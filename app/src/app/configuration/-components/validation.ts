import { toast } from "sonner";
import { z } from "zod";
import { cmd } from "@/commands";
import type { BiopassConfig } from "@/types/config";

const thresholdSchema = z
  .number("Threshold must be a number")
  .min(0, "Threshold must be at least 0%")
  .max(1, "Threshold must be at most 100%");

export const biopassConfigSchema = z.object({
  schema_version: z.number(),
  strategy: z.object({
    debug: z.boolean(),
    execution_mode: z.enum(["sequential", "parallel"]),
    order: z.array(z.string()),
    ignore_services: z.array(z.string()),
  }),
  methods: z.object({
    face: z.object({
      enable: z.boolean(),
      camera: z.string().nullable(),
      camera_selection: z
        .object({
          mode: z.enum(["legacy", "priority", "fixed"]),
          fixed_pair: z.string().nullable(),
          pairs: z.array(
            z.object({
              id: z.string().min(1),
              name: z.string(),
              camera: z.string(),
              ir_camera: z.string(),
            }),
          ),
        })
        .superRefine((selection, ctx) => {
          if (selection.mode === "legacy") return;
          if (!selection.pairs.length) {
            ctx.addIssue({
              code: "custom",
              message: "Add at least one camera",
              path: ["pairs"],
            });
          }
          if (
            selection.mode === "fixed" &&
            !selection.pairs.some((p) => p.id === selection.fixed_pair)
          ) {
            ctx.addIssue({
              code: "custom",
              message: "Select the camera to use",
              path: ["fixed_pair"],
            });
          }
          const ids = new Set<string>();
          selection.pairs.forEach((pair, index) => {
            if (!pair.name.trim())
              ctx.addIssue({
                code: "custom",
                message: "Give this camera a name",
                path: ["pairs", index, "name"],
              });
            if (ids.has(pair.id))
              ctx.addIssue({
                code: "custom",
                message: "Duplicate camera pair",
                path: ["pairs", index, "id"],
              });
            ids.add(pair.id);
            for (const field of ["camera"] as const) {
              if (!pair[field])
                ctx.addIssue({
                  code: "custom",
                  message: "Select a camera",
                  path: ["pairs", index, field],
                });
            }
            if (pair.camera && pair.camera === pair.ir_camera) {
              ctx.addIssue({
                code: "custom",
                message: "Use different color and IR streams",
                path: ["pairs", index, "ir_camera"],
              });
            }
          });
        }),
      retries: z
        .number("Max retries must be a number")
        .int("Max retries must be a whole number")
        .min(1, "Max retries must be at least 1"),
      retry_delay: z
        .number("Retry delay must be a number")
        .int("Retry delay must be a whole number")
        .min(1, "Retry delay must be at least 1 ms")
        .max(5000, "Retry delay must be at most 5000 ms"),
      detection: z.object({
        model_id: z.string(),
        threshold: thresholdSchema,
      }),
      recognition: z.object({
        model_id: z.string(),
        threshold: thresholdSchema,
      }),
      anti_spoofing: z.object({
        enable: z.boolean(),
        model: z.object({
          model_id: z.string(),
          threshold: thresholdSchema,
        }),
        ir_camera: z.string().nullable(),
        ir_warmup_delay_ms: z
          .number("IR warmup delay must be a number")
          .int("IR warmup delay must be a whole number")
          .min(0, "IR warmup delay must be at least 0 ms"),
        ir_presence_timeout_ms: z
          .number("IR presence timeout must be a number")
          .int("IR presence timeout must be a whole number")
          .min(0, "IR presence timeout must be at least 0 ms"),
      }),
    }),
    fingerprint: z.object({
      enable: z.boolean(),
      retries: z
        .number("Max retries must be a number")
        .int("Max retries must be a whole number")
        .min(1, "Max retries must be at least 1"),
      timeout: z
        .number("Timeout must be a number")
        .int("Timeout must be a whole number")
        .min(1, "Timeout must be at least 1 ms")
        .max(5000, "Timeout must be at most 5000 ms"),
    }),
  }),
  appearance: z.string(),
});

// Model existence/file checks need a live models list from the SQLite
// registry (no longer embedded in the form state), so they run here as a
// separate async pass rather than inside the zod schema's synchronous
// superRefine.
export async function validateConfig(config: BiopassConfig): Promise<boolean> {
  const models = await cmd.models.list();
  const modelsById = new Map(models.map((m) => [m.id, m]));

  if (config.methods.face.enable) {
    if (
      !config.methods.face.detection.model_id ||
      !modelsById.has(config.methods.face.detection.model_id)
    ) {
      toast.error("Valid Face Detection model is required");
      return false;
    }
    if (
      !config.methods.face.recognition.model_id ||
      !modelsById.has(config.methods.face.recognition.model_id)
    ) {
      toast.error("Valid Face Recognition model is required");
      return false;
    }
    if (
      config.methods.face.anti_spoofing.enable &&
      (!config.methods.face.anti_spoofing.model.model_id ||
        !modelsById.has(config.methods.face.anti_spoofing.model.model_id))
    ) {
      toast.error("Valid Anti-Spoofing model is required when enabled");
      return false;
    }

    try {
      const samples = await cmd.face.listImages();
      if (samples.length === 0) {
        toast.error(
          "At least one face sample must be captured before enabling Face method",
        );
        return false;
      }
    } catch (err) {
      console.error("Failed to check face samples:", err);
    }
  }

  const modelIdsToCheck: string[] = [];
  if (config.methods.face.enable) {
    if (config.methods.face.detection.model_id)
      modelIdsToCheck.push(config.methods.face.detection.model_id);
    if (config.methods.face.recognition.model_id)
      modelIdsToCheck.push(config.methods.face.recognition.model_id);
    if (
      config.methods.face.anti_spoofing.enable &&
      config.methods.face.anti_spoofing.model.model_id
    ) {
      modelIdsToCheck.push(config.methods.face.anti_spoofing.model.model_id);
    }
  }
  for (const modelId of modelIdsToCheck) {
    const model = modelsById.get(modelId);
    if (!model) continue;
    try {
      const exists = await cmd.file.exists(model.path);
      if (!exists) {
        toast.error(
          `Model file not found: ${model.name}. Please check AI Models.`,
        );
        return false;
      }
    } catch (err) {
      console.error(`Failed to check model file at ${model.path}:`, err);
      toast.error(
        err instanceof Error
          ? err.message
          : "Unknown error occurred while validating models",
      );
      return false;
    }
  }

  return true;
}
