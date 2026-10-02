#pragma once

#include <array>
#include <optional>

#include "image_utils.h"
#include "onnx_session.h"

namespace biopass {

using FaceLandmarks = std::array<std::array<double, 2>, 5>;

// Standard 112px ArcFace reference; shared by EdgeFace and FaceLiVT.
std::optional<ImageRGB> alignFaceLandmarks(const ImageRGB& image, const FaceLandmarks& points);

class FaceAlignment {
 public:
  explicit FaceAlignment(const std::string& model_path);
  std::optional<FaceLandmarks> landmarks(const ImageRGB& image);
  std::optional<ImageRGB> align(const ImageRGB& image);
  static constexpr const char* installedModelPath =
      "/usr/share/com.ticklab.biopass/models/yunet-landmarks.onnx";

 private:
  OnnxSession session_;
};

}  // namespace biopass
