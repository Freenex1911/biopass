#ifndef IMAGE_UTILS_H
#define IMAGE_UTILS_H

#include <algorithm>
#include <array>
#include <cmath>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <limits>
#include <opencv2/imgproc.hpp>
#include <string>
#include <vector>

#include "stb_image.h"
#include "stb_image_write.h"

/**
 * Owned RGB image container with zero-copy OpenCV views.
 * Stores 3-channel (RGB) uint8 data in row-major order.
 */
struct ImageRGB {
  int width = 0;
  int height = 0;
  std::vector<uint8_t> data;  // size = width * height * 3

  static size_t byteSize(int w, int h) {
    if (w <= 0 || h <= 0)
      return 0;
    const size_t ws = static_cast<size_t>(w);
    const size_t hs = static_cast<size_t>(h);
    if (ws > std::numeric_limits<size_t>::max() / hs / 3)
      return 0;
    return ws * hs * 3;
  }

  ImageRGB() = default;
  ImageRGB(int w, int h)
      : width(std::max(0, w)), height(std::max(0, h)), data(byteSize(width, height), 0) {}
  ImageRGB(int w, int h, const uint8_t *src) : width(std::max(0, w)), height(std::max(0, h)) {
    const size_t bytes = byteSize(width, height);
    if (bytes == 0 || !src) {
      width = 0;
      height = 0;
      return;
    }
    data.resize(bytes);
    std::memcpy(data.data(), src, bytes);
  }

  bool empty() const { return data.empty(); }
  uint8_t *ptr() { return data.data(); }
  const uint8_t *ptr() const { return data.data(); }

  uint8_t &at(int y, int x, int c) { return data[(y * width + x) * 3 + c]; }
  const uint8_t &at(int y, int x, int c) const { return data[(y * width + x) * 3 + c]; }

  ImageRGB crop(int x1, int y1, int x2, int y2) const {
    x1 = std::max(0, x1);
    y1 = std::max(0, y1);
    x2 = std::min(width, x2);
    y2 = std::min(height, y2);
    int cw = x2 - x1, ch = y2 - y1;
    if (cw <= 0 || ch <= 0)
      return {};
    ImageRGB out(cw, ch);
    for (int r = 0; r < ch; r++)
      std::memcpy(&out.data[r * cw * 3], &data[((y1 + r) * width + x1) * 3], cw * 3);
    return out;
  }

  ImageRGB clone() const {
    ImageRGB out;
    out.width = width;
    out.height = height;
    out.data = data;
    return out;
  }
};

// OpenCV operates directly on the existing RGB storage without a copy.
inline cv::Mat imageMat(const ImageRGB &image) {
  return cv::Mat(image.height, image.width, CV_8UC3, const_cast<uint8_t *>(image.ptr()));
}
inline ImageRGB resizeImageWith(const ImageRGB &src, int width, int height, int interpolation) {
  if (src.empty() || width <= 0 || height <= 0)
    return {};
  ImageRGB out(width, height);
  auto destination = imageMat(out);
  cv::resize(imageMat(src), destination, cv::Size(width, height), 0., 0., interpolation);
  return out;
}
inline ImageRGB resizeImage(const ImageRGB &src, int width, int height) {
  return resizeImageWith(src, width, height, cv::INTER_LINEAR_EXACT);
}
inline ImageRGB resizeImageArea(const ImageRGB &src, int width, int height) {
  return resizeImageWith(src, width, height, cv::INTER_AREA);
}
inline ImageRGB resizeImageLanczos4(const ImageRGB &src, int width, int height) {
  return resizeImageWith(src, width, height, cv::INTER_LANCZOS4);
}
inline ImageRGB imageLetterbox(const ImageRGB &src, int width, int height, uint8_t pad = 114) {
  if (src.empty() || width <= 0 || height <= 0)
    return {};
  const double scale = std::min(double(width) / src.width, double(height) / src.height);
  const int nw = std::clamp(int(std::round(src.width * scale)), 1, width);
  const int nh = std::clamp(int(std::round(src.height * scale)), 1, height);
  auto resized = resizeImage(src, nw, nh);
  ImageRGB out(width, height);
  auto destination = imageMat(out);
  const int left = (width - nw) / 2, top = (height - nh) / 2;
  cv::copyMakeBorder(imageMat(resized), destination, top, height - nh - top, left,
                     width - nw - left, cv::BORDER_CONSTANT, cv::Scalar::all(pad));
  return out;
}
inline ImageRGB imageResizePad(const ImageRGB &src, int width, int height) {
  return imageLetterbox(src, width, height, 0);
}
inline ImageRGB imageLetterboxReflect101(const ImageRGB &src, int size) {
  if (src.empty() || size <= 0)
    return {};
  const double ratio = double(size) / std::max(src.width, src.height);
  const int width = std::clamp(int(src.width * ratio), 1, size);
  const int height = std::clamp(int(src.height * ratio), 1, size);
  auto resized =
      resizeImageWith(src, width, height, ratio > 1. ? cv::INTER_LANCZOS4 : cv::INTER_AREA);
  ImageRGB out(size, size);
  auto destination = imageMat(out);
  const int left = (size - width) / 2, top = (size - height) / 2;
  cv::copyMakeBorder(imageMat(resized), destination, top, size - height - top, left,
                     size - width - left, cv::BORDER_REFLECT_101);
  return out;
}

/**
 * HWC RGB uint8 -> CHW float, normalized to [0,1].
 */
inline std::vector<float> imageToChw(const ImageRGB &img) {
  int h = img.height, w = img.width;
  std::vector<float> out(3 * h * w);
  for (int c = 0; c < 3; c++)
    for (int y = 0; y < h; y++)
      for (int x = 0; x < w; x++) out[c * h * w + y * w + x] = img.at(y, x, c) / 255.0f;
  return out;
}

/**
 * HWC RGB uint8 -> CHW float, with mean/std normalization.
 */
inline std::vector<float> imageToChwNormalized(const ImageRGB &img, const float mean[3],
                                               const float std_val[3]) {
  int h = img.height, w = img.width;
  std::vector<float> out(3 * h * w);
  for (int c = 0; c < 3; c++)
    for (int y = 0; y < h; y++)
      for (int x = 0; x < w; x++)
        out[c * h * w + y * w + x] = (img.at(y, x, c) / 255.0f - mean[c]) / std_val[c];
  return out;
}

namespace {
inline std::string lowercasePathExtension(const std::string &path) {
  size_t dot = path.rfind('.');
  if (dot == std::string::npos)
    return "";
  std::string ext = path.substr(dot);
  for (auto &ch : ext) ch = (char)std::tolower((unsigned char)ch);
  return ext;
}
}  // namespace

/**
 * Load image from any supported format (JPEG, PNG, BMP, GIF, TGA, PSD, HDR, PIC, PNM).
 * Automatically detects format from file contents via stb_image.
 */
inline ImageRGB readImage(const std::string &path) {
  int w = 0, h = 0, channels = 0;
  uint8_t *pixels = stbi_load(path.c_str(), &w, &h, &channels, 3);
  if (!pixels)
    return {};

  ImageRGB img(w, h, pixels);
  stbi_image_free(pixels);
  return img;
}

/**
 * Save image to file. Format is determined by file extension:
 *   .jpg / .jpeg  -> JPEG (quality 95)
 *   .png          -> PNG
 *   .bmp          -> BMP
 *   .tga          -> TGA
 * Returns false on unsupported extension or write failure.
 */
inline bool saveImage(const std::string &path, const ImageRGB &img) {
  if (img.empty())
    return false;

  std::string ext = lowercasePathExtension(path);
  int stride = img.width * 3;

  if (ext == ".jpg" || ext == ".jpeg") {
    return stbi_write_jpg(path.c_str(), img.width, img.height, 3, img.ptr(), 95) != 0;
  } else if (ext == ".png") {
    return stbi_write_png(path.c_str(), img.width, img.height, 3, img.ptr(), stride) != 0;
  } else if (ext == ".bmp") {
    return stbi_write_bmp(path.c_str(), img.width, img.height, 3, img.ptr()) != 0;
  } else if (ext == ".tga") {
    return stbi_write_tga(path.c_str(), img.width, img.height, 3, img.ptr()) != 0;
  }

  // Fallback: save as PNG
  return stbi_write_png(path.c_str(), img.width, img.height, 3, img.ptr(), stride) != 0;
}

#endif  // IMAGE_UTILS_H
