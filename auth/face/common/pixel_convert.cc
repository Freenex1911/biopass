#include "pixel_convert.h"

#include <libyuv/convert_argb.h>
#include <libyuv/convert_from_argb.h>
#include <turbojpeg.h>

#include <algorithm>
#include <cstring>

namespace biopass {

bool yuyvToRgb(const uint8_t* src, size_t size, int width, int height, int stride, ImageRGB& out) {
  if (!src || width <= 0 || height <= 0) {
    return false;
  }
  const size_t min_stride = static_cast<size_t>(width) * 2;
  const size_t row_stride = static_cast<size_t>(std::max(stride, static_cast<int>(min_stride)));
  const size_t required = row_stride * static_cast<size_t>(height - 1) + min_stride;
  if (size < required) {
    return false;
  }

  // Packed YUYV needs complete pixel pairs.
  if (width % 2 != 0)
    return false;
  out = ImageRGB(width, height);
  std::vector<uint8_t> argb(static_cast<size_t>(width) * height * 4);
  if (libyuv::YUY2ToARGB(src, static_cast<int>(row_stride), argb.data(), width * 4, width,
                         height) != 0)
    return false;
  return libyuv::ARGBToRAW(argb.data(), width * 4, out.ptr(), width * 3, width, height) == 0;
}

bool greyToRgb(const uint8_t* src, size_t size, int width, int height, int stride, ImageRGB& out) {
  if (!src || width <= 0 || height <= 0) {
    return false;
  }
  const size_t row_stride = static_cast<size_t>(std::max(stride, width));
  const size_t required = row_stride * static_cast<size_t>(height - 1) + static_cast<size_t>(width);
  if (size < required) {
    return false;
  }

  out = ImageRGB(width, height);
  cv::Mat grey(height, width, CV_8UC1, const_cast<uint8_t*>(src), row_stride);
  auto destination = imageMat(out);
  cv::cvtColor(grey, destination, cv::COLOR_GRAY2RGB);
  return true;
}

bool mjpegToRgb(const uint8_t* src, size_t bytes_used, ImageRGB& out) {
  if (!src || bytes_used < 2 || src[0] != 0xFF || src[1] != 0xD8) {
    return false;
  }

  tjhandle handle = tjInitDecompress();
  if (!handle) {
    return false;
  }

  int width = 0, height = 0, subsamp = 0, colorspace = 0;
  if (tjDecompressHeader3(handle, const_cast<unsigned char*>(src),
                          static_cast<unsigned long>(bytes_used), &width, &height, &subsamp,
                          &colorspace) != 0 ||
      width <= 0 || height <= 0) {
    tjDestroy(handle);
    return false;
  }

  out = ImageRGB(width, height);
  const int rc = tjDecompress2(handle, const_cast<unsigned char*>(src),
                               static_cast<unsigned long>(bytes_used), out.ptr(), width,
                               0 /* pitch: tightly packed */, height, TJPF_RGB, TJFLAG_FASTDCT);
  tjDestroy(handle);
  if (rc != 0) {
    out = ImageRGB();
    return false;
  }
  return true;
}

}  // namespace biopass
