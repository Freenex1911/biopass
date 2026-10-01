import { getCurrentWindow } from "@tauri-apps/api/window";
import { ThemeProvider as NextThemesProvider } from "next-themes";
import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useState,
} from "react";
import { cmd } from "@/commands";
import {
  type Appearance,
  appearancePreference,
  type ColorTheme,
  observeSystemTheme,
  resolveAppearance,
} from "@/lib/appearance";

const AppearanceContext = createContext<{
  appearance: Appearance;
  resolvedTheme: ColorTheme;
  systemTheme: ColorTheme;
  ready: boolean;
  saving: boolean;
  setAppearance: (appearance: Appearance) => Promise<void>;
} | null>(null);

export function useAppearance() {
  const context = useContext(AppearanceContext);
  if (!context) throw new Error("AppearanceProvider is missing");
  return context;
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [appearance, setPreference] = useState<Appearance>("system");
  const [systemTheme, setSystemTheme] = useState<ColorTheme>("light");
  const [ready, setReady] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let alive = true;
    void cmd.config
      .load()
      .then((config) => {
        if (alive) setPreference(appearancePreference(config.appearance));
      })
      .catch((error) => console.error("Could not load appearance:", error))
      .finally(() => {
        if (alive) setReady(true);
      });
    return () => {
      alive = false;
    };
  }, []);

  useEffect(
    () =>
      observeSystemTheme(
        getCurrentWindow(),
        window.matchMedia("(prefers-color-scheme: dark)"),
        setSystemTheme,
      ),
    [],
  );

  const setAppearance = useCallback(async (next: Appearance) => {
    setSaving(true);
    try {
      await cmd.config.saveAppearance(next);
      setPreference(next);
    } finally {
      setSaving(false);
    }
  }, []);

  const resolvedTheme = resolveAppearance(appearance, systemTheme);
  return (
    <AppearanceContext.Provider
      value={{
        appearance,
        resolvedTheme,
        systemTheme,
        ready,
        saving,
        setAppearance,
      }}
    >
      <NextThemesProvider
        attribute="class"
        forcedTheme={resolvedTheme}
        enableColorScheme
        disableTransitionOnChange
      >
        {children}
      </NextThemesProvider>
    </AppearanceContext.Provider>
  );
}
