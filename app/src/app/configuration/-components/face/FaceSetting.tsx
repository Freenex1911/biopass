import { useCallback, useEffect, useState } from "react";
import { Controller, useFormContext, useWatch } from "react-hook-form";
import { cmd } from "@/commands";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { selectAvailableCameraPair } from "@/lib/camera-selection";
import type { BiopassConfig, Model, VideoDeviceInfo } from "@/types/config";
import { ModelSelect } from "../methods/shared/ModelSelect";
import { Threshold } from "../methods/shared/Threshold";
import { SettingsDisclosure } from "../SettingsDisclosure";
import { CameraPairSetting } from "./CameraPairSetting";
import { FaceCapture } from "./FaceCapture";

function parseNumberInput(value: string): number {
  return value === "" ? Number.NaN : Number(value);
}

export function FaceSetting({ active = true }: { active?: boolean }) {
  const {
    control,
    formState: { errors },
    setValue,
  } = useFormContext<BiopassConfig>();
  const config = useWatch<BiopassConfig, "methods.face">({
    name: "methods.face",
  });
  const [models, setModels] = useState<Model[]>([]);
  const [videoDevices, setVideoDevices] = useState<VideoDeviceInfo[]>([]);
  const [devicesLoading, setDevicesLoading] = useState(false);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);

  const fetchDevices = useCallback(async () => {
    setDevicesLoading(true);
    try {
      setVideoDevices(await cmd.face.listVideoDevices());
      setDiscoveryError(null);
    } catch (err) {
      console.error("Failed to fetch devices:", err);
      setDiscoveryError(String(err));
      setVideoDevices([]);
    } finally {
      setDevicesLoading(false);
    }
  }, []);
  useEffect(() => {
    void fetchDevices();
    const refreshOnFocus = () => {
      void fetchDevices();
    };
    window.addEventListener("focus", refreshOnFocus);
    return () => window.removeEventListener("focus", refreshOnFocus);
  }, [fetchDevices]);

  useEffect(() => {
    const fetchModels = async () => {
      try {
        setModels(await cmd.models.list());
      } catch (err) {
        console.error("Failed to fetch models:", err);
      }
    };

    fetchModels();
  }, []);

  const antiSpoofModels = models.filter(
    (model) => model.model_type === "anti_spoofing",
  );
  const activePair = selectAvailableCameraPair(
    config.camera_selection,
    videoDevices,
  );
  const previewCamera =
    activePair?.camera === "auto" ? null : activePair?.camera || null;

  return (
    <div className="grid gap-4">
      <CameraPairSetting
        devices={videoDevices}
        refresh={() => void fetchDevices()}
        loading={devicesLoading}
        discoveryError={discoveryError}
      />
      <section className="grid gap-3" aria-labelledby="enrolled-faces-heading">
        <div>
          <h4 id="enrolled-faces-heading" className="font-medium text-sm">
            Your face
          </h4>
          <p className="text-sm text-muted-foreground">
            Use the selected color camera to save photos for recognition.
          </p>
        </div>
        <FaceCapture
          camera={previewCamera}
          available={active && Boolean(activePair)}
        />
      </section>

      <SettingsDisclosure
        className="rounded-lg border border-border/50 bg-muted/50 p-4"
        title="Advanced settings"
        hasErrors={Boolean(
          errors.methods?.face?.detection ||
            errors.methods?.face?.recognition ||
            errors.methods?.face?.anti_spoofing?.model ||
            errors.methods?.face?.retries ||
            errors.methods?.face?.retry_delay,
        )}
      >
        <div className="grid gap-4 mt-4">
          <p className="text-sm text-muted-foreground">
            AI models, sensitivity and retry timing.
          </p>
          <div className="p-4 rounded-lg bg-muted/50 border border-border/50">
            <h4 className="font-medium mb-3 text-sm">Face detection</h4>
            <div className="flex flex-col gap-4 sm:flex-row sm:gap-6 sm:items-end">
              <div className="w-full flex-1 min-w-0">
                <ModelSelect
                  label="Model"
                  value={config.detection.model_id}
                  models={models.filter((m) => m.model_type === "detection")}
                  error={
                    config.enable || !!errors.methods?.face?.detection?.model_id
                  }
                  errorMessage={
                    errors.methods?.face?.detection?.model_id?.message
                  }
                  onChange={(modelId) =>
                    setValue("methods.face.detection.model_id", modelId, {
                      shouldDirty: true,
                      shouldValidate: true,
                    })
                  }
                />
              </div>
              <div className="w-full sm:w-48 shrink-0">
                <Threshold
                  label="Threshold"
                  value={config.detection.threshold}
                  onChange={(threshold) =>
                    setValue("methods.face.detection.threshold", threshold, {
                      shouldDirty: true,
                      shouldValidate: true,
                    })
                  }
                />
              </div>
            </div>
            <h4 className="font-medium my-3 text-sm">Face recognition</h4>
            <div className="flex flex-col gap-4 sm:flex-row sm:gap-6 sm:items-end">
              <div className="w-full flex-1 min-w-0">
                <ModelSelect
                  label="Model"
                  value={config.recognition.model_id}
                  models={models.filter((m) => m.model_type === "recognition")}
                  error={
                    config.enable ||
                    !!errors.methods?.face?.recognition?.model_id
                  }
                  errorMessage={
                    errors.methods?.face?.recognition?.model_id?.message
                  }
                  onChange={(modelId) =>
                    setValue("methods.face.recognition.model_id", modelId, {
                      shouldDirty: true,
                      shouldValidate: true,
                    })
                  }
                />
              </div>
              <div className="w-full sm:w-48 shrink-0">
                <Threshold
                  label="Threshold"
                  value={config.recognition.threshold}
                  onChange={(threshold) =>
                    setValue("methods.face.recognition.threshold", threshold, {
                      shouldDirty: true,
                      shouldValidate: true,
                    })
                  }
                />
              </div>
            </div>
          </div>

          <section
            aria-labelledby="photo-protection-heading"
            className="rounded-lg border border-border/50 p-4 grid gap-4"
          >
            <div className="flex items-start justify-between gap-4">
              <div className="grid gap-1">
                <Label
                  id="photo-protection-heading"
                  htmlFor="ai-photo-protection"
                  className="font-medium"
                >
                  Photo & screen protection
                </Label>
                <p className="text-sm text-muted-foreground">
                  An optional AI check looks for signs of a printed photo or
                  screen in the color image.
                </p>
              </div>
              <Switch
                id="ai-photo-protection"
                checked={config.anti_spoofing.enable}
                onCheckedChange={(enable) =>
                  setValue("methods.face.anti_spoofing.enable", enable, {
                    shouldDirty: true,
                    shouldValidate: true,
                  })
                }
              />
            </div>
            {config.anti_spoofing.enable && (
              <div className="flex flex-col gap-4 sm:flex-row sm:gap-6 sm:items-end">
                <div className="w-full flex-1 min-w-0">
                  <ModelSelect
                    label="Model"
                    value={config.anti_spoofing.model.model_id}
                    models={antiSpoofModels}
                    error={true}
                    errorMessage={
                      errors.methods?.face?.anti_spoofing?.model?.model_id
                        ?.message
                    }
                    onChange={(model_id) =>
                      setValue(
                        "methods.face.anti_spoofing.model.model_id",
                        model_id,
                        {
                          shouldDirty: true,
                          shouldValidate: true,
                        },
                      )
                    }
                  />
                </div>
                <div className="w-full sm:w-48 shrink-0">
                  <Threshold
                    label="Threshold"
                    value={config.anti_spoofing.model.threshold}
                    onChange={(threshold) =>
                      setValue(
                        "methods.face.anti_spoofing.model.threshold",
                        threshold,
                        { shouldDirty: true, shouldValidate: true },
                      )
                    }
                  />
                </div>
              </div>
            )}
            <p className="text-xs text-muted-foreground">
              {config.anti_spoofing.enable
                ? "Enabled for every configured camera."
                : "Off. Any IR verification assigned to a camera remains active."}
            </p>
          </section>

          <div className="grid sm:grid-cols-2 gap-6 p-4 rounded-lg bg-muted/50 border border-border/50">
            <div className="grid gap-2">
              <Label
                htmlFor="face-max-retries"
                className="text-sm font-medium text-muted-foreground"
              >
                Max Retries
              </Label>
              <Controller
                control={control}
                name="methods.face.retries"
                render={({ field, fieldState }) => (
                  <>
                    <Input
                      id="face-max-retries"
                      type="number"
                      min="1"
                      value={Number.isNaN(field.value) ? "" : field.value}
                      onChange={(e) =>
                        field.onChange(parseNumberInput(e.target.value))
                      }
                      aria-invalid={fieldState.invalid}
                      className="h-10"
                    />
                    {fieldState.error && (
                      <p className="text-xs text-destructive">
                        {fieldState.error.message}
                      </p>
                    )}
                  </>
                )}
              />
            </div>
            <div className="grid gap-2">
              <Label
                htmlFor="face-retry-delay"
                className="text-sm font-medium text-muted-foreground"
              >
                Retry Delay (ms)
              </Label>
              <Controller
                control={control}
                name="methods.face.retry_delay"
                render={({ field, fieldState }) => (
                  <>
                    <Input
                      id="face-retry-delay"
                      type="number"
                      min="0"
                      max="5000"
                      value={Number.isNaN(field.value) ? "" : field.value}
                      onChange={(e) =>
                        field.onChange(parseNumberInput(e.target.value))
                      }
                      aria-invalid={fieldState.invalid}
                      className="h-10"
                    />
                    {fieldState.error && (
                      <p className="text-xs text-destructive">
                        {fieldState.error.message}
                      </p>
                    )}
                  </>
                )}
              />
            </div>
          </div>
        </div>
      </SettingsDisclosure>
    </div>
  );
}
