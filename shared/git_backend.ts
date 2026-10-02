// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT
/**
 * Git interaction layer for git-time-lapse (platform-agnostic).
 *
 * This module has no UI dependencies. It runs the git CLI through an injected
 * `GitTransport` (Tauri `invoke`, or Node `child_process` in the VS Code host)
 * to expose the file history, per-commit content, blame, and line-level diff
 * status needed by the viewer. Blame is derived from patches during precache
 * (see populateFromLog), not from `git blame`. The CLI is used rather than a
 * library binding because it is the most compatible option (e.g. reftables and
 * some submodule edge cases).
 *
 * SAFETY: every git command issued here is strictly read-only. The full set is
 * `rev-parse` (`--show-toplevel`, `--is-bare-repository`,
 * `--is-shallow-repository`, `--verify`, `--symbolic-full-name`),
 * `cat-file -e`, `log`, `show`, `diff`, `ls-files`, `ls-tree`, `for-each-ref`,
 * and `config` reads of `user.name`/`user.email`. There are no `checkout`/`switch`/`stash`/`reset`/`restore`/`add`/
 * `commit`/`merge`/`rebase`/`clean`/`pull`/`push` invocations. Keep any new git
 * calls read-only to preserve this guarantee.
 *
 * Exit codes: `GitTransport` throws on a non-zero git exit. The few call sites
 * that treat a non-zero exit as an expected outcome (existence checks, a
 * missing blob, an empty diff) catch and handle it.
 */

import type { BlameEntry, DiffDetail, DiffRow, FileHistory, GitTransport, RenameSegment } from "./types";
import { BinaryFileError, FileNotFoundError, MODIFIED_SENTINEL } from "./types";

// Re-export shared types/errors so `from "./git_backend"` imports keep working.
export type { BlameEntry, DiffDetail, DiffRow, FileHistory, GitTransport, LineStatus } from "./types";
export { BinaryFileError, FileNotFoundError } from "./types";


// ---------------------------------------------------------------------------
// Binary-path heuristics (file extensions rejected as binary up front)
// ---------------------------------------------------------------------------

const BINARY_EXTENSIONS: ReadonlySet<string> = new Set([
  ".exe", ".dll", ".so", ".dylib", ".o", ".obj", ".a", ".lib",
  ".bin", ".dat", ".db", ".sqlite", ".sqlite3",
  ".png", ".jpg", ".jpeg", ".gif", ".bmp", ".ico", ".tiff", ".tif",
  ".webp", ".svg", ".psd", ".ai", ".eps",
  ".zip", ".gz", ".bz2", ".xz", ".7z", ".tar", ".rar", ".zst",
  ".jar", ".war", ".ear",
  ".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
  ".odt", ".ods", ".odp",
  ".mp3", ".mp4", ".avi", ".mov", ".mkv", ".flv", ".wmv", ".wav",
  ".flac", ".ogg", ".aac", ".m4a", ".webm",
  ".ttf", ".otf", ".woff", ".woff2", ".eot",
  ".pyc", ".pyo", ".class", ".wasm",
  ".iso", ".img", ".dmg", ".msi",
  ".deb", ".rpm", ".apk", ".ipa",
]);

function fileExtension(path: string): string {
  const base = path.replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = base.lastIndexOf(".");
  if (dot <= 0) return ""; // no ext, or dotfile like ".gitignore"
  return base.slice(dot).toLowerCase();
}

function isBinaryPath(filePath: string): boolean {
  return BINARY_EXTENSIONS.has(fileExtension(filePath));
}

// ---------------------------------------------------------------------------
// Decoding helpers
// ---------------------------------------------------------------------------

/**
 * Decode bytes as text, trying utf-8 then latin-1. Throws BinaryFileError if
 * the data contains a NUL byte (a strong signal the file is binary).
 */
function decode(data: Uint8Array): string {
  if (data.includes(0x00)) {
    throw new BinaryFileError("File appears to be binary (contains NUL bytes)");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(data);
  } catch {
    // latin-1 maps every byte 1:1 to U+0000..U+00FF, so it never fails.
    return new TextDecoder("latin1").decode(data);
  }
}

// ---------------------------------------------------------------------------
// Path helper (browser-safe; no Node `path` so it works in the Tauri webview)
// ---------------------------------------------------------------------------

/** Forward slashes + uppercase Windows drive letter, for case-safe compares. */
function normalizePath(p: string): string {
  let norm = p.replace(/\\/g, "/");
  if (/^[a-z]:/.test(norm)) norm = norm[0].toUpperCase() + norm.slice(1);
  return norm;
}

/**
 * Path of `filePath` relative to the repo `toplevel`, with forward slashes.
 * Both sides are normalized (uppercase drive letter) so a Windows drive-letter
 * case mismatch between git's toplevel and an OS path doesn't break the strip.
 * If `filePath` isn't under the root (or is already relative), it's returned
 * normalized as-is.
 */
function relativeRepoPath(toplevel: string, filePath: string): string {
  const root = normalizePath(toplevel).replace(/\/+$/, "");
  const file = normalizePath(filePath);
  if (file.toLowerCase() === root.toLowerCase()) return "";
  const rootSlash = root + "/";
  if (file.toLowerCase().startsWith(rootSlash.toLowerCase())) {
    return file.slice(rootSlash.length);
  }
  return file;
}

// ---------------------------------------------------------------------------
// Date parsing
// ---------------------------------------------------------------------------

/** Parse an ISO-8601 date from `git log --format=%aI`; falls back to epoch. */
function parseIso(value: string): Date {
  const d = new Date(value.trim());
  if (isNaN(d.getTime())) {
    return new Date(0);
  }
  return d;
}

// ---------------------------------------------------------------------------
// Cache key helper
// ---------------------------------------------------------------------------

/**
 * Build a string cache key from a tuple tag such as `("content", hex)` or
 * `("diff", oldHex, newHex)`. NUL joins avoid any
 * collision between hashes/paths containing the separator.
 */
function cacheKey(...parts: string[]): string {
  return parts.join("\x00");
}

// ---------------------------------------------------------------------------
// GitTimeLapse
// ---------------------------------------------------------------------------

/** Provides time-lapse data for a single file within a git repository. */
export class GitTimeLapse {
  private cache = new Map<string, unknown>();
  private repoRoot = "";
  filePath = "";
  /**
   * Revision the history is walked from. Defaults to HEAD, i.e. whatever
   * branch the working tree has checked out. Set to a branch name or commit
   * hash to view the file as of a different point in the graph.
   *
   * Only the entry points that establish the commit list take this; the
   * patch-replay in populateFromLog works from explicit hashes it got out of
   * that list, so scoping the walk is enough to scope everything downstream.
   */
  ref = "HEAD";
  private readonly transport: GitTransport;
  private renameBackends = new Map<string, GitTimeLapse>();

  private constructor(transport: GitTransport) {
    this.transport = transport;
  }

  /**
   * Async factory (constructors can't await). Discovers the repo root, resolves
   * the file path relative to it, and validates the file exists in HEAD and is
   * not binary. `transport` is how git is actually run (platform-provided).
   */
  static async create(
    transport: GitTransport,
    repoPath: string,
    filePath: string,
    ref = "HEAD",
  ): Promise<GitTimeLapse> {
    const self = new GitTimeLapse(transport);
    self.ref = ref || "HEAD";

    // Discover the repo root and repo characteristics in a single git call.
    // Output is three lines: toplevel, is-bare-repository, is-shallow-repository.
    let toplevel: string;
    let bare = "";
    let shallow = "";
    try {
      const out = await transport.runGitText(
        ["rev-parse", "--show-toplevel", "--is-bare-repository", "--is-shallow-repository"],
        repoPath,
      );
      const lines = out.split("\n").map((l) => l.trim());
      toplevel = lines[0] ?? "";
      bare = lines[1] ?? "";
      shallow = lines[2] ?? "";
    } catch (err) {
      throw new Error(`Not a git repository (or git failed) at ${repoPath}: ${err}`);
    }
    self.repoRoot = toplevel;

    // Reject bare repositories (no working tree to inspect).
    if (bare === "true") {
      throw new Error(
        `This is a bare git repository — no working tree is available.\n\n` +
        `git-time-lapse requires a regular (non-bare) clone.`
      );
    }

    // Warn about shallow clones (limited history).
    if (shallow === "true") {
      throw new Error(
        `This is a shallow git clone with limited history.\n\n` +
        `git-time-lapse requires full history to show all revisions.\n` +
        `Run 'git fetch --unshallow' to fetch the complete history.`
      );
    }

    // Compute the file's path relative to the repo root. Normalize both sides
    // (forward slashes, uppercase Windows drive letter) so a drive-letter case
    // mismatch between git's toplevel (c:/path/to/repo) and an OS path
    // (C:\path\to\repo) doesn't
    // break the relative path, which would make cat-file/show fail.
    self.filePath = relativeRepoPath(toplevel, filePath);

    // Check the file exists in HEAD; if not, check if git has any history for
    // it (the file may have been deleted). Only reject if git has never seen it.
    try {
      await transport.runGitText(["cat-file", "-e", `${self.ref}:${self.filePath}`], self.repoRoot);
    } catch {
      // Not in HEAD: check if git log finds any commits that touched this path.
      try {
        const logCheck = await transport.runGitText(
          ["log", "--first-parent", "--oneline", "-1", self.ref, "--", self.filePath], self.repoRoot,
        );
        if (!logCheck.trim()) {
          throw new FileNotFoundError(
            `File '${self.filePath}' not found in repository history`,
          );
        }
      } catch (err) {
        if (err instanceof FileNotFoundError) throw err;
        throw new FileNotFoundError(
          `File '${self.filePath}' not found in HEAD of repository`,
        );
      }
    }

    if (isBinaryPath(self.filePath)) {
      throw new BinaryFileError(`File '${self.filePath}' appears to be binary`);
    }

    return self;
  }

  static async createForHistoricalPath(
    transport: GitTransport,
    repoRoot: string,
    filePath: string,
  ): Promise<GitTimeLapse> {
    const instance = new GitTimeLapse(transport);
    instance.repoRoot = repoRoot;
    instance.filePath = filePath;
    return instance;
  }

  /** The repo root discovered at creation (absolute, git-normalized slashes). */
  async getRepoRoot(): Promise<string> {
    return this.repoRoot;
  }

  // -- git runners -------------------------------------------------------

  /** Run a git command and return decoded stdout; throws on non-zero exit. */
  private async gitText(args: string[]): Promise<string> {
    return this.transport.runGitText(args, this.repoRoot);
  }

  // -- history -----------------------------------------------------------

  private static buildHistory(
    hexSha: string,
    authorName: string,
    authorEmail: string,
    isoDate: string,
    message: string,
  ): FileHistory {
    const trimmed = message.trim();
    const summary = trimmed ? trimmed.split(/\r?\n/)[0] : "";
    return {
      hexSha: hexSha.slice(0, 8),
      authorName,
      authorEmail,
      authoredDate: parseIso(isoDate),
      message,
      summary,
    };
  }

  async getLatestCommitHash(): Promise<string> {
    try {
      // Must mirror getCommits()'s commit selection so the hash matches the
      // newest entry it returns. Both use --first-parent to walk only the
      // linear mainline history.
      const out = await this.gitText([
        "log", "-1", "--first-parent", "--format=%H", this.ref, "--", this.filePath,
      ]);
      return out.trim().slice(0, 8);
    } catch {
      return "";
    }
  }

  /**
   * Validate `ref` and describe it.
   *
   * `hash` is the abbreviated commit it resolves to. `label` is the most
   * meaningful name for it -- branch, else remote/tag, else symbolic ref such
   * as HEAD when detached or FETCH_HEAD -- and is empty when the ref is only a
   * raw commit, so the caller can render "name (hash)" or just "hash".
   * `ok` is false when it does not resolve at all, which is what the switch
   * dialog uses to reject a typo before reloading.
   */
  async resolveRef(ref: string): Promise<{ ok: boolean; label: string; hash: string }> {
    const wanted = (ref || "HEAD").trim() || "HEAD";
    // --verify with ^{commit} rejects anything that is not a real commit-ish,
    // so a typo fails here rather than yielding an empty history later.
    let hash = "";
    try {
      hash = (await this.gitText(["rev-parse", "--verify", "--short", `${wanted}^{commit}`])).trim();
    } catch {
      return { ok: false, label: "", hash: "" };
    }
    if (!hash) return { ok: false, label: "", hash: "" };

    try {
      const full = (await this.gitText(["rev-parse", "--symbolic-full-name", wanted])).trim();
      for (const prefix of ["refs/heads/", "refs/remotes/", "refs/tags/"]) {
        if (full.startsWith(prefix)) return { ok: true, label: full.slice(prefix.length), hash };
      }
      // Non-empty but unprefixed means a bare symbolic ref such as FETCH_HEAD.
      if (full) return { ok: true, label: full, hash };
    } catch {
      // fall through
    }
    // Detached HEAD resolves to no symbolic name, but the ref the user asked
    // for is still worth naming. A raw hash has no name to show.
    if (!/^[0-9a-f]{4,40}$/i.test(wanted)) return { ok: true, label: wanted, hash };
    return { ok: true, label: "", hash };
  }

  /**
   * Local branches, tags and remote-tracking branches, for switch-field
   * autocomplete.
   *
   * `for-each-ref` reads only local ref storage, so remote-tracking branches
   * come from whatever the last fetch left behind -- this never contacts a
   * server. Grouped branches -> tags -> remotes, alphabetical within a group.
   *
   * Deliberately unsorted at the git level. `--sort=-committerdate` has to
   * read the commit object behind each ref, and on a large repo that cost is
   * flat and brutal rather than proportional: measured at ~5.2s whether the
   * spec matched 18 refs or 23,325, against ~0.36s for the same query with no
   * sort. Ordering is done below instead, where it is free.
   */
  async listRefs(): Promise<{ name: string; kind: "branch" | "tag" | "remote" }[]> {
    let out: string;
    try {
      out = await this.gitText([
        "for-each-ref", "--format=%(refname)",
        "refs/heads", "refs/tags", "refs/remotes",
      ]);
    } catch {
      return [];
    }
    const branches: { name: string; kind: "branch" | "tag" | "remote" }[] = [];
    const tags: typeof branches = [];
    const remotes: typeof branches = [];
    for (const raw of out.split("\n")) {
      const line = raw.trim();
      if (!line) continue;
      if (line.startsWith("refs/heads/")) {
        branches.push({ name: line.slice("refs/heads/".length), kind: "branch" });
      } else if (line.startsWith("refs/tags/")) {
        tags.push({ name: line.slice("refs/tags/".length), kind: "tag" });
      } else if (line.startsWith("refs/remotes/")) {
        const name = line.slice("refs/remotes/".length);
        // refs/remotes/<remote>/HEAD is a symbolic alias for that remote's
        // default branch, which is already listed. Listing it too is noise.
        if (name.endsWith("/HEAD")) continue;
        remotes.push({ name, kind: "remote" });
      }
    }
    // Sorted here rather than by git: see the note above on --sort cost.
    // Remotes sort by name so each remote's branches cluster together.
    const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);
    branches.sort(byName);
    tags.sort(byName);
    remotes.sort(byName);
    return [...branches, ...tags, ...remotes];
  }

  async getFileModifiedState(): Promise<string> {
    // The working tree belongs to HEAD. When viewing another ref, a diff
    // against it would report every change between the two revisions as an
    // uncommitted edit, so the virtual "modified" revision is suppressed.
    if (this.ref !== "HEAD") return "";
    try {
      const out = await this.gitText([
        "diff", "--name-only", "HEAD", "--", this.filePath,
      ]);
      return out.trim() ? "modified" : "";
    } catch {
      return "";
    }
  }

  /** Return all commits that touched the file, oldest-to-newest. */
  async getCommits(): Promise<FileHistory[]> {
    // Fields separated by newline (%n); commits terminated by a NUL (%x00).
    // --reverse yields oldest-first.
    const out = await this.gitText([
      "log",
      "--first-parent",
      "--format=%H%n%an%n%ae%n%aI%n%B%x00",
      "--reverse",
      this.ref,
      "--",
      this.filePath,
    ]);

    const history: FileHistory[] = [];
    for (let block of out.split("\x00")) {
      // Between commits git emits the NUL then a newline; strip leading
      // newlines before deciding whether the block is empty.
      block = block.replace(/^\n+/, "");
      if (!block.trim()) continue;
      // Split into exactly the five fixed fields; the message (%B) is the final
      // field and may itself contain newlines and blank lines.
      const parts = splitN(block, "\n", 4);
      if (parts.length < 5) continue;
      let [hexSha, authorName, authorEmail, isoDate, message] = parts;
      // %B is the raw body and git appends a trailing newline; strip only that
      // final newline, preserving blank lines within.
      if (message.endsWith("\n")) message = message.slice(0, -1);
      history.push(
        GitTimeLapse.buildHistory(hexSha, authorName, authorEmail, isoDate, message),
      );
    }
    return history;
  }

  /** Return metadata (author, date, full message) for a single commit. */
  async getCommitInfo(commitHex: string): Promise<FileHistory> {
    const key = cacheKey("commit_info", commitHex);
    const cached = this.cache.get(key);
    if (cached) return cached as FileHistory;

    const out = await this.gitText([
      "log",
      "-1",
      "--format=%H%n%an%n%ae%n%aI%n%B",
      commitHex,
    ]);
    const parts = splitN(out, "\n", 4);
    const hexSha = parts[0] ?? "";
    const authorName = parts[1] ?? "";
    const authorEmail = parts[2] ?? "";
    const isoDate = parts[3] ?? "";
    let message = parts[4] ?? "";
    if (message.endsWith("\n")) message = message.slice(0, -1);
    const result = GitTimeLapse.buildHistory(
      hexSha, authorName, authorEmail, isoDate, message,
    );
    this.cache.set(key, result);
    return result;
  }

  // -- file tree ---------------------------------------------------------

  /**
   * List the immediate children of a directory. `dirPath` is a repo-relative
   * path with forward slashes and no trailing slash; the empty string means the
   * repo root. Returns each child's name (not full path) and whether it is a
   * directory, so the UI can lazily expand one level at a time.
   *
   * `git ls-files -- <dir>/` reads the index (respecting sparse-checkout, so it
   * stays consistent with listAllFiles), but returns full paths recursively with
   * no directory entries. So we collapse the results to a single level: the first
   * path segment after the directory prefix is the child name, and any child with
   * a further slash after it is a directory. The root case omits the pathspec.
   *
   * The `-t` flag prefixes each line with a status tag; we keep `H` (cached, in
   * the sparse cone) and `S` (skip-worktree, outside the cone). `S` entries are
   * returned with `sparse: true` so the UI can mark them as hidden by sparse
   * checkout; an entry is a directory if any of its members has a further slash.
   * A name that appears both cached and skip-worktree (e.g. a directory with a
   * mix of files) is treated as present (not sparse).
   *
   * Submodules are gitlinks (mode 160000) and appear in `ls-files` as a single
   * entry with no trailing slash, so they'd be misclassified as files. A
   * `git ls-tree HEAD -- <dir>/` at the same level exposes each child's mode; any
   * name with mode 160000 is marked `isSubmodule: true` and forced to `isDir`,
   * so the UI can render it as an expandable directory.
   */
  async listDirectory(dirPath: string): Promise<{ name: string; isDir: boolean; sparse?: boolean; isSubmodule?: boolean }[]> {
    const clean = dirPath.replace(/^\/+|\/+$/g, "");
    const args = clean ? ["ls-files", "-t", "--", `${clean}/`] : ["ls-files", "-t"];
    let out: string;
    try {
      out = await this.gitText(args);
    } catch {
      return [];
    }
    const prefix = clean ? clean + "/" : "";
    const seen = new Map<string, { name: string; isDir: boolean; sparse: boolean }>();
    for (const raw of out.split("\n")) {
      if (raw[1] !== " " || (raw[0] !== "H" && raw[0] !== "S")) continue;
      const line = raw.slice(2);
      if (!line) continue;
      const rel = prefix && line.startsWith(prefix) ? line.slice(prefix.length) : line;
      if (!rel) continue;
      const slash = rel.indexOf("/");
      const name = slash === -1 ? rel : rel.slice(0, slash);
      if (!name) continue;
      const isDir = slash !== -1;
      const sparse = raw[0] === "S";
      const existing = seen.get(name);
      if (existing) {
        // A directory can hold both cached and skip-worktree members; if any
        // member is cached, the directory is present (not sparse).
        if (!sparse) existing.sparse = false;
      } else {
        seen.set(name, { name, isDir, sparse });
      }
    }

    // Identify submodules (gitlinks) at this level via ls-tree's mode column.
    const submodules = await this.listSubmoduleNames(clean);

    const entries: { name: string; isDir: boolean; sparse?: boolean; isSubmodule?: boolean }[] = [];
    for (const e of seen.values()) {
      const isSubmodule = submodules.has(e.name);
      const isDir = isSubmodule || e.isDir;
      if (e.sparse) {
        entries.push(isSubmodule ? { name: e.name, isDir, sparse: true, isSubmodule: true } : { name: e.name, isDir, sparse: true });
      } else {
        entries.push(isSubmodule ? { name: e.name, isDir, isSubmodule: true } : { name: e.name, isDir });
      }
    }
    return entries;
  }

  /**
   * Names of immediate-child submodules (gitlinks, mode 160000) under a
   * repo-relative directory ("" = root), read from `git ls-tree <ref>`. Failures
   * (no HEAD, detached, etc.) yield an empty set so directory listing is never
   * blocked by submodule detection.
   */
  private async listSubmoduleNames(clean: string): Promise<Set<string>> {
    const names = new Set<string>();
    const args = clean
      ? ["ls-tree", this.ref, "--", `${clean}/`]
      : ["ls-tree", this.ref];
    let out: string;
    try {
      out = await this.gitText(args);
    } catch {
      return names;
    }
    const prefix = clean ? clean + "/" : "";
    for (const line of out.split("\n")) {
      if (!line) continue;
      // Format: "<mode> <type> <hash>\t<path>"
      const tab = line.indexOf("\t");
      if (tab === -1) continue;
      const mode = line.slice(0, line.indexOf(" "));
      if (mode !== "160000") continue;
      let path = line.slice(tab + 1);
      if (prefix && path.startsWith(prefix)) path = path.slice(prefix.length);
      if (path && path.indexOf("/") === -1) names.add(path);
    }
    return names;
  }

  /**
   * List files that once existed directly under `dirPath` but are no longer in
   * HEAD (deleted, and not re-added). `dirPath` is repo-relative with forward
   * slashes and no trailing slash; the empty string means the repo root. Returns
   * just the immediate child filenames (not full paths, not nested).
   *
   * A `git log --diff-filter=D` over a directory glob can report paths nested
   * deeper than one level and paths that were later re-added, so results are
   * post-filtered to immediate children and cross-checked against the live
   * listDirectory so a still-present path is never reported as deleted.
   */
  async listDeletedInDirectory(dirPath: string): Promise<string[]> {
    const info = await this.listDirectoryInfo(dirPath);
    return info.deleted;
  }

  /**
   * Combined directory info from a single `git log` over two glob pathspecs:
   * immediate children (`<dir>/*`) and one level deeper (`<dir>/*​/*`). The log
   * (without --diff-filter) outputs every file ever touched at those depths.
   *
   * - Immediate children: count occurrences for per-file revision counts; any
   *   name not present in the live `listDirectory` listing is a deleted file.
   * - One-level-deeper paths: extract the intervening subdirectory name; any
   *   such subdir not present in the live listing is a deleted directory (its
   *   files are gone from HEAD but existed in history). These are returned in a
   *   separate `deletedDirs` array so the UI can render them as directories.
   */
  async listDirectoryInfo(
    dirPath: string,
  ): Promise<{ deleted: string[]; deletedDirs: string[]; counts: Map<string, number> }> {
    const clean = dirPath.replace(/^\/+|\/+$/g, "");
    const immediateGlob = clean ? `:(glob)${clean}/*` : ":(glob)*";
    const deeperGlob = clean ? `:(glob)${clean}/*/*` : ":(glob)*/*";
    const counts = new Map<string, number>();
    const deeperDirs = new Set<string>();
    try {
      const out = await this.gitText([
        "log", "--first-parent", "--format=", "--name-only", this.ref, "--",
        immediateGlob, deeperGlob,
      ]);
      const prefix = clean ? clean + "/" : "";
      for (const line of out.split("\n")) {
        const path = line.trim();
        if (!path) continue;
        const rel = prefix && path.startsWith(prefix) ? path.slice(prefix.length) : path;
        if (!rel) continue;
        const slash = rel.indexOf("/");
        if (slash === -1) {
          // Immediate child file.
          counts.set(rel, (counts.get(rel) ?? 0) + 1);
        } else {
          // One-level-deeper path: record its subdirectory name.
          const sub = rel.slice(0, slash);
          if (sub) deeperDirs.add(sub);
        }
      }
    } catch {
      return { deleted: [], deletedDirs: [], counts };
    }

    // `listDirectory` now returns both cached (`H`) and sparse-excluded (`S`)
    // entries. Sparse entries are present in the index (just outside the
    // sparse-checkout cone), so folding them into the live sets keeps them from
    // being reported as deleted; they render as "(sparse)" instead. In
    // a non-sparse repo there are no `S` entries, so this is a no-op there.
    const liveFiles = new Set<string>();
    const liveDirs = new Set<string>();
    try {
      for (const child of await this.listDirectory(clean)) {
        if (child.isDir) liveDirs.add(child.name);
        else liveFiles.add(child.name);
      }
    } catch { /* empty */ }

    const deleted: string[] = [];
    for (const name of counts.keys()) {
      if (!liveFiles.has(name) && !liveDirs.has(name)) deleted.push(name);
    }
    deleted.sort();

    const deletedDirs: string[] = [];
    for (const name of deeperDirs) {
      if (!liveDirs.has(name)) deletedDirs.push(name);
    }
    deletedDirs.sort();

    return { deleted, deletedDirs, counts };
  }

  async getGitUserEmail(): Promise<string> {
    try {
      const local = (await this.gitText(["config", "user.email"])).trim();
      if (local) return local;
    } catch { /* fall through */ }
    try {
      return (await this.gitText(["config", "--global", "user.email"])).trim();
    } catch {
      return "";
    }
  }

  async getGitUserName(): Promise<string> {
    try {
      const local = (await this.gitText(["config", "user.name"])).trim();
      if (local) return local;
    } catch { /* fall through */ }
    try {
      return (await this.gitText(["config", "--global", "user.name"])).trim();
    } catch {
      return "";
    }
  }

  /**
   * List every tracked file (full repo-relative paths, forward slashes). Used
   * only to power the tree's filter/search, where all paths are needed at once.
   * `ls-files` reads the index rather than the HEAD tree, so it respects
   * sparse-checkout (only files in the sparse cone appear) and stays fast on
   * large repos. In a non-sparse repo it lists the same set as `ls-tree -r HEAD`.
   *
   * The `-t` flag prefixes each line with a status tag; we keep only `H` (cached,
   * in the sparse cone) and drop `S` (skip-worktree, outside the cone). Plain
   * `ls-files` still lists skip-worktree files, which would surface directories
   * the user has not checked out.
   */
  async listAllFiles(): Promise<string[]> {
    try {
      const out = await this.gitText(["ls-files", "-t"]);
      const files: string[] = [];
      for (const raw of out.split("\n")) {
        if (raw[1] === " " && raw[0] === "H") files.push(raw.slice(2));
      }
      return files;
    } catch {
      return [];
    }
  }

  /**
   * List every sparse (skip-worktree) file: the `S`-tagged entries `listAllFiles`
   * drops. Full repo-relative paths, forward slashes. Used to fold sparse files
   * into the tree's filter search when "Show Sparse Files" is enabled; in a
   * non-sparse repo this is empty.
   */
  async listSparseFiles(): Promise<string[]> {
    try {
      const out = await this.gitText(["ls-files", "-t"]);
      const files: string[] = [];
      for (const raw of out.split("\n")) {
        if (raw[1] === " " && raw[0] === "S") files.push(raw.slice(2));
      }
      return files;
    } catch {
      return [];
    }
  }

  /**
   * List files with uncommitted changes (staged or unstaged) relative to HEAD.
   * Returns a Set of repo-relative paths.
   */
  async listModifiedFiles(): Promise<Set<string>> {
    const modified = new Set<string>();
    if (this.ref !== "HEAD") return modified;   // see getFileModifiedState
    try {
      const out = await this.gitText(["diff", "--name-only", "HEAD"]);
      for (const line of out.split("\n")) {
        const path = line.trim();
        if (path) modified.add(path);
      }
    } catch {
      // empty set on error
    }
    try {
      const out = await this.gitText(["diff", "--name-only", "--cached"]);
      for (const line of out.split("\n")) {
        const path = line.trim();
        if (path) modified.add(path);
      }
    } catch {
      // empty set on error
    }
    return modified;
  }

  /**
   * Get the first-parent revision count for a single file.
   */
  async getFileRevisionCount(filePath: string): Promise<number> {
    try {
      const out = await this.gitText([
        "rev-list", "--count", "--first-parent", this.ref, "--", filePath,
      ]);
      return parseInt(out.trim(), 10) || 0;
    } catch {
      return 0;
    }
  }

  async listDirectoryRevisionCounts(dirPath: string): Promise<Map<string, number>> {
    const info = await this.listDirectoryInfo(dirPath);
    return info.counts;
  }

  // -- precache ----------------------------------------------------------

  /**
   * Warm the entire cache in two phases.
   *
   * Phase 1 (parallel content): split the commit list into up to `WORKERS`
   * ranges and, for each, `git show <prev>:<file>` to seed content then
   * `git log -p --reverse <start>^..<end> -- <file>` to get patches, replaying
   * them forward to reconstruct (and cache) the file content at every commit.
   * Each parsed patch is stashed in a local `patches` map (keyed by short hex).
   *
   * Phase 2 (sequential blame): after all ranges finish, replay every patch in
   * commit order from an empty file, carrying per-line blame forward. This is
   * the only correct way to attribute lines: the parallel ranges can't know the
   * true blame of context lines they inherit from a neighbouring range's tail,
   * so blame is derived here where the full ordered history is available. It
   * issues no new git calls; it reuses the patches captured in phase 1 (or, for
   * the rare commit whose patch replay failed, re-seeds from that commit's
   * already-cached content).
   *
   * Total git commands: 1 (commit list) + 2*workers (seed + log -p per range)
   * instead of 3*N individual calls.
   *
   * Best-effort: any error in a range leaves those revisions uncached so the
   * per-command fallbacks in getFileContent/getDiffDetail serve them.
   */
  async populateFromLog(
    onProgress?: (done: number, total: number) => void,
    workerCount?: number | null,
  ): Promise<void> {
    const cpus = typeof navigator !== "undefined" ? navigator.hardwareConcurrency : 0;
    const WORKERS = (workerCount && workerCount > 0) ? workerCount : Math.max(2, Math.floor((cpus || 16) / 2));
    let commitHashes: string[];
    // Per-commit author metadata keyed by 8-char hex, carried into the
    // sequential blame pass so added/modified lines get real author/date info.
    const commitMeta = new Map<
      string,
      { authorName: string; authorEmail: string; authoredDate: Date }
    >();
    try {
      // Must mirror getCommits()'s commit selection (--first-parent) so the hash
      // list (and therefore the indices, seed hashes, and cache keys) line up
      // with what the UI requests. NUL-delimited fields + SOH record separator
      // keep author names/dates parseable even with odd characters.
      const out = await this.gitText([
        "log", "--first-parent", "--format=%x01%H%x00%an%x00%ae%x00%aI",
        "--reverse", this.ref, "--", this.filePath,
      ]);
      commitHashes = [];
      for (const block of out.split("\x01")) {
        if (!block) continue;
        const fields = block.split("\x00");
        if (fields.length < 4) continue;
        const hexSha = fields[0].trim();
        if (!hexSha) continue;
        commitHashes.push(hexSha);
        commitMeta.set(hexSha.slice(0, 8), {
          authorName: fields[1],
          authorEmail: fields[2],
          authoredDate: parseIso(fields[3]),
        });
      }
    } catch {
      return;
    }
    const total = commitHashes.length;
    if (total === 0) return;

    const rangeSize = Math.ceil(total / WORKERS);
    const ranges: { start: number; end: number }[] = [];
    for (let i = 0; i < total; i += rangeSize) {
      ranges.push({ start: i, end: Math.min(i + rangeSize, total) });
    }

    // Patches parsed during the parallel content phase, keyed by short hex, so
    // the sequential blame pass can replay them in order without new git calls.
    // A commit absent from this map (its patch replay failed and it was re-seeded
    // from the blob) triggers a content re-seed in the blame pass instead.
    const patches = new Map<string, string>();

    let done = 0;

    const processRange = async (range: { start: number; end: number }): Promise<void> => {
      const endHash = commitHashes[range.end - 1];

      // Seed: get the file content at the commit before the range's first commit
      // so we can replay patches forward. For the first range (start=0), there's
      // no prior commit; the first patch is a full add against /dev/null.
      let seedContent: string[] = [];
      if (range.start > 0) {
        const prevHash = commitHashes[range.start - 1];
        try {
          const bytes = await this.transport.runGitBytes(
            ["show", `${prevHash}:${this.filePath}`],
            this.repoRoot,
          );
          const text = decode(bytes);
          seedContent = text.endsWith("\n")
            ? text.slice(0, -1).split("\n")
            : text.split("\n");
        } catch {
          return; // can't seed this range; fall back to per-command
        }
      }

      // Get patches for this range
      let logOut: string;
      try {
        const revRange = range.start === 0
          ? [endHash]
          : [`${commitHashes[range.start - 1]}..${endHash}`];
        // --first-parent walks only the linear mainline, matching getCommits()'s
        // traversal and the commitHashes list above so indices stay in sync. -m
        // is required because merge commits produce no diff otherwise; with
        // --first-parent, -m emits the diff against the first parent only, which
        // is exactly the forward-replay change we want. Together they yield one
        // patch per file-touching mainline commit, preserving the
        // one-patch-per-commit invariant the forward replay depends on.
        logOut = await this.gitText([
          "log",
          "--first-parent",
          "-m",
          "--format=%x01%H%n%an%n%ae%n%aI%n%B%x00",
          "--no-renames",
          "--no-color",
          "-p",
          "--reverse",
          ...revRange,
          "--",
          this.filePath,
        ]);
      } catch {
        return;
      }

      const commits = GitTimeLapse.parseLogWithPatches(logOut);
      let content = seedContent;
      // Blame is a throwaway placeholder here: the parallel phase only
      // reconstructs content. Real per-line blame is derived in the sequential
      // pass below. applyPatchForward still needs a blame array to mutate, so
      // pass one of matching length filled with empty attribution.
      let blame: LineBlame[] = seedContent.map(() => EMPTY_BLAME);
      let prevHex = range.start > 0 ? commitHashes[range.start - 1].slice(0, 8) : "";

      for (const commit of commits) {
        const hex = commit.hexSha.slice(0, 8);

        if (prevHex) {
          this.cache.set(cacheKey("patch", prevHex, hex), commit.patch);
        }
        // Stash every commit's patch (including the first, which prevHex skips)
        // for the sequential blame replay.
        patches.set(hex, commit.patch);

        try {
          const applied = applyPatchForward(content, blame, commit.patch, EMPTY_ATTRIB);
          content = applied.content;
          blame = applied.blame;
        } catch {
          // Patch replay failed for this commit. Re-seed content from the real
          // blob so the *next* commit's patch applies against correct text
          // (leaving content stale here would corrupt every later revision). Drop
          // this commit's patch from the map so the blame pass re-seeds too. If
          // even the fallback fails, drop this range's replay to avoid feeding
          // downstream commits from a desynced state.
          patches.delete(hex);
          try {
            const bytes = await this.transport.runGitBytes(
              ["show", `${commit.hexSha}:${this.filePath}`],
              this.repoRoot,
            );
            const text = decode(bytes);
            content = text.endsWith("\n")
              ? text.slice(0, -1).split("\n")
              : text.split("\n");
            blame = content.map(() => EMPTY_BLAME);
            if (!text.includes("\0")) {
              this.cache.set(cacheKey("content", hex), text);
            }
            prevHex = hex;
            done += 1;
            onProgress?.(done, total);
            continue;
          } catch {
            return; // can't recover; per-command fallbacks serve the rest
          }
        }

        const text =
          content.length === 0
            ? ""
            : content.join("\n") + (commit.trailingNewline ? "\n" : "");
        if (text.includes("\0")) {
          prevHex = hex;
          done += 1;
          onProgress?.(done, total);
          continue;
        }
        this.cache.set(cacheKey("content", hex), text);

        prevHex = hex;
        done += 1;
        onProgress?.(done, total);
      }
    };

    await Promise.all(ranges.map((r) => processRange(r)));

    // Phase 2: sequential blame pass. Replay every commit's patch in order from
    // an empty file, carrying per-line blame forward so context lines keep their
    // true origin commit. Content is already cached from phase 1; this only
    // computes and caches blame. No new git calls (patches were captured above).
    let content: string[] = [];
    let blame: LineBlame[] = [];
    for (const fullHash of commitHashes) {
      const hex = fullHash.slice(0, 8);
      const meta = commitMeta.get(hex);
      const storedPatch = patches.get(hex);

      if (storedPatch === undefined) {
        // This commit's patch replay failed in phase 1 (re-seeded from blob).
        // Re-seed blame from the cached content so later commits stay aligned.
        const cachedText = this.cache.get(cacheKey("content", hex)) as string | undefined;
        if (cachedText === undefined) {
          // Content was never cached (e.g. binary or unrecoverable). Give up on
          // the rest; remaining commits fall back to per-command blame (empty).
          break;
        }
        content = cachedText === ""
          ? []
          : (cachedText.endsWith("\n") ? cachedText.slice(0, -1) : cachedText).split("\n");
        blame = content.map((_, idx) => ({
          commitHex: hex,
          authorName: meta?.authorName ?? "",
          authorEmail: meta?.authorEmail ?? "",
          authoredDate: meta?.authoredDate ?? new Date(0),
          originLine: idx + 1,
        }));
        this.cache.set(cacheKey("blame", hex), blameToEntries(blame));
        continue;
      }

      try {
        const applied = applyPatchForward(content, blame, storedPatch, {
          commitHex: hex,
          authorName: meta?.authorName ?? "",
          authorEmail: meta?.authorEmail ?? "",
          authoredDate: meta?.authoredDate ?? new Date(0),
        });
        content = applied.content;
        blame = applied.blame;
      } catch {
        // Should not happen (phase 1 already validated the replay), but stay
        // robust: re-seed from cached content and continue.
        const cachedText = this.cache.get(cacheKey("content", hex)) as string | undefined;
        if (cachedText === undefined) break;
        content = cachedText === ""
          ? []
          : (cachedText.endsWith("\n") ? cachedText.slice(0, -1) : cachedText).split("\n");
        blame = content.map((_, idx) => ({
          commitHex: hex,
          authorName: meta?.authorName ?? "",
          authorEmail: meta?.authorEmail ?? "",
          authoredDate: meta?.authoredDate ?? new Date(0),
          originLine: idx + 1,
        }));
      }
      this.cache.set(cacheKey("blame", hex), blameToEntries(blame));
    }
  }

  /**
   * Parse `git log -p` output (with the %x01-prefixed, %x00-terminated header
   * format used by populateFromLog) into per-commit metadata + patch bodies,
   * oldest-first. Each commit block is: SOH, the five header fields (H, an, ae,
   * aI, B) separated by newlines, a NUL, then the unified-diff patch (which
   * runs until the next SOH or EOF).
   */
  private static parseLogWithPatches(out: string): ParsedLogCommit[] {
    const commits: ParsedLogCommit[] = [];
    // Split on the SOH record separator; the first chunk before the first SOH
    // is empty (or leading whitespace) and is skipped.
    const blocks = out.split("\x01");
    for (const block of blocks) {
      if (!block) continue;
      const nul = block.indexOf("\x00");
      if (nul === -1) continue;
      const headerPart = block.slice(0, nul);
      // After the NUL git emits a newline before the patch (and before the next
      // record). Strip a single leading newline so the patch starts clean.
      let patch = block.slice(nul + 1);
      if (patch.startsWith("\n")) patch = patch.slice(1);

      // For merge commits, `git log -m` emits one `diff --git` section per
      // parent. Keep only the first (against the first parent) to match the
      // --first-parent semantics of our forward replay; the extra sections
      // would otherwise corrupt the reconstructed content.
      if (patch.startsWith("diff --git ")) {
        const secondDiff = patch.indexOf("\ndiff --git ", 1);
        if (secondDiff !== -1) patch = patch.slice(0, secondDiff + 1);
      }

      const parts = splitN(headerPart, "\n", 4);
      if (parts.length < 5) continue;
      let [hexSha, authorName, authorEmail, isoDate, message] = parts;
      if (message.endsWith("\n")) message = message.slice(0, -1);

      commits.push({
        hexSha,
        authorName,
        authorEmail,
        isoDate,
        message,
        patch,
        // Whether the reconstructed file ends with a newline. False only when
        // the patch's final new-side line carries a "\ No newline at end of
        // file" marker; true otherwise (the common case).
        trailingNewline: !patchEndsWithoutNewline(patch),
      });
    }
    return commits;
  }

  /**
   * Whether content, blame, and diff are all cached for a commit. The diff key
   * depends on the previous commit, which this method doesn't know, so it
   * treats any cached diff whose new-side hash matches as a hit.
   */
  isCached(commitHex: string): boolean {
    if (!this.cache.has(cacheKey("content", commitHex))) return false;
    if (!this.cache.has(cacheKey("blame", commitHex))) return false;
    for (const key of this.cache.keys()) {
      const p = key.split("\x00");
      if (p[0] === "diff" && p[2] === commitHex) return true;
    }
    return false;
  }

  // -- content -----------------------------------------------------------

  /**
   * Return the file's content at the given commit as text. Uses the
   * `git show <rev>:<path>` object syntax so git returns the file blob at that
   * revision, not the commit object. An empty commitHex is rejected outright.
   */
  async getFileContent(commitHex: string): Promise<string> {
    if (!commitHex) {
      throw new FileNotFoundError("Empty commit ref for getFileContent");
    }
    const key = cacheKey("content", commitHex);
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached as string;

    let bytes: Uint8Array;
    try {
      bytes = await this.transport.runGitBytes(
        ["show", `${commitHex}:${this.filePath}`],
        this.repoRoot,
      );
    } catch {
      throw new FileNotFoundError(
        `File '${this.filePath}' not present in commit ${commitHex}`,
      );
    }
    // decode() may throw BinaryFileError (NUL bytes); let that propagate.
    const content = decode(bytes);
    this.cache.set(key, content);
    return content;
  }

  // -- blame -------------------------------------------------------------

  /**
   * Return blame data for the file at the given commit. Blame is derived from
   * patches by populateFromLog and stored in the cache; this is a cache-only
   * lookup. The expensive `git blame --porcelain` call has been removed since
   * precache always runs (and completes) before any revision is displayed. If
   * the cache is somehow cold for a commit, return an empty blame rather than
   * falling back to git.
   */
  async getBlame(commitHex: string): Promise<BlameEntry[]> {
    const key = cacheKey("blame", commitHex);
    const cached = this.cache.get(key);
    if (cached) return cached as BlameEntry[];
    return [];
  }

  // -- diff --------------------------------------------------------------

  /** Return the raw unified diff between two commits, cached. */
  private async getPatch(oldHex: string, newHex: string): Promise<string> {
    const key = cacheKey("patch", oldHex, newHex);
    const cached = this.cache.get(key);
    if (cached !== undefined) return cached as string;

    // A non-zero diff exit is treated as "no patch" (empty), matching the
    // prior behavior; the transport throws on non-zero, so catch to "".
    let patch = "";
    try {
      patch = await this.transport.runGitText(
        ["diff", oldHex, newHex, "--", this.filePath],
        this.repoRoot,
      );
    } catch {
      patch = "";
    }
    this.cache.set(key, patch);
    return patch;
  }

  async getCrossPathDiffRows(
    oldHex: string,
    oldPath: string,
    newHex: string,
    newPath: string,
    sourceLines: string[],
  ): Promise<DiffRow[]> {
    let patch = "";
    try {
      patch = await this.transport.runGitText(
        ["diff", `${oldHex}:${oldPath}`, `${newHex}:${newPath}`],
        this.repoRoot,
      );
    } catch {
      patch = "";
    }
    if (!patch.trim()) {
      return sourceLines.map((text, i) => ({
        lineno: i + 1,
        oldLineno: null,
        status: "unchanged" as const,
        text,
      }));
    }
    return GitTimeLapse.parsePatchRows(patch, sourceLines);
  }

  /**
   * Map a line number from oldCommit to its position in newCommit. Walks the
   * diff hunks tracking how insertions and deletions shift line numbers.
   * Returns the translated line number in the new file, or null if deleted.
   */
  async translateLine(
    oldLineno: number,
    oldCommitHex: string,
    newCommitHex: string,
  ): Promise<number | null> {
    if (!oldCommitHex || !newCommitHex) return oldLineno;
    if (oldCommitHex === newCommitHex) return oldLineno;
    const patch = await this.getPatch(oldCommitHex, newCommitHex);
    if (!patch.trim()) return oldLineno;
    return GitTimeLapse.translateThroughPatch(oldLineno, patch);
  }

  /**
   * Compute where oldLineno ends up after applying a unified diff. Walks each
   * hunk line-by-line, tracking old and new line cursors so insertions and
   * deletions before/around oldLineno are accounted for precisely.
   */
  private static translateThroughPatch(
    oldLineno: number,
    patch: string,
  ): number | null {
    let oldCur = 0;
    let newCur = 0;
    let lastOffset = 0;
    let inHunk = false;

    for (const line of patch.split("\n")) {
      if (line.startsWith("@@")) {
        if (inHunk && oldLineno < oldCur) {
          return oldLineno + lastOffset;
        }
        const parts = line.split(/\s+/);
        const oldPart = parts[1];
        const newPart = parts[2];
        if (oldPart === undefined || newPart === undefined) continue;
        const oc = parseInt(oldPart.split(",")[0].replace(/^-/, ""), 10);
        const nc = parseInt(newPart.split(",")[0].replace(/^\+/, ""), 10);
        if (isNaN(oc) || isNaN(nc)) continue;
        oldCur = oc;
        newCur = nc;
        if (oldLineno < oldCur) {
          return oldLineno + lastOffset;
        }
        lastOffset = newCur - oldCur;
        inHunk = true;
        continue;
      }
      if (!inHunk) continue;
      if (line.startsWith("---") || line.startsWith("+++")) continue;
      if (line.startsWith("-")) {
        if (oldCur === oldLineno) return null;
        oldCur += 1;
        lastOffset -= 1;
      } else if (line.startsWith("+")) {
        newCur += 1;
        lastOffset += 1;
      } else {
        if (oldCur === oldLineno) return oldLineno + lastOffset;
        oldCur += 1;
        newCur += 1;
      }
    }
    return oldLineno + lastOffset;
  }

  /**
   * Map each line number in the new version to its diff status
   * ('added' | 'modified' | 'unchanged'). If oldCommitHex is falsy (the first
   * commit has no parent), every line is 'added'.
   */
  async getDiffLines(
    oldCommitHex: string,
    newCommitHex: string,
  ): Promise<Map<number, string>> {
    const newContent = await this.getFileContent(newCommitHex);
    const newLineCount = splitLines(newContent).length;

    if (!oldCommitHex) {
      const m = new Map<number, string>();
      for (let i = 1; i <= newLineCount; i++) m.set(i, "added");
      return m;
    }

    const patch = await this.getPatch(oldCommitHex, newCommitHex);
    if (!patch.trim()) {
      const m = new Map<number, string>();
      for (let i = 1; i <= newLineCount; i++) m.set(i, "unchanged");
      return m;
    }

    return GitTimeLapse.parsePatchStatuses(patch, newLineCount);
  }

  /** Return richer diff info (statuses + removals + modifiedOld), cached. */
  async getDiffDetail(
    oldCommitHex: string,
    newCommitHex: string,
  ): Promise<DiffDetail> {
    const key = cacheKey("diff", oldCommitHex, newCommitHex);
    const cached = this.cache.get(key);
    if (cached) return cached as DiffDetail;

    const newContent = await this.getFileContent(newCommitHex);
    const newLineCount = splitLines(newContent).length;

    if (!oldCommitHex) {
      const statuses = new Map<number, string>();
      for (let i = 1; i <= newLineCount; i++) statuses.set(i, "added");
      const result: DiffDetail = {
        statuses,
        removals: new Map(),
        modifiedOld: new Map(),
      };
      this.cache.set(key, result);
      return result;
    }

    const patch = await this.getPatch(oldCommitHex, newCommitHex);
    if (!patch.trim()) {
      const statuses = new Map<number, string>();
      for (let i = 1; i <= newLineCount; i++) statuses.set(i, "unchanged");
      const result: DiffDetail = {
        statuses,
        removals: new Map(),
        modifiedOld: new Map(),
      };
      this.cache.set(key, result);
      return result;
    }

    const result = GitTimeLapse.parsePatchDetail(patch, newLineCount);
    this.cache.set(key, result);
    return result;
  }

  /**
   * Return the diff between two commits as an ordered list of display rows,
   * replaying the unified diff in git's own top-to-bottom order. Unlike
   * `getDiffDetail` (which derives per-line maps that lose the original hunk
   * ordering), this preserves git's grouping: every changed block shows all of
   * its removed lines first, then all of its added lines.
   *
   * `sourceLines` must be the new file's content split into lines (the caller
   * already has it); it is used as the authoritative text for kept/added lines
   * so the rows stay in sync with what the viewer renders.
   */
  async getDiffRows(
    oldCommitHex: string,
    newCommitHex: string,
    sourceLines: string[],
  ): Promise<DiffRow[]> {
    if (!oldCommitHex) {
      return sourceLines.map((text, i) => ({
        lineno: i + 1,
        oldLineno: null,
        status: "added" as const,
        text,
      }));
    }

    const patch = await this.getPatch(oldCommitHex, newCommitHex);
    if (!patch.trim()) {
      return sourceLines.map((text, i) => ({
        lineno: i + 1,
        oldLineno: null,
        status: "unchanged" as const,
        text,
      }));
    }

    return GitTimeLapse.parsePatchRows(patch, sourceLines);
  }

  // -- working tree (virtual "uncommitted changes" revision) -------------

  /**
   * The unified diff of the working tree (staged + unstaged) against `baseHex`
   * (or HEAD when empty), for the tracked file. Read-only. A non-zero exit or an
   * empty diff yields "". Not cached: the working tree can change at any time.
   */
  private async getWorkingTreePatch(baseHex: string): Promise<string> {
    const base = baseHex || "HEAD";
    try {
      return await this.transport.runGitText(
        ["diff", base, "--", this.filePath],
        this.repoRoot,
      );
    } catch {
      return "";
    }
  }

  /**
   * The tracked file's content as it currently exists in the working tree. Since
   * the git transport only runs git (it can't read raw files), this reconstructs
   * the content by applying `git diff HEAD` forward onto the HEAD blob, which
   * captures both staged and unstaged edits. Not cached (the working tree is
   * mutable).
   */
  async getWorkingTreeContent(): Promise<string> {
    let baseText: string;
    try {
      const bytes = await this.transport.runGitBytes(
        ["show", `HEAD:${this.filePath}`],
        this.repoRoot,
      );
      baseText = decode(bytes);
    } catch {
      baseText = "";
    }
    const patch = await this.getWorkingTreePatch("");
    if (!patch.trim()) return baseText;

    const baseLines = baseText === ""
      ? []
      : (baseText.endsWith("\n") ? baseText.slice(0, -1) : baseText).split("\n");
    const baseBlame: LineBlame[] = baseLines.map((_, idx) => ({
      commitHex: "",
      authorName: "",
      authorEmail: "",
      authoredDate: new Date(0),
      originLine: idx + 1,
    }));
    try {
      const applied = applyPatchForward(baseLines, baseBlame, patch, {
        commitHex: MODIFIED_SENTINEL,
        authorName: "",
        authorEmail: "",
        authoredDate: new Date(),
      });
      const trailingNewline = !patchEndsWithoutNewline(patch);
      return applied.content.length === 0
        ? ""
        : applied.content.join("\n") + (trailingNewline ? "\n" : "");
    } catch {
      // Patch didn't apply cleanly against HEAD; fall back to the base content.
      return baseText;
    }
  }

  /** Diff detail between `baseHex` (or HEAD) and the working-tree file. */
  async getWorkingTreeDiffDetail(baseHex: string): Promise<DiffDetail> {
    const newContent = await this.getWorkingTreeContent();
    const newLineCount = splitLines(newContent).length;
    const patch = await this.getWorkingTreePatch(baseHex);
    if (!patch.trim()) {
      const statuses = new Map<number, string>();
      for (let i = 1; i <= newLineCount; i++) statuses.set(i, "unchanged");
      return { statuses, removals: new Map(), modifiedOld: new Map() };
    }
    return GitTimeLapse.parsePatchDetail(patch, newLineCount);
  }

  /** Diff rows between `baseHex` (or HEAD) and the working-tree file. */
  async getWorkingTreeDiffRows(baseHex: string, sourceLines: string[]): Promise<DiffRow[]> {
    const patch = await this.getWorkingTreePatch(baseHex);
    if (!patch.trim()) {
      return sourceLines.map((text, i) => ({
        lineno: i + 1,
        oldLineno: null,
        status: "unchanged" as const,
        text,
      }));
    }
    return GitTimeLapse.parsePatchRows(patch, sourceLines);
  }

  /**
   * Walk a unified diff top-to-bottom and emit display rows in git's order.
   *
   * Within a hunk, git lists a run's removals before its additions, so simply
   * replaying the patch lines yields the grouped "deletions then additions"
   * layout. A `+` line is tagged 'modified' while removals from the current
   * run remain unconsumed (an in-place change) and 'added' otherwise, matching
   * the status distinction the rest of the app uses for coloring.
   */
  private static parsePatchRows(patch: string, sourceLines: string[]): DiffRow[] {
    const rows: DiffRow[] = [];
    let newLineno = 0; // last emitted new-file line number
    let oldLineno = 0; // last consumed old-file line number
    let pendingRemovals = 0; // '-' lines in the current run not yet paired
    let inHunk = false; // only process body lines after the first @@ header

    for (const line of patch.split("\n")) {
      if (line.startsWith("@@")) {
        // Emit untouched lines between the previous hunk and this one.
        const afterPlus = line.split("+").slice(1).join("+");
        const newPart = afterPlus.split(" ")[0];
        const newStart = parseInt(newPart.split(",")[0], 10);
        // The old-file start comes from the "-OLD_START,OLD_COUNT" token.
        const afterMinus = line.split("-").slice(1).join("-");
        const oldPart = afterMinus.split(" ")[0];
        const oldStart = parseInt(oldPart.split(",")[0], 10);
        if (isNaN(newStart)) continue;
        for (let ln = newLineno + 1; ln < newStart; ln++) {
          rows.push({
            lineno: ln,
            oldLineno: null,
            status: "unchanged",
            text: sourceLines[ln - 1] ?? "",
          });
        }
        newLineno = newStart - 1;
        oldLineno = isNaN(oldStart) ? oldLineno : oldStart - 1;
        pendingRemovals = 0;
        inHunk = true;
      } else if (!inHunk) {
        // Skip the file header (diff --git, index, --- / +++) that precedes the
        // first hunk; those lines are not diff body content. Without this guard
        // they fall into the context branch below and get emitted as spurious
        // duplicate rows before the first real hunk.
        continue;
      } else if (line.startsWith("+++") || line.startsWith("---")) {
        continue;
      } else if (line.startsWith("-")) {
        oldLineno += 1;
        rows.push({ lineno: null, oldLineno, status: "removed", text: line.slice(1) });
        pendingRemovals += 1;
      } else if (line.startsWith("+")) {
        newLineno += 1;
        const status = pendingRemovals > 0 ? "modified" : "added";
        if (pendingRemovals > 0) pendingRemovals -= 1;
        rows.push({
          lineno: newLineno,
          oldLineno: null,
          status,
          text: sourceLines[newLineno - 1] ?? line.slice(1),
        });
      } else {
        // Context line (leading space) or the "\ No newline" marker.
        if (line.startsWith("\\")) continue;
        newLineno += 1;
        oldLineno += 1;
        pendingRemovals = 0;
        rows.push({
          lineno: newLineno,
          oldLineno: null,
          status: "unchanged",
          text: sourceLines[newLineno - 1] ?? (line.startsWith(" ") ? line.slice(1) : line),
        });
      }
    }

    // Emit any remaining untouched lines after the last hunk.
    for (let ln = newLineno + 1; ln <= sourceLines.length; ln++) {
      rows.push({ lineno: ln, oldLineno: null, status: "unchanged", text: sourceLines[ln - 1] });
    }
    return rows;
  }

  /** Parse a unified diff into statuses plus removed-line positions. */
  private static parsePatchDetail(
    patch: string,
    newLineCount: number,
  ): DiffDetail {
    const statuses = new Map<number, string>();
    const removals = new Map<number, string[]>();
    const modifiedOld = new Map<number, string[]>();
    let newLineno = 0;
    let pendingRemoved: string[] = [];

    const flushRemovals = () => {
      if (pendingRemoved.length) {
        const anchor = newLineno + 1;
        const existing = removals.get(anchor);
        if (existing) {
          existing.push(...pendingRemoved);
        } else {
          removals.set(anchor, pendingRemoved.slice());
        }
        pendingRemoved = [];
      }
    };

    for (const line of patch.split("\n")) {
      if (line.startsWith("@@")) {
        flushRemovals();
        const afterPlus = line.split("+").slice(1).join("+");
        const newPart = afterPlus.split(" ")[0];
        const newStart = parseInt(newPart.split(",")[0], 10);
        if (isNaN(newStart)) continue;
        newLineno = newStart - 1;
      } else if (line.startsWith("+++") || line.startsWith("---")) {
        continue;
      } else if (line.startsWith("-")) {
        pendingRemoved.push(line.slice(1));
      } else if (line.startsWith("+")) {
        newLineno += 1;
        if (pendingRemoved.length) {
          statuses.set(newLineno, "modified");
          const oldText = pendingRemoved.shift() as string;
          const existing = modifiedOld.get(newLineno);
          if (existing) existing.push(oldText);
          else modifiedOld.set(newLineno, [oldText]);
        } else {
          statuses.set(newLineno, "added");
        }
      } else {
        flushRemovals();
        newLineno += 1;
      }
    }

    flushRemovals();

    for (let i = 1; i <= newLineCount; i++) {
      if (!statuses.has(i)) statuses.set(i, "unchanged");
    }
    return { statuses, removals, modifiedOld };
  }

  /**
   * Parse a unified diff into per-line statuses for the new file. A '+' line
   * with a preceding '-' line in the same run is 'modified'; otherwise it is
   * 'added'. Lines outside any hunk default to 'unchanged'.
   */
  private static parsePatchStatuses(
    patch: string,
    newLineCount: number,
  ): Map<number, string> {
    const status = new Map<number, string>();
    let newLineno = 0;
    let pendingRemovals = 0;

    for (const line of patch.split("\n")) {
      if (line.startsWith("@@")) {
        const afterPlus = line.split("+").slice(1).join("+");
        const newPart = afterPlus.split(" ")[0];
        const newStart = parseInt(newPart.split(",")[0], 10);
        if (isNaN(newStart)) continue;
        newLineno = newStart - 1;
        pendingRemovals = 0;
      } else if (line.startsWith("+++") || line.startsWith("---")) {
        continue;
      } else if (line.startsWith("-")) {
        pendingRemovals += 1;
      } else if (line.startsWith("+")) {
        newLineno += 1;
        if (pendingRemovals > 0) {
          status.set(newLineno, "modified");
          pendingRemovals -= 1;
        } else {
          status.set(newLineno, "added");
        }
      } else {
        newLineno += 1;
        pendingRemovals = 0;
      }
    }

    for (let i = 1; i <= newLineCount; i++) {
      if (!status.has(i)) status.set(i, "unchanged");
    }
    return status;
  }

  async detectRenames(): Promise<RenameSegment[]> {
    const out = await this.gitText([
      "log", "--follow", "--first-parent", "-m",
      "--diff-filter=R", "--find-renames",
      "--name-status", "--format=%x01%H",
      "--", this.filePath,
    ]);
    const segments: RenameSegment[] = [];
    let currentHex = "";
    for (const line of out.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.startsWith("\x01")) {
        currentHex = trimmed.slice(1).substring(0, 8);
      } else if (trimmed.startsWith("R") && currentHex) {
        const parts = trimmed.split("\t");
        if (parts.length >= 3) {
          segments.push({
            filePath: parts[1],
            renameCommitHex: currentHex,
          });
        }
      }
    }
    return segments.reverse();
  }

  private async getOrCreateRenameBackend(filePath: string): Promise<GitTimeLapse> {
    let backend = this.renameBackends.get(filePath);
    if (!backend) {
      backend = await GitTimeLapse.createForHistoricalPath(
        this.transport, this.repoRoot, filePath,
      );
      this.renameBackends.set(filePath, backend);
    }
    return backend;
  }

  async getCommitsForPath(filePath: string): Promise<FileHistory[]> {
    const backend = await this.getOrCreateRenameBackend(filePath);
    return backend.getCommits();
  }

  async populateForPath(
    filePath: string,
    onProgress?: (done: number, total: number) => void,
    workerCount?: number | null,
  ): Promise<void> {
    const backend = await this.getOrCreateRenameBackend(filePath);
    return backend.populateFromLog(onProgress, workerCount);
  }

  async getBlameForPath(filePath: string, commitHex: string): Promise<BlameEntry[]> {
    const backend = await this.getOrCreateRenameBackend(filePath);
    return backend.getBlame(commitHex);
  }

  async getFileContentForPath(filePath: string, commitHex: string): Promise<string> {
    const backend = await this.getOrCreateRenameBackend(filePath);
    return backend.getFileContent(commitHex);
  }

  async getDiffDetailForPath(filePath: string, oldHex: string, newHex: string): Promise<DiffDetail> {
    const backend = await this.getOrCreateRenameBackend(filePath);
    return backend.getDiffDetail(oldHex, newHex);
  }

  async getDiffRowsForPath(filePath: string, oldHex: string, newHex: string, sourceLines: string[]): Promise<DiffRow[]> {
    const backend = await this.getOrCreateRenameBackend(filePath);
    return backend.getDiffRows(oldHex, newHex, sourceLines);
  }
}

// ---------------------------------------------------------------------------
// git log -p replay (content + blame reconstruction)
// ---------------------------------------------------------------------------

/** One commit parsed from `git log -p` output, with its unified-diff patch. */
interface ParsedLogCommit {
  hexSha: string; // full 40-hex
  authorName: string;
  authorEmail: string;
  isoDate: string;
  message: string;
  patch: string; // raw unified diff for this commit (may be empty)
  trailingNewline: boolean; // does the new-side file end with a newline?
}

/** Blame ownership for a single line, replayed forward across revisions. */
interface LineBlame {
  commitHex: string; // 8-hex short sha (matches BlameEntry.commitHex)
  authorName: string;
  authorEmail: string;
  authoredDate: Date;
  // Stable 1-based line number within the introducing commit's added block.
  // Assigned when a line is first added and carried forward unchanged for
  // surviving context lines, so it identifies a physical line across revisions
  // even as the line's current position drifts.
  originLine: number;
}

/** The commit attribution applied to lines a patch adds or modifies. */
interface CommitAttribution {
  commitHex: string;
  authorName: string;
  authorEmail: string;
  authoredDate: Date;
}

/**
 * Placeholder blame/attribution for the parallel content phase, which
 * reconstructs content only; real per-line blame is derived in the sequential
 * pass. Shared singletons avoid allocating throwaway objects per line.
 */
const EMPTY_BLAME: LineBlame = {
  commitHex: "",
  authorName: "",
  authorEmail: "",
  authoredDate: new Date(0),
  originLine: 0,
};
const EMPTY_ATTRIB: CommitAttribution = EMPTY_BLAME;

/**
 * True when the patch's final new-side line lacks a trailing newline, i.e. a
 * "\ No newline at end of file" marker follows the last `+` or context line
 * (not a `-` line, whose no-newline marker refers to the *old* side). We scan
 * for the last body line that contributes to the new file and check whether the
 * immediately following line is the marker.
 */
function patchEndsWithoutNewline(patch: string): boolean {
  const lines = patch.split("\n");
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    if (line.startsWith("\\")) continue; // the marker itself
    if (line === "") continue; // trailing blank from the final split
    // A '-' line's no-newline marker is about the old side; ignore it. Only a
    // '+' or context line as the last new-side content decides the new file.
    if (line.startsWith("-")) return false;
    if (line.startsWith("+") || line.startsWith(" ") || !line.startsWith("@")) {
      // Look at what preceded this line in the reversed walk: if the *next*
      // (i+1) line was the marker, this line has no trailing newline.
      const next = lines[i + 1] ?? "";
      return next.startsWith("\\");
    }
    return false;
  }
  return false;
}

/**
 * Apply one unified-diff patch to `content`/`blame` in place-ish, returning the
 * new arrays for the post-patch file version. Context lines keep their existing
 * blame; removed lines are dropped; added lines are attributed to `attrib`.
 *
 * The first commit's patch is a diff against /dev/null (all additions), which
 * this handles naturally: the hunk header is `@@ -0,0 +1,N @@`, there are no
 * context/removed lines, and every `+` line is inserted with the first commit's
 * attribution.
 *
 * Throws if a hunk's context/removed lines don't match the current content (a
 * signal the patch can't be replayed; the caller falls back to per-command).
 */
function applyPatchForward(
  content: string[],
  blame: LineBlame[],
  patch: string,
  attrib: CommitAttribution,
): { content: string[]; blame: LineBlame[] } {
  if (!patch.trim()) {
    // No diff body (e.g. a commit that touched the file only via mode change).
    // The file is unchanged; keep content/blame as-is.
    return { content, blame };
  }

  const outContent: string[] = [];
  const outBlame: LineBlame[] = [];
  // 0-based cursor into the *old* (pre-patch) content array.
  let oldIdx = 0;
  let inHunk = false;
  // Counter for the stable origin line of lines this commit adds. Each added
  // line gets a distinct 1-based ordinal within this commit so surviving lines
  // can be told apart later even when they end up non-contiguous in the file.
  let addedCount = 0;

  const lines = patch.split("\n");
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li];
    if (line.startsWith("@@")) {
      // Parse the old-side start ("-OLD_START,OLD_COUNT"). Copy untouched lines
      // before this hunk from old content, preserving their blame.
      const afterMinus = line.split("-").slice(1).join("-");
      const oldPart = afterMinus.split(" ")[0];
      const oldStart = parseInt(oldPart.split(",")[0], 10);
      if (isNaN(oldStart)) {
        inHunk = true;
        continue;
      }
      // Convert 1-based start to a 0-based index; for a pure addition against an
      // empty file git uses "-0,0", so target index 0.
      const targetIdx = oldStart <= 0 ? 0 : oldStart - 1;
      while (oldIdx < targetIdx) {
        if (oldIdx >= content.length) {
          throw new Error("patch hunk starts past end of content");
        }
        outContent.push(content[oldIdx]);
        outBlame.push(blame[oldIdx]);
        oldIdx += 1;
      }
      inHunk = true;
      continue;
    }
    if (!inHunk) continue; // file header (diff --git / index / --- / +++)
    if (line.startsWith("\\")) continue; // "\ No newline at end of file"
    if (line === "") continue;

    if (line.startsWith("-")) {
      // Removed line: consume from old content without emitting it.
      if (oldIdx >= content.length) {
        throw new Error("patch removes a line past end of content");
      }
      oldIdx += 1;
    } else if (line.startsWith("+")) {
      // Added line: attribute to this commit with a fresh per-line blame so each
      // added line carries a distinct stable origin ordinal.
      outContent.push(line.slice(1));
      addedCount += 1;
      outBlame.push({
        commitHex: attrib.commitHex,
        authorName: attrib.authorName,
        authorEmail: attrib.authorEmail,
        authoredDate: attrib.authoredDate,
        originLine: addedCount,
      });
    } else {
      // Context line (leading space): keep the old line and its blame.
      if (oldIdx >= content.length) {
        throw new Error("patch context past end of content");
      }
      outContent.push(content[oldIdx]);
      outBlame.push(blame[oldIdx]);
      oldIdx += 1;
    }
  }

  // Copy any trailing untouched lines after the last hunk.
  while (oldIdx < content.length) {
    outContent.push(content[oldIdx]);
    outBlame.push(blame[oldIdx]);
    oldIdx += 1;
  }

  return { content: outContent, blame: outBlame };
}

/**
 * Group a per-line blame array into BlameEntry blocks, merging consecutive lines
 * that share a commit AND run contiguously in their stable origin line. Merging
 * requires contiguous originLine (not just a shared commit) so every line in a
 * block satisfies `origin(j) = entry.originLine + j`; this keeps disjoint blocks
 * from the same commit separate, which the lifetime-end map relies on to key
 * each physical line uniquely. `origLineno` is the 1-based line number of the
 * block's first line in this file version; `originLine` is the stable origin of
 * that first line within its introducing commit.
 */
function blameToEntries(blame: LineBlame[]): BlameEntry[] {
  const entries: BlameEntry[] = [];
  for (let i = 0; i < blame.length; i++) {
    const b = blame[i];
    const last = entries[entries.length - 1];
    if (
      last &&
      last.commitHex === b.commitHex &&
      last.originLine + last.lines.length === b.originLine
    ) {
      last.lines.push("");
    } else {
      entries.push({
        commitHex: b.commitHex,
        authorName: b.authorName,
        authorEmail: b.authorEmail,
        authoredDate: b.authoredDate,
        origLineno: i + 1,
        originLine: b.originLine,
        lines: [""],
      });
    }
  }
  return entries;
}

// ---------------------------------------------------------------------------
// String helpers
// ---------------------------------------------------------------------------

/**
 * Split `text` on `sep` at most `maxSplits` times, keeping the remainder intact
 * in the final element. Mirrors Python's `str.split(sep, maxsplit)`.
 */
function splitN(text: string, sep: string, maxSplits: number): string[] {
  const out: string[] = [];
  let rest = text;
  for (let k = 0; k < maxSplits; k++) {
    const idx = rest.indexOf(sep);
    if (idx === -1) break;
    out.push(rest.slice(0, idx));
    rest = rest.slice(idx + sep.length);
  }
  out.push(rest);
  return out;
}

/**
 * Split content into lines the way Python's `str.splitlines()` counts them: a
 * trailing newline does not produce a final empty element. Used for line
 * counting, so a file ending in a newline is not counted as having an extra
 * empty line.
 */
function splitLines(text: string): string[] {
  if (text === "") return [];
  const withoutTrailing = text.endsWith("\n") ? text.slice(0, -1) : text;
  return withoutTrailing.split(/\r\n|\r|\n/);
}
