// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT
/**
 * VS Code webview entry point.
 *
 * Wires the shared UI to the webview: a backend that RPCs to the extension host
 * (where the real shared backend runs), the postMessage PlatformHost, and the
 * two highlight.js theme CSS strings (bundled via webpack asset/source). Then
 * starts the app, listens for the host's "openFile" push, and signals ready.
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

import type { AppDeps } from "../../../shared/types";
import { startApp } from "../../../shared/ui/app";
import { buildThemes } from "../../../shared/ui/themes";
import { createBackend, onHostMessage, signalReady, vscodeHost } from "./transport";

const deps: AppDeps = {
  createBackend,
  host: vscodeHost,
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

// The extension host pushes a file or repo to open (from the command / context
// menu). A file goes to File mode; a directory switches to Repo mode.
onHostMessage((msg) => {
  if (msg.type === "openFile" && typeof msg.filePath === "string") {
    const focusLine =
      typeof msg.focusLine === "number" && msg.focusLine > 0 ? msg.focusLine : undefined;
    void app.loadFile(msg.filePath, true, false, undefined, focusLine);
  } else if (msg.type === "openRepo" && typeof msg.repoDir === "string") {
    void app.openRepo(msg.repoDir);
  }
});

// Listeners are installed; tell the host it can push the file to open.
signalReady();
