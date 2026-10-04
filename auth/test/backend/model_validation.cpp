#include <stdexcept>

#include "onnx_session.h"
int main() {
  const std::string root = MODEL_DIR;
  for (auto pair : {std::pair{"yolov8n-face.onnx", "detection"},
                    std::pair{"edgeface_s_gamma_05.onnx", "recognition"},
                    std::pair{"mobilenetv3_antispoof.onnx", "anti_spoofing"}}) {
    biopass::OnnxSession session(root + "/" + pair.first, "ValidationTest");
    session.validate(pair.second);
    bool rejected = false;
    try {
      session.validate(std::string(pair.second) == "recognition" ? "detection" : "recognition");
    } catch (const std::exception&) {
      rejected = true;
    }
    if (!rejected)
      throw std::runtime_error("Wrong model type accepted");
  }
}
