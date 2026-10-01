import { describe, expect, test } from "bun:test";
import {
  cameraSelectionMode,
  withCameraSetups,
} from "../src/lib/camera-setups";
import { configFixture } from "./config-fixture";

describe("shared camera setup list", () => {
  test("adapts old settings without modifying the loaded configuration or dropping IR", () => {
    const saved = configFixture();
    const adapted = withCameraSetups(saved);
    expect(saved.methods.face.camera_selection.mode).toBe("legacy");
    expect(adapted.methods.face.camera_selection.mode).toBe("fixed");
    expect(adapted.methods.face.camera_selection.pairs[0].camera).toBe("auto");
    expect(adapted.methods.face.camera_selection.pairs[0].ir_camera).toBe(
      "/dev/video2",
    );
    expect(withCameraSetups(adapted)).toEqual(adapted);
  });

  test("keeps saved setups and chooses a distinct ID for an imported camera", () => {
    const saved = configFixture();
    saved.methods.face.camera = "/dev/video0";
    saved.methods.face.camera_selection.pairs = [
      { id: "main-camera", name: "Dock", camera: "rgb", ir_camera: "ir" },
    ];
    const adapted = withCameraSetups(saved).methods.face.camera_selection;
    expect(adapted.pairs.length).toBe(2);
    expect(adapted.fixed_pair).toBe("main-camera-1");
    expect(adapted.pairs[1]).toEqual(
      saved.methods.face.camera_selection.pairs[0],
    );
  });

  test("switching to manual pins the currently available setup and keeps priority order", () => {
    const selection = withCameraSetups(configFixture()).methods.face
      .camera_selection;
    selection.pairs.push({
      id: "dock",
      name: "Dock",
      camera: "rgb",
      ir_camera: "ir",
    });
    const automatic = cameraSelectionMode(selection, true);
    const manual = cameraSelectionMode(automatic, false, "dock");
    expect(manual.fixed_pair).toBe("dock");
    expect(manual.mode).toBe("fixed");
    expect(manual.pairs).toEqual(selection.pairs);
  });
});
