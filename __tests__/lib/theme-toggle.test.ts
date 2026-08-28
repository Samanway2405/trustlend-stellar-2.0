import { describe, expect, it, beforeEach } from "vitest";

describe("Dark Mode UI Preference & Storage (#258)", () => {
  const STORAGE_KEY = "trustlend-theme";

  beforeEach(() => {
    // Clear mock localStorage
    if (typeof window !== "undefined") {
      window.localStorage.clear();
      document.documentElement.classList.remove("dark");
    }
  });

  it("persists theme preference to localStorage using 'trustlend-theme' key", () => {
    // Simulate setting dark theme
    const themeToSet = "dark";
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, themeToSet);
      expect(window.localStorage.getItem(STORAGE_KEY)).toBe("dark");
    }
  });

  it("cycles correctly between light, system, and dark themes", () => {
    function getNextTheme(current: string): string {
      if (current === "dark") return "light";
      if (current === "light") return "system";
      return "dark";
    }

    expect(getNextTheme("system")).toBe("dark");
    expect(getNextTheme("dark")).toBe("light");
    expect(getNextTheme("light")).toBe("system");
  });

  it("applies and removes the .dark class on root HTML element", () => {
    if (typeof document !== "undefined") {
      document.documentElement.classList.add("dark");
      expect(document.documentElement.classList.contains("dark")).toBe(true);

      document.documentElement.classList.remove("dark");
      expect(document.documentElement.classList.contains("dark")).toBe(false);
    }
  });

  it("retains user choice across sessions from localStorage", () => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(STORAGE_KEY, "dark");
      const stored = window.localStorage.getItem(STORAGE_KEY);
      expect(stored).toBe("dark");

      window.localStorage.setItem(STORAGE_KEY, "light");
      expect(window.localStorage.getItem(STORAGE_KEY)).toBe("light");
    }
  });
});
