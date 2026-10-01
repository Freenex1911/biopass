import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { FormProvider, useForm } from "react-hook-form";
import { FaceSetting } from "../src/app/configuration/-components/face/FaceSetting";
import { ModelCard } from "../src/app/models";
import { configFixture } from "./config-fixture";

const model = {
  id: "custom",
  name: "Custom",
  model_type: "anti_spoofing" as const,
  path: "/tmp/custom.onnx",
  version: null,
  checksum: null,
  source: "user",
  installed_at: 0,
};
const renderCard = (
  source: string,
  reason: string | null,
  status: "available" | "missing" = "available",
) =>
  renderToStaticMarkup(
    createElement(ModelCard, {
      model: { ...model, source },
      status,
      management: {
        model,
        selected_for:
          reason && source === "user"
            ? ["Photo & screen protection (off)"]
            : [],
        delete_block_reason: reason,
      },
      onRenamed() {},
      onDelete() {},
    }),
  );

test("all models expose deletion and protected missing models stay disabled", () => {
  const bundled = renderCard("builtin", "Included with BioPass");
  expect(bundled).toContain('aria-label="Delete Custom"');
  expect(bundled).toContain("Included");
  expect(bundled).toContain("File available");
  expect(bundled).toMatch(
    /disabled=""[^>]*aria-label="Delete Custom"|aria-label="Delete Custom"[^>]*disabled=""/,
  );
  const selected = renderCard(
    "user",
    "Selected in sign-in settings",
    "missing",
  );
  expect(selected).toContain("Photo &amp; screen protection (off)");
  expect(selected).toContain("File missing");
  expect(selected).toContain("Selected");
  expect(selected).toContain("Imported");
  expect(selected).toContain('disabled=""');
  expect(renderCard("user", null)).not.toContain('disabled=""');
});

function Harness() {
  const config = configFixture();
  config.methods.face.anti_spoofing.enable = true;
  const form = useForm({ defaultValues: config });
  return createElement(FormProvider, {
    ...form,
    children: createElement(FaceSetting),
  });
}
test("protection model and threshold live together inside advanced settings", () => {
  const html = renderToStaticMarkup(createElement(Harness));
  const advanced = html.indexOf("Advanced settings");
  const protection = html.indexOf('aria-labelledby="photo-protection-heading"');
  expect(protection).toBeGreaterThan(advanced);
  const section = html.slice(
    protection,
    html.indexOf("</section>", protection),
  );
  expect(section).toContain("Photo &amp; screen protection");
  expect(section).toContain("Model");
  expect(section).toContain("Threshold");
  expect(html).not.toContain("Photo &amp; screen protection threshold");
});
