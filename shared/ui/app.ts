// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT
/**
 * Git Time-Lapse View: shared, platform-agnostic UI.
 *
 * Presents a single file's git history as a time-lapse: a slider scrubs through
 * the commits that touched the file, updating a syntax-highlighted view of the
 * file content and the commit metadata for the selected revision.
 *
 * This module is bundler- and platform-agnostic: it imports its own CSS but not
 * highlight.js theme CSS (bundlers differ), the git backend, config, dialog, or
 * window APIs. Those are injected via `AppDeps` (see startApp), so the same code
 * runs in the Tauri webview and the VS Code webview.
 */

import "./style.css";
import hljs from "highlight.js";

import {
  AppConfig,
  AppDeps,
  Backend,
  BinaryFileError,
  BlameEntry,
  DiffDetail,
  DiffRow,
  FileHistory,
  FileNotFoundError,
  HljsTheme,
  MODIFIED_SENTINEL,
  RenameSegment,
} from "../types";
import {
  DEFAULT_LIGHT_THEME_ID,
  ideThemeToId,
} from "./themes";
import {
  ageBucketHexes,
  ageColor,
  authorColor,
  authorDisplay,
  blameToLineInfos,
  currentLineColorFor,
  diffColorsFor,
  Hex,
  LineInfo,
  removedColorFor,
  selectedDiffColor,
} from "../visualization";

type ColoringMode = "none" | "diff" | "blame" | "age" | "range";
type GutterMode = "revision" | "hash" | "author" | "date";
type Status = "added" | "modified" | "unchanged" | "removed";

/** A display row: real source line (with lineno) or a virtual removed row. */
interface Row {
  lineno: number | null;
  oldLineno: number | null;
  info: LineInfo | null;
  status: Status;
  text: string;
}

const CHANGED_STATUSES: ReadonlySet<Status> = new Set([
  "added",
  "modified",
  "removed",
]);

function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  cls?: string,
  text?: string,
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Insert the "#N" revision-count badge immediately after the file name and
// before any parenthetical badge (deleted/modified/opened/submodule/sparse) so
// the row always reads "name #N (…)". Anchoring to the file-name span rather
// than an arbitrary parenthetical marker keeps the order correct regardless of
// which badges are present or the order they were added. Idempotent.
function insertTreeRevCount(rowEl: HTMLElement, count: number): void {
  if (count <= 0) return;
  if (rowEl.querySelector(".tree-rev-count")) return;
  const badge = el("span", "tree-rev-count", `#${count}`);
  const name = rowEl.querySelector<HTMLElement>(".tree-file-name");
  if (name) {
    if (name.nextSibling) rowEl.insertBefore(badge, name.nextSibling);
    else rowEl.appendChild(badge);
    return;
  }
  const marker = rowEl.querySelector(
    ".tree-submodule-badge, .tree-combined-badge",
  );
  if (marker) rowEl.insertBefore(badge, marker);
  else rowEl.appendChild(badge);
}

// The set of parenthetical badges a file/dir row can carry, in the fixed
// hierarchical display order. Submodule is rendered separately (dirs only) and
// is not part of this combined badge.
interface TreeBadgeFlags {
  sparse?: boolean;
  deleted?: boolean;
  modified?: boolean;
  opened?: boolean;
}

// Render (or clear) the single combined parenthetical badge on a row. All
// applicable labels are collected in the order sparse → deleted → modified →
// opened, joined with ", ", wrapped in one set of parentheses, and appended as
// a `.tree-combined-badge` wrapper. Any existing combined badge is removed
// first, so this is the one entry point for (re)building badge text. Idempotent.
function renderTreeBadges(rowEl: HTMLElement, flags: TreeBadgeFlags): void {
  rowEl.querySelector(".tree-combined-badge")?.remove();

  const parts: { cls: string; label: string }[] = [];
  if (flags.sparse) parts.push({ cls: "tree-sparse-badge", label: "sparse" });
  if (flags.deleted) parts.push({ cls: "tree-deleted-badge", label: "deleted" });
  if (flags.modified) parts.push({ cls: "tree-modified-badge", label: "modified" });
  if (flags.opened) parts.push({ cls: "tree-opened-badge", label: "opened" });
  if (parts.length === 0) return;

  const wrap = el("span", "tree-combined-badge");
  wrap.appendChild(el("span", "tree-badge-paren", "("));
  parts.forEach((p, i) => {
    if (i > 0) wrap.appendChild(el("span", "tree-badge-sep", ", "));
    wrap.appendChild(el("span", p.cls, p.label));
  });
  wrap.appendChild(el("span", "tree-badge-paren", ")"));
  rowEl.appendChild(wrap);
}

// Derive the current badge flags for a row from its persisted state (dataset +
// modified/opened lookups) so a single changed flag can trigger a full rebuild
// without the caller having to know the other flags.
function treeBadgeFlagsFor(
  rowEl: HTMLElement,
  modifiedFiles: Set<string>,
  openedPath: string,
): TreeBadgeFlags {
  const path = rowEl.dataset.path ?? "";
  const isFile = rowEl.dataset.dir !== "true";
  return {
    sparse: rowEl.dataset.sparse === "true",
    deleted: rowEl.dataset.deleted === "true",
    modified: isFile && !!path && modifiedFiles.has(path),
    opened: isFile && !!path && !!openedPath && path === openedPath,
  };
}

function fmtDate(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function fmtDateTime(d: Date): string {
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${fmtDate(d)} ${hh}:${mm}`;
}

function basename(p: string): string {
  return p.replace(/\\/g, "/").split("/").pop() ?? p;
}

function dirname(p: string): string {
  const norm = p.replace(/\\/g, "/");
  const idx = norm.lastIndexOf("/");
  return idx <= 0 ? "." : norm.slice(0, idx);
}

// Quotes are escaped too: esc() output is interpolated into quoted attribute
// values (see revLinkHtml), where &lt;/&gt; escaping alone would let a quote in
// a commit message or path close the attribute.
function esc(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function setsEqual(a: Set<string>, b: Set<string>): boolean {
  if (a.size !== b.size) return false;
  for (const v of a) if (!b.has(v)) return false;
  return true;
}

/** The parts of a tab's state needed to diff a revision the way the viewer does. */
interface RevisionSource {
  backend: Backend;
  commits: FileHistory[];
  filePath: string;
  followRenames: boolean;
  segPaths: Map<string, string>;
  segmentBoundaries: number[];
  hasModifiedRev: boolean;
  modifiedBaseHex: string;
}

/**
 * One row of the history-search tray. The tray is a flat virtualized list, so
 * a revision heading and the matching lines under it are separate rows of the
 * same fixed height. `index` is the revision's position in `commits` when the
 * search ran; results are dropped whenever `commits` is rebuilt, so it stays
 * valid for labelling, while jumps still resolve through the hash.
 *
 * A hit's `mark` is "+" when the revision added the line (or changed it in
 * place), " " when it carried over unchanged, and "-" when the revision
 * removed it. A removed line has no number in the revision that removed it,
 * so `lineno` is its number in the predecessor and `anchor` is the surviving
 * line it was removed in front of; for the other marks the two are equal.
 */
type HistoryMark = "+" | " " | "-";
interface HistoryRevRow {
  kind: "rev"; hexSha: string; index: number; path: string | null;
  present: number; added: number; removed: number;
}
interface HistoryHitRow {
  kind: "hit"; hexSha: string; index: number; mark: HistoryMark;
  lineno: number; anchor: number; text: string;
}
type HistoryRow = HistoryRevRow | HistoryHitRow;

/**
 * One revision's kept results. The heading's counts are the revision's full
 * counts even when the caps kept only some of its entries.
 */
interface HistoryRev {
  head: HistoryRevRow;
  hits: HistoryHitRow[];
}

/**
 * A tab's history search: its tray, its controls in the Find bar, and its
 * results. Kept as one object per tab so a search that is still running when
 * the user switches tabs writes into the tab it was started from.
 */
interface HistorySearch {
  tray: HTMLDivElement;
  list: HTMLDivElement;
  lines: HTMLDivElement;
  status: HTMLSpanElement;
  toggleBtn: HTMLButtonElement;
  searchBtn: HTMLButtonElement;
  changesBtn: HTMLButtonElement;
  empty: HTMLDivElement;
  /** The Find bar's previous/next-match buttons, which act on the revision on
   *  screen and so are disabled while history mode is on. */
  findNav: HTMLButtonElement[];
  /** Kept results, newest first; the source every filter rebuilds `rows` from. */
  revs: HistoryRev[];
  /** `revs` flattened for the virtualized list, with the Changes only filter applied. */
  rows: HistoryRow[];
  /** The filter `rows` was built with, so a toggle made elsewhere is caught up on. */
  rowsChangesOnly: boolean;
  /** The query that produced `rows`, which can differ from the field once edited. */
  query: string;
  /** Progress: revisions read, then revisions diffed out of those needing it. */
  searched: number;
  total: number;
  compared: number;
  toCompare: number;
  /** Kept entries, in total and by kind, and the revisions holding them. */
  hitCount: number;
  addedCount: number;
  removedCount: number;
  unchangedCount: number;
  revCount: number;
  /** Carried-over entries found but not kept, once their own cap was reached. */
  unchangedDropped: number;
  /** Entries and revisions currently listed after the filter. */
  shownCount: number;
  shownRevs: number;
  /** The change cap stopped the search before every revision was compared. */
  truncated: boolean;
  /** Scroll offset to restore when the tray is next shown. Detaching it on a
   *  tab switch or hiding it loses the offset, as it does for the code view. */
  savedScroll: number | null;
  running: boolean;
  renderedStart: number;
  renderedEnd: number;
  token: number;
}

interface TabState {
  id: number;
  label: string;
  bodyArea: HTMLDivElement;
  statusBar: HTMLDivElement;

  backend: Backend | null;
  commits: FileHistory[];
  hasModifiedRev: boolean;
  modifiedBaseHex: string;
  currentIndex: number;
  lineInfos: LineInfo[];
  rows: Row[];
  commitRevisions: Map<string, number>;
  lifetimeEndMap: Map<string, number>;
  rangeStart: number;
  rangeEnd: number;

  selectionMode: "chunk" | "line" | "none";
  selectedBlock: number | null;
  selectedChunkStart: number | null;
  selectedChunkEnd: number | null;
  stickyLineno: number | null;
  selectedLineBlock: number | null;

  precaching: boolean;
  lastKnownCommitHash: string;
  lastKnownModifiedState: string;
  precacheRemaining: number;
  precacheWorkerCount: number;
  precacheToken: number;

  firstLoad: boolean;
  filePath: string;
  searchMatchIndex: number;
  searchHitBlock: number | null;
  renderedStart: number;
  renderedEnd: number;
  hljsCache: Map<string, string>;
  scrollRafId: number;
  chunkHighlightToken: number;
  revInputMode: "rev" | "commit";

  followRenamesActive: boolean;
  renameSegments: RenameSegment[];
  renameDetected: boolean;
  renameDetectionToken: number;
  currentPathCommits: FileHistory[];
  commitSegmentPath: Map<string, string>;
  segmentBoundaries: number[];

  coloring: ColoringMode;
  gutterMode: GutterMode;
  showDetails: boolean;
  showBlame: boolean;
  showLineno: boolean;
  showLifetimes: boolean;
  prevColoring: ColoringMode;

  treeBackend: Backend | null;
  treeRepoRoot: string;
  /** Ref this tab's view is based on; "HEAD" follows the checked-out branch. */
  viewRef: string;
  /** Autocomplete candidates for the switch field; refreshed with the tree. */
  refList: { name: string; kind: "branch" | "tag" | "remote" }[];
  treeExpanded: boolean;
  treeLoaded: boolean;
  treeOpenedPath: string;
  treeModifiedFiles: Set<string>;
  treeAllFiles: string[] | null;
  treeSparseFiles: string[] | null;
  treeAllFilesLoading: boolean;
  treeAllFilesToken: number;
  treeDirCache: Map<string, { deleted: string[]; deletedDirs: string[]; counts: Map<string, number> }>;
  treeLoadToken: number;
  treeSubmoduleBackends: Map<string, Backend>;
  treeSubmoduleFiles: Map<string, string[]>;
  treeSelected: HTMLElement | null;
  treePreFilterScrollTop: number;
  treeLoadingCount: number;
  treePanelHeight: number;

  scrollTop: number;
  scrollLeft: number;

  pathField: HTMLInputElement;
  modeToggle: HTMLSelectElement;
  browseBtn: HTMLButtonElement;
  repoFileLabel: HTMLSpanElement;
  slider: HTMLInputElement;
  refBanner: HTMLDivElement;
  mRevBtn: HTMLButtonElement;
  rangeWrap: HTMLDivElement;
  rangeStartInput: HTMLInputElement;
  rangeEndInput: HTMLInputElement;
  rangeFill: HTMLDivElement;
  rangeLabels: HTMLDivElement;
  sliderLabels: HTMLDivElement;
  chunkHighlight: HTMLDivElement;
  prevRevBtn: HTMLButtonElement;
  nextRevBtn: HTMLButtonElement;
  revInput: HTMLInputElement;
  revDropdownBtn: HTMLButtonElement;
  revDropdownMenu: HTMLDivElement;
  modeCombo: HTMLSelectElement;
  gutterCombo: HTMLSelectElement;
  lifetimesBtn: HTMLButtonElement;
  followRenamesBtn: HTMLButtonElement;
  prevChunkBtn: HTMLButtonElement;
  nextChunkBtn: HTMLButtonElement;
  wrapIndicator: HTMLSpanElement;
  legendLabel: HTMLSpanElement;
  infoLabel: HTMLDivElement;
  searchRow: HTMLDivElement;
  searchField: HTMLInputElement;
  searchCount: HTMLSpanElement;
  history: HistorySearch;
  codeArea: HTMLDivElement;
  gutter: HTMLDivElement;
  gutterHandle: HTMLDivElement;
  gutterAuthor: HTMLDivElement;
  gutterLifetime: HTMLDivElement;
  gutterLineno: HTMLDivElement;
  codeLines: HTMLDivElement;
  detailSplitter: HTMLDivElement;
  prevDetail: HTMLDivElement;
  detailView: HTMLDivElement;
  statusMsg: HTMLSpanElement;
  codeContextMenu: HTMLDivElement;
  treeContextMenu: HTMLDivElement;
  loadingOverlay: HTMLDivElement;
  treeTray: HTMLDivElement;
  treePanel: HTMLDivElement;
  treeContent: HTMLDivElement;
  treeFilterOverlay: HTMLDivElement;
  treeFilter: HTMLInputElement;
  treeFilterClearBtn: HTMLButtonElement;
  treeArrow: HTMLSpanElement;
  treeSpinner: HTMLSpanElement;
  wrapTimer: number | null;
  loadingTimer: number | null;
}

class App {
  // Injected platform dependencies (backend factory, host services, hljs CSS).
  private readonly deps: AppDeps;
  constructor(deps: AppDeps) {
    this.deps = deps;
    this.themes = deps.themes;
    for (const t of this.themes) this.themesById.set(t.id, t);
  }

  // Backend / model state
  private backend: Backend | null = null;
  private commits: FileHistory[] = [];
  // When the working tree differs from HEAD a synthetic "uncommitted changes"
  // revision (hexSha === MODIFIED_SENTINEL) is appended to `commits`. This flags
  // its presence; `modifiedBaseHex` is the last real commit it diffs against.
  private hasModifiedRev = false;
  private modifiedBaseHex = "";
  private currentIndex = -1;
  private lineInfos: LineInfo[] = [];
  private rows: Row[] = [];
  private commitRevisions = new Map<string, number>();

  // "commitHex:originLine" -> last 0-based revision index where that specific
  // physical line still appears in blame. Keyed per line (not per commit)
  // because one commit can introduce lines in several disjoint places that get
  // deleted at different revisions; keying on commit alone would extend a
  // deleted chunk's bar to a surviving sibling chunk's end. A line present at
  // the viewed revision may be deleted in a LATER revision; its lifetime bar
  // must end there, not at the end of history. Built once after precache (blame
  // for all revisions is cached) by scanning backward from the last revision.
  // Empty until built; lifetimeBar falls back to the last real index for any
  // line not present.
  private lifetimeEndMap = new Map<string, number>();

  private lifetimeKey(commitHex: string, originLine: number): string {
    return `${commitHex}:${originLine}`;
  }

  // Range-diff coloring state. In "range" mode the slider splits into two
  // handles bounding a start/end revision; the code view shows the file at the
  // END revision, colored by the accumulated diff from START to END. Indices are
  // into `commits` but address real revisions only (the virtual M revision is
  // never a range endpoint). `rangeStart <= rangeEnd` is maintained by the
  // handle input clamps.
  private rangeStart = 0;
  private rangeEnd = 0;

  // View / theme
  // `dark` drives chrome/gutter/diff coloring; it is derived from the selected
  // theme's isDark flag, never set independently.
  private dark = false;
  private themeId: string = DEFAULT_LIGHT_THEME_ID;
  private themes: HljsTheme[] = [];
  private themesById = new Map<string, HljsTheme>();
  private coloring: ColoringMode = "diff";
  private gutterMode: GutterMode = "revision";
  private blameFormat = "full";
  private showDetails = true;
  private showBlame = true;
  private showLineno = true;
  private showLifetimes = false;
  private showSparseFiles = false;
  private showDeletedFiles = true;
  // Code-area font size in px (drives the --code-size CSS variable). Gutter
  // cell heights scale off it too via calc(var(--code-size) * 1.35).
  private fontSize = 14;
  private readonly FONT_MIN = 8;
  private readonly FONT_MAX = 24;
  private readonly FONT_DEFAULT = 14;
  // The blame/author column width (the only resizable part of the gutter). The
  // line-number column and the resize handle have fixed widths set in CSS.
  private gutterWidth = 120;
  private precacheWorkers: number | null = null;

  // Blame-transition tracking (mirrors _prev_coloring_mode). The user's real
  // gutter choice always lives in `gutterMode`; while blame coloring is active
  // the gutter is rendered as "author" without disturbing that stored choice.
  private prevColoring: ColoringMode = "diff";

  // Selection state. Three modes cycle as the user clicks a line:
  //   "chunk" - the clicked line's whole chunk is selected and followed across
  //             revisions (via translateLine/blame); highlights the chunk.
  //   "line"  - a single absolute line number is anchored and held across every
  //             revision regardless of content; highlights just that one row.
  //   "none"  - nothing selected; scrubbing keeps relative scroll position.
  // `stickyLineno` is the anchored line number in both "chunk" and "line" modes
  // (set to the clicked line when entering chunk mode, persisted into line mode).
  private selectionMode: "chunk" | "line" | "none" = "none";
  private selectedBlock: number | null = null;
  private selectedChunkStart: number | null = null;
  private selectedChunkEnd: number | null = null;
  private stickyLineno: number | null = null;
  // In "line" mode, the display-row index highlighted as the anchored line, so
  // the highlight can be re-applied as that row scrolls in/out of the window.
  private selectedLineBlock: number | null = null;

  // Precache
  private precaching = false;
  private lastKnownCommitHash = "";
  private lastKnownModifiedState = "";
  private lastFocusCheck = 0;
  private precacheRemaining = 0;
  private precacheWorkerCount = 0;
  private precacheToken = 0;

  private firstLoad = true;
  private loadingPrefs = false;
  private filePath = "";
  private searchMatchIndex = -1;
  // The currently highlighted search hit (row index), re-applied when the row
  // re-enters the virtual window during scrolling.
  private searchHitBlock: number | null = null;
  // Find is application-wide: the query and whether the bar is showing are
  // shared by every tab, while the matches are always the active tab's. Each
  // tab builds its own search widgets, so these two are the source of truth
  // and the per-tab elements are synchronised from them on activation.
  private searchQuery = "";
  private searchOpen = false;
  // History search is a Find mode that looks for the query in every revision
  // the scrubber offers. The mode is application-wide like the query; the
  // results and the tray belong to the tab's file (see HistorySearch).
  private historyMode = false;
  // Tray filter: list only matches a revision added, edited or removed.
  // Application-wide and persisted, like the other view toggles.
  private historyChangesOnly = false;
  private history!: HistorySearch;
  private historyTrayHeight = 200;
  // Caps on what one search keeps, newest revisions first; a common substring
  // in a long history can otherwise match millions of lines. Changes and
  // carried-over lines are capped separately so that carried-over lines,
  // which repeat in every revision, can never crowd out a change.
  private readonly HISTORY_MAX_CHANGES = 50000;
  private readonly HISTORY_MAX_UNCHANGED = 50000;
  // Minified or generated files can put a whole file on one line; show a window
  // around the match instead of the entire line.
  private readonly HISTORY_LINE_CLIP = 400;
  private readonly HISTORY_WORKERS = 8;

  // Virtual scrolling: only the rows within the viewport (plus a buffer) are in
  // the DOM at any time. `renderedStart`/`renderedEnd` bound the window of row
  // indices currently rendered (end is one-past-last). Code-line and gutter-cell
  // elements are absolutely positioned at `rowIndex * lineH()`, so DOM child N
  // maps to row `renderedStart + N`. The hljs cache keys on "revIndex:rowIndex"
  // so scrubbing back to a previously viewed revision re-renders instantly.
  private renderedStart = 0;
  private renderedEnd = 0;
  private hljsCache = new Map<string, string>();
  private scrollRafId = 0;
  private readonly RENDER_BUFFER = 50;
  private readonly HLJS_CACHE_MAX = 50000;

  // DOM refs
  private pathField!: HTMLInputElement;
  private modeToggle!: HTMLSelectElement;
  private browseBtn!: HTMLButtonElement;
  private repoFileLabel!: HTMLSpanElement;
  private slider!: HTMLInputElement;
  private mRevBtn!: HTMLButtonElement;
  // Dual-handle slider used only in "range" coloring mode. Two overlapping
  // range inputs (start/end) share the same min/max as the single slider; the
  // fill bar marks the span between the handles. Hidden unless range mode is on.
  private rangeWrap!: HTMLDivElement;
  private rangeStartInput!: HTMLInputElement;
  private rangeEndInput!: HTMLInputElement;
  private rangeFill!: HTMLDivElement;
  private rangeLabels!: HTMLDivElement;
  private sliderLabels!: HTMLDivElement;
  // Thin bar overlaying the slider track marking the span of revisions across
  // which the currently selected chunk stays in its present form (origin
  // revision to the last revision before it is next modified). Shown only in
  // chunk-anchor mode; hidden otherwise.
  private chunkHighlight!: HTMLDivElement;
  // Guards against overlapping async highlight computations (findNextModifier
  // awaits diffs): only the latest request applies its result.
  private chunkHighlightToken = 0;
  private prevRevBtn!: HTMLButtonElement;
  private nextRevBtn!: HTMLButtonElement;
  private revInput!: HTMLInputElement;
  private revDropdownBtn!: HTMLButtonElement;
  private revDropdownMenu!: HTMLDivElement;
  private revInputMode: "rev" | "commit" = "rev";
  private modeCombo!: HTMLSelectElement;
  private gutterCombo!: HTMLSelectElement;
  private lifetimesBtn!: HTMLButtonElement;
  private prevChunkBtn!: HTMLButtonElement;
  private nextChunkBtn!: HTMLButtonElement;
  private wrapIndicator!: HTMLSpanElement;
  private legendLabel!: HTMLSpanElement;
  private infoLabel!: HTMLDivElement;
  private searchRow!: HTMLDivElement;
  private searchField!: HTMLInputElement;
  private searchCount!: HTMLSpanElement;
  private codeArea!: HTMLDivElement;
  private gutter!: HTMLDivElement;
  private gutterHandle!: HTMLDivElement;
  private gutterAuthor!: HTMLDivElement;
  private gutterLifetime!: HTMLDivElement;
  private gutterLineno!: HTMLDivElement;
  private readonly LIFETIME_WIDTH = 70;
  // Horizontal breathing room inside the lifetime column so the dotted cursor
  // and bar ends at the first/last revision aren't clipped at the edges. All
  // bar/cursor geometry maps into [LIFETIME_PAD, WIDTH - LIFETIME_PAD].
  private readonly LIFETIME_PAD = 4;
  // Vertical gap (px) inset between adjacent chunk lifetime bars so a multi-line
  // chunk reads as one tall bar distinct from its neighbours.
  private readonly LIFETIME_GAP = 2;
  private codeLines!: HTMLDivElement;
  private detailSplitter!: HTMLDivElement;
  private prevDetail!: HTMLDivElement;
  private detailView!: HTMLDivElement;
  private statusMsg!: HTMLSpanElement;
  private themeCombo!: HTMLSelectElement;
  private hljsStyle!: HTMLStyleElement;
  private menuActions: Record<string, HTMLDivElement> = {};
  private codeContextMenu!: HTMLDivElement;
  private treeContextMenu!: HTMLDivElement;
  private treeContextTarget: HTMLElement | null = null;
  private loadingOverlay!: HTMLDivElement;
  private loadingTimer: number | null = null;

  private wrapTimer: number | null = null;

  private aboutModal!: HTMLDivElement;

  // Recently-opened list (most-recent-first, capped at 10), persisted per
  // platform. `recentDrop` is the submenu dropdown, repopulated whenever the
  // list changes.
  private recentFiles: Array<{ path: string; mode: "file" | "repo" }> = [];
  private recentDrop!: HTMLDivElement;
  private recentSubmenu!: HTMLDivElement;
  // Experimental ref switcher. "HEAD" means "follow the checked-out branch",
  // which is the behaviour everywhere else in the app. This field mirrors the
  // active tab's `viewRef`; it is saved and restored with the rest of the
  // per-tab state, so switching a ref in one tab leaves the others alone.
  private viewRef = "HEAD";
  // Autocomplete candidates, mirrored per tab like viewRef. Refreshed on the
  // same beat as the tree and file content, never when the dialog opens.
  private refList: { name: string; kind: "branch" | "tag" | "remote" }[] = [];
  private refSuggest!: HTMLDivElement;
  private refSuggestMatches: { name: string; kind: string }[] = [];
  private refSuggestIndex = -1;
  private refModal!: HTMLDivElement;
  private refInput!: HTMLInputElement;
  private refError!: HTMLDivElement;
  private refBanner!: HTMLDivElement;
  private readonly REF_BANNER_EMPTY = "No file or repository is being viewed";
  private readonly RECENT_MAX = 10;

  // File-browser tray (collapsible panel above the code area).
  private treeTray!: HTMLDivElement;
  private treePanel!: HTMLDivElement;
  private treeContent!: HTMLDivElement;
  // Flat filter results are rendered here, laid over `treeContent` while a filter
  // is active. The underlying tree DOM is left untouched so clearing the filter
  // reveals it exactly as the user left it (same expansion, same scroll).
  private treeFilterOverlay!: HTMLDivElement;
  private treeFilter!: HTMLInputElement;
  private treeFilterClearBtn!: HTMLButtonElement;
  // Scroll position of the tree panel captured when a filter first takes over, so
  // clearing the filter can put the (untouched) tree back where the user left it.
  private treePreFilterScrollTop = 0;
  private treeArrow!: HTMLSpanElement;
  private treeSpinner!: HTMLSpanElement;
  // Count of in-flight async tree operations (directory loads, background info
  // fetches, full-file-list warm-up). The header spinner is visible whenever
  // this is > 0 and hidden when everything expected has loaded.
  private treeLoadingCount = 0;
  private treePanelHeight = 300;
  private treeExpanded = false;
  private treeLoaded = false;
  private treeSelected: HTMLElement | null = null;
  // Files with uncommitted changes, fetched once per tree open and reused to
  // mark file rows as modified as directories are lazily expanded.
  private treeModifiedFiles = new Set<string>();
  // All tracked HEAD paths, fetched lazily the first time the user filters.
  // Cached so repeated keystrokes don't re-run `ls-tree -r`. In a large repo
  // this is expensive, so it is never fetched during the initial tree render,
  // only when the user starts filtering.
  private treeAllFiles: string[] | null = null;
  // All sparse (skip-worktree) paths, fetched lazily alongside `treeAllFiles` the
  // first time the user filters. Folded into the search set only when
  // `showSparseFiles` is on, so sparse files are searchable even in unexpanded
  // directories. Kept separate from `treeAllFiles` so toggling the option needs
  // no refetch. `listAllFiles` drops `S`-tagged entries, so these never overlap.
  private treeSparseFiles: string[] | null = null;
  // Whether the background full-file-list fetch is currently in flight, so the
  // filter can show a "loading" hint instead of a false "no matches".
  private treeAllFilesLoading = false;
  // Separate generation token for the background full-file-list warm-up. Bumped
  // only by tree-lifecycle events (re-populate, repo swap, tree clear), NOT by
  // a plain file open. This lets an in-flight `listAllFiles()` complete and apply
  // its result even if the user opens a file while it is running, while still
  // being discarded when the tree itself is torn down.
  private treeAllFilesToken = 0;
  private treeDirCache = new Map<string, { deleted: string[]; deletedDirs: string[]; counts: Map<string, number> }>();
  // Token to abort in-flight lazy loads when the tree is re-populated (a new
  // file or a Browse pick swaps the backend out from under pending fetches).
  private treeLoadToken = 0;
  // Repo the tree is showing. Normally derived from the loaded file, but the
  // "Browse..." button can point the tree at a repo before any file is loaded:
  // `treeBackend` then lists files independently of the main `backend`, and
  // `treeRepoRoot` (absolute, forward slashes) anchors relative paths so a
  // double-clicked entry can be opened.
  private treeBackend: Backend | null = null;
  private treeRepoRoot = "";
  // Backends for expanded submodules, keyed by the submodule's repo-relative
  // path (e.g. "libs/mylib"). Each runs git inside that submodule's own repo so
  // listing/opening its contents uses the submodule as the repo root. Populated
  // lazily on first expansion and cleared with the rest of the tree state.
  private treeSubmoduleBackends = new Map<string, Backend>();
  // Full HEAD file lists for expanded submodules, keyed by the submodule's
  // repo-relative path, with entries already prefixed by that path (so they are
  // main-repo-relative like the rest of the tree). Fetched lazily the first time
  // a filter needs them, so submodule contents are searchable even though the
  // main repo's `listAllFiles` never enumerates them. Cleared with the tree.
  private treeSubmoduleFiles = new Map<string, string[]>();
  // The tree node (by data-path) currently carrying the "(opened)" badge, so it
  // can be cleared when a different file loads. Empty when no tree node is marked.
  private treeOpenedPath = "";

  private tabs: TabState[] = [];
  private activeTabId = -1;
  private nextTabId = 0;
  private tabStrip!: HTMLDivElement;
  private tabContentArea!: HTMLDivElement;

  private followRenamesBtn!: HTMLButtonElement;
  private followRenamesActive = false;
  private renameSegments: RenameSegment[] = [];
  private renameDetected = false;
  private renameDetectionToken = 0;
  private currentPathCommits: FileHistory[] = [];
  private commitSegmentPath = new Map<string, string>();
  private segmentBoundaries: number[] = [];

  async init(): Promise<void> {
    this.buildDom();
    await this.loadPreferences();
    await this.autoMatchIdeTheme();
    this.applyTheme();
    this.setStatus("Open a file to begin.");
    // Optional deep link: ?file=<absolute path> opens that file on startup.
    const initial = new URLSearchParams(location.search).get("file");
    if (initial) await this.loadFile(initial);
  }

  // =======================================================================
  // DOM construction
  // =======================================================================

  private buildDom(): void {
    const app = document.querySelector<HTMLDivElement>("#app")!;
    app.innerHTML = "";

    this.hljsStyle = el("style");
    document.head.appendChild(this.hljsStyle);

    const win = el("div", "window");
    win.appendChild(this.buildMenuBar());

    this.tabStrip = el("div", "tab-strip");
    win.appendChild(this.tabStrip);

    this.tabContentArea = el("div", "tab-content-area");
    win.appendChild(this.tabContentArea);

    app.appendChild(win);

    this.aboutModal = this.buildAboutModal();
    app.appendChild(this.aboutModal);

    this.refModal = this.buildRefModal();
    app.appendChild(this.refModal);

    this.createTab();

    this.bindGlobalKeys();
    this.bindFocusReload();
    this.updateChunkButtons();
  }

  private buildTabContent(): { bodyArea: HTMLDivElement; statusBar: HTMLDivElement } {
    const bodyArea = el("div", "body-area");
    bodyArea.appendChild(this.buildSelectorRow());
    bodyArea.appendChild(this.buildTreeTray());
    bodyArea.appendChild(this.buildRefBanner());
    bodyArea.appendChild(this.buildSliderRow());
    bodyArea.appendChild(this.buildModeRow());
    bodyArea.appendChild(this.buildInfoBar());
    // Built before the Find bar, which hosts two of its controls.
    this.history = this.buildHistorySearch();
    bodyArea.appendChild(this.buildSearchRow());
    bodyArea.appendChild(this.buildSplitter());
    bodyArea.appendChild(this.history.tray);

    const statusBar = this.buildStatusBar();

    return { bodyArea, statusBar };
  }

  private createTab(file?: string, ref?: string): void {
    if (this.activeTabId >= 0) {
      this.saveTabState();
      this.disambiguateTabLabels();
      const prev = this.tabs.find(t => t.id === this.activeTabId);
      if (prev) { prev.bodyArea.remove(); prev.statusBar.remove(); }
      this.activeTabId = -1;
    }
    const { bodyArea, statusBar } = this.buildTabContent();
    const id = this.nextTabId++;
    const tab: TabState = {
      id,
      label: "New Tab",
      bodyArea,
      statusBar,
      backend: null,
      commits: [],
      hasModifiedRev: false,
      modifiedBaseHex: "",
      currentIndex: -1,
      lineInfos: [],
      rows: [],
      commitRevisions: new Map(),
      lifetimeEndMap: new Map(),
      rangeStart: 0,
      rangeEnd: 0,
      selectionMode: "none",
      selectedBlock: null,
      selectedChunkStart: null,
      selectedChunkEnd: null,
      stickyLineno: null,
      selectedLineBlock: null,
      precaching: false,
      lastKnownCommitHash: "",
      lastKnownModifiedState: "",
      precacheRemaining: 0,
      precacheWorkerCount: 0,
      precacheToken: 0,
      firstLoad: true,
      filePath: "",
      searchMatchIndex: -1,
      searchHitBlock: null,
      renderedStart: 0,
      renderedEnd: 0,
      hljsCache: new Map(),
      scrollRafId: 0,
      chunkHighlightToken: 0,
      revInputMode: "rev",
      followRenamesActive: false,
      renameSegments: [],
      renameDetected: false,
      renameDetectionToken: 0,
      currentPathCommits: [],
      commitSegmentPath: new Map(),
      segmentBoundaries: [],
      coloring: this.coloring,
      gutterMode: this.gutterMode,
      showDetails: this.showDetails,
      showBlame: this.showBlame,
      showLineno: this.showLineno,
      showLifetimes: this.showLifetimes,
      prevColoring: this.prevColoring,
      treeBackend: null,
      treeRepoRoot: "",
      viewRef: ref ?? "HEAD",
      refList: [],
      treeExpanded: false,
      treeLoaded: false,
      treeOpenedPath: "",
      treeModifiedFiles: new Set(),
      treeAllFiles: null,
      treeSparseFiles: null,
      treeAllFilesLoading: false,
      treeAllFilesToken: 0,
      treeDirCache: new Map(),
      treeLoadToken: 0,
      treeSubmoduleBackends: new Map(),
      treeSubmoduleFiles: new Map(),
      treeSelected: null,
      treePreFilterScrollTop: 0,
      treeLoadingCount: 0,
      treePanelHeight: this.treePanelHeight,
      scrollTop: 0,
      scrollLeft: 0,
      pathField: this.pathField,
      modeToggle: this.modeToggle,
      browseBtn: this.browseBtn,
      repoFileLabel: this.repoFileLabel,
      slider: this.slider,
      refBanner: this.refBanner,
      mRevBtn: this.mRevBtn,
      rangeWrap: this.rangeWrap,
      rangeStartInput: this.rangeStartInput,
      rangeEndInput: this.rangeEndInput,
      rangeFill: this.rangeFill,
      rangeLabels: this.rangeLabels,
      sliderLabels: this.sliderLabels,
      chunkHighlight: this.chunkHighlight,
      prevRevBtn: this.prevRevBtn,
      nextRevBtn: this.nextRevBtn,
      revInput: this.revInput,
      revDropdownBtn: this.revDropdownBtn,
      revDropdownMenu: this.revDropdownMenu,
      modeCombo: this.modeCombo,
      gutterCombo: this.gutterCombo,
      lifetimesBtn: this.lifetimesBtn,
      followRenamesBtn: this.followRenamesBtn,
      prevChunkBtn: this.prevChunkBtn,
      nextChunkBtn: this.nextChunkBtn,
      wrapIndicator: this.wrapIndicator,
      legendLabel: this.legendLabel,
      infoLabel: this.infoLabel,
      searchRow: this.searchRow,
      searchField: this.searchField,
      searchCount: this.searchCount,
      history: this.history,
      codeArea: this.codeArea,
      gutter: this.gutter,
      gutterHandle: this.gutterHandle,
      gutterAuthor: this.gutterAuthor,
      gutterLifetime: this.gutterLifetime,
      gutterLineno: this.gutterLineno,
      codeLines: this.codeLines,
      detailSplitter: this.detailSplitter,
      prevDetail: this.prevDetail,
      detailView: this.detailView,
      statusMsg: this.statusMsg,
      codeContextMenu: this.codeContextMenu,
      treeContextMenu: this.treeContextMenu,
      loadingOverlay: this.loadingOverlay,
      treeTray: this.treeTray,
      treePanel: this.treePanel,
      treeContent: this.treeContent,
      treeFilterOverlay: this.treeFilterOverlay,
      treeFilter: this.treeFilter,
      treeFilterClearBtn: this.treeFilterClearBtn,
      treeArrow: this.treeArrow,
      treeSpinner: this.treeSpinner,
      wrapTimer: this.wrapTimer,
      loadingTimer: this.loadingTimer,
    };
    this.tabs.push(tab);
    this.switchTab(id);
    this.rebuildTabStrip();
    if (file) void this.loadFile(file);
  }

  private switchTab(id: number): void {
    const target = this.tabs.find(t => t.id === id);
    if (!target) return;

    if (this.activeTabId >= 0) {
      this.saveTabState();
      const current = this.tabs.find(t => t.id === this.activeTabId);
      if (current) {
        current.bodyArea.remove();
        current.statusBar.remove();
      }
    }

    this.activeTabId = id;
    this.tabContentArea.appendChild(target.bodyArea);
    this.tabContentArea.appendChild(target.statusBar);
    this.restoreTabState(target);
    this.lastFocusCheck = Date.now();
    this.rebuildTabStrip();
  }

  private saveTabState(): void {
    const tab = this.tabs.find(t => t.id === this.activeTabId);
    if (!tab) return;
    tab.backend = this.backend;
    tab.commits = this.commits;
    tab.hasModifiedRev = this.hasModifiedRev;
    tab.modifiedBaseHex = this.modifiedBaseHex;
    tab.currentIndex = this.currentIndex;
    tab.lineInfos = this.lineInfos;
    tab.rows = this.rows;
    tab.commitRevisions = this.commitRevisions;
    tab.lifetimeEndMap = this.lifetimeEndMap;
    tab.rangeStart = this.rangeStart;
    tab.rangeEnd = this.rangeEnd;
    tab.selectionMode = this.selectionMode;
    tab.selectedBlock = this.selectedBlock;
    tab.selectedChunkStart = this.selectedChunkStart;
    tab.selectedChunkEnd = this.selectedChunkEnd;
    tab.stickyLineno = this.stickyLineno;
    tab.selectedLineBlock = this.selectedLineBlock;
    tab.precaching = this.precaching;
    tab.lastKnownCommitHash = this.lastKnownCommitHash;
    tab.lastKnownModifiedState = this.lastKnownModifiedState;
    tab.precacheRemaining = this.precacheRemaining;
    tab.precacheWorkerCount = this.precacheWorkerCount;
    tab.precacheToken = this.precacheToken;
    tab.firstLoad = this.firstLoad;
    tab.filePath = this.filePath;
    tab.searchMatchIndex = this.searchMatchIndex;
    tab.searchHitBlock = this.searchHitBlock;
    tab.renderedStart = this.renderedStart;
    tab.renderedEnd = this.renderedEnd;
    tab.hljsCache = this.hljsCache;
    tab.scrollRafId = this.scrollRafId;
    tab.chunkHighlightToken = this.chunkHighlightToken;
    tab.revInputMode = this.revInputMode;
    tab.followRenamesActive = this.followRenamesActive;
    tab.renameSegments = this.renameSegments;
    tab.renameDetected = this.renameDetected;
    tab.renameDetectionToken = this.renameDetectionToken;
    tab.currentPathCommits = this.currentPathCommits;
    tab.commitSegmentPath = this.commitSegmentPath;
    tab.segmentBoundaries = this.segmentBoundaries;
    tab.coloring = this.coloring;
    tab.gutterMode = this.gutterMode;
    tab.showDetails = this.showDetails;
    tab.showBlame = this.showBlame;
    tab.showLineno = this.showLineno;
    tab.showLifetimes = this.showLifetimes;
    tab.prevColoring = this.prevColoring;
    tab.treeBackend = this.treeBackend;
    tab.treeRepoRoot = this.treeRepoRoot;
    tab.viewRef = this.viewRef;
    tab.refList = this.refList;
    tab.treeExpanded = this.treeExpanded;
    tab.treeLoaded = this.treeLoaded;
    tab.treeOpenedPath = this.treeOpenedPath;
    tab.treeModifiedFiles = this.treeModifiedFiles;
    tab.treeAllFiles = this.treeAllFiles;
    tab.treeSparseFiles = this.treeSparseFiles;
    tab.treeAllFilesLoading = this.treeAllFilesLoading;
    tab.treeAllFilesToken = this.treeAllFilesToken;
    tab.treeDirCache = this.treeDirCache;
    tab.treeLoadToken = this.treeLoadToken;
    tab.treeSubmoduleBackends = this.treeSubmoduleBackends;
    tab.treeSubmoduleFiles = this.treeSubmoduleFiles;
    tab.treeSelected = this.treeSelected;
    tab.treePreFilterScrollTop = this.treePreFilterScrollTop;
    tab.treeLoadingCount = this.treeLoadingCount;
    tab.treePanelHeight = this.treePanelHeight;
    tab.scrollTop = this.codeArea.scrollTop;
    tab.scrollLeft = this.codeArea.scrollLeft;
    tab.pathField = this.pathField;
    tab.modeToggle = this.modeToggle;
    tab.browseBtn = this.browseBtn;
    tab.repoFileLabel = this.repoFileLabel;
    tab.slider = this.slider;
    tab.refBanner = this.refBanner;
    tab.mRevBtn = this.mRevBtn;
    tab.rangeWrap = this.rangeWrap;
    tab.rangeStartInput = this.rangeStartInput;
    tab.rangeEndInput = this.rangeEndInput;
    tab.rangeFill = this.rangeFill;
    tab.rangeLabels = this.rangeLabels;
    tab.sliderLabels = this.sliderLabels;
    tab.chunkHighlight = this.chunkHighlight;
    tab.prevRevBtn = this.prevRevBtn;
    tab.nextRevBtn = this.nextRevBtn;
    tab.revInput = this.revInput;
    tab.revDropdownBtn = this.revDropdownBtn;
    tab.revDropdownMenu = this.revDropdownMenu;
    tab.modeCombo = this.modeCombo;
    tab.gutterCombo = this.gutterCombo;
    tab.lifetimesBtn = this.lifetimesBtn;
    tab.followRenamesBtn = this.followRenamesBtn;
    tab.prevChunkBtn = this.prevChunkBtn;
    tab.nextChunkBtn = this.nextChunkBtn;
    tab.wrapIndicator = this.wrapIndicator;
    tab.legendLabel = this.legendLabel;
    tab.infoLabel = this.infoLabel;
    tab.searchRow = this.searchRow;
    tab.searchField = this.searchField;
    tab.searchCount = this.searchCount;
    tab.history = this.history;
    if (!this.history.tray.classList.contains("hidden")) {
      this.history.savedScroll = this.history.list.scrollTop;
    }
    tab.codeArea = this.codeArea;
    tab.gutter = this.gutter;
    tab.gutterHandle = this.gutterHandle;
    tab.gutterAuthor = this.gutterAuthor;
    tab.gutterLifetime = this.gutterLifetime;
    tab.gutterLineno = this.gutterLineno;
    tab.codeLines = this.codeLines;
    tab.detailSplitter = this.detailSplitter;
    tab.prevDetail = this.prevDetail;
    tab.detailView = this.detailView;
    tab.statusMsg = this.statusMsg;
    tab.codeContextMenu = this.codeContextMenu;
    tab.treeContextMenu = this.treeContextMenu;
    tab.loadingOverlay = this.loadingOverlay;
    tab.treeTray = this.treeTray;
    tab.treePanel = this.treePanel;
    tab.treeContent = this.treeContent;
    tab.treeFilterOverlay = this.treeFilterOverlay;
    tab.treeFilter = this.treeFilter;
    tab.treeFilterClearBtn = this.treeFilterClearBtn;
    tab.treeArrow = this.treeArrow;
    tab.treeSpinner = this.treeSpinner;
    tab.wrapTimer = this.wrapTimer;
    tab.loadingTimer = this.loadingTimer;
    tab.filePath = this.filePath;
  }

  private restoreTabState(tab: TabState): void {
    this.backend = tab.backend;
    this.commits = tab.commits;
    this.hasModifiedRev = tab.hasModifiedRev;
    this.modifiedBaseHex = tab.modifiedBaseHex;
    this.currentIndex = tab.currentIndex;
    this.lineInfos = tab.lineInfos;
    this.rows = tab.rows;
    this.commitRevisions = tab.commitRevisions;
    this.lifetimeEndMap = tab.lifetimeEndMap;
    this.rangeStart = tab.rangeStart;
    this.rangeEnd = tab.rangeEnd;
    this.selectionMode = tab.selectionMode;
    this.selectedBlock = tab.selectedBlock;
    this.selectedChunkStart = tab.selectedChunkStart;
    this.selectedChunkEnd = tab.selectedChunkEnd;
    this.stickyLineno = tab.stickyLineno;
    this.selectedLineBlock = tab.selectedLineBlock;
    this.precaching = tab.precaching;
    this.lastKnownCommitHash = tab.lastKnownCommitHash;
    this.lastKnownModifiedState = tab.lastKnownModifiedState;
    this.precacheRemaining = tab.precacheRemaining;
    this.precacheWorkerCount = tab.precacheWorkerCount;
    this.precacheToken = tab.precacheToken;
    this.firstLoad = tab.firstLoad;
    this.filePath = tab.filePath;
    this.searchMatchIndex = tab.searchMatchIndex;
    this.searchHitBlock = tab.searchHitBlock;
    this.renderedStart = tab.renderedStart;
    this.renderedEnd = tab.renderedEnd;
    this.hljsCache = tab.hljsCache;
    this.scrollRafId = tab.scrollRafId;
    this.chunkHighlightToken = tab.chunkHighlightToken;
    this.revInputMode = tab.revInputMode;
    this.followRenamesActive = tab.followRenamesActive;
    this.renameSegments = tab.renameSegments;
    this.renameDetected = tab.renameDetected;
    this.renameDetectionToken = tab.renameDetectionToken;
    this.currentPathCommits = tab.currentPathCommits;
    this.commitSegmentPath = tab.commitSegmentPath;
    this.segmentBoundaries = tab.segmentBoundaries;
    this.coloring = tab.coloring;
    this.gutterMode = tab.gutterMode;
    this.showDetails = tab.showDetails;
    this.showBlame = tab.showBlame;
    this.showLineno = tab.showLineno;
    this.showLifetimes = tab.showLifetimes;
    this.prevColoring = tab.prevColoring;
    this.treeBackend = tab.treeBackend;
    this.treeRepoRoot = tab.treeRepoRoot;
    this.viewRef = tab.viewRef;
    this.refList = tab.refList;
    this.treeExpanded = tab.treeExpanded;
    this.treeLoaded = tab.treeLoaded;
    this.treeOpenedPath = tab.treeOpenedPath;
    this.treeModifiedFiles = tab.treeModifiedFiles;
    this.treeAllFiles = tab.treeAllFiles;
    this.treeSparseFiles = tab.treeSparseFiles;
    this.treeAllFilesLoading = tab.treeAllFilesLoading;
    this.treeAllFilesToken = tab.treeAllFilesToken;
    this.treeDirCache = tab.treeDirCache;
    this.treeLoadToken = tab.treeLoadToken;
    this.treeSubmoduleBackends = tab.treeSubmoduleBackends;
    this.treeSubmoduleFiles = tab.treeSubmoduleFiles;
    this.treeSelected = tab.treeSelected;
    this.treePreFilterScrollTop = tab.treePreFilterScrollTop;
    this.treeLoadingCount = tab.treeLoadingCount;
    this.treePanelHeight = tab.treePanelHeight;
    this.pathField = tab.pathField;
    this.modeToggle = tab.modeToggle;
    this.browseBtn = tab.browseBtn;
    this.repoFileLabel = tab.repoFileLabel;
    this.slider = tab.slider;
    this.refBanner = tab.refBanner;
    // After the rebind, not before: refreshing earlier would write this tab's
    // label into the outgoing tab's (now detached) banner element.
    void this.refreshRefBanner();
    this.mRevBtn = tab.mRevBtn;
    this.rangeWrap = tab.rangeWrap;
    this.rangeStartInput = tab.rangeStartInput;
    this.rangeEndInput = tab.rangeEndInput;
    this.rangeFill = tab.rangeFill;
    this.rangeLabels = tab.rangeLabels;
    this.sliderLabels = tab.sliderLabels;
    this.chunkHighlight = tab.chunkHighlight;
    this.prevRevBtn = tab.prevRevBtn;
    this.nextRevBtn = tab.nextRevBtn;
    this.revInput = tab.revInput;
    this.revDropdownBtn = tab.revDropdownBtn;
    this.revDropdownMenu = tab.revDropdownMenu;
    this.modeCombo = tab.modeCombo;
    this.gutterCombo = tab.gutterCombo;
    this.lifetimesBtn = tab.lifetimesBtn;
    this.followRenamesBtn = tab.followRenamesBtn;
    this.prevChunkBtn = tab.prevChunkBtn;
    this.nextChunkBtn = tab.nextChunkBtn;
    this.wrapIndicator = tab.wrapIndicator;
    this.legendLabel = tab.legendLabel;
    this.infoLabel = tab.infoLabel;
    this.searchRow = tab.searchRow;
    this.searchField = tab.searchField;
    this.searchCount = tab.searchCount;
    this.history = tab.history;
    this.codeArea = tab.codeArea;
    this.gutter = tab.gutter;
    this.gutterHandle = tab.gutterHandle;
    this.gutterAuthor = tab.gutterAuthor;
    this.gutterLifetime = tab.gutterLifetime;
    this.gutterLineno = tab.gutterLineno;
    this.codeLines = tab.codeLines;
    this.detailSplitter = tab.detailSplitter;
    this.prevDetail = tab.prevDetail;
    this.detailView = tab.detailView;
    this.statusMsg = tab.statusMsg;
    this.codeContextMenu = tab.codeContextMenu;
    this.treeContextMenu = tab.treeContextMenu;
    this.loadingOverlay = tab.loadingOverlay;
    this.treeTray = tab.treeTray;
    this.treePanel = tab.treePanel;
    this.treeContent = tab.treeContent;
    this.treeFilterOverlay = tab.treeFilterOverlay;
    this.treeFilter = tab.treeFilter;
    this.treeFilterClearBtn = tab.treeFilterClearBtn;
    this.treeArrow = tab.treeArrow;
    this.treeSpinner = tab.treeSpinner;
    this.wrapTimer = tab.wrapTimer;
    this.loadingTimer = tab.loadingTimer;
    this.codeArea.scrollTop = tab.scrollTop;
    this.codeArea.scrollLeft = tab.scrollLeft;

    // Find is application-wide, so this tab's own widgets may be carrying a
    // stale query, visibility or match count from whenever it was last active.
    // Nothing else re-renders on activation -- a tab's DOM stays live while
    // detached -- so they have to be brought up to date here.
    this.searchField.value = this.searchQuery;
    this.searchRow.classList.toggle("hidden", this.searchOpen === false);
    if (this.searchOpen && this.searchQuery) this.updateSearchCount();
    else this.searchCount.textContent = "";
    this.syncHistoryUi();
  }

  private closeTab(id: number): void {
    if (this.tabs.length <= 1) return;
    const idx = this.tabs.findIndex(t => t.id === id);
    if (idx < 0) return;
    const tab = this.tabs[idx];
    tab.bodyArea.remove();
    tab.statusBar.remove();
    // A history search still running for this tab has nowhere left to show.
    tab.history.token++;
    this.tabs.splice(idx, 1);
    if (this.activeTabId === id) {
      const next = this.tabs[Math.min(idx, this.tabs.length - 1)];
      this.switchTab(next.id);
    }
    this.rebuildTabStrip();
  }

  private rebuildTabStrip(): void {
    this.tabStrip.innerHTML = "";

    const leftBtn = el("button", "tab-scroll-btn");
    leftBtn.innerHTML = '<svg width="10" height="10" viewBox="0 0 10 10"><polygon points="2,5 8,1 8,9" fill="currentColor"/></svg>';
    this.tabStrip.appendChild(leftBtn);

    const scrollArea = el("div", "tab-scroll-area");

    for (const tab of this.tabs) {
      const tabEl = el("div", tab.id === this.activeTabId ? "tab active" : "tab");
      const fp = tab.id === this.activeTabId ? this.filePath : tab.filePath;
      tabEl.title = fp || "New Tab";
      const label = el("span", "tab-label", tab.label);
      tabEl.appendChild(label);
      tabEl.addEventListener("click", (e) => {
        if ((e.target as HTMLElement).closest(".tab-close")) return;
        this.switchTab(tab.id);
      });
      if (this.tabs.length > 1) {
        const close = el("button", "tab-close", "×");
        close.addEventListener("click", (e) => {
          e.stopPropagation();
          this.closeTab(tab.id);
        });
        tabEl.appendChild(close);
      }
      scrollArea.appendChild(tabEl);
    }
    const addBtn = el("button", "tab-add", "+");
    addBtn.title = "New Tab";
    addBtn.addEventListener("click", () => this.createTab());
    scrollArea.appendChild(addBtn);

    this.tabStrip.appendChild(scrollArea);

    const rightBtn = el("button", "tab-scroll-btn");
    rightBtn.innerHTML = '<svg width="10" height="10" viewBox="0 0 10 10"><polygon points="8,5 2,1 2,9" fill="currentColor"/></svg>';
    this.tabStrip.appendChild(rightBtn);

    const scrollToTab = (dir: -1 | 1) => {
      const tabs = scrollArea.querySelectorAll<HTMLElement>(".tab");
      const sl = scrollArea.scrollLeft;
      const vw = scrollArea.clientWidth;
      if (dir === 1) {
        for (let i = 0; i < tabs.length; i++) {
          const t = tabs[i];
          if (t.offsetLeft + t.offsetWidth > sl + vw + 1) {
            scrollArea.scrollTo({ left: t.offsetLeft, behavior: "smooth" });
            return;
          }
        }
      } else {
        for (let i = tabs.length - 1; i >= 0; i--) {
          if (tabs[i].offsetLeft < sl - 1) {
            scrollArea.scrollTo({ left: tabs[i].offsetLeft - vw + tabs[i].offsetWidth, behavior: "smooth" });
            return;
          }
        }
      }
    };
    leftBtn.addEventListener("click", () => scrollToTab(-1));
    rightBtn.addEventListener("click", () => scrollToTab(1));

    const checkOverflow = () => {
      this.tabStrip.classList.toggle("overflowing", scrollArea.scrollWidth > scrollArea.clientWidth);
    };
    checkOverflow();
    new ResizeObserver(checkOverflow).observe(scrollArea);

    const activeEl = scrollArea.querySelector<HTMLElement>(".tab.active");
    if (activeEl) activeEl.scrollIntoView({ block: "nearest", inline: "nearest" });
  }

  private updateTabLabel(): void {
    this.disambiguateTabLabels();
    this.rebuildTabStrip();
  }

  private tabLabel(tab: TabState): string {
    const fp = tab.id === this.activeTabId ? this.filePath : tab.filePath;
    const repoRoot = tab.id === this.activeTabId ? this.treeRepoRoot : tab.treeRepoRoot;
    const mode = tab.id === this.activeTabId ? this.modeToggle.value : tab.modeToggle.value;
    if (!fp && !repoRoot) return "New Tab";
    if (mode === "repo" && repoRoot) {
      const repoName = basename(repoRoot.replace(/\/+$/, ""));
      if (fp) return `(R) ${repoName} | (F) ${basename(fp)}`;
      return `(R) ${repoName}`;
    }
    if (fp) return `(F) ${basename(fp)}`;
    return "New Tab";
  }

  private disambiguateTabLabels(): void {
    for (const tab of this.tabs) {
      tab.label = this.tabLabel(tab);
    }
    for (let i = 0; i < this.tabs.length; i++) {
      const a = this.tabs[i];
      if (!a.label || a.label === "New Tab") continue;
      const dupes = this.tabs.filter(t => t.label === a.label && t.id !== a.id);
      if (dupes.length === 0) continue;
      for (const t of [a, ...dupes]) {
        const fp = t.id === this.activeTabId ? this.filePath : t.filePath;
        if (!fp) continue;
        const parts = fp.replace(/\\/g, "/").split("/");
        if (parts.length >= 2) {
          const short = parts.slice(-2).join("/");
          t.label = t.label.replace(basename(fp), short);
        }
      }
    }
  }

  private buildMenuBar(): HTMLDivElement {
    const bar = el("div", "menu-bar");

    const makeItem = (
      label: string,
      opts: { shortcut?: string; checkable?: boolean; onClick?: () => void } = {},
    ): HTMLDivElement => {
      const item = el("div", "menu-item");
      if (opts.checkable) item.classList.add("checkable");
      item.appendChild(document.createTextNode(label));
      if (opts.shortcut) item.appendChild(el("span", "shortcut", opts.shortcut));
      if (opts.onClick) {
        item.addEventListener("click", (e) => {
          e.stopPropagation();
          if (item.classList.contains("disabled")) return;
          opts.onClick!();
          this.closeMenus();
        });
      }
      return item;
    };

    // File menu
    const fileMenu = el("div", "menu");
    fileMenu.appendChild(el("div", "menu-title", "File"));
    const fileDrop = el("div", "menu-dropdown");
    fileDrop.appendChild(
      makeItem("Open File...", { shortcut: "Ctrl+O", onClick: () => this.onMenuOpenFile() }),
    );
    fileDrop.appendChild(
      makeItem("Open File in New Tab...", { shortcut: "Ctrl+Shift+O", onClick: () => this.onMenuOpenFileInNewTab() }),
    );
    fileDrop.appendChild(
      makeItem("Open Repo...", { shortcut: "Ctrl+R", onClick: () => this.onMenuOpenRepo() }),
    );
    fileDrop.appendChild(
      makeItem("Open Repo in New Tab...", { shortcut: "Ctrl+Shift+R", onClick: () => this.onMenuOpenRepoInNewTab() }),
    );

    const recentSub = el("div", "menu-item submenu submenu-title");
    recentSub.appendChild(document.createTextNode("Recently Opened"));
    this.recentDrop = el("div", "submenu-dropdown");
    recentSub.appendChild(this.recentDrop);
    this.recentSubmenu = recentSub;
    fileDrop.appendChild(recentSub);
    this.rebuildRecentMenu();

    fileDrop.appendChild(el("div", "menu-separator"));
    fileDrop.appendChild(
      makeItem("New Tab", { shortcut: "Ctrl+T", onClick: () => this.createTab() }),
    );
    fileDrop.appendChild(
      makeItem("Close Tab", { shortcut: "Ctrl+W", onClick: () => this.closeTab(this.activeTabId) }),
    );

    fileDrop.appendChild(el("div", "menu-separator"));
    fileDrop.appendChild(
      makeItem("Quit", { shortcut: "Ctrl+Q", onClick: () => void this.deps.host.close() }),
    );
    fileMenu.appendChild(fileDrop);
    bar.appendChild(fileMenu);

    // Search menu
    const searchMenu = el("div", "menu");
    searchMenu.appendChild(el("div", "menu-title", "Search"));
    const searchDrop = el("div", "menu-dropdown");
    searchDrop.appendChild(
      makeItem("Find", { shortcut: "Ctrl+F", onClick: () => this.openSearch() }),
    );
    this.menuActions.findNext = makeItem("Find Next", { shortcut: "F3", onClick: () => this.findAgain(true) });
    this.menuActions.findPrev = makeItem("Find Previous", { shortcut: "Shift+F3", onClick: () => this.findAgain(false) });
    searchDrop.appendChild(this.menuActions.findNext);
    searchDrop.appendChild(this.menuActions.findPrev);
    searchDrop.appendChild(el("div", "menu-separator"));
    this.menuActions.history = makeItem("Find in History", {
      checkable: true,
      shortcut: this.deps.host.isVSCode ? undefined : "Ctrl+Shift+F",
      onClick: () => this.toggleHistoryMode(),
    });
    searchDrop.appendChild(this.menuActions.history);
    searchMenu.appendChild(searchDrop);
    bar.appendChild(searchMenu);

    // Options menu
    const optMenu = el("div", "menu");
    optMenu.appendChild(el("div", "menu-title", "Options"));
    const optDrop = el("div", "menu-dropdown");
    this.menuActions.details = makeItem("Show Commit Details", {
      checkable: true,
      onClick: () => this.toggleDetails(),
    });
    this.menuActions.blame = makeItem("Show Blame Gutter", {
      checkable: true,
      onClick: () => this.toggleBlameGutter(),
    });
    this.menuActions.lineno = makeItem("Show Line Numbers", {
      checkable: true,
      onClick: () => this.toggleLineno(),
    });
    this.menuActions.sparse = makeItem("Show Sparse Files", {
      checkable: true,
      onClick: () => this.toggleSparseFiles(),
    });
    this.menuActions.deleted = makeItem("Show Deleted Files", {
      checkable: true,
      onClick: () => this.toggleDeletedFiles(),
    });
    optDrop.appendChild(this.menuActions.details);
    optDrop.appendChild(this.menuActions.blame);
    optDrop.appendChild(this.menuActions.lineno);
    optDrop.appendChild(this.menuActions.sparse);
    optDrop.appendChild(this.menuActions.deleted);

    const submenu = el("div", "menu-item submenu submenu-title");
    submenu.appendChild(document.createTextNode("Blame Name Format"));
    const subDrop = el("div", "submenu-dropdown");
    for (const [label, fmt] of [
      ["First Last", "full"],
      ["First Name Only", "first"],
      ["Last Name Only", "last"],
      ["Email", "email"],
    ]) {
      const item = makeItem(label, { checkable: true, onClick: () => this.setBlameFormat(fmt) });
      this.menuActions[`fmt_${fmt}`] = item;
      subDrop.appendChild(item);
    }
    submenu.appendChild(subDrop);
    optDrop.appendChild(submenu);

    optDrop.appendChild(el("div", "menu-separator"));
    optDrop.appendChild(
      makeItem("Edit Preferences File...", { onClick: () => void this.onEditPreferences() }),
    );
    optMenu.appendChild(optDrop);
    bar.appendChild(optMenu);

    const helpMenu = el("div", "menu");
    helpMenu.appendChild(el("div", "menu-title", "Help"));
    const helpDrop = el("div", "menu-dropdown");
    helpDrop.appendChild(
      makeItem("About", { onClick: () => this.openAboutModal() }),
    );
    helpMenu.appendChild(helpDrop);
    bar.appendChild(helpMenu);

    for (const menu of [fileMenu, searchMenu, optMenu, helpMenu]) {
      const title = menu.querySelector<HTMLDivElement>(".menu-title")!;
      title.addEventListener("click", (e) => {
        e.stopPropagation();
        const isOpen = menu.classList.contains("open");
        this.closeMenus();
        if (!isOpen) menu.classList.add("open");
      });
      title.addEventListener("mouseenter", () => {
        if (document.querySelector(".menu.open")) {
          this.closeMenus();
          menu.classList.add("open");
        }
      });
    }
    document.addEventListener("click", () => this.closeMenus());
    return bar;
  }

  private closeMenus(): void {
    document.querySelectorAll(".menu.open").forEach((m) => m.classList.remove("open"));
  }

  private buildSelectorRow(): HTMLDivElement {
    const row = el("div", "row");

    this.modeToggle = el("select", "mode-toggle");
    this.modeToggle.title = "File Mode: open a single file. Repo Mode: browse the repository tree.";
    const fileOpt = el("option", undefined, "File");
    fileOpt.value = "file";
    const repoOpt = el("option", undefined, "Repo");
    repoOpt.value = "repo";
    this.modeToggle.appendChild(fileOpt);
    this.modeToggle.appendChild(repoOpt);
    row.appendChild(this.modeToggle);

    this.pathField = el("input");
    this.pathField.type = "text";
    this.pathField.placeholder = "Path to a file inside a git repository";
    this.pathField.addEventListener("keydown", (e) => {
      if (e.key === "Enter") void this.loadFile(this.pathField.value.trim(), false);
    });
    row.appendChild(this.pathField);

    this.repoFileLabel = el("span", "repo-file-label");
    row.appendChild(this.repoFileLabel);

    this.browseBtn = el("button", undefined, "Browse File...");
    this.browseBtn.addEventListener("click", () => {
      if (this.modeToggle.value === "repo") {
        void this.onRepoBrowse();
      } else {
        void this.onOpenClicked();
      }
    });
    row.appendChild(this.browseBtn);

    this.modeToggle.addEventListener("change", () => {
      const isRepo = this.modeToggle.value === "repo";
      this.browseBtn.textContent = isRepo ? "Browse Repo..." : "Browse File...";
      this.pathField.placeholder = isRepo
        ? "Path to a git repository"
        : "Path to a file inside a git repository";
      if (isRepo) {
        // Clear previous repo state and prompt for a new repo.
        this.treeBackend = null;
        this.treeRepoRoot = "";
        this.treeLoaded = false;
        this.treeAllFiles = null;
        this.cancelBackgroundAllFiles();
        this.resetTreeLoading();
        this.treeDirCache.clear();
        this.treeSubmoduleBackends.clear();
        this.treeSubmoduleFiles.clear();
        this.resetTreeFilterState();
        this.treeModifiedFiles = new Set();
        this.treeLoadToken++;
        this.treeOpenedPath = "";
        if (this.treeContent) this.treeContent.innerHTML = "";
        this.treeTray.classList.add("tree-disabled");
        this.pathField.value = "";
        this.repoFileLabel.textContent = "";
        this.pathField.classList.remove("repo-shrink");
        this.pathField.removeAttribute("size");
        void this.onRepoBrowse();
      } else {
        this.collapseTree();
        this.treeTray.classList.add("tree-disabled");
        this.repoFileLabel.textContent = "";
        this.pathField.classList.remove("repo-shrink");
        this.pathField.removeAttribute("size");
        if (this.filePath) this.pathField.value = this.filePath;
        void this.onOpenClicked();
      }
      this.savePreferences();
    });

    return row;
  }

  private buildSliderRow(): HTMLDivElement {
    const row = el("div", "row");
    const stack = el("div", "slider-stack");

    const wrap = el("div", "slider-wrap");
    this.slider = el("input", "rev-slider");
    this.slider.type = "range";
    this.slider.min = "0";
    this.slider.max = "0";
    this.slider.value = "0";
    this.slider.step = "1";
    this.slider.disabled = true;
    this.slider.addEventListener("wheel", (e) => e.preventDefault(), { passive: false });
    // Block the native Up/Down slider stepping and drive chunk navigation
    // instead, so Up/Down do the same thing whether or not the slider is
    // focused. (The global keydown handler skips inputs, so we act here.)
    // Left/Right keep their default revision-stepping behavior.
    this.slider.addEventListener("keydown", (e) => {
      if (e.key === "ArrowUp") { e.preventDefault(); this.onPrevChunk(); }
      else if (e.key === "ArrowDown") { e.preventDefault(); this.onNextChunk(); }
    });
    this.slider.addEventListener("input", () => {
      void this.showRevision(parseInt(this.slider.value, 10));
      this.updateNavButtons();
    });
    wrap.appendChild(this.slider);

    // Separate button for the virtual "M" (uncommitted changes) revision. The
    // slider only spans real revisions; M lives here so the native slider's
    // linear tick distribution stays aligned with the real-revision labels.
    this.mRevBtn = el("button", "m-rev-btn hidden", "M");
    this.mRevBtn.title = "Uncommitted changes";
    this.mRevBtn.addEventListener("click", () => {
      if (!this.hasModifiedRev) return;
      if (this.isModifiedRev(this.currentIndex)) {
        this.setRevision(this.lastRealIndex());
      } else {
        this.setRevision(this.commits.length - 1);
      }
    });
    wrap.appendChild(this.mRevBtn);

    stack.appendChild(wrap);

    this.sliderLabels = el("div", "slider-labels");
    // The chunk-lifetime bar aligns with the tick marks, so it lives inside the
    // labels container (same thumb-centered tick geometry) rather than over the
    // slider track.
    this.chunkHighlight = el("div", "slider-chunk-highlight hidden");
    this.sliderLabels.appendChild(this.chunkHighlight);
    stack.appendChild(this.sliderLabels);

    // Dual-handle slider for range mode. Two overlapping range inputs occupy
    // the same track; the fill bar between them is drawn from their values.
    // Hidden until range coloring is selected.
    this.rangeWrap = el("div", "range-slider-wrap hidden");
    this.rangeFill = el("div", "range-slider-fill");
    this.rangeWrap.appendChild(this.rangeFill);
    this.rangeStartInput = el("input", "range-handle range-start");
    this.rangeEndInput = el("input", "range-handle range-end");
    for (const inp of [this.rangeStartInput, this.rangeEndInput]) {
      inp.type = "range";
      inp.min = "0";
      inp.max = "0";
      inp.value = "0";
      inp.step = "1";
      inp.disabled = true;
      inp.addEventListener("wheel", (e) => e.preventDefault(), { passive: false });
    }
    this.rangeStartInput.addEventListener("input", () => this.onRangeInput("start"));
    this.rangeEndInput.addEventListener("input", () => this.onRangeInput("end"));
    this.rangeWrap.appendChild(this.rangeStartInput);
    this.rangeWrap.appendChild(this.rangeEndInput);
    stack.appendChild(this.rangeWrap);

    this.rangeLabels = el("div", "slider-labels range-labels hidden");
    stack.appendChild(this.rangeLabels);

    const nav = el("div", "nav-row");
    this.prevRevBtn = el("button", "icon-btn", "◄");
    this.prevRevBtn.title = "Previous revision (Left arrow)";
    this.prevRevBtn.disabled = true;
    this.prevRevBtn.addEventListener("click", () => this.stepRevision(-1));
    this.nextRevBtn = el("button", "icon-btn", "►");
    this.nextRevBtn.title = "Next revision (Right arrow)";
    this.nextRevBtn.disabled = true;
    this.nextRevBtn.addEventListener("click", () => this.stepRevision(1));

    // Direct-jump revision input between the arrows: shows the current 1-based
    // revision. Enter strips non-digits, parses an int, and clamps into range
    // (never errors), so "999" -> last, "0"/"-5" -> 1, "42.7" -> 42; empty or
    // entirely non-numeric reverts to the current revision.
    this.revInput = el("input", "rev-input");
    this.revInput.type = "text";
    this.revInput.title = "Current revision — type a number and press Enter to jump";
    this.revInput.disabled = true;
    this.revInput.addEventListener("keydown", (e) => {
      if (e.key !== "Enter") return;
      e.preventDefault();
      if (this.coloring === "range") {
        this.submitRangeInput();
      } else if (this.revInputMode === "commit") {
        this.submitCommitInput();
      } else {
        this.submitRevInput();
      }
    });

    // Mode dropdown: switch the field between revision numbers and 8-char
    // commit hashes. A custom popup (not a native <select>) sits inline on the
    // right edge of the input so it renders consistently across platforms.
    this.revDropdownBtn = el("button", "rev-dropdown-btn", "▾");
    this.revDropdownBtn.type = "button";
    this.revDropdownBtn.disabled = true;
    this.revDropdownBtn.title = "Interpret the field as a revision number or commit hash";
    this.revDropdownBtn.addEventListener("click", (e) => {
      e.stopPropagation();
      this.toggleRevDropdown();
    });

    this.revDropdownMenu = el("div", "rev-dropdown-menu");
    this.revDropdownMenu.hidden = true;
    for (const [label, val] of [
      ["Rev #", "rev"],
      ["Commit", "commit"],
    ] as const) {
      const item = el("div", "rev-dropdown-item", label);
      item.dataset.mode = val;
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        this.setRevInputMode(val);
        this.closeRevDropdown();
      });
      this.revDropdownMenu.appendChild(item);
    }

    // Any click outside the menu dismisses it.
    document.addEventListener("click", () => this.closeRevDropdown());

    // In commit mode, keep the field to at most the first 8 hash characters.
    this.revInput.addEventListener("input", () => {
      if (this.coloring === "range" || this.revInputMode !== "commit") return;
      const trimmed = this.revInput.value.trim().slice(0, 8);
      if (trimmed !== this.revInput.value) this.revInput.value = trimmed;
    });

    const revInputWrapper = el("div", "rev-input-wrapper");
    revInputWrapper.appendChild(this.revInput);
    revInputWrapper.appendChild(this.revDropdownBtn);
    revInputWrapper.appendChild(this.revDropdownMenu);

    nav.appendChild(this.prevRevBtn);
    nav.appendChild(revInputWrapper);
    nav.appendChild(this.nextRevBtn);
    stack.appendChild(nav);

    row.appendChild(stack);
    window.addEventListener("resize", () => {
      this.refreshSliderLabels();
      if (this.coloring === "range") this.refreshRangeLabels();
    });
    return row;
  }

  private toggleRevDropdown(): void {
    if (this.revDropdownBtn.disabled) return;
    if (this.revDropdownMenu.hidden) {
      this.syncRevDropdownActive();
      this.revDropdownMenu.hidden = false;
    } else {
      this.revDropdownMenu.hidden = true;
    }
  }

  private closeRevDropdown(): void {
    this.revDropdownMenu.hidden = true;
  }

  // Reflect the current mode as the bold "active" item in the popup.
  private syncRevDropdownActive(): void {
    for (const item of Array.from(this.revDropdownMenu.children) as HTMLElement[]) {
      item.classList.toggle("active", item.dataset.mode === this.revInputMode);
    }
  }

  private setRevInputMode(mode: "rev" | "commit"): void {
    this.revInputMode = mode;
    this.revInput.title =
      mode === "commit"
        ? "Current commit — paste an 8-char hash and press Enter to jump"
        : "Current revision — type a number and press Enter to jump";
    this.syncRevDropdownActive();
    this.syncRevInput();
  }

  // Handle Enter in "Rev #" mode. parseInt handles the requested cases directly:
  // "42.7" -> 42 (ignores the decimal), "-5" -> -5, "999" -> 999, "abc"/"" ->
  // NaN. Clamp valid numbers into range; revert on non-numeric input.
  private submitRevInput(): void {
    // "M"/"m" jumps to the virtual "uncommitted changes" revision when present.
    if (this.hasModifiedRev && this.revInput.value.trim().toLowerCase() === "m") {
      this.revInput.value = "M";
      this.setRevision(this.commits.length - 1);
      return;
    }
    const rev = parseInt(this.revInput.value, 10);
    if (isNaN(rev)) {
      this.revInput.value = this.isModifiedRev(this.currentIndex)
        ? "M"
        : String(this.currentIndex + 1); // revert
      return;
    }
    // Numeric input addresses real revisions only; M is reached by typing "M"
    // or clicking its button. Clamp to the last real revision.
    const realCount = this.hasModifiedRev ? this.commits.length - 1 : this.commits.length;
    const clamped = Math.max(1, Math.min(realCount, rev));
    // Reflect the clamped value in the field (the input keeps focus, so
    // updateNavButtons won't overwrite it), then jump.
    this.revInput.value = String(clamped);
    this.setRevision(clamped - 1); // 0-based
  }

  // Handle Enter in "Commit" mode: look up the entered 8-char hash in the
  // history and jump to it, or show an error when it doesn't match this file.
  private submitCommitInput(): void {
    const query = this.revInput.value.trim().slice(0, 8).toLowerCase();
    if (!query) {
      this.syncRevInput(); // revert to current
      return;
    }
    const index = this.commits.findIndex(
      (c) => !this.isModifiedRevSha(c.hexSha) && c.hexSha.slice(0, 8).toLowerCase() === query,
    );
    if (index === -1) {
      this.deps.host.showError("Commit hash not found in this file's history");
      this.syncRevInput(); // revert to current
      return;
    }
    this.setRevision(index);
    this.syncRevInput();
  }

  // Resolve a single range-endpoint token to a 0-based real revision index.
  // Accepts a 1-based revision number ("42") or, in commit mode, an 8-char
  // hash. Returns null when the token can't be resolved to a real revision.
  private resolveRangeToken(token: string): number | null {
    const t = token.trim();
    if (!t) return null;
    if (this.revInputMode === "commit") {
      const query = t.slice(0, 8).toLowerCase();
      const index = this.commits.findIndex(
        (c) => !this.isModifiedRevSha(c.hexSha) && c.hexSha.slice(0, 8).toLowerCase() === query,
      );
      return index === -1 || index > this.lastRealIndex() ? null : index;
    }
    const rev = parseInt(t, 10);
    if (isNaN(rev)) return null;
    const max = this.lastRealIndex();
    return Math.max(0, Math.min(max, rev - 1)); // 1-based -> 0-based, clamped
  }

  // Handle Enter in range mode: parse a typed "N — M" (em dash or hyphen)
  // range, update both handles, and re-render. Reverts on unparseable input.
  private submitRangeInput(): void {
    const raw = this.revInput.value;
    const parts = raw.split(/\s*(?:—|-)\s*/).filter((p) => p.trim().length > 0);
    if (parts.length !== 2) {
      this.deps.host.showError('Enter a range as "start — end" (e.g. 5 — 20)');
      this.syncRevInput(); // revert
      return;
    }
    const a = this.resolveRangeToken(parts[0]);
    const b = this.resolveRangeToken(parts[1]);
    if (a === null || b === null) {
      this.deps.host.showError(
        this.revInputMode === "commit"
          ? "One or both commit hashes not found in this file's history"
          : "Range values out of range",
      );
      this.syncRevInput(); // revert
      return;
    }
    this.rangeStart = Math.min(a, b);
    this.rangeEnd = Math.max(a, b);
    this.rangeStartInput.value = String(this.rangeStart);
    this.rangeEndInput.value = String(this.rangeEnd);
    this.layoutRangeFill();
    this.revInput.blur();
    this.syncRevInput();
    void this.showRange();
  }

  private isModifiedRevSha(hexSha: string): boolean {
    return this.hasModifiedRev && hexSha === MODIFIED_SENTINEL;
  }

  // Populate the revision input from the current index according to the active
  // mode. Skipped while the field has focus so the user's typing isn't clobbered.
  private syncRevInput(): void {
    if (document.activeElement === this.revInput) return;
    if (this.slider.disabled) {
      this.revInput.value = "";
      return;
    }
    if (this.coloring === "range") {
      this.revInput.value = `${this.rangeStart + 1} — ${this.rangeEnd + 1}`;
      return;
    }
    const cur = this.currentIndex;
    if (this.revInputMode === "commit") {
      this.revInput.value = this.isModifiedRev(cur)
        ? "M"
        : (this.commits[cur]?.hexSha.slice(0, 8) ?? "");
    } else {
      this.revInput.value = this.isModifiedRev(cur) ? "M" : String(cur + 1);
    }
  }

  private buildModeRow(): HTMLDivElement {
    const row = el("div", "row");
    row.appendChild(el("label", "field-label", "Coloring:"));
    this.modeCombo = el("select");
    for (const [label, val] of [
      ["None", "none"],
      ["Diff vs. previous", "diff"],
      ["Range Diff", "range"],
      ["Blame (by author)", "blame"],
      ["Age (older fades)", "age"],
    ]) {
      const opt = el("option", undefined, label);
      opt.value = val;
      this.modeCombo.appendChild(opt);
    }
    this.modeCombo.value = "diff";
    this.modeCombo.addEventListener("change", () => this.onModeChanged());
    row.appendChild(this.modeCombo);

    const gutterLabel = el("label", "field-label", "Gutter:");
    gutterLabel.style.marginLeft = "12px";
    row.appendChild(gutterLabel);
    this.gutterCombo = el("select");
    for (const [label, val] of [
      ["Revision", "revision"],
      ["Commit Hash", "hash"],
      ["Author", "author"],
      ["Date", "date"],
    ]) {
      const opt = el("option", undefined, label);
      opt.value = val;
      this.gutterCombo.appendChild(opt);
    }
    this.gutterCombo.value = "revision";
    this.gutterCombo.addEventListener("change", () => this.onGutterModeChanged());
    row.appendChild(this.gutterCombo);

    this.lifetimesBtn = el("button", "narrow-btn lifetimes-btn", "≣");
    this.lifetimesBtn.title = "Toggle chunk lifetimes column";
    this.lifetimesBtn.style.marginLeft = "6px";
    this.lifetimesBtn.addEventListener("click", () => this.onToggleLifetimes());
    row.appendChild(this.lifetimesBtn);

    this.followRenamesBtn = el("button", "narrow-btn follow-renames-btn");
    this.followRenamesBtn.title = "Follow renames/moves";
    this.followRenamesBtn.disabled = true;
    // Icon based on Google Material Symbols "rebase_edit" (Apache-2.0); see NOTICES.txt.
    this.followRenamesBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24"><path fill="currentColor" d="M10 22v-4.1l7.35-7.3q.3-.3.663-.45t.762-.15t.763.15t.662.45l1.225 1.25q.275.3.425.663t.15.737t-.162.738t-.438.662L14.1 22zm8.725-7.45L20 13.25L18.775 12l-1.3 1.3zm-7.975-5.3l-1.4-1.425L11.175 6h-3.35q-.225.65-.7 1.125T6 7.825v8.35q.875.325 1.438 1.088T8 19q0 1.25-.875 2.125T5 22t-2.125-.875T2 19q0-.975.563-1.725T4 16.2V7.825Q3.125 7.5 2.563 6.737T2 5q0-1.25.875-2.125T5 2q.975 0 1.738.563T7.825 4h3.35L9.35 2.175L10.75.75L15 5zm10.375-6.375Q22 3.75 22 5t-.875 2.125T19 8t-2.125-.875T16 5t.875-2.125T19 2t2.125.875"/></svg>';
    this.followRenamesBtn.addEventListener("click", () => void this.onToggleFollowRenames());
    row.appendChild(this.followRenamesBtn);

    row.appendChild(el("span", "spacer"));

    this.wrapIndicator = el("span", "wrap-indicator");
    this.wrapIndicator.style.display = "none";
    row.appendChild(this.wrapIndicator);

    this.prevChunkBtn = el("button", "narrow-btn", "▲");
    this.prevChunkBtn.title = "Previous changed chunk (Up arrow)";
    this.prevChunkBtn.addEventListener("click", () => this.onPrevChunk());
    row.appendChild(this.prevChunkBtn);
    this.nextChunkBtn = el("button", "narrow-btn", "▼");
    this.nextChunkBtn.title = "Next changed chunk (Down arrow)";
    this.nextChunkBtn.addEventListener("click", () => this.onNextChunk());
    row.appendChild(this.nextChunkBtn);

    this.legendLabel = el("span", "legend");
    this.legendLabel.style.marginLeft = "12px";
    row.appendChild(this.legendLabel);
    return row;
  }

  private buildInfoBar(): HTMLDivElement {
    this.infoLabel = el("div", "info-bar", "No file loaded.");
    return this.infoLabel;
  }

  private buildSearchRow(): HTMLDivElement {
    this.searchRow = el("div", "row search-row");
    this.searchRow.classList.toggle("hidden", this.searchOpen === false);
    this.searchRow.appendChild(el("label", "field-label", "Find:"));
    this.searchField = el("input");
    this.searchField.type = "text";
    this.searchField.placeholder = "Search...";
    // A tab opened while a search is active inherits the query rather than
    // starting blank.
    this.searchField.value = this.searchQuery;
    this.searchField.addEventListener("keydown", (e) => {
      // In history mode Enter (with or without Shift) is the Search button;
      // it must not fall through to stepping through the revision on screen.
      if (e.key === "Enter" && this.historyMode) void this.runHistorySearch(this.history);
      else if (e.key === "Enter") this.doSearch(!e.shiftKey);
      else if (e.key === "Escape") this.closeSearch();
    });
    this.searchField.addEventListener("input", () => this.setSearchQuery(this.searchField.value));
    this.searchRow.appendChild(this.searchField);
    this.searchRow.appendChild(this.history.searchBtn);

    const prev = el("button", "narrow-btn", "▲");
    prev.title = "Previous match";
    prev.addEventListener("click", () => this.doSearch(false));
    this.searchRow.appendChild(prev);
    const next = el("button", "narrow-btn", "▼");
    next.title = "Next match";
    next.addEventListener("click", () => this.doSearch(true));
    this.searchRow.appendChild(next);
    this.history.findNav = [prev, next];

    this.searchCount = el("span", "search-count");
    this.searchRow.appendChild(this.searchCount);
    this.searchRow.appendChild(this.history.toggleBtn);

    const close = el("button", "narrow-btn", "✕");
    close.title = "Close search";
    close.addEventListener("click", () => this.closeSearch());
    this.searchRow.appendChild(close);
    return this.searchRow;
  }

  private buildSplitter(): HTMLDivElement {
    const splitter = el("div", "v-splitter");

    this.codeArea = el("div", "code-area");
    const inner = el("div", "code-inner");
    this.gutter = el("div", "gutter");
    this.gutterAuthor = el("div", "gutter-author");
    this.gutterLifetime = el("div", "gutter-lifetime-col");
    this.gutterLineno = el("div", "gutter-lineno");
    // The resize handle sits between the author column and the line-number
    // column and controls only the author column's width. Line numbers keep
    // their fixed width, unaffected by the drag.
    this.gutterHandle = el("div", "gutter-resize-handle");
    this.makeGutterDrag(this.gutterHandle);
    this.gutter.appendChild(this.gutterAuthor);
    this.gutter.appendChild(this.gutterHandle);
    this.gutter.appendChild(this.gutterLifetime);
    this.gutter.appendChild(this.gutterLineno);
    this.codeLines = el("div", "code-lines");
    inner.appendChild(this.gutter);
    inner.appendChild(this.codeLines);
    this.loadingOverlay = el("div", "loading-overlay hidden");
    this.loadingOverlay.textContent = "Loading.";
    this.codeArea.appendChild(inner);
    this.codeArea.appendChild(this.loadingOverlay);
    this.codeLines.appendChild(el("div", "placeholder", "Open a file to begin."));
    this.applyGutterWidth();

    const onRowClick = (e: MouseEvent) => {
      const target = e.target as HTMLElement;
      const rowEl = target.closest<HTMLElement>("[data-block]");
      if (!rowEl) {
        this.clearLineSelection();
        return;
      }
      this.onLineClicked(parseInt(rowEl.dataset.block!, 10));
    };
    this.codeLines.addEventListener("click", onRowClick);
    this.gutterAuthor.addEventListener("click", onRowClick);
    this.gutterLifetime.addEventListener("click", onRowClick);
    this.gutterLineno.addEventListener("click", onRowClick);
    this.codeLines.addEventListener("dblclick", () => this.clearLineSelection());
    this.codeArea.addEventListener("contextmenu", (e) => {
      e.preventDefault();
      // Show a copy / select-all menu; keep any line/chunk selection intact.
      this.showCodeContextMenu(e.clientX, e.clientY);
    });

    // Virtual scroll: repaint the visible window (debounced to one paint per
    // animation frame) as the user scrolls, and when the viewport is resized.
    this.codeArea.addEventListener("scroll", () => {
      if (this.scrollRafId) cancelAnimationFrame(this.scrollRafId);
      this.scrollRafId = requestAnimationFrame(() => {
        this.scrollRafId = 0;
        this.renderWindow();
      });
    });
    new ResizeObserver(() => this.renderWindow()).observe(this.codeArea);

    splitter.appendChild(this.codeArea);

    const handle = el("div", "splitter-handle horizontal");
    this.makeVerticalDrag(handle);
    splitter.appendChild(handle);

    this.detailSplitter = el("div", "detail-splitter");
    this.prevDetail = el("div", "detail-pane hidden");
    this.detailView = el("div", "detail-pane");
    // Clicking a revision link (e.g. "Revision: 5") in either pane jumps there.
    for (const pane of [this.prevDetail, this.detailView]) {
      pane.addEventListener("click", (e) => this.onDetailPaneClick(e));
    }
    const detailHandle = el("div", "splitter-handle vertical");
    this.makeHorizontalDrag(detailHandle, this.prevDetail, this.detailView);
    this.detailSplitter.appendChild(this.prevDetail);
    this.detailSplitter.appendChild(detailHandle);
    this.detailSplitter.appendChild(this.detailView);
    this.setDetailPlaceholder();
    splitter.appendChild(this.detailSplitter);

    this.buildCodeContextMenu();
    this.buildTreeContextMenu();

    return splitter;
  }

  private buildCodeContextMenu(): void {
    this.codeContextMenu = el("div", "context-menu");
    this.codeContextMenu.style.display = "none";

    const copyItem = el("div", "context-menu-item", "Copy");
    copyItem.addEventListener("click", (e) => {
      e.stopPropagation();
      void this.copySelection();
      this.hideCodeContextMenu();
    });
    const selectAllItem = el("div", "context-menu-item", "Select All");
    selectAllItem.addEventListener("click", (e) => {
      e.stopPropagation();
      this.selectAllCode();
      this.hideCodeContextMenu();
    });
    this.codeContextMenu.appendChild(copyItem);
    this.codeContextMenu.appendChild(selectAllItem);
    document.body.appendChild(this.codeContextMenu);

    // Dismiss on any outside click or on Escape.
    document.addEventListener("click", () => this.hideCodeContextMenu());
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.hideCodeContextMenu();
    });
    // Right-clicking elsewhere closes an open code menu too.
    document.addEventListener("contextmenu", (e) => {
      if (!this.codeArea.contains(e.target as Node)) this.hideCodeContextMenu();
    });
  }

  private buildTreeContextMenu(): void {
    this.treeContextMenu = el("div", "context-menu");
    this.treeContextMenu.style.display = "none";

    const openItem = el("div", "context-menu-item", "Open");
    openItem.addEventListener("click", (e) => {
      e.stopPropagation();
      const target = this.treeContextTarget;
      this.hideTreeContextMenu();
      if (target) this.openTreeRow(target);
    });

    const openNewTabItem = el("div", "context-menu-item", "Open in New Tab");
    openNewTabItem.addEventListener("click", (e) => {
      e.stopPropagation();
      const target = this.treeContextTarget;
      this.hideTreeContextMenu();
      if (target) {
        const rel = target.dataset.path;
        if (rel) {
          const root = this.treeRepoRoot || (this.filePath ? dirname(this.filePath) : "");
          if (root) {
            const full = `${root}/${rel}`.replace(/\\/g, "/");
            if (this.filePath === full) return;
            const existing = this.tabs.find(
              t => t.id !== this.activeTabId && t.filePath === full && t.viewRef === this.viewRef,
            );
            if (existing) { this.switchTab(existing.id); }
            else this.createTab(full, this.viewRef);
          }
        }
      }
    });

    const copyPathItem = el("div", "context-menu-item", "Copy Path");
    copyPathItem.addEventListener("click", (e) => {
      e.stopPropagation();
      const target = this.treeContextTarget;
      this.hideTreeContextMenu();
      if (target) {
        const rel = target.dataset.path;
        if (rel) {
          const root = this.treeRepoRoot || (this.filePath ? dirname(this.filePath) : "");
          const abs = root ? `${root}/${rel}` : rel;
          void navigator.clipboard.writeText(abs);
        }
      }
    });

    this.treeContextMenu.appendChild(openItem);
    this.treeContextMenu.appendChild(openNewTabItem);
    this.treeContextMenu.appendChild(copyPathItem);
    document.body.appendChild(this.treeContextMenu);

    document.addEventListener("click", () => this.hideTreeContextMenu());
    document.addEventListener("keydown", (e) => {
      if (e.key === "Escape") this.hideTreeContextMenu();
    });
  }

  private showTreeContextMenu(x: number, y: number, isDir: boolean): void {
    const menu = this.treeContextMenu;
    const items = menu.querySelectorAll<HTMLElement>(".context-menu-item");
    items.forEach((item) => {
      const text = item.textContent ?? "";
      if (text === "Open" || text === "Open in New Tab") {
        item.style.display = isDir ? "none" : "";
      }
    });
    menu.style.display = "block";
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    const left = Math.min(x, window.innerWidth - mw - 4);
    const top = Math.min(y, window.innerHeight - mh - 4);
    menu.style.left = `${Math.max(0, left)}px`;
    menu.style.top = `${Math.max(0, top)}px`;
  }

  private hideTreeContextMenu(): void {
    if (this.treeContextMenu) this.treeContextMenu.style.display = "none";
    this.treeContextTarget = null;
  }

  private showCodeContextMenu(x: number, y: number): void {
    const menu = this.codeContextMenu;
    menu.style.display = "block";
    // Clamp to the viewport so the menu never opens off-screen.
    const mw = menu.offsetWidth;
    const mh = menu.offsetHeight;
    const left = Math.min(x, window.innerWidth - mw - 4);
    const top = Math.min(y, window.innerHeight - mh - 4);
    menu.style.left = `${Math.max(0, left)}px`;
    menu.style.top = `${Math.max(0, top)}px`;
  }

  private hideCodeContextMenu(): void {
    if (this.codeContextMenu) this.codeContextMenu.style.display = "none";
  }

  private async copySelection(): Promise<void> {
    const text = window.getSelection()?.toString() ?? "";
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      // Clipboard may be unavailable; ignore silently.
    }
  }

  private selectAllCode(): void {
    const selection = window.getSelection();
    if (!selection) return;
    const range = document.createRange();
    range.selectNodeContents(this.codeLines);
    selection.removeAllRanges();
    selection.addRange(range);
  }

  /**
   * Size the gutter from column visibility. `gutterWidth` is the author (blame
   * label) column width; the line-number column is a fixed LINENO_WIDTH and the
   * handle a fixed 5px, all laid out by flex, so the gutter's total width is
   * just the sum of whichever children are shown.
   * - both hidden → gutter hidden,
   * - blame shown → author column at gutterWidth, handle shown,
   * - line numbers shown → fixed-width lineno column,
   * - blame hidden → author column and handle hidden (line numbers, if on,
   *   remain at their fixed width).
   */
  private applyGutterWidth(): void {
    this.gutterAuthor.style.width = `${this.gutterWidth}px`;
    this.gutter.style.display =
      this.showBlame || this.showLineno || this.showLifetimes ? "flex" : "none";
    // The handle resizes the author column, so it only makes sense when the
    // author column is visible.
    this.gutterHandle.style.display = this.showBlame ? "block" : "none";
    this.gutterLifetime.style.width = `${this.LIFETIME_WIDTH}px`;
    this.gutterLifetime.style.display = this.showLifetimes ? "block" : "none";
  }

  private makeGutterDrag(handle: HTMLDivElement): void {
    const MIN = 40;
    const MAX = 400;
    let startX = 0;
    let startW = 0;
    const onMove = (e: MouseEvent) => {
      const dx = e.clientX - startX;
      // The handle resizes only the author column; gutterWidth IS that width.
      this.gutterWidth = Math.max(MIN, Math.min(MAX, startW + dx));
      this.applyGutterWidth();
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      this.savePreferences();
    };
    handle.addEventListener("mousedown", (e) => {
      startX = e.clientX;
      startW = this.gutterAuthor.offsetWidth;
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      document.body.style.cursor = "col-resize";
      document.body.style.userSelect = "none";
      e.preventDefault();
    });
  }

  private makeVerticalDrag(handle: HTMLDivElement): void {
    let startY = 0;
    let startH = 0;
    const onMove = (e: MouseEvent) => {
      const dy = e.clientY - startY;
      this.detailSplitter.style.height = `${Math.max(60, startH - dy)}px`;
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    handle.addEventListener("mousedown", (e) => {
      startY = e.clientY;
      startH = this.detailSplitter.offsetHeight;
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      e.preventDefault();
    });
  }

  private makeHorizontalDrag(
    handle: HTMLDivElement,
    left: HTMLDivElement,
    right: HTMLDivElement,
  ): void {
    let startX = 0;
    let startLeftW = 0;
    let totalW = 0;
    const onMove = (e: MouseEvent) => {
      const dx = e.clientX - startX;
      const newLeft = Math.max(60, Math.min(totalW - 60, startLeftW + dx));
      left.style.flex = `0 0 ${(newLeft / totalW) * 100}%`;
      right.style.flex = "1 1 auto";
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    handle.addEventListener("mousedown", (e) => {
      if (left.classList.contains("hidden")) return;
      startX = e.clientX;
      startLeftW = left.offsetWidth;
      totalW = this.detailSplitter.offsetWidth;
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      e.preventDefault();
    });
  }

  private buildStatusBar(): HTMLDivElement {
    const bar = el("div", "status-bar");
    this.statusMsg = el("span", "status-msg");
    bar.appendChild(this.statusMsg);

    const zoomOutBtn = el("button", "zoom-btn", "−"); // minus sign
    zoomOutBtn.title = "Zoom out (Ctrl+-)";
    zoomOutBtn.addEventListener("click", () => this.zoomOut());
    bar.appendChild(zoomOutBtn);
    const zoomResetBtn = el("button", "zoom-btn", "⟳");
    zoomResetBtn.title = "Reset zoom (Ctrl+0)";
    zoomResetBtn.addEventListener("click", () => this.resetZoom());
    bar.appendChild(zoomResetBtn);
    const zoomInBtn = el("button", "zoom-btn", "+");
    zoomInBtn.title = "Zoom in (Ctrl+=)";
    zoomInBtn.addEventListener("click", () => this.zoomIn());
    bar.appendChild(zoomInBtn);

    this.themeCombo = el("select", "theme-combo");
    this.themeCombo.title = "Syntax highlighting theme";
    for (const theme of this.themes) {
      const opt = el("option", undefined, theme.name);
      opt.value = theme.id;
      this.themeCombo.appendChild(opt);
    }
    this.themeCombo.addEventListener("change", () => this.onThemeChanged());
    bar.appendChild(this.themeCombo);

    return bar;
  }

  // =======================================================================
  // File-browser tray
  // =======================================================================

  private buildTreeTray(): HTMLDivElement {
    this.treeTray = el("div", "tree-tray tree-disabled");

    const header = el("div", "tree-tray-header");
    this.treeArrow = el("span", "tree-tray-arrow", "▶"); // ▶
    header.appendChild(this.treeArrow);
    header.appendChild(el("span", "tree-tray-label", "File Browser"));
    this.treeSpinner = el("span", "tree-spinner hidden");
    this.treeSpinner.title = "Loading…";
    header.appendChild(this.treeSpinner);
    header.addEventListener("click", () => this.toggleTree());
    this.treeTray.appendChild(header);

    this.treePanel = el("div", "tree-panel hidden");
    this.treeFilter = el("input", "tree-filter");
    this.treeFilter.type = "text";
    this.treeFilter.placeholder = "Filter files (expanded directories only)...";
    this.treeFilter.addEventListener("input", () => void this.filterTree(this.treeFilter.value));

    const filterRow = el("div", "tree-filter-row");
    filterRow.appendChild(this.treeFilter);
    const clearFilterBtn = el("button", "tree-filter-clear", "×");
    this.treeFilterClearBtn = clearFilterBtn;
    clearFilterBtn.title = "Clear filter";
    clearFilterBtn.disabled = true;
    clearFilterBtn.addEventListener("click", () => {
      this.treeFilter.value = "";
      clearFilterBtn.disabled = true;
      void this.filterTree("");
    });
    this.treeFilter.addEventListener("input", () => {
      clearFilterBtn.disabled = !this.treeFilter.value;
    });
    filterRow.appendChild(clearFilterBtn);
    this.treePanel.appendChild(filterRow);

    this.treeContent = el("div", "tree-content");
    this.treePanel.appendChild(this.treeContent);

    // Overlay for flat filter results, layered over the real tree. Kept hidden
    // until a filter is active; the tree DOM in `treeContent` is never disturbed.
    this.treeFilterOverlay = el("div", "tree-filter-overlay hidden");
    this.treeFilterOverlay.onclick = (e) => void this.onTreeClick(e);
    this.treeFilterOverlay.ondblclick = (e) => this.onTreeDblClick(e);
    this.treeFilterOverlay.addEventListener("contextmenu", (e) => {
      const rowEl = (e.target as HTMLElement).closest<HTMLElement>(".tree-node");
      if (!rowEl) return;
      e.preventDefault();
      this.treeContextTarget = rowEl;
      this.selectTreeRow(rowEl);
      this.showTreeContextMenu(e.clientX, e.clientY, rowEl.dataset.dir === "true");
    });
    this.treePanel.appendChild(this.treeFilterOverlay);

    this.treeTray.appendChild(this.treePanel);

    const treeResizeHandle = el("div", "tree-resize-handle");
    this.makeTreePanelDrag(treeResizeHandle);
    this.treeTray.appendChild(treeResizeHandle);

    // Enter opens the highlighted file (from anywhere in the panel, including
    // while the filter field is focused).
    this.treePanel.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && this.treeSelected && this.treeSelected.dataset.dir !== "true") {
        e.preventDefault();
        this.openTreeRow(this.treeSelected);
      }
    });

    return this.treeTray;
  }

  private makeTreePanelDrag(handle: HTMLDivElement): void {
    let startY = 0;
    let startH = 0;
    const onMove = (e: MouseEvent) => {
      const dy = e.clientY - startY;
      this.treePanelHeight = Math.max(80, startH + dy);
      this.treePanel.style.height = `${this.treePanelHeight}px`;
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      this.savePreferences();
    };
    handle.addEventListener("mousedown", (e) => {
      if (this.treePanel.classList.contains("hidden")) return;
      startY = e.clientY;
      startH = this.treePanel.offsetHeight;
      document.body.style.cursor = "row-resize";
      document.body.style.userSelect = "none";
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      e.preventDefault();
    });
  }

  private toggleTree(): void {
    if (this.modeToggle.value !== "repo") return;
    this.treeExpanded = !this.treeExpanded;
    this.treePanel.classList.toggle("hidden", !this.treeExpanded);
    this.treeArrow.textContent = this.treeExpanded ? "▼" : "▶";
    if (this.treeExpanded && !this.treeLoaded) {
      void this.populateTree();
    }
  }

  private collapseTree(): void {
    if (!this.treeExpanded) return;
    this.treeExpanded = false;
    this.treePanel.classList.add("hidden");
    this.treeArrow.textContent = "▶"; // ▶
  }

  /**
   * The repo root (absolute, forward slashes) for the tree. The backend already
   * discovered it via `rev-parse --show-toplevel` at creation, so ask for it
   * directly rather than reconstructing it from the (expensive) full file list.
   * Falls back to the picked file's directory if the backend can't provide one.
   */
  private async deriveRepoRoot(backend: Backend, pickedAbs: string): Promise<string> {
    try {
      const root = (await backend.getRepoRoot()).trim();
      if (root) return root.replace(/\\/g, "/");
    } catch {
      // fall through to directory-of-file fallback
    }
    return dirname(pickedAbs.replace(/\\/g, "/"));
  }

  /**
   * Populate the tree lazily: fetch and render only the root directory's
   * immediate children, then load deeper levels on demand as directories are
   * expanded. Uses `treeBackend` when the user browsed to a repo (cold start),
   * otherwise the loaded-file `backend`. `pickedAbs`, when browsing, anchors
   * `treeRepoRoot`.
   *
   * The full HEAD file list is deliberately NOT fetched here: in a large
   * monorepo `ls-tree -r` can take tens of seconds and would block the whole
   * tree. Instead each directory is listed on demand (`listDirectory`), and the
   * full list is loaded lazily only when the user actually filters.
   */
  private async populateTree(pickedAbs?: string): Promise<void> {
    const backend = this.treeBackend ?? this.backend;
    this.treeContent.innerHTML = "";
    this.treeSelected = null;
    this.treeAllFiles = null;
    this.cancelBackgroundAllFiles();
    this.treeDirCache.clear();
    this.treeSubmoduleBackends.clear();
    this.treeSubmoduleFiles.clear();
    this.resetTreeFilterState();
    this.treeModifiedFiles = new Set();
    // Fresh tree render: drop any spinner debt from a prior (possibly aborted)
    // population before counting this one's work.
    this.resetTreeLoading();
    if (!backend) {
      this.treeContent.appendChild(
        el("div", "tree-empty", "No repository loaded. Use Browse in Repo mode to open a repository."),
      );
      return;
    }
    const token = ++this.treeLoadToken;
    this.startTreeLoading();
    // try/finally, not a trailing call: an exception anywhere below used to
    // skip endTreeLoading and leave the spinner running forever with no error
    // shown, which reads as "the file browser never finishes loading".
    let treeLoadingEnded = false;
    const endOnce = () => { if (!treeLoadingEnded) { treeLoadingEnded = true; this.endTreeLoading(); } };
    try {

    // Anchor the repo root. When browsing to a repo, `treeRepoRoot` was already
    // set to the chosen directory by the caller; keep it. Otherwise ask the
    // backend, which discovered the root at creation (no full file list needed).
    if (this.treeBackend && pickedAbs) {
      this.treeRepoRoot = await this.deriveRepoRoot(backend, pickedAbs);
    } else if (this.treeBackend) {
      // Keep the caller-set root; do NOT re-derive from `this.filePath`, which
      // may still point at a file from a previously opened repository.
    } else if (this.filePath) {
      this.treeRepoRoot = await this.deriveRepoRoot(backend, this.filePath);
    }
    if (token !== this.treeLoadToken) return;

    this.treeContent.innerHTML = "";
    // Row interactions delegated at the container level.
    this.treeContent.onclick = (e) => void this.onTreeClick(e);
    this.treeContent.ondblclick = (e) => this.onTreeDblClick(e);
    this.treeContent.addEventListener("contextmenu", (e) => {
      const rowEl = (e.target as HTMLElement).closest<HTMLElement>(".tree-node");
      if (!rowEl) return;
      e.preventDefault();
      this.treeContextTarget = rowEl;
      this.selectTreeRow(rowEl);
      this.showTreeContextMenu(e.clientX, e.clientY, rowEl.dataset.dir === "true");
    });

    await this.loadDir(null, "", 0, token);
    endOnce();
    if (token !== this.treeLoadToken) return;

    // Modified-file badges are applied after the tree is visible. `git diff
    // --name-only` can be slow in a huge dirty repo, so it must not block the
    // initial render.
    void backend.listModifiedFiles().then((modified) => {
      if (token !== this.treeLoadToken) return;
      this.treeModifiedFiles = modified;
      this.refreshTreeBadges();
      if (this.filePath) this.updateTreeOpenedBadge(this.filePath);
    }).catch(() => { /* leave badges off on error */ });
    if (token !== this.treeLoadToken) return;
    this.treeLoaded = true;

    // Warm the full HEAD file list in the background so the filter is ready
    // without a stall. This is the expensive `ls-tree -r`; it runs only after
    // the tree is already visible and interactive.
    this.startBackgroundAllFiles(backend);

    if (this.treeFilter.value) void this.filterTree(this.treeFilter.value);
    void this.refreshRefBanner();
    void this.refreshRefList();
    } finally {
      endOnce();
    }
  }

  /**
   * Fetch the full HEAD file list in the background (used only by filter search)
   * without blocking the visible tree. Fire-and-forget: guarded by
   * `treeAllFilesToken` (a tree-lifecycle token, NOT the per-load token), so a
   * file open (which bumps `treeLoadToken`) does not discard the in-flight
   * result. It still gets cancelled when the tree is re-populated or the repo is
   * swapped. Sets `treeAllFilesLoading` so a filter issued before it completes
   * can show a "loading" hint instead of a false "no matches".
   */
  private startBackgroundAllFiles(backend: Backend): void {
    if (this.treeAllFiles !== null || this.treeAllFilesLoading) return;
    const token = this.treeAllFilesToken;
    this.treeAllFilesLoading = true;
    this.startTreeLoading();
    // Sparse paths are warmed in parallel so they're ready the moment "Show
    // Sparse Files" is toggled; a failure here just leaves them out of search.
    void backend.listSparseFiles().then((files) => {
      if (token !== this.treeAllFilesToken) return;
      this.treeSparseFiles = files;
    }).catch(() => {
      if (token !== this.treeAllFilesToken) return;
      this.treeSparseFiles = [];
    });
    void backend.listAllFiles().then((files) => {
      if (token !== this.treeAllFilesToken) return;
      this.treeAllFiles = files;
      // If the user is already filtering, re-run now that the full list is in.
      if (this.treeFilter.value.trim()) void this.filterTree(this.treeFilter.value);
    }).catch(() => {
      if (token !== this.treeAllFilesToken) return;
      this.treeAllFiles = [];
    }).finally(() => {
      this.endTreeLoading();
      if (token !== this.treeAllFilesToken) return;
      this.treeAllFilesLoading = false;
    });
  }

  /**
   * Invalidate any in-flight or pending background full-file-list warm-up, so a
   * stale result from a previous tree/repo can't write into fresh state. Called
   * by tree-lifecycle resets (repo swap, tree teardown), NOT by a plain file
   * open; that must let the fetch complete fire-and-forget.
   */
  private cancelBackgroundAllFiles(): void {
    this.treeAllFilesToken++;
    this.treeAllFilesLoading = false;
    // The sparse list is warmed under the same token, so drop it here too: every
    // reset site clears `treeAllFiles` and calls this in lockstep.
    this.treeSparseFiles = null;
  }

  /**
   * The single File Browser loading indicator. Reflects `treeLoadingCount`:
   * visible while any async tree operation is in flight, hidden once all
   * currently expected work has completed.
   */
  private updateTreeSpinner(): void {
    if (!this.treeSpinner) return;
    this.treeSpinner.classList.toggle("hidden", this.treeLoadingCount <= 0);
  }

  private startTreeLoading(): void {
    this.treeLoadingCount++;
    this.updateTreeSpinner();
  }

  private endTreeLoading(): void {
    this.treeLoadingCount = Math.max(0, this.treeLoadingCount - 1);
    this.updateTreeSpinner();
  }

  private resetTreeLoading(): void {
    this.treeLoadingCount = 0;
    this.updateTreeSpinner();
  }

  /**
   * The repo-relative path of the deepest expanded submodule that contains
   * `dirPath` (or is `dirPath` itself), or null when `dirPath` lives in the main
   * repo. "Deepest" so nested submodules resolve to the innermost one. Only
   * submodules already in `treeSubmoduleBackends` are considered; an entry is
   * added there the first time its row is expanded (see {@link resolveDirBackend}).
   */
  private submodulePrefixFor(dirPath: string): string | null {
    let best: string | null = null;
    for (const subPath of this.treeSubmoduleBackends.keys()) {
      if (dirPath === subPath || dirPath.startsWith(subPath + "/")) {
        if (best === null || subPath.length > best.length) best = subPath;
      }
    }
    return best;
  }

  /**
   * Resolve which backend should list `dirPath` and the path relative to that
   * backend's repo root. When `dirPath` is inside an expanded submodule, its
   * backend (created lazily and anchored at the submodule's own repo) is used
   * with the submodule prefix stripped; otherwise the main tree backend is used
   * with the full repo-relative path. Returns null when no backend is available
   * or the submodule backend can't be created (e.g. an uninitialized submodule).
   */
  private async resolveDirBackend(
    dirPath: string,
  ): Promise<{ backend: Backend; subPath: string; submodulePath: string | null } | null> {
    const submodulePath = this.submodulePrefixFor(dirPath);
    if (submodulePath !== null) {
      const backend = await this.ensureSubmoduleBackend(submodulePath);
      if (!backend) return null;
      const subPath = dirPath === submodulePath ? "" : dirPath.slice(submodulePath.length + 1);
      return { backend, subPath, submodulePath };
    }
    const backend = this.treeBackend ?? this.backend;
    if (!backend) return null;
    return { backend, subPath: dirPath, submodulePath: null };
  }

  /**
   * Get (or lazily create and cache) the backend for the submodule at the
   * repo-relative `submodulePath`. Its absolute path is derived from
   * `treeRepoRoot`; the backend runs git inside the submodule so its contents
   * list against the submodule as the repo root. Returns null if the backend
   * can't be created (e.g. the submodule is not initialized/checked out).
   */
  private async ensureSubmoduleBackend(submodulePath: string): Promise<Backend | null> {
    const existing = this.treeSubmoduleBackends.get(submodulePath);
    if (existing) return existing;
    const root = this.treeRepoRoot.replace(/\/+$/, "");
    if (!root) return null;
    const abs = `${root}/${submodulePath}`;
    try {
      const backend = await this.deps.createBackend(abs, abs);
      this.treeSubmoduleBackends.set(submodulePath, backend);
      return backend;
    } catch {
      return null;
    }
  }

  /**
   * Fetch one directory's immediate children and insert their rows into the DOM
   * after `anchor` (its directory row), or append to `this.treeContent` when
   * `anchor` is null (the root). Directories first, then files, each group
   * alphabetical. File rows get modified/deleted badges immediately and a
   * per-file revision count badge as it resolves. `dirPath` is repo-relative
   * ("" = root); `depth` drives indentation. `token` guards against a stale load
   * whose backend was swapped out by a re-populate.
   */
  private async loadDir(
    anchor: HTMLElement | null,
    dirPath: string,
    depth: number,
    token: number,
  ): Promise<void> {
    // Route git to the right repo. When `dirPath` is inside an already-expanded
    // submodule, use that submodule's backend and the path relative to it;
    // otherwise use the main tree backend and the full repo-relative path.
    const resolved = await this.resolveDirBackend(dirPath);
    if (token !== this.treeLoadToken) return;
    if (!resolved) return;
    const { backend, subPath } = resolved;

    // The immediate listing keeps the header spinner up until this directory's
    // live children are rendered; the background info fetch below adds its own
    // span so the spinner persists until deleted/count badges resolve too.
    this.startTreeLoading();
    let immediateDone = false;
    const endImmediate = () => { if (!immediateDone) { immediateDone = true; this.endTreeLoading(); } };

    // List this ONE directory's immediate children in HEAD. `ls-tree HEAD --
    // <dir>/` is instant even in a huge monorepo, unlike a recursive listing of
    // the whole repo.
    const dirs = new Set<string>();
    const files: string[] = [];
    const sparseNames = new Set<string>();
    const submoduleNames = new Set<string>();
    try {
      for (const entry of await backend.listDirectory(subPath)) {
        // Sparse (skip-worktree) entries are hidden by default; the "Show Sparse
        // Files" option reveals them with the "(sparse)" badge.
        if (entry.sparse && !this.showSparseFiles) continue;
        if (entry.isDir) dirs.add(entry.name);
        else files.push(entry.name);
        if (entry.sparse) sparseNames.add(entry.name);
        if (entry.isSubmodule) submoduleNames.add(entry.name);
      }
    } catch { /* empty directory listing on error */ }
    if (token !== this.treeLoadToken) { endImmediate(); return; }

    // Render live children immediately; deleted entries and revision counts come
    // from the cached directory info (or the background fetch below).
    const cached = this.treeDirCache.get(dirPath);
    let deleted: string[] = cached?.deleted ?? [];
    let deletedDirs: string[] = cached?.deletedDirs ?? [];
    let revCounts = cached?.counts ?? new Map<string, number>();

    interface Child { name: string; dir: boolean; deleted: boolean; sparse: boolean; submodule: boolean }
    const compareChildren = (a: Child, b: Child): number => {
      if (a.dir !== b.dir) return a.dir ? -1 : 1;
      return a.name.toLowerCase().localeCompare(b.name.toLowerCase());
    };
    const children: Child[] = [];
    for (const d of dirs) children.push({ name: d, dir: true, deleted: false, sparse: sparseNames.has(d), submodule: submoduleNames.has(d) });
    for (const f of files) children.push({ name: f, dir: false, deleted: false, sparse: sparseNames.has(f), submodule: false });
    if (cached && this.showDeletedFiles) {
      for (const name of deletedDirs) children.push({ name, dir: true, deleted: true, sparse: false, submodule: false });
      for (const name of deleted) children.push({ name, dir: false, deleted: true, sparse: false, submodule: false });
    }
    children.sort(compareChildren);

    const frag = document.createDocumentFragment();
    const fileRows: { rowEl: HTMLElement; path: string }[] = [];
    for (const child of children) {
      const childPath = dirPath ? `${dirPath}/${child.name}` : child.name;
      const rowEl = el("div", "tree-node");
      rowEl.dataset.path = childPath;
      rowEl.dataset.depth = String(depth);
      rowEl.style.paddingLeft = `${6 + depth * 14}px`;

      if (child.dir) {
        rowEl.classList.add("dir", "collapsed");
        rowEl.dataset.dir = "true";
        rowEl.appendChild(el("span", "tree-dir-arrow", "▶"));
        rowEl.appendChild(el("span", "tree-file-name", child.name));
        if (child.submodule) {
          rowEl.classList.add("tree-submodule");
          rowEl.dataset.submodule = "true";
          rowEl.appendChild(el("span", "tree-submodule-badge", " (submodule)"));
        } else {
          if (child.deleted) { rowEl.classList.add("tree-deleted"); rowEl.dataset.deleted = "true"; }
          if (child.sparse) { rowEl.classList.add("tree-sparse"); rowEl.dataset.sparse = "true"; }
          renderTreeBadges(rowEl, { sparse: child.sparse, deleted: child.deleted });
        }
      } else {
        rowEl.appendChild(el("span", "tree-dir-arrow", ""));
        rowEl.appendChild(el("span", "tree-file-name", child.name));
        fileRows.push({ rowEl, path: childPath });
        const modified = this.treeModifiedFiles.has(childPath);
        if (modified) rowEl.classList.add("tree-modified");
        if (child.deleted) { rowEl.classList.add("tree-deleted"); rowEl.dataset.deleted = "true"; }
        if (child.sparse) { rowEl.classList.add("tree-sparse"); rowEl.dataset.sparse = "true"; }
        const opened = !!this.treeOpenedPath && childPath === this.treeOpenedPath;
        renderTreeBadges(rowEl, { sparse: child.sparse, deleted: child.deleted, modified, opened });
      }
      frag.appendChild(rowEl);
    }

    if (anchor) {
      anchor.after(frag);
    } else {
      this.treeContent.appendChild(frag);
    }

    // The opened flag is applied inline during the render loop above via
    // renderTreeBadges, so no separate reassert pass is needed here.

    // Apply cached revision counts immediately.
    if (cached) {
      for (const { rowEl, path } of fileRows) {
        const name = path.split("/").pop() ?? path;
        const count = revCounts.get(name) ?? 0;
        insertTreeRevCount(rowEl, count);
      }
    }

    // The live children are now rendered; the immediate load is complete. The
    // background info fetch (below) keeps the header spinner up on its own.
    endImmediate();

    // Background fetch: deleted files, deleted dirs, and revision counts.
    // The tree is already showing live children; badges appear as they resolve.
    if (!cached && backend.listDirectoryInfo) {
      this.startTreeLoading();
      void backend.listDirectoryInfo(subPath).then((info) => {
        if (token !== this.treeLoadToken) return;
        this.treeDirCache.set(dirPath, info);

        // Deleted files discovered here are folded into filter search from
        // `treeDirCache` (see filterTree), so no need to touch `treeAllFiles`.

        // Add revision count badges to already-rendered file rows.
        for (const { rowEl, path } of fileRows) {
          if (!rowEl.isConnected) continue;
          const name = path.split("/").pop() ?? path;
          const count = info.counts.get(name) ?? 0;
          insertTreeRevCount(rowEl, count);
        }

        // Insert deleted files and dirs that weren't rendered initially, each at
        // its correct alphabetical position among the existing siblings (dirs
        // first, then files) rather than segregated at the end.
        const newChildren: Child[] = [];
        if (this.showDeletedFiles) {
          for (const name of info.deletedDirs ?? []) newChildren.push({ name, dir: true, deleted: true, sparse: false, submodule: false });
          for (const name of info.deleted) newChildren.push({ name, dir: false, deleted: true, sparse: false, submodule: false });
        }
        if (newChildren.length > 0) {
          newChildren.sort(compareChildren);

          // Collect the current sibling rows at this depth under the same parent,
          // in DOM order, so we can find the insertion point for each new entry.
          const siblings: HTMLElement[] = [];
          const scanStart = (anchor ? anchor.nextElementSibling : this.treeContent.firstElementChild) as HTMLElement | null;
          let sib = scanStart;
          while (sib) {
            const sDepth = parseInt(sib.dataset.depth ?? "-1", 10);
            if (sDepth < depth) break;
            if (sDepth === depth && sib.classList.contains("tree-node")) siblings.push(sib);
            sib = sib.nextElementSibling as HTMLElement | null;
          }

          const siblingKey = (row: HTMLElement): Child => ({
            name: (row.querySelector<HTMLElement>(".tree-file-name")?.textContent ?? row.dataset.path?.split("/").pop() ?? ""),
            dir: row.dataset.dir === "true",
            deleted: row.dataset.deleted === "true",
            sparse: row.dataset.sparse === "true",
            submodule: row.dataset.submodule === "true",
          });

          for (const child of newChildren) {
            const childPath = dirPath ? `${dirPath}/${child.name}` : child.name;
            const rowEl = el("div", "tree-node tree-deleted");
            rowEl.dataset.path = childPath;
            rowEl.dataset.depth = String(depth);
            rowEl.dataset.deleted = "true";
            rowEl.style.paddingLeft = `${6 + depth * 14}px`;
            if (child.dir) {
              rowEl.classList.add("dir", "collapsed");
              rowEl.dataset.dir = "true";
              rowEl.appendChild(el("span", "tree-dir-arrow", "▶"));
            } else {
              rowEl.appendChild(el("span", "tree-dir-arrow", ""));
            }
            rowEl.appendChild(el("span", "tree-file-name", child.name));
            const count = info.counts.get(child.name) ?? 0;
            insertTreeRevCount(rowEl, count);
            const opened = !child.dir && !!this.treeOpenedPath && childPath === this.treeOpenedPath;
            renderTreeBadges(rowEl, { deleted: true, opened });

            // Find the first existing sibling that sorts after this entry and
            // insert before it; otherwise append after the last sibling.
            let insertBefore: HTMLElement | null = null;
            for (const s of siblings) {
              if (compareChildren(child, siblingKey(s)) < 0) { insertBefore = s; break; }
            }
            if (insertBefore) {
              insertBefore.before(rowEl);
              siblings.splice(siblings.indexOf(insertBefore), 0, rowEl);
            } else if (siblings.length > 0) {
              // Append after the last sibling's entire subtree (an expanded dir
              // may have already-loaded descendants between it and the next row).
              const last = siblings[siblings.length - 1];
              let end: HTMLElement = last;
              let after = last.nextElementSibling as HTMLElement | null;
              while (after && parseInt(after.dataset.depth ?? "-1", 10) > depth) {
                end = after;
                after = after.nextElementSibling as HTMLElement | null;
              }
              end.after(rowEl);
              siblings.push(rowEl);
            } else if (anchor) {
              anchor.after(rowEl);
              siblings.push(rowEl);
            } else {
              this.treeContent.appendChild(rowEl);
              siblings.push(rowEl);
            }
          }
          this.applyTreeVisibility();
        }
      }).catch(() => {}).finally(() => { this.endTreeLoading(); });
    }
  }

  /**
   * A transient row with an inline spinner, shown while a directory's info is
   * being fetched. Not a `.tree-node`, so it stays out of visibility/filter
   * logic; it is removed once the real rows are inserted.
   */
  private async onTreeClick(e: MouseEvent): Promise<void> {
    const rowEl = (e.target as HTMLElement).closest<HTMLElement>(".tree-node");
    if (!rowEl) return;
    if (rowEl.dataset.dir === "true") {
      await this.toggleDir(rowEl);
      return;
    }
    // File: single click selects/highlights.
    this.selectTreeRow(rowEl);
  }

  /**
   * Expand or collapse a directory row. On first expansion its children are
   * fetched and inserted (marking data-loaded); later expansions just re-show
   * the already-loaded descendant rows. Collapsing hides all descendants (rows
   * deeper than this one, up to the next sibling at the same/shallower depth)
   * without removing them, so re-expanding is instant.
   */
  private async toggleDir(rowEl: HTMLElement): Promise<void> {
    const collapsing = !rowEl.classList.contains("collapsed");
    rowEl.classList.toggle("collapsed", collapsing);
    const arrow = rowEl.querySelector<HTMLElement>(".tree-dir-arrow");
    if (arrow) arrow.textContent = collapsing ? "▶" : "▼"; // ▶ / ▼

    if (!collapsing && rowEl.dataset.loaded !== "true") {
      const dirPath = rowEl.dataset.path ?? "";
      const depth = parseInt(rowEl.dataset.depth ?? "0", 10);
      // A submodule row is the boundary into another repo: register its backend
      // before listing so `resolveDirBackend` routes this and every descendant
      // path to the submodule. If the submodule isn't initialized the backend
      // can't be created; leave the row unloaded so a retry is possible.
      if (rowEl.dataset.submodule === "true") {
        const backend = await this.ensureSubmoduleBackend(dirPath);
        if (!backend) {
          rowEl.classList.toggle("collapsed", true);
          if (arrow) arrow.textContent = "▶";
          this.deps.host.showError(
            "This submodule is not initialized or checked out, so its contents can't be listed.",
          );
          return;
        }
      }
      rowEl.dataset.loaded = "true";
      await this.loadDir(rowEl, dirPath, depth + 1, this.treeLoadToken);
    }
    this.applyTreeVisibility();
  }

  /**
   * Show/hide rows based on their ancestor directories' expanded state. A row is
   * visible only if every ancestor directory is expanded. Directory expansion is
   * tracked via the `collapsed` class on the directory row. Rows whose parent
   * directory has not been loaded yet simply don't exist in the DOM.
   */
  private applyTreeVisibility(): void {
    const rows = Array.from(this.treeContent.querySelectorAll<HTMLElement>(".tree-node"));
    // When we pass a collapsed dir at depth d, everything deeper than d is
    // hidden until we return to depth <= d.
    let hideBelow = Infinity;
    for (const rowEl of rows) {
      const depth = parseInt(rowEl.dataset.depth ?? "0", 10);
      if (depth > hideBelow) {
        rowEl.classList.add("tree-hidden");
        continue;
      }
      hideBelow = Infinity;
      rowEl.classList.remove("tree-hidden");
      if (rowEl.dataset.dir === "true" && rowEl.classList.contains("collapsed")) {
        hideBelow = depth;
      }
    }
  }

  private onTreeDblClick(e: MouseEvent): void {
    const rowEl = (e.target as HTMLElement).closest<HTMLElement>(".tree-node");
    if (!rowEl || rowEl.dataset.dir === "true") return;
    this.openTreeRow(rowEl);
  }

  private selectTreeRow(rowEl: HTMLElement): void {
    if (this.treeSelected) this.treeSelected.classList.remove("selected");
    this.treeSelected = rowEl;
    rowEl.classList.add("selected");
  }

  private openTreeRow(rowEl: HTMLElement): void {
    if (rowEl.classList.contains("dir")) return;
    const rel = rowEl.dataset.path;
    if (!rel) return;
    const root = this.treeRepoRoot || (this.filePath ? dirname(this.filePath) : "");
    if (!root) {
      this.deps.host.showError("No repository root available.");
      return;
    }
    // `data-path` is always relative to the main repo root, so the absolute path
    // is the same regardless of submodules. But a file inside a submodule must
    // be opened against the submodule as the repo root, otherwise its history
    // (and, for deleted files, the deleted-file lookup) resolves in the wrong
    // repo. `submodulePrefixFor` returns the enclosing submodule (registered
    // when the user expanded it) so we can anchor at the submodule's root.
    const full = `${root}/${rel}`;
    const submodulePath = this.submodulePrefixFor(rel);
    const fileRoot = submodulePath ? `${root}/${submodulePath}` : root;
    const isDeleted = rowEl.dataset.deleted === "true";
    if (isDeleted) {
      void this.loadDeletedFile(fileRoot, full);
    } else {
      void this.loadFile(full, false, false, fileRoot);
    }
  }

  /**
   * All tree rows matching a repo-relative `data-path`, across both the real
   * tree (`treeContent`) and the filter-results overlay. A path can be present in
   * both at once, so badge updates must touch every instance.
   */
  private treeNodesByPath(rel: string): HTMLElement[] {
    const sel = `.tree-node[data-path="${CSS.escape(rel)}"]`;
    const out: HTMLElement[] = [];
    if (this.treeContent) out.push(...Array.from(this.treeContent.querySelectorAll<HTMLElement>(sel)));
    if (this.treeFilterOverlay) out.push(...Array.from(this.treeFilterOverlay.querySelectorAll<HTMLElement>(sel)));
    return out;
  }

  /**
   * Move the "opened" flag to the tree node matching `newPath` (an absolute file
   * path). Updates `treeOpenedPath`, then rebuilds the combined badge on both the
   * previously-opened node and the newly-opened one from their derived flags, so
   * the opened label appears/disappears in its correct position alongside any
   * sparse/deleted/modified labels. Pass "" to just clear the current opened flag
   * (nothing loaded). Nodes not present in the DOM are skipped.
   */
  private updateTreeOpenedBadge(newPath: string): void {
    // Translate the absolute path into the repo-relative path used as data-path.
    const toRel = (abs: string): string => {
      if (!abs) return "";
      const root = this.treeRepoRoot;
      if (!root) return "";
      const a = abs.replace(/\\/g, "/");
      const r = root.replace(/\\/g, "/").replace(/\/+$/, "");
      const prefix = r + "/";
      return a.toLowerCase().startsWith(prefix.toLowerCase())
        ? a.slice(prefix.length)
        : "";
    };

    const rebuild = (rel: string): void => {
      if (!rel) return;
      for (const node of this.treeNodesByPath(rel)) {
        renderTreeBadges(
          node,
          treeBadgeFlagsFor(node, this.treeModifiedFiles, this.treeOpenedPath),
        );
      }
    };

    const oldRel = this.treeOpenedPath;
    const newRel = toRel(newPath);
    this.treeOpenedPath = newRel;
    if (oldRel === newRel) {
      // Same node (or both empty): still rebuild in case the row was re-rendered.
      rebuild(newRel);
      return;
    }
    rebuild(oldRel);
    rebuild(newRel);
  }

  private async loadDeletedFile(repoRoot: string, filePath: string): Promise<void> {
    // Clear all per-file state before loading so nothing carries over from the
    // previously viewed file.
    this.resetFileState();
    this.showLoading();
    try {
      const backend = await this.deps.createBackend(repoRoot, filePath);
      const commits = await backend.getCommits();
      if (!commits.length) {
        this.deps.host.showError("No commits were found that touched this file.");
        return;
      }
      this.backend = backend;
      this.commits = commits;
      this.filePath = filePath;
      // A deleted file has no working-tree content, so no virtual "M" revision
      // (resetFileState already left hasModifiedRev false / modifiedBaseHex "").
      this.lastKnownCommitHash = commits.length > 0 ? commits[commits.length - 1].hexSha : "";
      this.lastKnownModifiedState = await backend.getFileModifiedState().catch(() => "");
      commits.forEach((c, i) => this.commitRevisions.set(c.hexSha, i + 1));
      this.updatePathDisplay(filePath);
    void this.refreshRefBanner();
    void this.refreshRefList();
      void this.deps.host.setTitle(`Git Time-Lapse View — ${basename(filePath)}`);
      this.slider.disabled = false;
      this.slider.min = "0";
      this.slider.max = String(commits.length - 1);
      this.slider.value = String(commits.length - 1);
      this.updateMRevButton();
      this.refreshSliderLabels();
      // Precache before display so showRevision hits the blame/content cache
      // (getBlame is cache-only now). The overlay stays up over the code area
      // while the status bar (outside the overlay) shows the "precaching, N
      // remaining" progress, both visible at once. Set currentIndex to the
      // target revision so refreshStatusBar (called from runPrecache) can render
      // it instead of early-returning on the negative index. hideLoading runs
      // after showRevision, once the content is painted.
      this.currentIndex = commits.length - 1;
      this.refreshStatusBar();
      // Warm the latest-revision content (cached for the showRevision below) and
      // use its line count to scale precache workers via the commits × lines
      // heuristic in runPrecache.
      const latestHex = commits[commits.length - 1].hexSha;
      const latestLineCount = await backend
        .getFileContent(latestHex)
        .then((content) => content.split("\n").length, () => 0);
      await this.runPrecache(latestLineCount);
      await this.buildLifetimeEndMap();
      await this.showRevision(commits.length - 1);
      this.hideLoading();
      this.updateNavButtons();
      this.updateTabLabel();
      this.updateTreeOpenedBadge(filePath);
      this.syncHistoryUi();
    } catch (exc) {
      this.hideLoading();
      this.deps.host.showError(`Failed to load deleted file:\n\n${filePath}\n\n${exc}`);
    }
  }

  /**
   * Collect per-path row metadata (deleted / sparse / submodule / dir) from the
   * live tree DOM under `treeContent`. This is the only source that carries the
   * sparse and submodule flags for a filter search: `listAllFiles` drops `S`
   * (skip-worktree) entries and `treeDirCache` records only deleted/count info,
   * so sparse and submodule facts survive solely on the rendered rows of
   * expanded directories. Keyed by repo-relative path (data-path).
   */
  private collectTreeRowMeta(): Map<
    string,
    { deleted: boolean; sparse: boolean; submodule: boolean; dir: boolean }
  > {
    const meta = new Map<
      string,
      { deleted: boolean; sparse: boolean; submodule: boolean; dir: boolean }
    >();
    for (const row of Array.from(
      this.treeContent.querySelectorAll<HTMLElement>(".tree-node"),
    )) {
      const p = row.dataset.path;
      if (!p) continue;
      meta.set(p, {
        deleted: row.dataset.deleted === "true",
        sparse: row.dataset.sparse === "true",
        submodule: row.dataset.submodule === "true",
        dir: row.dataset.dir === "true",
      });
    }
    return meta;
  }

  /**
   * Build one flat filter-result row for `path`, applying the same CSS classes,
   * data attributes, and combined badge that the main tree rows carry so filter
   * results are visually identical. `rowMeta` supplies sparse/submodule/deleted
   * facts derived from the live tree DOM (see collectTreeRowMeta); `deleted` may
   * also be forced true for entries known deleted from other sources, and
   * `forceSparse` marks entries known sparse from the cached sparse list even
   * when they aren't present in any expanded (DOM) directory.
   */
  private buildFilterRow(
    path: string,
    deleted: boolean,
    rowMeta: Map<
      string,
      { deleted: boolean; sparse: boolean; submodule: boolean; dir: boolean }
    >,
    forceSparse = false,
  ): HTMLElement {
    const meta = rowMeta.get(path);
    const isDeleted = deleted || !!meta?.deleted;
    const isSparse = forceSparse || !!meta?.sparse;
    const isSubmodule = !!meta?.submodule;
    const isDir = !!meta?.dir;

    const rowEl = el("div", "tree-node");
    rowEl.dataset.path = path;
    rowEl.dataset.depth = "0";
    rowEl.style.paddingLeft = "6px";
    rowEl.appendChild(el("span", "tree-dir-arrow", isDir ? "▶" : ""));
    rowEl.appendChild(el("span", "tree-file-name", path));

    if (isDir) {
      rowEl.classList.add("dir", "collapsed");
      rowEl.dataset.dir = "true";
    }
    if (isSubmodule) {
      rowEl.classList.add("tree-submodule");
      rowEl.dataset.submodule = "true";
      rowEl.appendChild(el("span", "tree-submodule-badge", " (submodule)"));
      return rowEl;
    }
    if (isDeleted) {
      rowEl.classList.add("tree-deleted");
      rowEl.dataset.deleted = "true";
    }
    if (isSparse) {
      rowEl.classList.add("tree-sparse");
      rowEl.dataset.sparse = "true";
    }
    const modified = !isDir && this.treeModifiedFiles.has(path);
    if (modified) rowEl.classList.add("tree-modified");
    const opened =
      !isDir && !!this.treeOpenedPath && path === this.treeOpenedPath;
    renderTreeBadges(rowEl, {
      sparse: isSparse,
      deleted: isDeleted,
      modified,
      opened,
    });
    return rowEl;
  }

  /**
   * Filter the tree by substring. Because directories are loaded lazily, the DOM
   * only holds expanded branches (a match can live in a never-opened directory),
   * so search runs against the full HEAD path list (`listAllFiles`, fetched
   * once and cached) plus the files of any expanded submodules, rather than the
   * visible rows. Matching files are rendered as a flat list of full-path rows in
   * a separate overlay layered over the tree; the tree DOM itself is never
   * touched, so clearing the filter reveals it exactly as the user left it (same
   * expansion, same scroll). Deleted files are not enumerated here (too
   * expensive); the user browses to find them.
   */
  private async filterTree(query: string): Promise<void> {
    const q = query.trim().toLowerCase();
    const backend = this.treeBackend ?? this.backend;
    if (!backend) return;

    if (!q) {
      // Reveal the untouched tree: hide the overlay and free its rows. The tree
      // DOM in `treeContent` was never modified, so its expansion state and
      // scroll position are exactly as the user left them.
      this.hideFilterOverlay();
      return;
    }

    // A filter is active: show the overlay layered over the tree.
    this.showFilterOverlay();

    // Search runs against the full HEAD file list, which is warmed in the
    // background after the tree renders. If it hasn't arrived yet, promote the
    // fetch to run immediately (the user clearly wants search now), show whatever
    // matches are already known from the cached per-directory listings, and let
    // the fetch's completion auto-re-run this filter with the full list.
    if (this.treeAllFiles === null) {
      this.startBackgroundAllFiles(backend);
      this.renderPartialFilterResults(q);
      return;
    }
    // Merge cached deleted files into the search set (unless deleted files are hidden).
    const allPaths = new Set(this.treeAllFiles);
    const deletedSet = new Set<string>();
    if (this.showDeletedFiles) {
      for (const [dir, info] of this.treeDirCache) {
        const prefix = dir ? dir + "/" : "";
        for (const name of info.deleted) {
          const full = prefix + name;
          allPaths.add(full);
          deletedSet.add(full);
        }
      }
    }
    // Fold in files from every expanded submodule so their contents are
    // searchable too; the main repo's `listAllFiles` stops at the submodule
    // boundary and never enumerates inside it. These are live files, so they
    // must not be treated as deleted just because they aren't in `treeAllFiles`.
    for (const path of await this.collectSubmoduleFiles()) allPaths.add(path);

    // Fold in sparse (skip-worktree) files when the "Show Sparse Files" option is
    // on. `listAllFiles` drops them, so they're only searchable via the separate
    // sparse list; tracked in `sparseSet` so their rows get the "(sparse)" badge
    // even in directories the user never expanded.
    const sparseSet = new Set<string>();
    if (this.showSparseFiles && this.treeSparseFiles) {
      for (const path of this.treeSparseFiles) {
        allPaths.add(path);
        sparseSet.add(path);
      }
    }

    // The user may have kept typing / cleared while the fetch was in flight
    // (including the submodule fetch just awaited above).
    if (this.treeFilter.value.trim().toLowerCase() !== q) return;

    const matches = [...allPaths].filter((p) => p.toLowerCase().includes(q));
    matches.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

    this.treeFilterOverlay.innerHTML = "";
    this.treeSelected = null;
    if (!matches.length) {
      this.treeFilterOverlay.appendChild(el("div", "tree-empty", "No matching files."));
      return;
    }

    const rowMeta = this.collectTreeRowMeta();
    const frag = document.createDocumentFragment();
    const MAX = 500; // cap so a broad query can't render tens of thousands of rows
    const shown = matches.slice(0, MAX);
    const fileRows: { rowEl: HTMLElement; path: string }[] = [];
    for (const path of shown) {
      const rowEl = this.buildFilterRow(path, deletedSet.has(path), rowMeta, sparseSet.has(path));
      frag.appendChild(rowEl);
      fileRows.push({ rowEl, path });
    }
    this.treeFilterOverlay.appendChild(frag);
    if (matches.length > MAX) {
      this.treeFilterOverlay.appendChild(
        el("div", "tree-empty", `Showing first ${MAX} of ${matches.length} matches — refine the filter.`),
      );
    }

    // The filter re-rendered the rows from scratch, so reassert the "(opened)"
    // badge on the open file's row if it survived the filter.
    if (this.filePath) this.updateTreeOpenedBadge(this.filePath);

    // Revision counts from cache only: no per-file git calls for search results
    // to avoid spawning hundreds of git processes that slow subsequent operations.
    for (const { rowEl, path } of fileRows) {
      const dirPart = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
      const namePart = path.split("/").pop() ?? path;
      const cached = this.treeDirCache.get(dirPart);
      if (cached) {
        const count = cached.counts.get(namePart) ?? 0;
        insertTreeRevCount(rowEl, count);
      }
    }
  }

  /**
   * Layer the flat filter-results overlay over the tree: hide `treeContent`,
   * reveal `treeFilterOverlay`. The tree DOM is left intact underneath.
   */
  private showFilterOverlay(): void {
    // Only capture scroll on the *first* keystroke of a filter (when the tree is
    // still the visible content); later keystrokes must not overwrite it with the
    // stale value. The tree and overlay have independent scroll containers, so the
    // tree keeps its own scrollTop untouched while the overlay is shown.
    if (!this.treeContent.classList.contains("hidden")) {
      this.treePreFilterScrollTop = this.treeContent.scrollTop;
    }
    this.treeContent.classList.add("hidden");
    this.treeFilterOverlay.classList.remove("hidden");
    this.treeFilterOverlay.scrollTop = 0;
  }

  /**
   * Tear down the filter overlay: hide and empty it, then reveal the untouched
   * tree. Clears `treeSelected` since it may have pointed at an overlay row.
   */
  private hideFilterOverlay(): void {
    this.treeFilterOverlay.classList.add("hidden");
    this.treeFilterOverlay.innerHTML = "";
    this.treeContent.classList.remove("hidden");
    // Restore the scroll position the tree had before the filter took over; the
    // tree DOM is unchanged, so its previous scrollTop is still valid.
    this.treeContent.scrollTop = this.treePreFilterScrollTop;
    if (this.treeSelected && !this.treeSelected.isConnected) this.treeSelected = null;
  }

  /**
   * Fully reset filter state when the tree is (re)built or the repo changes:
   * clear the filter input and tear down the overlay so no stale query or results
   * carry over into the fresh tree. Guarded so it is safe to call before the DOM
   * is constructed (early repo-switch paths).
   */
  private resetTreeFilterState(): void {
    if (this.treeFilter) this.treeFilter.value = "";
    if (this.treeFilterClearBtn) this.treeFilterClearBtn.disabled = true;
    if (this.treeFilterOverlay) {
      this.treeFilterOverlay.classList.add("hidden");
      this.treeFilterOverlay.innerHTML = "";
    }
    if (this.treeContent) this.treeContent.classList.remove("hidden");
  }

  /**
   * Full HEAD file lists for every expanded submodule, each entry prefixed with
   * the submodule's repo-relative path so it is main-repo-relative like the rest
   * of the search set. Results are cached per submodule (`treeSubmoduleFiles`) so
   * repeated keystrokes don't re-run `ls-files` in each submodule.
   */
  private async collectSubmoduleFiles(): Promise<string[]> {
    const out: string[] = [];
    for (const [subPath, backend] of this.treeSubmoduleBackends) {
      let files = this.treeSubmoduleFiles.get(subPath);
      if (!files) {
        try {
          const raw = await backend.listAllFiles();
          files = raw.map((f) => (subPath ? `${subPath}/${f}` : f));
        } catch {
          files = [];
        }
        this.treeSubmoduleFiles.set(subPath, files);
      }
      for (const f of files) out.push(f);
    }
    return out;
  }

  /**
   * Render best-effort filter matches from what is already known locally while
   * the full HEAD file list is still being fetched: the file rows currently in
   * the DOM (from expanded directories) plus any deleted files discovered in the
   * per-directory cache. A "Loading full file list…" hint sits below the results
   * so the user knows more may appear; `startBackgroundAllFiles`'s completion
   * re-runs the filter with the complete list.
   */
  private renderPartialFilterResults(q: string): void {
    // Collect known file paths from the live tree rows (which stay intact under
    // the overlay). Track which are deleted so the flat rows are badged correctly
    // (the full HEAD list isn't in yet, so membership can't be used to infer it).
    const known = new Set<string>();
    const deletedSet = new Set<string>();
    for (const row of Array.from(this.treeContent.querySelectorAll<HTMLElement>(".tree-node"))) {
      if (row.dataset.dir === "true") continue;
      const p = row.dataset.path;
      if (!p) continue;
      known.add(p);
      if (row.dataset.deleted === "true") deletedSet.add(p);
    }
    if (this.showDeletedFiles) {
      for (const [dir, info] of this.treeDirCache) {
        const prefix = dir ? dir + "/" : "";
        for (const name of info.deleted) {
          const full = prefix + name;
          known.add(full);
          deletedSet.add(full);
        }
      }
    }
    // Any submodule file lists already cached from a prior filter pass. No fetch
    // here to keep this pre-load fast path synchronous; the full merge (with
    // fetch) happens in filterTree once the main list arrives. These are live.
    for (const files of this.treeSubmoduleFiles.values()) {
      for (const f of files) known.add(f);
    }
    // Fold in the sparse list if it was warmed early (it loads under the same
    // token as `treeAllFiles`, so it may be ready before the main list). Tracked
    // so rows from unexpanded directories still get the "(sparse)" badge.
    const sparseSet = new Set<string>();
    if (this.showSparseFiles && this.treeSparseFiles) {
      for (const path of this.treeSparseFiles) {
        known.add(path);
        sparseSet.add(path);
      }
    }

    const matches = [...known].filter((p) => p.toLowerCase().includes(q));
    matches.sort((a, b) => a.toLowerCase().localeCompare(b.toLowerCase()));

    this.treeFilterOverlay.innerHTML = "";
    this.treeSelected = null;

    const rowMeta = this.collectTreeRowMeta();
    const MAX = 500;
    const frag = document.createDocumentFragment();
    for (const path of matches.slice(0, MAX)) {
      frag.appendChild(this.buildFilterRow(path, deletedSet.has(path), rowMeta, sparseSet.has(path)));
    }
    this.treeFilterOverlay.appendChild(frag);

    const hint = el("div", "tree-loading-row");
    hint.appendChild(el("span", "tree-loading-text", "Loading full file list…"));
    this.treeFilterOverlay.appendChild(hint);

    if (this.filePath) this.updateTreeOpenedBadge(this.filePath);
  }

  private buildAboutModal(): HTMLDivElement {
    const modal = el("div", "about-modal hidden");
    const overlay = el("div", "modal-overlay");
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) this.closeAboutModal();
    });

    const dialog = el("div", "modal-dialog about-dialog");
    const header = el("div", "modal-header");
    header.appendChild(el("h3", undefined, "About Git Time-Lapse View"));
    const closeBtn = el("button", "modal-close", "×");
    closeBtn.addEventListener("click", () => this.closeAboutModal());
    header.appendChild(closeBtn);
    dialog.appendChild(header);

    const body = el("div", "modal-body about-body");
    body.appendChild(el("div", "about-app-name", "Git Time-Lapse View"));
    const version = typeof __APP_VERSION__ !== "undefined" ? __APP_VERSION__ : "dev";
    const commit = typeof __SOURCE_COMMIT__ !== "undefined" ? __SOURCE_COMMIT__ : "dev";
    body.appendChild(el("div", "about-version", `Version ${version} (${commit})`));
    body.appendChild(el("div", "about-author", "by Advanced Micro Devices, Inc."));
    dialog.appendChild(body);

    const footer = el("div", "modal-footer");
    const okBtn = el("button", undefined, "OK");
    okBtn.addEventListener("click", () => this.closeAboutModal());
    footer.appendChild(okBtn);
    dialog.appendChild(footer);

    overlay.appendChild(dialog);
    modal.appendChild(overlay);
    return modal;
  }

  private openAboutModal(): void {
    this.aboutModal.classList.remove("hidden");
    const dialog = this.aboutModal.querySelector<HTMLElement>(".modal-dialog");
    if (dialog) {
      dialog.style.left = `${(window.innerWidth - dialog.offsetWidth) / 2}px`;
      dialog.style.top = `${(window.innerHeight - dialog.offsetHeight) / 2}px`;
    }
  }

  private closeAboutModal(): void {
    this.aboutModal.classList.add("hidden");
  }

  // =======================================================================
  // Ref switcher (experimental)
  // =======================================================================

  private buildRefBanner(): HTMLDivElement {
    // Never hidden: it reserves its own row height at all times so appearing
    // or changing cannot shift the scrubber and everything below it.
    this.refBanner = el("div", "ref-banner is-empty") as HTMLDivElement;
    this.refBanner.textContent = this.REF_BANNER_EMPTY;
    // Clicking the label is a shortcut to the same dialog as the menu item.
    // `is-empty` suppresses the affordance while there is nothing to switch.
    this.refBanner.addEventListener("click", () => {
      if (this.refBanner.classList.contains("is-empty")) return;
      this.openRefModal();
    });
    return this.refBanner;
  }

  /** The backend describing what is currently on screen. Repo browsing keeps
   *  its backend in `treeBackend`; only file views populate `backend`. */
  private activeBackend(): Backend | null {
    return this.backend ?? this.treeBackend ?? null;
  }

  /**
   * Show which ref the current view is based on. Hidden until something is
   * open, since there is nothing to describe before that.
   */
  private bannerEl(): HTMLDivElement | null {
    if (this.refBanner && this.refBanner.isConnected) return this.refBanner;
    const live = this.tabContentArea?.querySelector<HTMLDivElement>(".ref-banner");
    if (live) this.refBanner = live;
    return live ?? this.refBanner ?? null;
  }

  /**
   * Refresh the autocomplete candidates.
   *
   * Called only where the whole tree or a file is actually (re)loaded --
   * populateTree, loadFile, loadDeletedFile -- and never from the dialog.
   * Deliberately NOT called from:
   *   - loadDir, which expands one directory: no refs can have changed
   *   - restoreTabState, which restores a tab's own cached list
   *   - openRepoAt / applyRef, which reach populateTree or loadFile anyway
   * `for-each-ref` is ~0.36s on a 23k-ref repo, so a stray call per directory
   * expansion or tab switch would be very noticeable.
   *
   * A failure leaves the previous list in place: if we could not refresh the
   * file list, we should not drop the refs either -- stale beats empty.
   */
  private async refreshRefList(): Promise<void> {
    const backend = this.activeBackend();
    if (!backend) return;
    try {
      const refs = await backend.listRefs();
      if (refs.length) this.refList = refs;
    } catch {
      // keep whatever we had
    }
  }

  private async refreshRefBanner(): Promise<void> {
    const el = this.bannerEl();
    if (!el) return;
    const backend = this.activeBackend();
    if (!backend || (!this.filePath && !this.treeRepoRoot)) {
      el.textContent = this.REF_BANNER_EMPTY;
      el.classList.add("is-empty");
      el.removeAttribute("title");
      return;
    }
    // "name (hash)" when the ref has a name worth showing, bare "hash" when it
    // is only a commit. Falls back to the raw ref string if the lookup fails.
    let shown = this.viewRef;
    try {
      const res = await backend.resolveRef(this.viewRef);
      if (res.ok) {
        shown = res.label && res.hash ? `${res.label} (${res.hash})`
              : res.hash || res.label || this.viewRef;
      }
    } catch {
      // An older backend without resolveRef: fall back to the raw ref.
    }
    // Re-resolve: the await above can span a tab switch.
    const target = this.bannerEl() ?? el;
    target.textContent = `Currently viewing based on ${shown}`;
    target.classList.remove("is-empty");
    target.title = "Switch to a different commit or branch";
  }

  private buildRefModal(): HTMLDivElement {
    const modal = el("div", "ref-modal hidden") as HTMLDivElement;
    const overlay = el("div", "modal-overlay");
    overlay.addEventListener("click", (e) => {
      if (e.target === overlay) this.closeRefModal();
    });

    const dialog = el("div", "modal-dialog ref-dialog");
    const header = el("div", "modal-header");
    header.appendChild(el("h3", undefined, "Switch to Commit or Branch"));
    const closeBtn = el("button", "modal-close", "×");
    closeBtn.addEventListener("click", () => this.closeRefModal());
    header.appendChild(closeBtn);
    dialog.appendChild(header);

    const body = el("div", "modal-body");
    body.appendChild(el("div", undefined,
      "Branch name, tag, or commit hash. Leave empty for HEAD (the checked-out branch)."));
    // The field and its suggestion list share a relatively-positioned wrapper
    // so the list can be pinned to exactly the field's width. A native
    // <datalist> was tried first: its popup is drawn by the webview, is not
    // styleable, and would not take the field's width.
    const wrap = el("div", "ref-input-wrap");
    const input = document.createElement("input");
    input.type = "text";
    input.className = "ref-input";
    input.placeholder = "HEAD";
    input.autocomplete = "off";
    input.spellcheck = false;
    this.refSuggest = el("div", "ref-suggest hidden") as HTMLDivElement;

    input.addEventListener("input", () => {
      this.refError.classList.add("hidden");
      this.openSuggest(input.value);
    });
    input.addEventListener("focus", () => this.openSuggest(input.value));
    input.addEventListener("blur", () => {
      // Delayed so a mousedown on an item is processed before the list goes.
      window.setTimeout(() => this.closeSuggest(), 120);
    });
    input.addEventListener("keydown", (e) => {
      const open = !this.refSuggest.classList.contains("hidden");
      if (e.key === "ArrowDown" || e.key === "ArrowUp") {
        if (!open) { this.openSuggest(input.value); return; }
        e.preventDefault();
        this.moveSuggest(e.key === "ArrowDown" ? 1 : -1);
        return;
      }
      if (e.key === "Enter") {
        e.preventDefault();
        // Enter accepts a highlighted suggestion into the field; a second
        // Enter performs the switch. Never switch straight off a highlight,
        // which would make a stray arrow key change what is being viewed.
        if (open && this.refSuggestIndex >= 0) {
          this.acceptSuggest(this.refSuggestIndex);
          return;
        }
        void this.applyRef();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        // Escape closes the list first, the dialog only once it is closed.
        if (open) this.closeSuggest();
        else this.closeRefModal();
      }
    });

    this.refSuggest.addEventListener("mousedown", (e) => {
      const row = (e.target as HTMLElement).closest<HTMLElement>(".ref-suggest-item");
      if (!row || !row.dataset.index) return;
      e.preventDefault();   // keep focus in the field
      this.acceptSuggest(parseInt(row.dataset.index, 10));
    });

    wrap.appendChild(input);
    body.appendChild(wrap);
    this.refInput = input;
    dialog.appendChild(body);

    const footer = el("div", "modal-footer ref-footer");
    this.refError = el("div", "ref-error hidden") as HTMLDivElement;
    this.refError.textContent = "Branch/tag/commit does not exist";
    footer.appendChild(this.refError);
    const okBtn = el("button", undefined, "Switch");
    okBtn.addEventListener("click", () => void this.applyRef());
    const cancelBtn = el("button", undefined, "Cancel");
    cancelBtn.addEventListener("click", () => this.closeRefModal());
    footer.appendChild(cancelBtn);
    footer.appendChild(okBtn);
    dialog.appendChild(footer);

    overlay.appendChild(dialog);
    modal.appendChild(overlay);
    // Appended to the modal root rather than beside the field. The field's
    // container scrolls and clips; a fixed-position sibling of the dialog is
    // clipped by nothing and simply floats above it.
    modal.appendChild(this.refSuggest);
    return modal;
  }

  /** Opened by clicking the viewing label, which is the only entry point. */
  private openRefModal(): void {
    if (!this.activeBackend() || (!this.filePath && !this.treeRepoRoot)) {
      this.deps.host.showError("Open a file or repository first, then switch the commit or branch it is viewed from.");
      return;
    }
    this.refError.classList.add("hidden");
    this.closeSuggest();
    this.refModal.classList.remove("hidden");
    this.refInput.value = this.viewRef === "HEAD" ? "" : this.viewRef;
    const dialog = this.refModal.querySelector<HTMLElement>(".modal-dialog");
    if (dialog) {
      dialog.style.left = `${(window.innerWidth - dialog.offsetWidth) / 2}px`;
      dialog.style.top = `${(window.innerHeight - dialog.offsetHeight) / 2}px`;
    }
    this.refInput.focus();
    this.refInput.select();
  }

  /** Cap on rendered suggestions. A repo can have tens of thousands of
   *  remote-tracking refs; narrowing the prefix is what finds the rest. */
  private readonly REF_SUGGEST_MAX = 100;

  /**
   * Show refs that START WITH what has been typed, in grouped order --
   * branches, tags, then remotes. Prefix rather than substring is deliberate:
   * substring matching surfaced unrelated refs ahead of the obvious one.
   */
  private openSuggest(filterText: string): void {
    const needle = filterText.trim().toLowerCase();
    this.refSuggestMatches = [];
    for (const ref of this.refList) {
      if (needle && !ref.name.toLowerCase().startsWith(needle)) continue;
      this.refSuggestMatches.push(ref);
      if (this.refSuggestMatches.length >= this.REF_SUGGEST_MAX) break;
    }
    this.refSuggestIndex = -1;
    this.refSuggest.innerHTML = "";
    if (!this.refSuggestMatches.length) { this.closeSuggest(); return; }
    this.refSuggestMatches.forEach((ref, i) => {
      const row = el("div", "ref-suggest-item");
      row.dataset.index = String(i);
      row.appendChild(el("span", "ref-suggest-name", ref.name));
      row.appendChild(el("span", "ref-suggest-kind", ref.kind));
      this.refSuggest.appendChild(row);
    });
    this.positionSuggest();
    this.refSuggest.classList.remove("hidden");
  }

  /** Pin the list to the field's on-screen box. Recomputed on every open
   *  because the dialog can be moved and resized underneath it. */
  private positionSuggest(): void {
    const r = this.refInput.getBoundingClientRect();
    this.refSuggest.style.left = `${r.left}px`;
    this.refSuggest.style.top = `${r.bottom}px`;
    this.refSuggest.style.width = `${r.width}px`;
  }

  private closeSuggest(): void {
    this.refSuggest.classList.add("hidden");
    this.refSuggestIndex = -1;
  }

  private moveSuggest(delta: number): void {
    const n = this.refSuggestMatches.length;
    if (!n) return;
    this.refSuggestIndex = (this.refSuggestIndex + delta + n + 1) % (n + 1) - 1;
    if (this.refSuggestIndex < 0) this.refSuggestIndex = delta > 0 ? 0 : n - 1;
    const rows = this.refSuggest.querySelectorAll<HTMLElement>(".ref-suggest-item");
    rows.forEach((r, i) => r.classList.toggle("active", i === this.refSuggestIndex));
    rows[this.refSuggestIndex]?.scrollIntoView({ block: "nearest" });
  }

  private acceptSuggest(index: number): void {
    const ref = this.refSuggestMatches[index];
    if (!ref) return;
    this.refInput.value = ref.name;
    this.refError.classList.add("hidden");
    this.closeSuggest();
    this.refInput.focus();
  }

  private closeRefModal(): void {
    // The list is a child of the modal so display:none already hides it, but
    // clear the highlight so reopening does not restore a stale selection.
    this.closeSuggest();
    this.refModal.classList.add("hidden");
  }

  /**
   * Re-open the current file with the history walked from a different ref.
   * loadFile() is reused wholesale, with `force` set because the path has not
   * changed and it would otherwise short-circuit as "same file".
   */
  private async applyRef(): Promise<void> {
    const wanted = this.refInput.value.trim() || "HEAD";
    const previous = this.viewRef;
    // Repo mode has no open file; the ref applies to the repository being
    // browsed instead. Capture both before the modal closes.
    const filePath = this.filePath;
    const repoRoot = this.treeRepoRoot;
    const backend = this.activeBackend();
    if (!backend || (!filePath && !repoRoot)) return;

    // Typed the ref we are already on: nothing to do, and reloading would
    // throw away scroll position and the warmed cache for no gain.
    if (wanted === previous) {
      this.closeRefModal();
      return;
    }

    // Validate before tearing the view down. This is unconditional: skipping
    // it when a backend looked absent is what previously let a bad ref through
    // to the reload, where it surfaced as a popup and left viewRef poisoned.
    let resolved: { ok: boolean; label: string; hash: string } | null = null;
    try {
      resolved = await backend.resolveRef(wanted);
    } catch {
      resolved = null;
    }
    if (!resolved || !resolved.ok) {
      this.refError.classList.remove("hidden");
      this.refInput.focus();
      this.refInput.select();
      return;
    }

    // Different spelling, same commit -- e.g. the hash of the branch already
    // being viewed. Also a no-op: the view would be byte-identical. viewRef is
    // deliberately left alone so it stays consistent with the backend that was
    // built from it.
    try {
      const current = await backend.resolveRef(previous);
      if (current.ok && current.hash && current.hash === resolved.hash) {
        this.closeRefModal();
        return;
      }
    } catch {
      // Cannot compare; fall through and reload rather than skip wrongly.
    }

    this.closeRefModal();
    this.viewRef = wanted;
    let failed = false;
    try {
      if (filePath) {
        await this.loadFile(filePath, false, true);
        failed = !this.commits.length;
      } else {
        await this.openRepoAt(repoRoot);
        // openRepoAt reports its own errors and does not rethrow, so success
        // has to be read off the resulting state rather than caught.
        failed = this.treeRepoRoot !== repoRoot;
      }
    } catch {
      failed = true;
    }

    if (failed) {
      // Never leave viewRef pointing at something that would not load: every
      // later open reuses it, so one bad switch would otherwise break the
      // session until restart.
      this.viewRef = previous;
      this.deps.host.showError(
        `Could not switch to '${wanted}'. Reverting to ${previous}.`);
      if (filePath) await this.loadFile(filePath, false, true);
      else await this.openRepoAt(repoRoot);
    }
    await this.refreshRefBanner();
  }

  // =======================================================================
  // Zoom
  // =======================================================================

  private zoomIn(): void {
    this.setFontSize(this.fontSize + 1);
  }

  private zoomOut(): void {
    this.setFontSize(this.fontSize - 1);
  }

  private resetZoom(): void {
    this.setFontSize(this.FONT_DEFAULT);
  }

  private setFontSize(size: number): void {
    const clamped = Math.max(this.FONT_MIN, Math.min(this.FONT_MAX, size));
    if (clamped === this.fontSize) return;
    // Keep the same top row anchored across the zoom by remembering it against
    // the OLD line height, then restoring scrollTop against the NEW one.
    const topBlock = Math.round(this.codeArea.scrollTop / this.lineH());
    this.fontSize = clamped;
    this.applyFontSize();
    this.reflowVirtual(topBlock);
    this.renderHistory(this.history);
    this.savePreferences();
  }

  private applyFontSize(): void {
    document.documentElement.style.setProperty("--code-size", `${this.fontSize}px`);
  }

  /**
   * Re-lay out the virtual scroll after the row height changes (zoom): resize
   * the code/gutter containers to the new total height, restore scroll to the
   * anchored top row, and repaint the window at the new positions.
   */
  private reflowVirtual(topBlock: number): void {
    if (!this.rows.length) return;
    const lh = this.lineH();
    const totalH = `${this.rows.length * lh}px`;
    this.codeLines.style.height = totalH;
    this.gutterAuthor.style.height = totalH;
    this.gutterLifetime.style.height = totalH;
    this.gutterLineno.style.height = totalH;
    this.codeArea.scrollTop = topBlock * lh;
    // Force a repaint: absolute `top` on every rendered row must be recomputed.
    this.renderedStart = 0;
    this.renderedEnd = 0;
    this.renderWindow(true);
  }

  /**
   * Pixel height of one code/gutter row at the current zoom. Matches the CSS
   * `calc(var(--code-size) * 1.35)`, so scroll math stays accurate as the font
   * size changes.
   */
  private lineH(): number {
    return this.fontSize * 1.35;
  }

  private bindFocusReload(): void {
    window.addEventListener("focus", () => {
      void this.checkForChanges();
    });
    document.addEventListener("visibilitychange", () => {
      if (document.visibilityState === "visible") {
        void this.checkForChanges();
      }
    });
  }

  private async checkForChanges(): Promise<void> {
    const treeBackend = this.treeBackend ?? this.backend;
    if ((!this.backend || !this.filePath) && !(this.treeLoaded && treeBackend)) return;
    const now = Date.now();
    if (now - this.lastFocusCheck < 2000) return;
    this.lastFocusCheck = now;

    if (this.backend && this.filePath) {
      try {
        const [currentHash, modState] = await Promise.all([
          this.backend.getLatestCommitHash(),
          this.backend.getFileModifiedState(),
        ]);
        const commitChanged = currentHash && currentHash !== this.lastKnownCommitHash;
        const modChanged = modState !== this.lastKnownModifiedState;
        if (commitChanged || modChanged) {
          this.lastKnownCommitHash = currentHash;
          this.lastKnownModifiedState = modState;
          await this.loadFile(this.filePath, false, true);
        }
      } catch {
        // ignore: can't check, don't reload
      }
    }

    // Refresh tree modified-file badges if the tree is loaded.
    if (this.treeLoaded && treeBackend) {
      try {
        const newModified = await treeBackend.listModifiedFiles();
        if (!setsEqual(this.treeModifiedFiles, newModified)) {
          this.treeModifiedFiles = newModified;
          // refreshTreeBadges rebuilds each row's combined badge from its derived
          // flags, which already includes the opened label, so no reassert is needed.
          this.refreshTreeBadges();
        }
      } catch {
        // ignore: can't refresh badges
      }
    }
  }

  /**
   * Walk the rendered tree rows and reconcile each file row's combined badge
   * against the current `treeModifiedFiles` set. Directory rows are skipped. The
   * `tree-modified` class is toggled and the combined badge is rebuilt from the
   * row's derived flags, so the modified label appears in its correct position
   * relative to any sparse/deleted/opened labels.
   */
  private refreshTreeBadges(): void {
    const nodes = [
      ...Array.from(this.treeContent.querySelectorAll<HTMLElement>(".tree-node")),
      ...Array.from(this.treeFilterOverlay.querySelectorAll<HTMLElement>(".tree-node")),
    ];
    nodes.forEach((node) => {
      const path = node.dataset.path;
      if (!path || node.dataset.dir === "true") return;
      const isModified = this.treeModifiedFiles.has(path);
      const hadModified = node.classList.contains("tree-modified");
      if (isModified === hadModified) return;
      node.classList.toggle("tree-modified", isModified);
      renderTreeBadges(
        node,
        treeBadgeFlagsFor(node, this.treeModifiedFiles, this.treeOpenedPath),
      );
    });
  }

  private bindGlobalKeys(): void {
    document.addEventListener("keydown", (e) => {
      const ctrl = e.ctrlKey || e.metaKey;
      if (ctrl && e.shiftKey && e.key.toLowerCase() === "o") { e.preventDefault(); void this.onMenuOpenFileInNewTab(); return; }
      if (ctrl && e.key.toLowerCase() === "o") { e.preventDefault(); void this.onOpenClicked(); return; }
      if (ctrl && e.shiftKey && e.key.toLowerCase() === "r") { e.preventDefault(); void this.onMenuOpenRepoInNewTab(); return; }
      if (ctrl && e.key.toLowerCase() === "r") { e.preventDefault(); void this.onMenuOpenRepo(); return; }
      if (ctrl && e.key.toLowerCase() === "t") { e.preventDefault(); this.createTab(); return; }
      if (ctrl && e.key.toLowerCase() === "w") { e.preventDefault(); this.closeTab(this.activeTabId); return; }
      if (ctrl && e.key.toLowerCase() === "q") { e.preventDefault(); void this.deps.host.close(); return; }
      if (ctrl && e.key.toLowerCase() === "d") { e.preventDefault(); this.toggleDarkLight(); return; }
      // Desktop only: Ctrl+Shift+F is Find in Files in both IDE hosts, and they
      // see the key too. `isVSCode` is set by the Visual Studio host as well.
      if (ctrl && e.shiftKey && e.key.toLowerCase() === "f" && !this.deps.host.isVSCode) {
        e.preventDefault();
        this.toggleHistoryMode();
        return;
      }
      if (ctrl && e.key.toLowerCase() === "f") { e.preventDefault(); this.openSearch(); return; }
      // Find-again. Without this the key reaches the host webview, which opens
      // its own find bar -- one that starts empty and, because the code view is
      // virtualised, can only see the rows currently in the DOM. Ctrl+G is
      // deliberately not bound as a synonym: inside the VS Code webview it is
      // that editor's Go to Line.
      if (e.key === "F3") { e.preventDefault(); this.findAgain(e.shiftKey === false); return; }
      // Zoom: Ctrl/Cmd with + / = (in), - (out), 0 (reset).
      if (ctrl && (e.key === "=" || e.key === "+")) { e.preventDefault(); this.zoomIn(); return; }
      if (ctrl && (e.key === "-" || e.key === "_")) { e.preventDefault(); this.zoomOut(); return; }
      if (ctrl && e.key === "0") { e.preventDefault(); this.resetZoom(); return; }
      if (e.key === "Escape") { this.closeSearch(); return; }
      const tag = (e.target as HTMLElement)?.tagName;
      const inField = tag === "INPUT" || tag === "SELECT" || tag === "TEXTAREA";
      if (!this.slider.disabled && !inField) {
        // Left/Right step revisions; Up/Down jump between changed chunks (same
        // as the ▲/▼ buttons). Home/End are intentionally left unhandled so they
        // scroll the code area to top/bottom as usual. preventDefault on the
        // arrows stops them from scrolling the code area.
        if (e.key === "ArrowLeft") { e.preventDefault(); this.stepRangeEnd(-1); }
        else if (e.key === "ArrowRight") { e.preventDefault(); this.stepRangeEnd(1); }
        else if (e.key === "ArrowUp") { e.preventDefault(); this.onPrevChunk(); }
        else if (e.key === "ArrowDown") { e.preventDefault(); this.onNextChunk(); }
      }
    });
  }

  // =======================================================================
  // Preferences
  // =======================================================================

  private async loadPreferences(): Promise<void> {
    const config = await this.deps.host.loadConfig();
    this.loadingPrefs = true;
    try {
      this.setThemeById(config.theme || DEFAULT_LIGHT_THEME_ID);
      this.coloring = (config.coloring as ColoringMode) || "diff";
      this.modeCombo.value = this.coloring;
      this.gutterMode = (config.gutter as GutterMode) || "revision";
      this.gutterCombo.value = this.gutterMode;
      this.showDetails = !!config.show_details;
      this.showBlame = !!config.show_blame;
      this.showLineno = !!config.show_lineno;
      this.showLifetimes = !!config.show_lifetimes;
      this.lifetimesBtn.classList.toggle("active", this.showLifetimes);
      this.showSparseFiles = !!config.show_sparse_files;
      this.showDeletedFiles = config.show_deleted_files !== false;
      this.historyChangesOnly = !!config.history_changes_only;
      const tph = Number(config.tree_panel_height);
      if (Number.isFinite(tph) && tph >= 80) this.treePanelHeight = tph;
      this.treePanel.style.height = `${this.treePanelHeight}px`;
      this.blameFormat = config.blame_format || "full";
      const w = Number(config.gutter_width);
      this.gutterWidth = Number.isFinite(w) ? Math.max(40, Math.min(400, w)) : 120;
      const fs = Number(config.font_size);
      this.fontSize = Number.isFinite(fs)
        ? Math.max(this.FONT_MIN, Math.min(this.FONT_MAX, fs))
        : this.FONT_DEFAULT;
      this.precacheWorkers = typeof config.precache_workers === "number" ? config.precache_workers : null;
      if (config.browse_mode === "file" || config.browse_mode === "repo") {
        this.modeToggle.value = config.browse_mode;
        this.browseBtn.textContent = config.browse_mode === "repo" ? "Browse Repo..." : "Browse File...";
        this.pathField.placeholder = config.browse_mode === "repo"
          ? "Path to a git repository"
          : "Path to a file inside a git repository";
      }
      this.recentFiles = Array.isArray(config.recent_files)
        ? config.recent_files
            .filter((e) => e && typeof e.path === "string" && (e.mode === "file" || e.mode === "repo"))
            .slice(0, this.RECENT_MAX)
        : [];
      this.rebuildRecentMenu();
      this.syncMenuChecks();
      this.detailSplitter.classList.toggle("hidden", !this.showDetails);
      this.applyGutterWidth();
      this.applyFontSize();
    } finally {
      this.loadingPrefs = false;
    }
    this.updateChunkButtons();
    this.updateSliderVisibility();
    this.prevColoring = this.coloring;
    if (this.coloring === "blame") {
      this.gutterCombo.disabled = true;
    }
  }

  private savePreferences(): void {
    if (this.loadingPrefs) return;
    const config: AppConfig = {
      theme: this.themeId,
      coloring: this.coloring,
      gutter: this.gutterMode,
      show_details: this.showDetails,
      show_blame: this.showBlame,
      show_lineno: this.showLineno,
      show_lifetimes: this.showLifetimes,
      blame_format: this.blameFormat,
      gutter_width: this.gutterWidth,
      font_size: this.fontSize,
      precache_workers: this.precacheWorkers,
      browse_mode: this.modeToggle.value as "file" | "repo",
      show_sparse_files: this.showSparseFiles,
      show_deleted_files: this.showDeletedFiles,
      tree_panel_height: this.treePanelHeight,
      recent_files: this.recentFiles,
      history_changes_only: this.historyChangesOnly,
    };
    void this.deps.host.saveConfig(config);
  }

  /**
   * Rebuild the "Recently Opened" submenu from `this.recentFiles`. Each entry is
   * labelled "(File) name — path" or "(Repo) name — path" and reopens in the
   * matching mode. When the list is empty the submenu title is dimmed and its
   * dropdown is suppressed via the `submenu-disabled` class.
   */
  private rebuildRecentMenu(): void {
    if (!this.recentDrop) return;
    this.recentDrop.innerHTML = "";
    if (!this.recentFiles.length) {
      this.recentSubmenu?.classList.add("submenu-disabled");
      return;
    }
    this.recentSubmenu?.classList.remove("submenu-disabled");
    for (const entry of this.recentFiles) {
      const name = entry.mode === "repo" ? basename(entry.path.replace(/\/+$/, "")) : basename(entry.path);
      const prefix = entry.mode === "repo" ? "(Repo)" : "(File)";
      const item = el("div", "menu-item", `${prefix} ${name} — ${entry.path}`);
      item.title = entry.path;
      item.addEventListener("click", (e) => {
        e.stopPropagation();
        void this.openRecent(entry);
        this.closeMenus();
      });
      this.recentDrop.appendChild(item);
    }
    this.recentDrop.appendChild(el("div", "menu-separator"));
    const clearItem = el("div", "menu-item", "Clear Recent History");
    clearItem.addEventListener("click", (e) => {
      e.stopPropagation();
      this.clearRecent();
      this.closeMenus();
    });
    this.recentDrop.appendChild(clearItem);
  }

  /** Empty the recent list, persist, and rebuild the submenu (now dimmed). */
  private clearRecent(): void {
    this.recentFiles = [];
    this.rebuildRecentMenu();
    this.savePreferences();
  }

  /**
   * Push a path to the front of the recent list, deduplicating by path, capping
   * at RECENT_MAX, then persist and rebuild the submenu.
   */
  private addRecent(path: string, mode: "file" | "repo"): void {
    this.recentFiles = this.recentFiles.filter((e) => e.path !== path);
    this.recentFiles.unshift({ path, mode });
    if (this.recentFiles.length > this.RECENT_MAX) {
      this.recentFiles.length = this.RECENT_MAX;
    }
    this.rebuildRecentMenu();
    this.savePreferences();
  }

  /**
   * Reopen a recent entry: switch the mode toggle and, for a repo, spin up a
   * tree backend and populate the browser (like {@link onRepoBrowse} but without
   * the dialog); for a file, load it directly.
   */
  private async openRecent(entry: { path: string; mode: "file" | "repo" }): Promise<void> {
    if (entry.mode === "repo") {
      this.modeToggle.value = "repo";
      this.browseBtn.textContent = "Browse Repo...";
      this.pathField.placeholder = "Path to a git repository";
      const repoDir = entry.path.replace(/\\/g, "/");
      // Reset the code pane, commit panes, scrub bar, and all viewer state so
      // opening a new repo starts from a clean slate. Tree state cleared here is
      // repopulated below.
      this.clearViewer();
      try {
        const backend = await this.deps.createBackend(repoDir, repoDir, this.viewRef);
        // Drop any prior repo's tree state so a stale root/cache can't resolve
        // the next selection to a file from the previously opened repository.
        this.filePath = "";
        this.treeAllFiles = null;
        this.cancelBackgroundAllFiles();
        this.treeDirCache.clear();
        this.treeSubmoduleBackends.clear();
        this.treeSubmoduleFiles.clear();
        this.resetTreeFilterState();
        this.treeModifiedFiles = new Set();
        this.treeLoadToken++;
        this.treeContent.innerHTML = "";
        this.treeBackend = backend;
        this.treeRepoRoot = repoDir;
        this.treeLoaded = false;
        this.treeSelected = null;
        const repoWithSlash = repoDir.replace(/\/+$/, "") + "/";
        this.pathField.value = repoWithSlash;
        this.pathField.classList.add("repo-shrink");
        this.pathField.size = Math.max(8, repoWithSlash.length - 1);
        this.repoFileLabel.textContent = " ";
        this.treeTray.classList.remove("tree-disabled");
        this.treeExpanded = true;
        this.treePanel.classList.remove("hidden");
        this.treeArrow.textContent = "▼";
        this.savePreferences();
        await this.populateTree();
        this.addRecent(repoDir, "repo");
        this.updateTabLabel();
      } catch (exc) {
        this.deps.host.showError(`Not a git repository:\n\n${repoDir}\n\n${exc}`);
      }
    } else {
      this.modeToggle.value = "file";
      this.browseBtn.textContent = "Browse File...";
      this.pathField.placeholder = "Path to a file inside a git repository";
      this.collapseTree();
      this.treeTray.classList.add("tree-disabled");
      this.repoFileLabel.textContent = "";
      this.pathField.classList.remove("repo-shrink");
      this.pathField.removeAttribute("size");
      this.savePreferences();
      await this.loadFile(entry.path, false);
    }
  }

  private syncMenuChecks(): void {
    this.menuActions.details?.classList.toggle("checked", this.showDetails);
    this.menuActions.blame?.classList.toggle("checked", this.showBlame);
    this.menuActions.lineno?.classList.toggle("checked", this.showLineno);
    this.menuActions.sparse?.classList.toggle("checked", this.showSparseFiles);
    this.menuActions.deleted?.classList.toggle("checked", this.showDeletedFiles);
    this.menuActions.history?.classList.toggle("checked", this.historyMode);
    for (const fmt of ["full", "first", "last", "email"]) {
      this.menuActions[`fmt_${fmt}`]?.classList.toggle("checked", fmt === this.blameFormat);
    }
  }

  // =======================================================================
  // Menu actions
  // =======================================================================

  private toggleDetails(): void {
    this.showDetails = !this.showDetails;
    this.detailSplitter.classList.toggle("hidden", !this.showDetails);
    this.syncMenuChecks();
    this.savePreferences();
  }

  private toggleBlameGutter(): void {
    this.showBlame = !this.showBlame;
    this.syncMenuChecks();
    this.renderGutter();
    this.applyGutterWidth();
    this.savePreferences();
  }

  private toggleLineno(): void {
    this.showLineno = !this.showLineno;
    this.syncMenuChecks();
    this.renderGutter();
    this.applyGutterWidth();
    this.savePreferences();
  }

  private setBlameFormat(fmt: string): void {
    this.blameFormat = fmt;
    this.syncMenuChecks();
    this.renderGutter();
    this.savePreferences();
  }

  private toggleSparseFiles(): void {
    this.showSparseFiles = !this.showSparseFiles;
    this.syncMenuChecks();
    this.savePreferences();
    if (this.treeLoaded) void this.populateTree();
  }

  private toggleDeletedFiles(): void {
    this.showDeletedFiles = !this.showDeletedFiles;
    this.syncMenuChecks();
    this.savePreferences();
    if (this.treeLoaded) void this.populateTree();
  }

  private async onEditPreferences(): Promise<void> {
    try {
      await this.deps.host.openConfigInEditor();
    } catch (exc) {
      this.deps.host.showError(`Failed to open the preferences file:\n\n${exc}`);
    }
  }

  // =======================================================================
  // File loading
  // =======================================================================

  private async onMenuOpenFile(): Promise<void> {
    this.modeToggle.value = "file";
    this.browseBtn.textContent = "Browse File...";
    this.pathField.placeholder = "Path to a file inside a git repository";
    this.collapseTree();
    this.treeTray.classList.add("tree-disabled");
    this.repoFileLabel.textContent = "";
    this.pathField.classList.remove("repo-shrink");
    this.pathField.removeAttribute("size");
    this.savePreferences();
    await this.onOpenClicked();
  }

  private async onMenuOpenRepo(): Promise<void> {
    this.modeToggle.value = "repo";
    this.browseBtn.textContent = "Browse Repo...";
    this.pathField.placeholder = "Path to a git repository";
    this.savePreferences();
    await this.onRepoBrowse();
  }

  private async onMenuOpenFileInNewTab(): Promise<void> {
    const selected = await this.deps.host.openFileDialog();
    if (typeof selected === "string") this.createTab(selected);
  }

  private async onMenuOpenRepoInNewTab(): Promise<void> {
    const dir = this.deps.host.openDirectoryDialog
      ? await this.deps.host.openDirectoryDialog()
      : await this.deps.host.openFileDialog();
    if (typeof dir !== "string" || !dir) return;
    this.createTab();
    this.modeToggle.value = "repo";
    this.browseBtn.textContent = "Browse Repo...";
    this.pathField.placeholder = "Path to a git repository";
    await this.openRepoAt(dir);
  }

  private async onOpenClicked(): Promise<void> {
    const selected = await this.deps.host.openFileDialog();
    if (typeof selected === "string") await this.loadFile(selected);
  }

  private async onRepoBrowse(): Promise<void> {
    const dir = this.deps.host.openDirectoryDialog
      ? await this.deps.host.openDirectoryDialog()
      : await this.deps.host.openFileDialog();
    if (typeof dir !== "string" || !dir) return;
    await this.openRepoAt(dir);
  }

  /**
   * Public entry point for host-driven repo opens (e.g. a VS Code / Visual
   * Studio "Open Time-Lapse View" on a directory). Switches the mode toggle to
   * Repo, updates the browse button / placeholder, then loads the tree for the
   * given directory, mirroring {@link onMenuOpenRepo} without a dialog.
   */
  async openRepo(dirPath: string): Promise<void> {
    if (!dirPath) return;
    this.modeToggle.value = "repo";
    this.browseBtn.textContent = "Browse Repo...";
    this.pathField.placeholder = "Path to a git repository";
    this.savePreferences();
    await this.openRepoAt(dirPath);
  }

  /**
   * Spin up a tree backend for `dir` and populate the browser. Shared by the
   * Browse-Repo dialog, recents, and the host-driven {@link openRepo} entry.
   */
  private async openRepoAt(dir: string): Promise<void> {
    const repoDir = dir.replace(/\\/g, "/");
    // Reset the code pane, commit panes, scrub bar, and all viewer state so
    // opening a new repo starts from a clean slate. Tree state cleared here is
    // repopulated below.
    this.clearViewer();
    try {
      const backend = await this.deps.createBackend(repoDir, repoDir, this.viewRef);
      // Fully drop any prior repo's tree state so a stale root/cache from the
      // previously opened repository can't resolve the next selection.
      this.filePath = "";
      this.treeAllFiles = null;
      this.cancelBackgroundAllFiles();
      this.treeDirCache.clear();
      this.treeSubmoduleBackends.clear();
      this.treeSubmoduleFiles.clear();
      this.resetTreeFilterState();
      this.treeModifiedFiles = new Set();
      this.treeLoadToken++;
      this.treeContent.innerHTML = "";
      this.treeBackend = backend;
      this.treeRepoRoot = repoDir;
      this.treeLoaded = false;
      this.treeSelected = null;
      const repoWithSlash = repoDir.replace(/\/+$/, "") + "/";
      this.pathField.value = repoWithSlash;
      this.pathField.classList.add("repo-shrink");
      this.pathField.size = Math.max(8, repoWithSlash.length - 1);
      this.repoFileLabel.textContent = " ";
      this.treeTray.classList.remove("tree-disabled");
      this.treeExpanded = true;
      this.treePanel.classList.remove("hidden");
      this.treeArrow.textContent = "▼";
      await this.populateTree();
      this.addRecent(repoDir, "repo");
      this.updateTabLabel();
      void this.refreshRefBanner();
    } catch (exc) {
      this.deps.host.showError(`Not a git repository:\n\n${repoDir}\n\n${exc}`);
    }
  }

  private updatePathDisplay(filePath: string): void {
    if (this.treeRepoRoot && this.modeToggle.value === "repo") {
      const repoWithSlash = this.treeRepoRoot.replace(/\/+$/, "") + "/";
      this.pathField.value = repoWithSlash;
      this.pathField.classList.add("repo-shrink");
      this.pathField.size = Math.max(8, repoWithSlash.length - 1);
      if (filePath) {
        const norm = filePath.replace(/\\/g, "/");
        const root = this.treeRepoRoot.replace(/\\/g, "/");
        this.repoFileLabel.textContent = norm.startsWith(root + "/")
          ? norm.slice(root.length + 1) : basename(filePath);
      } else {
        this.repoFileLabel.textContent = " ";
      }
    } else {
      this.pathField.value = filePath || "";
      this.repoFileLabel.textContent = "";
      this.pathField.classList.remove("repo-shrink");
      this.pathField.removeAttribute("size");
    }
  }

  private clearViewer(): void {
    this.hljsCache.clear();
    this.backend = null;
    this.commits = [];
    this.invalidateHistory();
    this.hasModifiedRev = false;
    this.modifiedBaseHex = "";
    this.filePath = "";
    this.lastKnownCommitHash = "";
    this.lastKnownModifiedState = "";
    this.currentIndex = -1;
    this.lineInfos = [];
    this.rows = [];
    this.commitRevisions.clear();
    this.selectionMode = "none";
    this.selectedBlock = null;
    this.selectedChunkStart = null;
    this.selectedChunkEnd = null;
    this.selectedLineBlock = null;
    this.stickyLineno = null;
    this.codeLines.innerHTML = "";
    this.codeLines.appendChild(el("div", "placeholder", "Open a file to begin."));
    this.gutterAuthor.innerHTML = "";
    this.gutterLifetime.innerHTML = "";
    this.gutterLineno.innerHTML = "";
    this.setDetailPlaceholder();
    this.prevDetail.classList.add("hidden");
    this.infoLabel.textContent = "No file loaded.";
    this.legendLabel.innerHTML = "";
    this.slider.disabled = true;
    this.slider.max = "0";
    this.updateMRevButton();
    this.refreshSliderLabels();
    this.updateNavButtons();
    this.hideLoading();
    this.treeLoaded = false;
    this.treeSelected = null;
    this.treeBackend = null;
    this.treeRepoRoot = "";
    this.treeAllFiles = null;
    this.cancelBackgroundAllFiles();
    this.resetTreeLoading();
    this.treeDirCache.clear();
    this.treeSubmoduleBackends.clear();
    this.treeSubmoduleFiles.clear();
    this.resetTreeFilterState();
    this.treeModifiedFiles = new Set();
    this.treeLoadToken++; // abort any in-flight lazy loads
    this.treeOpenedPath = "";
    if (this.treeContent) this.treeContent.innerHTML = "";
    this.collapseTree();
    void this.deps.host.setTitle("Git Time-Lapse View");
  }

  /**
   * Reset every piece of state tied to the currently loaded file so a freshly
   * loaded file can't inherit stale content, blame, selection, precache, or
   * virtual-scroll state from the previous one. Deliberately leaves tree state
   * (treeBackend/treeRepoRoot/treeAllFiles/treeDirCache/treeModifiedFiles/…) and
   * UI preferences (theme, coloring, gutter mode, font size, …) untouched.
   * Called at the top of loadFile/loadDeletedFile, after their early returns.
   */
  private resetFileState(): void {
    // Backend / model
    this.backend = null;
    this.commits = [];
    this.invalidateHistory();
    this.hasModifiedRev = false;
    this.modifiedBaseHex = "";
    this.currentIndex = -1;
    this.lineInfos = [];
    this.rows = [];
    this.commitRevisions.clear();
    this.lifetimeEndMap.clear();
    this.filePath = "";
    this.firstLoad = true;

    // Selection
    this.selectionMode = "none";
    this.selectedBlock = null;
    this.selectedChunkStart = null;
    this.selectedChunkEnd = null;
    this.stickyLineno = null;
    this.selectedLineBlock = null;

    // Auto-reload tracking
    this.lastKnownCommitHash = "";
    this.lastKnownModifiedState = "";

    // Precache: invalidate any in-flight run via the token so its callbacks
    // no-op, then clear the counters that feed the status bar.
    this.precacheToken++;
    this.precaching = false;
    this.precacheRemaining = 0;
    this.precacheWorkerCount = 0;

    // Search. The query is application-wide and deliberately survives a new
    // file, but the match position and the count belong to the file being
    // replaced. The count is blanked rather than recomputed because the rows
    // are not loaded yet; the next search fills it in.
    this.searchMatchIndex = -1;
    this.searchHitBlock = null;
    if (this.searchCount) this.searchCount.textContent = "";

    // Highlight cache (keyed by revIndex:rowIndex, meaningless for a new file).
    this.hljsCache.clear();

    // Virtual scroll: cancel any pending repaint and drop the rendered-window
    // bounds so renderWindow doesn't assume the cleared DOM is still valid.
    if (this.scrollRafId) {
      cancelAnimationFrame(this.scrollRafId);
      this.scrollRafId = 0;
    }
    this.renderedStart = 0;
    this.renderedEnd = 0;
    this.codeLines.innerHTML = "";
    this.gutterAuthor.innerHTML = "";
    this.gutterLifetime.innerHTML = "";
    this.gutterLineno.innerHTML = "";

    this.followRenamesActive = false;
    this.renameDetected = false;
    this.renameDetectionToken++;
    this.renameSegments = [];
    this.currentPathCommits = [];
    this.commitSegmentPath.clear();
    this.segmentBoundaries = [];
    if (this.followRenamesBtn) {
      this.followRenamesBtn.disabled = true;
      this.followRenamesBtn.classList.remove("active");
    }
  }

  /** True when `index` is the virtual "uncommitted changes" revision. */
  private isModifiedRev(index: number): boolean {
    return (
      this.hasModifiedRev &&
      index === this.commits.length - 1 &&
      this.commits[index]?.hexSha === MODIFIED_SENTINEL
    );
  }

  /**
   * If the file has uncommitted changes, append a synthetic "M" revision to
   * `this.commits` (diffed against the last real commit). Sets `hasModifiedRev`
   * and `modifiedBaseHex`. Call after `this.commits` and `this.backend` are set
   * but before wiring the slider so the slider max includes the virtual entry.
   */
  private async appendModifiedRevIfNeeded(modifiedState?: string): Promise<void> {
    this.hasModifiedRev = false;
    this.modifiedBaseHex = "";
    if (!this.backend || !this.commits.length) return;
    let modified = "";
    if (modifiedState !== undefined) {
      modified = modifiedState;
    } else {
      try {
        modified = await this.backend.getFileModifiedState();
      } catch {
        return;
      }
    }
    if (modified !== "modified") return;

    const baseHex = this.commits[this.commits.length - 1].hexSha;
    let name = "";
    let email = "";
    try {
      [name, email] = await Promise.all([
        this.backend.getGitUserName(),
        this.backend.getGitUserEmail(),
      ]);
    } catch {
      // best-effort; leave blank
    }
    const virtual: FileHistory = {
      hexSha: MODIFIED_SENTINEL,
      authorName: name,
      authorEmail: email,
      authoredDate: new Date(),
      message: "Uncommitted changes",
      summary: "Uncommitted changes",
    };
    this.commits.push(virtual);
    this.commitRevisions.set(MODIFIED_SENTINEL, this.commits.length);
    this.hasModifiedRev = true;
    this.modifiedBaseHex = baseHex;
  }

  /**
   * Normalize a caller-supplied 1-based focus line. Hosts pass whatever their
   * editor reported, so anything absent, non-numeric, or below line 1 means
   * "no line focus" rather than an error.
   */
  private normalizeFocusLine(line: number | undefined): number | null {
    if (typeof line !== "number" || !Number.isFinite(line) || line < 1) return null;
    return Math.floor(line);
  }

  /**
   * Re-focus the already-rendered view on a 1-based line: anchor it in line
   * mode, repaint the highlight, and center it. Used when a host re-opens a
   * file that is already displayed (same tab or another tab) with a line to
   * focus, where no reload happens.
   */
  private focusLineInCurrentView(lineno: number): void {
    if (!this.rows.length) return;
    this.selectionMode = "line";
    this.stickyLineno = lineno;
    const block = this.enterLineAnchor(lineno);
    this.applyColoring();
    this.centerBlock(block);
    this.updatePrevDetail();
    void this.updateNextDetail();
    this.layoutChunkHighlight();
  }

  async loadFile(filePath: string, closeOnError = true, force = false, repoDir?: string, focusLine?: number): Promise<void> {
    if (!filePath) return;
    filePath = filePath.replace(/\\/g, "/");
    const focus = this.normalizeFocusLine(focusLine);
    if (!force) {
      if (this.backend && this.filePath === filePath) {
        if (focus !== null) this.focusLineInCurrentView(focus);
        return;
      }
      const existing = this.tabs.find(
        t => t.id !== this.activeTabId && t.filePath === filePath && t.viewRef === this.viewRef,
      );
      if (existing) {
        this.switchTab(existing.id);
        if (focus !== null) this.focusLineInCurrentView(focus);
        return;
      }
    }
    // Clear all per-file state before loading so nothing carries over from the
    // previously viewed file. `filePath` is reset here and re-set once loading
    // succeeds; the early return above already captured the "same file" case.
    this.resetFileState();
    this.showLoading();
    let backend: Backend;
    let commits: FileHistory[];
    // Modified state is independent of the commit list (it only needs the file
    // path), so it's started in parallel with getCommits below and awaited here.
    let modifiedState = "";
    // git must run in a directory, not the file itself. Callers that know the
    // repo root (e.g. tree opens) pass it in; this is required for sparse-checkout
    // files whose parent dir doesn't exist on disk. Otherwise derive the parent
    // dir so `rev-parse --show-toplevel` can discover the repo root.
    const cwd = repoDir || dirname(filePath);
    try {
      backend = await this.deps.createBackend(cwd, filePath, this.viewRef);
      // Phase 2: getCommits and getFileModifiedState are independent once the
      // backend exists (modified state only needs the file path), so run them
      // concurrently. Modified state is best-effort: a failure shouldn't abort
      // loading, so it never rejects the Promise.all.
      [commits, modifiedState] = await Promise.all([
        backend.getCommits(),
        backend.getFileModifiedState().catch(() => ""),
      ]);
    } catch (exc) {
      this.clearViewer();
      if (exc instanceof BinaryFileError) {
        this.deps.host.showError(`This file appears to be binary and cannot be displayed as text:\n\n${filePath}\n\ngit-time-lapse only supports text files.`);
      } else if (exc instanceof FileNotFoundError) {
        this.deps.host.showError(`The file was not found in the repository:\n\n${exc}`);
      } else {
        this.deps.host.showError(`The selected file is not inside a Git repository, or loading failed:\n\n${filePath}\n\n${exc}`);
      }
      this.hideLoading();
      if (closeOnError) this.deps.host.close();
      return;
    }

    if (!commits.length) {
      this.clearViewer();
      this.deps.host.showError("No commits were found that touched this file.");
      this.hideLoading();
      if (closeOnError) this.deps.host.close();
      return;
    }

    // Phase 3: fetch content for the latest revision for early binary
    // validation. Blame is no longer warmed here; runPrecache (below, before
    // the initial showRevision) derives blame for all revisions from patches.
    const latestHex = commits[commits.length - 1].hexSha;
    const contentResult = await backend.getFileContent(latestHex).then(
      (content) => ({ ok: true as const, content }),
      (exc: unknown) => ({ ok: false as const, exc }),
    );
    const latestLineCount = contentResult.ok
      ? contentResult.content.split("\n").length
      : 0;

    // Binary validation. The latest commit is the common case; if it failed with
    // something other than a binary error (e.g. a deleted file whose latest
    // commit removed it), fall back to the second-to-last revision.
    if (!contentResult.ok) {
      if (contentResult.exc instanceof BinaryFileError) {
        this.clearViewer();
        this.deps.host.showError(`This file appears to be binary and cannot be displayed as text:\n\n${filePath}\n\ngit-time-lapse only supports text files.`);
        if (closeOnError) this.deps.host.close();
        return;
      }
      if (commits.length >= 2) {
        try {
          await backend.getFileContent(commits[commits.length - 2].hexSha);
        } catch (exc) {
          if (exc instanceof BinaryFileError) {
            this.clearViewer();
            this.deps.host.showError(`This file appears to be binary and cannot be displayed as text:\n\n${filePath}\n\ngit-time-lapse only supports text files.`);
            if (closeOnError) this.deps.host.close();
            return;
          }
        }
      }
    }

    this.backend = backend;
    this.commits = commits;
    this.filePath = filePath;
    this.lastKnownCommitHash = commits.length > 0 ? commits[commits.length - 1].hexSha : "";
    this.lastKnownModifiedState = modifiedState;
    commits.forEach((c, i) => this.commitRevisions.set(c.hexSha, i + 1));

    this.updatePathDisplay(filePath);
    void this.refreshRefBanner();
    void this.refreshRefList();
    void this.deps.host.setTitle(`Git Time-Lapse View — ${basename(filePath)}`);

    // Append the virtual "uncommitted changes" revision if the working tree
    // differs from HEAD, so the slider can scrub to the current file state.
    await this.appendModifiedRevIfNeeded(this.lastKnownModifiedState);

    // Only reset tree state if we don't have a tree backend (i.e., the user
    // typed a path or browsed a file, not selected from the repo tree).
    if (!this.treeBackend) {
      this.treeLoaded = false;
      this.treeSelected = null;
      this.treeRepoRoot = "";
      this.treeAllFiles = null;
      this.cancelBackgroundAllFiles();
      this.resetTreeLoading();
      this.treeDirCache.clear();
      this.treeSubmoduleBackends.clear();
      this.treeSubmoduleFiles.clear();
      this.resetTreeFilterState();
      this.treeModifiedFiles = new Set();
      this.treeLoadToken++;
    }

    this.slider.disabled = false;
    this.slider.min = "0";
    // The slider spans only real revisions; M (if present) is reached via its
    // own button, not the slider. But the initial view starts on the newest
    // revision, which is M when the working tree is dirty.
    this.slider.max = String(this.lastRealIndex());
    this.slider.value = String(this.lastRealIndex());
    this.updateMRevButton();
    this.refreshSliderLabels();

    // Seed the range handles to span the whole real history and configure the
    // dual slider bounds. updateSliderVisibility then shows whichever slider the
    // active coloring mode calls for.
    this.rangeStart = 0;
    this.rangeEnd = this.lastRealIndex();
    this.updateSliderVisibility();

    // Precache BEFORE the initial display: populateFromLog derives blame (and
    // content/diff) for every revision from patches, so showRevision below hits
    // the cache instead of running the slow `git blame --porcelain`. The loading
    // overlay stays up over the code area during precache while the status bar
    // (which lives outside the overlay) shows the "precaching, N remaining"
    // progress, so both are visible at once. Set currentIndex to the revision we're
    // about to show so refreshStatusBar (called from runPrecache) doesn't
    // early-return on the still-negative index and can render the counter against
    // the target revision. hideLoading runs after showRevision below, once the
    // content is actually painted.
    this.currentIndex = this.lastRealIndex();
    this.refreshStatusBar();
    await this.runPrecache(latestLineCount);
    await this.buildLifetimeEndMap();

    // Seed the line anchor for the initial display. resetFileState above cleared
    // selection state, so this must come after it; showRevision/showRange below
    // pick the anchor up through the normal line-mode path.
    if (focus !== null) {
      this.selectionMode = "line";
      this.stickyLineno = focus;
    }

    if (this.coloring === "range") {
      await this.showRange();
    } else {
      await this.showRevision(this.commits.length - 1);
    }
    this.hideLoading();
    this.startRenameDetection();
    this.updateNavButtons();
    this.addRecent(filePath, "file");
    this.updateTabLabel();
    this.updateTreeOpenedBadge(filePath);
    this.syncHistoryUi();
  }

  /** Index of the last real (non-virtual) revision in `this.commits`. */
  private lastRealIndex(): number {
    return this.hasModifiedRev ? this.commits.length - 2 : this.commits.length - 1;
  }

  /** Show/hide the M button based on whether a virtual M revision exists. */
  private updateMRevButton(): void {
    this.mRevBtn.classList.toggle("hidden", !this.hasModifiedRev);
  }

  // =======================================================================
  // Precaching
  // =======================================================================

  private showLoading(): void {
    this.loadingOverlay.classList.remove("hidden");
    this.codeArea.style.overflow = "hidden";
    let dots = 1;
    if (this.loadingTimer !== null) clearInterval(this.loadingTimer);
    this.loadingTimer = window.setInterval(() => {
      dots = (dots % 3) + 1;
      this.loadingOverlay.textContent = "Loading" + ".".repeat(dots);
    }, 500);
  }

  private hideLoading(): void {
    this.loadingOverlay.classList.add("hidden");
    this.codeArea.style.overflow = "";
    if (this.loadingTimer !== null) {
      clearInterval(this.loadingTimer);
      this.loadingTimer = null;
    }
  }

  /**
   * Warm the cache for every revision and resolve when done. Runs BEFORE the
   * initial showRevision so blame/content/diff are already cached (getBlame is
   * cache-only now, with no `git blame` fallback). The loading overlay stays owned
   * by the caller (loadFile/loadDeletedFile); this only drives the status-bar
   * counter. A newer load bumps precacheToken, which makes an in-flight run stop
   * updating shared state and resolve early so the caller isn't blocked.
   */
  private async runPrecache(fileLines = 0): Promise<void> {
    if (!this.backend) return;
    this.precaching = true;
    // The virtual "uncommitted changes" revision is never precached (it can
    // change on every focus return), so exclude it from the counts.
    const realCount = this.hasModifiedRev ? this.commits.length - 1 : this.commits.length;
    this.precacheRemaining = realCount;
    const cpus = typeof navigator !== "undefined" ? navigator.hardwareConcurrency : 0;
    const autoWorkers = Math.max(2, Math.floor((cpus || 16) / 2));
    // The configured (or auto-detected) worker count is the ceiling. Small files
    // with few revisions don't benefit from splitting the `git log -p` into many
    // parallel ranges (the process spawn + seed `git show` per range costs more
    // than it saves), so scale workers up with commits × lines and cap at maxWorkers.
    const maxWorkers = this.precacheWorkers ?? autoWorkers;
    const score = realCount * fileLines;
    let scaledWorkers: number;
    if (fileLines <= 0 || score >= 50000) scaledWorkers = maxWorkers;
    else if (score < 5000) scaledWorkers = 1;
    else if (score < 15000) scaledWorkers = 2;
    else scaledWorkers = 4;
    this.precacheWorkerCount = Math.min(scaledWorkers, maxWorkers);
    const token = ++this.precacheToken;
    const backend = this.backend;
    const commits = this.commits;
    const total = realCount;

    const finish = (): void => {
      if (token !== this.precacheToken) return;
      this.precaching = false;
      this.precacheRemaining = 0;
      this.refreshStatusBar();
    };

    try {
      if (backend.populateFromLog) {
        await backend.populateFromLog((done, logTotal) => {
          if (token !== this.precacheToken) return;
          this.precacheRemaining = logTotal - done;
          this.refreshStatusBar();
        }, this.precacheWorkerCount);
      } else {
        // Fallback: per-command precache with striped workers
        const CONCURRENCY = this.precacheWorkerCount;
        let cursor = total - 1;
        let done = 0;

        const worker = async (): Promise<void> => {
          while (true) {
            if (token !== this.precacheToken) return;
            const index = cursor--;
            if (index < 0) return;
            const newHex = commits[index].hexSha;
            const prevHex = index > 0 ? commits[index - 1].hexSha : "";
            await Promise.all(
              [
                backend.getFileContent(newHex),
                backend.getBlame(newHex),
                backend.getDiffDetail(prevHex, newHex),
              ].map((p) => p.catch(() => {})),
            );
            done++;
            this.precacheRemaining = total - done;
            this.refreshStatusBar();
          }
        };

        await Promise.all(Array.from({ length: CONCURRENCY }, () => worker()));
      }
    } catch {
      // Best-effort: a precache failure leaves per-command fallbacks (content/
      // diff) to serve uncached revisions; blame simply comes back empty.
    } finally {
      finish();
    }
  }

  /**
   * Build `lifetimeEndMap`: for every physical line (keyed by
   * "commitHex:originLine") ever seen in blame, the last 0-based revision index
   * at which it still appears. Runs ONCE after precache (all revisions' blame is
   * cached) so lifetimeBar can end a chunk's bar at the revision before it was
   * deleted instead of always extending to the end of history. Scans backward
   * from the last real revision: a line missing from revision N but present in
   * N+1 was deleted between them, so its lifetime ends at N+1, recorded the
   * first (latest) time we encounter it walking backward. Keying per line rather
   * than per commit keeps disjoint chunks from the same commit independent, so a
   * chunk deleted early doesn't inherit a surviving sibling chunk's later end.
   * Blame that comes back empty (cache miss) is skipped; lines only seen in
   * skipped revisions stay unmapped and lifetimeBar falls back to the last index.
   */
  private async buildLifetimeEndMap(): Promise<void> {
    if (!this.backend) return;
    this.lifetimeEndMap.clear();
    const last = this.lastRealIndex();
    if (last < 0) return;
    const token = this.precacheToken;
    const map = this.lifetimeEndMap;
    for (let idx = last; idx >= 0; idx--) {
      if (token !== this.precacheToken) return;
      const hex = this.commits[idx].hexSha;
      const segPath = this.followRenamesActive
        ? this.commitSegmentPath.get(hex)
        : undefined;
      let blame: BlameEntry[];
      try {
        blame = (segPath && segPath !== this.filePath)
          ? await this.backend.getBlameForPath!(segPath, hex)
          : await this.backend.getBlame(hex);
      } catch {
        continue;
      }
      if (blame.length === 0) continue;
      for (const entry of blame) {
        // A block's lines are contiguous in origin: line j has origin
        // entry.originLine + j. Record each so per-line lookups resolve.
        for (let j = 0; j < entry.lines.length; j++) {
          const key = this.lifetimeKey(entry.commitHex, entry.originLine + j);
          if (!map.has(key)) map.set(key, idx);
        }
      }
    }
  }

  // =======================================================================
  // Revision navigation
  // =======================================================================

  private stepRevision(delta: number): void {
    // Step off the current revision, not the slider value: when M is active the
    // slider is parked at the last real index, so arrows must advance/retreat
    // from currentIndex to cross the real↔M boundary correctly.
    this.setRevision(this.currentIndex + delta);
  }

  // In range mode, Left/Right nudge the end handle (clamped to >= start). Falls
  // back to plain revision stepping when range mode is off.
  private stepRangeEnd(delta: number): void {
    if (this.coloring !== "range") { this.stepRevision(delta); return; }
    const max = this.lastRealIndex();
    const next = Math.max(this.rangeStart, Math.min(max, this.rangeEnd + delta));
    if (next === this.rangeEnd) return;
    this.rangeEnd = next;
    this.rangeEndInput.value = String(next);
    this.layoutRangeFill();
    this.syncRevInput();
    void this.showRange();
  }

  /** Resolves once the revision is painted, for callers that act on the result. */
  private setRevision(index: number): Promise<void> {
    index = Math.max(0, Math.min(this.commits.length - 1, index));
    // The slider only spans real revisions; when landing on M leave the thumb
    // parked at the last real index (the M button reflects the active state).
    this.slider.value = String(Math.min(index, this.lastRealIndex()));
    const shown = this.showRevision(index);
    this.updateNavButtons();
    return shown;
  }

  private updateNavButtons(): void {
    const enabled = !this.slider.disabled;
    const rangeMode = this.coloring === "range";
    // Base enable/disable on the active revision (currentIndex), which can be M
    // even though the slider thumb is parked at the last real index.
    const cur = this.currentIndex;
    // The prev/next-revision arrows and direct-jump input address a single
    // revision, so they don't apply in range mode.
    this.prevRevBtn.disabled = !enabled || rangeMode || cur <= 0;
    this.nextRevBtn.disabled = !enabled || rangeMode || cur >= this.commits.length - 1;
    // Highlight the M button while the virtual revision is the active one.
    this.mRevBtn.classList.toggle("active", !rangeMode && this.isModifiedRev(cur));
    // Keep the revision input in sync. syncRevInput respects the active mode
    // and won't clobber the field while the user is editing it (it has focus).
    this.revInput.disabled = !enabled;
    this.revInput.readOnly = false;
    // The mode dropdown (rev # vs commit hash) is meaningless in range mode,
    // where the field always shows "N — M" revision numbers.
    this.revDropdownBtn.disabled = !enabled || rangeMode;
    if (!enabled || rangeMode) this.closeRevDropdown();
    this.syncRevInput();
    // Size the input to the largest revision number's digit count, plus a
    // small buffer so horizontal padding doesn't clip the number, but keep
    // room for a full 8-char commit hash. In range mode the field shows
    // "N — M", so widen it enough for two revision numbers. The inline mode
    // dropdown sits beside the input inside .rev-input-wrapper.
    const digits = Math.max(1, String(this.commits.length).length);
    const chWidth = rangeMode ? Math.max(digits * 2 + 4, 12) : Math.max(digits + 1, 10);
    this.revInput.style.width = `${chWidth}ch`;
  }

  // =======================================================================
  // Slider labels
  // =======================================================================

  private refreshSliderLabels(): void {
    const labels = this.sliderLabels;
    labels.innerHTML = "";
    // The highlight bar is a child of labels; clearing innerHTML detaches it, so
    // put it back before (re)laying it out.
    labels.appendChild(this.chunkHighlight);
    if (this.slider.disabled) return;
    const min = 0;
    const max = parseInt(this.slider.max, 10);
    if (max < min) return;
    const count = max - min + 1;
    const width = labels.clientWidth;
    if (width <= 0) return;

    const thumb = 36;
    const span = Math.max(1, width - thumb);
    const charW = 6.2;

    // The slider spans only real revisions (M lives on its own button), so a
    // single linear distribution over [min, max] matches the native
    // <input type="range"> and keeps the thumb, ticks, and labels aligned.
    const tickX = (value: number) =>
      thumb / 2 + (count <= 1 ? 0 : (value - min) / (max - min)) * span;

    // Tick marks at every real revision.
    for (let v = min; v <= max; v++) {
      const t = el("div", "tick");
      t.style.left = `${tickX(v)}px`;
      labels.appendChild(t);
    }

    const widest = this.segmentLabel(max);
    const labelW = widest.length * charW + 4;
    const perLabel = span / Math.max(1, count);
    const step = labelW <= perLabel ? 1 : Math.max(1, Math.ceil(labelW / perLabel));

    const values: number[] = [];
    if (step <= 1) {
      for (let v = min; v <= max; v++) values.push(v);
    } else {
      values.push(min);
      for (let v = min + step; v <= max; v += step) {
        if (v - min < step || max - v < step) continue;
        values.push(v);
      }
      if (values[values.length - 1] !== max) values.push(max);
    }

    for (const v of values) {
      const lab = el("div", "tick-label", this.segmentLabel(v));
      lab.style.left = `${tickX(v)}px`;
      labels.appendChild(lab);
    }

    this.layoutChunkHighlight();

    if (this.followRenamesActive && this.segmentBoundaries.length > 1) {
      for (let i = 1; i < this.segmentBoundaries.length; i++) {
        const boundaryIdx = this.segmentBoundaries[i];
        if (boundaryIdx <= 0 || boundaryIdx > max) continue;
        const marker = el("div", "tick segment-boundary");
        marker.style.left = `${tickX(boundaryIdx)}px`;
        const segPath = this.renameSegments[i - 1]?.filePath ?? "";
        marker.title = `Renamed from ${segPath}`;
        labels.appendChild(marker);
      }
    }
  }

  // Map a real-revision index to its x pixel within the labels container,
  // matching the thumb-centered geometry refreshSliderLabels uses for ticks.
  // Uses the labels' width (the highlight bar's parent) so the bar lines up with
  // the tick marks exactly, including the M-button margin adjustment.
  private sliderTickX(value: number): number {
    const max = this.lastRealIndex();
    const thumb = 36;
    const width = this.sliderLabels.clientWidth;
    const span = Math.max(1, width - thumb);
    const frac = max <= 0 ? 0 : Math.min(1, Math.max(0, value / max));
    return thumb / 2 + frac * span;
  }

  /**
   * Draw (or hide) the bar over the slider track showing how long the selected
   * chunk stays in its current form: from the revision that introduced it to
   * the last revision before it is next modified. Only meaningful in chunk
   * mode; hidden in line/none modes or when geometry isn't ready.
   */
  private layoutChunkHighlight(): void {
    const bar = this.chunkHighlight;
    if (!bar) return;

    const token = ++this.chunkHighlightToken;
    const hide = () => {
      if (token === this.chunkHighlightToken) bar.classList.add("hidden");
    };

    if (
      this.selectionMode !== "chunk" ||
      this.slider.disabled ||
      this.coloring === "range" ||
      this.selectedBlock === null
    ) {
      hide();
      return;
    }

    const block = this.selectedBlock;
    const info = block < this.rows.length ? this.rows[block].info : null;
    // A removed line has no blame in the current revision; without an origin
    // commit there is no meaningful lifetime span to draw.
    if (!info || !info.commitHex) { hide(); return; }

    const originRev = this.revisionOf(info.commitHex);
    if (originRev === undefined) { hide(); return; }
    const start = Math.min(originRev - 1, this.lastRealIndex());

    const range = this.selectedChunkLineRange();
    if (!range) { hide(); return; }

    void (async () => {
      const [nextMod] = await this.findNextModifier(range, this.currentIndex + 1);
      if (token !== this.chunkHighlightToken) return;
      const last = this.lastRealIndex();
      const end = nextMod === null ? last : Math.min(nextMod - 1, last);
      if (end < start) { bar.classList.add("hidden"); return; }
      const x1 = this.sliderTickX(start);
      const x2 = this.sliderTickX(end);
      bar.style.left = `${Math.min(x1, x2)}px`;
      bar.style.width = `${Math.max(2, Math.abs(x2 - x1))}px`;
      bar.classList.remove("hidden");
    })();
  }

  // =======================================================================
  // Range-diff slider
  // =======================================================================

  // Toggle between the single slider (+ M button) and the dual range slider,
  // syncing whichever is now active. Called from onModeChanged and on load.
  private updateSliderVisibility(): void {
    const range = this.coloring === "range";
    this.slider.parentElement?.classList.toggle("hidden", range);
    this.sliderLabels.classList.toggle("hidden", range);
    // The M button lives inside the single slider's wrap; hide it in range mode
    // (its own hidden class still governs presence when NOT in range mode).
    this.mRevBtn.classList.toggle("range-hidden", range);
    this.rangeWrap.classList.toggle("hidden", !range);
    this.rangeLabels.classList.toggle("hidden", !range);
    if (range) {
      this.syncRangeSlider();
      this.refreshRangeLabels();
    } else {
      this.refreshSliderLabels();
    }
  }

  // Set up the dual slider's bounds and values from current state. The handles
  // address real revisions only, so max is lastRealIndex().
  private syncRangeSlider(): void {
    const max = Math.max(0, this.lastRealIndex());
    const disabled = this.slider.disabled;
    for (const inp of [this.rangeStartInput, this.rangeEndInput]) {
      inp.min = "0";
      inp.max = String(max);
      inp.disabled = disabled;
    }
    this.rangeStart = Math.max(0, Math.min(max, this.rangeStart));
    this.rangeEnd = Math.max(this.rangeStart, Math.min(max, this.rangeEnd));
    this.rangeStartInput.value = String(this.rangeStart);
    this.rangeEndInput.value = String(this.rangeEnd);
    this.layoutRangeFill();
    this.syncRevInput();
  }

  // Handle a drag on either range handle, enforcing start <= end, then re-render
  // the range diff.
  private onRangeInput(which: "start" | "end"): void {
    let start = parseInt(this.rangeStartInput.value, 10);
    let end = parseInt(this.rangeEndInput.value, 10);
    if (isNaN(start)) start = this.rangeStart;
    if (isNaN(end)) end = this.rangeEnd;
    if (which === "start") {
      if (start > end) start = end;
    } else {
      if (end < start) end = start;
    }
    this.rangeStart = start;
    this.rangeEnd = end;
    this.rangeStartInput.value = String(start);
    this.rangeEndInput.value = String(end);
    this.layoutRangeFill();
    this.syncRevInput();
    void this.showRange();
  }

  // Position the fill bar between the two handles using the same thumb-centered
  // geometry as the tick marks.
  private layoutRangeFill(): void {
    if (!this.rangeFill) return;
    const x1 = this.rangeTickX(this.rangeStart);
    const x2 = this.rangeTickX(this.rangeEnd);
    this.rangeFill.style.left = `${Math.min(x1, x2)}px`;
    this.rangeFill.style.width = `${Math.max(2, Math.abs(x2 - x1))}px`;
  }

  // Map a real-revision index to its x pixel on the range slider track, matching
  // the native thumb centering used by the single slider's tick placement.
  private rangeTickX(value: number): number {
    const max = this.lastRealIndex();
    const thumb = 36;
    const width = this.rangeWrap.clientWidth;
    const span = Math.max(1, width - thumb);
    const frac = max <= 0 ? 0 : Math.min(1, Math.max(0, value / max));
    return thumb / 2 + frac * span;
  }

  // Draw tick marks and thinned labels for the dual slider, mirroring
  // refreshSliderLabels but positioned over the range track.
  private refreshRangeLabels(): void {
    const labels = this.rangeLabels;
    labels.innerHTML = "";
    if (this.slider.disabled) return;
    const min = 0;
    const max = this.lastRealIndex();
    if (max < min) return;
    const count = max - min + 1;
    const width = labels.clientWidth;
    if (width <= 0) return;

    const thumb = 36;
    const span = Math.max(1, width - thumb);
    const charW = 6.2;
    const tickX = (value: number) =>
      thumb / 2 + (count <= 1 ? 0 : (value - min) / (max - min)) * span;

    for (let v = min; v <= max; v++) {
      const t = el("div", "tick");
      t.style.left = `${tickX(v)}px`;
      labels.appendChild(t);
    }

    const widest = String(count);
    const labelW = widest.length * charW + 4;
    const perLabel = span / Math.max(1, count);
    const step = labelW <= perLabel ? 1 : Math.max(1, Math.ceil(labelW / perLabel));

    const values: number[] = [];
    if (step <= 1) {
      for (let v = min; v <= max; v++) values.push(v);
    } else {
      values.push(min);
      for (let v = min + step; v <= max; v += step) {
        if (v - min < step || max - v < step) continue;
        values.push(v);
      }
      if (values[values.length - 1] !== max) values.push(max);
    }

    for (const v of values) {
      const lab = el("div", "tick-label", this.segmentLabel(v));
      lab.style.left = `${tickX(v)}px`;
      labels.appendChild(lab);
    }

    this.layoutRangeFill();
  }

  // Render the range diff: show the END revision's content colored by the
  // accumulated diff from START to END. Reuses buildDisplay's range branch and
  // the existing diff coloring path.
  private async showRange(): Promise<void> {
    if (!this.backend || !this.commits.length) return;
    const endIndex = Math.max(0, Math.min(this.lastRealIndex(), this.rangeEnd));
    this.currentIndex = endIndex;
    const commit = this.commits[endIndex];

    this.selectedBlock = null;
    this.selectedChunkStart = null;
    this.selectedChunkEnd = null;
    this.selectedLineBlock = null;
    this.prevDetail.classList.add("hidden");

    const prevTop = Math.round(this.codeArea.scrollTop / this.lineH());
    const oldTotalLines = this.rows.length;

    let content: string;
    try {
      content = await this.backend.getFileContent(commit.hexSha);
    } catch (exc) {
      if (exc instanceof BinaryFileError) content = "<binary file — cannot display as text>";
      else if (exc instanceof FileNotFoundError) content = "<file did not exist at this revision>";
      else content = `<error reading content: ${exc}>`;
    }

    this.lineInfos = await this.fetchLineInfos(commit.hexSha);
    this.rows = await this.buildDisplay(endIndex, content);
    this.renderRows();
    this.renderGutter();

    let anchorBlock: number | null = null;
    if (this.selectionMode === "line" && this.stickyLineno !== null) {
      anchorBlock = this.enterLineAnchor(this.stickyLineno);
    }

    this.applyColoring();

    if (anchorBlock !== null) {
      this.centerBlock(anchorBlock);
    } else {
      const newTotal = this.rows.length;
      const scaledTop =
        oldTotalLines > 0 ? Math.round((prevTop / oldTotalLines) * newTotal) : prevTop;
      this.scrollToBlock(scaledTop);
    }

    const startRev = this.rangeStart + 1;
    const endRev = endIndex + 1;
    this.infoLabel.textContent =
      `Range: Rev ${startRev} → Rev ${endRev} / ${this.lastRealIndex() + 1}  |  ` +
      `${this.commits[this.rangeStart].hexSha} … ${commit.hexSha}  ` +
      `accumulated diff`;

    this.detailView.innerHTML = this.formatCommitHtml(commit, endIndex + 1);
    this.refreshStatusBar();
  }

  // =======================================================================
  // Rendering: content rows + gutter
  // =======================================================================

  /**
   * One revision's content, read the way the viewer displays it: the working
   * tree for the virtual revision, and the pre-rename path for commits that
   * predate a move. The tab's state is passed in rather than read from `this`
   * because history search keeps reading after the user switches tabs.
   */
  private async revisionContent(
    backend: Backend,
    commit: FileHistory,
    isModified: boolean,
    segPath: string | undefined,
    filePath: string,
  ): Promise<string> {
    if (isModified) return backend.getWorkingTreeContent();
    return segPath && segPath !== filePath
      ? backend.getFileContentForPath!(segPath, commit.hexSha)
      : backend.getFileContent(commit.hexSha);
  }

  private async showRevision(index: number): Promise<void> {
    if (!this.backend || index < 0 || index >= this.commits.length) return;
    const prevIndex = this.currentIndex;
    this.currentIndex = index;
    const commit = this.commits[index];

    // The line number tracked across this scrub (set when entering chunk mode,
    // held through line mode). In chunk mode we prefer the currently selected
    // row's line number in case the chunk shifted since the anchor was set.
    let trackLineno = this.stickyLineno;
    if (
      this.selectionMode === "chunk" &&
      this.selectedBlock !== null &&
      this.selectedBlock < this.rows.length &&
      this.rows[this.selectedBlock].lineno !== null
    ) {
      trackLineno = this.rows[this.selectedBlock].lineno;
    }

    this.selectedBlock = null;
    this.selectedChunkStart = null;
    this.selectedChunkEnd = null;
    this.selectedLineBlock = null;
    this.prevDetail.classList.add("hidden");

    // For "none" mode, keep roughly the same proportion of the file visible by
    // scaling the top row against the new/old line counts.
    const oldTotalLines = this.rows.length;
    const prevTop = Math.round(this.codeArea.scrollTop / this.lineH());

    const isModified = this.isModifiedRev(index);

    let content: string;
    try {
      content = await this.revisionContent(
        this.backend,
        commit,
        isModified,
        this.followRenamesActive ? this.commitSegmentPath.get(commit.hexSha) : undefined,
        this.filePath,
      );
    } catch (exc) {
      if (exc instanceof BinaryFileError) content = "<binary file — cannot display as text>";
      else if (exc instanceof FileNotFoundError) content = "<file did not exist at this revision>";
      else content = `<error reading content: ${exc}>`;
    }

    // The working tree has no git blame; approximate with the base commit's
    // blame (line numbers may shift where the working tree adds/removes lines).
    let blameHex = isModified ? this.modifiedBaseHex : commit.hexSha;
    if (!isModified && this.isSegmentBoundary(index) && index > 0) {
      blameHex = this.commits[index - 1].hexSha;
    }
    this.lineInfos = await this.fetchLineInfos(blameHex);
    this.rows = await this.buildDisplay(index, content);
    this.renderRows();
    this.renderGutter();

    // Re-establish the anchor for the new revision according to the mode.
    let anchorBlock: number | null = null;

    if (this.selectionMode === "chunk" && trackLineno !== null && this.backend) {
      // Try to follow the chunk: translate the anchored line into this revision.
      let translated: number | null = null;
      if (prevIndex >= 0 && Math.abs(prevIndex - index) === 1) {
        const oldHex = this.commits[prevIndex].hexSha;
        translated = await this.backend.translateLine(trackLineno, oldHex, commit.hexSha);
      } else {
        translated = await this.findLineByBlame(trackLineno, prevIndex);
      }

      if (translated !== null) {
        // Chunk survives: re-select it here and re-anchor to its line number.
        for (let i = 0; i < this.rows.length; i++) {
          if (this.rows[i].lineno === translated) {
            this.selectedBlock = i;
            [this.selectedChunkStart, this.selectedChunkEnd] = this.chunkBounds(i);
            this.stickyLineno = translated;
            anchorBlock = i;
            break;
          }
        }
        // Defensive: translated to a line not present as a row: fall to line mode.
        if (this.selectedBlock === null) {
          this.selectionMode = "line";
          this.stickyLineno = trackLineno;
          anchorBlock = this.enterLineAnchor(trackLineno);
        }
      } else {
        // Chunk vanished (line deleted): transition to line mode, holding the
        // line number where the chunk was and scrolling to it (clamped).
        this.selectionMode = "line";
        this.stickyLineno = trackLineno;
        anchorBlock = this.enterLineAnchor(trackLineno);
      }
    } else if (this.selectionMode === "line" && trackLineno !== null) {
      // Stick to the exact line number regardless of content. Never re-lock the
      // chunk even if it reappears; the user must click again to do that.
      this.stickyLineno = trackLineno;
      anchorBlock = this.enterLineAnchor(trackLineno);
    }

    this.applyColoring();

    if (this.firstLoad) {
      this.firstLoad = false;
      // A seeded line anchor (a host opened this file at a specific line) wins
      // over the usual snap-to-top for the very first render.
      if (anchorBlock !== null) this.centerBlock(anchorBlock);
      else this.scrollToBlock(0);
    } else if (anchorBlock !== null) {
      this.centerBlock(anchorBlock);
    } else {
      // "none" mode: maintain relative scroll position across the file.
      const newTotal = this.rows.length;
      const scaledTop =
        oldTotalLines > 0 ? Math.round((prevTop / oldTotalLines) * newTotal) : prevTop;
      this.scrollToBlock(scaledTop);
    }

    if (isModified) {
      this.infoLabel.textContent =
        `Rev M / ${this.commits.length - 1}  |  Uncommitted changes  ` +
        `by ${commit.authorName || "you"}`;
    } else {
      this.infoLabel.textContent =
        `Rev ${index + 1} / ${this.commits.length}  |  ` +
        `${fmtDate(commit.authoredDate)}  ${commit.hexSha}  "${commit.summary}"  ` +
        `by ${commit.authorName}`;
    }

    if (this.selectedBlock !== null) {
      await this.updateNextDetail();
      this.updatePrevDetail();
    } else {
      this.detailView.innerHTML = this.formatCommitHtml(commit, isModified ? undefined : index + 1);
    }
    this.layoutChunkHighlight();
    this.refreshStatusBar();
  }

  /**
   * Full render of the code lines. With virtual scrolling this only sizes the
   * container to the full document height and paints the visible window; the
   * scroll handler repaints as the viewport moves. Resets the rendered-window
   * bounds so renderWindow always repaints (it early-outs when the window is
   * unchanged).
   */
  private renderRows(): void {
    this.codeLines.innerHTML = "";
    this.codeLines.style.height = `${this.rows.length * this.lineH()}px`;
    this.renderedStart = 0;
    this.renderedEnd = 0;
    this.renderWindow(true);
    this.onRowsChanged();
  }

  /**
   * The rows have been rebuilt for a different revision or range. Row indices
   * from the previous set no longer mean anything, so the search position is
   * dropped -- the next search re-anchors on the selected line -- and the count
   * is recomputed against the new content while the find bar is showing. The
   * highlight needs no DOM cleanup: renderRows has just discarded those nodes.
   */
  private onRowsChanged(): void {
    this.searchMatchIndex = -1;
    this.searchHitBlock = null;
    if (!this.searchCount) return;
    if (this.searchOpen && this.searchQuery) this.updateSearchCount();
    else this.searchCount.textContent = "";
  }

  private renderGutter(): void {
    this.gutterAuthor.innerHTML = "";
    this.gutterLifetime.innerHTML = "";
    this.gutterLineno.innerHTML = "";
    this.gutterAuthor.style.display = this.showBlame ? "block" : "none";
    this.gutterLifetime.style.display = this.showLifetimes ? "block" : "none";
    this.gutterLineno.style.display = this.showLineno ? "block" : "none";
    const totalH = `${this.rows.length * this.lineH()}px`;
    this.gutterAuthor.style.height = totalH;
    this.gutterLifetime.style.height = totalH;
    this.gutterLineno.style.height = totalH;
    // Force a repaint of the current window (renderGutter is called on its own
    // for blame/lineno/format toggles without a preceding renderRows).
    this.renderGutterWindow(this.renderedStart, this.renderedEnd, this.lineH());
    this.applyGutterShading();
  }

  /**
   * Render (or re-render) the slice of code lines visible in the viewport plus a
   * buffer. Called by the scroll/resize handlers and by renderRows for the
   * initial paint. When `force` is true the early-out is skipped (used after a
   * full container reset where the DOM was cleared).
   */
  private renderWindow(force = false): void {
    const lh = this.lineH();
    const scrollTop = this.codeArea.scrollTop;
    const viewportH = this.codeArea.clientHeight;
    const total = this.rows.length;

    const firstVisible = Math.floor(scrollTop / lh);
    const lastVisible = Math.ceil((scrollTop + viewportH) / lh);
    const start = Math.max(0, firstVisible - this.RENDER_BUFFER);
    const end = Math.min(total, lastVisible + this.RENDER_BUFFER);

    if (!force && start >= this.renderedStart && end <= this.renderedEnd) return;

    this.renderedStart = start;
    this.renderedEnd = end;

    const filename = basename(this.filePath);
    const lang = hljsLanguageFor(filename);
    const cachePrefix = `${this.currentIndex}:`;

    const codeFrag = document.createDocumentFragment();
    for (let i = start; i < end; i++) {
      const row = this.rows[i];
      const div = el("div", "code-line");
      div.dataset.block = String(i);
      div.style.top = `${i * lh}px`;
      if (row.status === "removed") div.classList.add("removed");

      const cacheKey = cachePrefix + i;
      let html = this.hljsCache.get(cacheKey);
      if (html === undefined) {
        try {
          html = lang
            ? hljs.highlight(row.text, { language: lang, ignoreIllegals: true }).value
            : hljs.highlightAuto(row.text).value;
        } catch {
          html = esc(row.text);
        }
        if (this.hljsCache.size >= this.HLJS_CACHE_MAX) this.hljsCache.clear();
        this.hljsCache.set(cacheKey, html);
      }
      div.innerHTML = html || "&nbsp;";
      codeFrag.appendChild(div);
    }
    this.codeLines.innerHTML = "";
    this.codeLines.appendChild(codeFrag);

    this.renderGutterWindow(start, end, lh);
    this.applyColoring();

    // Re-apply the active search highlight if its row fell inside this window.
    if (
      this.searchHitBlock !== null &&
      this.searchHitBlock >= start &&
      this.searchHitBlock < end
    ) {
      const hit = this.codeLines.children[this.searchHitBlock - start] as HTMLElement | undefined;
      if (hit) hit.classList.add("search-hit");
    }
  }

  /**
   * Render the gutter cells (author + line-number columns) for the same row
   * window as the code lines, absolutely positioned at `row * lineH()`.
   */
  private renderGutterWindow(start: number, end: number, lh: number): void {
    const effectiveGutterMode: GutterMode =
      this.prevColoring === "blame" ? "author" : this.gutterMode;
    const blameColorActive = this.coloring === "blame";

    const authorFrag = document.createDocumentFragment();
    const lifetimeFrag = document.createDocumentFragment();
    const linenoFrag = document.createDocumentFragment();

    const lifeCtx = this.showLifetimes ? this.lifetimeContext() : null;

    for (let i = start; i < end; i++) {
      const row = this.rows[i];
      const info = row.info;
      const top = `${i * lh}px`;

      // Author column cell
      const aCell = el("div", "gutter-cell");
      aCell.dataset.block = String(i);
      aCell.style.top = top;
      if (info && this.showBlame) {
        const isStart = i === 0 || this.rows[i - 1].info?.commitHex !== info.commitHex;
        if (isStart) aCell.textContent = this.chunkLabel(info, effectiveGutterMode);
        if (blameColorActive) {
          aCell.style.background = authorColor(info.authorName || info.authorEmail, { dark: this.dark });
        }
      }
      authorFrag.appendChild(aCell);

      // Lifetime column cell: one bar per chunk. The bar is drawn on the first
      // rendered row of the chunk (its true start, or the window's top edge when
      // the chunk continues from above) and stretched via absolute height to
      // cover the chunk's remaining visible rows.
      if (lifeCtx) {
        const lCell = el("div", "gutter-cell gutter-lifetime-cell");
        lCell.dataset.block = String(i);
        lCell.style.top = top;
        const chunkStartsHere = i === 0 || !this.sameLifetimeChunk(i - 1, i);
        const continuesFromAbove =
          i === start && !chunkStartsHere && info != null;
        if ((chunkStartsHere || continuesFromAbove) && info) {
          const deleted = row.status === "removed";
          const bar = this.lifetimeBar(info, i, end, lifeCtx, lh, chunkStartsHere, deleted);
          if (bar) {
            lCell.style.zIndex = "1";
            lCell.appendChild(bar);
          }
        }
        lifetimeFrag.appendChild(lCell);
      }

      // Line-number column cell
      const nCell = el("div", "gutter-cell");
      nCell.dataset.block = String(i);
      nCell.style.top = top;
      if (row.lineno !== null && this.showLineno) {
        nCell.textContent = String(row.lineno);
        if (blameColorActive && info) {
          nCell.style.background = authorColor(info.authorName || info.authorEmail, { dark: this.dark });
        }
      }
      linenoFrag.appendChild(nCell);
    }
    this.gutterAuthor.innerHTML = "";
    this.gutterLifetime.innerHTML = "";
    this.gutterLineno.innerHTML = "";
    this.gutterAuthor.appendChild(authorFrag);
    this.gutterLineno.appendChild(linenoFrag);
    if (lifeCtx) {
      // Cursor spans the whole column height, so it lives on the column itself
      // rather than inside a per-row cell.
      const cursor = el("div", "gutter-lifetime-cursor");
      cursor.style.left = `${lifeCtx.cursorX}px`;
      lifetimeFrag.appendChild(cursor);
    }
    this.gutterLifetime.appendChild(lifetimeFrag);
  }

  /**
   * Precompute the geometry shared by every lifetime bar in the current window.
   * All revision-to-x mapping happens inside the padded inner track
   * [x0, x0 + innerW] so the cursor/bar ends at the first and last revision
   * stay clear of the column edges.
   */
  private lifetimeContext(): {
    x0: number;
    innerW: number;
    denom: number;
    curRev0: number;
    cursorX: number;
  } {
    const x0 = this.LIFETIME_PAD;
    const innerW = Math.max(1, this.LIFETIME_WIDTH - 2 * this.LIFETIME_PAD);
    const total = this.lastRealIndex() + 1;
    const denom = Math.max(1, total - 1);
    // Clamp the virtual "M" (uncommitted) revision onto the last real revision
    // so the cursor stays inside the column.
    const curRev0 = Math.max(0, Math.min(this.currentIndex, this.lastRealIndex()));
    const cursorX = x0 + (curRev0 / denom) * innerW;
    return { x0, innerW, denom, curRev0, cursorX };
  }

  /** Map a 0-based real-revision index to its x pixel in the padded track. */
  private lifetimeX(rev0: number, ctx: ReturnType<App["lifetimeContext"]>): number {
    return ctx.x0 + (rev0 / ctx.denom) * ctx.innerW;
  }

  /**
   * Build a single chunk lifetime bar spanning the chunk's lifetime: from the
   * revision that introduced the chunk's commit to the last revision where the
   * chunk's lines still appear in blame (via lifetimeEndMap, keyed per line by
   * commitHex:originLine). A chunk visible now may be removed in a LATER
   * revision, so its bar ends before the end of history; if it survives, the map
   * holds the last real index. The span is static and does not track the scrub
   * cursor. Endpoints come from O(1) map lookups (one per chunk line for the
   * end), so no per-scrub recomputation is needed. The bar is stretched
   * vertically to cover the chunk's visible rows, inset a little so adjacent
   * chunks read apart. Returns null if the commit has no known revision (blame
   * origin outside history).
   */
  private lifetimeBar(
    info: LineInfo,
    drawRow: number,
    windowEnd: number,
    ctx: ReturnType<App["lifetimeContext"]>,
    lh: number,
    chunkStartsHere: boolean,
    deleted: boolean,
  ): HTMLDivElement | null {
    const rev1 = this.revisionOf(info.commitHex);
    if (rev1 === undefined) return null;
    const last = this.lastRealIndex();
    const introRev0 = Math.max(0, Math.min(rev1 - 1, last));

    // Vertical extent: the chunk runs from the drawn row down to its true last
    // row (which may sit below the rendered window).
    let chunkEnd = drawRow;
    while (
      chunkEnd + 1 < this.rows.length &&
      this.sameLifetimeChunk(chunkEnd, chunkEnd + 1)
    ) {
      chunkEnd++;
    }

    // A deleted line's span ends at the revision BEFORE the one being viewed
    // (where it is removed); a surviving line's span runs through the end of
    // history. If the deletion happens at the very first revision there is no
    // "before", so the bar has no meaningful extent, so skip it.
    let endRev0: number;
    if (deleted) {
      if (this.currentIndex <= 0) return null;
      endRev0 = Math.max(0, Math.min(this.currentIndex - 1, last));
      if (endRev0 < introRev0) return null;
    } else {
      // A surviving chunk ends at the last revision where its lines are still
      // blamed, which may precede the end of history if the lines were removed
      // in a later revision. sameLifetimeChunk() splits on lifetime end, so all
      // lines in this chunk share the same end; use this line's directly.
      endRev0 = Math.max(introRev0, Math.min(this.lifetimeEndForLine(info), last));
    }
    const chunkEndsHere = chunkEnd < windowEnd;
    const visibleRows = Math.min(chunkEnd, windowEnd - 1) - drawRow + 1;

    const bar = el("div", "gutter-lifetime-bar");
    if (deleted) bar.classList.add("deleted");
    // Inset top/bottom so consecutive chunk bars don't visually merge. The inset
    // is only applied at real chunk boundaries: a chunk clipped by the window
    // edge abuts the edge (no false gap) so it stitches seamlessly across the
    // buffer boundary. margin handles the spacing; height subtracts it back out.
    const gap = this.LIFETIME_GAP;
    const topInset = chunkStartsHere ? gap / 2 : 0;
    const botInset = chunkEndsHere ? gap / 2 : 0;
    bar.style.height = `${Math.max(1, Math.max(1, visibleRows) * lh - topInset - botInset)}px`;
    bar.style.marginTop = `${topInset}px`;

    const x1 = this.lifetimeX(introRev0, ctx);
    const x2 = this.lifetimeX(endRev0, ctx);
    bar.style.left = `${Math.min(x1, x2)}px`;
    bar.style.width = `${Math.max(2, Math.abs(x2 - x1))}px`;
    return bar;
  }

  /**
   * Two adjacent rows belong to the same lifetime chunk when they share an
   * origin commit, the same lifetime end, AND the same deleted-vs-present state.
   * Splitting on the deletion boundary keeps a removed block (whose bar ends
   * before the current revision) from visually merging with a surviving block
   * from the same commit (whose bar runs to the end of history). Splitting on
   * lifetime end keeps lines introduced together but removed at different later
   * revisions from sharing one bar clamped to the earliest death.
   */
  private sameLifetimeChunk(a: number, b: number): boolean {
    const ra = this.rows[a];
    const rb = this.rows[b];
    const infoA = ra?.info;
    const infoB = rb?.info;
    if (!infoA || !infoB) return infoA === infoB;
    if (infoA.commitHex !== infoB.commitHex) return false;
    // Only merge when both lifetime ends are known. A missing key resolves to the
    // lastRealIndex() fallback, which is shared by every unkeyed line, so two
    // distinct-death lines would falsely merge. Require an explicit map hit for
    // both so grouping never rests on the fallback.
    const keyA = this.lifetimeKey(infoA.commitHex, infoA.originLine);
    const keyB = this.lifetimeKey(infoB.commitHex, infoB.originLine);
    const endA = this.lifetimeEndMap.get(keyA);
    const endB = this.lifetimeEndMap.get(keyB);
    if (endA === undefined || endB === undefined) return false;
    if (endA !== endB) return false;
    return (ra.status === "removed") === (rb.status === "removed");
  }

  /**
   * The last real revision index at which a single physical line is still
   * blamed. Falls back to the end of history for lines not in the map (map not
   * yet built, or line survives to HEAD).
   */
  private lifetimeEndForLine(info: LineInfo): number {
    const key = this.lifetimeKey(info.commitHex, info.originLine);
    return this.lifetimeEndMap.get(key) ?? this.lastRealIndex();
  }

  private chunkLabel(info: LineInfo, mode: GutterMode): string {
    if (mode === "hash") return info.commitHex.slice(0, 8);
    if (mode === "author") return authorDisplay(info.authorName, info.authorEmail, { fmt: this.blameFormat });
    if (mode === "date") return fmtDate(info.authoredDate);
    const rev = this.commitRevisions.get(info.commitHex);
    return rev !== undefined ? String(rev) : info.commitHex.slice(0, 8);
  }

  // =======================================================================
  // Display model
  // =======================================================================

  private async diffDetail(index: number): Promise<DiffDetail> {
    try {
      if (this.isModifiedRev(index)) {
        return await this.backend!.getWorkingTreeDiffDetail(this.modifiedBaseHex);
      }
      const newHex = this.commits[index].hexSha;
      const oldHex = index > 0 ? this.commits[index - 1].hexSha : "";
      return await this.backend!.getDiffDetail(oldHex, newHex);
    } catch {
      return { statuses: new Map(), removals: new Map(), modifiedOld: new Map() };
    }
  }

  /** Snapshot of the active tab's state that revisionDiffRows reads. */
  private revisionSource(): RevisionSource | null {
    if (!this.backend) return null;
    return {
      backend: this.backend,
      commits: this.commits,
      filePath: this.filePath,
      followRenames: this.followRenamesActive,
      segPaths: this.commitSegmentPath,
      segmentBoundaries: this.segmentBoundaries,
      hasModifiedRev: this.hasModifiedRev,
      modifiedBaseHex: this.modifiedBaseHex,
    };
  }

  /**
   * The Diff-mode rows for one revision, diffed against the predecessor the
   * viewer uses: the previous revision; the working tree's base for the
   * uncommitted revision; the previous segment's path across a rename; or
   * nothing at all, making every line added, for the oldest revision. With
   * `range` the diff is the accumulated change from the start handle's
   * revision to the end handle's. History search classifies its matches from
   * these same rows, so the tray and the Diff view cannot disagree.
   *
   * The rows replay the unified diff in git's own order, so a changed block
   * shows all of its removed (old) lines first, then all of its added (new)
   * lines -- matching `git diff` exactly, rather than interleaving per line.
   */
  private async revisionDiffRows(
    src: RevisionSource,
    index: number,
    sourceLines: string[],
    range: [number, number] | null = null,
  ): Promise<{ diffRows: DiffRow[]; oldHex: string }> {
    const { backend, commits } = src;
    const newHex = range ? commits[range[1]].hexSha : commits[index].hexSha;
    const atBoundary =
      !range && src.followRenames && src.segmentBoundaries.includes(index) && index > 0;
    const oldHex = range
      ? commits[range[0]].hexSha
      : (index > 0 && !atBoundary)
        ? commits[index - 1].hexSha
        : "";
    const isModified =
      !range &&
      src.hasModifiedRev &&
      index === commits.length - 1 &&
      commits[index]?.hexSha === MODIFIED_SENTINEL;
    let diffRows: DiffRow[];
    try {
      if (isModified) {
        diffRows = await backend.getWorkingTreeDiffRows(src.modifiedBaseHex, sourceLines);
      } else if (atBoundary && backend.getCrossPathDiffRows) {
        const prevCommit = commits[index - 1];
        const prevPath = src.segPaths.get(prevCommit.hexSha) ?? src.filePath;
        const curPath = src.segPaths.get(newHex) ?? src.filePath;
        diffRows = await backend.getCrossPathDiffRows(
          prevCommit.hexSha, prevPath, newHex, curPath, sourceLines,
        );
      } else {
        const segPath = src.followRenames ? src.segPaths.get(newHex) : undefined;
        diffRows = (segPath && segPath !== src.filePath)
          ? await backend.getDiffRowsForPath!(segPath, oldHex, newHex, sourceLines)
          : await backend.getDiffRows(oldHex, newHex, sourceLines);
      }
    } catch {
      diffRows = sourceLines.map((text, i) => ({
        lineno: i + 1,
        oldLineno: null,
        status: "unchanged" as const,
        text,
      }));
    }
    return { diffRows, oldHex };
  }

  private async buildDisplay(index: number, content: string): Promise<Row[]> {
    const sourceLines = splitLines(content);
    const rows: Row[] = [];
    const rangeMode = this.coloring === "range";
    const interleave = this.coloring === "diff" || rangeMode;

    // An empty range (start === end) has no accumulated diff; render every line
    // as unchanged rather than falling into the "old==='' means all-new" path.
    if (!interleave || (rangeMode && this.rangeStart >= this.rangeEnd)) {
      for (let i = 0; i < sourceLines.length; i++) {
        rows.push({
          lineno: i + 1,
          oldLineno: null,
          info: i < this.lineInfos.length ? this.lineInfos[i] : null,
          status: "unchanged",
          text: sourceLines[i],
        });
      }
      return rows;
    }

    const range: [number, number] | null = rangeMode
      ? [this.rangeStart, Math.min(this.lastRealIndex(), this.rangeEnd)]
      : null;
    const { diffRows, oldHex } = await this.revisionDiffRows(
      this.revisionSource()!, index, sourceLines, range,
    );

    // Removed rows carry no blame in the current revision (they no longer exist
    // here). To draw their lifetime bar we need the commit that last touched them
    // in the PREVIOUS revision, so fetch that revision's blame once if any row is
    // a deletion. In range mode the "previous" side is the range start handle.
    let oldInfos: LineInfo[] | null = null;
    if (diffRows.some((dr) => dr.status === "removed" && dr.oldLineno !== null)) {
      const oldBlameHex =
        !rangeMode && this.isModifiedRev(index) ? this.modifiedBaseHex : oldHex;
      oldInfos = oldBlameHex ? await this.fetchLineInfos(oldBlameHex) : [];
    }

    for (const dr of diffRows) {
      let info: LineInfo | null = null;
      if (dr.lineno !== null && dr.lineno - 1 < this.lineInfos.length) {
        info = this.lineInfos[dr.lineno - 1];
      } else if (
        dr.status === "removed" &&
        dr.oldLineno !== null &&
        oldInfos &&
        dr.oldLineno - 1 < oldInfos.length
      ) {
        info = oldInfos[dr.oldLineno - 1];
      }
      rows.push({ lineno: dr.lineno, oldLineno: dr.oldLineno, info, status: dr.status, text: dr.text });
    }
    return rows;
  }

  private async fetchLineInfos(commitHex: string): Promise<LineInfo[]> {
    if (!this.backend) return [];
    try {
      const segPath = this.followRenamesActive
        ? this.commitSegmentPath.get(commitHex)
        : undefined;
      const blame = (segPath && segPath !== this.filePath)
        ? await this.backend.getBlameForPath!(segPath, commitHex)
        : await this.backend.getBlame(commitHex);
      return blameToLineInfos(blame);
    } catch {
      return [];
    }
  }

  private async findLineByBlame(oldLineno: number, oldIndex: number): Promise<number | null> {
    let oldInfos: LineInfo[];
    if (oldIndex < 0 || oldIndex >= this.commits.length) oldInfos = this.lineInfos;
    else oldInfos = await this.fetchLineInfos(this.commits[oldIndex].hexSha);
    if (!(oldLineno >= 1 && oldLineno <= oldInfos.length)) return null;
    const targetHex = oldInfos[oldLineno - 1].commitHex;
    let best: number | null = null;
    let bestDist = Infinity;
    for (let i = 0; i < this.lineInfos.length; i++) {
      if (this.lineInfos[i].commitHex === targetHex) {
        const dist = Math.abs(i + 1 - oldLineno);
        if (dist < bestDist) { best = i + 1; bestDist = dist; }
      }
    }
    return best;
  }

  // =======================================================================
  // Scrolling
  // =======================================================================

  private scrollToBlock(block: number): void {
    block = Math.max(0, Math.min(block, this.rows.length - 1));
    this.codeArea.scrollTop = block * this.lineH();
  }

  /**
   * Scroll a changed chunk (starting at `chunkStart`) into view showing as much
   * of it as possible: if the whole chunk fits, leave a couple of context lines
   * above; if it's taller than the viewport, pin the start near the top with
   * minimal context so the chunk fills the screen from its beginning.
   */
  private scrollChunkIntoView(chunkStart: number): void {
    let chunkEnd = chunkStart;
    while (
      chunkEnd + 1 < this.rows.length &&
      CHANGED_STATUSES.has(this.rows[chunkEnd + 1].status)
    ) {
      chunkEnd += 1;
    }
    const lh = this.lineH();
    const viewportLines = Math.floor(this.codeArea.clientHeight / lh);
    const chunkLines = chunkEnd - chunkStart + 1;
    const context = chunkLines <= viewportLines - 4 ? 2 : 1;
    this.codeArea.scrollTop = Math.max(0, chunkStart - context) * lh;
  }

  /** Scroll so `block` sits vertically centered in the code viewport. */
  private centerBlock(block: number): void {
    block = Math.max(0, Math.min(block, this.rows.length - 1));
    const lh = this.lineH();
    const target = block * lh - this.codeArea.clientHeight / 2 + lh / 2;
    const max = Math.max(0, this.rows.length * lh - this.codeArea.clientHeight);
    this.codeArea.scrollTop = Math.max(0, Math.min(target, max));
  }

  /**
   * Resolve a line-anchor to a display-row index: the row whose line number
   * equals `lineno` when present, otherwise the nearest surviving line. When the
   * file is shorter than `lineno`, the nearest is the last line, so this doubles
   * as "clamp to bottom". Used as the line-mode scroll/highlight target.
   */
  private clampBlockForLineno(lineno: number): number {
    let best = 0;
    let bestDist = Infinity;
    for (let i = 0; i < this.rows.length; i++) {
      const ln = this.rows[i].lineno;
      if (ln === null) continue;
      const dist = Math.abs(ln - lineno);
      if (dist < bestDist) {
        best = i;
        bestDist = dist;
        if (dist === 0) break;
      }
    }
    return best;
  }

  /**
   * Set up line-mode anchoring for `lineno` in the current revision: resolve the
   * anchor row (clamped to the file), record it as `selectedLineBlock` for the
   * single-line highlight, and populate `selectedBlock`/chunk bounds so the
   * detail panes reflect the chunk that line falls in. Returns the anchor row
   * index for scrolling. The single-line highlight (not chunk) is enforced by
   * `applySelectionHighlight`/`applyGutterShading` via `selectionMode`.
   */
  private enterLineAnchor(lineno: number): number {
    const block = this.clampBlockForLineno(lineno);
    this.selectedLineBlock = block;
    this.selectedBlock = block;
    [this.selectedChunkStart, this.selectedChunkEnd] = this.chunkBounds(block);
    return block;
  }

  // =======================================================================
  // Selection
  // =======================================================================

  /**
   * Cycle the 3-state selection for the clicked row:
   *   none / different chunk → chunk mode (select & follow the chunk)
   *   chunk mode, same chunk → line mode (anchor this exact line number)
   *   line mode, same line   → none (clear all selection)
   */
  private onLineClicked(block: number): void {
    if (block < 0 || block >= this.rows.length) return;

    if (this.selectionMode === "line") {
      // Same anchored line → clear; any other line → re-enter chunk mode there.
      if (block === this.selectedLineBlock) {
        this.clearLineSelection();
      } else {
        this.enterChunkMode(block);
      }
      return;
    }

    if (
      this.selectionMode === "chunk" &&
      this.selectedChunkStart !== null &&
      this.selectedChunkEnd !== null &&
      block >= this.selectedChunkStart &&
      block <= this.selectedChunkEnd
    ) {
      // Second click within the selected chunk → line mode on the clicked line.
      this.enterLineMode(block);
      return;
    }

    // None, or a click outside the current chunk → chunk mode.
    this.enterChunkMode(block);
  }

  /**
   * Enter chunk mode: select the chunk containing `block`, anchor its line
   * number in `stickyLineno` (so a later transition to line mode holds it), and
   * update coloring + detail panes.
   */
  private enterChunkMode(block: number): void {
    this.selectionMode = "chunk";
    this.selectedLineBlock = null;
    this.selectChunk(block);
  }

  /**
   * Enter line mode: drop the chunk highlight and anchor the single clicked
   * line number. The detail panes keep showing whatever chunk that line falls
   * in, so selection state (selectedBlock/chunk bounds) is retained for panes
   * but the visual highlight switches to just the one row.
   */
  private enterLineMode(block: number): void {
    this.selectionMode = "line";
    this.selectedLineBlock = block;
    const ln = this.rows[block]?.lineno;
    this.stickyLineno = ln ?? this.stickyLineno;
    this.applyColoring();
    this.layoutChunkHighlight();
  }

  /**
   * Select the chunk containing `block`, updating selection state, coloring,
   * and the commit detail panes. Unlike {@link onLineClicked}, this does not
   * toggle off when the block is already within the selected chunk; it is used
   * by chunk navigation where re-selecting the target is always intended.
   */
  private selectChunk(block: number): void {
    this.selectionMode = "chunk";
    this.selectedLineBlock = null;
    this.selectedBlock = block;
    [this.selectedChunkStart, this.selectedChunkEnd] = this.chunkBounds(block);
    // Anchor the clicked line so a later transition to line mode (or a chunk
    // that vanishes while scrubbing) can fall back to holding this line number.
    this.stickyLineno = this.rows[block]?.lineno ?? null;
    this.applyColoring();
    this.updatePrevDetail();
    void this.updateNextDetail();
    this.layoutChunkHighlight();
  }

  private chunkBounds(block: number): [number, number] {
    if (block < 0 || block >= this.rows.length) return [block, block];

    // A changed row (added/modified/removed) belongs to a change block: the
    // contiguous run of non-"unchanged" rows around it. This matches how git
    // shows a hunk: all removed (old) lines first, then all added/modified
    // (new) lines. So clicking any removed, added, or modified line selects
    // the whole block, not just the run that shares one commit.
    if (CHANGED_STATUSES.has(this.rows[block].status)) {
      let start = block;
      while (start - 1 >= 0 && CHANGED_STATUSES.has(this.rows[start - 1].status)) {
        start -= 1;
      }
      let end = block;
      while (end + 1 < this.rows.length && CHANGED_STATUSES.has(this.rows[end + 1].status)) {
        end += 1;
      }
      return [start, end];
    }

    // An unchanged row groups with adjacent unchanged rows sharing its commit.
    const info = this.rows[block].info;
    if (!info) return [block, block];
    const target = info.commitHex;
    let start = block;
    while (start - 1 >= 0) {
      const prevRow = this.rows[start - 1];
      if (CHANGED_STATUSES.has(prevRow.status)) break;
      if (!prevRow.info || prevRow.info.commitHex !== target) break;
      start -= 1;
    }
    let end = block;
    while (end + 1 < this.rows.length) {
      const nxtRow = this.rows[end + 1];
      if (CHANGED_STATUSES.has(nxtRow.status)) break;
      if (!nxtRow.info || nxtRow.info.commitHex !== target) break;
      end += 1;
    }
    return [start, end];
  }

  private clearLineSelection(): void {
    this.selectionMode = "none";
    this.selectedLineBlock = null;
    this.selectedBlock = null;
    this.selectedChunkStart = null;
    this.selectedChunkEnd = null;
    this.stickyLineno = null;
    this.prevDetail.innerHTML = "";
    this.prevDetail.classList.add("hidden");
    this.resetDetailToCurrent();
    this.applyColoring();
    this.layoutChunkHighlight();
  }

  private resetDetailToCurrent(): void {
    if (!this.backend || this.currentIndex < 0) return;
    const commit = this.commits[this.currentIndex];
    this.detailView.innerHTML = this.formatCommitHtml(commit, this.currentIndex + 1);
  }

  // =======================================================================
  // Detail panes
  // =======================================================================

  /**
   * Format a commit for a detail pane as HTML. The "Revision: N" line (when a
   * revision number is known) is rendered as a clickable link that jumps to
   * that revision; everything else is HTML-escaped plain text laid out with
   * `white-space: pre-wrap` on the pane.
   */
  private formatCommitHtml(commit: FileHistory, revNumber?: number): string {
    const dt = fmtDateTime(commit.authoredDate);
    // The virtual "uncommitted changes" revision has no real commit object.
    if (commit.hexSha === MODIFIED_SENTINEL) {
      const author = commit.authorName
        ? `Author: ${esc(commit.authorName)} &lt;${esc(commit.authorEmail)}&gt;\n`
        : "";
      return (
        `Revision: M (uncommitted changes)\n` +
        author +
        `Date:   ${esc(dt)}\n\n` +
        `Working-tree changes not yet committed.`
      );
    }
    const revLine =
      revNumber !== undefined ? `${this.revLinkHtml(revNumber, `Revision: ${revNumber}`)}\n` : "";
    return (
      `${revLine}` +
      `Commit: ${esc(commit.hexSha)}\n` +
      `Author: ${esc(commit.authorName)} &lt;${esc(commit.authorEmail)}&gt;\n` +
      `Date:   ${esc(dt)}\n\n` +
      `${esc(commit.message.trim())}`
    );
  }

  /** A clickable revision link (`<a class="rev-link" data-rev="N">label</a>`). */
  private revLinkHtml(revNumber: number, label: string, title?: string): string {
    const titleAttr = title !== undefined ? ` title="${esc(title)}"` : "";
    return `<a href="#" class="rev-link" data-rev="${revNumber}"${titleAttr}>${esc(label)}</a>`;
  }

  /** Jump to the revision named by a `.rev-link` clicked in a detail pane. */
  private onDetailPaneClick(e: MouseEvent): void {
    const target = e.target as HTMLElement;
    if (!target.classList.contains("rev-link")) return;
    e.preventDefault();
    const rev = parseInt(target.dataset.rev ?? "", 10);
    if (!isNaN(rev) && rev >= 1 && rev <= this.commits.length) {
      this.setRevision(rev - 1); // 0-based
    }
  }

  private revisionOf(commitHex: string): number | undefined {
    return this.commitRevisions.get(commitHex);
  }

  private selectedChunkLineRange(): [number, number] | null {
    const start = this.selectedChunkStart;
    const end = this.selectedChunkEnd;
    if (start === null || end === null) return null;
    const linenos: number[] = [];
    for (let i = start; i <= end && i < this.rows.length; i++) {
      if (this.rows[i].lineno !== null) linenos.push(this.rows[i].lineno!);
    }
    if (!linenos.length) return null;
    return [Math.min(...linenos), Math.max(...linenos)];
  }

  private async findNextModifier(
    range: [number, number],
    fromIndex: number,
  ): Promise<[number | null, string]> {
    const [lo, hi] = range;
    for (let i = fromIndex; i < this.commits.length; i++) {
      const detail = await this.diffDetail(i);
      let changed = false;
      for (let ln = lo; ln <= hi; ln++) {
        const s = detail.statuses.get(ln);
        if (s === "added" || s === "modified") { changed = true; break; }
      }
      let removed = false;
      for (const anchor of detail.removals.keys()) {
        if ((anchor >= lo && anchor <= hi) || anchor === hi + 1) { removed = true; break; }
      }
      if (changed) return [i, "modified"];
      if (removed) return [i, "deleted"];
    }
    return [null, ""];
  }

  private async updateNextDetail(): Promise<void> {
    if (!this.backend || this.currentIndex < 0) return;
    const block = this.selectedBlock;
    let info: LineInfo | null = null;
    if (block !== null && block < this.rows.length) info = this.rows[block].info;
    const currentHex = this.commits[this.currentIndex].hexSha;

    if (info && info.commitHex === currentHex) {
      let chunkHasChanges = false;
      const s = this.selectedChunkStart ?? 0;
      const e = this.selectedChunkEnd ?? 0;
      for (let i = s; i <= e && i < this.rows.length; i++) {
        if (CHANGED_STATUSES.has(this.rows[i].status)) { chunkHasChanges = true; break; }
      }
      if (chunkHasChanges) {
        this.detailView.innerHTML = this.formatCommitHtml(
          this.commits[this.currentIndex],
          this.currentIndex + 1,
        );
      } else {
        this.detailView.textContent = "Same as current revision.";
      }
      return;
    }

    const range = this.selectedChunkLineRange();
    if (!range) { this.resetDetailToCurrent(); return; }
    const [revIndex, action] = await this.findNextModifier(range, this.currentIndex + 1);
    if (revIndex === null) {
      this.detailView.textContent = "Unchanged through latest revision.";
      return;
    }
    const commit = this.commits[revIndex];
    const verb = action === "deleted" ? "Deleted" : "Modified";
    this.detailView.innerHTML =
      `${this.revLinkHtml(revIndex + 1, `${verb} in revision ${revIndex + 1}`)}:\n\n` +
      this.formatCommitHtml(commit, revIndex + 1);
  }

  private updatePrevDetail(): void {
    if (!this.backend || this.currentIndex < 0) {
      this.prevDetail.innerHTML = "";
      return;
    }
    const block = this.selectedBlock;
    if (block === null) {
      this.prevDetail.innerHTML = "";
      this.prevDetail.classList.add("hidden");
      return;
    }
    this.prevDetail.classList.remove("hidden");
    let info: LineInfo | null = null;
    let oldLineno: number | null = null;
    if (block < this.rows.length) {
      info = this.rows[block].info;
      oldLineno = this.rows[block].oldLineno;
    }
    if (!info) {
      // A removed line has no blame in the current revision, but it existed in
      // the previous revision; look up which commit introduced it there.
      if (oldLineno !== null && this.currentIndex > 0) {
        this.showDeletedLineBlame(oldLineno);
      } else {
        this.prevDetail.textContent = "No blame data for this line.";
      }
      return;
    }
    const currentHex = this.commits[this.currentIndex].hexSha;
    if (info.commitHex === currentHex) { this.prevDetail.textContent = "Same as current revision."; return; }
    const revNumber = this.revisionOf(info.commitHex);
    const revLine =
      revNumber !== undefined ? `${this.revLinkHtml(revNumber, `Revision: ${revNumber}`)}\n` : "";
    void (async () => {
      try {
        const commit = await this.backend!.getCommitInfo(info!.commitHex);
        this.prevDetail.innerHTML = this.formatCommitHtml(commit, revNumber);
      } catch {
        const dt = fmtDateTime(info!.authoredDate);
        this.prevDetail.innerHTML =
          `${revLine}Commit: ${esc(info!.commitHex)}\nAuthor: ${esc(info!.authorName)} &lt;${esc(info!.authorEmail)}&gt;\nDate:   ${esc(dt)}\n`;
      }
    })();
  }

  /**
   * Show, in the left pane, the commit that originally introduced a line that
   * has since been deleted. The current revision has no blame for a removed
   * line, so consult the previous revision's blame (where the line still
   * existed) at its old-file line number.
   */
  private showDeletedLineBlame(oldLineno: number): void {
    const prevIndex = this.currentIndex - 1;
    void (async () => {
      try {
        const blame = await this.backend!.getBlame(this.commits[prevIndex].hexSha);
        let match: BlameEntry | null = null;
        for (const entry of blame) {
          if (oldLineno >= entry.origLineno && oldLineno < entry.origLineno + entry.lines.length) {
            match = entry;
            break;
          }
        }
        if (!match) { this.prevDetail.textContent = "No blame data for this line."; return; }
        const revNumber = this.revisionOf(match.commitHex);
        const currentRev = this.currentIndex + 1;
        const deletedIn = `deleted in ${this.revLinkHtml(currentRev, `revision ${currentRev}`, `Jump to revision ${currentRev}`)} (current)`;
        const note =
          revNumber !== undefined
            ? `${this.revLinkHtml(revNumber, `Introduced in revision ${revNumber}`)} (${deletedIn})\n\n`
            : `Introduced by a commit not in this file's history (${deletedIn})\n\n`;
        try {
          const commit = await this.backend!.getCommitInfo(match.commitHex);
          this.prevDetail.innerHTML = note + this.formatCommitHtml(commit, revNumber);
        } catch {
          const dt = fmtDateTime(match.authoredDate);
          this.prevDetail.innerHTML =
            `${note}Commit: ${esc(match.commitHex)}\nAuthor: ${esc(match.authorName)} &lt;${esc(match.authorEmail)}&gt;\nDate:   ${esc(dt)}\n`;
        }
      } catch {
        this.prevDetail.textContent = "No blame data for this line.";
      }
    })();
  }

  // =======================================================================
  // Coloring
  // =======================================================================

  private applyColoring(): void {
    this.updateChunkButtons();

    // Compute per-row background from the active mode.
    const rowColors = new Map<number, Hex | null>();
    let legendHtml = "";

    if (this.backend && this.currentIndex >= 0) {
      if (this.coloring === "diff" || this.coloring === "range") {
        legendHtml = this.diffColors(rowColors);
      } else if (this.coloring === "blame") {
        legendHtml = this.blameColors(rowColors);
      } else if (this.coloring === "age") {
        legendHtml = this.ageColors(rowColors);
      }
    }

    // Only the windowed slice of rows is in the DOM. Child N maps to row
    // `renderedStart + N`.
    const lineEls = this.codeLines.children;
    for (let j = 0; j < lineEls.length; j++) {
      const i = this.renderedStart + j;
      if (i >= this.rows.length) break;
      const div = lineEls[j] as HTMLElement;
      // reset
      div.style.background = "";
      div.classList.toggle("removed", this.rows[i].status === "removed");
      if (this.rows[i].status === "removed") {
        div.style.background = removedColorFor(this.dark);
      } else {
        const c = rowColors.get(i + 1);
        if (c) div.style.background = c;
      }
    }

    // Selection highlight layered last.
    this.applySelectionHighlight();
    this.applyGutterShading();
    this.legendLabel.innerHTML = legendHtml;
  }

  private selectionColorForRow(i: number): Hex {
    const diffMode = this.coloring === "diff" || this.coloring === "range";
    if (diffMode && i < this.rows.length) {
      const status = this.rows[i].status;
      if (status === "added" || status === "modified") {
        const base = diffColorsFor(this.dark).added;
        if (base) return selectedDiffColor(base, this.dark);
      } else if (status === "removed") {
        return selectedDiffColor(removedColorFor(this.dark), this.dark);
      }
    }
    return currentLineColorFor(this.dark);
  }

  private applySelectionHighlight(): void {
    const lineEls = this.codeLines.children;
    for (let j = 0; j < lineEls.length; j++) {
      (lineEls[j] as HTMLElement).classList.remove("selected", "line-selected");
    }

    if (this.selectionMode === "line") {
      const block = this.selectedLineBlock;
      if (block === null) return;
      const div = lineEls[block - this.renderedStart] as HTMLElement | undefined;
      if (div) { div.style.background = this.selectionColorForRow(block); div.classList.add("line-selected"); }
      return;
    }

    const sel = this.selectedBlock;
    if (sel === null) return;
    const s = this.selectedChunkStart ?? sel;
    const e = this.selectedChunkEnd ?? sel;
    for (let i = s; i <= e; i++) {
      const div = lineEls[i - this.renderedStart] as HTMLElement | undefined;
      if (div) { div.style.background = this.selectionColorForRow(i); div.classList.add("selected"); }
    }
  }

  private applyGutterShading(): void {
    const authorCells = this.gutterAuthor.children;
    const linenoCells = this.gutterLineno.children;
    const diffMode = this.coloring === "diff" || this.coloring === "range";
    const selStart = this.selectedChunkStart;
    const selEnd = this.selectedChunkEnd;
    const addedColor = diffColorsFor(this.dark).added;
    const removedColor = removedColorFor(this.dark);

    const count = Math.max(authorCells.length, linenoCells.length);
    for (let j = 0; j < count; j++) {
      const i = this.renderedStart + j;
      if (i >= this.rows.length) break;
      const aCell = authorCells[j] as HTMLElement | undefined;
      const nCell = linenoCells[j] as HTMLElement | undefined;
      const selected =
        this.selectionMode === "line"
          ? i === this.selectedLineBlock
          : selStart !== null && selEnd !== null && i >= selStart && i <= selEnd;
      const status = this.rows[i].status;
      let bg = "";
      if (selected) {
        bg = this.selectionColorForRow(i);
      } else if (diffMode) {
        if (status === "added" || status === "modified") bg = addedColor || "";
        else if (status === "removed") bg = removedColor;
      } else if (this.coloring === "blame" && this.rows[i].info) {
        bg = authorColor(this.rows[i].info!.authorName || this.rows[i].info!.authorEmail, { dark: this.dark });
      }
      if (aCell) aCell.style.background = bg;
      if (nCell) nCell.style.background = bg;
    }
  }

  private diffColors(colors: Map<number, Hex | null>): string {
    const palette = diffColorsFor(this.dark);
    for (let i = 0; i < this.rows.length; i++) {
      const status = this.rows[i].status;
      if (status === "removed") continue;
      const col = palette[status];
      if (col) colors.set(i + 1, col);
    }
    const addedHex = palette.added ?? "#c6efce";
    const removedHex = removedColorFor(this.dark);
    const addedSelHex = selectedDiffColor(addedHex, this.dark);
    const removedSelHex = selectedDiffColor(removedHex, this.dark);
    const splitSwatch = (base: Hex, sel: Hex) =>
      `<span class="swatch" style="background:linear-gradient(135deg,${base} 50%,${sel} 50%)"></span>`;
    const hasDiff = this.coloring === "range" ? this.rangeStart < this.rangeEnd : this.currentIndex > 0;
    if (hasDiff) {
      return (
        `Added/Modified ${splitSwatch(addedHex, addedSelHex)}` +
        ` &nbsp; Removed ${splitSwatch(removedHex, removedSelHex)}`
      );
    }
    if (this.coloring === "range") {
      return `No changes in range (start = end)`;
    }
    return `All lines new (first revision) ${splitSwatch(addedHex, addedSelHex)}`;
  }

  private blameColors(colors: Map<number, Hex | null>): string {
    const authors: string[] = [];
    const seen = new Set<string>();
    for (let i = 0; i < this.rows.length; i++) {
      const info = this.rows[i].info;
      if (!info) continue;
      const key = info.authorName || info.authorEmail;
      colors.set(i + 1, authorColor(key, { dark: this.dark }));
      if (!seen.has(key)) { seen.add(key); authors.push(key); }
    }
    let legend = "By author: " + authors.slice(0, 6).map(esc).join(", ");
    if (authors.length > 6) legend += ", …";
    return legend;
  }

  private ageColors(colors: Map<number, Hex | null>): string {
    const dated = this.rows.map((r) => r.info).filter((x): x is LineInfo => x !== null);
    if (!dated.length) return "";
    let oldest = dated[0].authoredDate;
    let newest = dated[0].authoredDate;
    for (const info of dated) {
      if (info.authoredDate < oldest) oldest = info.authoredDate;
      if (info.authoredDate > newest) newest = info.authoredDate;
    }
    for (let i = 0; i < this.rows.length; i++) {
      const info = this.rows[i].info;
      if (!info) continue;
      colors.set(i + 1, ageColor(info.authoredDate, oldest, newest, this.dark));
    }
    const hexes = ageBucketHexes(this.dark);
    const swatches = hexes
      .map((h) => `<span class="swatch swatch-sm" style="background:${h}"></span>`)
      .join(" ");
    const dateRange = `(${fmtDate(oldest)} &rarr; ${fmtDate(newest)})`;
    return `Least recent ${swatches} Most recent &nbsp; ${dateRange}`;
  }

  // =======================================================================
  // Mode / gutter dropdowns
  // =======================================================================

  private onModeChanged(): void {
    const newMode = this.modeCombo.value as ColoringMode;
    if (newMode === "blame" && this.prevColoring !== "blame") {
      this.gutterCombo.disabled = true;
    } else if (this.prevColoring === "blame" && newMode !== "blame") {
      this.gutterCombo.disabled = false;
    }
    const leavingRange = this.prevColoring === "range" && newMode !== "range";
    this.prevColoring = newMode;
    this.coloring = newMode;
    this.updateSliderVisibility();

    if (newMode === "range") {
      // Seed the range from the current position on first entry: end at the
      // current real revision, start at the first revision, so the initial view
      // shows the whole accumulated history up to here. Clamp defensively.
      const last = this.lastRealIndex();
      if (last < 0) { this.savePreferences(); return; }
      this.rangeEnd = Math.max(0, Math.min(last, this.isModifiedRev(this.currentIndex) ? last : this.currentIndex));
      this.rangeStart = 0;
      this.syncRangeSlider();
      void this.showRange();
      this.savePreferences();
      return;
    }

    if (leavingRange) {
      // Return the single slider to the end revision we were showing.
      this.setRevision(Math.max(0, Math.min(this.lastRealIndex(), this.rangeEnd)));
    }
    // Switching to/from diff changes interleaving, so rebuild rows.
    void this.rebuildDisplay();
    this.savePreferences();
  }

  private async rebuildDisplay(): Promise<void> {
    if (!this.backend || this.currentIndex < 0) {
      this.applyColoring();
      return;
    }
    const topBlock = Math.round(this.codeArea.scrollTop / this.lineH());
    const commit = this.commits[this.currentIndex];
    let content: string;
    try {
      content = await this.backend.getFileContent(commit.hexSha);
    } catch (exc) {
      if (exc instanceof BinaryFileError) content = "<binary file — cannot display as text>";
      else if (exc instanceof FileNotFoundError) content = "<file did not exist at this revision>";
      else content = `<error reading content: ${exc}>`;
    }
    this.rows = await this.buildDisplay(this.currentIndex, content);
    this.renderRows();
    this.renderGutter();
    this.applyColoring();
    this.scrollToBlock(topBlock);
  }

  private onGutterModeChanged(): void {
    this.gutterMode = this.gutterCombo.value as GutterMode;
    // While blame coloring forces the gutter to "author", just record the new
    // choice (stored in gutterMode) for later; otherwise re-render immediately.
    if (this.prevColoring !== "blame") {
      this.renderGutter();
    }
    this.savePreferences();
  }

  private onToggleLifetimes(): void {
    this.showLifetimes = !this.showLifetimes;
    this.lifetimesBtn.classList.toggle("active", this.showLifetimes);
    this.applyGutterWidth();
    this.renderGutter();
    this.savePreferences();
  }

  // =======================================================================
  // Chunk navigation
  // =======================================================================

  private chunkStarts(): number[] {
    const starts: number[] = [];
    let prevChanged = false;
    for (let i = 0; i < this.rows.length; i++) {
      const changed = CHANGED_STATUSES.has(this.rows[i].status);
      if (changed && !prevChanged) starts.push(i);
      prevChanged = changed;
    }
    return starts;
  }

  private updateChunkButtons(): void {
    const diffMode = this.coloring === "diff" || this.coloring === "range";
    this.prevChunkBtn.style.display = diffMode ? "" : "none";
    this.nextChunkBtn.style.display = diffMode ? "" : "none";
    const enabled = diffMode && this.rows.length > 0;
    this.prevChunkBtn.disabled = !enabled;
    this.nextChunkBtn.disabled = !enabled;
  }

  private onPrevChunk(): void {
    const starts = this.chunkStarts();
    if (!starts.length) return;
    const anchor = this.selectedChunkStart ?? Math.round(this.codeArea.scrollTop / this.lineH());
    let target: number | null = null;
    let wrapped = false;
    for (const start of starts) {
      if (start < anchor) target = start;
      else break;
    }
    if (target === null) { target = starts[starts.length - 1]; wrapped = true; }
    this.scrollChunkIntoView(target);
    this.selectChunk(target);
    if (wrapped) this.showWrapIndicator("↑ Wrapped to bottom");
    else this.hideWrapIndicator();
  }

  private onNextChunk(): void {
    const starts = this.chunkStarts();
    if (!starts.length) return;
    const anchor = this.selectedChunkStart ?? Math.round(this.codeArea.scrollTop / this.lineH());
    let target: number | null = null;
    let wrapped = false;
    for (const start of starts) {
      if (start > anchor) { target = start; break; }
    }
    if (target === null) { target = starts[0]; wrapped = true; }
    this.scrollChunkIntoView(target);
    this.selectChunk(target);
    if (wrapped) this.showWrapIndicator("↓ Wrapped to top");
    else this.hideWrapIndicator();
  }

  private showWrapIndicator(text: string): void {
    this.wrapIndicator.textContent = text;
    this.wrapIndicator.style.display = "";
    if (this.wrapTimer !== null) window.clearTimeout(this.wrapTimer);
    this.wrapTimer = window.setTimeout(() => {
      this.wrapIndicator.style.display = "none";
    }, 5000);
  }

  /** Hide the wrap indicator immediately and cancel any pending auto-hide. */
  private hideWrapIndicator(): void {
    if (this.wrapTimer !== null) {
      window.clearTimeout(this.wrapTimer);
      this.wrapTimer = null;
    }
    this.wrapIndicator.style.display = "none";
  }

  // =======================================================================
  // Search
  // =======================================================================

  private openSearch(): void {
    this.searchOpen = true;
    this.searchRow.classList.remove("hidden");
    this.searchField.focus();
    this.searchField.select();
    this.syncHistoryUi();
  }

  /**
   * Hide the bar but keep the query, so F3 can pick it up again. Only the
   * active tab's highlight is cleared; the others were already dropped when
   * the query that produced them changed.
   */
  private closeSearch(): void {
    this.searchOpen = false;
    this.searchRow.classList.add("hidden");
    this.searchCount.textContent = "";
    this.clearSearchHighlights();
    this.syncHistoryUi();
  }

  /**
   * Record a new application-wide query. The active tab's field already holds
   * it; the others are re-synchronised when they next become active. Every
   * remembered match position belongs to the query being replaced, so all of
   * them are dropped -- including the highlight sitting in an inactive tab,
   * whose DOM stays live while detached and is never re-rendered on the way
   * back in.
   */
  private setSearchQuery(query: string): void {
    this.searchQuery = query;
    this.searchMatchIndex = -1;
    this.clearSearchHighlights();
    for (const tab of this.tabs) {
      if (tab.id === this.activeTabId) continue;
      tab.searchMatchIndex = -1;
      tab.searchHitBlock = null;
      tab.codeLines
        .querySelectorAll(".search-hit")
        .forEach((n) => n.classList.remove("search-hit"));
    }
    this.updateSearchCount();
    // History results are not re-run here, only relabelled as belonging to
    // the previous query until Search is pressed.
    this.updateHistoryStatus(this.history);
  }

  /**
   * F3 / Ctrl+G. Repeats the last search, reopening the bar if Escape hid it,
   * so "find, dismiss, find again" behaves the way it does in an editor. The
   * match position is per-tab, so this resumes where the active tab left off.
   * With no query to repeat it is just Ctrl+F.
   */
  private findAgain(forward: boolean): void {
    // Stepping through the revision on screen would read as stepping through
    // the history results, so it is inert in history mode. The key handler
    // has already called preventDefault, so the webview's own find stays shut.
    if (this.historyMode) return;
    if (!this.searchQuery) {
      this.openSearch();
      return;
    }
    if (this.searchOpen === false) {
      this.searchOpen = true;
      this.searchRow.classList.remove("hidden");
      this.syncHistoryUi();
    }
    this.doSearch(forward);
  }

  // =======================================================================
  // History search
  // =======================================================================

  private buildHistorySearch(): HistorySearch {
    const toggleBtn = el("button", "history-toggle-btn", "History");
    toggleBtn.title = "Search every revision of the file (Find in History)";
    toggleBtn.addEventListener("click", () => this.toggleHistoryMode());

    const searchBtn = el("button", "history-search-btn hidden", "Search");
    searchBtn.title = "Search the file's history for this text";

    const tray = el("div", "history-tray hidden");
    const handle = el("div", "splitter-handle horizontal");
    const header = el("div", "history-header");
    header.appendChild(el("span", "history-title", "History"));
    const status = el("span", "history-status");
    header.appendChild(status);
    const changesBtn = el("button", "history-changes-btn", "Changes only");
    changesBtn.title = "List only the lines a revision added, edited or removed";
    changesBtn.addEventListener("click", () => this.toggleHistoryChangesOnly());
    header.appendChild(changesBtn);
    const close = el("button", "narrow-btn", "✕");
    close.title = "Close history search";
    close.addEventListener("click", () => this.toggleHistoryMode());
    header.appendChild(close);
    const list = el("div", "history-list");
    const empty = el("div", "placeholder history-empty hidden");
    const lines = el("div", "history-lines");
    list.append(empty, lines);
    tray.append(handle, header, list);

    const h: HistorySearch = {
      tray, list, lines, status, toggleBtn, searchBtn, changesBtn, empty, findNav: [],
      revs: [], rows: [], rowsChangesOnly: this.historyChangesOnly, query: "",
      searched: 0, total: 0, compared: 0, toCompare: 0,
      hitCount: 0, addedCount: 0, removedCount: 0, unchangedCount: 0, revCount: 0,
      unchangedDropped: 0, shownCount: 0, shownRevs: 0, truncated: false, savedScroll: null,
      running: false, renderedStart: 0, renderedEnd: 0, token: 0,
    };

    searchBtn.addEventListener("click", () => void this.runHistorySearch(h));
    this.makeHistoryTrayDrag(handle, tray);
    let rafId = 0;
    list.addEventListener("scroll", () => {
      if (rafId) cancelAnimationFrame(rafId);
      rafId = requestAnimationFrame(() => {
        rafId = 0;
        this.renderHistoryWindow(h);
      });
    });
    new ResizeObserver(() => this.renderHistoryWindow(h)).observe(list);
    // A double-click is a jump; without this it would also select a word.
    lines.addEventListener("mousedown", (e) => {
      if (e.detail > 1) e.preventDefault();
    });
    lines.addEventListener("dblclick", (e) => {
      const rowEl = (e.target as HTMLElement).closest<HTMLElement>("[data-row]");
      const row = rowEl ? h.rows[parseInt(rowEl.dataset.row!, 10)] : undefined;
      if (row) void this.jumpToHistoryRow(row);
    });
    tray.addEventListener("animationend", () => tray.classList.remove("opening"));
    return h;
  }

  private makeHistoryTrayDrag(handle: HTMLDivElement, tray: HTMLDivElement): void {
    let startY = 0;
    let startH = 0;
    const onMove = (e: MouseEvent) => {
      // The tray grows upward into the code view; leave that a usable minimum.
      const room = Math.max(80, (tray.parentElement?.clientHeight ?? 0) - 200);
      const height = Math.max(80, Math.min(room, startH - (e.clientY - startY)));
      tray.style.height = `${height}px`;
      this.historyTrayHeight = height;
    };
    const onUp = () => {
      document.removeEventListener("mousemove", onMove);
      document.removeEventListener("mouseup", onUp);
    };
    handle.addEventListener("mousedown", (e) => {
      startY = e.clientY;
      startH = tray.offsetHeight;
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
      e.preventDefault();
    });
  }

  private toggleHistoryMode(): void {
    this.historyMode = !this.historyMode;
    if (this.historyMode) {
      this.history.tray.classList.add("opening");
      this.openSearch();
    } else {
      // Leaving the mode abandons a run in any tab, so a background tab cannot
      // finish later and repopulate a tray that has been closed.
      for (const tab of this.tabs) this.cancelHistorySearch(tab.history);
      this.syncHistoryUi();
    }
    this.syncMenuChecks();
  }

  /**
   * Bring the active tab's history controls in line with the application-wide
   * mode and with this tab's file. Every path that changes the mode or the
   * active tab ends here, so this is also where the in-revision navigation is
   * switched off and back on. The tray shows only while Find is open in
   * history mode and there is a file to search.
   */
  private syncHistoryUi(): void {
    const h = this.history;
    if (!h) return;
    const hasFile = !!this.backend && this.commits.length > 0;
    h.toggleBtn.classList.toggle("active", this.historyMode);
    h.changesBtn.classList.toggle("active", this.historyChangesOnly);
    h.searchBtn.classList.toggle("hidden", !this.historyMode);
    h.searchBtn.disabled = !hasFile;
    for (const btn of h.findNav) btn.disabled = this.historyMode;
    // An in-revision hit is no longer navigable, so do not leave one marked.
    if (this.historyMode) this.clearSearchHighlights();
    this.menuActions.findNext?.classList.toggle("disabled", this.historyMode);
    this.menuActions.findPrev?.classList.toggle("disabled", this.historyMode);
    if (this.searchOpen && this.searchQuery && this.rows.length) this.updateSearchCount();
    else this.searchCount.textContent = "";
    const show = this.searchOpen && this.historyMode && hasFile;
    const shown = !h.tray.classList.contains("hidden");
    if (shown && !show) h.savedScroll = h.list.scrollTop;
    h.tray.classList.toggle("hidden", !show);
    if (!show) return;
    h.tray.style.height = `${this.historyTrayHeight}px`;
    if (h.savedScroll !== null) {
      h.list.scrollTop = h.savedScroll;
      h.savedScroll = null;
    }
    this.renderHistory(h);
  }

  /**
   * Changes only. Refilters the results already gathered: nothing is re-read,
   * re-diffed or re-run. The active tray repaints now; other tabs catch up in
   * renderHistory when they are next shown.
   */
  private toggleHistoryChangesOnly(): void {
    this.historyChangesOnly = !this.historyChangesOnly;
    this.savePreferences();
    this.syncHistoryUi();
  }

  private cancelHistorySearch(h: HistorySearch): void {
    if (!h.running) return;
    this.clearHistory(h);
  }

  /**
   * Drop the active tab's results because the history they index has been
   * rebuilt -- a new file, or follow-renames toggled -- so the revision numbers
   * and the set of revisions searched are no longer the ones on screen.
   */
  private invalidateHistory(): void {
    if (!this.history) return;
    this.clearHistory(this.history);
    this.syncHistoryUi();
  }

  private clearHistory(h: HistorySearch): void {
    h.token++;
    h.running = false;
    h.revs = [];
    h.rows = [];
    h.rowsChangesOnly = this.historyChangesOnly;
    h.savedScroll = null;
    h.query = "";
    this.resetHistoryCounts(h, 0);
    h.list.scrollTop = 0;
    this.renderHistory(h);
  }

  private resetHistoryCounts(h: HistorySearch, total: number): void {
    h.searched = 0;
    h.total = total;
    h.compared = 0;
    h.toCompare = 0;
    h.hitCount = 0;
    h.addedCount = 0;
    h.removedCount = 0;
    h.unchangedCount = 0;
    h.revCount = 0;
    h.unchangedDropped = 0;
    h.shownCount = 0;
    h.shownRevs = 0;
    h.truncated = false;
  }

  /**
   * Look for the query in every revision the scrubber offers, newest first.
   * Runs only from the Search button: searching on each keystroke would start
   * a scan of the whole history on the first character typed.
   *
   * Everything read from the tab is captured up front and results go into the
   * tab's own HistorySearch, so switching tabs mid-search neither mixes files
   * nor loses the result. A newer search, a rebuilt history or leaving history
   * mode bumps the token, and the superseded run stops writing.
   *
   * Two passes. The first reads every revision and notes which contain the
   * query at all. The second takes each revision's Diff-mode rows from
   * revisionDiffRows -- the same rows the Diff view draws -- and classifies
   * the matching ones as added, carried over or removed. A revision needs the
   * second pass only if it or its predecessor contains the query, since its
   * rows come from exactly those two; the rest are skipped without diffing.
   */
  private async runHistorySearch(h: HistorySearch): Promise<void> {
    const live = this.revisionSource();
    const query = this.searchQuery;
    if (h !== this.history || !live || !live.commits.length || !query) return;

    const token = ++h.token;
    // A snapshot: a follow-renames toggle replaces these and invalidates the run.
    const src: RevisionSource = {
      ...live,
      segPaths: new Map(live.segPaths),
      segmentBoundaries: live.segmentBoundaries.slice(),
    };
    const { commits } = src;
    const needle = query.toLowerCase();

    h.revs = [];
    h.rows = [];
    h.rowsChangesOnly = this.historyChangesOnly;
    h.query = query;
    this.resetHistoryCounts(h, commits.length);
    h.running = true;
    h.list.scrollTop = 0;
    this.renderHistory(h);

    let lastPaint = performance.now();
    let sliceStart = lastPaint;
    // Precached content resolves without ever yielding, so a long history
    // would otherwise freeze the UI until the whole search finished.
    const pace = async (): Promise<boolean> => {
      const now = performance.now();
      if (now - lastPaint > 100) {
        lastPaint = now;
        this.updateHistoryStatus(h);
      }
      if (now - sliceStart > 16) {
        await new Promise((resolve) => setTimeout(resolve, 0));
        sliceStart = performance.now();
      }
      return token === h.token;
    };
    const workers = (n: number, work: () => Promise<void>) =>
      Promise.all(Array.from({ length: Math.min(this.HISTORY_WORKERS, n) }, work));

    const contents: (string | null)[] = new Array(commits.length).fill(null);
    const contains: boolean[] = new Array(commits.length).fill(false);
    let next = commits.length - 1;
    await workers(commits.length, async () => {
      while (next >= 0) {
        const index = next--;
        const commit = commits[index];
        const isModified =
          src.hasModifiedRev && index === commits.length - 1 && commit.hexSha === MODIFIED_SENTINEL;
        try {
          const content = await this.revisionContent(
            src.backend, commit, isModified,
            src.followRenames ? src.segPaths.get(commit.hexSha) : undefined, src.filePath,
          );
          contents[index] = content;
          contains[index] = content.toLowerCase().includes(needle);
        } catch {
          // Binary, or not present at this revision: nothing to match.
        }
        if (token !== h.token) return;
        h.searched++;
        if (!(await pace())) return;
      }
    });
    if (token !== h.token) return;

    // Newest first, so if the cap stops the run early, everything newer than
    // the stopping point has been compared.
    const pending: number[] = [];
    for (let index = commits.length - 1; index >= 0; index--) {
      if (contents[index] !== null && (contains[index] || (index > 0 && contains[index - 1]))) {
        pending.push(index);
      }
    }
    h.toCompare = pending.length;
    const found: { hits: HistoryHitRow[]; added: number; removed: number; unchanged: number }[] =
      new Array(commits.length);
    let changes = 0;
    let unchangedStored = 0;
    let taken = 0;
    // Only the change cap stops the search. Carried-over lines never do, so a
    // query present in every revision still finds changes all the way back.
    await workers(pending.length, async () => {
      while (taken < pending.length && changes < this.HISTORY_MAX_CHANGES) {
        const index = pending[taken++];
        const { diffRows } = await this.revisionDiffRows(src, index, splitLines(contents[index]!));
        if (token !== h.token) return;
        const hits = this.historyHitsFromDiff(diffRows, needle, commits[index].hexSha, index);
        let added = 0;
        let removed = 0;
        for (const hit of hits) {
          if (hit.mark === "+") added++;
          else if (hit.mark === "-") removed++;
        }
        const unchanged = hits.length - added - removed;
        // Carried-over lines past what can be kept are dropped as they arrive,
        // so a common query cannot hold millions of them in memory; the extra
        // headroom absorbs workers finishing slightly out of newest-first order.
        const keepUnchanged = unchangedStored < 2 * this.HISTORY_MAX_UNCHANGED;
        if (keepUnchanged) unchangedStored += unchanged;
        found[index] = {
          hits: keepUnchanged ? hits : hits.filter((hit) => hit.mark !== " "),
          added, removed, unchanged,
        };
        changes += added + removed;
        h.compared++;
        if (!(await pace())) return;
      }
    });
    if (token !== h.token) return;

    // Newest first, each kind against its own cap. Headings keep the full
    // counts, so a partly kept revision still says what it contained.
    const revs: HistoryRev[] = [];
    let unchangedFound = 0;
    for (let index = commits.length - 1; index >= 0; index--) {
      const f = found[index];
      if (!f) continue;
      unchangedFound += f.unchanged;
      const kept: HistoryHitRow[] = [];
      for (const hit of f.hits) {
        if (hit.mark === " ") {
          if (h.unchangedCount >= this.HISTORY_MAX_UNCHANGED) continue;
          h.unchangedCount++;
        } else {
          if (h.addedCount + h.removedCount >= this.HISTORY_MAX_CHANGES) continue;
          if (hit.mark === "+") h.addedCount++;
          else h.removedCount++;
        }
        kept.push(hit);
      }
      if (!kept.length) continue;
      const commit = commits[index];
      const segPath = src.followRenames ? src.segPaths.get(commit.hexSha) : undefined;
      revs.push({
        head: {
          kind: "rev",
          hexSha: commit.hexSha,
          index,
          path: segPath && segPath !== src.filePath ? segPath : null,
          present: f.added + f.unchanged,
          added: f.added,
          removed: f.removed,
        },
        hits: kept,
      });
    }
    h.revs = revs;
    h.revCount = revs.length;
    h.hitCount = h.addedCount + h.removedCount + h.unchangedCount;
    h.unchangedDropped = unchangedFound - h.unchangedCount;
    h.truncated = taken < pending.length || h.addedCount + h.removedCount < changes;
    h.running = false;
    this.flattenHistory(h);
    h.list.scrollTop = 0;
    this.renderHistory(h);
  }

  /** Rebuild the listed rows from the kept results under the current filter. */
  private flattenHistory(h: HistorySearch): void {
    const rows: HistoryRow[] = [];
    let shown = 0;
    let revs = 0;
    for (const rev of h.revs) {
      const hits = this.historyChangesOnly ? rev.hits.filter((hit) => hit.mark !== " ") : rev.hits;
      if (!hits.length) continue;
      rows.push(rev.head);
      for (const hit of hits) rows.push(hit);
      shown += hits.length;
      revs++;
    }
    h.rows = rows;
    h.shownCount = shown;
    h.shownRevs = revs;
    h.rowsChangesOnly = this.historyChangesOnly;
  }

  /**
   * Re-apply the filter to a tray that is showing results, keeping the reader's
   * place: the revision at the top stays at the top if it survives; otherwise
   * the next older revision that survived does, or failing that the nearest
   * newer one. With nothing left it goes to the top.
   */
  private refilterHistory(h: HistorySearch): void {
    const lh = this.lineH();
    let topRev: number | null = null;
    for (let i = Math.min(h.rows.length - 1, Math.floor(h.list.scrollTop / lh)); i >= 0; i--) {
      const row = h.rows[i];
      if (row.kind === "rev") {
        topRev = row.index;
        break;
      }
    }
    this.flattenHistory(h);
    let target = 0;
    if (topRev !== null) {
      let nearestNewer = -1;
      let found = false;
      for (let i = 0; i < h.rows.length; i++) {
        const row = h.rows[i];
        if (row.kind !== "rev") continue;
        // Revisions are listed newest first, so indices only go down.
        if (row.index <= topRev) {
          target = i;
          found = true;
          break;
        }
        nearestNewer = i;
      }
      if (!found && nearestNewer >= 0) target = nearestNewer;
    }
    h.lines.style.height = `${h.rows.length * lh}px`;
    h.list.scrollTop = target * lh;
  }

  /**
   * One revision's matching lines, from its Diff-mode rows and in their order,
   * so a removed line sits exactly where the Diff view interleaves it. Added
   * and changed-in-place rows are "+", unchanged rows " ", removed rows "-".
   * Matching is the same case-insensitive substring test Find uses.
   */
  private historyHitsFromDiff(
    diffRows: DiffRow[],
    needle: string,
    hexSha: string,
    index: number,
  ): HistoryHitRow[] {
    // Where a removed line was taken out: the next surviving line, or the
    // last one when the removal was at the end of the file.
    const nextSurviving = new Array<number>(diffRows.length);
    let following = 0;
    for (let i = diffRows.length - 1; i >= 0; i--) {
      if (diffRows[i].lineno !== null) following = diffRows[i].lineno!;
      nextSurviving[i] = following;
    }
    const out: HistoryHitRow[] = [];
    let preceding = 1;
    for (let i = 0; i < diffRows.length; i++) {
      const dr = diffRows[i];
      if (dr.lineno !== null) preceding = dr.lineno;
      const text = dr.text.endsWith("\r") ? dr.text.slice(0, -1) : dr.text;
      const at = text.toLowerCase().indexOf(needle);
      if (at < 0) continue;
      const clipped = this.clipHistoryLine(text, at);
      if (dr.status === "removed") {
        out.push({
          kind: "hit", hexSha, index, mark: "-", lineno: dr.oldLineno ?? 0,
          anchor: nextSurviving[i] || preceding, text: clipped,
        });
      } else {
        out.push({
          kind: "hit", hexSha, index, mark: dr.status === "unchanged" ? " " : "+",
          lineno: dr.lineno!, anchor: dr.lineno!, text: clipped,
        });
      }
    }
    return out;
  }

  private clipHistoryLine(line: string, at: number): string {
    const max = this.HISTORY_LINE_CLIP;
    if (line.length <= max) return line;
    const start = Math.max(0, Math.min(at - Math.floor(max / 3), line.length - max));
    const end = start + max;
    return (start > 0 ? "..." : "") + line.slice(start, end) + (end < line.length ? "..." : "");
  }

  private updateHistoryStatus(h: HistorySearch): void {
    if (!h) return;
    const q = (s: string) => `"${s}"`;
    let text: string;
    if (h.running) {
      text = h.searched < h.total
        ? `Searching for ${q(h.query)}... read ${h.searched} / ${h.total} revisions`
        : `Searching for ${q(h.query)}... compared ${h.compared} / ${h.toCompare} revisions`;
    } else if (!h.query) {
      text = this.searchQuery
        ? `Press Search to look for ${q(this.searchQuery)} in all ${this.commits.length} revisions.`
        : "Type what to look for, then press Search.";
    } else if (!h.hitCount) {
      text = `No matches for ${q(h.query)} in ${h.total} revisions.`;
    } else {
      const entries = (n: number) => `${n} entr${n === 1 ? "y" : "ies"}`;
      text = h.rowsChangesOnly
        ? `Showing ${h.shownCount} of ${entries(h.hitCount)} (changes only) in ` +
          `${h.shownRevs} of ${h.total} revisions`
        : `${entries(h.hitCount)} in ${h.revCount} of ${h.total} revisions`;
      text += ` for ${q(h.query)} (${h.addedCount} added, ${h.removedCount} removed)`;
      // Say what the caps dropped, per kind, rather than one vague total.
      if (h.truncated) {
        text += `; stopped at ${this.HISTORY_MAX_CHANGES} changes, newest first`;
      }
      if (h.unchangedDropped) {
        text += `; ${h.unchangedDropped} unchanged entries not kept (limit ${this.HISTORY_MAX_UNCHANGED})`;
      }
    }
    if (!h.running && h.query && this.searchQuery !== h.query) {
      text += " -- the query has changed; press Search to update.";
    }
    h.status.textContent = text;
  }

  /**
   * Full repaint of a tray: new row count, new window, new status line. A
   * tray whose rows were built under the other filter setting -- the toggle
   * was flipped, perhaps from another tab -- is refiltered first.
   */
  private renderHistory(h: HistorySearch): void {
    if (h.rowsChangesOnly !== this.historyChangesOnly) this.refilterHistory(h);
    h.lines.style.height = `${h.rows.length * this.lineH()}px`;
    this.renderHistoryWindow(h, true);
    this.updateHistoryStatus(h);
    this.updateHistoryEmpty(h);
  }

  /** A message in place of a blank list when a search found, or kept, nothing. */
  private updateHistoryEmpty(h: HistorySearch): void {
    const q = `"${h.query}"`;
    let text = "";
    if (!h.running && h.query && !h.rows.length) {
      text = h.hitCount
        ? `No revision added, edited or removed a line matching ${q}. ` +
          `Turn off Changes only to see the ${h.hitCount} unchanged entries.`
        : `No line matching ${q} in any revision.`;
    }
    h.empty.textContent = text;
    h.empty.classList.toggle("hidden", !text);
  }

  /**
   * Render the slice of tray rows in view plus a buffer, the same windowing
   * renderWindow does for the code view: rows are absolutely positioned at
   * `row * lineH()`, so only what can be seen is ever in the DOM.
   */
  private renderHistoryWindow(h: HistorySearch, force = false): void {
    // A hidden or inactive tray has no size to window against.
    if (h !== this.history || h.tray.classList.contains("hidden")) return;
    const lh = this.lineH();
    const total = h.rows.length;
    const firstVisible = Math.floor(h.list.scrollTop / lh);
    const lastVisible = Math.ceil((h.list.scrollTop + h.list.clientHeight) / lh);
    const start = Math.max(0, firstVisible - this.RENDER_BUFFER);
    const end = Math.min(total, lastVisible + this.RENDER_BUFFER);
    if (!force && start >= h.renderedStart && end <= h.renderedEnd) return;
    h.renderedStart = start;
    h.renderedEnd = end;

    const needle = h.query.toLowerCase();
    // The Diff view's own added/removed colours, which follow the theme's
    // light/dark flag; theme changes repaint the tray (see applyTheme).
    const addedBg = diffColorsFor(this.dark).added;
    const removedBg = removedColorFor(this.dark);
    const frag = document.createDocumentFragment();
    for (let i = start; i < end; i++) {
      const row = h.rows[i];
      const div = el("div", `history-row history-${row.kind}`);
      div.dataset.row = String(i);
      div.style.top = `${i * lh}px`;
      if (row.kind === "rev") {
        div.innerHTML = this.historyRevHtml(row);
      } else {
        div.innerHTML = this.historyHitHtml(row, needle);
        if (row.mark === "-") {
          div.classList.add("removed");
          div.style.background = removedBg;
        } else if (row.mark === "+" && addedBg) {
          div.style.background = addedBg;
        }
      }
      frag.appendChild(div);
    }
    h.lines.replaceChildren(frag);
  }

  private historyRevHtml(row: Extract<HistoryRow, { kind: "rev" }>): string {
    const counts = [`${row.present} in revision`];
    if (row.added) counts.push(`+${row.added} added`);
    if (row.removed) counts.push(`-${row.removed} removed`);
    const matches = counts.join(", ");
    let html: string;
    if (row.hexSha === MODIFIED_SENTINEL) {
      html = `<span class="history-rev-num">Rev M</span>  Uncommitted changes`;
    } else {
      const commit = this.commits[row.index];
      html = `<span class="history-rev-num">Rev ${row.index + 1}</span>  ${esc(row.hexSha)}`;
      if (commit?.hexSha === row.hexSha) {
        html += `  ${fmtDate(commit.authoredDate)}  ${esc(commit.authorName)}  "${esc(commit.summary)}"`;
      }
    }
    html += `  <span class="history-count">${matches}</span>`;
    if (row.path) html += `  <span class="history-path">${esc(row.path)}</span>`;
    return html;
  }

  private historyHitHtml(row: Extract<HistoryRow, { kind: "hit" }>, needle: string): string {
    let html = `<span class="history-marker">${row.mark}</span>`;
    // A removed line has no number here; show its old number in parentheses
    // so it cannot be read as a line of this revision.
    html += row.mark === "-"
      ? `<span class="history-lineno history-was" title="Line ${row.lineno} in the previous revision">(${row.lineno})</span>`
      : `<span class="history-lineno">${row.lineno}</span>`;
    return `${html}<span class="history-text">${this.markMatches(row.text, needle)}</span>`;
  }

  private markMatches(text: string, needle: string): string {
    const lower = text.toLowerCase();
    // A few characters change length when lowercased; the offsets would then
    // mark the wrong text, so show the line unmarked instead.
    if (!needle || lower.length !== text.length) return esc(text);
    let html = "";
    let pos = 0;
    for (let at = lower.indexOf(needle); at >= 0; at = lower.indexOf(needle, pos)) {
      html += esc(text.slice(pos, at));
      html += `<mark class="history-mark">${esc(text.slice(at, at + needle.length))}</mark>`;
      pos = at + needle.length;
    }
    return html + esc(text.slice(pos));
  }

  /**
   * Double-click in the tray. A revision row moves the scrubber there. A
   * matching line also anchors that line in line mode, the same state a click
   * in the code view produces, so showRevision centres it and it stays
   * selected while scrubbing on from there.
   *
   * A removed line is anchored on the surviving line it was removed in front
   * of. In Diff mode the removed row itself is drawn there, so it is then
   * selected in place of that line; other colouring modes draw no removed
   * rows, so the surviving line is where the jump lands.
   */
  private async jumpToHistoryRow(row: HistoryRow): Promise<void> {
    const rev = this.commitRevisions.get(row.hexSha);
    if (rev === undefined) {
      this.setStatus("That revision is no longer in this file's history. Search again.");
      return;
    }
    const index = rev - 1;
    if (row.kind === "rev") {
      if (index !== this.currentIndex) void this.setRevision(index);
      return;
    }
    if (index === this.currentIndex) {
      this.focusLineInCurrentView(row.anchor);
    } else {
      this.selectionMode = "line";
      this.stickyLineno = row.anchor;
      await this.setRevision(index);
    }
    if (row.mark === "-" && this.coloring === "diff" && this.currentIndex === index) {
      this.selectRemovedRow(row.lineno);
    }
  }

  /** Line-select the Diff view's removed row that was line `oldLineno` before. */
  private selectRemovedRow(oldLineno: number): void {
    const block = this.rows.findIndex((r) => r.status === "removed" && r.oldLineno === oldLineno);
    if (block < 0) return;
    // stickyLineno stays on the surviving line: a removed row has no line
    // number to hold, so scrubbing on keeps the place it was removed from.
    this.selectedLineBlock = block;
    this.selectedBlock = block;
    [this.selectedChunkStart, this.selectedChunkEnd] = this.chunkBounds(block);
    this.applyColoring();
    this.centerBlock(block);
    this.updatePrevDetail();
    void this.updateNextDetail();
    this.layoutChunkHighlight();
  }

  private clearSearchHighlights(): void {
    this.searchHitBlock = null;
    this.codeLines
      .querySelectorAll(".search-hit")
      .forEach((n) => n.classList.remove("search-hit"));
  }

  private searchHits(): number[] {
    // The query is application-wide; the rows searched are the active tab's.
    const text = this.searchQuery;
    if (!text) return [];
    const lower = text.toLowerCase();
    const hits: number[] = [];
    for (let i = 0; i < this.rows.length; i++) {
      if (this.rows[i].text.toLowerCase().includes(lower)) hits.push(i);
    }
    return hits;
  }

  private updateSearchCount(): void {
    // The count describes the revision on screen, not the history; the tray's
    // status line reports the history results instead.
    if (this.historyMode) {
      this.searchCount.textContent = "";
      return;
    }
    const hits = this.searchHits();
    const total = hits.length;
    this.searchCount.textContent = `${total} match${total !== 1 ? "es" : ""}`;
  }

  /**
   * Row a fresh search starts from: the selected line, or the line clicked
   * inside the selected chunk. Null when nothing is selected, which starts the
   * search at the top of the file (or the bottom, searching backwards).
   */
  private searchAnchor(): number | null {
    const block = this.selectedLineBlock ?? this.selectedBlock;
    if (block === null || block < 0 || block >= this.rows.length) return null;
    return block;
  }

  private doSearch(forward: boolean): void {
    const hits = this.searchHits();
    if (!hits.length) {
      this.searchCount.textContent = "0 matches";
      this.hideWrapIndicator();
      return;
    }

    // A match index of -1 means there is no search in progress: the query just
    // changed, the revision was scrubbed, or the file was reloaded. Those start
    // from the selection; only a continuing search steps from the last hit.
    let wrapped = false;
    if (this.searchMatchIndex < 0) {
      const anchor = this.searchAnchor();
      if (anchor === null) {
        this.searchMatchIndex = forward ? 0 : hits.length - 1;
      } else if (forward) {
        // The anchor row itself counts, so searching for text on the selected
        // line lands on that line rather than skipping past it.
        const i = hits.findIndex((h) => h >= anchor);
        wrapped = i < 0;
        this.searchMatchIndex = wrapped ? 0 : i;
      } else {
        let i = -1;
        for (let k = hits.length - 1; k >= 0; k--) {
          if (hits[k] <= anchor) { i = k; break; }
        }
        wrapped = i < 0;
        this.searchMatchIndex = wrapped ? hits.length - 1 : i;
      }
    } else if (forward) {
      wrapped = this.searchMatchIndex + 1 >= hits.length;
      this.searchMatchIndex = (this.searchMatchIndex + 1) % hits.length;
    } else {
      wrapped = this.searchMatchIndex - 1 < 0;
      this.searchMatchIndex = (this.searchMatchIndex - 1 + hits.length) % hits.length;
    }

    // Same wording and lifetime as chunk navigation, which wraps the same way.
    if (wrapped) this.showWrapIndicator(forward ? "↓ Wrapped to top" : "↑ Wrapped to bottom");
    else this.hideWrapIndicator();

    const block = hits[this.searchMatchIndex];
    this.clearSearchHighlights();
    this.searchHitBlock = block;
    // Center the hit. Scrolling may pull the target row into the virtual window;
    // renderWindow re-applies the .search-hit class, but the target may already
    // be rendered (small scroll), so ensure the window covers it and mark it.
    this.codeArea.scrollTop = Math.max(0, block * this.lineH() - this.codeArea.clientHeight / 2);
    this.renderWindow();
    const div = this.codeLines.children[block - this.renderedStart] as HTMLElement | undefined;
    if (div) div.classList.add("search-hit");
    this.searchCount.textContent =
      `${this.searchMatchIndex + 1} of ${hits.length} match${hits.length !== 1 ? "es" : ""}`;
  }

  // =======================================================================
  // Theme
  // =======================================================================

  /**
   * Resolve a theme id to a bundled theme and record it as the current theme.
   * Falls back to the first bundled theme if the id is unknown (e.g. a stale
   * preference or a theme dropped from a build). Updates `dark` from the theme's
   * isDark flag and reflects the choice in the dropdown, but does not re-render;
   * callers apply the theme via applyTheme().
   */
  private setThemeById(id: string): void {
    let theme = this.themesById.get(id);
    if (!theme) theme = this.themes[0];
    if (!theme) return; // no themes bundled (shouldn't happen)
    this.themeId = theme.id;
    this.dark = theme.isDark;
    if (this.themeCombo) this.themeCombo.value = theme.id;
  }

  private onThemeChanged(): void {
    this.setThemeById(this.themeCombo.value);
    this.applyTheme();
    this.applyColoring();
    this.renderGutter();
    this.savePreferences();
  }

  /**
   * Ctrl+D quick toggle between light and dark. Jumps to a theme in the opposite
   * group, preferring a same-family counterpart (e.g. "GitHub" <-> "GitHub
   * Dark") and otherwise the group's default.
   */
  private toggleDarkLight(): void {
    const wantDark = !this.dark;
    const target = this.pickCounterpartTheme(this.themeId, wantDark);
    if (!target) return;
    this.setThemeById(target);
    this.applyTheme();
    this.applyColoring();
    this.renderGutter();
    this.savePreferences();
  }

  /** Pick a theme in the requested light/dark group, favoring a name match. */
  private pickCounterpartTheme(currentId: string, wantDark: boolean): string | null {
    const candidates = this.themes.filter((t) => t.isDark === wantDark);
    if (!candidates.length) return null;
    // Try a family match: strip common light/dark suffixes and compare stems.
    const stem = (id: string) =>
      id.replace(/-?dark$/, "").replace(/-?light$/, "").replace(/^vs2015$/, "vs");
    const curStem = stem(currentId);
    const family = candidates.find((t) => stem(t.id) === curStem);
    if (family) return family.id;
    // Otherwise the group's default.
    return (wantDark ? this.themesById.get("monokai") : this.themesById.get("default"))?.id
      ?? candidates[0].id;
  }

  /**
   * On first run (no user-saved theme, i.e. still the default light theme), ask
   * the host IDE for its current theme and switch to a matching one. A no-op in
   * shells without an IDE (Tauri) or when the IDE theme can't be mapped.
   */
  private async autoMatchIdeTheme(): Promise<void> {
    if (this.themeId !== DEFAULT_LIGHT_THEME_ID) return; // user has a saved theme
    const getIdeTheme = this.deps.host.getIdeTheme;
    if (!getIdeTheme) return;
    let ideTheme: string | null = null;
    try {
      ideTheme = await getIdeTheme.call(this.deps.host);
    } catch {
      return;
    }
    const matchedId = ideThemeToId(ideTheme);
    if (matchedId && this.themesById.has(matchedId)) {
      this.setThemeById(matchedId);
      // Don't persist: this is an inferred default, not an explicit choice, so
      // the app keeps tracking the IDE until the user picks a theme themselves.
    }
  }

  private applyTheme(): void {
    document.body.classList.toggle("dark", this.dark);
    document.body.classList.toggle("light", !this.dark);
    const theme = this.themesById.get(this.themeId);
    this.hljsStyle.textContent = theme?.css ?? "";
    // Match the native title bar / window theme.
    void this.deps.host.setTheme(this.dark ? "dark" : "light");
    // Added/removed rows carry inline diff colours chosen for the old theme.
    if (this.history) this.renderHistoryWindow(this.history, true);
  }

  // =======================================================================
  // Misc
  // =======================================================================

  private setDetailPlaceholder(): void {
    this.detailView.innerHTML = "";
    this.detailView.appendChild(el("div", "placeholder", "Full commit message will appear here."));
    this.prevDetail.innerHTML = "";
    this.prevDetail.appendChild(
      el("div", "placeholder", "Click a line to see the commit that introduced it."),
    );
  }

  private setStatus(msg: string): void {
    this.statusMsg.textContent = msg;
  }

  private startRenameDetection(): void {
    const detect = this.backend?.detectRenames;
    if (!detect) return;
    this.renameDetected = false;
    const token = ++this.renameDetectionToken;
    void detect.call(this.backend).then((segments) => {
      if (token !== this.renameDetectionToken) return;
      if (segments.length > 0) {
        this.renameSegments = segments;
        this.renameDetected = true;
        this.followRenamesBtn.disabled = false;
      }
    }).catch(() => {});
  }

  private async onToggleFollowRenames(): Promise<void> {
    if (!this.backend || !this.renameDetected) return;
    this.followRenamesActive = !this.followRenamesActive;
    this.followRenamesBtn.classList.toggle("active", this.followRenamesActive);
    if (this.followRenamesActive) {
      await this.activateFollowRenames();
    } else {
      this.deactivateFollowRenames();
    }
  }

  private async activateFollowRenames(): Promise<void> {
    this.currentPathCommits = this.commits.slice();
    this.showLoading();
    this.setStatus("Loading rename history...");

    const backend = this.backend!;
    const allSegmentCommits: { path: string; commits: FileHistory[] }[] = [];
    for (const seg of this.renameSegments) {
      try {
        const commits = await backend.getCommitsForPath!(seg.filePath);
        if (commits.length > 0) {
          allSegmentCommits.push({ path: seg.filePath, commits });
        }
      } catch { /* skip failed segments */ }
    }

    const hadModified = this.hasModifiedRev;
    let modifiedEntry: FileHistory | undefined;
    const currentReal = hadModified
      ? this.currentPathCommits.slice(0, -1)
      : this.currentPathCommits;
    if (hadModified) modifiedEntry = this.currentPathCommits[this.currentPathCommits.length - 1];

    const merged: FileHistory[] = [];
    this.segmentBoundaries = [];
    this.commitSegmentPath.clear();
    const renameHexes = new Set(this.renameSegments.map(s => s.renameCommitHex));
    const seen = new Set<string>();

    for (const seg of allSegmentCommits) {
      this.segmentBoundaries.push(merged.length);
      for (const c of seg.commits) {
        if (renameHexes.has(c.hexSha)) continue;
        if (seen.has(c.hexSha)) continue;
        seen.add(c.hexSha);
        this.commitSegmentPath.set(c.hexSha, seg.path);
        merged.push(c);
      }
    }

    this.segmentBoundaries.push(merged.length);
    for (const c of currentReal) {
      if (seen.has(c.hexSha)) continue;
      seen.add(c.hexSha);
      this.commitSegmentPath.set(c.hexSha, this.filePath);
      merged.push(c);
    }

    if (hadModified && modifiedEntry) {
      merged.push(modifiedEntry);
      this.hasModifiedRev = true;
    }

    this.commitRevisions.clear();
    merged.forEach((c, i) => this.commitRevisions.set(c.hexSha, i + 1));
    this.commits = merged;
    this.invalidateHistory();

    const lastReal = this.lastRealIndex();
    this.slider.max = String(lastReal);
    this.slider.value = String(lastReal);
    this.rangeStart = 0;
    this.rangeEnd = lastReal;
    this.updateMRevButton();
    this.refreshSliderLabels();
    this.updateSliderVisibility();

    const precacheToken = ++this.precacheToken;
    this.precaching = true;
    let totalPrecached = 0;
    const totalToPrecache = allSegmentCommits.reduce((s, seg) => s + seg.commits.length, 0);
    for (const seg of allSegmentCommits) {
      if (precacheToken !== this.precacheToken) break;
      try {
        this.precacheRemaining = totalToPrecache - totalPrecached;
        this.refreshStatusBar();
        await backend.populateForPath!(seg.path, (done, _total) => {
          if (precacheToken !== this.precacheToken) return;
          this.precacheRemaining = totalToPrecache - totalPrecached - done;
          this.refreshStatusBar();
        }, this.precacheWorkerCount || null);
      } catch { /* best effort */ }
      totalPrecached += seg.commits.length;
    }
    this.precaching = false;
    this.precacheRemaining = 0;

    await this.buildLifetimeEndMap();
    this.currentIndex = lastReal;
    await this.showRevision(lastReal);
    this.hideLoading();
    this.updateNavButtons();
  }

  private deactivateFollowRenames(): void {
    this.commits = this.currentPathCommits.slice();
    this.invalidateHistory();
    this.currentPathCommits = [];
    this.segmentBoundaries = [];
    this.commitSegmentPath.clear();

    this.commitRevisions.clear();
    this.commits.forEach((c, i) => this.commitRevisions.set(c.hexSha, i + 1));

    this.hasModifiedRev = this.commits.length > 0 &&
      this.commits[this.commits.length - 1].hexSha === MODIFIED_SENTINEL;

    const lastReal = this.lastRealIndex();
    this.slider.max = String(lastReal);
    this.slider.value = String(lastReal);
    this.rangeStart = 0;
    this.rangeEnd = lastReal;
    this.updateMRevButton();
    this.refreshSliderLabels();
    this.updateSliderVisibility();

    void this.buildLifetimeEndMap();
    this.currentIndex = lastReal;
    void this.showRevision(lastReal);
    this.updateNavButtons();
  }

  private isSegmentBoundary(index: number): boolean {
    return this.followRenamesActive && this.segmentBoundaries.includes(index);
  }

  private segmentLabel(index: number): string {
    if (!this.followRenamesActive || this.segmentBoundaries.length < 2) {
      return String(index + 1);
    }
    let segIdx = 0;
    for (let i = this.segmentBoundaries.length - 1; i >= 0; i--) {
      if (index >= this.segmentBoundaries[i]) { segIdx = i; break; }
    }
    const letter = String.fromCharCode(65 + segIdx);
    return `${letter}${index + 1}`;
  }

  private refreshStatusBar(): void {
    if (this.currentIndex < 0 || !this.commits.length) return;
    const commit = this.commits[this.currentIndex];
    // Real revisions count excludes the virtual "uncommitted changes" entry.
    const realCount = this.hasModifiedRev ? this.commits.length - 1 : this.commits.length;
    const revLabel = this.segmentLabel(this.currentIndex);
    let msg = this.isModifiedRev(this.currentIndex)
      ? `Revision M of ${realCount} — uncommitted changes`
      : `Revision ${revLabel} of ${realCount} — ${commit.hexSha}`;
    if (this.followRenamesActive) {
      const segPath = this.commitSegmentPath.get(commit.hexSha) ?? this.filePath;
      msg += `  [path: ${segPath}]`;
    }
    if (this.precaching && this.precacheRemaining > 0) {
      msg += `  (precaching, ${this.precacheRemaining} remaining, using ${this.precacheWorkerCount} threads)`;
    }
    this.setStatus(msg);
  }
}

// ---------------------------------------------------------------------------
// Text helpers
// ---------------------------------------------------------------------------

/** Split content into lines like Python's str.splitlines (no trailing empty). */
function splitLines(text: string): string[] {
  if (text === "") return [];
  const withoutTrailing = text.endsWith("\n") ? text.slice(0, -1) : text;
  return withoutTrailing.split(/\r\n|\r|\n/);
}

/** Map a filename to a highlight.js language id, or "" for auto-detection. */
function hljsLanguageFor(filename: string): string {
  const ext = (filename.split(".").pop() ?? "").toLowerCase();
  const map: Record<string, string> = {
    ts: "typescript", tsx: "typescript", js: "javascript", jsx: "javascript",
    mjs: "javascript", cjs: "javascript",
    py: "python", rs: "rust", go: "go", java: "java", kt: "kotlin",
    c: "c", h: "c", cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", hxx: "cpp",
    cs: "csharp", rb: "ruby", php: "php", swift: "swift", scala: "scala",
    sh: "bash", bash: "bash", zsh: "bash", ps1: "powershell",
    html: "xml", xml: "xml", svg: "xml", vue: "xml",
    css: "css", scss: "scss", less: "less",
    json: "json", yaml: "yaml", yml: "yaml", toml: "ini", ini: "ini",
    md: "markdown", markdown: "markdown", sql: "sql", lua: "lua", pl: "perl",
    r: "r", dart: "dart", ex: "elixir", exs: "elixir", hs: "haskell",
    vhd: "vhdl", vhdl: "vhdl", v: "verilog", sv: "verilog", tcl: "tcl",
    dockerfile: "dockerfile", makefile: "makefile", mk: "makefile",
  };
  if (map[ext] && hljs.getLanguage(map[ext])) return map[ext];
  return "";
}

/**
 * Construct and initialize the app with platform-provided dependencies. Each
 * shell (Tauri, VS Code webview) calls this with its own backend factory, host
 * services, and hljs theme CSS. Returns the App so shells that need to drive it
 * (e.g. VS Code pushing a file to open) can call `loadFile`.
 */
export function startApp(deps: AppDeps): App {
  const app = new App(deps);
  void app.init();
  return app;
}

export { App };
