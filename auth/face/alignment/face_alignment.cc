#include "face_alignment.h"

#include <Eigen/Geometry>
#include <algorithm>
#include <cmath>
#include <stdexcept>

namespace biopass {
namespace {
const FaceLandmarks reference{{{38.2946, 51.6963},
                               {73.5318, 51.5014},
                               {56.0252, 71.7366},
                               {41.5493, 92.3655},
                               {70.7299, 92.2041}}};
const std::vector<std::string> output_names{"cls_8",   "cls_16", "cls_32", "obj_8",
                                            "obj_16",  "obj_32", "bbox_8", "bbox_16",
                                            "bbox_32", "kps_8",  "kps_16", "kps_32"};

struct Candidate {
  double x, y, w, h;
  float score;
  FaceLandmarks points;
};

double overlap(const Candidate& first, const Candidate& second) {
  const double width =
      std::max(0., std::min(first.x + first.w, second.x + second.w) - std::max(first.x, second.x));
  const double height =
      std::max(0., std::min(first.y + first.h, second.y + second.h) - std::max(first.y, second.y));
  const double intersection = width * height;
  return intersection / (first.w * first.h + second.w * second.h - intersection);
}
}  // namespace

std::optional<ImageRGB> alignFaceLandmarks(const ImageRGB& image, const FaceLandmarks& points) {
  if (image.empty())
    return std::nullopt;
  Eigen::Matrix<double, 2, 5> source, target;
  for (int i = 0; i < 5; ++i) {
    for (int axis = 0; axis < 2; ++axis) {
      if (!std::isfinite(points[i][axis]) || points[i][axis] < 0. ||
          points[i][axis] >= (axis == 0 ? image.width : image.height))
        return std::nullopt;
      source(axis, i) = points[i][axis];
      target(axis, i) = reference[i][axis];
    }
  }
  if ((source.col(0) - source.col(1)).norm() < 2.)
    return std::nullopt;
  // Eigen implements the established Umeyama similarity fit (rotation,
  // translation and uniform scale), also used by the offline reference.
  const Eigen::Matrix3d transform = Eigen::umeyama(source, target, true);
  if (!transform.allFinite() || transform.topLeftCorner<2, 2>().determinant() <= 1e-12)
    return std::nullopt;
  double error = 0.;
  for (int i = 0; i < 5; ++i) {
    const Eigen::Vector3d point(source(0, i), source(1, i), 1.);
    error += ((transform * point).head<2>() - target.col(i)).squaredNorm();
  }
  if (std::sqrt(error / 5.) > 10.)
    return std::nullopt;
  ImageRGB output(112, 112);
  cv::Matx23d affine(transform(0, 0), transform(0, 1), transform(0, 2), transform(1, 0),
                     transform(1, 1), transform(1, 2));
  auto destination = imageMat(output);
  cv::warpAffine(imageMat(image), destination, affine, cv::Size(112, 112), cv::INTER_LINEAR,
                 cv::BORDER_CONSTANT, cv::Scalar::all(0));
  return output;
}

FaceAlignment::FaceAlignment(const std::string& path) : session_(path, "FaceAlignment") {
  if (session_.outputNames() != output_names)
    throw std::invalid_argument("Unsupported landmark model: expected YuNet output contract");
}

std::optional<FaceLandmarks> FaceAlignment::landmarks(const ImageRGB& image) {
  if (image.empty())
    return std::nullopt;
  const double scale = std::min(1., 320. / std::max(image.width, image.height));
  const int width = std::max(1, static_cast<int>(std::round(image.width * scale)));
  const int height = std::max(1, static_cast<int>(std::round(image.height * scale)));
  const int padded_width = (width + 31) / 32 * 32;
  const int padded_height = (height + 31) / 32 * 32;
  const auto resized = resizeImage(image, width, height);
  const size_t plane = static_cast<size_t>(padded_width) * padded_height;
  std::vector<float> input(plane * 3, 0.f);
  // YuNet expects unnormalized BGR, unlike the recognition models' RGB.
  for (int y = 0; y < height; ++y)
    for (int x = 0; x < width; ++x)
      for (int channel = 0; channel < 3; ++channel)
        input[channel * plane + y * padded_width + x] = resized.at(y, x, 2 - channel);
  auto outputs = session_.run(input, {1, 3, padded_height, padded_width});
  if (outputs.size() != 12)
    throw std::runtime_error("Invalid YuNet output count");
  std::vector<Candidate> candidates;
  for (int level = 0; level < 3; ++level) {
    const int stride = 8 << level, columns = padded_width / stride;
    const size_t locations = static_cast<size_t>(columns) * (padded_height / stride);
    for (int group = 0; group < 4; ++group) {
      const auto info = outputs[level + group * 3].GetTensorTypeAndShapeInfo();
      if (info.GetElementType() != ONNX_TENSOR_ELEMENT_DATA_TYPE_FLOAT ||
          info.GetElementCount() != locations * (group == 2   ? 4
                                                 : group == 3 ? 10
                                                              : 1))
        throw std::runtime_error("Invalid YuNet output shape");
    }
    const float* classes = outputs[level].GetTensorData<float>();
    const float* objects = outputs[level + 3].GetTensorData<float>();
    const float* boxes = outputs[level + 6].GetTensorData<float>();
    const float* points = outputs[level + 9].GetTensorData<float>();
    for (size_t i = 0; i < locations; ++i) {
      const float score =
          std::sqrt(std::clamp(classes[i], 0.f, 1.f) * std::clamp(objects[i], 0.f, 1.f));
      if (!std::isfinite(score) || score < .8f)
        continue;
      const double cx = (i % columns + boxes[i * 4]) * stride;
      const double cy = (i / columns + boxes[i * 4 + 1]) * stride;
      const double w = std::exp(boxes[i * 4 + 2]) * stride;
      const double h = std::exp(boxes[i * 4 + 3]) * stride;
      if (!std::isfinite(cx) || !std::isfinite(cy) || !std::isfinite(w) || !std::isfinite(h) ||
          w <= 0. || h <= 0. || cx < 0 || cy < 0 || cx >= width || cy >= height)
        continue;
      Candidate candidate{cx - w / 2., cy - h / 2., w, h, score, {}};
      for (int point = 0; point < 5; ++point) {
        candidate.points[point][0] = (points[i * 10 + point * 2] + i % columns) * stride / scale;
        candidate.points[point][1] =
            (points[i * 10 + point * 2 + 1] + i / columns) * stride / scale;
      }
      candidates.push_back(candidate);
    }
  }
  std::sort(candidates.begin(), candidates.end(),
            [](const Candidate& a, const Candidate& b) { return a.score > b.score; });
  if (candidates.empty())
    return std::nullopt;
  // Exactly one face after NMS. Never use unrelated landmarks for a selected
  // recognition crop when several people are visible.
  const auto& first = candidates.front();
  for (size_t i = 1; i < candidates.size(); ++i)
    if (overlap(first, candidates[i]) <= .3)
      return std::nullopt;
  return first.points;
}

std::optional<ImageRGB> FaceAlignment::align(const ImageRGB& image) {
  const auto points = landmarks(image);
  return points ? alignFaceLandmarks(image, *points) : std::nullopt;
}
}  // namespace biopass
