// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT
/**
 * VS Code extension host for Git Time-Lapse View.
 *
 * Registers the open commands, creates the webview panel, runs the git backend
 * (Node) in this host, and bridges the webview's postMessage RPC to the
 * backend, config persistence, and the file-open dialog.
 */

import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { GitTimeLapse } from "../../shared/git_backend";
import { AppConfig, BinaryFileError, FileNotFoundError } from "../../shared/types";
import { nodeTransport } from "./transport";
import { ensureConfigFile, loadConfig, saveConfig } from "./config";

/**
 * Convert an MSYS / Git-Bash style path (`/c/path/to/repo`) to a Windows path
 * (`C:/path/to/repo`). Node's `execFile` cwd and `path.dirname` don't understand
 * the `/c/...` form, so a user typing that in the webview path field would hit
 * an ENOENT. Only rewrites the leading `/<drive>/` on Windows; every other path
 * is returned unchanged.
 */
function normalizeMsysPath(p: string): string {
  if (process.platform !== "win32") return p;
  const m = /^\/([a-z])\/(.*)$/i.exec(p);
  if (!m) return p;
  return `${m[1].toUpperCase()}:/${m[2]}`;
}

export function activate(context: vscode.ExtensionContext): void {
  context.subscriptions.push(
    vscode.commands.registerCommand("git-time-lapse.open", async () => {
      const picked = await pickFile();
      if (picked) openViewer(context, picked);
    }),
    vscode.commands.registerCommand(
      "git-time-lapse.openFile",
      async (resource?: vscode.Uri) => openFileCommand(context, resource, false),
    ),
    // Bound to editor/context only: the caret is meaningful for that gesture.
    vscode.commands.registerCommand(
      "git-time-lapse.openFileAtLine",
      async (resource?: vscode.Uri) => openFileCommand(context, resource, true),
    ),
    vscode.commands.registerCommand(
      "git-time-lapse.openRepo",
      async (resource?: vscode.Uri) => {
        if (resource && resource.scheme === "file") {
          openRepoViewer(context, resource.fsPath);
        } else {
          const picked = await pickDirectory();
          if (picked) openRepoViewer(context, picked);
        }
      },
    ),
  );
}

/**
 * Shared body of the two open-file commands. `withLine` is true only for the
 * editor/context entry; even then the caret is used only when the target really
 * is the focused editor, so an explorer right-click on another file can't pick
 * up the active editor's line.
 */
async function openFileCommand(
  context: vscode.ExtensionContext,
  resource: vscode.Uri | undefined,
  withLine: boolean,
): Promise<void> {
  const editor = vscode.window.activeTextEditor;
  const uri = resource ?? editor?.document.uri;
  if (uri && uri.scheme === "file") {
    // A directory (Solution/Explorer folder right-click) opens Repo mode;
    // a file opens File mode.
    if (isDirectory(uri.fsPath)) {
      openRepoViewer(context, uri.fsPath);
      return;
    }
    const isActiveEditor =
      resource === undefined || resource.toString() === editor?.document.uri.toString();
    const focusLine =
      withLine && editor && isActiveEditor ? editor.selection.active.line + 1 : undefined;
    openViewer(context, uri.fsPath, focusLine);
  } else {
    const picked = await pickFile();
    if (picked) openViewer(context, picked);
  }
}

/** Whether `p` exists and is a directory. Best-effort; returns false on error. */
function isDirectory(p: string): boolean {
  try {
    return fs.statSync(p).isDirectory();
  } catch {
    return false;
  }
}

export function deactivate(): void {
  // Panels dispose themselves via context.subscriptions.
}

/** Show VS Code's built-in file-open dialog and return the fsPath, or null. */
async function pickFile(): Promise<string | null> {
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: true,
    canSelectFolders: false,
    canSelectMany: false,
    openLabel: "Open Time-Lapse",
    title: "Select a file for Time-Lapse View",
  });
  return picked && picked.length > 0 ? picked[0].fsPath : null;
}

async function pickDirectory(): Promise<string | null> {
  const picked = await vscode.window.showOpenDialog({
    canSelectFiles: false,
    canSelectFolders: true,
    canSelectMany: false,
    openLabel: "Open Repository",
    title: "Select a git repository directory",
  });
  return picked && picked.length > 0 ? picked[0].fsPath : null;
}

/** Create the webview panel for a file and wire up its message handling. */
function openViewer(
  context: vscode.ExtensionContext,
  filePath: string,
  focusLine?: number,
): void {
  // Defensive: ensure an absolute OS path. VS Code URIs give us absolute
  // fsPaths already, but normalize in case a relative path ever reaches here.
  filePath = path.resolve(filePath);
  createPanel(context, `Git Time-Lapse — ${path.basename(filePath)}`, (panel) => {
    console.log("[git-time-lapse] Sending file path to webview:", filePath);
    panel.webview.postMessage(
      focusLine && focusLine > 0
        ? { type: "openFile", filePath, focusLine }
        : { type: "openFile", filePath },
    );
  });
}

/** Create the webview panel for a repository (Repo mode / tree browser). */
function openRepoViewer(context: vscode.ExtensionContext, dirPath: string): void {
  dirPath = path.resolve(dirPath);
  createPanel(context, `Git Time-Lapse — ${path.basename(dirPath)}`, (panel) => {
    console.log("[git-time-lapse] Sending repo dir to webview:", dirPath);
    panel.webview.postMessage({ type: "openRepo", repoDir: dirPath });
  });
}

/**
 * Create a webview panel, wire up its message handling, and invoke `onReady`
 * once the webview signals it is ready. `onReady` pushes the initial target
 * (a file for File mode or a directory for Repo mode).
 */
function createPanel(
  context: vscode.ExtensionContext,
  title: string,
  onReady: (panel: vscode.WebviewPanel) => void,
): void {
  const panel = vscode.window.createWebviewPanel(
    "gitTimeLapse",
    title,
    vscode.ViewColumn.Active,
    {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, "dist")],
    },
  );

  panel.webview.html = getHtml(panel.webview, context.extensionUri);

  // One backend instance per panel, created lazily on the "create" request.
  let backend: GitTimeLapse | null = null;

  panel.webview.onDidReceiveMessage(async (msg: HostMessage) => {
    // The webview sends "ready" once its script has loaded and its message
    // listener is installed; only then is it safe to push the target to open
    // (a postMessage before that would be dropped).
    if (msg.type === "ready") {
      onReady(panel);
      return;
    }
    if (msg.type === "notify") {
      if (msg.method === "setTitle" && typeof msg.params?.title === "string") {
        panel.title = msg.params.title;
      } else if (msg.method === "close") {
        panel.dispose();
      } else if (msg.method === "showError" && typeof msg.params?.message === "string") {
        // Webviews can't use window.alert; surface errors as VS Code toasts.
        void vscode.window.showErrorMessage(msg.params.message);
      }
      return;
    }
    if (msg.type !== "request") return;

    try {
      const result = await handleRequest(msg, () => backend, (b) => {
        backend = b;
      });
      panel.webview.postMessage({ type: "response", id: msg.id, ok: true, result });
    } catch (err) {
      panel.webview.postMessage({
        type: "response",
        id: msg.id,
        ok: false,
        error: serializeError(err),
      });
    }
  });

  context.subscriptions.push(panel);
}

interface HostMessage {
  type: "request" | "notify" | "ready";
  id?: number;
  method: string;
  params?: any;
}

/** Route a webview request to the backend / config / dialog. */
async function handleRequest(
  msg: HostMessage,
  getBackend: () => GitTimeLapse | null,
  setBackend: (b: GitTimeLapse) => void,
): Promise<unknown> {
  const p = msg.params ?? {};
  switch (msg.method) {
    case "create": {
      const filePath = path.resolve(normalizeMsysPath(p.filePath));
      const repoDir = p.repoPath
        ? path.resolve(normalizeMsysPath(p.repoPath))
        : path.dirname(filePath);
      const b = await GitTimeLapse.create(nodeTransport, repoDir, filePath, p.ref);
      setBackend(b);
      return null;
    }
    case "getLatestCommitHash":
      return requireBackend(getBackend).getLatestCommitHash();
    case "resolveRef":
      return requireBackend(getBackend).resolveRef(String(p.ref ?? "HEAD"));
    case "listRefs":
      return requireBackend(getBackend).listRefs();
    case "getFileModifiedState":
      return requireBackend(getBackend).getFileModifiedState();
    case "getCommits":
      return (await requireBackend(getBackend).getCommits()).map(serializeHistory);
    case "getCommitInfo":
      return serializeHistory(await requireBackend(getBackend).getCommitInfo(p.commitHex));
    case "getFileContent":
      return requireBackend(getBackend).getFileContent(p.commitHex);
    case "getBlame":
      return (await requireBackend(getBackend).getBlame(p.commitHex)).map(serializeBlame);
    case "getDiffDetail":
      return serializeDiffDetail(
        await requireBackend(getBackend).getDiffDetail(p.oldHex, p.newHex),
      );
    case "getDiffRows":
      return requireBackend(getBackend).getDiffRows(p.oldHex, p.newHex, p.sourceLines);
    case "getWorkingTreeContent":
      return requireBackend(getBackend).getWorkingTreeContent();
    case "getWorkingTreeDiffDetail":
      return serializeDiffDetail(
        await requireBackend(getBackend).getWorkingTreeDiffDetail(p.baseHex),
      );
    case "getWorkingTreeDiffRows":
      return requireBackend(getBackend).getWorkingTreeDiffRows(p.baseHex, p.sourceLines);
    case "translateLine":
      return requireBackend(getBackend).translateLine(
        p.oldLineno,
        p.oldCommitHex,
        p.newCommitHex,
      );
    case "listDirectory":
      return requireBackend(getBackend).listDirectory(p.dirPath);
    case "listDeletedInDirectory":
      return requireBackend(getBackend).listDeletedInDirectory(p.dirPath);
    case "listAllFiles":
      return requireBackend(getBackend).listAllFiles();
    case "listSparseFiles":
      return requireBackend(getBackend).listSparseFiles();
    case "getRepoRoot":
      return requireBackend(getBackend).getRepoRoot();
    case "listDirectoryInfo": {
      const info = await requireBackend(getBackend).listDirectoryInfo(p.dirPath);
      return { deleted: info.deleted, deletedDirs: info.deletedDirs, counts: [...info.counts] };
    }
    case "getGitUserEmail":
      return requireBackend(getBackend).getGitUserEmail();
    case "getGitUserName":
      return requireBackend(getBackend).getGitUserName();
    case "listModifiedFiles":
      return [...await requireBackend(getBackend).listModifiedFiles()];
    case "getFileRevisionCount":
      return requireBackend(getBackend).getFileRevisionCount(p.filePath);
    case "listDirectoryRevisionCounts":
      return [...await requireBackend(getBackend).listDirectoryRevisionCounts(p.dirPath)];
    case "populateFromLog":
      await requireBackend(getBackend).populateFromLog(undefined, p.workerCount ?? undefined);
      return null;
    case "detectRenames":
      return requireBackend(getBackend).detectRenames();
    case "getCommitsForPath":
      return (await requireBackend(getBackend).getCommitsForPath(p.filePath)).map(serializeHistory);
    case "populateForPath":
      await requireBackend(getBackend).populateForPath(p.filePath, undefined, p.workerCount ?? undefined);
      return null;
    case "getBlameForPath":
      return (await requireBackend(getBackend).getBlameForPath(p.filePath, p.commitHex)).map(serializeBlame);
    case "getFileContentForPath":
      return requireBackend(getBackend).getFileContentForPath(p.filePath, p.commitHex);
    case "getDiffDetailForPath":
      return serializeDiffDetail(
        await requireBackend(getBackend).getDiffDetailForPath(p.filePath, p.oldHex, p.newHex),
      );
    case "getDiffRowsForPath":
      return requireBackend(getBackend).getDiffRowsForPath(p.filePath, p.oldHex, p.newHex, p.sourceLines);
    case "getCrossPathDiffRows":
      return requireBackend(getBackend).getCrossPathDiffRows(p.oldHex, p.oldPath, p.newHex, p.newPath, p.sourceLines);
    case "loadConfig":
      return loadConfig();
    case "saveConfig":
      await saveConfig(p.config as AppConfig);
      return null;
    case "openConfigInEditor": {
      const file = await ensureConfigFile();
      await vscode.window.showTextDocument(vscode.Uri.file(file));
      return null;
    }
    case "openDialog":
      return pickFile();
    case "openDirectoryDialog":
      return pickDirectory();
    case "getIdeTheme":
      return currentIdeTheme();
    case "getIdeVersion":
      return `VS Code ${vscode.version}`;
    default:
      throw new Error(`Unknown request method: ${msg.method}`);
  }
}

function requireBackend(getBackend: () => GitTimeLapse | null): GitTimeLapse {
  const b = getBackend();
  if (!b) throw new Error("No file is open in this Git Time-Lapse panel");
  return b;
}

/**
 * The user's current VS Code theme, for auto-matching the highlight.js theme.
 * Prefers the exact configured theme name (e.g. "Monokai", "GitHub Dark") since
 * the shared mapping recognizes several by name; falls back to the active theme
 * kind ("dark" / "light" / "high contrast") so the shared side can at least pick
 * a light or dark default.
 */
function currentIdeTheme(): string | null {
  const configured = vscode.workspace
    .getConfiguration("workbench")
    .get<string>("colorTheme");
  if (configured && configured.trim()) return configured;

  switch (vscode.window.activeColorTheme.kind) {
    case vscode.ColorThemeKind.Dark:
    case vscode.ColorThemeKind.HighContrast:
      return "dark";
    case vscode.ColorThemeKind.Light:
    case vscode.ColorThemeKind.HighContrastLight:
      return "light";
    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Serialization (JSON loses Date and Map; errors lose their class)
// ---------------------------------------------------------------------------

function serializeHistory(h: {
  hexSha: string;
  authorName: string;
  authorEmail: string;
  authoredDate: Date;
  message: string;
  summary: string;
}): unknown {
  return { ...h, authoredDate: h.authoredDate.toISOString() };
}

function serializeBlame(e: {
  commitHex: string;
  authorName: string;
  authorEmail: string;
  authoredDate: Date;
  origLineno: number;
  originLine: number;
  lines: string[];
}): unknown {
  return { ...e, authoredDate: e.authoredDate.toISOString() };
}

function serializeDiffDetail(d: {
  statuses: Map<number, string>;
  removals: Map<number, string[]>;
  modifiedOld: Map<number, string[]>;
}): unknown {
  return {
    statuses: [...d.statuses.entries()],
    removals: [...d.removals.entries()],
    modifiedOld: [...d.modifiedOld.entries()],
  };
}

function serializeError(err: unknown): { kind: string; message: string } {
  if (err instanceof BinaryFileError) return { kind: "BinaryFileError", message: err.message };
  if (err instanceof FileNotFoundError) return { kind: "FileNotFoundError", message: err.message };
  const message = err instanceof Error ? err.message : String(err);
  return { kind: "Error", message };
}

// ---------------------------------------------------------------------------
// Webview HTML
// ---------------------------------------------------------------------------

function getHtml(webview: vscode.Webview, extensionUri: vscode.Uri): string {
  const scriptUri = webview.asWebviewUri(
    vscode.Uri.joinPath(extensionUri, "dist", "webview.js"),
  );
  const nonce = makeNonce();
  // style-src allows 'unsafe-inline' because style-loader and the hljs theme
  // <style> inject inline styles. script-src is nonce-locked.
  const csp = [
    `default-src 'none'`,
    `img-src ${webview.cspSource} data:`,
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `font-src ${webview.cspSource}`,
  ].join("; ");
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="${csp}" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Git Time-Lapse View</title>
  </head>
  <body>
    <div id="app"></div>
    <script nonce="${nonce}">window.__VSCODE = true;</script>
    <script nonce="${nonce}" src="${scriptUri}"></script>
  </body>
</html>`;
}

function makeNonce(): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < 32; i++) out += chars.charAt(Math.floor(Math.random() * chars.length));
  return out;
}
