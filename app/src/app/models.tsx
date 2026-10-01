import { createFileRoute } from "@tanstack/react-router";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import { Cpu, Trash2 } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { toast } from "sonner";
import { cmd } from "@/commands";
import type { ModelManagement } from "@/commands/models";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { modelTypeLabels } from "@/lib/model-types";
import type { Model } from "@/types/config";
import { AddModelDialog } from "./-components/AddModelDialog";
import { ModelStatus, type ModelStatusType } from "./-components/ModelStatus";
import { RenameModelDialog } from "./-components/RenameModelDialog";
import {
  SettingsPageHeader,
  settingsPageClass,
} from "./-components/SettingsPage";

interface ModelCardProps {
  model: Model;
  status: ModelStatusType;
  management?: ModelManagement;
  onRenamed: (model: Model) => void;
  onDelete: (model: Model) => void;
}

function ModelFileFolderButton({ path }: { path: string }) {
  const handleOpenFileFolder = async (path: string) => {
    try {
      await revealItemInDir(path);
    } catch (err) {
      console.error("Failed to open file location:", err);
      toast.error(`Failed to open file location: ${err}`);
    }
  };
  return (
    <TooltipProvider>
      <Tooltip delayDuration={300}>
        <TooltipTrigger asChild>
          <button
            type="button"
            onClick={() => handleOpenFileFolder(path)}
            aria-label="Show model file in folder"
            title="Show model file in folder"
            className="text-[10px] font-mono text-muted-foreground opacity-60 truncate max-w-37.5 bg-muted/50 px-1.5 py-0.5 rounded hover:opacity-100 hover:bg-primary/10 hover:text-primary transition-all cursor-pointer"
          >
            {path.split(/[/]/).pop()}
          </button>
        </TooltipTrigger>
        <TooltipContent
          side="bottom"
          align="end"
          className="max-w-75 break-all"
        >
          <p className="font-mono text-xs">{path}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  );
}

export function ModelCard({
  model,
  status,
  management,
  onRenamed,
  onDelete,
}: ModelCardProps) {
  const isDefault = model.source === "builtin";
  const deleteDisabledReason =
    management?.delete_block_reason ??
    (!management ? "Checking model selection…" : "Delete model");
  const deleteDisabled = !management || Boolean(management.delete_block_reason);

  return (
    <div className="group relative flex flex-col gap-4 p-5 rounded-xl border border-border bg-linear-to-b from-card to-muted/20 shadow-sm hover:border-primary/30 hover:shadow-md transition-all duration-300">
      <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-lg bg-linear-to-br from-blue-500/10 to-indigo-500/10 flex items-center justify-center border border-blue-500/10 group-hover:border-blue-500/30 transition-colors">
            <Cpu className="w-5 h-5 text-blue-600 dark:text-blue-400" />
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2">
              <h3
                className="font-semibold leading-none truncate max-w-100"
                title={model.name}
              >
                {model.name}
              </h3>
              <p className="text-xs text-muted-foreground">
                {modelTypeLabels[model.model_type]}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2 mt-2">
              <Badge variant="outline">
                {isDefault ? "Included" : "Imported"}
              </Badge>
              {Boolean(management?.selected_for.length) && (
                <TooltipProvider>
                  <Tooltip delayDuration={300}>
                    <TooltipTrigger asChild>
                      <Badge
                        variant="secondary"
                        tabIndex={0}
                        aria-label={`Selected for ${management?.selected_for.join(", ")}`}
                      >
                        {management?.selected_for.every((role) =>
                          role.endsWith(" (off)"),
                        )
                          ? "Selected (off)"
                          : "Selected"}
                      </Badge>
                    </TooltipTrigger>
                    <TooltipContent side="bottom">
                      Selected for {management?.selected_for.join(", ")}
                    </TooltipContent>
                  </Tooltip>
                </TooltipProvider>
              )}
              <ModelStatus status={status} />
            </div>
            <div className="mt-2">
              <ModelFileFolderButton path={model.path} />
            </div>
          </div>
        </div>

        <div className="flex items-center gap-1">
          <RenameModelDialog model={model} onRenamed={onRenamed} />
          <TooltipProvider>
            <Tooltip delayDuration={300}>
              <TooltipTrigger asChild>
                <span>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    aria-label={`Delete ${model.name}`}
                    disabled={deleteDisabled}
                    onClick={() => onDelete(model)}
                    className="text-destructive hover:text-destructive"
                  >
                    <Trash2 className="w-4 h-4" />
                  </Button>
                </span>
              </TooltipTrigger>
              {deleteDisabledReason && (
                <TooltipContent side="bottom">
                  <p className="text-xs">{deleteDisabledReason}</p>
                </TooltipContent>
              )}
            </Tooltip>
          </TooltipProvider>
        </div>
      </div>
    </div>
  );
}

function ModelsRouteComponent() {
  const [models, setModels] = useState<Model[]>([]);
  const [management, setManagement] = useState<Record<string, ModelManagement>>(
    {},
  );
  const [pendingDelete, setPendingDelete] = useState<Model | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [statusMap, setStatusMap] = useState<
    Record<string, "checking" | "available" | "missing">
  >({});

  const checkModelsStatus = useCallback(async (modelList: Model[]) => {
    const newStatuses: Record<string, "checking" | "available" | "missing"> =
      {};

    for (const model of modelList) newStatuses[model.id] = "checking";
    setStatusMap({ ...newStatuses });

    try {
      const checks = modelList.map(async (model) => {
        try {
          const exists = await cmd.file.exists(model.path);
          if (!exists) {
            newStatuses[model.id] = "missing";
          } else {
            newStatuses[model.id] = "available";
          }
        } catch (err) {
          console.error(`Status check failed for ${model.path}:`, err);
          newStatuses[model.id] = "missing";
        }
      });

      await Promise.all(checks);
      setStatusMap({ ...newStatuses });
    } catch (err) {
      console.error("Failed to check model usage:", err);
    }
  }, []);

  const loadModels = useCallback(async () => {
    try {
      const entries = await cmd.models.listManagement();
      setManagement(
        Object.fromEntries(entries.map((entry) => [entry.model.id, entry])),
      );
      const loadedModels = entries.map((entry) => entry.model);
      setModels(loadedModels);
      await checkModelsStatus(loadedModels);
    } catch (err) {
      console.error("Failed to load models:", err);
      toast.error("Failed to load models");
    } finally {
      setLoading(false);
    }
  }, [checkModelsStatus]);

  useEffect(() => {
    void loadModels();
    const refresh = () => void loadModels();
    window.addEventListener("focus", refresh);
    return () => window.removeEventListener("focus", refresh);
  }, [loadModels]);

  function handleModelUpdated(updated: Model) {
    setModels((prev) => prev.map((m) => (m.id === updated.id ? updated : m)));
  }

  function handleModelAdded(_added: Model) {
    void loadModels();
  }

  async function handleDelete(model: Model) {
    setDeleting(true);
    try {
      await cmd.models.remove(model.id);
      toast.success("Model deleted");
      setPendingDelete(null);
      setModels((prev) => prev.filter((m) => m.id !== model.id));
    } catch (err) {
      toast.error(`Failed to delete model: ${err}`);
      void loadModels();
    } finally {
      setDeleting(false);
    }
  }

  if (loading) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  return (
    <div className={settingsPageClass}>
      <SettingsPageHeader
        title="AI models"
        description="Choose models in Sign-in settings. Included models come with BioPass; imported models were added separately."
      >
        <AddModelDialog onAdded={handleModelAdded} />
      </SettingsPageHeader>
      <Dialog
        open={Boolean(pendingDelete)}
        onOpenChange={(open) => {
          if (!open && !deleting) setPendingDelete(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Delete {pendingDelete?.name}?</DialogTitle>
            <DialogDescription>
              The imported model will be removed from BioPass. Its copy stored
              by BioPass will also be deleted. This cannot be undone.
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="outline"
              disabled={deleting}
              onClick={() => setPendingDelete(null)}
            >
              Cancel
            </Button>
            <Button
              variant="destructive"
              disabled={deleting}
              onClick={() => pendingDelete && void handleDelete(pendingDelete)}
            >
              {deleting ? "Deleting…" : "Delete model"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <div className="flex flex-col gap-4">
        {models.length === 0 ? (
          <div className="col-span-full flex flex-col items-center justify-center p-12 text-center rounded-xl border border-dashed border-border/50 bg-card/50">
            <div className="w-12 h-12 rounded-full bg-muted flex items-center justify-center mb-4">
              <Cpu className="w-6 h-6 text-muted-foreground" />
            </div>
            <h3 className="font-semibold text-lg">No models added</h3>
          </div>
        ) : (
          models.map((model) => (
            <ModelCard
              key={model.id}
              model={model}
              status={statusMap[model.id]}
              management={management[model.id]}
              onRenamed={handleModelUpdated}
              onDelete={setPendingDelete}
            />
          ))
        )}
      </div>
    </div>
  );
}

export const Route = createFileRoute("/models")({
  component: ModelsRouteComponent,
});
