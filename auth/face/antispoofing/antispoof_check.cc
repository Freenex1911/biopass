#include "antispoof_check.h"

#include <spdlog/spdlog.h>

#include <fstream>
#include <future>
#include <memory>
#include <vector>

#include "debug_image_io.h"
#include "face_as.h"
#include "ir_camera_as.h"

namespace biopass {

namespace {

struct AntiSpoofTask {
  std::string name;
  std::future<bool> future;
};

AntiSpoofTask make_task(const std::string& name, std::future<bool> future) {
  AntiSpoofTask task;
  task.name = name;
  task.future = std::move(future);
  return task;
}

bool checkAntiSpoofByAIModel(const FaceMethodConfig& faceCfg, const std::string& username,
                             const ImageRGB& face, const AuthConfig& authCfg,
                             const ModelRegistry& model_registry,
                             FaceAntiSpoofing* shared_protection) {
  const std::string modelPath =
      model_registry.resolveModelPath(faceCfg.anti_spoofing.model.model_id).value_or("");
  if (modelPath.empty() || !std::ifstream(modelPath).good()) {
    spdlog::error("FaceAuth: Anti-spoofing model file not found: {}", modelPath);
    return false;
  }

  try {
    std::unique_ptr<FaceAntiSpoofing> local_protection;
    if (!shared_protection)
      local_protection =
          std::make_unique<FaceAntiSpoofing>(modelPath, 128, faceCfg.anti_spoofing.model.threshold);
    const SpoofResult result =
        (shared_protection ? shared_protection : local_protection.get())->inference(face);
    if (result.spoof) {
      spdlog::warn("FaceAuth: AI anti-spoofing detected spoof, score: {}", result.score);
      if (authCfg.debug) {
        saveFailedFace(username, face, "spoof");
      }
      return false;
    }

    spdlog::debug("FaceAuth: AI anti-spoofing check passed");
    return true;
  } catch (const std::exception& e) {
    spdlog::error("FaceAuth: AI anti-spoofing check failed: {}", e.what());
    return false;
  }
}

}  // namespace

bool checkAntiSpoof(const FaceMethodConfig& face_config, const std::string& username,
                    const ImageRGB& face, const AuthConfig& config,
                    const ModelRegistry& model_registry, FaceDetection* shared_detector,
                    ICameraCaptureSession* ir_camera_session) {
  return checkAntiSpoof(face_config, username, face, config, model_registry, shared_detector,
                        ir_camera_session, nullptr, nullptr);
}

bool checkAntiSpoof(const FaceMethodConfig& face_config, const std::string& username,
                    const ImageRGB& face, const AuthConfig& config,
                    const ModelRegistry& model_registry, FaceDetection* shared_detector,
                    ICameraCaptureSession* ir_camera_session, FaceAntiSpoofing* shared_protection,
                    std::atomic<bool>* cancel_signal) {
  if (cancel_signal && cancel_signal->load())
    return false;
  const bool ai_enabled = face_config.anti_spoofing.enable;
  const bool ir_enabled = face_config.anti_spoofing.ir_camera.has_value() &&
                          !face_config.anti_spoofing.ir_camera->empty();

  if (!ai_enabled && !ir_enabled) {
    spdlog::debug("FaceAuth: Anti-spoofing methods are disabled, skipping checks");
    return true;
  }

  spdlog::debug("FaceAuth: Anti-spoofing started (ai_enabled={}, ir_enabled={}, ir_camera='{}')",
                ai_enabled, ir_enabled, face_config.anti_spoofing.ir_camera.value_or(""));

  std::vector<AntiSpoofTask> tasks;

  if (ai_enabled) {
    const auto face_config_copy = face_config;
    const auto username_copy = username;
    const auto config_copy = config;
    const auto* model_registry_ptr = &model_registry;
    auto shared_face = std::make_shared<const ImageRGB>(face);
    tasks.push_back(make_task(
        "AI",
        std::async(std::launch::async, [face_config_copy, username_copy, shared_face, config_copy,
                                        model_registry_ptr, shared_protection]() {
          return checkAntiSpoofByAIModel(face_config_copy, username_copy, *shared_face, config_copy,
                                         *model_registry_ptr, shared_protection);
        })));
  }

  if (ir_enabled) {
    const auto ir_camera_path = *face_config.anti_spoofing.ir_camera;
    const auto username_copy = username;
    const auto debug_enabled = config.debug;
    const auto warmup_delay_ms = face_config.anti_spoofing.ir_warmup_delay_ms;
    const auto presence_timeout_ms = face_config.anti_spoofing.ir_presence_timeout_ms;
    auto* ir_camera_session_ptr = ir_camera_session;
    tasks.push_back(make_task(
        "IR", std::async(std::launch::async, [ir_camera_path, shared_detector, username_copy,
                                              debug_enabled, warmup_delay_ms, presence_timeout_ms,
                                              ir_camera_session_ptr, cancel_signal]() {
          return checkAntispoofByIRCamera(ir_camera_path, shared_detector, username_copy,
                                          debug_enabled, ir_camera_session_ptr, warmup_delay_ms,
                                          presence_timeout_ms, cancel_signal);
        })));
  }

  bool all_passed = true;
  for (auto& task : tasks) {
    bool ok = false;
    try {
      ok = task.future.get();
    } catch (const std::exception& e) {
      spdlog::error("FaceAuth: {} anti-spoofing task failed: {}", task.name, e.what());
      ok = false;
    }
    if (ok) {
      spdlog::debug("FaceAuth: {} anti-spoofing method passed", task.name);
    } else {
      spdlog::debug("FaceAuth: {} anti-spoofing method failed", task.name);
      all_passed = false;
    }
  }

  if (!all_passed) {
    spdlog::error("FaceAuth: Anti-spoofing failed (one or more enabled methods failed)");
  }
  return all_passed && !(cancel_signal && cancel_signal->load());
}

}  // namespace biopass
