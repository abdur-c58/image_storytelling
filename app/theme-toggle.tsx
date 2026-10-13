"use client";

import { Moon, Sun } from "lucide-react";
import { useTheme } from "next-themes";
import { useSyncExternalStore } from "react";

const noop = () => () => {};

export function ThemeToggle() {
  const { resolvedTheme, setTheme } = useTheme();
  // The theme is only known in the browser; render a placeholder on the server.
  const mounted = useSyncExternalStore(noop, () => true, () => false);
  if (!mounted) return <div className="h-9 w-9" />;
  const light = resolvedTheme === "light";
  return (
    <button
      type="button"
      onClick={() => setTheme(light ? "dark" : "light")}
      className="flex h-9 w-9 items-center justify-center rounded-full border border-line bg-panel transition-colors hover:border-line-hover hover:bg-panel-hover"
      aria-label="Toggle light and dark mode"
    >
      {light ? <Sun className="h-4 w-4" /> : <Moon className="h-4 w-4" />}
    </button>
  );
}
