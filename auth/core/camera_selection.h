#pragma once

#include <functional>
#include <optional>
#include <string>
#include <vector>

namespace biopass {

struct CameraPairConfig {
  std::string id;
  std::string name;
  std::string camera;
  std::string ir_camera;
};

struct CameraSelectionConfig {
  // legacy preserves the existing independent camera settings.
  std::string mode = "legacy";
  std::vector<CameraPairConfig> pairs;
  std::optional<std::string> fixed_pair;
};

// Select only before authentication. Missing hardware may skip a priority
// entry; a failed authentication must never trigger selection of another pair.
inline std::optional<CameraPairConfig> selectCameraPair(
    const CameraSelectionConfig& config,
    const std::function<std::optional<std::string>(const std::string&)>& resolve) {
  if (config.mode != "priority" && config.mode != "fixed") {
    return std::nullopt;
  }
  for (const auto& pair : config.pairs) {
    if (config.mode == "fixed" && (!config.fixed_pair || pair.id != *config.fixed_pair)) {
      continue;
    }
    if (!pair.id.empty() && !pair.camera.empty() && !pair.ir_camera.empty()) {
      const auto camera = resolve(pair.camera);
      const auto ir_camera = resolve(pair.ir_camera);
      if (camera && ir_camera && *camera != *ir_camera) {
        auto selected = pair;
        selected.camera = *camera;
        selected.ir_camera = *ir_camera;
        return selected;
      }
    }
    if (config.mode == "fixed") {
      return std::nullopt;
    }
  }
  return std::nullopt;
}

}  // namespace biopass
