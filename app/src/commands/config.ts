import type { BiopassConfig } from "@/types/config";
import { invokeCommand } from "./core";

function load() {
  return invokeCommand<BiopassConfig>("load_config");
}

function save(config: BiopassConfig) {
  return invokeCommand<void>("save_config", { config });
}

function saveAppearance(appearance: "system" | "light" | "dark") {
  return invokeCommand<void>("save_appearance", { appearance });
}

export const config = {
  load,
  save,
  saveAppearance,
};
