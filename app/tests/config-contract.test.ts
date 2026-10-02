import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { biopassConfigSchema } from "../src/app/configuration/-components/validation";
import { withCameraSetups } from "../src/lib/camera-setups";

for (const name of ["legacy", "color-only", "fixed-ir"]) {
  test(`shared configuration contract: ${name}`, () => {
    const config = JSON.parse(
      readFileSync(
        new URL(`../../tests/config-contract/${name}.json`, import.meta.url),
        "utf8",
      ),
    );
    // These defaults are supplied by Rust on the config-load IPC boundary.
    config.strategy.show_auth_status ??= false;
    delete config.methods.face.recognition.alignment;
    config.methods.face.camera_selection ??= {
      mode: "legacy",
      pairs: [],
      fixed_pair: null,
    };
    expect(biopassConfigSchema.parse(config)).toEqual(config);
    const imported = withCameraSetups(config);
    expect(biopassConfigSchema.safeParse(imported).success).toBe(true);
    expect(imported.strategy.show_auth_status).toBe(
      config.strategy.show_auth_status,
    );
    expect(imported.methods.face.anti_spoofing).toEqual(
      config.methods.face.anti_spoofing,
    );
  });
}
