/*
 * Light or dark (Adrian, 2026-10-21): GreedyGoo follows the phone, and the menu's Phone · Light · Dark overrides it on
 * this device. The dark look is the booth app's (hannibaluslab/jaw-booth-revamp): ink, glass cards, lime dots and glow
 * (app/globals.css `[data-theme="dark"]`). JAW's own sheet follows the same theme (lib/jaw/config.ts, ThemeSync). Pure,
 * apart from THEME_BOOT, which is the same rule as a string for the page's first paint.
 */

/** What the menu sets: follow the phone, or always light, or always dark. */
export type ThemePref = "system" | "light" | "dark";
export type Theme = "light" | "dark";

/** This device's choice, in its own storage (a convenience: lost storage means following the phone again). */
export const THEME_KEY = "gg.theme";

export const readPref = (raw: string | null | undefined): ThemePref =>
  raw === "light" || raw === "dark" ? raw : "system";

export const resolveTheme = (pref: ThemePref, phoneDark: boolean): Theme =>
  pref === "system" ? (phoneDark ? "dark" : "light") : pref;

/** The browser bar's colour for each theme: the page's own ground, which is also the dark page's top edge. */
export const THEME_COLOR: Record<Theme, string> = { light: "#f4f2ec", dark: "#0e0d0b" };

/**
 * Runs during parse, before the first paint: sets `<html data-theme>` (and the browser bar's colour) from the saved
 * choice and the phone's setting, so a dark page never flashes light. Without script or storage the page stays light.
 */
export const THEME_BOOT = `try{var p=localStorage.getItem("${THEME_KEY}");var d=p==="dark"||(p!=="light"&&matchMedia("(prefers-color-scheme: dark)").matches);var t=d?"dark":"light";document.documentElement.dataset.theme=t;var m=document.querySelector('meta[name="theme-color"]');if(m)m.setAttribute("content",t==="dark"?"${THEME_COLOR.dark}":"${THEME_COLOR.light}")}catch(e){}`;
