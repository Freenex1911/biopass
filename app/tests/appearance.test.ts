import { describe, expect, test } from "bun:test";
import {
  type ColorTheme,
  observeSystemTheme,
  resolveAppearance,
} from "../src/lib/appearance";

function mediaQuery() {
  const handlers = new Set<() => void>();
  const media = {
    matches: false,
    addEventListener: (_event: string, handler: () => void) =>
      handlers.add(handler),
    removeEventListener: (_event: string, handler: () => void) =>
      handlers.delete(handler),
  };
  return {
    media: media as unknown as MediaQueryList,
    change(dark: boolean) {
      media.matches = dark;
      for (const handler of handlers) handler();
    },
    handlers,
  };
}
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};

describe("desktop appearance synchronization", () => {
  test("a newer desktop event wins over a delayed initial read", async () => {
    const query = mediaQuery();
    const updates: ColorTheme[] = [];
    const latest = () => {
      const theme = updates.at(-1);
      if (!theme) throw new Error("No theme update received");
      return theme;
    };
    let event: (event: { payload: ColorTheme }) => void = () => {};
    let finish: (theme: ColorTheme) => void = () => {};
    const initial = new Promise<ColorTheme>((resolve) => {
      finish = resolve;
    });
    const stop = observeSystemTheme(
      {
        onThemeChanged: async (handler) => {
          event = handler;
          return () => {};
        },
        theme: () => initial,
      },
      query.media,
      (theme) => updates.push(theme),
    );
    await flush();
    event({ payload: "dark" });
    finish("light");
    await flush();
    query.change(false);
    expect(updates.at(-1)).toBe("dark");
    expect(resolveAppearance("system", latest())).toBe("dark");
    expect(resolveAppearance("light", latest())).toBe("light");
    event({ payload: "light" });
    expect(resolveAppearance("system", latest())).toBe("light");
    stop();
  });

  test("unmount disposes a native subscription that finishes late", async () => {
    const query = mediaQuery();
    let finish: (stop: () => void) => void = () => {};
    let disposed = 0;
    let reads = 0;
    const subscription = new Promise<() => void>((resolve) => {
      finish = resolve;
    });
    const stop = observeSystemTheme(
      {
        onThemeChanged: () => subscription,
        theme: async () => {
          reads++;
          return "dark";
        },
      },
      query.media,
      () => {},
    );
    stop();
    finish(() => {
      disposed++;
    });
    await flush();
    expect(disposed).toBe(1);
    expect(reads).toBe(0);
    expect(query.handlers.size).toBe(0);
  });

  test("media changes remain live when the desktop API is unavailable", async () => {
    const query = mediaQuery();
    const updates: ColorTheme[] = [];
    const stop = observeSystemTheme(
      {
        onThemeChanged: async () => {
          throw new Error("Unavailable");
        },
        theme: async () => null,
      },
      query.media,
      (theme) => updates.push(theme),
    );
    await flush();
    query.change(true);
    expect(updates.at(-1)).toBe("dark");
    query.change(false);
    expect(updates.at(-1)).toBe("light");
    stop();
  });
});
