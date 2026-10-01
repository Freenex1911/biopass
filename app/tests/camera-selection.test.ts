import { describe, expect, test } from "bun:test";
import type { CameraSelectionConfig, VideoDeviceInfo } from "@/types/config";
import { selectAvailableCameraPair } from "../src/lib/camera-selection";

const selection: CameraSelectionConfig = {
  mode: "priority",
  fixed_pair: null,
  pairs: [
    {
      id: "dock",
      name: "Dock",
      camera: "libcamera:dock-rgb",
      ir_camera: "libcamera:dock-ir",
    },
    {
      id: "surface",
      name: "Surface",
      camera: "libcamera:surface-rgb",
      ir_camera: "libcamera:surface-ir",
    },
  ],
};
const device = (id: string, path: string): VideoDeviceInfo => ({
  stable_id: `libcamera:${id}`,
  path,
  name: id,
  display_name: id,
});
const surface = [
  device("surface-rgb", "/dev/video0"),
  device("surface-ir", "/dev/video2"),
];

describe("camera pair status and preview", () => {
  test("uses the built-in pair when the dock is disconnected", () => {
    expect(selectAvailableCameraPair(selection, surface)?.id).toBe("surface");
  });
  test("prefers a complete dock and does not mix partial pairs", () => {
    const partial = [...surface, device("dock-rgb", "/dev/video4")];
    expect(selectAvailableCameraPair(selection, partial)?.id).toBe("surface");
    expect(
      selectAvailableCameraPair(selection, [
        ...partial,
        device("dock-ir", "/dev/video6"),
      ])?.id,
    ).toBe("dock");
  });
  test("fixed missing pairs disable preview instead of auto-selecting", () => {
    expect(
      selectAvailableCameraPair(
        { ...selection, mode: "fixed", fixed_pair: "dock" },
        surface,
      ),
    ).toBeUndefined();
  });
  test("stable IDs survive video device renumbering", () => {
    expect(
      selectAvailableCameraPair(selection, [
        device("surface-rgb", "/dev/video8"),
        device("surface-ir", "/dev/video10"),
      ])?.id,
    ).toBe("surface");
  });
  test("legacy mode keeps independent selection", () => {
    expect(
      selectAvailableCameraPair({ ...selection, mode: "legacy" }, surface),
    ).toBeUndefined();
  });
  test("aliases of one stream cannot form a color/IR pair", () => {
    expect(
      selectAvailableCameraPair(
        {
          ...selection,
          pairs: [
            {
              id: "invalid",
              name: "Invalid",
              camera: "/dev/video0",
              ir_camera: "libcamera:surface-rgb",
            },
          ],
        },
        surface,
      ),
    ).toBeUndefined();
  });
  test("an explicitly color-only setup does not require an IR stream", () => {
    expect(
      selectAvailableCameraPair(
        { ...selection, pairs: [{ ...selection.pairs[1], ir_camera: "" }] },
        [surface[0]],
      )?.id,
    ).toBe("surface");
    expect(
      selectAvailableCameraPair({ ...selection, pairs: [selection.pairs[1]] }, [
        surface[0],
      ]),
    ).toBeUndefined();
  });
  test("migrated automatic color settings use the backend's first stream", () => {
    expect(
      selectAvailableCameraPair(
        { ...selection, pairs: [{ ...selection.pairs[1], camera: "auto" }] },
        surface,
      )?.id,
    ).toBe("surface");
    expect(
      selectAvailableCameraPair(
        {
          ...selection,
          pairs: [
            {
              ...selection.pairs[1],
              camera: "auto",
              ir_camera: "libcamera:surface-rgb",
            },
          ],
        },
        surface,
      ),
    ).toBeUndefined();
  });
});
