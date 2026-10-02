// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT
/**
 * Tauri v2 binding for the `@shell/tauri-api` shim.
 *
 * The shell's own sources import `@shell/tauri-api`; a vite alias plus a
 * tsconfig `paths` entry point that specifier at this file (v2 build) or at
 * tauri-api.v1.ts (v1 build). Both files export the same explicitly declared
 * shapes so either one typechecks against the same call sites.
 */

import { invoke as invokeV2 } from "@tauri-apps/api/core";
import { open as openV2 } from "@tauri-apps/plugin-dialog";
import { getCurrentWindow } from "@tauri-apps/api/window";

export interface OpenDialogOptions {
  multiple: false;
  directory: boolean;
}

export interface ShellWindow {
  setTitle(title: string): void;
  setTheme(theme: "light" | "dark" | null): void;
  close(): void;
}

export function invoke<T>(cmd: string, args?: Record<string, unknown>): Promise<T> {
  return invokeV2<T>(cmd, args);
}

export function openDialog(options: OpenDialogOptions): Promise<null | string | string[]> {
  return openV2(options) as Promise<null | string | string[]>;
}

export const win: ShellWindow = {
  setTitle(title) {
    void getCurrentWindow().setTitle(title);
  },
  setTheme(theme) {
    void getCurrentWindow().setTheme(theme);
  },
  close() {
    void getCurrentWindow().close();
  },
};
