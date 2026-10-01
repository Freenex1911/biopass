export type Appearance = "system" | "light" | "dark";
export type ColorTheme = "light" | "dark";

export function appearancePreference(value: string): Appearance {
  return value === "light" || value === "dark" ? value : "system";
}

export function resolveAppearance(
  preference: Appearance,
  system: ColorTheme,
): ColorTheme {
  return preference === "system" ? system : preference;
}

interface NativeThemeWindow {
  theme(): Promise<ColorTheme | null>;
  onThemeChanged(
    handler: (event: { payload: ColorTheme }) => void,
  ): Promise<() => void>;
}

// Use Tauri's desktop theme events, falling back to the WebView media query if
// the native theme APIs are unavailable. The initial read must not overwrite
// a newer change event, and a delayed subscription must still be disposed.
export function observeSystemTheme(
  native: NativeThemeWindow,
  media: MediaQueryList,
  update: (theme: ColorTheme) => void,
): () => void {
  let alive = true;
  let nativeAvailable = false;
  let changed = false;
  let unlisten: (() => void) | undefined;
  const fromMedia = () => {
    if (alive && !nativeAvailable) update(media.matches ? "dark" : "light");
  };
  fromMedia();
  media.addEventListener("change", fromMedia);
  void (async () => {
    try {
      const stop = await native.onThemeChanged(({ payload }) => {
        if (!alive) return;
        changed = true;
        nativeAvailable = true;
        update(payload);
      });
      if (!alive) {
        stop();
        return;
      }
      unlisten = stop;
    } catch {
      // The media query remains subscribed when native events are unavailable.
      return;
    }
    try {
      const theme = await native.theme();
      if (alive && theme && !changed) {
        nativeAvailable = true;
        update(theme);
      }
    } catch {
      // Retain the current media-query result.
    }
  })();
  return () => {
    alive = false;
    media.removeEventListener("change", fromMedia);
    unlisten?.();
  };
}
