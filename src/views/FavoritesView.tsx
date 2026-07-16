import { Pencil, Play, Star, Trash2 } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "../components/ui/Button";
import { EmptyState } from "../components/ui/EmptyState";
import { Tip } from "../components/ui/Tooltip";
import type { Favorite } from "../lib/types";
import { cn, errMsg } from "../lib/utils";
import { useFavoritesStore } from "../stores/favorites";
import { useQueryStore } from "../stores/query";
import { useUiStore } from "../stores/ui";

export function FavoritesView() {
  const favorites = useFavoritesStore((s) => s.favorites);
  const loaded = useFavoritesStore((s) => s.loaded);

  return (
    <div className="flex h-full min-h-0 flex-col">
      <header className="shrink-0 border-b border-line bg-surface px-4 py-3">
        <h1 className="text-[15px] font-semibold tracking-tight">Favorites</h1>
        <p className="mt-0.5 text-xs text-mut">
          Saved queries. Edits save automatically when you click away.
        </p>
      </header>

      <div className="min-h-0 grow overflow-y-auto p-4">
        {loaded && favorites.length === 0 ? (
          <EmptyState icon={Star} title="No favorites yet">
            Start sending queries, then bookmark them — they'll show up here ready to rerun.
          </EmptyState>
        ) : (
          <ul className="mx-auto flex max-w-3xl flex-col gap-2.5">
            {favorites.map((f) => (
              <FavoriteCard key={f.id} favorite={f} />
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function FavoriteCard({ favorite: f }: { favorite: Favorite }) {
  const update = useFavoritesStore((s) => s.update);
  const remove = useFavoritesStore((s) => s.remove);
  const setSql = useQueryStore((s) => s.setSql);
  const setView = useUiStore((s) => s.setView);

  const [name, setName] = useState(f.name);
  const [sql, setSqlLocal] = useState(f.sql);
  const dirty = name !== f.name || sql !== f.sql;
  const savingRef = useRef(false);

  // Reflect external updates (e.g. bookmark from Query view re-saves).
  useEffect(() => {
    setName(f.name);
    setSqlLocal(f.sql);
  }, [f.name, f.sql]);

  async function autosave() {
    if (!dirty || savingRef.current) return;
    savingRef.current = true;
    try {
      await update(f.id, name.trim() || "Untitled query", sql);
      toast.success("Favorite saved", { description: name.trim() || "Untitled query" });
    } catch (e) {
      toast.error("Autosave failed", { description: errMsg(e) });
    } finally {
      savingRef.current = false;
    }
  }

  function runIt() {
    void autosave();
    setSql(sql);
    setView("query");
  }

  async function doDelete() {
    try {
      await remove(f.id);
      toast.success("Favorite deleted", { description: f.name });
    } catch (e) {
      toast.error("Delete failed", { description: errMsg(e) });
    }
  }

  return (
    <li
      className="group animate-rise rounded-lg border border-line bg-surface transition-colors hover:border-line-2"
      onBlur={(e) => {
        // Autosave when focus leaves the card entirely.
        if (!e.currentTarget.contains(e.relatedTarget)) void autosave();
      }}
    >
      <div className="flex items-center gap-1.5 border-b border-line/70 py-1.5 pr-2 pl-3">
        <Pencil className="size-3 shrink-0 text-faint" />
        <input
          value={name}
          onChange={(e) => setName(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && (e.target as HTMLInputElement).blur()}
          aria-label="Favorite name"
          className="h-6 min-w-0 grow rounded-[4px] bg-transparent px-1 text-[13px] font-semibold text-ink outline-none placeholder:text-faint focus:bg-raised/70"
          placeholder="Untitled query"
        />
        <span
          className={cn(
            "text-[10px] text-faint transition-opacity",
            dirty ? "opacity-100" : "opacity-0",
          )}
        >
          unsaved
        </span>
        <Tip content="Load into the Query editor">
          <Button size="sm" variant="primary" onClick={runIt} className="h-6.5">
            <Play className="size-3" fill="currentColor" />
            Run
          </Button>
        </Tip>
        <Tip content="Delete favorite">
          <Button
            variant="danger-ghost"
            size="icon-sm"
            aria-label={`Delete ${f.name}`}
            onClick={() => void doDelete()}
          >
            <Trash2 className="size-3.5" />
          </Button>
        </Tip>
      </div>
      <textarea
        value={sql}
        onChange={(e) => setSqlLocal(e.target.value)}
        rows={Math.min(10, Math.max(2, sql.split("\n").length))}
        spellCheck={false}
        aria-label={`SQL for ${f.name}`}
        className="block w-full resize-y rounded-b-lg bg-transparent px-3 py-2.5 font-mono text-[11.5px] leading-relaxed text-ink/90 outline-none placeholder:text-faint focus:bg-canvas/60"
        placeholder="SELECT …"
      />
    </li>
  );
}
