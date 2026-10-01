import { zodResolver } from "@hookform/resolvers/zod";
import { createFileRoute } from "@tanstack/react-router";
import { RotateCcw, Save } from "lucide-react";
import { useEffect, useState } from "react";
import { FormProvider, useForm } from "react-hook-form";
import { toast } from "sonner";
import { cmd } from "@/commands";
import { Button } from "@/components/ui/button";
import { withCameraSetups } from "@/lib/camera-setups";
import type { BiopassConfig } from "@/types/config";
import {
  SettingsPageHeader,
  settingsPageClass,
} from "../-components/SettingsPage";
import { MethodConfig } from "./-components/MethodConfig";
import { StrategyConfig } from "./-components/StrategyConfig";
import { biopassConfigSchema, validateConfig } from "./-components/validation";

function ConfigurationRouteComponent() {
  const [initialConfig, setInitialConfig] = useState<BiopassConfig | null>(
    null,
  );

  useEffect(() => {
    let canceled = false;

    cmd.config
      .load()
      .then((loadedConfig) => {
        if (!canceled) setInitialConfig(loadedConfig);
      })
      .catch((err) => {
        if (!canceled) toast.error(`Failed to load config: ${err}`);
      });

    return () => {
      canceled = true;
    };
  }, []);

  if (!initialConfig) {
    return (
      <div className="flex items-center justify-center p-8">
        <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
      </div>
    );
  }

  return <ConfigurationForm initialConfig={initialConfig} />;
}

function ConfigurationForm({
  initialConfig,
}: {
  initialConfig: BiopassConfig;
}) {
  const form = useForm<BiopassConfig>({
    defaultValues: withCameraSetups(initialConfig),
    resolver: zodResolver(biopassConfigSchema),
  });
  const { isSubmitting, isDirty } = form.formState;

  async function onSave(values: BiopassConfig) {
    const configToSave = structuredClone(values);

    const isValid = await validateConfig(configToSave);
    if (!isValid) return;

    try {
      await cmd.config.save(configToSave);
      form.reset(configToSave);
      toast.success("Settings saved successfully!");
    } catch (err) {
      console.error("Failed to save config:", err);
      toast.error(`Failed to save config: ${err}`);
    }
  }

  const submit = form.handleSubmit(onSave, () => {
    toast.error("Please fix validation errors before saving");
  });

  useEffect(() => {
    function handleSaveShortcut(event: KeyboardEvent) {
      if (
        !(event.ctrlKey || event.metaKey) ||
        event.key.toLowerCase() !== "s"
      ) {
        return;
      }

      event.preventDefault();
      void submit();
    }

    window.addEventListener("keydown", handleSaveShortcut);

    return () => {
      window.removeEventListener("keydown", handleSaveShortcut);
    };
  }, [submit]);

  function handleReset() {
    form.reset();
    toast.info("Configuration reset to last saved state");
  }

  return (
    <FormProvider {...form}>
      <form onSubmit={submit} className={settingsPageClass}>
        <SettingsPageHeader
          title="Sign-in settings"
          description="Set up how you sign in with your face or fingerprint."
        >
          <div className="flex gap-2 items-center">
            {isDirty && (
              <span role="status" className="text-xs text-muted-foreground">
                Unsaved changes
              </span>
            )}
            <Button
              type="button"
              variant="outline"
              onClick={handleReset}
              disabled={!isDirty || isSubmitting}
              className="flex items-center gap-2 cursor-pointer"
            >
              <RotateCcw className="w-4 h-4" />
              Discard changes
            </Button>
            <Button
              type="submit"
              disabled={isSubmitting}
              className="flex items-center gap-2 cursor-pointer"
            >
              <Save className="w-4 h-4" />
              {isSubmitting ? "Saving..." : "Save"}
            </Button>
          </div>
        </SettingsPageHeader>

        <div className="grid gap-6">
          <MethodConfig />
          <StrategyConfig />
        </div>
      </form>
    </FormProvider>
  );
}

export const Route = createFileRoute("/configuration/")({
  component: ConfigurationRouteComponent,
});
