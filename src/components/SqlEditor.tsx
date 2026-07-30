import CodeMirror, { type ReactCodeMirrorRef } from "@uiw/react-codemirror";
import { sql } from "@codemirror/lang-sql";
import { EditorView, keymap } from "@codemirror/view";
import { Prec } from "@codemirror/state";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags as t } from "@lezer/highlight";
import { forwardRef, useMemo } from "react";
import { useSchemaStore } from "../stores/schema";
import { useUiStore } from "../stores/ui";

/** Editor chrome reads the app's CSS variables so both themes stay in sync. */
const chrome = EditorView.theme({
  "&": { backgroundColor: "transparent", color: "var(--ink)" },
  ".cm-content": { caretColor: "var(--accent)", padding: "10px 4px" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--accent)" },
  ".cm-gutters": {
    backgroundColor: "transparent",
    color: "var(--faint)",
    border: "none",
    paddingLeft: "6px",
  },
  ".cm-activeLine": { backgroundColor: "color-mix(in oklab, var(--ink) 4%, transparent)" },
  ".cm-activeLineGutter": {
    backgroundColor: "transparent",
    color: "var(--mut)",
  },
  "&.cm-focused .cm-selectionBackground, .cm-selectionBackground, ::selection": {
    backgroundColor: "color-mix(in oklab, var(--accent) 24%, transparent) !important",
  },
  ".cm-selectionMatch": {
    backgroundColor: "color-mix(in oklab, var(--accent) 14%, transparent)",
  },
  ".cm-placeholder": { color: "var(--faint)", fontStyle: "normal" },
  ".cm-tooltip": {
    backgroundColor: "var(--overlay)",
    border: "1px solid var(--line)",
    borderRadius: "6px",
    color: "var(--ink)",
  },
  ".cm-tooltip-autocomplete ul li[aria-selected]": {
    backgroundColor: "color-mix(in oklab, var(--accent) 14%, transparent)",
    color: "var(--ink)",
  },
});

function highlight(dark: boolean) {
  return syntaxHighlighting(
    HighlightStyle.define([
      { tag: t.keyword, color: dark ? "hsl(266 90% 76%)" : "hsl(266 70% 48%)", fontWeight: "600" },
      { tag: [t.operator, t.punctuation], color: "var(--mut)" },
      { tag: [t.string, t.special(t.string)], color: dark ? "hsl(152 55% 62%)" : "hsl(152 70% 30%)" },
      { tag: t.number, color: dark ? "hsl(35 90% 65%)" : "hsl(30 90% 36%)" },
      { tag: t.comment, color: "var(--faint)", fontStyle: "italic" },
      { tag: [t.typeName, t.className], color: dark ? "hsl(189 80% 65%)" : "hsl(192 90% 32%)" },
      { tag: [t.propertyName, t.attributeName], color: dark ? "hsl(199 85% 70%)" : "hsl(210 80% 40%)" },
      { tag: t.variableName, color: "var(--ink)" },
      { tag: t.bool, color: dark ? "hsl(35 90% 65%)" : "hsl(30 90% 36%)" },
    ]),
  );
}

export const SqlEditor = forwardRef<
  ReactCodeMirrorRef,
  {
    value: string;
    onChange: (v: string) => void;
    onRun: () => void;
  }
>(({ value, onChange, onRun }, ref) => {
  const dark = useUiStore((s) => s.theme === "dark");
  const schemaTables = useSchemaStore((s) => s.tables);

  const extensions = useMemo(
    () => [
      // Mod-Enter must beat the default newline binding.
      Prec.highest(
        keymap.of([
          {
            key: "Mod-Enter",
            run: () => {
              onRun();
              return true;
            },
          },
        ]),
      ),
      // With an introspected schema, lang-sql completes table names, and
      // column names after `table.` or inside a query FROM that table.
      sql(schemaTables ? { schema: schemaTables } : {}),
      chrome,
      highlight(dark),
      EditorView.lineWrapping,
    ],
    [dark, onRun, schemaTables],
  );

  return (
    <CodeMirror
      ref={ref}
      value={value}
      onChange={onChange}
      extensions={extensions}
      theme="none"
      placeholder={'SELECT name, description FROM device WHERE tkclass = 1'}
      basicSetup={{
        foldGutter: false,
        highlightActiveLine: true,
        autocompletion: true,
        searchKeymap: false,
      }}
      className="h-full [&_.cm-editor]:h-full"
      height="100%"
    />
  );
});
SqlEditor.displayName = "SqlEditor";
