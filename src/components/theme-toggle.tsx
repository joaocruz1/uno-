"use client";

import { Moon, Sun } from "lucide-react";
import { useSyncExternalStore } from "react";

type Theme = "light" | "dark";

// The attribute on <html> is the source of truth, so the control subscribes to it
// instead of mirroring it into state (and picks up changes made elsewhere).
function subscribe(onChange: () => void) {
  const observer = new MutationObserver(onChange);
  observer.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
  return () => observer.disconnect();
}

const readTheme = (): Theme => (document.documentElement.getAttribute("data-theme") === "dark" ? "dark" : "light");

/**
 * Light/dark switch for the dashboard shell. The theme lives in a `data-theme`
 * attribute on <html>, set before paint by the inline script in the root layout
 * (so there is no flash); this control flips it and remembers the choice.
 */
export function ThemeToggle({ className }: { className?: string }) {
  const theme = useSyncExternalStore(subscribe, readTheme, () => "light" as Theme);

  const toggle = () => {
    const next = theme === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try {
      localStorage.setItem("uno-theme", next);
    } catch {
      // private mode / blocked storage: the choice just won't persist.
    }
  };

  return (
    <button
      type="button"
      onClick={toggle}
      aria-label={theme === "dark" ? "Usar tema claro" : "Usar tema escuro"}
      title={theme === "dark" ? "Tema claro" : "Tema escuro"}
      className={className}
    >
      {theme === "dark" ? <Sun size={17} /> : <Moon size={17} />}
    </button>
  );
}
