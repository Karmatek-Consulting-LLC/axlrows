import { Command, FlaskConical, Moon, Server, Star, Sun, Table2 } from "lucide-react";
import { useEffect } from "react";
import { Toaster } from "sonner";
import { CommandPalette } from "./components/CommandPalette";
import { LogoMark, Wordmark } from "./components/Logo";
import { Kbd, MOD_KEY } from "./components/ui/Kbd";
import { Tip, TooltipProvider } from "./components/ui/Tooltip";
import { ipc, USING_MOCK, type UnlistenFn } from "./lib/ipc";
import { cn } from "./lib/utils";
import { useFavoritesStore } from "./stores/favorites";
import { useSchemaStore } from "./stores/schema";
import { useQueryStore } from "./stores/query";
import { useUcmsStore } from "./stores/ucms";
import { useUiStore, type View } from "./stores/ui";
import { FavoritesView } from "./views/FavoritesView";
import { QueryView } from "./views/QueryView";
import { ServersView } from "./views/ServersView";

const NAV: { view: View; label: string; icon: typeof Table2; shortcut: string }[] = [
  { view: "query", label: "Query", icon: Table2, shortcut: "1" },
  { view: "favorites", label: "Favorites", icon: Star, shortcut: "2" },
  { view: "servers", label: "Servers", icon: Server, shortcut: "3" },
];

export default function App() {
  const view = useUiStore((s) => s.view);
  const setView = useUiStore((s) => s.setView);
  const theme = useUiStore((s) => s.theme);
  const toggleTheme = useUiStore((s) => s.toggleTheme);
  const setPaletteOpen = useUiStore((s) => s.setPaletteOpen);

  // Initial data load.
  useEffect(() => {
    void useUcmsStore.getState().load();
    void useFavoritesStore.getState().load();
    void useSchemaStore.getState().load();
  }, []);

  // Query event stream -> store. Wired exactly once per mount.
  useEffect(() => {
    const q = useQueryStore.getState();
    const unlisteners: Promise<UnlistenFn>[] = [
      ipc.onTargetStarted((p) => useQueryStore.getState()._onStarted(p)),
      ipc.onTargetSuccess((p) => useQueryStore.getState()._onSuccess(p)),
      ipc.onTargetError((p) => useQueryStore.getState()._onError(p)),
      ipc.onTargetThrottled((p) => useQueryStore.getState()._onThrottled(p)),
      ipc.onTargetBatchProgress((p) => useQueryStore.getState()._onBatchProgress(p)),
      ipc.onQueryComplete((p) => useQueryStore.getState()._onComplete(p)),
    ];
    void q; // silence unused if tree-shaken
    return () => {
      for (const u of unlisteners) void u.then((fn) => fn());
    };
  }, []);

  // Global shortcuts.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (!mod) return;
      if (e.key === "k" || e.key === "K") {
        e.preventDefault();
        setPaletteOpen(!useUiStore.getState().paletteOpen);
      } else if (e.key === "Enter") {
        e.preventDefault();
        setView("query");
        void useQueryStore.getState().run();
      } else if (e.key >= "1" && e.key <= "3") {
        e.preventDefault();
        setView(NAV[Number(e.key) - 1].view);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [setPaletteOpen, setView]);

  return (
    <TooltipProvider delayDuration={350}>
      <div className="flex h-full">
        {/* nav rail */}
        <aside className="flex w-13 shrink-0 flex-col items-center border-r border-line bg-surface py-3">
          <Tip content={<Wordmark />} side="right">
            <button
              className="mb-4 cursor-pointer rounded-lg transition-transform hover:scale-105 active:scale-95"
              onClick={() => setView("query")}
              aria-label="AXLRows — go to Query"
            >
              <LogoMark className="size-7" />
            </button>
          </Tip>

          <nav className="flex flex-col gap-1" aria-label="Main">
            {NAV.map(({ view: v, label, icon: Icon, shortcut }) => (
              <Tip
                key={v}
                side="right"
                content={
                  <span className="flex items-center gap-2">
                    {label}
                    <Kbd>{MOD_KEY} {shortcut}</Kbd>
                  </span>
                }
              >
                <button
                  onClick={() => setView(v)}
                  aria-label={label}
                  aria-current={view === v ? "page" : undefined}
                  className={cn(
                    "relative flex size-9 cursor-pointer items-center justify-center rounded-lg",
                    "transition-colors duration-100",
                    view === v
                      ? "bg-accent/14 text-accent"
                      : "text-mut hover:bg-raised hover:text-ink",
                  )}
                >
                  <Icon className="size-[17px]" />
                  {view === v && (
                    <span className="absolute top-1/2 -left-2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-accent" />
                  )}
                </button>
              </Tip>
            ))}
          </nav>

          <div className="grow" />

          {USING_MOCK && (
            <Tip content="Browser dev mode — mock backend, no Tauri" side="right">
              <span className="mb-2 flex size-7 items-center justify-center rounded-md border border-warn/40 bg-warn/10 text-warn">
                <FlaskConical className="size-3.5" />
              </span>
            </Tip>
          )}

          <Tip
            content={
              <span className="flex items-center gap-2">
                Command palette <Kbd>{MOD_KEY} K</Kbd>
              </span>
            }
            side="right"
          >
            <button
              onClick={() => setPaletteOpen(true)}
              aria-label="Open command palette"
              className="flex size-9 cursor-pointer items-center justify-center rounded-lg text-mut transition-colors hover:bg-raised hover:text-ink"
            >
              <Command className="size-[17px]" />
            </button>
          </Tip>

          <Tip content={theme === "dark" ? "Light theme" : "Dark theme"} side="right">
            <button
              onClick={toggleTheme}
              aria-label="Toggle theme"
              className="mt-1 flex size-9 cursor-pointer items-center justify-center rounded-lg text-mut transition-colors hover:bg-raised hover:text-ink"
            >
              {theme === "dark" ? <Sun className="size-[17px]" /> : <Moon className="size-[17px]" />}
            </button>
          </Tip>
        </aside>

        {/* active view */}
        <main className="min-w-0 grow">
          {view === "query" && <QueryView />}
          {view === "favorites" && <FavoritesView />}
          {view === "servers" && <ServersView />}
        </main>
      </div>

      <CommandPalette />
      <Toaster
        theme={theme}
        position="bottom-right"
        gap={8}
        toastOptions={{
          style: {
            background: "var(--overlay)",
            border: "1px solid var(--line)",
            color: "var(--ink)",
            fontSize: "12.5px",
            boxShadow: "var(--shadow-pop)",
          },
        }}
      />
    </TooltipProvider>
  );
}
