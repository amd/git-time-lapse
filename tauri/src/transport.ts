// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT
/**
 * Tauri GitTransport: runs git via the Rust `run_git` command (invoke).
 *
 * The Rust side returns { code, stdout (bytes), stderr } and never throws on a
 * non-zero git exit. The shared backend expects the transport to THROW on a
 * non-zero exit (it catches where a failure is an expected outcome), so this
 * bridge inspects the code and throws accordingly.
 */

import { invoke } from "@shell/tauri-api";
import type { GitTransport } from "../../shared/types";

interface GitResult {
  code: number | null;
  stdout: number[]; // raw bytes
  stderr: string;
}

async function runGit(args: string[], cwd: string): Promise<GitResult> {
  return invoke<GitResult>("run_git", { args, cwd });
}

function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("latin1").decode(bytes);
  }
}

export const tauriTransport: GitTransport = {
  async runGitText(args, cwd) {
    const res = await runGit(args, cwd);
    if (res.code !== 0) {
      throw new Error(`git ${args.join(" ")} failed (${res.code}): ${res.stderr}`);
    }
    return decodeText(new Uint8Array(res.stdout));
  },
  async runGitBytes(args, cwd) {
    const res = await runGit(args, cwd);
    if (res.code !== 0) {
      throw new Error(`git ${args.join(" ")} failed (${res.code}): ${res.stderr}`);
    }
    return new Uint8Array(res.stdout);
  },
};

