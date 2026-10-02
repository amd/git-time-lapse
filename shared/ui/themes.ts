// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT
/**
 * Theme catalog shared across all platform shells.
 *
 * The list of selectable highlight.js themes (their ids, display names, and
 * dark/light flag) lives here so every shell agrees on them. Each shell imports
 * the theme CSS its own way (Vite `?raw`, webpack asset/source) and calls
 * `buildThemes` with a map of id -> CSS to produce the `HljsTheme[]` the shared
 * UI consumes.
 *
 * This module also owns config migration (old `dark_mode` boolean -> theme id)
 * and the mapping from an IDE's own theme name to one of our theme ids, used to
 * auto-match the IDE on first run.
 */

import type { HljsTheme } from "../types";

/** Metadata for one selectable theme, minus the platform-supplied CSS. */
export interface ThemeMeta {
  id: string;
  name: string;
  isDark: boolean;
}

/**
 * The selectable themes, in dropdown order (light group then dark group). Ids
 * match highlight.js style filenames so each shell can import them by name.
 */
export const THEME_METAS: ThemeMeta[] = [
  { id: "default", name: "Default (Light)", isDark: false },
  { id: "github", name: "GitHub", isDark: false },
  { id: "vs", name: "VS Light", isDark: false },
  { id: "atom-one-light", name: "Atom One Light", isDark: false },
  { id: "monokai", name: "Monokai (Dark)", isDark: true },
  { id: "github-dark", name: "GitHub Dark", isDark: true },
  { id: "vs2015", name: "VS 2015", isDark: true },
  { id: "atom-one-dark", name: "Atom One Dark", isDark: true },
  { id: "dracula", name: "Dracula", isDark: true },
];

export const DEFAULT_LIGHT_THEME_ID = "default";
export const DEFAULT_DARK_THEME_ID = "monokai";

/**
 * Combine the shared theme metadata with a platform-supplied `id -> CSS` map to
 * produce the `HljsTheme[]` for `AppDeps`. Themes whose CSS is missing from the
 * map are skipped, so a shell can bundle a subset without crashing.
 */
export function buildThemes(cssById: Record<string, string>): HljsTheme[] {
  const themes: HljsTheme[] = [];
  for (const meta of THEME_METAS) {
    const css = cssById[meta.id];
    if (typeof css === "string") {
      themes.push({ id: meta.id, name: meta.name, isDark: meta.isDark, css });
    }
  }
  return themes;
}

/**
 * Map an IDE's own theme name/id to one of our theme ids, or null if there's no
 * good match. Matching is case-insensitive and substring-based so variants like
 * "Default Dark+" or "Visual Studio Dark" still land on a sensible theme.
 */
export function ideThemeToId(ideTheme: string | null | undefined): string | null {
  if (!ideTheme) return null;
  const t = ideTheme.toLowerCase();

  // Exact / branded matches first.
  if (t.includes("dracula")) return "dracula";
  if (t.includes("atom one dark") || t.includes("one dark")) return "atom-one-dark";
  if (t.includes("atom one light") || t.includes("one light")) return "atom-one-light";
  if (t.includes("github dark")) return "github-dark";
  if (t.includes("github light") || t === "github") return "github";
  if (t.includes("monokai")) return "monokai";
  // Visual Studio's own theme names.
  if (t === "dark" || t.includes("visual studio dark")) return "vs2015";
  if (t === "blue" || t === "light" || t.includes("visual studio light") || t.includes("blue")) {
    return "vs";
  }
  // VS Code default themes.
  if (t.includes("dark")) return DEFAULT_DARK_THEME_ID;
  if (t.includes("light")) return DEFAULT_LIGHT_THEME_ID;

  return null;
}

/**
 * Resolve a persisted config's theme id, migrating legacy configs. Newer configs
 * store `theme` directly; older ones stored a `dark_mode` boolean, which maps to
 * monokai (dark) or default (light).
 */
export function migrateThemeId(raw: unknown): string {
  if (raw && typeof raw === "object") {
    const obj = raw as Record<string, unknown>;
    if (typeof obj.theme === "string" && obj.theme) return obj.theme;
    if (typeof obj.dark_mode === "boolean") {
      return obj.dark_mode ? DEFAULT_DARK_THEME_ID : DEFAULT_LIGHT_THEME_ID;
    }
  }
  return DEFAULT_LIGHT_THEME_ID;
}
