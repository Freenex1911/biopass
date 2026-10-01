import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import type { Model, ModelType } from "@/types/config";
import { invokeCommand } from "./core";

export interface ModelManagement {
  model: Model;
  selected_for: string[];
  delete_block_reason: string | null;
}
function listManagement() {
  return invokeCommand<ModelManagement[]>("list_model_management");
}

function list(modelType?: ModelType) {
  return invokeCommand<Model[]>("list_models", {
    modelType: modelType ?? null,
  });
}

function addFromUrl(name: string, modelType: ModelType, url: string) {
  return invokeCommand<Model>("add_model_from_url", {
    name,
    modelType,
    url,
  });
}

function addFromFile(name: string, modelType: ModelType, srcPath: string) {
  return invokeCommand<Model>("add_model_from_file", {
    name,
    modelType,
    srcPath,
  });
}

function remove(id: string) {
  return invokeCommand<void>("delete_model", { id });
}

function rename(id: string, name: string) {
  return invokeCommand<Model>("rename_model", { id, name });
}

export interface ModelDownloadProgress {
  id: string;
  downloaded: number;
  total: number | null;
}

function onDownloadProgress(
  cb: (progress: ModelDownloadProgress) => void,
): Promise<UnlistenFn> {
  return listen<ModelDownloadProgress>("model-download-progress", (event) => {
    cb(event.payload);
  });
}

export const models = {
  list,
  listManagement,
  addFromUrl,
  addFromFile,
  remove,
  rename,
  onDownloadProgress,
};
