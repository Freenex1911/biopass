#include <cmath>
#include <future>
#include <iostream>
#include <stdexcept>
#include <thread>

#include "face_recognition.h"
#include "ir_camera_as.h"

int main() {
  std::atomic<bool> cancel{false};
  const auto start = std::chrono::steady_clock::now();
  auto ir = std::async(std::launch::async, [&] {
    return biopass::checkAntispoofByIRCamera("test-only-no-device", nullptr, "test", false, nullptr,
                                             3000, 1500, &cancel);
  });
  std::this_thread::sleep_for(std::chrono::milliseconds(50));
  cancel.store(true);
  if (ir.get() || std::chrono::steady_clock::now() - start > std::chrono::seconds(1))
    throw std::runtime_error("IR warmup ignored cancellation");
  biopass::FaceRecognition recognizer(std::string(MODEL_DIR) + "/edgeface_s_gamma_05.onnx");
  ImageRGB first(112, 112), second(112, 112);
  for (size_t i = 0; i < first.data.size(); ++i) {
    first.data[i] = i % 251;
    second.data[i] = (i * 7) % 253;
  }
  const auto old = recognizer.match(first, second);
  const auto cached = recognizer.embedding(first);
  for (int attempt = 0; attempt < 3; ++attempt) {
    const auto updated = recognizer.matchEmbeddings(cached, recognizer.embedding(second));
    if (std::abs(updated.dist - old.dist) > 1e-6 || updated.similar != old.similar)
      throw std::runtime_error("Cached matching changed recognition result");
  }
  bool rejected = false;
  try {
    recognizer.matchEmbeddings(cached, {});
  } catch (const std::invalid_argument&) {
    rejected = true;
  }
  if (!rejected)
    throw std::runtime_error("Malformed embedding accepted");
  std::cout << "Cached and direct ONNX comparisons agree\n";
}
