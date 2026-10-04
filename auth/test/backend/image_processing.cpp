#include <cmath>
#include <stdexcept>

#include "image_utils.h"
#include "pixel_convert.h"
void require(bool value) {
  if (!value)
    throw std::runtime_error("Image processing contract failed");
}
int main() {
  const uint8_t packed[]{16, 128, 235, 128, 0, 0, 0, 0, 81, 90, 81, 240};
  ImageRGB rgb;
  require(biopass::yuyvToRgb(packed, sizeof(packed), 2, 2, 8, rgb));
  require(rgb.at(0, 0, 0) <= 1 && rgb.at(0, 1, 0) >= 254);
  require(rgb.at(1, 0, 0) >= 252 && rgb.at(1, 0, 1) <= 2 && rgb.at(1, 0, 2) <= 2);
  require(!biopass::yuyvToRgb(packed, sizeof(packed) - 1, 2, 2, 8, rgb));
  require(!biopass::yuyvToRgb(packed, sizeof(packed), 3, 1, 8, rgb));
  const uint8_t grey[]{0, 255, 99, 42, 128};
  require(biopass::greyToRgb(grey, sizeof(grey), 2, 2, 3, rgb));
  for (int c = 0; c < 3; ++c) require(rgb.at(1, 0, c) == 42 && rgb.at(1, 1, c) == 128);
  auto identity = resizeImage(rgb, 2, 2);
  require(identity.data == rgb.data);
  auto letterbox = imageLetterbox(ImageRGB(2, 1, packed), 4, 4, 114);
  require(letterbox.at(0, 0, 0) == 114 && letterbox.at(3, 3, 2) == 114);
  require(resizeImage(rgb, 0, 2).empty());
  auto thin = imageLetterboxReflect101(ImageRGB(1, 100), 16);
  require(!thin.empty());
}
