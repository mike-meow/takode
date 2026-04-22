import { useEffect, useState } from "react";
import { COLOR_THEMES, isDarkTheme, useStore, type ColorTheme } from "../store.js";
import { navigateToMostRecentSession, navigateToSession } from "../utils/routing.js";
import { PlaygroundOverviewSections } from "./playground/sections-overview.js";
import { PlaygroundInteractiveSections } from "./playground/sections-interactive.js";
import { PlaygroundStateSections } from "./playground/sections-states.js";
import { usePlaygroundSeed } from "./playground/usePlaygroundSeed.js";

export function Playground() {
  const [colorTheme, setColorTheme] = useState<ColorTheme>(() => useStore.getState().colorTheme);
  const darkMode = isDarkTheme(colorTheme);

  useEffect(() => {
    const el = document.documentElement;
    el.classList.toggle("dark", darkMode);
    el.className = el.className.replace(/\btheme-\S+/g, "").trim();
    if (colorTheme !== "light" && colorTheme !== "dark") {
      el.classList.add(`theme-${colorTheme}`);
    }
    // Keep the store in sync so other components see the playground override
    useStore.getState().setColorTheme(colorTheme);
  }, [colorTheme, darkMode]);

  usePlaygroundSeed();

  return (
    <div className="h-screen overflow-y-auto bg-cc-bg text-cc-fg font-sans-ui">
      <header className="sticky top-0 z-50 bg-cc-sidebar border-b border-cc-border">
        <div className="max-w-5xl mx-auto px-6 py-4 flex items-center justify-between">
          <div>
            <h1 className="text-lg font-semibold text-cc-fg tracking-tight">Component Playground</h1>
            <p className="text-xs text-cc-muted mt-0.5">Visual catalog of all UI components</p>
          </div>
          <div className="flex items-center gap-3">
            <button
              onClick={() => {
                const sessionId = useStore.getState().currentSessionId;
                if (sessionId) {
                  navigateToSession(sessionId);
                } else {
                  navigateToMostRecentSession();
                }
              }}
              className="px-3 py-1.5 text-xs font-medium rounded-lg bg-cc-hover hover:bg-cc-active text-cc-fg border border-cc-border transition-colors cursor-pointer"
            >
              Back to App
            </button>
            <div className="flex items-center gap-1.5">
              {COLOR_THEMES.map((t) => (
                <button
                  key={t.id}
                  onClick={() => setColorTheme(t.id)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors cursor-pointer ${
                    colorTheme === t.id
                      ? "bg-cc-primary/20 text-cc-primary border-cc-primary/30"
                      : "bg-cc-hover text-cc-muted border-cc-border hover:bg-cc-active hover:text-cc-fg"
                  }`}
                >
                  {t.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </header>

      <div className="max-w-5xl mx-auto px-6 py-8 space-y-12">
        <PlaygroundOverviewSections />
        <PlaygroundInteractiveSections />
        <PlaygroundStateSections />
      </div>
    </div>
  );
}
