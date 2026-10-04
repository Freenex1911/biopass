#include "onnx_session.h"

#include <cmath>
#include <mutex>
#include <opencv2/core.hpp>
#include <stdexcept>

namespace biopass {

OnnxSession::OnnxSession(const std::string& model_path, const char* log_name)
    : env_(ORT_LOGGING_LEVEL_WARNING, log_name) {
  static std::once_flag image_threads;
  std::call_once(image_threads, [] { cv::setNumThreads(1); });
  Ort::SessionOptions opts;
  opts.SetIntraOpNumThreads(1);
  opts.SetGraphOptimizationLevel(GraphOptimizationLevel::ORT_ENABLE_ALL);

  session_ = std::make_unique<Ort::Session>(env_, model_path.c_str(), opts);

  for (size_t i = 0; i < session_->GetInputCount(); i++) {
    auto name = session_->GetInputNameAllocated(i, allocator_);
    input_names_str_.push_back(name.get());
  }
  for (size_t i = 0; i < session_->GetOutputCount(); i++) {
    auto name = session_->GetOutputNameAllocated(i, allocator_);
    output_names_str_.push_back(name.get());
  }
  for (auto& s : input_names_str_) input_names_cstr_.push_back(s.c_str());
  for (auto& s : output_names_str_) output_names_cstr_.push_back(s.c_str());
}

std::vector<int64_t> OnnxSession::inputShape() const {
  return session_->GetInputTypeInfo(0).GetTensorTypeAndShapeInfo().GetShape();
}
void OnnxSession::validate(const std::string& kind) {
  if (session_->GetInputCount() != 1 || session_->GetOutputCount() != 1 ||
      session_->GetInputTypeInfo(0).GetTensorTypeAndShapeInfo().GetElementType() !=
          ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT)
    throw std::invalid_argument("Model must have one float32 image input and one output");
  auto shape = inputShape();
  int size = kind == "detection" ? 640 : 112;
  if (kind == "anti_spoofing") {
    if (shape.size() != 4 || (shape[2] != 80 && shape[2] != 128) || shape[2] != shape[3])
      throw std::invalid_argument("Protection model must use an 80px or 128px image input");
    size = static_cast<int>(shape[2]);
  } else if (kind != "detection" && kind != "recognition") {
    throw std::invalid_argument("Unknown model type");
  }
  const std::vector<int64_t> expected{1, 3, size, size};
  if (shape.size() != expected.size())
    throw std::invalid_argument("Model requires an NCHW image input");
  for (size_t i = 0; i < shape.size(); ++i)
    if (shape[i] > 0 && shape[i] != expected[i])
      throw std::invalid_argument("Model image dimensions are incompatible with the selected type");
  std::vector<float> image(3 * size * size, 0.f);
  auto outputs = run(image, expected);
  auto info = outputs[0].GetTensorTypeAndShapeInfo();
  auto output = info.GetShape();
  if (info.GetElementType() != ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT)
    throw std::invalid_argument("Model output must be float32");
  bool valid = false;
  if (kind == "detection")
    valid = output.size() == 3 && output[0] == 1 && (output[1] == 5 || output[1] == 20) &&
            output[2] > 0;
  else if (kind == "recognition")
    valid = output.size() == 2 && output[0] == 1 && output[1] > 0 && output[1] <= 4096;
  else
    valid = output.size() == 2 && output[0] == 1 && output[1] == 2;
  if (!valid)
    throw std::invalid_argument("Model output is incompatible with the selected type");
  const float* data = outputs[0].GetTensorData<float>();
  for (size_t i = 0; i < info.GetElementCount(); ++i)
    if (!std::isfinite(data[i]))
      throw std::invalid_argument("Model produced non-finite values");
}

std::vector<Ort::Value> OnnxSession::run(std::vector<float>& input,
                                         const std::vector<int64_t>& shape) {
  auto memory_info = Ort::MemoryInfo::CreateCpu(OrtArenaAllocator, OrtMemTypeDefault);
  Ort::Value input_tensor = Ort::Value::CreateTensor<float>(memory_info, input.data(), input.size(),
                                                            shape.data(), shape.size());

  return session_->Run(Ort::RunOptions{nullptr}, input_names_cstr_.data(), &input_tensor, 1,
                       output_names_cstr_.data(), output_names_cstr_.size());
}

}  // namespace biopass
