// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT
/**
 * Tauri shell entry point.
 *
 * Wires the shared UI to Tauri: an in-webview git backend (shared GitTimeLapse
 * over the invoke transport), a PlatformHost backed by the `@shell/tauri-api`
 * shim (resolved to the v1 or v2 binding at build time), and the highlight.js
 * theme CSS strings. Then starts the app.
 */

// hljs theme CSS as raw strings (Vite ?raw). buildThemes attaches these to the
// shared theme catalog; the shared UI injects the active one into a <style>.
import defaultCss from "highlight.js/styles/default.css?raw";
import githubCss from "highlight.js/styles/github.css?raw";
import vsCss from "highlight.js/styles/vs.css?raw";
import atomOneLightCss from "highlight.js/styles/atom-one-light.css?raw";
import monokaiCss from "highlight.js/styles/monokai.css?raw";
import githubDarkCss from "highlight.js/styles/github-dark.css?raw";
import vs2015Css from "highlight.js/styles/vs2015.css?raw";
import atomOneDarkCss from "highlight.js/styles/atom-one-dark.css?raw";
import draculaCss from "highlight.js/styles/base16/dracula.css?raw";

import { openDialog, win } from "@shell/tauri-api";

import { GitTimeLapse } from "../../shared/git_backend";
import type { AppDeps, Backend, PlatformHost } from "../../shared/types";
import { startApp } from "../../shared/ui/app";
import { buildThemes } from "../../shared/ui/themes";
import { tauriTransport } from "./transport";
import { loadConfig, openConfigInEditor, saveConfig } from "./config";

const themes = buildThemes({
  default: defaultCss,
  github: githubCss,
  vs: vsCss,
  "atom-one-light": atomOneLightCss,
  monokai: monokaiCss,
  "github-dark": githubDarkCss,
  vs2015: vs2015Css,
  "atom-one-dark": atomOneDarkCss,
  dracula: draculaCss,
});

const host: PlatformHost = {
  loadConfig,
  saveConfig,
  openConfigInEditor,
  async openFileDialog() {
    const selected = await openDialog({ multiple: false, directory: false });
    return typeof selected === "string" ? selected : null;
  },
  async openDirectoryDialog() {
    const selected = await openDialog({ multiple: false, directory: true });
    return typeof selected === "string" ? selected : null;
  },
  setTitle(title) {
    win.setTitle(title);
  },
  setTheme(theme) {
    win.setTheme(theme);
  },
  close() {
    win.close();
  },
  showError(message) {
    // Tauri has no built-in toast here; the window alert works in the webview.
    alert(message);
  },
  async getIdeVersion() {
    return null;
  },
  isVSCode: false,
};

const deps: AppDeps = {
  createBackend(repoDir, filePath, ref): Promise<Backend> {
    return GitTimeLapse.create(tauriTransport, repoDir, filePath, ref);
  },
  host,
  themes,
};

// The shared App.init() handles the optional ?file= deep link itself.
startApp(deps);
