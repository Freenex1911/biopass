#include <iostream>
#include <map>
#include <stdexcept>

#include "camera_selection.h"

void require(bool condition, const char* description) {
  if (!condition)
    throw std::runtime_error(description);
}

int main() {
  using namespace biopass;
  std::map<std::string, std::string> devices;
  auto resolve = [&devices](const std::string& selector) -> std::optional<std::string> {
    const auto device = devices.find(selector);
    if (device == devices.end())
      return std::nullopt;
    return device->second;
  };
  CameraSelectionConfig config;
  config.mode = "priority";
  config.pairs = {{"dock", "Dock", "dock-rgb", "dock-ir"},
                  {"built-in", "Built-in", "surface-rgb", "surface-ir"}};
  devices = {{"surface-rgb", "libcamera:surface-rgb"}, {"surface-ir", "libcamera:surface-ir"}};
  require(selectCameraPair(config, resolve)->id == "built-in", "Missing dock must select built-in");
  devices["dock-rgb"] = "libcamera:dock-rgb";
  require(selectCameraPair(config, resolve)->id == "built-in", "Partial dock must not mix streams");
  devices["dock-ir"] = "libcamera:dock-ir";
  auto pair = selectCameraPair(config, resolve);
  require(pair && pair->id == "dock", "First complete pair must win");
  require(pair->camera == "libcamera:dock-rgb", "Selection must pin canonical identity");
  CameraSelectionConfig rgb_only;
  rgb_only.mode = "fixed";
  rgb_only.fixed_pair = "rgb-only";
  rgb_only.pairs = {{"rgb-only", "Color camera", "dock-rgb", ""}};
  const auto without_ir = selectCameraPair(rgb_only, resolve);
  require(without_ir && without_ir->ir_camera.empty(),
          "Explicit color-only setup must be available");
  rgb_only.pairs[0].ir_camera = "missing-ir";
  require(!selectCameraPair(rgb_only, resolve), "Configured IR must never be silently disabled");
  devices["auto"] = "libcamera:dock-rgb";
  rgb_only.pairs[0].camera = "auto";
  rgb_only.pairs[0].ir_camera = "dock-ir";
  require(selectCameraPair(rgb_only, resolve)->camera == "libcamera:dock-rgb",
          "Migrated automatic color selection must still pin the selected identity");
  config.mode = "fixed";
  config.fixed_pair = "dock";
  devices.erase("dock-ir");
  require(!selectCameraPair(config, resolve), "Fixed missing pair must not fall back");
  config.fixed_pair = "unknown";
  require(!selectCameraPair(config, resolve), "Unknown fixed pair must be unavailable");
  config.fixed_pair.reset();
  require(!selectCameraPair(config, resolve), "Fixed selection is required");
  config.mode = "priority";
  devices["dock-ir"] = "libcamera:dock-rgb";
  require(selectCameraPair(config, resolve)->id == "built-in",
          "Aliases of the same stream must not form a pair");
  devices.clear();
  require(!selectCameraPair(config, resolve), "No hardware must not use automatic selection");
  config.mode = "invalid";
  require(!selectCameraPair(config, resolve), "Unknown selection mode must fail closed");
  config.mode = "legacy";
  require(!selectCameraPair(config, resolve), "Legacy mode must use existing settings");
  std::cout << "Camera pair selection tests passed\n";
}
