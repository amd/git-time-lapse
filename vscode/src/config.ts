// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT
/**
 * VS Code host preference persistence: JSON at ~/.git_time_lapse.json (the same
 * file the desktop app and Visual Studio extension use), via Node fs.
 */

import { promises as fs } from "fs";
import * as os from "os";
import * as path from "path";
import { AppConfig, DEFAULT_CONFIG, loadConfigFromRaw, saveConfigToRaw } from "../../shared/types";

const PLATFORM = "vscode" as const;

function configPath(): string {
  return path.join(os.homedir(), ".git_time_lapse.json");
}

let rawData: Record<string, unknown> = {};

export async function loadConfig(): Promise<AppConfig> {
  let text = "";
  try {
    text = await fs.readFile(configPath(), "utf8");
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
    await fs.writeFile(configPath(), JSON.stringify(rawData, null, 2), "utf8");
  } catch {}
}

export async function ensureConfigFile(): Promise<string> {
  const p = configPath();
  try {
    await fs.access(p);
  } catch {
    try {
      await fs.writeFile(p, JSON.stringify(DEFAULT_CONFIG, null, 2), "utf8");
    } catch {
      // ignore
    }
  }
  return p;
}
