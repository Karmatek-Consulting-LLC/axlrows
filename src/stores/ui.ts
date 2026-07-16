import { create } from "zustand";

export type View = "query" | "favorites" | "servers";
export type Theme = "dark" | "light";

const THEME_KEY = "axlrows.theme";

function initialTheme(): Theme {
  const saved = localStorage.getItem(THEME_KEY);
  if (saved === "light" || saved === "dark") return saved;
  return "dark"; // dark-first
}

function applyTheme(theme: Theme) {
  document.documentElement.classList.toggle("dark", theme === "dark");
  document.documentElement.style.colorScheme = theme;
}

interface UiState {
  view: View;
  setView: (v: View) => void;
  theme: Theme;
  setTheme: (t: Theme) => void;
  toggleTheme: () => void;
  paletteOpen: boolean;
  setPaletteOpen: (open: boolean) => void;
  /** "Bookmark current query" dialog (lives in QueryView; opened from anywhere). */
  bookmarkOpen: boolean;
  setBookmarkOpen: (open: boolean) => void;
}

export const useUiStore = create<UiState>((set, get) => ({
  view: "query",
  setView: (view) => set({ view }),
  theme: initialTheme(),
  setTheme: (theme) => {
    localStorage.setItem(THEME_KEY, theme);
    applyTheme(theme);
    set({ theme });
  },
  toggleTheme: () => get().setTheme(get().theme === "dark" ? "light" : "dark"),
  paletteOpen: false,
  setPaletteOpen: (paletteOpen) => set({ paletteOpen }),
  bookmarkOpen: false,
  setBookmarkOpen: (bookmarkOpen) => set({ bookmarkOpen }),
}));

// Apply persisted theme immediately at module load (before first paint).
applyTheme(useUiStore.getState().theme);
