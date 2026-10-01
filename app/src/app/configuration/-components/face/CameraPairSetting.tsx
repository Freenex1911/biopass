import { ArrowDown, ArrowUp, Plus, RefreshCw, Trash2 } from "lucide-react";
import type { ReactNode } from "react";
import { useFormContext, useWatch } from "react-hook-form";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
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
import type {
  BiopassConfig,
  CameraPairConfig,
  CameraSelectionConfig,
  VideoDeviceInfo,
} from "@/types/config";

export function CameraPairSetting({
  devices,
  refresh,
  loading,
  discoveryError,
  children,
}: {
  devices: VideoDeviceInfo[];
  refresh: () => void;
  loading: boolean;
  discoveryError: string | null;
  children: ReactNode;
}) {
  const {
    control,
    setValue,
    formState: { errors },
  } = useFormContext<BiopassConfig>();
  const selection = useWatch({
    control,
    name: "methods.face.camera_selection",
  });
  const selected = selectAvailableCameraPair(selection, devices);
  const update = (next: CameraSelectionConfig) =>
    setValue("methods.face.camera_selection", next, {
      shouldDirty: true,
      shouldValidate: true,
    });
  const updatePair = (index: number, values: Partial<CameraPairConfig>) =>
    update({
      ...selection,
      pairs: selection.pairs.map((pair, i) =>
        i === index ? { ...pair, ...values } : pair,
      ),
    });
  const move = (index: number, offset: number) => {
    const pairs = [...selection.pairs];
    [pairs[index], pairs[index + offset]] = [
      pairs[index + offset],
      pairs[index],
    ];
    update({ ...selection, pairs });
  };
  const pairErrors = errors.methods?.face?.camera_selection;

  const cameraSelect = (
    pair: CameraPairConfig,
    index: number,
    field: "camera" | "ir_camera",
  ) => {
    const value = pair[field];
    const device = devices.find((d) => cameraMatches(d, value));
    return (
      <div className="grid gap-2">
        <Label htmlFor={`${pair.id}-${field}`}>
          {field === "camera" ? "Color camera" : "IR camera"}
        </Label>
        <Select
          value={device?.stable_id ?? (value || "__none__")}
          onValueChange={(next) => updatePair(index, { [field]: next })}
        >
          <SelectTrigger id={`${pair.id}-${field}`} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__" disabled>
              Select a camera
            </SelectItem>
            {value && !device && (
              <SelectItem value={value} disabled>
                Configured camera disconnected
              </SelectItem>
            )}
            {devices.map((d) => (
              <SelectItem key={d.stable_id} value={d.stable_id}>
                {d.display_name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {pairErrors?.pairs?.[index]?.[field]?.message && (
          <p className="text-xs text-destructive">
            {pairErrors.pairs[index]?.[field]?.message}
          </p>
        )}
      </div>
    );
  };

  return (
    <div className="grid gap-4 rounded-lg border border-border/50 bg-muted/50 p-4">
      <div className="flex items-center justify-between gap-3">
        <h4 id="camera-selection-heading" className="font-medium text-sm">
          Cameras
        </h4>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={refresh}
          disabled={loading}
        >
          <RefreshCw className="mr-2 h-4 w-4" />
          Refresh cameras
        </Button>
      </div>
      <RadioGroup
        aria-labelledby="camera-selection-heading"
        value={selection.mode}
        onValueChange={(mode) =>
          update({ ...selection, mode: mode as CameraSelectionConfig["mode"] })
        }
      >
        {[
          {
            value: "legacy",
            title: "One camera setup",
            description: "Choose a color camera and, optionally, an IR camera.",
          },
          {
            value: "priority",
            title: "Switch automatically",
            description:
              "Use the first connected pair in your list. Useful when docking and undocking.",
          },
          {
            value: "fixed",
            title: "Use a specific pair",
            description: "Choose one saved pair. Other pairs will not be used.",
          },
        ].map((mode) => (
          <Label
            key={mode.value}
            htmlFor={`camera-mode-${mode.value}`}
            className="flex items-start gap-3 rounded-md border bg-background p-3 cursor-pointer"
          >
            <RadioGroupItem
              id={`camera-mode-${mode.value}`}
              value={mode.value}
              className="mt-0.5"
            />
            <span className="grid gap-1">
              <span className="font-medium">{mode.title}</span>
              <span className="text-xs text-muted-foreground font-normal">
                {mode.description}
              </span>
            </span>
          </Label>
        ))}
      </RadioGroup>
      {selection.mode === "legacy" && children}
      {discoveryError && (
        <p role="alert" className="text-sm text-destructive">
          {discoveryError}
        </p>
      )}
      {selection.mode !== "legacy" && (
        <>
          <p className="text-sm text-muted-foreground">
            {selection.mode === "priority"
              ? "Use the first pair with both cameras connected. Put your dock camera before the built-in pair."
              : "Select “Use” on the pair you want to use. Both its color and IR camera must be connected."}
          </p>
          {selection.mode === "fixed" && pairErrors?.fixed_pair?.message && (
            <p className="text-xs text-destructive">
              {pairErrors.fixed_pair.message}
            </p>
          )}
          <p
            className={
              selected || !selection.pairs.length
                ? "text-sm"
                : "text-sm text-destructive"
            }
            role="status"
          >
            {selected
              ? `Currently selected: ${selected.name || "Unnamed pair"}`
              : !selection.pairs.length
                ? "Add a camera pair to get started."
                : "No complete configured pair is connected. Face authentication will be unavailable."}
          </p>
          {selection.pairs.map((pair, index) => (
            <div
              key={pair.id}
              className="grid gap-3 rounded-md border bg-background p-3"
            >
              {selection.mode === "fixed" && (
                <Label
                  htmlFor={`${pair.id}-use`}
                  className="flex items-center gap-2 cursor-pointer text-sm"
                >
                  <input
                    id={`${pair.id}-use`}
                    type="radio"
                    name="fixed-camera-pair"
                    value={pair.id}
                    checked={selection.fixed_pair === pair.id}
                    onChange={() =>
                      update({ ...selection, fixed_pair: pair.id })
                    }
                    className="accent-primary"
                  />
                  Use {pair.name || "this pair"}
                </Label>
              )}
              <div className="flex items-center gap-2">
                <span className="text-sm text-muted-foreground">
                  {selection.mode === "priority" ? `${index + 1}.` : ""}
                </span>
                <Label htmlFor={`${pair.id}-name`} className="sr-only">
                  Pair name
                </Label>
                <Input
                  id={`${pair.id}-name`}
                  className="min-w-0 flex-1"
                  value={pair.name}
                  placeholder="Pair name, e.g. Dock or Built-in"
                  onChange={(e) => updatePair(index, { name: e.target.value })}
                />
                {selection.mode === "priority" && (
                  <>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      aria-label={`Move ${pair.name} up`}
                      disabled={index === 0}
                      onClick={() => move(index, -1)}
                    >
                      <ArrowUp className="h-4 w-4" />
                    </Button>
                    <Button
                      type="button"
                      size="icon"
                      variant="ghost"
                      aria-label={`Move ${pair.name} down`}
                      disabled={index === selection.pairs.length - 1}
                      onClick={() => move(index, 1)}
                    >
                      <ArrowDown className="h-4 w-4" />
                    </Button>
                  </>
                )}
                <Button
                  type="button"
                  size="icon"
                  variant="ghost"
                  aria-label={`Remove ${pair.name}`}
                  onClick={() =>
                    update({
                      ...selection,
                      pairs: selection.pairs.filter((p) => p.id !== pair.id),
                      fixed_pair:
                        selection.fixed_pair === pair.id
                          ? null
                          : selection.fixed_pair,
                    })
                  }
                >
                  <Trash2 className="h-4 w-4" />
                </Button>
              </div>
              {pairErrors?.pairs?.[index]?.name?.message && (
                <p className="text-xs text-destructive">
                  {pairErrors.pairs[index]?.name?.message}
                </p>
              )}
              <p className="text-xs text-muted-foreground">
                {selectAvailableCameraPair(
                  { ...selection, mode: "fixed", fixed_pair: pair.id },
                  devices,
                )
                  ? selected?.id === pair.id
                    ? "Connected · selected for login"
                    : "Connected"
                  : "Incomplete or disconnected"}
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                {cameraSelect(pair, index, "camera")}
                {cameraSelect(pair, index, "ir_camera")}
              </div>
            </div>
          ))}
          {pairErrors?.pairs?.message && (
            <p className="text-xs text-destructive">
              {pairErrors.pairs.message}
            </p>
          )}
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              const id = crypto.randomUUID();
              update({
                ...selection,
                pairs: [
                  ...selection.pairs,
                  { id, name: "", camera: "", ir_camera: "" },
                ],
                fixed_pair: selection.fixed_pair || id,
              });
            }}
          >
            <Plus className="mr-2 h-4 w-4" />
            Add camera pair
          </Button>
          <p className="text-xs text-muted-foreground">
            Each pair needs a color and an IR stream from the same camera.
            Switching only handles disconnected pairs before login; a failed
            face or IR check does not switch cameras.
          </p>
        </>
      )}
    </div>
  );
}
