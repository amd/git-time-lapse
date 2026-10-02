// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT
/**
 * Visual Studio (WebView2) bridge to the native C# host.
 *
 * Unlike the VS Code shell (which runs the git backend in the extension host and
 * RPCs each backend method), this shell follows the Tauri model: the shared
 * GitTimeLapse backend runs IN the webview, and the C# host only executes git
 * subprocesses and provides host services (config, dialog, editor, title).
 *
 * WebView2 exposes `window.chrome.webview.postMessage()` /
 * `addEventListener("message")`. Every call is a promise keyed by a random id;
 * the host replies with `{ id, ok, result?, error? }`.
 *
 * This module provides:
 * - webview2Transport: implements GitTransport (git). It mirrors the Tauri
 *   transport's contract: the host returns { code, stdout, stderr } and never
 *   throws on a non-zero git exit; this bridge inspects `code` and THROWS so the
 *   shared backend's try/catch logic (empty diff, missing blob, etc.) works.
 * - vsHost: implements PlatformHost (config, dialog, window, showError) via the
 *   same postMessage RPC.
 */

import type {
  AppConfig,
  GitTransport,
  PlatformHost,
} from "../../shared/types";
import { DEFAULT_CONFIG } from "../../shared/types";

interface WebView2 {
  postMessage(msg: unknown): void;
  addEventListener(type: "message", handler: (e: { data: any }) => void): void;
}

declare global {
  interface Window {
    chrome: { webview: WebView2 };
    __VS_OPEN_FILE?: string;
    __VS_OPEN_LINE?: number;
  }
}

const webview = window.chrome.webview;

interface Pending {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
}

const pending = new Map<string, Pending>();

webview.addEventListener("message", (e) => {
  const msg = e.data as {
    id?: string;
    ok?: boolean;
    result?: unknown;
    error?: string;
  };
  if (!msg || typeof msg.id !== "string") return;
  const p = pending.get(msg.id);
  if (!p) return;
  pending.delete(msg.id);
  if (msg.ok) p.resolve(msg.result);
  else p.reject(new Error(msg.error ?? "Unknown host error"));
});

function makeId(): string {
  // crypto.randomUUID isn't guaranteed in every WebView2 runtime; fall back to a
  // random string that's unique enough for in-flight request correlation.
  const c = (globalThis as any).crypto;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function call<T>(method: string, params: Record<string, unknown>): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const id = makeId();
    pending.set(id, { resolve: (v) => resolve(v as T), reject });
    webview.postMessage({ id, method, ...params });
  });
}

/** Result of a git subprocess, mirroring the Tauri GitResult shape. */
interface GitResult {
  code: number | null;
  stdout: string; // base64-encoded stdout bytes
  stderr: string;
}

async function runGit(args: string[], cwd: string): Promise<GitResult> {
  return call<GitResult>("git", { args, cwd });
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("latin1").decode(bytes);
  }
}

export const webview2Transport: GitTransport = {
  async runGitText(args, cwd) {
    const res = await runGit(args, cwd);
    if (res.code !== 0) {
      throw new Error(`git ${args.join(" ")} failed (${res.code}): ${res.stderr}`);
    }
    return decodeText(base64ToBytes(res.stdout));
  },
  async runGitBytes(args, cwd) {
    const res = await runGit(args, cwd);
    if (res.code !== 0) {
      throw new Error(`git ${args.join(" ")} failed (${res.code}): ${res.stderr}`);
    }
    return base64ToBytes(res.stdout);
  },
};

/** Merge a raw JSON config object onto the defaults (unknown keys ignored). */
import { loadConfigFromRaw, saveConfigToRaw } from "../../shared/types";

const PLATFORM = "vs" as const;
let rawData: Record<string, unknown> = {};

function mergeConfig(data: unknown): AppConfig {
  if (data && typeof data === "object") {
    rawData = data as Record<string, unknown>;
  }
  return loadConfigFromRaw(rawData, PLATFORM);
}

/** PlatformHost implemented over postMessage to the C# host. */
export const vsHost: PlatformHost = {
  async loadConfig() {
    const text = await call<string>("readConfig", {});
    if (!text || !text.trim()) return { ...DEFAULT_CONFIG };
    try {
      return mergeConfig(JSON.parse(text));
    } catch {
      return { ...DEFAULT_CONFIG };
    }
  },
  async saveConfig(config) {
    rawData = saveConfigToRaw(rawData, config, PLATFORM);
    await call<void>("writeConfig", {
      contents: JSON.stringify(rawData, null, 2),
    });
  },
  async openConfigInEditor() {
    await call<void>("openInEditor", {
      defaultContents: JSON.stringify(DEFAULT_CONFIG, null, 2),
    });
  },
  openFileDialog() {
    return call<string | null>("openDialog", {});
  },
  openDirectoryDialog() {
    return call<string | null>("openDirectoryDialog", {});
  },
  getIdeTheme() {
    return call<string | null>("getIdeTheme", {});
  },
  getIdeVersion() {
    return call<string | null>("getIdeVersion", {});
  },
  setTitle(title) {
    void call<void>("setTitle", { title });
  },
  setTheme() {
    // Visual Studio owns the tool window chrome/theme.
  },
  close() {
    void call<void>("close", {});
  },
  showError(message) {
    void call<void>("showError", { message });
  },
  isVSCode: true, // hides the in-app file selector row (VS opens via command)
};
