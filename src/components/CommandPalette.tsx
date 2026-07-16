import {
  Eraser,
  Moon,
  Play,
  Plus,
  Search,
  Server,
  Square,
  Star,
  Sun,
  Table2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import * as RDialog from "@radix-ui/react-dialog";
import type { LucideIcon } from "lucide-react";
import { cn } from "../lib/utils";
import { useFavoritesStore } from "../stores/favorites";
import { useQueryStore } from "../stores/query";
import { useUiStore } from "../stores/ui";
import { Kbd, MOD_KEY } from "./ui/Kbd";

interface Command {
  id: string;
  label: string;
  hint?: string;
  icon: LucideIcon;
  keywords?: string;
  run: () => void;
}

export function CommandPalette() {
  const open = useUiStore((s) => s.paletteOpen);
  const setOpen = useUiStore((s) => s.setPaletteOpen);
  const setView = useUiStore((s) => s.setView);
  const theme = useUiStore((s) => s.theme);
  const toggleTheme = useUiStore((s) => s.toggleTheme);
  const setBookmarkOpen = useUiStore((s) => s.setBookmarkOpen);
  const favorites = useFavoritesStore((s) => s.favorites);
  const running = useQueryStore((s) => s.running);
  const sql = useQueryStore((s) => s.sql);

  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const listRef = useRef<HTMLUListElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
    }
  }, [open]);

  const commands = useMemo<Command[]>(() => {
    const close = (fn: () => void) => () => {
      setOpen(false);
      fn();
    };
    const cmds: Command[] = [
      ...(running
        ? [
            {
              id: "cancel",
              label: "Cancel running query",
              icon: Square,
              run: close(() => void useQueryStore.getState().cancel()),
            },
          ]
        : [
            {
              id: "run",
              label: "Run query",
              hint: `${MOD_KEY} ↵`,
              icon: Play,
              keywords: "execute submit sql",
              run: close(() => {
                setView("query");
                void useQueryStore.getState().run();
              }),
            },
          ]),
      {
        id: "bookmark",
        label: "Bookmark current query",
        icon: Star,
        keywords: "favorite save star",
        run: close(() => {
          if (!sql.trim()) return;
          setView("query");
          setBookmarkOpen(true);
        }),
      },
      {
        id: "clear",
        label: "Clear editor & results",
        icon: Eraser,
        keywords: "reset erase",
        run: close(() => {
          useQueryStore.getState().clearEditor();
          useQueryStore.getState().clearResults();
        }),
      },
      {
        id: "view-query",
        label: "Go to Query",
        icon: Table2,
        keywords: "navigate editor results",
        run: close(() => setView("query")),
      },
      {
        id: "view-favorites",
        label: "Go to Favorites",
        icon: Star,
        keywords: "navigate saved",
        run: close(() => setView("favorites")),
      },
      {
        id: "view-servers",
        label: "Go to Servers",
        icon: Server,
        keywords: "navigate ucm cucm manage",
        run: close(() => setView("servers")),
      },
      {
        id: "add-server",
        label: "Add UCM server",
        icon: Plus,
        keywords: "new create cucm",
        run: close(() => setView("servers")),
      },
      {
        id: "theme",
        label: theme === "dark" ? "Switch to light theme" : "Switch to dark theme",
        icon: theme === "dark" ? Sun : Moon,
        keywords: "theme dark light appearance",
        run: close(toggleTheme),
      },
      ...favorites.map((f) => ({
        id: `fav-${f.id}`,
        label: f.name,
        hint: "favorite",
        icon: Star,
        keywords: `favorite load ${f.sql.slice(0, 80)}`,
        run: close(() => {
          useQueryStore.getState().setSql(f.sql);
          setView("query");
        }),
      })),
    ];
    return cmds;
  }, [running, sql, theme, favorites, setOpen, setView, toggleTheme, setBookmarkOpen]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return commands;
    return commands.filter((c) =>
      `${c.label} ${c.keywords ?? ""}`.toLowerCase().includes(q),
    );
  }, [commands, query]);

  useEffect(() => setActive(0), [filtered.length, query]);

  function onKeyDown(e: React.KeyboardEvent) {
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActive((a) => Math.min(a + 1, filtered.length - 1));
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActive((a) => Math.max(a - 1, 0));
    } else if (e.key === "Enter") {
      e.preventDefault();
      filtered[active]?.run();
    }
  }

  useEffect(() => {
    listRef.current
      ?.querySelector(`[data-index="${active}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [active]);

  return (
    <RDialog.Root open={open} onOpenChange={setOpen}>
      <RDialog.Portal>
        <RDialog.Overlay className="fixed inset-0 z-40 animate-fade bg-black/45 backdrop-blur-[2px] dark:bg-black/60" />
        <RDialog.Content
          onKeyDown={onKeyDown}
          className="fixed top-[18%] left-1/2 z-50 w-[calc(100vw-2rem)] max-w-lg -translate-x-1/2 animate-rise overflow-hidden rounded-xl border border-line bg-overlay shadow-pop"
        >
          <RDialog.Title className="sr-only">Command palette</RDialog.Title>
          <RDialog.Description className="sr-only">
            Type to search commands, favorites and navigation.
          </RDialog.Description>
          <div className="flex items-center gap-2 border-b border-line px-3">
            <Search className="size-4 shrink-0 text-faint" />
            <input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Type a command or search favorites…"
              aria-label="Search commands"
              className="h-11 w-full bg-transparent text-[13px] text-ink outline-none placeholder:text-faint"
            />
            <Kbd>esc</Kbd>
          </div>
          <ul ref={listRef} className="max-h-80 overflow-y-auto p-1.5" role="listbox">
            {filtered.length === 0 && (
              <li className="px-3 py-6 text-center text-xs text-mut">No matching commands</li>
            )}
            {filtered.map((c, i) => (
              <li key={c.id} role="option" aria-selected={i === active} data-index={i}>
                <button
                  type="button"
                  onClick={c.run}
                  onMouseMove={() => setActive(i)}
                  className={cn(
                    "flex w-full cursor-pointer items-center gap-2.5 rounded-md px-2.5 py-2 text-left text-[12.5px]",
                    i === active ? "bg-accent/12 text-ink" : "text-mut",
                  )}
                >
                  <c.icon
                    className={cn("size-4 shrink-0", i === active ? "text-accent" : "text-faint")}
                  />
                  <span className="grow truncate">{c.label}</span>
                  {c.hint && <span className="shrink-0 text-[10.5px] text-faint">{c.hint}</span>}
                </button>
              </li>
            ))}
          </ul>
        </RDialog.Content>
      </RDialog.Portal>
    </RDialog.Root>
  );
}
