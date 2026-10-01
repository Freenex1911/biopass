import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FormProvider, useForm } from "react-hook-form";
import { CameraPairSetting } from "../src/app/configuration/-components/face/CameraPairSetting";
import { withCameraSetups } from "../src/lib/camera-setups";
import type { BiopassConfig, VideoDeviceInfo } from "../src/types/config";
import { configFixture } from "./config-fixture";

const devices: VideoDeviceInfo[] = [
  {
    path: "/dev/video0",
    name: "Color",
    display_name: "Color",
    stable_id: "libcamera:rgb",
  },
  {
    path: "/dev/video2",
    name: "IR",
    display_name: "IR",
    stable_id: "libcamera:ir",
  },
];
function Harness({ config }: { config: BiopassConfig }) {
  const form = useForm({ defaultValues: config });
  return createElement(FormProvider, {
    ...form,
    children: createElement(CameraPairSetting, {
      devices,
      refresh() {},
      loading: false,
      discoveryError: null,
    }),
  });
}
const render = (config: BiopassConfig) =>
  renderToStaticMarkup(createElement(Harness, { config }));

describe("camera settings decisions", () => {
  test("a single setup shows IR status without a redundant selection mode", () => {
    const html = render(withCameraSetups(configFixture()));
    expect(html).toContain("IR verification enabled");
    expect(html).not.toContain("Switch cameras automatically");
    expect(html).not.toContain("One camera setup");
    expect(html).not.toContain("Use a specific pair");
  });

  test("multiple setups share one list and offer manual or automatic selection", () => {
    const config = withCameraSetups(configFixture());
    config.methods.face.camera_selection.pairs.push({
      id: "dock",
      name: "Dock",
      camera: "libcamera:rgb",
      ir_camera: "",
    });
    const manual = render(config);
    expect(manual).toContain("Switch cameras automatically");
    expect((manual.match(/role="radio"/g) || []).length).toBe(2);
    expect(manual).toContain("No IR verification");
    config.methods.face.camera_selection.mode = "priority";
    const automatic = render(config);
    expect(automatic).toContain("Move Dock up");
    expect(automatic).not.toContain('role="radio"');
  });
});
