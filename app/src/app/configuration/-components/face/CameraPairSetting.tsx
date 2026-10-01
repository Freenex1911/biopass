import {
  ArrowDown,
  ArrowUp,
  Camera,
  Plus,
  RefreshCw,
  Trash2,
} from "lucide-react";
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
import { Switch } from "@/components/ui/switch";
import {
  cameraMatches,
  selectAvailableCameraPair,
} from "@/lib/camera-selection";
import { cameraSelectionMode } from "@/lib/camera-setups";
import type {
  BiopassConfig,
  CameraPairConfig,
  CameraSelectionConfig,
  VideoDeviceInfo,
} from "@/types/config";
import { SettingsDisclosure } from "../SettingsDisclosure";

export function CameraPairSetting({
  devices,
  refresh,
  loading,
  discoveryError,
}: {
  devices: VideoDeviceInfo[];
  refresh: () => void;
  loading: boolean;
  discoveryError: string | null;
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
  const automatic = selection.mode === "priority";
  const multiple = selection.pairs.length > 1;
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
    const ir = field === "ir_camera";
    return (
      <div className="grid gap-2">
        <Label htmlFor={`${pair.id}-${field}`}>
          {ir ? "IR camera (optional)" : "Color camera"}
        </Label>
        <Select
          value={device?.stable_id ?? (value || "__none__")}
          onValueChange={(next) =>
            updatePair(index, { [field]: next === "__none__" ? "" : next })
          }
        >
          <SelectTrigger id={`${pair.id}-${field}`} className="w-full min-w-0">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="__none__" disabled={!ir}>
              {ir ? "No IR camera" : "Choose a color camera"}
            </SelectItem>
            {value === "auto" && !ir && (
              <SelectItem value="auto">Automatic (existing setting)</SelectItem>
            )}
            {value && value !== "auto" && !device && (
              <SelectItem value={value} disabled>
                Saved camera disconnected
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

  const cards = selection.pairs.map((pair, index) => {
    const connected = Boolean(
      selectAvailableCameraPair(
        { ...selection, mode: "fixed", fixed_pair: pair.id },
        devices,
      ),
    );
    const active = selected?.id === pair.id;
    const irConnected = devices.some((device) =>
      cameraMatches(device, pair.ir_camera),
    );
    return (
      <div
        key={pair.id}
        className={`rounded-lg border bg-background ${active ? "border-primary/50" : ""}`}
      >
        <div className="flex items-center gap-3 p-3">
          {!automatic && multiple ? (
            <RadioGroupItem value={pair.id} id={`${pair.id}-use`} />
          ) : (
            <Camera className="h-4 w-4 text-muted-foreground shrink-0" />
          )}
          <div className="flex-1 min-w-0">
            <Label
              htmlFor={!automatic && multiple ? `${pair.id}-use` : undefined}
              className="font-medium text-sm cursor-pointer"
            >
              {automatic && multiple ? `${index + 1}. ` : ""}
              {pair.name || "New camera"}
            </Label>
            <p
              className={`text-xs mt-1 ${connected ? "text-muted-foreground" : "text-amber-600 dark:text-amber-400"}`}
            >
              {connected
                ? active
                  ? "Connected · used for login"
                  : "Connected"
                : pair.camera
                  ? "Disconnected or incomplete"
                  : "Choose a color camera"}
            </p>
          </div>
          {automatic && multiple && (
            <>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={`Move ${pair.name || "camera"} up`}
                disabled={index === 0}
                onClick={() => move(index, -1)}
              >
                <ArrowUp className="h-4 w-4" />
              </Button>
              <Button
                type="button"
                size="icon"
                variant="ghost"
                aria-label={`Move ${pair.name || "camera"} down`}
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
            aria-label={`Remove ${pair.name || "camera"}`}
            onClick={() => {
              const pairs = selection.pairs.filter((p) => p.id !== pair.id);
              update({
                ...selection,
                pairs,
                fixed_pair:
                  selection.fixed_pair === pair.id
                    ? pairs[0]?.id || null
                    : selection.fixed_pair,
              });
            }}
          >
            <Trash2 className="h-4 w-4" />
          </Button>
        </div>
        <div className="px-3 pb-3 text-xs text-muted-foreground">
          {pair.ir_camera
            ? irConnected
              ? "IR verification enabled"
              : "IR verification required · IR camera disconnected"
            : "No IR verification · no IR camera assigned"}
        </div>
        <SettingsDisclosure
          className="border-t p-3"
          title="Camera settings"
          defaultOpen={!pair.camera || !pair.name}
          hasErrors={Boolean(pairErrors?.pairs?.[index])}
        >
          <div className="grid gap-4 mt-3">
            <div className="grid gap-2">
              <Label htmlFor={`${pair.id}-name`}>Name</Label>
              <Input
                id={`${pair.id}-name`}
                value={pair.name}
                placeholder="e.g. Surface or Dock"
                onChange={(event) =>
                  updatePair(index, { name: event.target.value })
                }
              />
              {pairErrors?.pairs?.[index]?.name?.message && (
                <p className="text-xs text-destructive">
                  {pairErrors.pairs[index]?.name?.message}
                </p>
              )}
            </div>
            <div className="grid gap-3 sm:grid-cols-2">
              {cameraSelect(pair, index, "camera")}
              {cameraSelect(pair, index, "ir_camera")}
            </div>
            <p className="text-xs text-muted-foreground">
              If your camera has an IR stream, assign it here. BioPass checks
              for a face in that stream during login and requires the IR camera
              to be connected.
            </p>
          </div>
        </SettingsDisclosure>
      </div>
    );
  });

  return (
    <section
      aria-labelledby="cameras-heading"
      className="grid gap-4 rounded-lg border border-border/50 p-4"
    >
      <div className="flex items-center justify-between gap-3">
        <div>
          <h4 id="cameras-heading" className="font-medium">
            Cameras
          </h4>
          <p className="text-xs text-muted-foreground mt-1">
            Save each camera once, with its color and optional IR stream.
          </p>
        </div>
        <Button
          type="button"
          variant="ghost"
          size="icon"
          onClick={refresh}
          disabled={loading}
          aria-label="Refresh connected cameras"
        >
          <RefreshCw className={`h-4 w-4 ${loading ? "animate-spin" : ""}`} />
        </Button>
      </div>
      {discoveryError && (
        <p role="alert" className="text-sm text-destructive">
          {discoveryError}
        </p>
      )}
      {multiple && (
        <div className="rounded-md bg-muted/50 p-3 flex items-start justify-between gap-4">
          <div className="grid gap-1">
            <Label htmlFor="automatic-camera-switching">
              Switch cameras automatically
            </Label>
            <p className="text-xs text-muted-foreground">
              {automatic
                ? "Use the first connected camera in this list. Reorder it to set your preference."
                : "Choose one camera below. BioPass will use only that camera."}
            </p>
          </div>
          <Switch
            id="automatic-camera-switching"
            checked={automatic}
            onCheckedChange={(checked) =>
              update(cameraSelectionMode(selection, checked, selected?.id))
            }
          />
        </div>
      )}
      {!automatic && multiple ? (
        <RadioGroup
          aria-label="Camera to use for login"
          value={selection.fixed_pair || ""}
          onValueChange={(fixed_pair) => update({ ...selection, fixed_pair })}
        >
          {cards}
        </RadioGroup>
      ) : (
        <div className="grid gap-3">{cards}</div>
      )}
      {pairErrors?.fixed_pair?.message && (
        <p className="text-xs text-destructive">
          {pairErrors.fixed_pair.message}
        </p>
      )}
      {pairErrors?.pairs?.message && (
        <p className="text-xs text-destructive">{pairErrors.pairs.message}</p>
      )}
      {!selection.pairs.length && (
        <p className="text-sm text-muted-foreground">
          Add a camera to get started.
        </p>
      )}
      {selection.pairs.length > 0 && !selected && !loading && (
        <p role="status" className="text-sm text-amber-600 dark:text-amber-400">
          The selected camera is not ready. Face login and preview are
          unavailable until its assigned streams are connected.
        </p>
      )}
      <Button
        type="button"
        variant="outline"
        className="justify-self-start"
        onClick={() => {
          const id = crypto.randomUUID();
          update({
            ...selection,
            mode: selection.mode === "legacy" ? "fixed" : selection.mode,
            pairs: [
              ...selection.pairs,
              { id, name: "", camera: "", ir_camera: "" },
            ],
            fixed_pair: selection.fixed_pair || id,
          });
        }}
      >
        <Plus className="mr-2 h-4 w-4" />
        Add camera
      </Button>
      {automatic && multiple && (
        <p className="text-xs text-muted-foreground">
          Automatic switching handles missing hardware before login. A failed
          face or IR check never switches to another camera.
        </p>
      )}
    </section>
  );
}
