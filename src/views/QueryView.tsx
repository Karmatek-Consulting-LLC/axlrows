import type { ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { Eraser, Play, Square, Star } from "lucide-react";
import { useCallback, useRef, useState } from "react";
import { toast } from "sonner";
import { ResultsGrid } from "../components/ResultsGrid";
import { RunStatus } from "../components/RunStatus";
import { SqlEditor } from "../components/SqlEditor";
import { TargetPicker } from "../components/TargetPicker";
import { Button } from "../components/ui/Button";
import { Dialog, DialogClose, DialogContent } from "../components/ui/Dialog";
import { Field } from "../components/ui/Field";
import { Input } from "../components/ui/Input";
import { Kbd, MOD_KEY } from "../components/ui/Kbd";
import { Spinner } from "../components/ui/Spinner";
import { Tip } from "../components/ui/Tooltip";
import { errMsg } from "../lib/utils";
import { useFavoritesStore } from "../stores/favorites";
import { useQueryStore } from "../stores/query";
import { useUiStore } from "../stores/ui";

export function QueryView() {
  const sql = useQueryStore((s) => s.sql);
  const setSql = useQueryStore((s) => s.setSql);
  const running = useQueryStore((s) => s.running);
  const run = useQueryStore((s) => s.run);
  const cancel = useQueryStore((s) => s.cancel);
  const clearEditor = useQueryStore((s) => s.clearEditor);
  const clearResults = useQueryStore((s) => s.clearResults);
  const hasResults = useQueryStore((s) => s.targets.length > 0);
  const targetCount = useQueryStore((s) => s.targetIds.length);

  const bookmarkOpen = useUiStore((s) => s.bookmarkOpen);
  const setBookmarkOpen = useUiStore((s) => s.setBookmarkOpen);

  const editorRef = useRef<ReactCodeMirrorRef>(null);
  const onRun = useCallback(() => void useQueryStore.getState().run(), []);

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* editor panel */}
      <div className="shrink-0 space-y-2.5 border-b border-line bg-surface px-4 pt-3 pb-3">
        <TargetPicker />

        <div className="overflow-hidden rounded-lg border border-line bg-canvas transition-colors focus-within:border-accent/50">
          <div className="h-36 resize-y overflow-auto" style={{ minHeight: "6rem", maxHeight: "45vh" }}>
            <SqlEditor ref={editorRef} value={sql} onChange={setSql} onRun={onRun} />
          </div>
        </div>

        <div className="flex items-center gap-2">
          {running ? (
            <Button variant="primary" onClick={() => void cancel()} className="min-w-24">
              <Square className="size-3.5" fill="currentColor" />
              Cancel
            </Button>
          ) : (
            <Button
              variant="primary"
              onClick={() => void run()}
              disabled={!sql.trim() || targetCount === 0}
              className="min-w-24"
            >
              <Play className="size-3.5" fill="currentColor" />
              Run
              <span className="ml-0.5 flex items-center gap-0.5 opacity-70">
                <Kbd className="border-on-accent/25 bg-transparent text-on-accent">{MOD_KEY}</Kbd>
                <Kbd className="border-on-accent/25 bg-transparent text-on-accent">↵</Kbd>
              </span>
            </Button>
          )}

          <Tip content="Save this query to Favorites">
            <Button onClick={() => setBookmarkOpen(true)} disabled={!sql.trim()}>
              <Star className="size-3.5" />
              Bookmark
            </Button>
          </Tip>

          <Tip content="Clear the editor and results">
            <Button
              variant="ghost"
              onClick={() => {
                clearEditor();
                clearResults();
                editorRef.current?.view?.focus();
              }}
              disabled={running || (!sql && !hasResults)}
            >
              <Eraser className="size-3.5" />
              Clear
            </Button>
          </Tip>

          {running && (
            <span className="flex items-center gap-2 text-xs text-mut">
              <Spinner className="size-3 text-accent" />
              querying…
            </span>
          )}
        </div>

        <RunStatus />
      </div>

      {/* results */}
      <div className="min-h-0 grow">
        <ResultsGrid />
      </div>

      <BookmarkDialog open={bookmarkOpen} onOpenChange={setBookmarkOpen} sql={sql} />
    </div>
  );
}

function BookmarkDialog({
  open,
  onOpenChange,
  sql,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  sql: string;
}) {
  const createFavorite = useFavoritesStore((s) => s.create);
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);

  async function save() {
    setSaving(true);
    try {
      const fav = await createFavorite(name.trim() || "Untitled query", sql);
      toast.success("Bookmarked", { description: fav.name });
      onOpenChange(false);
      setName("");
    } catch (e) {
      toast.error("Could not save favorite", { description: errMsg(e) });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        title="Bookmark query"
        description="Save the current SQL to Favorites for one-click reuse."
      >
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
          className="space-y-4"
        >
          <Field label="Name">
            <Input
              autoFocus
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Untitled query"
            />
          </Field>
          <pre className="max-h-32 overflow-auto rounded-md border border-line bg-canvas p-2.5 font-mono text-[11px] leading-relaxed whitespace-pre-wrap text-mut">
            {sql}
          </pre>
          <div className="flex justify-end gap-2">
            <DialogClose asChild>
              <Button variant="ghost">Cancel</Button>
            </DialogClose>
            <Button variant="primary" type="submit" disabled={saving}>
              {saving && <Spinner className="size-3" />}
              Save favorite
            </Button>
          </div>
        </form>
      </DialogContent>
    </Dialog>
  );
}
