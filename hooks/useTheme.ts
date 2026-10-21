"use client";

import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useConnectors } from "wagmi";
import { jawThemeFor } from "@/lib/jaw/config";
import { THEME_COLOR, THEME_KEY, readPref, resolveTheme, type Theme, type ThemePref } from "@/lib/theme";

const PHONE_DARK = "(prefers-color-scheme: dark)";
/** Fired on this page when the menu changes the choice ("storage" only reaches other tabs). */
const CHANGED = "gg-theme";

function subscribe(onChange: () => void) {
  const phone = window.matchMedia(PHONE_DARK);
  phone.addEventListener("change", onChange);
  window.addEventListener("storage", onChange);
  window.addEventListener(CHANGED, onChange);
  return () => {
    phone.removeEventListener("change", onChange);
    window.removeEventListener("storage", onChange);
    window.removeEventListener(CHANGED, onChange);
  };
}

function savedPref(): ThemePref {
  try {
    return readPref(localStorage.getItem(THEME_KEY));
  } catch {
    return "system";
  }
}

/** "system:dark", "light:light"…: one string, so the store's snapshot compares by value. */
const snapshot = () => `${savedPref()}:${resolveTheme(savedPref(), window.matchMedia(PHONE_DARK).matches)}`;

/** The menu's choice, the theme it resolves to now, and a setter that saves it on this device. */
export function useTheme(): { pref: ThemePref; theme: Theme; setPref: (p: ThemePref) => void } {
  const snap = useSyncExternalStore(subscribe, snapshot, () => "system:light");
  const [pref, theme] = snap.split(":") as [ThemePref, Theme];
  const setPref = useCallback((p: ThemePref) => {
    try {
      if (p === "system") localStorage.removeItem(THEME_KEY);
      else localStorage.setItem(THEME_KEY, p);
    } catch {
      /* storage blocked: the choice lasts this page only */
    }
    window.dispatchEvent(new Event(CHANGED));
  }, []);
  return { pref, theme, setPref };
}

/**
 * Keeps the page and JAW's sheet on the resolved theme: `<html data-theme>`, the browser bar's colour, and JAW's
 * connector (`setTheme` re-themes a sheet that's open, and the next one). Mounted once, in the providers.
 */
export function ThemeSync() {
  const { theme } = useTheme();
  const connectors = useConnectors();
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
    document.querySelector('meta[name="theme-color"]')?.setAttribute("content", THEME_COLOR[theme]);
    for (const c of connectors) {
      const themed = c as unknown as { setTheme?: (t: ReturnType<typeof jawThemeFor>) => void };
      themed.setTheme?.(jawThemeFor(theme));
    }
  }, [theme, connectors]);
  return null;
}
