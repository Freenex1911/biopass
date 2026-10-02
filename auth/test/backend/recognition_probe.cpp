#include <iomanip>
#include <iostream>

#include "face_recognition.h"
#include "image_utils.h"

// Offline reference for checking evaluation preprocessing against production.
int main(int argc, char** argv) {
  if (argc != 3)
    return 2;
  try {
    const auto image = readImage(argv[2]);
    if (image.empty())
      return 2;
    biopass::FaceRecognition recognizer(argv[1], 112, 0.5f);
    const auto embedding = recognizer.embedding(image);
    std::cout << std::setprecision(9);
    for (auto value : embedding) std::cout << value << '\n';
  } catch (const std::exception& error) {
    std::cerr << error.what() << '\n';
    return 1;
  }
}
