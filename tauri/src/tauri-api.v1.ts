// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT
/**
 * Tauri v1 binding for the `@shell/tauri-api` shim.
 *
 * Mirrors tauri-api.v2.ts exactly in shape (see that file for how the specifier
 * is resolved). The v1 packages are installed under the npm alias
 * `@tauri-apps/api-v1` so both API majors can coexist in one node_modules.
 */

import { invoke as invokeV1 } from "@tauri-apps/api-v1/tauri";
import { open as openV1 } from "@tauri-apps/api-v1/dialog";
import { appWindow } from "@tauri-apps/api-v1/window";

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
  return invokeV1<T>(cmd, args);
}

export function openDialog(options: OpenDialogOptions): Promise<null | string | string[]> {
  return openV1(options) as Promise<null | string | string[]>;
}

export const win: ShellWindow = {
  setTitle(title) {
    void appWindow.setTitle(title);
  },
  // Tauri v1 has no window setTheme; the titlebar theme is fixed at startup.
  setTheme() {},
  close() {
    void appWindow.close();
  },
};
