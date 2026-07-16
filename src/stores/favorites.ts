import { create } from "zustand";
import { ipc } from "../lib/ipc";
import type { Favorite } from "../lib/types";

interface FavoritesState {
  favorites: Favorite[];
  loaded: boolean;
  load: () => Promise<void>;
  create: (name: string, sql: string) => Promise<Favorite>;
  update: (id: string, name: string, sql: string) => Promise<Favorite>;
  remove: (id: string) => Promise<void>;
}

export const useFavoritesStore = create<FavoritesState>((set, get) => ({
  favorites: [],
  loaded: false,

  load: async () => {
    const favorites = await ipc.listFavorites();
    set({ favorites, loaded: true });
  },

  create: async (name, sql) => {
    const fav = await ipc.createFavorite(name, sql);
    set({ favorites: [fav, ...get().favorites] });
    return fav;
  },

  update: async (id, name, sql) => {
    const fav = await ipc.updateFavorite(id, name, sql);
    set({ favorites: get().favorites.map((f) => (f.id === id ? fav : f)) });
    return fav;
  },

  remove: async (id) => {
    await ipc.deleteFavorite(id);
    set({ favorites: get().favorites.filter((f) => f.id !== id) });
  },
}));
