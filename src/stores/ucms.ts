import { create } from "zustand";
import { ipc } from "../lib/ipc";
import type { Ucm, UcmInput } from "../lib/types";

interface UcmsState {
  ucms: Ucm[];
  loaded: boolean;
  load: () => Promise<void>;
  create: (input: UcmInput) => Promise<Ucm>;
  update: (id: string, input: UcmInput) => Promise<Ucm>;
  remove: (id: string) => Promise<void>;
}

export const useUcmsStore = create<UcmsState>((set, get) => ({
  ucms: [],
  loaded: false,

  load: async () => {
    const ucms = await ipc.listUcms();
    set({ ucms, loaded: true });
  },

  create: async (input) => {
    const ucm = await ipc.createUcm(input);
    set({ ucms: [...get().ucms, ucm] });
    return ucm;
  },

  update: async (id, input) => {
    const ucm = await ipc.updateUcm(id, input);
    set({ ucms: get().ucms.map((u) => (u.id === id ? ucm : u)) });
    return ucm;
  },

  remove: async (id) => {
    await ipc.deleteUcm(id);
    set({ ucms: get().ucms.filter((u) => u.id !== id) });
  },
}));
