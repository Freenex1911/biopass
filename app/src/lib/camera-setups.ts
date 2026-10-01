import type { BiopassConfig, CameraSelectionConfig } from "@/types/config";

// Adapt old independent settings in the form only. Loading a page never writes
// the user's configuration; saving explicitly adopts the shared setup list.
export function withCameraSetups(config: BiopassConfig): BiopassConfig {
  const next = structuredClone(config);
  const face = next.methods.face;
  if (face.camera_selection.mode !== "legacy") return next;
  let id = "main-camera";
  while (face.camera_selection.pairs.some((pair) => pair.id === id)) id += "-1";
  face.camera_selection = {
    mode: "fixed",
    fixed_pair: id,
    pairs: [
      {
        id,
        name: "Main camera",
        camera: face.camera || "auto",
        ir_camera: face.anti_spoofing.ir_camera || "",
      },
      ...face.camera_selection.pairs,
    ],
  };
  return next;
}

export function cameraSelectionMode(
  selection: CameraSelectionConfig,
  automatic: boolean,
  availableId?: string,
): CameraSelectionConfig {
  return {
    ...selection,
    mode: automatic ? "priority" : "fixed",
    fixed_pair: automatic
      ? selection.fixed_pair
      : availableId || selection.fixed_pair || selection.pairs[0]?.id || null,
  };
}
