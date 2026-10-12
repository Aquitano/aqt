import { createContext, useCallback, useContext, useMemo, useState } from "react";
import type { ReactNode } from "react";

export type ThemeMode = "light" | "dark";

interface Theme {
  readonly mode: ThemeMode;
  readonly toggle: () => void;
}

const ThemeContext = createContext<Theme | null>(null);

const currentMode = (): ThemeMode =>
  document.documentElement.dataset.mode === "dark" ? "dark" : "light";

export const ThemeProvider = ({ children }: { readonly children: ReactNode }) => {
  const [mode, setMode] = useState<ThemeMode>(currentMode);

  const toggle = useCallback(() => {
    setMode((previous) => {
      const next = previous === "dark" ? "light" : "dark";
      document.documentElement.dataset.mode = next;
      try {
        localStorage.setItem("cb_theme", next);
      } catch {
        // The toggle still applies for this page load.
      }
      return next;
    });
  }, []);

  const value = useMemo(() => ({ mode, toggle }), [mode, toggle]);
  return <ThemeContext value={value}>{children}</ThemeContext>;
};

export const useTheme = (): Theme => {
  const theme = useContext(ThemeContext);
  if (theme === null) throw new Error("useTheme was called outside ThemeProvider");
  return theme;
};
