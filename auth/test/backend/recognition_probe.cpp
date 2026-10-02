#include <iomanip>
#include <iostream>

#include "face_alignment.h"
#include "face_recognition.h"
#include "image_utils.h"

// Offline reference for checking evaluation preprocessing against production.
int main(int argc, char** argv) {
  if (argc != 3 && argc != 5)
    return 2;
  try {
    auto image = readImage(argv[2]);
    if (image.empty())
      return 2;
    if (argc == 5) {
      biopass::FaceAlignment aligner(argv[3]);
      const auto aligned = aligner.align(image);
      if (!aligned || !saveImage(argv[4], *aligned))
        return 2;
      image = *aligned;
    }
    biopass::FaceRecognition recognizer(argv[1], 112, 0.5f);
    const auto embedding = recognizer.embedding(image);
    std::cout << std::setprecision(9);
    for (auto value : embedding) std::cout << value << '\n';
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
