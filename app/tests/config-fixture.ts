import type { BiopassConfig } from "../src/types/config";

export function configFixture(): BiopassConfig {
  return {
    schema_version: 2,
    appearance: "system",
    strategy: {
      debug: false,
      show_auth_status: false,
      execution_mode: "parallel",
      order: ["face", "fingerprint"],
      ignore_services: [],
    },
    methods: {
      face: {
        enable: true,
        retries: 5,
        retry_delay: 200,
        camera: null,
        camera_selection: { mode: "legacy", pairs: [], fixed_pair: null },
        detection: { model_id: "detection", threshold: 0.5 },
        recognition: {
          alignment: false,
          model_id: "recognition",
          threshold: 0.5,
        },
        anti_spoofing: {
          enable: false,
          model: { model_id: "protection", threshold: 0.8 },
          ir_camera: "/dev/video2",
          ir_warmup_delay_ms: 300,
          ir_presence_timeout_ms: 1500,
        },
      },
      fingerprint: { enable: false, retries: 5, timeout: 5000 },
    },
  };
}
