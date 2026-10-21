import { describe, expect, it } from "vitest";
import { THEME_BOOT, THEME_COLOR, THEME_KEY, readPref, resolveTheme } from "@/lib/theme";

/*
 * Light or dark (lib/theme.ts): the phone's setting unless the menu overrides it, and the same rule in the script that
 * paints the first frame.
 */

describe("the theme", () => {
  it("follows the phone unless Light or Dark is chosen", () => {
    expect(resolveTheme("system", true)).toBe("dark");
    expect(resolveTheme("system", false)).toBe("light");
    expect(resolveTheme("light", true)).toBe("light");
    expect(resolveTheme("dark", false)).toBe("dark");
  });

  it("reads anything it doesn't know as following the phone", () => {
    expect(readPref("dark")).toBe("dark");
    expect(readPref("light")).toBe("light");
    expect(readPref(null)).toBe("system");
    expect(readPref("purple")).toBe("system");
  });

  /** Runs THEME_BOOT against a stand-in page: the saved choice, the phone's setting, the browser bar's meta. */
  function boot(saved: string | null, phoneDark: boolean, throws = false) {
    const html = { dataset: {} as Record<string, string> };
    let bar = THEME_COLOR.light;
    const page = {
      documentElement: html,
      querySelector: () => ({ setAttribute: (_k: string, v: string) => (bar = v) }),
    };
    const storage = {
      getItem: (k: string) => {
        if (throws) throw new Error("blocked");
        return k === THEME_KEY ? saved : null;
      },
    };
    new Function("document", "localStorage", "matchMedia", THEME_BOOT)(page, storage, () => ({ matches: phoneDark }));
    return { theme: html.dataset.theme, bar };
  }

  it("paints the first frame in the same theme, and the browser bar with it", () => {
    expect(boot(null, true)).toEqual({ theme: "dark", bar: THEME_COLOR.dark });
    expect(boot(null, false)).toEqual({ theme: "light", bar: THEME_COLOR.light });
    expect(boot("light", true)).toEqual({ theme: "light", bar: THEME_COLOR.light });
    expect(boot("dark", false)).toEqual({ theme: "dark", bar: THEME_COLOR.dark });
  });

  it("leaves the page light when storage is blocked", () => {
    expect(boot(null, true, true).theme).toBeUndefined();
  });
});
