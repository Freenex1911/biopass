import { useCallback, useEffect, useState } from "react";
import { Controller, useFormContext, useWatch } from "react-hook-form";
import { ModelStatus } from "@/app/-components/ModelStatus";
import { cmd } from "@/commands";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  cameraMatches,
  selectAvailableCameraPair,
} from "@/lib/camera-selection";
import type { BiopassConfig, Model, VideoDeviceInfo } from "@/types/config";
import { ModelSelect } from "../methods/shared/ModelSelect";
import { Threshold } from "../methods/shared/Threshold";
import { CameraPairSetting } from "./CameraPairSetting";
import { FaceCapture } from "./FaceCapture";

function parseNumberInput(value: string): number {
  return value === "" ? Number.NaN : Number(value);
}

export function FaceSetting() {
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
  const [antiSpoofStatusMap, setAntiSpoofStatusMap] = useState<
    Record<string, boolean>
  >({});

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

  const cameraPath = config.camera;
  const selectedCamera = cameraPath
    ? (videoDevices.find((device) => cameraMatches(device, cameraPath)) ?? null)
    : null;

  const irCameraPath = config.anti_spoofing.ir_camera;
  const selectedIrCamera = irCameraPath
    ? (videoDevices.find((device) => cameraMatches(device, irCameraPath)) ??
      null)
    : null;

  const antiSpoofModels = models.filter(
    (m) => m.model_type === "anti_spoofing",
  );

  useEffect(() => {
    const checkAntiSpoofModels = async () => {
      const newStatusMap: Record<string, boolean> = {};
      await Promise.all(
        antiSpoofModels.map(async (m) => {
          try {
            newStatusMap[m.id] = await cmd.file.exists(m.path);
          } catch {
            newStatusMap[m.id] = false;
          }
        }),
      );
      setAntiSpoofStatusMap(newStatusMap);
    };

    checkAntiSpoofModels();
  }, [models]);

  const disabledOption = "__disabled__";
  const unavailableAiModelOption = "__unavailable_ai_model__";
  const unavailableIrDeviceOption = "__unavailable_ir_device__";
  const selectedAiModelExists = antiSpoofModels.some(
    (model) => model.id === config.anti_spoofing.model.model_id,
  );
  const unavailableCameraDeviceOption = "__unavailable_camera_device__";
  const cameraValue = config.camera
    ? (selectedCamera?.stable_id ?? unavailableCameraDeviceOption)
    : disabledOption;
  const irCameraValue = config.anti_spoofing.ir_camera
    ? (selectedIrCamera?.stable_id ?? unavailableIrDeviceOption)
    : disabledOption;

  const aiModelValue = config.anti_spoofing.enable
    ? selectedAiModelExists
      ? config.anti_spoofing.model.model_id
      : unavailableAiModelOption
    : disabledOption;
  const paired = config.camera_selection.mode !== "legacy";
  const activePair = selectAvailableCameraPair(
    config.camera_selection,
    videoDevices,
  );
  const previewCamera = paired ? (activePair?.camera ?? null) : config.camera;

  return (
    <div className="grid gap-4">
      <CameraPairSetting
        devices={videoDevices}
        refresh={() => void fetchDevices()}
        loading={devicesLoading}
        discoveryError={discoveryError}
      >
        {!paired && (
          <div className="grid gap-4 sm:grid-cols-2">
            <div className="grid gap-2">
              <Label
                htmlFor="camera-device"
                className="text-sm font-medium text-muted-foreground"
              >
                Color camera
              </Label>
              <Select
                value={cameraValue}
                onValueChange={(value) => {
                  if (value === disabledOption) {
                    setValue("methods.face.camera", null, {
                      shouldDirty: true,
                      shouldValidate: true,
                    });
                    return;
                  }
                  setValue("methods.face.camera", value, {
                    shouldDirty: true,
                    shouldValidate: true,
                  });
                }}
              >
                <SelectTrigger id="camera-device" className="h-10 w-full">
                  <SelectValue placeholder="Automatic color camera" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={disabledOption}>
                    Automatic color camera
                  </SelectItem>
                  {cameraValue === unavailableCameraDeviceOption && (
                    <SelectItem value={unavailableCameraDeviceOption} disabled>
                      Selected camera unavailable
                    </SelectItem>
                  )}
                  {videoDevices.length > 0 ? (
                    videoDevices.map((device) => (
                      <SelectItem
                        key={device.stable_id}
                        value={device.stable_id}
                      >
                        {device.display_name}
                      </SelectItem>
                    ))
                  ) : (
                    <SelectItem value="__no_devices__" disabled>
                      No video devices found
                    </SelectItem>
                  )}
                </SelectContent>
              </Select>
            </div>
            <div className="grid gap-2">
              <Label
                htmlFor="ir-device"
                className="text-sm font-medium text-muted-foreground"
              >
                IR camera
              </Label>
              <Select
                value={irCameraValue}
                onValueChange={(value) => {
                  setValue(
                    "methods.face.anti_spoofing.ir_camera",
                    value === disabledOption ? null : value,
                    {
                      shouldDirty: true,
                      shouldValidate: true,
                    },
                  );
                }}
              >
                <SelectTrigger id="ir-device" className="h-10 w-full">
                  <SelectValue placeholder="Select an IR camera" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value={disabledOption}>No IR camera</SelectItem>
                  {irCameraValue === unavailableIrDeviceOption && (
                    <SelectItem value={unavailableIrDeviceOption} disabled>
                      Selected IR camera unavailable
                    </SelectItem>
                  )}
                  {videoDevices.length > 0 ? (
                    videoDevices.map((device) => (
                      <SelectItem
                        key={device.stable_id}
                        value={device.stable_id}
                      >
                        {device.display_name}
                      </SelectItem>
                    ))
                  ) : (
                    <SelectItem value="__no_ir_devices__" disabled>
                      No video devices found
                    </SelectItem>
                  )}
                </SelectContent>
              </Select>
            </div>
          </div>
        )}
      </CameraPairSetting>
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
          available={!paired || Boolean(activePair)}
        />
      </section>
      <div className="p-4 rounded-lg bg-muted/50 border border-border/50 space-y-3">
        <h4 className="font-medium text-sm">Liveness checks</h4>
        <div className="rounded-md border bg-background p-3 space-y-1">
          <p className="text-sm font-medium">Infrared check</p>
          <p className="text-sm text-muted-foreground">
            {paired
              ? activePair
                ? `Required. Uses the IR stream from ${activePair.name || "the selected pair"}.`
                : "Required, but no complete camera pair is currently connected."
              : config.anti_spoofing.ir_camera
                ? selectedIrCamera
                  ? "Enabled. Uses the IR camera selected above."
                  : "Configured IR camera disconnected. Reconnect it or update the camera selection above."
                : "Off. Select an IR camera above to enable it."}
          </p>
          <p className="text-xs text-muted-foreground">
            Checks for a face in the IR image during login.
          </p>
        </div>
        <div className="grid gap-2">
          <Label
            htmlFor="anti-spoofing-method"
            className="text-xs text-muted-foreground"
          >
            AI check (optional)
          </Label>
          <Select
            value={aiModelValue}
            onValueChange={(value) => {
              if (value === disabledOption) {
                setValue("methods.face.anti_spoofing.enable", false, {
                  shouldDirty: true,
                  shouldValidate: true,
                });
                return;
              }

              setValue("methods.face.anti_spoofing.enable", true, {
                shouldDirty: true,
                shouldValidate: true,
              });
              setValue("methods.face.anti_spoofing.model.model_id", value, {
                shouldDirty: true,
                shouldValidate: true,
              });
            }}
          >
            <SelectTrigger id="anti-spoofing-method" className="h-10 w-full">
              <SelectValue placeholder="Choose an AI model or turn off" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value={disabledOption}>Off</SelectItem>
              {aiModelValue === unavailableAiModelOption && (
                <SelectItem value={unavailableAiModelOption} disabled>
                  Selected anti-spoofing model unavailable
                </SelectItem>
              )}
              {antiSpoofModels.length > 0 ? (
                antiSpoofModels.map((model) => (
                  <SelectItem key={model.id} value={model.id}>
                    <div className="flex items-center gap-3 pr-6">
                      <span className="truncate">{model.name}</span>
                      <ModelStatus
                        status={antiSpoofStatusMap[model.id]}
                        size="sm"
                        className="h-4"
                      />
                    </div>
                  </SelectItem>
                ))
              ) : (
                <SelectItem value="__no_ai_models__" disabled>
                  No anti-spoofing models available
                </SelectItem>
              )}
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Analyzes the color image for signs of a photo or screen. This is
            independent of the IR check.
          </p>
          {errors.methods?.face?.anti_spoofing?.model?.model_id && (
            <p className="text-xs text-destructive">
              {errors.methods.face.anti_spoofing.model.model_id.message}
            </p>
          )}
        </div>

        {config.anti_spoofing.enable && (
          <div className="w-48">
            <Threshold
              label="Threshold"
              value={config.anti_spoofing.model.threshold}
              onChange={(threshold) =>
                setValue(
                  "methods.face.anti_spoofing.model.threshold",
                  threshold,
                  {
                    shouldDirty: true,
                    shouldValidate: true,
                  },
                )
              }
            />
          </div>
        )}
      </div>

      <details
        className="rounded-lg border border-border/50 bg-muted/50 p-4"
        open={Boolean(
          errors.methods?.face?.detection ||
            errors.methods?.face?.recognition ||
            errors.methods?.face?.retries ||
            errors.methods?.face?.retry_delay,
        )}
      >
        <summary className="cursor-pointer font-medium text-sm">
          Advanced settings
        </summary>
        <div className="grid gap-4 mt-4">
          <p className="text-sm text-muted-foreground">
            Recognition models, matching thresholds and retry timing.
          </p>
          <div className="p-4 rounded-lg bg-muted/50 border border-border/50">
            <h4 className="font-medium mb-3 text-sm">Detection</h4>
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
            <h4 className="font-medium my-3 text-sm">Recognition</h4>
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
      </details>
    </div>
  );
}
