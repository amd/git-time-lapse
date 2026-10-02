// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT
/**
 * Tauri preference persistence: JSON at ~/.git_time_lapse.json via the Rust
 * read_config / write_config / open_in_editor commands. The file is shared
 * with the VS Code and Visual Studio extensions, each under its own subkey.
 */

import { invoke } from "@shell/tauri-api";
import { AppConfig, DEFAULT_CONFIG, loadConfigFromRaw, saveConfigToRaw } from "../../shared/types";

const PLATFORM = "desktop" as const;
let rawData: Record<string, unknown> = {};

export async function loadConfig(): Promise<AppConfig> {
  let text = "";
  try {
    text = await invoke<string>("read_config");
  } catch {
    return { ...DEFAULT_CONFIG };
  }
  if (!text.trim()) return { ...DEFAULT_CONFIG };
  try {
    const parsed = JSON.parse(text);
    if (parsed && typeof parsed === "object") rawData = parsed;
  } catch {
    return { ...DEFAULT_CONFIG };
  }
  return loadConfigFromRaw(rawData, PLATFORM);
}

export async function saveConfig(config: AppConfig): Promise<void> {
  rawData = saveConfigToRaw(rawData, config, PLATFORM);
  try {
    await invoke("write_config", { contents: JSON.stringify(rawData, null, 2) });
  } catch {}
}

export async function openConfigInEditor(): Promise<void> {
  const defaults = JSON.stringify(DEFAULT_CONFIG, null, 2);
  await invoke("open_in_editor", { defaultContents: defaults });
}
