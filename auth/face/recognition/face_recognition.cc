#include "face_recognition.h"

#include <cmath>
#include <stdexcept>

namespace biopass {

FaceRecognition::FaceRecognition(const std::string& ckpt, int imgsz, const float threshold)
    : threshold(threshold), imgsz(imgsz), session(ckpt, "FaceRecognition") {}

std::vector<float> FaceRecognition::preprocess(const ImageRGB& input_image) {
  ImageRGB resize_img = imageResizePad(input_image, this->imgsz, this->imgsz);

  const float mean[3] = {0.5f, 0.5f, 0.5f};
  const float std[3] = {0.5f, 0.5f, 0.5f};

  return imageToChwNormalized(resize_img, mean, std);
}

std::vector<float> FaceRecognition::inference(const ImageRGB& image) {
  std::vector<float> input_data = this->preprocess(image);

  std::vector<int64_t> input_shape = {1, 3, (int64_t)this->imgsz, (int64_t)this->imgsz};
  auto output_tensors = this->session.run(input_data, input_shape);

  auto& out = output_tensors[0];
  auto shape = out.GetTensorTypeAndShapeInfo().GetShape();
  int embed_dim = static_cast<int>(shape[1]);
  const float* data = out.GetTensorData<float>();

  return std::vector<float>(data, data + embed_dim);
}

float FaceRecognition::cosine(const std::vector<float>& feat1, const std::vector<float>& feat2) {
  if (feat1.empty() || feat1.size() != feat2.size())
    throw std::invalid_argument("Face embeddings must have matching, nonzero dimensions");
  float dot_product = 0, norm1 = 0, norm2 = 0;
  for (size_t i = 0; i < feat1.size(); i++) {
    dot_product += feat1[i] * feat2[i];
    norm1 += feat1[i] * feat1[i];
    norm2 += feat2[i] * feat2[i];
  }
  norm1 = std::sqrt(norm1);
  norm2 = std::sqrt(norm2);

  if (norm1 == 0 || norm2 == 0) {
    throw std::runtime_error("One of the tensors has zero magnitude.");
  }

  float sim = dot_product / (norm1 * norm2);
  return sim;
}

std::vector<float> FaceRecognition::embedding(const ImageRGB& image) { return inference(image); }

MatchResult FaceRecognition::matchEmbeddings(const std::vector<float>& first,
                                             const std::vector<float>& second) {
  const float score = cosine(first, second);
  return MatchResult(score, score > threshold);
}

MatchResult FaceRecognition::match(const ImageRGB& image1, const ImageRGB& image2) {
  return matchEmbeddings(embedding(image1), embedding(image2));
}

}  // namespace biopass
