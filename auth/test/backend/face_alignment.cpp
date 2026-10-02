#include "face_alignment.h"

#include <cmath>
#include <limits>
#include <stdexcept>

void require(bool value, const char* message) {
  if (!value)
    throw std::runtime_error(message);
}

int main() {
  const biopass::FaceLandmarks points{{{38.2946, 51.6963},
                                       {73.5318, 51.5014},
                                       {56.0252, 71.7366},
                                       {41.5493, 92.3655},
                                       {70.7299, 92.2041}}};
  ImageRGB image(112, 112);
  for (int y = 0; y < 112; ++y)
    for (int x = 0; x < 112; ++x)
      for (int c = 0; c < 3; ++c) image.at(y, x, c) = (x + 2 * y + c) % 256;
  const auto identity = biopass::alignFaceLandmarks(image, points);
  require(identity && identity->data == image.data, "Identity alignment changed pixels");

  ImageRGB shifted(132, 132);
  auto shifted_points = points;
  for (auto& point : shifted_points) {
    point[0] += 10;
    point[1] += 10;
  }
  for (int y = 0; y < 112; ++y)
    for (int x = 0; x < 112; ++x)
      for (int c = 0; c < 3; ++c) shifted.at(y + 10, x + 10, c) = image.at(y, x, c);
  const auto translated = biopass::alignFaceLandmarks(shifted, shifted_points);
  require(translated && translated->data == image.data, "Translation was not recovered");
  for (const double angle : {-.3, .3}) {
    auto rotated = points;
    for (auto& point : rotated) {
      const double x = point[0], y = point[1];
      point[0] = 2 * (std::cos(angle) * x - std::sin(angle) * y) + 30;
      point[1] = 2 * (std::sin(angle) * x + std::cos(angle) * y) + 30;
    }
    require(biopass::alignFaceLandmarks(ImageRGB(400, 400), rotated).has_value(),
            "Valid rotation rejected");
  }
  require(!biopass::alignFaceLandmarks({}, points), "Empty image accepted");
  require(!biopass::alignFaceLandmarks(image, {}), "Degenerate landmarks accepted");
  auto invalid = points;
  invalid[0][0] = std::numeric_limits<double>::quiet_NaN();
  require(!biopass::alignFaceLandmarks(image, invalid), "Nonfinite landmarks accepted");
  invalid = points;
  invalid[2][0] += 100;
  invalid[2][1] += 100;
  require(!biopass::alignFaceLandmarks(image, invalid), "Inconsistent landmarks accepted");

  biopass::FaceAlignment model(ALIGNMENT_MODEL);
  ImageRGB blank(320, 240);
  require(!model.align(blank), "A blank image became an aligned face");
  bool rejected = false;
  try {
    biopass::FaceAlignment wrong(std::string(MODEL_DIR) + "/edgeface_s_gamma_05.onnx");
  } catch (const std::invalid_argument&) {
    rejected = true;
  }
  require(rejected, "Recognizer incorrectly accepted as landmark detector");
}
