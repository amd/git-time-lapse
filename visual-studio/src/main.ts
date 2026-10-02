// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT
/**
 * Visual Studio (WebView2) webview entry point.
 *
 * Wires the shared UI to the WebView2 host: an in-webview git backend (shared
 * GitTimeLapse over the WebView2 transport), a PlatformHost backed by the C#
 * host (config/dialog/editor/title), and the two highlight.js theme CSS strings
 * (bundled by webpack as asset/source). Then starts the app, listens for the
 * host's "openFile" push, and signals ready.
 *
 * Backend runs here (Tauri model), so the C# side only executes git and a few
 * host services; see src/transport.ts.
 */

// hljs theme CSS as raw strings (webpack asset/source). buildThemes attaches
// these to the shared theme catalog; the shared UI injects the active one.
import defaultCss from "highlight.js/styles/default.css";
import githubCss from "highlight.js/styles/github.css";
import vsCss from "highlight.js/styles/vs.css";
import atomOneLightCss from "highlight.js/styles/atom-one-light.css";
import monokaiCss from "highlight.js/styles/monokai.css";
import githubDarkCss from "highlight.js/styles/github-dark.css";
import vs2015Css from "highlight.js/styles/vs2015.css";
import atomOneDarkCss from "highlight.js/styles/atom-one-dark.css";
import draculaCss from "highlight.js/styles/base16/dracula.css";

import { GitTimeLapse } from "../../shared/git_backend";
import type { AppDeps, Backend } from "../../shared/types";
import { startApp } from "../../shared/ui/app";
import { buildThemes } from "../../shared/ui/themes";
import { webview2Transport, vsHost } from "./transport";

const deps: AppDeps = {
  createBackend(repoDir, filePath, ref): Promise<Backend> {
    return GitTimeLapse.create(webview2Transport, repoDir, filePath, ref);
  },
  host: vsHost,
  themes: buildThemes({
    default: defaultCss,
    github: githubCss,
    vs: vsCss,
    "atom-one-light": atomOneLightCss,
    monokai: monokaiCss,
    "github-dark": githubDarkCss,
    vs2015: vs2015Css,
    "atom-one-dark": atomOneDarkCss,
    dracula: draculaCss,
  }),
};

const app = startApp(deps);

// The C# host pushes a file to open (from the Tools menu / file context menu).
// It arrives either as a message after "ready", or pre-seeded on window before
// the script ran.
window.chrome.webview.addEventListener("message", (e) => {
  const msg = e.data as {
    type?: string;
    filePath?: string;
    focusLine?: number;
  };
  if (msg && msg.type === "openFile" && typeof msg.filePath === "string") {
    const focusLine =
      typeof msg.focusLine === "number" && msg.focusLine > 0
        ? msg.focusLine
        : undefined;
    void app.loadFile(msg.filePath, true, false, undefined, focusLine);
  }
});

if (typeof window.__VS_OPEN_FILE === "string" && window.__VS_OPEN_FILE) {
  const seeded = window.__VS_OPEN_LINE;
  const focusLine =
    typeof seeded === "number" && seeded > 0 ? seeded : undefined;
  void app.loadFile(window.__VS_OPEN_FILE, true, false, undefined, focusLine);
}

// Listeners installed; tell the host it can push the file to open.
window.chrome.webview.postMessage({ type: "ready" });
