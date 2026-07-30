import { create } from "zustand";
import { ipc } from "../lib/ipc";
import type { SchemaInfo, SchemaMap } from "../lib/types";

interface SchemaState {
  /** Union of every cached server schema; null before any fetch. */
  tables: SchemaMap | null;
  fetchedAt: string | null;
  /** ucmId currently being introspected, for per-card spinners. */
  fetching: string | null;
  load: () => Promise<void>;
  refresh: (ucmId: string) => Promise<SchemaInfo>;
}

export const useSchemaStore = create<SchemaState>((set) => ({
  tables: null,
  fetchedAt: null,
  fetching: null,

  load: async () => {
    const info = await ipc.getSchema();
    if (info) set({ tables: info.tables, fetchedAt: info.fetchedAt });
  },

  refresh: async (ucmId) => {
    set({ fetching: ucmId });
    try {
      const info = await ipc.fetchSchema(ucmId);
      // Re-read the merged union rather than trusting one server's map.
      const merged = await ipc.getSchema();
      set({
        tables: merged?.tables ?? info.tables,
        fetchedAt: merged?.fetchedAt ?? info.fetchedAt,
      });
      return info;
    } finally {
      set({ fetching: null });
    }
  },
}));
