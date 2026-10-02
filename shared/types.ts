// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT
/**
 * Shared types for git-time-lapse.
 *
 * These interfaces and error classes are used by the platform-agnostic git
 * backend, visualization, and UI, and are re-used by each platform shell
 * (Tauri, VS Code). The `GitTransport` interface is the seam between the shared
 * backend and how each platform actually runs git.
 */

/**
 * How the shared backend runs git. Each platform provides an implementation:
 * - Tauri: `invoke("run_git", ...)`.
 * - VS Code extension host: `child_process.execFile`.
 *
 * Both methods return git's stdout; they must NOT throw on a non-zero git exit
 * (a failing command such as an empty diff or a missing blob is expected and
 * handled by the backend). Text and bytes are separate calls so
 * binary content stays byte-accurate.
 */
export interface GitTransport {
  /** Run git and return stdout decoded as text (utf-8, latin-1 fallback). */
  runGitText(args: string[], cwd: string): Promise<string>;
  /** Run git and return stdout as raw bytes. */
  runGitBytes(args: string[], cwd: string): Promise<Uint8Array>;
}

/**
 * Sentinel `hexSha` for the virtual "uncommitted changes" revision appended to
 * the history when the working tree differs from HEAD. It is not a real git
 * object; the backend/UI special-case it to read the working tree instead of
 * `git show <hex>:<file>`.
 */
export const MODIFIED_SENTINEL = "modified";

/** A single commit that touched the tracked file. */
export interface FileHistory {
  hexSha: string;
  authorName: string;
  authorEmail: string;
  authoredDate: Date;
  message: string;
  summary: string;
}

export interface RenameSegment {
  filePath: string;
  renameCommitHex: string;
}

/** A contiguous block of lines attributed to one commit by blame. */
export interface BlameEntry {
  commitHex: string;
  authorName: string;
  authorEmail: string;
  authoredDate: Date;
  origLineno: number;
  // Stable 1-based line number of the block's first line *within the commit that
  // introduced it*. Unlike origLineno (the block's position in this file
  // version, which drifts as lines above are added/removed), this identifies a
  // physical line consistently across revisions. Lines in the block are
  // contiguous: line j has origin `originLine + j`.
  originLine: number;
  lines: string[];
}

/**
 * Richer diff info than a plain per-line status map.
 *
 * - `statuses`: new line number -> 'added' | 'modified' | 'unchanged'.
 * - `removals`: new line number -> lines deleted *immediately before* that new
 *   line. A key of `newLineCount + 1` holds deletions at end-of-file.
 * - `modifiedOld`: new line number -> the old text of lines changed in place.
 */
export interface DiffDetail {
  statuses: Map<number, string>;
  removals: Map<number, string[]>;
  modifiedOld: Map<number, string[]>;
}

export type LineStatus = "added" | "modified" | "unchanged";

/**
 * One display row produced by replaying a unified diff in git's own order:
 * a changed block shows all removed lines first, then all added lines.
 */
export interface DiffRow {
  lineno: number | null; // new-file line number, or null for removed lines
  oldLineno: number | null; // old-file line number for removed lines (for blame lookup)
  status: "added" | "modified" | "unchanged" | "removed";
  text: string;
}

/** Raised when a file's content at a commit cannot be decoded as text. */
export class BinaryFileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BinaryFileError";
  }
}

/** Raised when the requested file is not present in a commit / HEAD. */
export class FileNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FileNotFoundError";
  }
}

/** User preferences, persisted per platform (Tauri config file / VS Code). */
export interface AppConfig {
  theme: string; // highlight.js theme id (see shared/ui/themes.ts)
  coloring: string; // none | diff | blame | age
  gutter: string; // revision | hash | author | date
  show_details: boolean;
  show_blame: boolean;
  show_lineno: boolean;
  show_lifetimes: boolean;
  blame_format: string; // full | first | last | email
  gutter_width: number;
  font_size: number;
  precache_workers: number | null; // parallel worker count for precaching (null = half of CPU threads)
  browse_mode: "file" | "repo"; // default mode for the file/repo selector
  show_sparse_files?: boolean; // reveal skip-worktree (sparse-checkout) entries in the tree browser
  show_deleted_files?: boolean; // show files/dirs deleted from HEAD in the tree browser
  tree_panel_height?: number;
  recent_files?: Array<{ path: string; mode: "file" | "repo" }>; // most-recent-first, max 10
  history_changes_only?: boolean; // history search tray lists only added/edited/removed matches
}

/** Platform identifier for per-target preferences. */
export type Platform = "desktop" | "vscode" | "vs";

/**
 * Load an AppConfig from a raw JSON object, using per-platform sub-keys
 * with fallback to top-level keys for migration.
 *
 * File format:
 * ```json
 * {
 *   "desktop": { "theme": "monokai", "coloring": "diff", ... },
 *   "vscode":  { "theme": "github-dark", ... },
 *   "vs":      { "theme": "vs2015", ... },
 *   "theme": "default",     // legacy fallback
 *   "coloring": "diff",     // legacy fallback
 *   ...
 * }
 * ```
 */
export function loadConfigFromRaw(raw: Record<string, unknown>, platform: Platform): AppConfig {
  const config: AppConfig = { ...DEFAULT_CONFIG };
  const target = config as unknown as Record<string, unknown>;
  const platformSection = (raw[platform] ?? {}) as Record<string, unknown>;

  for (const key of Object.keys(DEFAULT_CONFIG)) {
    // Platform-specific value takes priority, then top-level fallback
    if (key in platformSection) {
      target[key] = platformSection[key];
    } else if (key in raw) {
      target[key] = raw[key];
    }
  }

  // Copy optional fields not in DEFAULT_CONFIG
  if ("recent_files" in platformSection) {
    config.recent_files = platformSection.recent_files as AppConfig["recent_files"];
  } else if ("recent_files" in raw) {
    config.recent_files = raw.recent_files as AppConfig["recent_files"];
  }

  // Migrate legacy dark_mode if no theme was found anywhere
  if (!("theme" in platformSection) && !("theme" in raw) && "dark_mode" in raw) {
    config.theme = raw["dark_mode"] ? "monokai" : "default";
  }

  return config;
}

/**
 * Merge an AppConfig back into the raw JSON object under the platform's sub-key,
 * preserving other platforms' sections and legacy top-level keys.
 */
export function saveConfigToRaw(
  raw: Record<string, unknown>,
  config: AppConfig,
  platform: Platform,
): Record<string, unknown> {
  const out = { ...raw };
  const section: Record<string, unknown> = {};
  for (const key of Object.keys(config)) {
    const val = (config as unknown as Record<string, unknown>)[key];
    if (val !== undefined) section[key] = val;
  }
  out[platform] = section;
  return out;
}

export const DEFAULT_CONFIG: AppConfig = {
  theme: "default",
  coloring: "diff",
  gutter: "revision",
  show_details: true,
  show_blame: true,
  show_lineno: true,
  show_lifetimes: false,
  blame_format: "full",
  gutter_width: 120,
  font_size: 14,
  precache_workers: null,
  browse_mode: "file",
  show_sparse_files: false,
  show_deleted_files: true,
  recent_files: [],
  history_changes_only: false,
};

/**
 * The subset of the git backend the shared UI calls. Implemented directly by
 * the shared GitTimeLapse (Tauri, in-webview) and by an RPC client that
 * forwards to the extension host (VS Code). Lets the UI stay agnostic about
 * where the backend actually runs.
 */
export interface Backend {
  getLatestCommitHash(): Promise<string>;
  /**
   * Validate a ref and describe it. `hash` is the abbreviated commit;
   * `label` is the branch/tag/symbolic-ref name, or empty for a raw commit.
   * `ok` is false if it does not resolve to a commit.
   */
  resolveRef(ref: string): Promise<{ ok: boolean; label: string; hash: string }>;
  /**
   * Local branches, tags and remote-tracking branches for autocomplete.
   * Reads local ref storage only -- never contacts a remote.
   */
  listRefs(): Promise<{ name: string; kind: "branch" | "tag" | "remote" }[]>;
  getFileModifiedState(): Promise<string>;
  getCommits(): Promise<FileHistory[]>;
  getCommitInfo(commitHex: string): Promise<FileHistory>;
  getFileContent(commitHex: string): Promise<string>;
  getBlame(commitHex: string): Promise<BlameEntry[]>;
  getDiffDetail(oldHex: string, newHex: string): Promise<DiffDetail>;
  getDiffRows(oldHex: string, newHex: string, sourceLines: string[]): Promise<DiffRow[]>;
  /**
   * The tracked file's content as it currently exists in the working tree
   * (HEAD content with any staged + unstaged changes applied). Powers the
   * virtual "uncommitted changes" revision (see {@link MODIFIED_SENTINEL}).
   */
  getWorkingTreeContent(): Promise<string>;
  /** Diff detail between HEAD (or `baseHex`) and the working-tree file. */
  getWorkingTreeDiffDetail(baseHex: string): Promise<DiffDetail>;
  /** Diff rows between HEAD (or `baseHex`) and the working-tree file. */
  getWorkingTreeDiffRows(baseHex: string, sourceLines: string[]): Promise<DiffRow[]>;
  translateLine(
    oldLineno: number,
    oldCommitHex: string,
    newCommitHex: string,
  ): Promise<number | null>;
  /**
   * Immediate children of a repo-relative directory ("" = root) in the index.
   * Entries outside the sparse-checkout cone are included with `sparse: true`
   * (in a non-sparse repo no entry carries the flag).
   */
  listDirectory(dirPath: string): Promise<{ name: string; isDir: boolean; sparse?: boolean; isSubmodule?: boolean }[]>;
  /** Immediate-child filenames deleted from a directory ("" = root). */
  listDeletedInDirectory(dirPath: string): Promise<string[]>;
  /** All tracked file paths in HEAD (repo-relative); powers filter search. */
  listAllFiles(): Promise<string[]>;
  /** Sparse (skip-worktree) file paths (repo-relative); folded into filter search when sparse files are shown. */
  listSparseFiles(): Promise<string[]>;
  /** The repo root (absolute path); anchors tree-relative paths without the full file list. */
  getRepoRoot(): Promise<string>;
  listDirectoryInfo(dirPath: string): Promise<{ deleted: string[]; deletedDirs: string[]; counts: Map<string, number> }>;
  getGitUserEmail(): Promise<string>;
  getGitUserName(): Promise<string>;
  listModifiedFiles(): Promise<Set<string>>;
  getFileRevisionCount(filePath: string): Promise<number>;
  listDirectoryRevisionCounts(dirPath: string): Promise<Map<string, number>>;
  /**
   * Warm the whole cache from one `git log -p` call so scrubbing is instant.
   * Optional: not every Backend implements it, and the UI treats its absence as
   * "fall back to per-revision precaching". `onProgress(done, total)` fires as
   * revisions are cached, for the progress bar.
   *
   * NOTE: for the VS Code RPC backend the callback can't cross the postMessage
   * boundary, so progress there is driven by the UI's own per-revision cache
   * reads rather than this callback.
   */
  populateFromLog?(onProgress?: (done: number, total: number) => void, workerCount?: number): Promise<void>;
  detectRenames?(): Promise<RenameSegment[]>;
  getCommitsForPath?(filePath: string): Promise<FileHistory[]>;
  populateForPath?(
    filePath: string,
    onProgress?: (done: number, total: number) => void,
    workerCount?: number | null,
  ): Promise<void>;
  getBlameForPath?(filePath: string, commitHex: string): Promise<BlameEntry[]>;
  getFileContentForPath?(filePath: string, commitHex: string): Promise<string>;
  getDiffDetailForPath?(filePath: string, oldHex: string, newHex: string): Promise<DiffDetail>;
  getDiffRowsForPath?(filePath: string, oldHex: string, newHex: string, sourceLines: string[]): Promise<DiffRow[]>;
  getCrossPathDiffRows?(oldHex: string, oldPath: string, newHex: string, newPath: string, sourceLines: string[]): Promise<DiffRow[]>;
}

/**
 * One selectable syntax-highlighting theme. `css` is the raw highlight.js theme
 * stylesheet (each bundler imports CSS differently, so the shell supplies it);
 * `isDark` drives the window chrome, gutter, and diff coloring.
 */
export interface HljsTheme {
  id: string;
  name: string; // Display name for the dropdown
  isDark: boolean;
  css: string;
}

/**
 * Everything the shared App needs from its host shell: a factory that builds a
 * Backend for a file, the platform services, and the bundled hljs themes (each
 * bundler imports CSS differently, so the shell supplies them).
 */
export interface AppDeps {
  createBackend(repoDir: string, filePath: string, ref?: string): Promise<Backend>;
  host: PlatformHost;
  themes: HljsTheme[];
}

/**
 * The platform services the shared UI needs beyond the git backend: config
 * persistence, a file-open dialog, and small window operations. Each shell
 * implements this (Tauri APIs, or VS Code postMessage to the host).
 */
export interface PlatformHost {
  loadConfig(): Promise<AppConfig>;
  saveConfig(config: AppConfig): Promise<void>;
  openConfigInEditor(): Promise<void>;
  /** Show a file-open dialog; resolve to the chosen path or null. */
  openFileDialog(): Promise<string | null>;
  /** Show a directory-open dialog; resolve to the chosen path or null. */
  openDirectoryDialog?(): Promise<string | null>;
  /** Set the window/panel title. */
  setTitle(title: string): void;
  /** Switch native window theme where applicable (no-op in VS Code). */
  setTheme(theme: "dark" | "light"): void;
  /** Close the window/panel. */
  close(): void;
  /** Show an error message to the user. */
  showError(message: string): void;
  /**
   * The IDE's current theme name/id, or null when there is no host IDE to match
   * (Tauri) or it can't be determined. The shared UI maps this to a bundled
   * highlight.js theme when the user has no saved preference.
   */
  getIdeTheme?(): Promise<string | null>;
  /** IDE version string (e.g. "Visual Studio 2022 17.14", "VS Code 1.96"). */
  getIdeVersion?(): Promise<string | null>;
  /** True when running inside VS Code (hides the in-app file selector row). */
  readonly isVSCode: boolean;
}
