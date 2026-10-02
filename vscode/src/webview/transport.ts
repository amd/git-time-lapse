// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT
/**
 * Webview-side bridge to the extension host.
 *
 * The git backend runs in the extension host; the webview reaches it over
 * postMessage. This module provides:
 * - RpcBackend: implements the shared Backend interface by forwarding each
 *   method call to the host and awaiting the reply (method-level RPC).
 * - vscodeHost: implements the shared PlatformHost (config, dialog, window,
 *   showError) over postMessage.
 * - signalReady(): tells the host the webview's listeners are installed.
 *
 * JSON loses Date and Map, so replies are revived here; host errors carry a
 * "kind" so the right Error subclass is rebuilt.
 */

import type {
  AppConfig,
  Backend,
  BlameEntry,
  DiffDetail,
  DiffRow,
  FileHistory,
  PlatformHost,
  RenameSegment,
} from "../../../shared/types";
import { BinaryFileError, FileNotFoundError } from "../../../shared/types";

interface VsCodeApi {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

const vscode = acquireVsCodeApi();

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

const pending = new Map<number, Pending>();
let nextId = 1;

/** A message pushed by the host rather than sent as a reply to a request. */
export interface HostPush {
  type?: string;
  filePath?: string;
  repoDir?: string;
  focusLine?: number;
}

const pushHandlers: ((msg: HostPush) => void)[] = [];

/**
 * Register a handler for host-pushed messages. Callers use this instead of
 * their own window "message" listener so every inbound message passes the
 * origin check below exactly once.
 */
export function onHostMessage(handler: (msg: HostPush) => void): void {
  pushHandlers.push(handler);
}

// VS Code relays host messages into this iframe with targetOrigin set to the
// relaying frame's own origin, so delivery only happens when the two share an
// origin. Anything arriving from a different origin therefore did not come
// from the extension host and must not be allowed to resolve an RPC reply or
// trigger a file load.
window.addEventListener("message", (event: MessageEvent) => {
  if (event.origin !== window.origin) {
    console.warn(`git-time-lapse: ignored message from unexpected origin ${event.origin}`);
    return;
  }
  const msg = event.data as {
    type?: string;
    id?: number;
    ok?: boolean;
    result?: unknown;
    error?: unknown;
  };
  if (!msg) return;
  if (msg.type === "response" && typeof msg.id === "number") {
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    if (msg.ok) p.resolve(msg.result);
    else p.reject(reviveError(msg.error));
    return;
  }
  for (const handler of pushHandlers) handler(msg as HostPush);
});

function request<T>(method: string, params: unknown = {}): Promise<T> {
  const id = nextId++;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: (v) => resolve(v as T), reject });
    vscode.postMessage({ type: "request", id, method, params });
  });
}

function reviveError(e: unknown): Error {
  const err = e as { kind?: string; message?: string } | null;
  const message = err?.message ?? "Unknown error";
  if (err?.kind === "BinaryFileError") return new BinaryFileError(message);
  if (err?.kind === "FileNotFoundError") return new FileNotFoundError(message);
  return new Error(message);
}

function reviveHistory(h: any): FileHistory {
  return { ...h, authoredDate: new Date(h.authoredDate) };
}

function reviveBlame(entries: any[]): BlameEntry[] {
  return entries.map((e) => ({ ...e, authoredDate: new Date(e.authoredDate) }));
}

function reviveDiffDetail(d: any): DiffDetail {
  return {
    statuses: new Map<number, string>(d.statuses),
    removals: new Map<number, string[]>(d.removals),
    modifiedOld: new Map<number, string[]>(d.modifiedOld),
  };
}

/** Backend that forwards each method call to the host-side shared backend. */
class RpcBackend implements Backend {
  getLatestCommitHash(): Promise<string> {
    return request<string>("getLatestCommitHash");
  }
  resolveRef(ref: string): Promise<{ ok: boolean; label: string; hash: string }> {
    return request<{ ok: boolean; label: string; hash: string }>("resolveRef", { ref });
  }
  listRefs(): Promise<{ name: string; kind: "branch" | "tag" | "remote" }[]> {
    return request<{ name: string; kind: "branch" | "tag" | "remote" }[]>("listRefs");
  }
  getFileModifiedState(): Promise<string> {
    return request<string>("getFileModifiedState");
  }
  async getCommits(): Promise<FileHistory[]> {
    return (await request<any[]>("getCommits")).map(reviveHistory);
  }
  async getCommitInfo(commitHex: string): Promise<FileHistory> {
    return reviveHistory(await request<any>("getCommitInfo", { commitHex }));
  }
  getFileContent(commitHex: string): Promise<string> {
    return request<string>("getFileContent", { commitHex });
  }
  async getBlame(commitHex: string): Promise<BlameEntry[]> {
    return reviveBlame(await request<any[]>("getBlame", { commitHex }));
  }
  async getDiffDetail(oldHex: string, newHex: string): Promise<DiffDetail> {
    return reviveDiffDetail(await request<any>("getDiffDetail", { oldHex, newHex }));
  }
  getDiffRows(oldHex: string, newHex: string, sourceLines: string[]): Promise<DiffRow[]> {
    return request<DiffRow[]>("getDiffRows", { oldHex, newHex, sourceLines });
  }
  getWorkingTreeContent(): Promise<string> {
    return request<string>("getWorkingTreeContent");
  }
  async getWorkingTreeDiffDetail(baseHex: string): Promise<DiffDetail> {
    return reviveDiffDetail(await request<any>("getWorkingTreeDiffDetail", { baseHex }));
  }
  getWorkingTreeDiffRows(baseHex: string, sourceLines: string[]): Promise<DiffRow[]> {
    return request<DiffRow[]>("getWorkingTreeDiffRows", { baseHex, sourceLines });
  }
  translateLine(oldLineno: number, oldCommitHex: string, newCommitHex: string): Promise<number | null> {
    return request<number | null>("translateLine", { oldLineno, oldCommitHex, newCommitHex });
  }
  listDirectory(dirPath: string): Promise<{ name: string; isDir: boolean; sparse?: boolean; isSubmodule?: boolean }[]> {
    return request<{ name: string; isDir: boolean; sparse?: boolean; isSubmodule?: boolean }[]>("listDirectory", { dirPath });
  }
  listDeletedInDirectory(dirPath: string): Promise<string[]> {
    return request<string[]>("listDeletedInDirectory", { dirPath });
  }
  listAllFiles(): Promise<string[]> {
    return request<string[]>("listAllFiles");
  }
  listSparseFiles(): Promise<string[]> {
    return request<string[]>("listSparseFiles");
  }
  getRepoRoot(): Promise<string> {
    return request<string>("getRepoRoot");
  }
  async listDirectoryInfo(dirPath: string): Promise<{ deleted: string[]; deletedDirs: string[]; counts: Map<string, number> }> {
    const raw = await request<{ deleted: string[]; deletedDirs: string[]; counts: [string, number][] }>("listDirectoryInfo", { dirPath });
    return { deleted: raw.deleted, deletedDirs: raw.deletedDirs ?? [], counts: new Map(raw.counts) };
  }
  getGitUserEmail(): Promise<string> {
    return request<string>("getGitUserEmail");
  }
  getGitUserName(): Promise<string> {
    return request<string>("getGitUserName");
  }
  async listModifiedFiles(): Promise<Set<string>> {
    return new Set(await request<string[]>("listModifiedFiles"));
  }
  getFileRevisionCount(filePath: string): Promise<number> {
    return request<number>("getFileRevisionCount", { filePath });
  }
  async listDirectoryRevisionCounts(dirPath: string): Promise<Map<string, number>> {
    return new Map(await request<[string, number][]>("listDirectoryRevisionCounts", { dirPath }));
  }
  populateFromLog(_onProgress?: (done: number, total: number) => void, workerCount?: number | null): Promise<void> {
    return request<void>("populateFromLog", { workerCount: workerCount ?? null });
  }
  async detectRenames(): Promise<RenameSegment[]> {
    return request("detectRenames");
  }
  async getCommitsForPath(filePath: string): Promise<FileHistory[]> {
    return (await request<any[]>("getCommitsForPath", { filePath })).map(reviveHistory);
  }
  async populateForPath(
    filePath: string,
    _onProgress?: (done: number, total: number) => void,
    workerCount?: number | null,
  ): Promise<void> {
    return request<void>("populateForPath", { filePath, workerCount: workerCount ?? null });
  }
  async getBlameForPath(filePath: string, commitHex: string): Promise<BlameEntry[]> {
    return reviveBlame(await request<any[]>("getBlameForPath", { filePath, commitHex }));
  }
  async getFileContentForPath(filePath: string, commitHex: string): Promise<string> {
    return request<string>("getFileContentForPath", { filePath, commitHex });
  }
  async getDiffDetailForPath(filePath: string, oldHex: string, newHex: string): Promise<DiffDetail> {
    return reviveDiffDetail(await request<any>("getDiffDetailForPath", { filePath, oldHex, newHex }));
  }
  async getDiffRowsForPath(filePath: string, oldHex: string, newHex: string, sourceLines: string[]): Promise<DiffRow[]> {
    return request<DiffRow[]>("getDiffRowsForPath", { filePath, oldHex, newHex, sourceLines });
  }
  async getCrossPathDiffRows(oldHex: string, oldPath: string, newHex: string, newPath: string, sourceLines: string[]): Promise<DiffRow[]> {
    return request<DiffRow[]>("getCrossPathDiffRows", { oldHex, oldPath, newHex, newPath, sourceLines });
  }
}

/**
 * Create a backend for a file. The host builds the real shared GitTimeLapse
 * (with its Node transport) on the "create" request; this returns the RPC proxy.
 */
export async function createBackend(repoDir: string, filePath: string, ref?: string): Promise<Backend> {
  await request<void>("create", { repoPath: repoDir, filePath, ref });
  return new RpcBackend();
}

/** PlatformHost implemented over postMessage to the extension host. */
export const vscodeHost: PlatformHost = {
  loadConfig() {
    return request<AppConfig>("loadConfig");
  },
  async saveConfig(config) {
    await request<void>("saveConfig", { config });
  },
  async openConfigInEditor() {
    await request<void>("openConfigInEditor");
  },
  openFileDialog() {
    return request<string | null>("openDialog");
  },
  openDirectoryDialog() {
    return request<string | null>("openDirectoryDialog");
  },
  getIdeTheme() {
    return request<string | null>("getIdeTheme");
  },
  getIdeVersion() {
    return request<string | null>("getIdeVersion");
  },
  setTitle(title) {
    vscode.postMessage({ type: "notify", method: "setTitle", params: { title } });
  },
  setTheme() {
    // VS Code owns the window chrome/theme.
  },
  close() {
    vscode.postMessage({ type: "notify", method: "close", params: {} });
  },
  showError(message) {
    vscode.postMessage({ type: "notify", method: "showError", params: { message } });
  },
  isVSCode: true,
};

/** Tell the host the webview is ready to receive the file to open. */
export function signalReady(): void {
  vscode.postMessage({ type: "ready" });
}
