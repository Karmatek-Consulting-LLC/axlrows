import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type ColumnFiltersState,
  type Row as TableRow,
  type SortingState,
  type Table,
  type VisibilityState,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  ArrowDown,
  ArrowUp,
  Check,
  Columns3,
  Download,
  ListFilter,
  Search,
  SearchX,
  Table2,
} from "lucide-react";
import { memo, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import * as RDropdown from "@radix-ui/react-dropdown-menu";
import { ipc } from "../lib/ipc";
import type { Row } from "../lib/types";
import { cn, errMsg, fmtCount, ucmHue } from "../lib/utils";
import { useQueryStore, type GridRow } from "../stores/query";
import { Button } from "./ui/Button";
import { EmptyState } from "./ui/EmptyState";
import { Input } from "./ui/Input";
import { Spinner } from "./ui/Spinner";
import { Tip } from "./ui/Tooltip";

// Client-side origin column id. Data columns are prefixed "c:" so a real UCM
// column can never collide with it (and dots in names don't trip TanStack's
// dot-notation id handling).
const UCM_COL = "__ucm__";
const colId = (name: string) => `c:${name}`;
const colName = (id: string) => (id === UCM_COL ? "UCM" : id.slice(2));

const ROW_H = 28;

const helper = createColumnHelper<GridRow>();

export function ResultsGrid() {
  const rows = useQueryStore((s) => s.rows);
  const dataColumns = useQueryStore((s) => s.columns);
  const targets = useQueryStore((s) => s.targets);
  const running = useQueryStore((s) => s.running);
  const runId = useQueryStore((s) => s.runId);
  const multiTarget = targets.length > 1;

  const [sorting, setSorting] = useState<SortingState>([]);
  const [columnFilters, setColumnFilters] = useState<ColumnFiltersState>([]);
  const [columnVisibility, setColumnVisibility] = useState<VisibilityState>({});
  const [globalFilter, setGlobalFilter] = useState("");
  const [filterRow, setFilterRow] = useState(false);
  const [exporting, setExporting] = useState(false);

  // New run -> table state resets so stale sorts/filters can't hide fresh data.
  useEffect(() => {
    setSorting([]);
    setColumnFilters([]);
    setColumnVisibility({});
    setGlobalFilter("");
  }, [runId]);

  const columns = useMemo<ColumnDef<GridRow, string>[]>(() => {
    const ucmCol = helper.accessor((r) => r.ucmName, {
      id: UCM_COL,
      header: "UCM",
      size: 110,
      minSize: 60,
    });
    const dataCols = dataColumns.map((name) =>
      helper.accessor((r) => r.cells[name] ?? "", {
        id: colId(name),
        header: name,
        size: Math.min(320, Math.max(110, name.length * 10 + 60)),
        minSize: 60,
      }),
    );
    return [ucmCol, ...dataCols];
  }, [dataColumns]);

  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting, columnFilters, columnVisibility, globalFilter },
    onSortingChange: setSorting,
    onColumnFiltersChange: setColumnFilters,
    onColumnVisibilityChange: setColumnVisibility,
    onGlobalFilterChange: setGlobalFilter,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
    globalFilterFn: "includesString",
    defaultColumn: { filterFn: "includesString" },
    columnResizeMode: "onChange",
    enableColumnResizing: true,
  });

  const tableRows = table.getRowModel().rows;
  const leafColumns = table.getVisibleLeafColumns();
  const totalWidth = table.getTotalSize();
  // Identity changes on resize/visibility change — busts row memoization.
  const sizingKey = table.getState().columnSizing;
  const layout = useMemo(
    () => leafColumns.map((c) => ({ id: c.id, width: c.getSize() })),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [leafColumns, sizingKey],
  );

  const scrollRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: tableRows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_H,
    overscan: 10,
  });

  const hasRun = targets.length > 0;
  const zeroTargets = targets.filter((t) => t.status === "ok" && t.rowCount === 0);
  const errTargets = targets.filter((t) => t.status === "error");
  const throttledTargets = targets.filter((t) => t.status === "throttled");

  async function exportCsv() {
    const headerFor = (id: string) => (id === UCM_COL ? "ucm" : colName(id));
    const cols = layout.map((c) => headerFor(c.id));
    const outRows: Row[] = tableRows.map((r) => {
      const rec: Row = {};
      for (const c of layout) rec[headerFor(c.id)] = r.getValue<string>(c.id);
      return rec;
    });
    const stamp = new Date().toISOString().slice(0, 16).replace(/[-:T]/g, "");
    setExporting(true);
    try {
      const path = await ipc.exportCsv(cols, outRows, `axlrows_${stamp}.csv`);
      if (path) {
        toast.success("Exported CSV", { description: path });
      } // null = user cancelled the save dialog; stay silent
    } catch (e) {
      toast.error("Export failed", { description: errMsg(e) });
    } finally {
      setExporting(false);
    }
  }

  // ---- empty states ----------------------------------------------------

  if (!hasRun) {
    return (
      <EmptyState icon={Table2} title="Results land here">
        Pick your targets, write a query and hit Run. Rows from every UCM merge into one
        sortable, filterable grid.
      </EmptyState>
    );
  }

  if (rows.length === 0) {
    return running ? (
      <div className="flex h-full items-center justify-center gap-2.5 text-sm text-mut">
        <Spinner className="text-accent" />
        Querying {targets.length} target{targets.length > 1 ? "s" : ""}…
      </div>
    ) : (
      <EmptyState icon={SearchX} title="No rows returned">
        <span className="flex flex-col gap-1">
          {zeroTargets.map((t) => (
            <span key={t.ucmId}>
              No matching rows for <b className="font-medium text-ink">{t.ucmName}</b>
            </span>
          ))}
          {throttledTargets.length > 0 && (
            <span>
              {throttledTargets.length} target{throttledTargets.length > 1 ? "s" : ""} hit UCM's 8 MB
              cap — fetch in batches from the panel above.
            </span>
          )}
          {errTargets.length > 0 && (
            <span>
              {errTargets.length} target{errTargets.length > 1 ? "s" : ""} failed — see the status
              above.
            </span>
          )}
        </span>
      </EmptyState>
    );
  }

  // ---- grid -------------------------------------------------------------

  const virtualRows = virtualizer.getVirtualItems();

  return (
    <div className="flex h-full min-h-0 flex-col">
      {/* toolbar */}
      <div className="flex shrink-0 items-center gap-1.5 border-b border-line px-2 py-1.5">
        <div className="relative">
          <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-faint" />
          <Input
            value={globalFilter}
            onChange={(e) => setGlobalFilter(e.target.value)}
            placeholder="Search all columns"
            className="h-7 w-52 pl-7 text-xs"
            aria-label="Search all columns"
          />
        </div>
        <Tip content="Per-column filters">
          <Button
            variant={filterRow ? "default" : "ghost"}
            size="icon-sm"
            aria-pressed={filterRow}
            aria-label="Toggle per-column filters"
            onClick={() => setFilterRow((v) => !v)}
            className={cn(filterRow && "text-accent")}
          >
            <ListFilter className="size-3.5" />
          </Button>
        </Tip>
        <ColumnsMenu table={table} />
        <div className="grow" />
        <span className="mr-1 text-[11px] tabular-nums text-faint">
          {tableRows.length !== rows.length && (
            <>
              <span className="text-mut">{fmtCount(tableRows.length)}</span> of{" "}
            </>
          )}
          {fmtCount(rows.length)} rows
          {running && <span className="ml-1 text-accent">· streaming</span>}
        </span>
        <Button size="sm" onClick={exportCsv} disabled={exporting || tableRows.length === 0}>
          {exporting ? <Spinner className="size-3" /> : <Download className="size-3.5" />}
          CSV
        </Button>
      </div>

      {/* virtualized grid (div-based: rows are absolutely positioned so
          scrolling never relayouts the container) */}
      <div ref={scrollRef} className="min-h-0 grow overflow-auto" role="table" aria-rowcount={tableRows.length}>
        <div style={{ width: totalWidth, minWidth: "100%" }}>
          {/* header */}
          <div className="sticky top-0 z-10" role="rowgroup">
            <div className="flex" role="row">
              {table.getHeaderGroups()[0].headers.map((header) => {
                const sorted = header.column.getIsSorted();
                return (
                  <div
                    key={header.id}
                    role="columnheader"
                    aria-sort={
                      sorted === "asc" ? "ascending" : sorted === "desc" ? "descending" : "none"
                    }
                    style={{ width: header.getSize() }}
                    className="relative shrink-0 border-r border-b border-line bg-raised select-none last:border-r-0"
                  >
                    <button
                      type="button"
                      onClick={header.column.getToggleSortingHandler()}
                      className="flex h-7 w-full cursor-pointer items-center gap-1 px-2 text-mut transition-colors hover:text-ink"
                      title={`Sort by ${colName(header.column.id)}`}
                    >
                      <span className="truncate font-mono text-[11px] font-medium">
                        {flexRender(header.column.columnDef.header, header.getContext())}
                      </span>
                      {sorted === "asc" && <ArrowUp className="size-3 shrink-0 text-accent" />}
                      {sorted === "desc" && <ArrowDown className="size-3 shrink-0 text-accent" />}
                    </button>
                    <span
                      onMouseDown={header.getResizeHandler()}
                      onTouchStart={header.getResizeHandler()}
                      onDoubleClick={() => header.column.resetSize()}
                      className="absolute top-0 -right-[3px] z-10 h-full w-1.5 cursor-col-resize hover:bg-accent/50"
                    />
                  </div>
                );
              })}
            </div>
            {filterRow && (
              <div className="flex" role="row">
                {leafColumns.map((col) => (
                  <div
                    key={col.id}
                    style={{ width: col.getSize() }}
                    className="shrink-0 border-r border-b border-line bg-surface p-0.5 last:border-r-0"
                  >
                    <input
                      value={(col.getFilterValue() as string) ?? ""}
                      onChange={(e) => col.setFilterValue(e.target.value || undefined)}
                      placeholder="filter"
                      aria-label={`Filter ${colName(col.id)}`}
                      className="h-6 w-full rounded-[4px] border border-transparent bg-transparent px-1.5 font-mono text-[11px] text-ink placeholder:text-faint/60 focus:border-accent/50 focus:bg-canvas focus:outline-none"
                    />
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* body */}
          {tableRows.length === 0 ? (
            <div className="p-8 text-center text-xs text-mut">
              No rows match the current filters.
            </div>
          ) : (
            <div
              role="rowgroup"
              className="relative font-mono text-[11.5px]"
              style={{ height: virtualizer.getTotalSize() }}
            >
              {virtualRows.map((vr) => (
                <MemoRow
                  key={tableRows[vr.index].id}
                  row={tableRows[vr.index]}
                  start={vr.start}
                  layout={layout}
                  multiTarget={multiTarget}
                />
              ))}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---- virtualized row ------------------------------------------------------

interface ColLayout {
  id: string;
  width: number;
}

/**
 * One grid row. Memoized: while scrolling, rows already on screen keep their
 * element identity and skip re-rendering entirely — only rows entering the
 * viewport mount. `layout` identity changes on resize/visibility to bust it.
 */
const MemoRow = memo(function GridRowView({
  row,
  start,
  layout,
  multiTarget,
}: {
  row: TableRow<GridRow>;
  start: number;
  layout: ColLayout[];
  multiTarget: boolean;
}) {
  const original = row.original;
  return (
    <div
      role="row"
      className="group absolute top-0 left-0 flex w-full border-b border-line/60 hover:bg-accent/6"
      style={{ transform: `translateY(${start}px)`, height: ROW_H }}
    >
      {layout.map(({ id, width }) => {
        if (id === UCM_COL) {
          return (
            <div
              key={id}
              role="cell"
              style={{ width }}
              className="flex shrink-0 items-center gap-1.5 truncate border-r border-line/60 px-2 whitespace-nowrap text-mut"
              title={original.ucmName}
            >
              {multiTarget && (
                <span
                  className="size-1.5 shrink-0 rounded-full"
                  style={{ background: `hsl(${ucmHue(original.ucmId)} 75% 52%)` }}
                />
              )}
              <span className="truncate">{original.ucmName}</span>
            </div>
          );
        }
        const value = row.getValue<string>(id);
        return (
          <div
            key={id}
            role="cell"
            style={{ width }}
            className="shrink-0 truncate border-r border-line/60 px-2 leading-[27px] whitespace-nowrap text-ink/90 last:border-r-0"
            title={value || undefined}
          >
            {value}
          </div>
        );
      })}
    </div>
  );
});

// ---- column visibility menu --------------------------------------------

function ColumnsMenu({ table }: { table: Table<GridRow> }) {
  const all = table.getAllLeafColumns();
  const hiddenCount = all.filter((c) => !c.getIsVisible()).length;
  return (
    <RDropdown.Root>
      <Tip content="Show / hide columns">
        <RDropdown.Trigger asChild>
          <Button variant="ghost" size="sm" aria-label="Column visibility" className="gap-1 px-2">
            <Columns3 className="size-3.5" />
            {hiddenCount > 0 && <span className="text-[10px] text-accent">−{hiddenCount}</span>}
          </Button>
        </RDropdown.Trigger>
      </Tip>
      <RDropdown.Portal>
        <RDropdown.Content
          align="start"
          sideOffset={4}
          className="z-50 max-h-80 w-56 animate-rise overflow-y-auto rounded-md border border-line bg-overlay p-1 shadow-pop"
        >
          {all.map((col) => (
            <RDropdown.CheckboxItem
              key={col.id}
              checked={col.getIsVisible()}
              onCheckedChange={(v) => col.toggleVisibility(!!v)}
              onSelect={(e) => e.preventDefault()} // keep menu open while toggling
              className="flex cursor-pointer items-center gap-2 rounded-[5px] px-2 py-1.5 font-mono text-[11.5px] text-ink outline-none select-none data-[highlighted]:bg-accent/12"
            >
              <span className="flex size-3.5 items-center justify-center rounded-[3px] border border-line-2">
                <RDropdown.ItemIndicator>
                  <Check className="size-3 text-accent" />
                </RDropdown.ItemIndicator>
              </span>
              <span className="truncate">{colName(col.id)}</span>
            </RDropdown.CheckboxItem>
          ))}
          {hiddenCount > 0 && (
            <>
              <RDropdown.Separator className="my-1 h-px bg-line" />
              <RDropdown.Item
                onSelect={() => table.resetColumnVisibility()}
                className="cursor-pointer rounded-[5px] px-2 py-1.5 text-xs font-medium text-accent outline-none select-none data-[highlighted]:bg-accent/12"
              >
                Show all columns
              </RDropdown.Item>
            </>
          )}
        </RDropdown.Content>
      </RDropdown.Portal>
    </RDropdown.Root>
  );
}
