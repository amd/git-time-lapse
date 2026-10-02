// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT
/**
 * VS Code extension-host GitTransport: runs git via Node child_process.
 *
 * The shared backend expects the transport to THROW on a non-zero git exit
 * (it catches where a failure is an expected outcome), and execFile already
 * rejects on non-zero exit, so this maps cleanly. stdout is captured as bytes.
 */

import { execFile } from "child_process";
import type { GitTransport } from "../../shared/types";

function run(args: string[], cwd: string): Promise<Buffer> {
  return new Promise<Buffer>((resolve, reject) => {
    execFile(
      "git",
      args,
      { cwd, encoding: "buffer", maxBuffer: 50 * 1024 * 1024, windowsHide: true },
      (error, stdout) => {
        const out = stdout instanceof Buffer ? stdout : Buffer.from(stdout ?? "");
        if (error) {
          reject(error);
          return;
        }
        resolve(out);
      },
    );
  });
}

function decodeText(bytes: Uint8Array): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return new TextDecoder("latin1").decode(bytes);
  }
}

export const nodeTransport: GitTransport = {
  async runGitText(args, cwd) {
    return decodeText(new Uint8Array(await run(args, cwd)));
  },
  async runGitBytes(args, cwd) {
    return new Uint8Array(await run(args, cwd));
  },
};
