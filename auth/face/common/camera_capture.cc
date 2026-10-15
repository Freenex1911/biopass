#include "camera_capture.h"

#include <dirent.h>
#include <fcntl.h>
#include <libcamera/libcamera.h>
#include <linux/videodev2.h>
#include <poll.h>
#include <spdlog/spdlog.h>
#include <sys/ioctl.h>
#include <sys/mman.h>
#include <sys/stat.h>
#include <unistd.h>

#include <algorithm>
#include <array>
#include <cerrno>
#include <chrono>
#include <condition_variable>
#include <cstdlib>
#include <cstring>
#include <deque>
#include <map>
#include <memory>
#include <mutex>
#include <optional>
#include <sstream>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include "pixel_convert.h"

namespace biopass {

namespace {

constexpr int kDefaultWarmupFrames = 5;
constexpr int kDefaultCaptureTimeoutMs = 10000;
constexpr const char* kCameraIdPrefix = "libcamera:";
// Selector suffix for an IR stream that shares its libcamera camera with the
// color stream (e.g. Logitech BRIO), see irStreamPath().
constexpr const char* kIrStreamSuffix = "/ir";
// Pulsed emitters alternate lit and unlit frames; pick the best exposed one.
constexpr int kIrCandidateFrames = 4;
constexpr int kV4l2BufferCount = 4;

std::string device_label(const std::optional<std::string>& linux_video_device_path) {
  return linux_video_device_path.has_value() ? *linux_video_device_path : std::string("<default>");
}

// Routes libcamera's internal logging through spdlog so it lands wherever
// the rest of the process's logs go (see setupBiopassLogger in helper.cc).
class SpdlogStreambuf : public std::streambuf {
 public:
  int overflow(int ch) override {
    if (ch == EOF) {
      return ch;
    }
    if (ch == '\n') {
      flushLine();
    } else {
      line_.push_back(static_cast<char>(ch));
    }
    return ch;
  }

 private:
  void flushLine() {
    if (!line_.empty()) {
      if (line_.find(" ERROR ") != std::string::npos ||
          line_.find(" FATAL ") != std::string::npos) {
        spdlog::error("libcamera: {}", line_);
      } else if (line_.find(" WARN ") != std::string::npos) {
        spdlog::warn("libcamera: {}", line_);
      } else {
        spdlog::info("libcamera: {}", line_);
      }
      line_.clear();
    }
  }

  std::string line_;
};

// The manager (and its logging redirection) is process-wide and outlives all
// sessions; RGB and IR capture can run concurrently against two Camera
// objects from a single CameraManager.
std::shared_ptr<libcamera::CameraManager> cameraManager() {
  static std::mutex init_mutex;
  static std::shared_ptr<libcamera::CameraManager> manager;

  std::lock_guard<std::mutex> lock(init_mutex);
  if (manager) {
    return manager;
  }

  if (!std::getenv("LIBCAMERA_LOG_LEVELS") && !std::getenv("LIBCAMERA_LOG_FILE")) {
    static SpdlogStreambuf log_streambuf;
    static std::ostream log_stream(&log_streambuf);
    libcamera::logSetStream(&log_stream);
  }

  auto candidate = std::make_shared<libcamera::CameraManager>();
  if (candidate->start() != 0) {
    spdlog::error("FaceAuth: Failed to start libcamera CameraManager");
    return nullptr;
  }

  manager = std::move(candidate);
  return manager;
}

std::shared_ptr<libcamera::Camera> findCameraByPath(libcamera::CameraManager& manager,
                                                    const std::string& linux_video_device_path) {
  struct stat device_info{};
  if (stat(linux_video_device_path.c_str(), &device_info) != 0 || !S_ISCHR(device_info.st_mode)) {
    return nullptr;
  }

  for (const auto& camera : manager.cameras()) {
    const auto devices = camera->properties().get(libcamera::properties::SystemDevices);
    if (!devices) {
      continue;
    }
    for (const int64_t device : *devices) {
      if (device == static_cast<int64_t>(device_info.st_rdev)) {
        return camera;
      }
    }
  }
  return nullptr;
}

std::shared_ptr<libcamera::Camera> findCamera(
    libcamera::CameraManager& manager, const std::optional<std::string>& linux_video_device_path) {
  if (linux_video_device_path.has_value() && *linux_video_device_path != "auto") {
    constexpr const char* id_prefix = "libcamera:";
    if (linux_video_device_path->rfind(id_prefix, 0) == 0) {
      return manager.get(linux_video_device_path->substr(std::strlen(id_prefix)));
    }
    auto camera = findCameraByPath(manager, *linux_video_device_path);
    if (!camera) {
      spdlog::error("FaceAuth: Camera path '{}' was not found among libcamera devices",
                    *linux_video_device_path);
    }
    return camera;
  }

  const auto cameras = manager.cameras();
  if (cameras.empty()) {
    spdlog::error("FaceAuth: No camera devices reported by libcamera");
    return nullptr;
  }
  return cameras.front();
}

// Reverse-maps a libcamera Camera's SystemDevices dev_t entries back to
// /dev/video* node paths, for field-debugging output (listCameraDevices).
std::vector<std::string> videoPathsForCamera(const libcamera::Camera& camera) {
  std::vector<std::string> paths;
  const auto devices = camera.properties().get(libcamera::properties::SystemDevices);
  if (!devices) {
    return paths;
  }

  DIR* dir = opendir("/dev");
  if (!dir) {
    return paths;
  }
  struct dirent* entry;
  while ((entry = readdir(dir)) != nullptr) {
    const std::string name(entry->d_name);
    if (name.rfind("video", 0) != 0) {
      continue;
    }
    const std::string path = "/dev/" + name;
    struct stat st{};
    if (stat(path.c_str(), &st) != 0 || !S_ISCHR(st.st_mode)) {
      continue;
    }
    for (const int64_t device : *devices) {
      if (device == static_cast<int64_t>(st.st_rdev)) {
        paths.push_back(path);
        break;
      }
    }
  }
  closedir(dir);
  std::sort(paths.begin(), paths.end());
  return paths;
}

int xioctl(int fd, unsigned long request, void* arg) {
  int result;
  do {
    result = ioctl(fd, request, arg);
  } while (result == -1 && errno == EINTR);
  return result;
}

struct V4l2NodeInfo {
  bool capture = false;
  bool grey = false;
};

V4l2NodeInfo probeV4l2Node(const std::string& path) {
  V4l2NodeInfo info;
  const int fd = ::open(path.c_str(), O_RDWR | O_NONBLOCK | O_CLOEXEC);
  if (fd < 0) {
    return info;
  }
  v4l2_capability cap{};
  if (xioctl(fd, VIDIOC_QUERYCAP, &cap) == 0) {
    const uint32_t caps =
        (cap.capabilities & V4L2_CAP_DEVICE_CAPS) ? cap.device_caps : cap.capabilities;
    info.capture = (caps & V4L2_CAP_VIDEO_CAPTURE) && (caps & V4L2_CAP_STREAMING);
  }
  if (info.capture) {
    v4l2_fmtdesc desc{};
    desc.type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
    for (desc.index = 0; xioctl(fd, VIDIOC_ENUM_FMT, &desc) == 0; ++desc.index) {
      if (desc.pixelformat == V4L2_PIX_FMT_GREY) {
        info.grey = true;
        break;
      }
    }
  }
  ::close(fd);
  return info;
}

// libcamera's UVC pipeline streams only from the camera's default video node.
// Some webcams (e.g. Logitech BRIO) expose their IR sensor as a second GREY
// capture node of the same USB function, which libcamera reports under the
// same camera but never streams. Returns that node, if any. A camera whose
// only capture node is GREY (a standalone IR camera) has no such stream.
std::optional<std::string> irStreamPath(const libcamera::Camera& camera) {
  std::optional<std::string> grey_node;
  bool has_color_node = false;
  for (const auto& path : videoPathsForCamera(camera)) {
    const auto info = probeV4l2Node(path);
    if (!info.capture) {
      continue;
    }
    if (info.grey) {
      if (!grey_node) {
        grey_node = path;
      }
    } else {
      has_color_node = true;
    }
  }
  if (!has_color_node) {
    return std::nullopt;
  }
  return grey_node;
}

bool hasSuffix(const std::string& value, const std::string& suffix) {
  return value.size() >= suffix.size() &&
         value.compare(value.size() - suffix.size(), suffix.size(), suffix) == 0;
}

// A selector naming a shared-camera IR stream, resolved to its video node.
struct IrStreamTarget {
  std::string camera_id;
  std::string path;
};

std::optional<IrStreamTarget> findIrStream(libcamera::CameraManager& manager,
                                           const std::optional<std::string>& selector) {
  if (!selector.has_value()) {
    return std::nullopt;
  }
  std::shared_ptr<libcamera::Camera> camera;
  if (selector->rfind(kCameraIdPrefix, 0) == 0) {
    if (!hasSuffix(*selector, kIrStreamSuffix)) {
      return std::nullopt;
    }
    const std::string id = selector->substr(
        std::strlen(kCameraIdPrefix),
        selector->size() - std::strlen(kCameraIdPrefix) - std::strlen(kIrStreamSuffix));
    camera = manager.get(id);
    if (!camera) {
      return std::nullopt;
    }
    if (auto path = irStreamPath(*camera)) {
      return IrStreamTarget{camera->id(), *path};
    }
    return std::nullopt;
  }

  // A plain /dev/video* path that is a camera's secondary IR node. Without
  // this, findCameraByPath() would map it to the same camera and silently
  // capture the color stream instead.
  camera = findCameraByPath(manager, *selector);
  if (!camera) {
    return std::nullopt;
  }
  const auto path = irStreamPath(*camera);
  if (!path || *path != *selector) {
    return std::nullopt;
  }
  return IrStreamTarget{camera->id(), *path};
}

bool isSupportedPixelFormat(const libcamera::PixelFormat& format) {
  return format == libcamera::formats::YUYV || format == libcamera::formats::MJPEG ||
         format == libcamera::formats::R8;
}

std::string listAvailableFormats(const libcamera::StreamFormats& formats) {
  std::ostringstream oss;
  bool first = true;
  for (const auto& format : formats.pixelformats()) {
    if (!first) {
      oss << ", ";
    }
    oss << format.toString();
    first = false;
  }
  return oss.str();
}

// Picks a pixel format for the given capture request out of what the camera
// actually offers, in preference order, then validates the configuration.
bool negotiate(libcamera::CameraConfiguration& config, CameraCaptureFormat requested_format,
               const std::string& camera_label) {
  libcamera::StreamConfiguration& stream_config = config.at(0);
  const auto& formats = stream_config.formats();

  std::vector<libcamera::PixelFormat> preference;
  if (requested_format == CameraCaptureFormat::V4L2Grey) {
    // Prefer a true grey stream, but some laptop IR sensors (e.g. Windows
    // Hello cameras) only expose the IR stream as YUYV/MJPEG; decode those
    // instead of failing outright.
    preference = {libcamera::formats::R8, libcamera::formats::YUYV, libcamera::formats::MJPEG};
  } else {
    // Full-resolution uncompressed USB streams can be limited to 5 FPS.
    // Prefer the camera's compressed stream to keep capture latency low.
    preference = {libcamera::formats::MJPEG, libcamera::formats::YUYV, libcamera::formats::R8};
  }

  const auto available = formats.pixelformats();
  bool picked = false;
  for (const auto& candidate : preference) {
    if (std::find(available.begin(), available.end(), candidate) != available.end()) {
      stream_config.pixelFormat = candidate;
      picked = true;
      break;
    }
  }

  if (!picked) {
    spdlog::error(
        "FaceAuth: Camera '{}' exposes none of the required pixel formats (available: {})",
        camera_label, listAvailableFormats(formats));
    return false;
  }

  if (requested_format == CameraCaptureFormat::Default) {
    // StillCapture defaults to the largest sensor mode. A 720p RGB stream is
    // sufficient for the face models and leaves USB bandwidth for a paired IR
    // sensor. Select an advertised mode rather than an unsupported arbitrary size.
    const auto sizes = formats.sizes(stream_config.pixelFormat);
    constexpr uint64_t pixel_budget = 1280 * 720;
    std::optional<libcamera::Size> preferred;
    for (const auto& size : sizes) {
      const uint64_t area = static_cast<uint64_t>(size.width) * size.height;
      if (area <= pixel_budget &&
          (!preferred || area > static_cast<uint64_t>(preferred->width) * preferred->height))
        preferred = size;
    }
    if (preferred)
      stream_config.size = *preferred;
  }

  const auto validation = config.validate();
  if (validation == libcamera::CameraConfiguration::Invalid) {
    spdlog::error("FaceAuth: Invalid camera configuration for '{}'", camera_label);
    return false;
  }

  if (!isSupportedPixelFormat(stream_config.pixelFormat)) {
    spdlog::error(
        "FaceAuth: Camera '{}' adjusted configuration to unsupported format {} (available: {})",
        camera_label, stream_config.pixelFormat.toString(), listAvailableFormats(formats));
    return false;
  }

  if (requested_format == CameraCaptureFormat::V4L2Grey &&
      stream_config.pixelFormat != libcamera::formats::R8) {
    spdlog::warn("FaceAuth: Camera '{}' exposes no GREY format; falling back to decoded {} capture",
                 camera_label, stream_config.pixelFormat.toString());
  }

  return true;
}

// Converts one captured plane's bytes into RGB according to the negotiated
// pixel format.
bool convertFrame(const libcamera::PixelFormat& pixel_format, const uint8_t* data,
                  size_t bytes_used, int width, int height, int stride, ImageRGB& out) {
  if (pixel_format == libcamera::formats::YUYV) {
    return yuyvToRgb(data, bytes_used, width, height, stride, out);
  }
  if (pixel_format == libcamera::formats::R8) {
    return greyToRgb(data, bytes_used, width, height, stride, out);
  }
  if (pixel_format == libcamera::formats::MJPEG) {
    return mjpegToRgb(data, bytes_used, out);
  }
  return false;
}

class LibcameraCaptureSession : public ICameraCaptureSession {
 public:
  static std::unique_ptr<LibcameraCaptureSession> open(
      std::shared_ptr<libcamera::CameraManager> manager, std::shared_ptr<libcamera::Camera> camera,
      CameraCaptureFormat requested_format, std::string camera_label, int warmup_frames,
      int capture_timeout_ms) {
    auto session = std::unique_ptr<LibcameraCaptureSession>(
        new LibcameraCaptureSession(std::move(manager), std::move(camera), requested_format,
                                    std::move(camera_label), warmup_frames, capture_timeout_ms));
    if (!session->setup()) {
      return nullptr;
    }
    return session;
  }

  ~LibcameraCaptureSession() override { close(); }

  bool isOpen() const override { return started_; }

  ImageRGB capture() override {
    if (!isOpen()) {
      return {};
    }

    const bool has_timeout = capture_timeout_ms_ > 0;
    const auto deadline = std::chrono::steady_clock::now() +
                          std::chrono::milliseconds(std::max(0, capture_timeout_ms_));

    // Drop any frames that completed before this call so a long-idle session
    // never returns a stale frame.
    drainPending();

    // RGB warmup runs during preparation. Preserve per-capture IR warmup:
    // pulsed emitters may need additional settling after a stream was idle.
    if (is_grey_) {
      for (int i = 0; i < ir_warmup_frames_; ++i) {
        libcamera::Request* request = waitForRequest(deadline, has_timeout);
        if (!request) {
          return {};
        }
        requeue(request);
      }
    }

    libcamera::Request* request = waitForRequest(deadline, has_timeout);
    if (!request) {
      return {};
    }

    ImageRGB image;
    const bool ok = extractFrame(request, image);
    requeue(request);
    if (!ok) {
      spdlog::error("FaceAuth: Failed to convert frame from '{}'", camera_label_);
      return {};
    }
    return image;
  }

 private:
  LibcameraCaptureSession(std::shared_ptr<libcamera::CameraManager> manager,
                          std::shared_ptr<libcamera::Camera> camera,
                          CameraCaptureFormat requested_format, std::string camera_label,
                          int warmup_frames, int capture_timeout_ms)
      : manager_(std::move(manager)),
        camera_(std::move(camera)),
        camera_label_(std::move(camera_label)),
        is_grey_(requested_format == CameraCaptureFormat::V4L2Grey),
        warmup_remaining_(is_grey_ ? 0 : std::max(0, warmup_frames)),
        ir_warmup_frames_(is_grey_ ? std::max(0, warmup_frames) : 0),
        capture_timeout_ms_(capture_timeout_ms) {}

  bool setup() {
    config_ = camera_->generateConfiguration({libcamera::StreamRole::StillCapture});
    if (!config_ || config_->size() == 0) {
      spdlog::error("FaceAuth: Failed to generate camera configuration for '{}'", camera_label_);
      return false;
    }

    if (!negotiate(*config_,
                   is_grey_ ? CameraCaptureFormat::V4L2Grey : CameraCaptureFormat::Default,
                   camera_label_)) {
      return false;
    }

    if (camera_->acquire() != 0) {
      spdlog::error("FaceAuth: Failed to acquire camera '{}'", camera_label_);
      return false;
    }
    acquired_ = true;

    if (camera_->configure(config_.get()) != 0) {
      spdlog::error("FaceAuth: Failed to configure camera '{}'", camera_label_);
      return false;
    }

    libcamera::StreamConfiguration& stream_config = config_->at(0);
    pixel_format_ = stream_config.pixelFormat;
    width_ = static_cast<int>(stream_config.size.width);
    height_ = static_cast<int>(stream_config.size.height);
    stride_ = static_cast<int>(stream_config.stride);
    stream_ = stream_config.stream();

    allocator_ = std::make_unique<libcamera::FrameBufferAllocator>(camera_);
    if (allocator_->allocate(stream_) < 0) {
      spdlog::error("FaceAuth: Failed to allocate buffers for '{}'", camera_label_);
      return false;
    }

    for (const auto& buffer : allocator_->buffers(stream_)) {
      auto request = camera_->createRequest();
      if (!request || request->addBuffer(stream_, buffer.get()) < 0) {
        spdlog::error("FaceAuth: Failed to create capture request for '{}'", camera_label_);
        return false;
      }
      if (!mapBuffer(buffer.get())) {
        spdlog::error("FaceAuth: Failed to mmap buffer for '{}'", camera_label_);
        return false;
      }
      requests_.push_back(std::move(request));
    }

    camera_->requestCompleted.connect(&connection_token_, [this](libcamera::Request* request) {
      if (request->status() == libcamera::Request::RequestCancelled) {
        return;
      }
      bool discard = false;
      libcamera::Request* superseded = nullptr;
      {
        std::lock_guard<std::mutex> lock(mutex_);
        if (warmup_remaining_ > 0) {
          --warmup_remaining_;
          discard = true;
        } else {
          // Keep only the latest completed frame and recycle older buffers.
          // Otherwise preparation fills every buffer and stalls the stream,
          // preventing exposure and pulsed IR illumination from settling.
          if (!is_grey_ && !completed_.empty()) {
            superseded = completed_.front();
            completed_.pop_front();
          }
          completed_.push_back(request);
        }
      }
      if (superseded) {
        requeue(superseded);
      }
      if (discard) {
        requeue(request);
      } else {
        ready_.notify_one();
      }
    });

    if (camera_->start() < 0) {
      spdlog::error("FaceAuth: Failed to start camera '{}'", camera_label_);
      camera_->requestCompleted.disconnect(&connection_token_);
      return false;
    }
    started_ = true;

    for (auto& request : requests_) {
      if (camera_->queueRequest(request.get()) < 0) {
        spdlog::error("FaceAuth: Failed to queue initial request for '{}'", camera_label_);
        started_ = false;
        return false;
      }
    }

    return true;
  }

  bool mapBuffer(libcamera::FrameBuffer* buffer) {
    const auto planes = buffer->planes();
    if (planes.empty()) {
      return false;
    }
    const auto& plane = planes[0];
    const size_t mapping_size = plane.offset + plane.length;
    void* mapping = mmap(nullptr, mapping_size, PROT_READ, MAP_SHARED, plane.fd.get(), 0);
    if (mapping == MAP_FAILED) {
      return false;
    }
    mappings_[buffer] = Mapping{mapping, mapping_size, plane.offset};
    return true;
  }

  // Blocks until a completed request is available or the deadline passes.
  libcamera::Request* waitForRequest(std::chrono::steady_clock::time_point deadline,
                                     bool has_timeout) {
    std::unique_lock<std::mutex> lock(mutex_);
    bool have_request;
    if (has_timeout) {
      have_request = ready_.wait_until(lock, deadline, [this] { return !completed_.empty(); });
    } else {
      ready_.wait(lock, [this] { return !completed_.empty(); });
      have_request = true;
    }
    if (!have_request) {
      spdlog::error("FaceAuth: Timed out waiting for frame from '{}'", camera_label_);
      lock.unlock();
      close();
      return nullptr;
    }
    libcamera::Request* request = completed_.front();
    completed_.pop_front();
    return request;
  }

  void drainPending() {
    std::lock_guard<std::mutex> lock(mutex_);
    while (!completed_.empty()) {
      libcamera::Request* request = completed_.front();
      completed_.pop_front();
      request->reuse(libcamera::Request::ReuseBuffers);
      camera_->queueRequest(request);
    }
  }

  void requeue(libcamera::Request* request) {
    request->reuse(libcamera::Request::ReuseBuffers);
    camera_->queueRequest(request);
  }

  bool extractFrame(libcamera::Request* request, ImageRGB& out) {
    libcamera::FrameBuffer* buffer = request->findBuffer(stream_);
    if (!buffer) {
      return false;
    }
    const auto it = mappings_.find(buffer);
    if (it == mappings_.end()) {
      return false;
    }
    const auto metadata = buffer->metadata().planes();
    if (metadata.empty()) {
      return false;
    }
    const size_t bytes_used = metadata[0].bytesused;
    const uint8_t* data = static_cast<const uint8_t*>(it->second.base) + it->second.plane_offset;
    return convertFrame(pixel_format_, data, bytes_used, width_, height_, stride_, out);
  }

  void close() {
    if (started_) {
      camera_->stop();
      started_ = false;
    }
    camera_->requestCompleted.disconnect(&connection_token_);
    {
      std::lock_guard<std::mutex> lock(mutex_);
      completed_.clear();
    }
    for (auto& [buffer, mapping] : mappings_) {
      munmap(mapping.base, mapping.size);
    }
    mappings_.clear();
    requests_.clear();
    allocator_.reset();
    if (acquired_) {
      camera_->release();
      acquired_ = false;
    }
  }

  struct Mapping {
    void* base = nullptr;
    size_t size = 0;
    size_t plane_offset = 0;
  };

  std::shared_ptr<libcamera::CameraManager> manager_;
  std::shared_ptr<libcamera::Camera> camera_;
  std::string camera_label_;
  bool is_grey_ = false;
  int warmup_remaining_ = 0;
  int ir_warmup_frames_ = 0;
  int capture_timeout_ms_ = 0;

  std::unique_ptr<libcamera::CameraConfiguration> config_;
  libcamera::Stream* stream_ = nullptr;
  libcamera::PixelFormat pixel_format_;
  int width_ = 0;
  int height_ = 0;
  int stride_ = 0;

  std::unique_ptr<libcamera::FrameBufferAllocator> allocator_;
  std::vector<std::unique_ptr<libcamera::Request>> requests_;
  std::map<libcamera::FrameBuffer*, Mapping> mappings_;

  std::mutex mutex_;
  std::condition_variable ready_;
  std::deque<libcamera::Request*> completed_;
  int connection_token_ = 0;

  bool acquired_ = false;
  bool started_ = false;
};

// Streams a GREY video node directly through V4L2, for IR streams libcamera
// does not capture (see irStreamPath()). Only used for IR sessions.
class V4l2GreyCaptureSession : public ICameraCaptureSession {
 public:
  static std::unique_ptr<V4l2GreyCaptureSession> open(const std::string& path,
                                                      std::string camera_label, int warmup_frames,
                                                      int capture_timeout_ms) {
    auto session = std::unique_ptr<V4l2GreyCaptureSession>(
        new V4l2GreyCaptureSession(std::move(camera_label), warmup_frames, capture_timeout_ms));
    if (!session->setup(path)) {
      return nullptr;
    }
    return session;
  }

  ~V4l2GreyCaptureSession() override { close(); }

  bool isOpen() const override { return started_; }

  ImageRGB capture() override {
    if (!isOpen()) {
      return {};
    }

    const bool has_timeout = capture_timeout_ms_ > 0;
    const auto deadline = std::chrono::steady_clock::now() +
                          std::chrono::milliseconds(std::max(0, capture_timeout_ms_));

    // Drop frames that completed before this call so a long-idle session
    // never returns a stale frame.
    while (dequeue(nullptr)) {
    }

    for (int i = 0; i < warmup_frames_; ++i) {
      if (!waitForFrame(deadline, has_timeout, nullptr)) {
        return {};
      }
    }

    std::vector<uint8_t> best;
    double best_score = 0.0;
    for (int i = 0; i < kIrCandidateFrames; ++i) {
      std::vector<uint8_t> frame;
      if (!waitForFrame(deadline, has_timeout, &frame)) {
        return {};
      }
      if (frame.empty()) {
        continue;
      }
      const double score = exposureScore(frame);
      if (best.empty() || score < best_score) {
        best = std::move(frame);
        best_score = score;
      }
    }

    ImageRGB image;
    if (!best.empty()) {
      stretchContrast(best);
    }
    if (best.empty() || !greyToRgb(best.data(), best.size(), width_, height_, width_, image)) {
      spdlog::error("FaceAuth: Failed to convert frame from '{}'", camera_label_);
      return {};
    }
    return image;
  }

 private:
  V4l2GreyCaptureSession(std::string camera_label, int warmup_frames, int capture_timeout_ms)
      : camera_label_(std::move(camera_label)),
        warmup_frames_(std::max(0, warmup_frames)),
        capture_timeout_ms_(capture_timeout_ms) {}

  bool setup(const std::string& path) {
    fd_ = ::open(path.c_str(), O_RDWR | O_NONBLOCK | O_CLOEXEC);
    if (fd_ < 0) {
      spdlog::error("FaceAuth: Failed to open IR stream '{}': {}", camera_label_,
                    std::strerror(errno));
      return false;
    }

    v4l2_format format{};
    format.type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
    if (xioctl(fd_, VIDIOC_G_FMT, &format) != 0) {
      spdlog::error("FaceAuth: Failed to query format of IR stream '{}'", camera_label_);
      return false;
    }
    format.fmt.pix.pixelformat = V4L2_PIX_FMT_GREY;
    format.fmt.pix.field = V4L2_FIELD_NONE;
    if (xioctl(fd_, VIDIOC_S_FMT, &format) != 0 ||
        format.fmt.pix.pixelformat != V4L2_PIX_FMT_GREY) {
      spdlog::error("FaceAuth: IR stream '{}' rejected the GREY format", camera_label_);
      return false;
    }
    width_ = static_cast<int>(format.fmt.pix.width);
    height_ = static_cast<int>(format.fmt.pix.height);
    stride_ = static_cast<int>(format.fmt.pix.bytesperline);
    if (stride_ < width_) {
      stride_ = width_;
    }

    v4l2_requestbuffers request{};
    request.count = kV4l2BufferCount;
    request.type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
    request.memory = V4L2_MEMORY_MMAP;
    if (xioctl(fd_, VIDIOC_REQBUFS, &request) != 0 || request.count == 0) {
      spdlog::error("FaceAuth: Failed to allocate buffers for '{}'", camera_label_);
      return false;
    }
    requested_buffers_ = true;

    for (uint32_t index = 0; index < request.count; ++index) {
      v4l2_buffer buffer{};
      buffer.type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
      buffer.memory = V4L2_MEMORY_MMAP;
      buffer.index = index;
      if (xioctl(fd_, VIDIOC_QUERYBUF, &buffer) != 0) {
        spdlog::error("FaceAuth: Failed to query buffer for '{}'", camera_label_);
        return false;
      }
      void* mapping = mmap(nullptr, buffer.length, PROT_READ, MAP_SHARED, fd_, buffer.m.offset);
      if (mapping == MAP_FAILED) {
        spdlog::error("FaceAuth: Failed to mmap buffer for '{}'", camera_label_);
        return false;
      }
      buffers_.push_back(Mapping{mapping, buffer.length});
      if (xioctl(fd_, VIDIOC_QBUF, &buffer) != 0) {
        spdlog::error("FaceAuth: Failed to queue initial buffer for '{}'", camera_label_);
        return false;
      }
    }

    v4l2_buf_type type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
    if (xioctl(fd_, VIDIOC_STREAMON, &type) != 0) {
      spdlog::error("FaceAuth: Failed to start IR stream '{}': {}", camera_label_,
                    std::strerror(errno));
      return false;
    }
    started_ = true;
    return true;
  }

  // Waits for the next frame. With `out`, copies its tightly packed grey
  // pixels (left empty for a corrupt frame); otherwise the frame is discarded.
  bool waitForFrame(std::chrono::steady_clock::time_point deadline, bool has_timeout,
                    std::vector<uint8_t>* out) {
    while (true) {
      int timeout_ms = -1;
      if (has_timeout) {
        const auto remaining = std::chrono::duration_cast<std::chrono::milliseconds>(
            deadline - std::chrono::steady_clock::now());
        timeout_ms = static_cast<int>(std::max<int64_t>(0, remaining.count()));
      }
      pollfd poll_fd{fd_, POLLIN, 0};
      const int ready = ::poll(&poll_fd, 1, timeout_ms);
      if (ready < 0 && errno == EINTR) {
        continue;
      }
      if (ready <= 0) {
        spdlog::error("FaceAuth: Timed out waiting for frame from '{}'", camera_label_);
        close();
        return false;
      }
      if (dequeue(out)) {
        return true;
      }
      if (!started_) {
        return false;
      }
    }
  }

  // Dequeues one completed buffer, optionally copying it, and requeues it.
  // Returns false when no buffer is ready (or on a stream error).
  bool dequeue(std::vector<uint8_t>* out) {
    v4l2_buffer buffer{};
    buffer.type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
    buffer.memory = V4L2_MEMORY_MMAP;
    if (xioctl(fd_, VIDIOC_DQBUF, &buffer) != 0) {
      if (errno != EAGAIN) {
        spdlog::error("FaceAuth: Failed to dequeue frame from '{}': {}", camera_label_,
                      std::strerror(errno));
        close();
      }
      return false;
    }
    if (out) {
      out->clear();
      const size_t needed = static_cast<size_t>(stride_) * (height_ - 1) + width_;
      if (buffer.index < buffers_.size() && !(buffer.flags & V4L2_BUF_FLAG_ERROR) &&
          buffer.bytesused >= needed) {
        const auto* data = static_cast<const uint8_t*>(buffers_[buffer.index].base);
        out->resize(static_cast<size_t>(width_) * height_);
        for (int y = 0; y < height_; ++y) {
          std::memcpy(out->data() + static_cast<size_t>(y) * width_,
                      data + static_cast<size_t>(y) * stride_, width_);
        }
      }
    }
    xioctl(fd_, VIDIOC_QBUF, &buffer);
    return true;
  }

  // Distance of the mean from mid-grey plus a penalty for clipped pixels, so
  // an over-exposed lit frame and a dark unlit frame both lose to a usable one.
  static double exposureScore(const std::vector<uint8_t>& pixels) {
    uint64_t sum = 0;
    uint64_t clipped = 0;
    for (const uint8_t value : pixels) {
      sum += value;
      clipped += value >= 250;
    }
    const double count = static_cast<double>(pixels.size());
    return std::abs(sum / count - 128.0) + 255.0 * (clipped / count);
  }

  // Stretches the 1st..99th percentile to the full range. Without an active
  // color stream the camera's shared auto-exposure leaves IR frames too dark
  // for face detection.
  static void stretchContrast(std::vector<uint8_t>& pixels) {
    std::array<size_t, 256> histogram{};
    for (const uint8_t value : pixels) {
      ++histogram[value];
    }
    const size_t tail = pixels.size() / 100;
    int low = 0;
    for (size_t seen = 0; low < 255 && (seen += histogram[low]) <= tail; ++low) {
    }
    int high = 255;
    for (size_t seen = 0; high > 0 && (seen += histogram[high]) <= tail; --high) {
    }
    // Leave flat (e.g. fully dark) frames alone instead of amplifying noise.
    if (high - low < 16) {
      return;
    }
    std::array<uint8_t, 256> lut{};
    for (int value = 0; value < 256; ++value) {
      lut[value] = static_cast<uint8_t>(std::clamp((value - low) * 255 / (high - low), 0, 255));
    }
    for (uint8_t& value : pixels) {
      value = lut[value];
    }
  }

  void close() {
    if (fd_ < 0) {
      return;
    }
    if (started_) {
      v4l2_buf_type type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
      xioctl(fd_, VIDIOC_STREAMOFF, &type);
      started_ = false;
    }
    for (const auto& mapping : buffers_) {
      munmap(mapping.base, mapping.length);
    }
    buffers_.clear();
    if (requested_buffers_) {
      v4l2_requestbuffers request{};
      request.type = V4L2_BUF_TYPE_VIDEO_CAPTURE;
      request.memory = V4L2_MEMORY_MMAP;
      xioctl(fd_, VIDIOC_REQBUFS, &request);
      requested_buffers_ = false;
    }
    ::close(fd_);
    fd_ = -1;
  }

  struct Mapping {
    void* base = nullptr;
    size_t length = 0;
  };

  std::string camera_label_;
  int warmup_frames_ = 0;
  int capture_timeout_ms_ = 0;
  int fd_ = -1;
  int width_ = 0;
  int height_ = 0;
  int stride_ = 0;
  std::vector<Mapping> buffers_;
  bool requested_buffers_ = false;
  bool started_ = false;
};

}  // namespace

bool checkCameraAvailability(const std::optional<std::string>& linux_video_device_path) {
  auto session = openCameraSession(linux_video_device_path);
  return session && session->isOpen();
}

std::optional<std::string> resolveCameraSelector(const std::string& selector) {
  auto manager = cameraManager();
  if (!manager || selector.empty())
    return std::nullopt;
  if (auto ir_stream = findIrStream(*manager, selector)) {
    return kCameraIdPrefix + ir_stream->camera_id + kIrStreamSuffix;
  }
  auto camera = findCamera(*manager, selector);
  if (!camera)
    return std::nullopt;
  return "libcamera:" + camera->id();
}

std::unique_ptr<ICameraCaptureSession> openCameraSession(
    const std::optional<std::string>& linux_video_device_path, CameraCaptureFormat format,
    int warmup_frames, int capture_timeout_ms) {
  auto manager = cameraManager();
  if (!manager) {
    return nullptr;
  }

  if (auto ir_stream = findIrStream(*manager, linux_video_device_path)) {
    if (format != CameraCaptureFormat::V4L2Grey) {
      spdlog::error("FaceAuth: '{}' is an IR stream and cannot be used as color camera",
                    device_label(linux_video_device_path));
      return nullptr;
    }
    return V4l2GreyCaptureSession::open(ir_stream->path, device_label(linux_video_device_path),
                                        warmup_frames, capture_timeout_ms);
  }

  auto camera = findCamera(*manager, linux_video_device_path);
  if (!camera) {
    return nullptr;
  }

  return LibcameraCaptureSession::open(manager, camera, format,
                                       device_label(linux_video_device_path), warmup_frames,
                                       capture_timeout_ms);
}

ImageRGB captureImage(const std::optional<std::string>& linux_video_device_path,
                      CameraCaptureFormat format) {
  auto session = openCameraSession(linux_video_device_path, format, kDefaultWarmupFrames,
                                   kDefaultCaptureTimeoutMs);
  if (!session) {
    return {};
  }

  return session->capture();
}

ImageRGB captureImageByIRCamera(const std::string& device_path, int warmup_frames,
                                int capture_timeout_ms) {
  if (device_path.empty()) {
    spdlog::error("FaceAuth: IR camera capture requires a /dev/video* path");
    return {};
  }

  auto session = openCameraSession(device_path, CameraCaptureFormat::V4L2Grey, warmup_frames,
                                   capture_timeout_ms);
  if (!session) {
    return {};
  }

  return session->capture();
}

std::vector<CameraDeviceInfo> listCameraDevices() {
  std::vector<CameraDeviceInfo> result;
  auto manager = cameraManager();
  if (!manager) {
    return result;
  }

  for (const auto& camera : manager->cameras()) {
    CameraDeviceInfo info;
    info.id = camera->id();
    const auto model = camera->properties().get(libcamera::properties::Model);
    info.model = model ? std::string(*model) : info.id;
    info.video_paths = videoPathsForCamera(*camera);
    const auto ir_path = irStreamPath(*camera);
    if (ir_path) {
      info.video_paths.erase(
          std::remove(info.video_paths.begin(), info.video_paths.end(), *ir_path),
          info.video_paths.end());
    }
    CameraDeviceInfo ir_info{info.id + kIrStreamSuffix, info.model, {}, true};
    result.push_back(std::move(info));
    // Shared-camera IR streams are listed as their own camera so they can be
    // selected independently of the color stream.
    if (ir_path) {
      ir_info.video_paths = {*ir_path};
      result.push_back(std::move(ir_info));
    }
  }
  return result;
}

std::vector<CameraFormatDesc> listCameraFormats(const std::string& device_path) {
  std::vector<CameraFormatDesc> result;
  auto manager = cameraManager();
  if (!manager) {
    return result;
  }

  auto camera = findCameraByPath(*manager, device_path);
  if (!camera) {
    return result;
  }

  auto config = camera->generateConfiguration({libcamera::StreamRole::StillCapture});
  if (!config || config->size() == 0) {
    return result;
  }

  const auto& formats = config->at(0).formats();
  for (const auto& pixel_format : formats.pixelformats()) {
    CameraFormatDesc desc;
    desc.pixel_format = pixel_format.toString();
    desc.supported = isSupportedPixelFormat(pixel_format);
    for (const auto& size : formats.sizes(pixel_format)) {
      desc.sizes.emplace_back(static_cast<int>(size.width), static_cast<int>(size.height));
    }
    result.push_back(std::move(desc));
  }
  return result;
}

}  // namespace biopass
