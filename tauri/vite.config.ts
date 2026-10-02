// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT
import { defineConfig } from "vite";
import { fileURLToPath, URL } from "node:url";
import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

// The v1 and v2 Tauri configs use different schemas, so the version string
// lives at a different path in each. Both must yield the same value.
function readAppVersion(isV1: boolean): string {
  const confUrl = isV1
    ? new URL("./src-tauri-v1/tauri.conf.json", import.meta.url)
    : new URL("./src-tauri/tauri.conf.json", import.meta.url);
  try {
    const conf = JSON.parse(readFileSync(fileURLToPath(confUrl), "utf-8"));
    return (isV1 ? conf.package?.productName : conf.productName) ?? "unknown";
  } catch {
    return "unknown";
  }
}

export default defineConfig(({ mode }) => {
  const isV1 = mode === "v1";
  const appVersion = readAppVersion(isV1);
  // SOURCE_COMMIT lets a caller inject the hash when `git` cannot resolve it in
  // the build environment. This only arises when building from Windows via WSL:
  // a git worktree checked out on Windows stores a Windows-absolute gitdir in
  // its .git file, so `git rev-parse` fails when the same tree is built from
  // WSL, and the bundles would otherwise ship "unknown" in their About box.
  // Builds on a Linux machine are unaffected.
  let sourceCommit = process.env.SOURCE_COMMIT?.trim() || "unknown";
  if (sourceCommit === "unknown") {
    try { sourceCommit = execSync("git rev-parse --short HEAD", { encoding: "utf-8" }).trim(); } catch { /* not in a git repo */ }
  }

  return {
    clearScreen: false,
    resolve: {
      alias: {
        // The shell imports the Tauri JS API through this bare specifier so the
        // same source builds against either Tauri major version.
        "@shell/tauri-api": fileURLToPath(
          new URL(isV1 ? "./src/tauri-api.v1.ts" : "./src/tauri-api.v2.ts", import.meta.url),
        ),
        // The shared UI (../shared) imports highlight.js, but shared/ has no
        // node_modules; alias it to this shell's install so Rollup resolves it.
        "highlight.js": fileURLToPath(
          new URL("./node_modules/highlight.js", import.meta.url),
        ),
      },
    },
    server: {
      port: 5173,
      strictPort: true,
      fs: {
        allow: [
          fileURLToPath(new URL(".", import.meta.url)),
          fileURLToPath(new URL("../shared", import.meta.url)),
        ],
      },
    },
    define: {
      __APP_VERSION__: JSON.stringify(appVersion),
      __SOURCE_COMMIT__: JSON.stringify(sourceCommit),
    },
    envPrefix: ["VITE_", "TAURI_"],
    build: {
      outDir: isV1 ? "dist-v1" : "dist",
      target: "es2021",
      minify: !process.env.TAURI_DEBUG ? "esbuild" : false,
      sourcemap: !!process.env.TAURI_DEBUG,
    },
  };
});
