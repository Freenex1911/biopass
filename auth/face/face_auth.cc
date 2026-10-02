#include "face_auth.h"

#include <spdlog/spdlog.h>

#include <fstream>
#include <memory>
#include <optional>
#include <vector>

#include "antispoof_check.h"
#include "camera_capture.h"
#include "debug_image_io.h"
#include "image_utils.h"

namespace biopass {

bool FaceAuth::isAvailable() const {
  if (face_config_.camera_selection.mode != "legacy" && !camera_pair_resolved_) {
    const auto pair = selectCameraPair(face_config_.camera_selection, resolveCameraSelector);
    if (!pair) {
      spdlog::warn("FaceAuth: No complete configured camera pair is available (mode='{}')",
                   face_config_.camera_selection.mode);
      return false;
    }
    face_config_.camera = pair->camera;
    face_config_.anti_spoofing.ir_camera =
        pair->ir_camera.empty() ? std::nullopt : std::optional<std::string>{pair->ir_camera};
    camera_pair_resolved_ = true;
    spdlog::debug("FaceAuth: Selected camera pair '{}' | RGB='{}' IR='{}'", pair->name,
                  pair->camera, pair->ir_camera);
  }
  // Keep the availability probe's stream for the authentication session.
  // Starting and immediately stopping a USB camera is expensive.
  if (!camera_session_ || !camera_session_->isOpen()) {
    camera_session_ = openCameraSession(face_config_.camera);
  }
  return camera_session_ && camera_session_->isOpen();
}

void FaceAuth::ensureIrSession() {
  if (face_config_.anti_spoofing.ir_camera.has_value() &&
      !face_config_.anti_spoofing.ir_camera->empty() &&
      (!ir_camera_session_ || !ir_camera_session_->isOpen())) {
    ir_camera_session_ =
        openCameraSession(*face_config_.anti_spoofing.ir_camera, CameraCaptureFormat::V4L2Grey,
                          kIrCaptureWarmupFrames, kIrCaptureTimeoutMs);
  }
}

bool FaceAuth::ensureModelsLoaded() {
  if (models_future_.valid()) {
    return models_future_.get();
  }
  return loadModels();
}

bool FaceAuth::loadModels() {
  if (detector_ && recognizer_ && aligner_ && (!face_config_.anti_spoofing.enable || protection_)) {
    return true;
  }

  const std::string detectModelPath =
      model_registry_.resolveModelPath(face_config_.detection.model_id).value_or("");
  const std::string recogModelPath =
      model_registry_.resolveModelPath(face_config_.recognition.model_id).value_or("");
  if (!std::ifstream(recogModelPath).good() || !std::ifstream(detectModelPath).good()) {
    spdlog::error("FaceAuth: Model files not found");
    return false;
  }

  try {
    detector_ =
        std::make_unique<FaceDetection>(detectModelPath, 640, face_config_.detection.threshold);
    spdlog::debug("FaceAuth: Detection model loaded | threshold={:.3f}",
                  face_config_.detection.threshold);
  } catch (const std::exception& e) {
    std::string msg = e.what();
    size_t first_line = msg.find('\n');
    if (first_line != std::string::npos)
      msg = msg.substr(0, first_line);
    spdlog::error("FaceAuth: Failed to load detection model: {}, skipping", msg);
    return false;
  }

  try {
    recognizer_ =
        std::make_unique<FaceRecognition>(recogModelPath, 112, face_config_.recognition.threshold);
    spdlog::debug("FaceAuth: Recognition model loaded | threshold={:.3f}",
                  face_config_.recognition.threshold);
  } catch (const std::exception& e) {
    std::string msg = e.what();
    size_t first_line = msg.find('\n');
    if (first_line != std::string::npos)
      msg = msg.substr(0, first_line);
    spdlog::error("FaceAuth: Failed to load recognition model: {}, skipping", msg);
    detector_.reset();
    return false;
  }

  if (!aligner_) {
    try {
      aligner_ = std::make_unique<FaceAlignment>(FaceAlignment::installedModelPath);
    } catch (const std::exception& error) {
      spdlog::error("FaceAuth: Could not load landmark model: {}", error.what());
      return false;
    }
  }
  if (face_config_.anti_spoofing.enable && !protection_) {
    try {
      const auto path = model_registry_.resolveModelPath(face_config_.anti_spoofing.model.model_id);
      if (!path)
        return false;
      protection_ = std::make_unique<FaceAntiSpoofing>(*path, 128,
                                                       face_config_.anti_spoofing.model.threshold);
    } catch (const std::exception& e) {
      spdlog::error("FaceAuth: Could not load protection model: {}", e.what());
      return false;
    }
  }
  return true;
}

void FaceAuth::beginAuthenticationSession() {
  if (!camera_session_) {
    camera_session_ = openCameraSession(face_config_.camera);
  }
  ensureIrSession();
  if (ensureModelsLoaded())
    prepareEnrolledFaces();
}

void FaceAuth::prepareEnrolledFaces() {
  if (enrolled_faces_prepared_)
    return;
  enrolled_faces_prepared_ = true;
  for (const auto& path : biopass::listFaces(username_))
    enrolled_faces_.push_back({path, {}, false});
}

void FaceAuth::endAuthenticationSession() {
  ir_camera_session_.reset();
  camera_session_.reset();
  enrolled_faces_.clear();
  enrolled_faces_prepared_ = false;
}

AuthResult FaceAuth::authenticate(const std::string& username, const AuthConfig& config,
                                  std::atomic<bool>* cancel_signal) {
  if (face_config_.camera_selection.mode != "legacy" && !camera_pair_resolved_ && !isAvailable()) {
    return AuthResult::Unavailable;
  }
  if (!camera_session_) {
    camera_session_ = openCameraSession(face_config_.camera);
  }
  if (!camera_session_ || !camera_session_->isOpen()) {
    spdlog::error("FaceAuth: Could not open camera");
    if (!checkCameraAvailability(face_config_.camera)) {
      return AuthResult::Unavailable;
    }
    return AuthResult::Retry;
  }

  if (!ensureModelsLoaded()) {
    spdlog::error("FaceAuth: Models not available for user {}, skipping", username);
    return AuthResult::Unavailable;
  }

  prepareEnrolledFaces();
  if (enrolled_faces_.empty() || username != username_) {
    spdlog::debug("FaceAuth: No usable enrolled faces for user, skipping");
    return AuthResult::Unavailable;
  }

  if (cancel_signal && cancel_signal->load()) {
    return AuthResult::Failure;
  }

  ImageRGB loginFace = camera_session_->capture();
  if (loginFace.empty()) {
    spdlog::error("FaceAuth: Could not read frame");
    camera_session_.reset();
    return AuthResult::Retry;
  }

  if (cancel_signal && cancel_signal->load())
    return AuthResult::Failure;
  std::vector<Detection> detectedImages = detector_->inference(loginFace);
  if (detectedImages.empty()) {
    spdlog::error("FaceAuth: No face detected");
    return AuthResult::Retry;
  }

  ImageRGB face = detectedImages[0].image;
  ImageRGB recognition_face = face;
  if (aligner_) {
    try {
      const auto aligned = aligner_->align(loginFace);
      if (!aligned) {
        spdlog::debug("FaceAuth: No unambiguous usable facial landmarks; retrying");
        return AuthResult::Retry;
      }
      recognition_face = *aligned;
    } catch (const std::exception& error) {
      spdlog::warn("FaceAuth: Face alignment failed: {}", error.what());
      return AuthResult::Retry;
    }
  }

  ensureIrSession();
  if (face_config_.camera_selection.mode != "legacy" &&
      face_config_.anti_spoofing.ir_camera.has_value() &&
      (!ir_camera_session_ || !ir_camera_session_->isOpen())) {
    spdlog::error("FaceAuth: Selected camera pair's IR stream could not be opened");
    return AuthResult::Failure;
  }

  if (!checkAntiSpoof(face_config_, username, face, config, model_registry_, detector_.get(),
                      ir_camera_session_.get(), protection_.get(), cancel_signal)) {
    spdlog::warn("FaceAuth: Anti-spoofing failed — returning Failure (no retry allowed)");
    // Always tear down the IR session so a subsequent call cannot reuse a
    // partially-warmed camera to bypass the check.
    ir_camera_session_.reset();
    return AuthResult::Failure;
  }

  if (cancel_signal && cancel_signal->load())
    return AuthResult::Failure;
  // One live embedding per attempt; enrolled embeddings are reused until the session ends.
  const auto live_embedding = recognizer_->embedding(recognition_face);
  for (auto& enrolled : enrolled_faces_) {
    if (cancel_signal && cancel_signal->load())
      return AuthResult::Failure;
    // Prepare only faces actually compared. Loading every enrollment up front
    // would slow a successful first match when many photos are enrolled.
    if (!enrolled.prepared) {
      enrolled.prepared = true;
      try {
        const auto image = readImage(enrolled.path);
        if (!image.empty()) {
          if (aligner_) {
            const auto aligned = aligner_->align(image);
            if (aligned)
              enrolled.embedding = recognizer_->embedding(*aligned);
            else
              spdlog::warn("FaceAuth: No usable landmarks in enrolled face '{}'", enrolled.path);
          } else {
            enrolled.embedding = recognizer_->embedding(image);
          }
        }
      } catch (const std::exception& e) {
        spdlog::warn("FaceAuth: Could not prepare enrolled face '{}': {}", enrolled.path, e.what());
      }
    }
    if (enrolled.embedding.empty())
      continue;
    const MatchResult match = recognizer_->matchEmbeddings(enrolled.embedding, live_embedding);
    spdlog::debug("FaceAuth: Recognition | face='{}' score={:.4f} threshold={:.3f} similar={}",
                  enrolled.path, match.dist, face_config_.recognition.threshold, match.similar);
    if (match.similar)
      return AuthResult::Success;
  }

  if (std::none_of(enrolled_faces_.begin(), enrolled_faces_.end(),
                   [](const EnrolledFace& enrolled) { return !enrolled.embedding.empty(); })) {
    spdlog::warn("FaceAuth: No enrolled faces could be prepared for recognition");
    return AuthResult::Unavailable;
  }
  if (config.debug) {
    saveFailedFace(username, face, "not_similar");
  }

  return AuthResult::Retry;
}

}  // namespace biopass
