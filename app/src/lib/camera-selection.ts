import type {
  CameraPairConfig,
  CameraSelectionConfig,
  VideoDeviceInfo,
} from "@/types/config";

export function cameraMatches(device: VideoDeviceInfo, selector: string) {
  return device.stable_id === selector || device.path === selector;
}

// UI status/preview only; the authentication backend independently selects
// and pins its pair from current libcamera enumeration.
export function selectAvailableCameraPair(
  selection: CameraSelectionConfig,
  devices: VideoDeviceInfo[],
): CameraPairConfig | undefined {
  if (selection.mode === "legacy") return undefined;
  const candidates =
    selection.mode === "fixed"
      ? selection.pairs.filter((pair) => pair.id === selection.fixed_pair)
      : selection.pairs;
  return candidates.find((pair) => {
    const camera =
      pair.camera === "auto"
        ? devices[0]
        : devices.find((device) => cameraMatches(device, pair.camera));
    const ir = devices.find((device) => cameraMatches(device, pair.ir_camera));
    return (
      camera && (!pair.ir_camera || (ir && camera.stable_id !== ir.stable_id))
    );
  });
}
