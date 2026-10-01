import { describe, expect, test } from "bun:test";
import { biopassConfigSchema } from "../src/app/configuration/-components/validation";

const schema =
  biopassConfigSchema.shape.methods.shape.face.shape.camera_selection;
const draft = { id: "dock", name: "", camera: "", ir_camera: "" };

describe("camera selection mode changes", () => {
  test("unused draft pairs do not block individual camera settings", () => {
    expect(
      schema.safeParse({ mode: "legacy", pairs: [draft], fixed_pair: null })
        .success,
    ).toBe(true);
  });

  test("automatic and fixed selection require complete named pairs", () => {
    for (const mode of ["priority", "fixed"]) {
      expect(
        schema.safeParse({ mode, pairs: [draft], fixed_pair: "dock" }).success,
      ).toBe(false);
    }
  });

  test("fixed selection requires an explicit existing pair", () => {
    const pairs = [
      { id: "dock", name: "Dock", camera: "rgb", ir_camera: "ir" },
    ];
    expect(
      schema.safeParse({ mode: "fixed", pairs, fixed_pair: null }).success,
    ).toBe(false);
    expect(
      schema.safeParse({ mode: "fixed", pairs, fixed_pair: "dock" }).success,
    ).toBe(true);
  });
  test("IR is optional for either selection policy", () => {
    for (const mode of ["fixed", "priority"]) {
      expect(
        schema.safeParse({
          mode,
          fixed_pair: "camera",
          pairs: [
            { id: "camera", name: "Camera", camera: "rgb", ir_camera: "" },
          ],
        }).success,
      ).toBe(true);
    }
  });
});
