import { useMemo } from "react";
import { COLOR_THEMES, useStore } from "../store.js";
import { navigateToMostRecentSession, navigateToSession } from "../utils/routing.js";
import { PLAYGROUND_NAV_GROUPS } from "./playground/navigation.js";
import { PlaygroundInteractiveSections } from "./playground/sections-interactive.js";
import { PlaygroundOverviewSections } from "./playground/sections-overview.js";
import { PlaygroundStateSections } from "./playground/sections-states.js";
import { usePlaygroundSeed } from "./playground/usePlaygroundSeed.js";

function scrollToPlaygroundSection(sectionId: string) {
  document.getElementById(sectionId)?.scrollIntoView({ block: "start", behavior: "smooth" });
}

export function Playground() {
  const colorTheme = useStore((s) => s.colorTheme);
  const setColorTheme = useStore((s) => s.setColorTheme);

  usePlaygroundSeed();

  const navGroups = useMemo(() => PLAYGROUND_NAV_GROUPS, []);

  return (
    <div className="h-screen overflow-y-auto bg-cc-bg text-cc-fg font-sans-ui">
      <header className="sticky top-0 z-50 bg-cc-sidebar border-b border-cc-border">
        <div className="max-w-6xl mx-auto px-6 py-4 flex items-center justify-between">
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
              {COLOR_THEMES.map((theme) => (
                <button
                  key={theme.id}
                  onClick={() => setColorTheme(theme.id)}
                  className={`px-3 py-1.5 text-xs font-medium rounded-lg border transition-colors cursor-pointer ${
                    colorTheme === theme.id
                      ? "bg-cc-primary/20 text-cc-primary border-cc-primary/30"
                      : "bg-cc-hover text-cc-muted border-cc-border hover:bg-cc-active hover:text-cc-fg"
                  }`}
                >
                  {theme.label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </header>

      <div className="max-w-6xl mx-auto px-6 py-8 grid gap-10 lg:grid-cols-[240px_minmax(0,1fr)]">
        <aside className="hidden lg:block">
          <div className="sticky top-24 space-y-5">
            {navGroups.map((group) => (
              <div key={group.id} className="space-y-2">
                <div>
                  <h2 className="text-sm font-semibold text-cc-fg">{group.title}</h2>
                  <p className="text-xs text-cc-muted mt-0.5">{group.description}</p>
                </div>
                <div className="space-y-1">
                  {group.items.map((item) => (
                    <button
                      key={item.id}
                      type="button"
                      onClick={() => scrollToPlaygroundSection(item.id)}
                      className="block w-full text-left px-2.5 py-1.5 rounded-lg text-xs text-cc-muted hover:text-cc-fg hover:bg-cc-hover transition-colors cursor-pointer"
                      aria-label={item.title}
                    >
                      <span className="text-cc-fg/80">{`Jump to ${item.title}`}</span>
                    </button>
                  ))}
                </div>
              </div>
            ))}
          </div>
        </aside>

        <main className="space-y-12 min-w-0">
          <PlaygroundOverviewSections />
          <PlaygroundInteractiveSections />
          <PlaygroundStateSections />
        </main>
      </div>
    </div>
  );
}
