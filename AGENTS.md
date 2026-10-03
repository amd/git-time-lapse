<!-- Copyright Advanced Micro Devices, Inc. -->
<!-- SPDX-License-Identifier: MIT -->
# Git Time-Lapse View

A visual time-lapse viewer for file history in git repositories, inspired by Perforce's Time-Lapse View. Scrub through every revision of a file with syntax highlighting, diff coloring, blame, and age visualization.

## Architecture

The codebase follows a **shared core + thin platform shell** pattern:

```
AGENTS.md                    Agent/contributor instructions (this file)
CLAUDE.md                    Stub that imports AGENTS.md for Claude Code
README.md, LICENSE, NOTICES.txt, .gitignore

.github/
  workflows/tauri.yml        CI: Tauri v2 (Windows, Ubuntu 22.04, macOS arm64 + x64) and v1 (Rocky Linux 8 container)
  workflows/vscode.yml       CI: VS Code VSIX (Linux)
  workflows/visual-studio.yml  CI: VS webview bundle + VSIX via MSBuild (Windows)
  scripts/collect-artifacts.sh  Gathers build outputs, logs size and SHA-256, fails on missing files
  scripts/detect-changes.sh  Path filter run by each workflow's `changes` job. Workflows have no
                             trigger `paths` so their checks always report and can be required;
                             with no relevant changes the build jobs skip their steps and pass

shared/                      Platform-agnostic TypeScript
  git_backend.ts             Git CLI interaction (all READ-ONLY commands)
  types.ts                   Interfaces, config, error classes
  visualization.ts           Color logic (author, age, diff)
  globals.d.ts               Build-time constant declarations
  tsconfig.json              Standalone type-check config for shared/
  ui/
    app.ts                   Full UI
    style.css                All styles (CSS custom properties for theming)
    themes.ts                highlight.js theme catalog
    css.d.ts                 Module declaration for CSS imports

tauri/                       Desktop app shell (Rust + WebView2/WebKitGTK/WKWebView)
  index.html                 Vite entry page
  package.json, package-lock.json, .gitignore
  src/main.ts                PlatformHost + AppDeps wiring
  src/transport.ts           GitTransport via Tauri invoke
  src/config.ts              Config via Rust read/write commands
  src/tauri-api.v2.ts        Tauri v2 API shim (invoke, openDialog, win)
  src/tauri-api.v1.ts        Tauri v1 API shim, same exports
  src/vite-env.d.ts          Module declaration for `?raw` CSS imports
  src-tauri/                 Tauri v2 crate (default shell)
    Cargo.toml, Cargo.lock, build.rs
    tauri.conf.json          v2 app/bundle config
    capabilities/default.json  v2 permissions
    icons/                   App icons (shared with the v1 crate). Icons based on
                             Google Material Symbols (Apache-2.0); see NOTICES.txt.
    src/main.rs              v2 Builder only
    src/commands.rs          Shared Rust commands (git subprocess, config)
  src-tauri-v1/              Tauri v1 crate (RHEL8-compatible shell)
    Cargo.toml, Cargo.lock, build.rs
    tauri.conf.json          v1 app/bundle config and allowlist
    src/main.rs              v1 Builder; includes ../../src-tauri/src/commands.rs
  vite.config.ts             Vite bundler config (mode v1 | v2)
  tsconfig.json              tsconfig (v2; @shell/tauri-api -> tauri-api.v2.ts)
  tsconfig.v1.json           tsconfig override pointing @shell/tauri-api at v1

vscode/                      VS Code extension shell
  package.json, package-lock.json, .gitignore, .vscodeignore
  README.md, LICENSE, icon.png  Marketplace README, license and icon (same icon as
                             src-tauri/icons)
  src/extension.ts           Extension host (commands, RPC dispatch)
  src/transport.ts           GitTransport via child_process
  src/config.ts              Config via fs
  src/webview/main.ts        Webview entry
  src/webview/transport.ts   RPC bridge to extension host
  src/webview/css.d.ts       Module declaration for CSS imports
  tsconfig.json
  webpack.config.js          Webpack config (host + webview bundles)

visual-studio/               Visual Studio 2022/2026 extension shell
  package.json, package-lock.json, .gitignore
  README.md                  Build notes for the VSIX
  src/main.ts                Webview entry (same pattern as Tauri)
  src/transport.ts           GitTransport + PlatformHost via WebView2 postMessage
  src/css.d.ts               Module declaration for CSS imports
  tsconfig.json
  webpack.config.js          Webpack config (webview bundle)
  extension/                 C# VSIX project
    GitTimeLapsePackage.cs   VS package entry
    GitTimeLapsePackage.vsct Command table (Tools menu, Solution Explorer, editor context)
    Commands/OpenTimeLapseCommand.cs  Handler for the three command placements
    TimeLapseToolWindow.cs   Tool window (multi-instance)
    TimeLapseToolWindowControl.xaml(.cs)  WebView2 host
    GitRunner.cs             RPC handler (git, config)
    Properties/AssemblyInfo.cs         Assembly attributes
    Resources/               VSIX icon, command icon, LICENSE.txt; webview/webview.js is
                             generated by webpack and gitignored
    GitTimeLapseExtension.csproj       .NET Framework 4.7.2
    source.extension.vsixmanifest      VSIX metadata
```

## Key Design Decisions

- **All git commands are strictly read-only**: `rev-parse`, `cat-file`, `log`, `show`, `diff`, `ls-files`, `ls-tree`, `for-each-ref`, and `config` reads of `user.name`/`user.email` only. No checkout/commit/push/reset. `git blame` is never run; blame is derived from patches (see Precaching).
- **GitTransport interface** abstracts how git is executed. Each platform provides its own implementation (Tauri invoke, Node child_process, WebView2 postMessage to C#).
- **Precaching** uses parallel `git log -p` ranges to reconstruct content and derive blame from patches in-memory. Total git commands: `1 + 2*workers` instead of `3*N`.
- **Per-platform preferences** stored in `~/.git_time_lapse.json` with platform sub-keys (`desktop`, `vscode`, `vs`).
- **Build-time constants** `__APP_VERSION__` and `__SOURCE_COMMIT__` are injected by Vite (Tauri) and webpack DefinePlugin (VS Code, VS). The `execSync("git rev-parse --short HEAD")` is wrapped in try/catch so builds outside a git repo fall back to "unknown". `vite.config.ts` also honours a `SOURCE_COMMIT` env var, which takes precedence. It is only needed when building from Windows via WSL: a git worktree created on Windows stores a Windows-absolute gitdir in its `.git` file, so the `git` call fails when that same tree is built from WSL. Builds on a Linux machine are unaffected.
- **Commit hashes are truncated to 8 characters** throughout the UI and cache keys. This is intentional: `buildHistory()` truncates, and all cache lookups use the short form.
- **Linux builds run in-tree**, either on a Linux machine or from Windows via WSL (against the Windows checkout through `/mnt/`). Building in-tree preserves the `.git` directory needed for `__SOURCE_COMMIT__` and allows incremental Rust builds via the persistent `target/` directory.
- **Two Tauri shells, one codebase.** Tauri v2 cannot build on RHEL8 or RHEL9: it requires glib >= 2.70, webkit2gtk-4.1 and libsoup-3.0, while RHEL8 ships glib 2.56.4 / webkit2gtk-4.0 / libsoup 2.62 and RHEL9 ships glib 2.68. The v2 build fails in gobject-sys with `Package 'gobject-2.0' has version '2.56.4', required version is '>= 2.70'`. Tauri v1 does build on RHEL8 and produces a binary with a glibc 2.28 floor, so its AppImage runs on RHEL8 and everything newer; the v2 AppImage built on Ubuntu 22.04 has a 2.35 floor and runs on neither RHEL8 nor RHEL9. `src-tauri-v1/` therefore exists purely to serve RHEL8/9 users. v2 remains the default everywhere else.
- **No duplicated logic between the shells.** The Rust commands live once in `src-tauri/src/commands.rs` and the v1 crate pulls them in with `#[path = "../../src-tauri/src/commands.rs"] mod commands;`. On the TypeScript side, all shell code imports the bare specifier `@shell/tauri-api`, which a Vite alias and a tsconfig `paths` entry resolve to `tauri-api.v2.ts` or `tauri-api.v1.ts`. Neither the shared UI nor `transport.ts`/`config.ts` knows which Tauri version it is running on.
- **The two crates can never share a Cargo workspace**, so each keeps its own `Cargo.lock`. This was measured, not assumed: Tauri 1 and Tauri 2 bind to different generations of the gtk-rs `-sys` crates, and Cargo forbids two packages in one dependency graph from declaring the same `links` native-library key: `web_kit2`, `gdk-3`, `gtk-3` and `atk-1.0` all collide, so `cargo generate-lockfile` fails with "only one package in the dependency graph may specify the same links value". No resolver version (1, 2 or 3) changes this, and `default-members` does not help, because workspace membership means a single resolve graph; building one member still resolves both. Semver collapse, the obvious worry, is a non-issue: when measured, a same-instant resolve of both crates disagreed on only a couple of crates, and those would move *up* for v2. The empty `[workspace]` tables in both manifests exist to stop a future root workspace manifest from silently breaking both builds. The cost of the split is real but bounded: building both shells duplicates the compilation of the dependencies they share, roughly a quarter of the package compiles when measured.
- **v1 shell limitation**: the Tauri v1 JS API has no window `setTheme`, so `win.setTheme` is a no-op there and the native titlebar does not follow the app theme. In-webview theming is unaffected. Tauri v1 is end-of-life upstream, but the webview engine comes from the system: RHEL8's webkit2gtk3 package is still updated by Red Hat, so the engine stays current even though the Tauri layer does not.

## Prerequisites

### All targets
- **Node.js** >= 20 (with npm)
- **Git** on PATH
- **TypeScript** (installed per-target via npm)

### Tauri desktop (Windows + Linux + macOS)
- **Rust** toolchain (rustup + cargo), >= 1.77.2 (`rust-version` in both `Cargo.toml` files)
- **Windows**: Microsoft C++ Build Tools with the "Desktop development with C++" workload, the MSVC Rust toolchain as the default host triple, and the WebView2 runtime (pre-installed on Windows 10 version 1803 and later). Building the MSI bundle also needs the VBSCRIPT optional feature enabled.
- **macOS (v2 shell only)**: Xcode Command Line Tools (`xcode-select --install`); full Xcode also works. The webview is the system WKWebView. Builds are native to the host architecture (arm64 or x64) and are not code-signed or notarized, so Gatekeeper blocks a downloaded copy until the user allows it.
- **Linux builds** run either on a Linux machine or from Windows via WSL; the package lists below apply to the Linux system doing the build (the WSL distro, in the WSL case).
- **Linux (v2 shell)**: Tauri v2's Debian/Ubuntu list (`libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev`) plus `patchelf`. Needs glib >= 2.70, so Ubuntu 22.04+ / el10, not RHEL8 or RHEL9.
- **Linux (v1 shell, RHEL8)**: `webkit2gtk3-devel`, `gtk3-devel`, `libsoup-devel` (2.x), `librsvg2-devel`, `openssl-devel`, `curl`, `patchelf`, `file`, `wget`, plus the "Development Tools" group. `wget` is required: Tauri v1's `appimage.sh` shells out to it. Tauri v1's upstream list also has `libappindicator-gtk3-devel`, which is only needed for the system tray; the v1 crate does not enable it.
- **Running any AppImage** needs FUSE 2 (`libfuse2` on Debian/Ubuntu, `fuse-libs` on RHEL). Without it, use `APPIMAGE_EXTRACT_AND_RUN=1` or `--appimage-extract` plus `./squashfs-root/AppRun`.

### VS Code extension
- **VS Code** ^1.85.0 (`engines.vscode` in `vscode/package.json`)
- **webpack**, **ts-loader**, **style-loader**, **css-loader** (in devDependencies)
- **@vscode/vsce** for packaging (installed via npx)

### Visual Studio extension
- **Visual Studio 2022 or 2026** with "Visual Studio extension development" workload
- **MSBuild** (comes with VS; run it from a Developer Command Prompt or Developer PowerShell so it is on PATH)
- **.NET Framework 4.7.2** targeting pack
- **webpack** (in devDependencies)

## Version Bumping

The version is not derived from a single source, so every field below must be updated together. Display strings embed it as `Git Time-Lapse View v<version>`; keep that format.

- `tauri/package.json`: `version`, `description`
- `tauri/package-lock.json`: top-level `version` and `packages[""].version`
- `tauri/src-tauri/tauri.conf.json`: `version`, `productName`, `app.windows[0].title`. `productName` is also the version string shown in the desktop app (`__APP_VERSION__`, read by `vite.config.ts`).
- `tauri/src-tauri/Cargo.toml`: `[package]` `version`, `description`
- `tauri/src-tauri/Cargo.lock`: `version` of the `git-time-lapse` package entry
- `tauri/src-tauri-v1/tauri.conf.json`: `package.version`, `package.productName`, `tauri.windows[0].title`. `productName` also names the v1 binary and bundle files.
- `tauri/src-tauri-v1/Cargo.toml`: `[package]` `version`, `description`
- `tauri/src-tauri-v1/Cargo.lock`: `version` of the `git-time-lapse-v1` package entry
- `vscode/package.json`: `version` (semver, no pre-release suffix), `displayName`, `description`. `displayName` is also the version string shown in the extension (`__APP_VERSION__`, read by `webpack.config.js`).
- `vscode/package-lock.json`: top-level `version` and `packages[""].version`
- `visual-studio/package.json`: `version`, `displayName`, `description`. `displayName` is also the version string shown in the VS About dialog (`__APP_VERSION__`, read by `webpack.config.js`).
- `visual-studio/package-lock.json`: top-level `version` and `packages[""].version`
- `visual-studio/extension/source.extension.vsixmanifest`: `Identity` `Version` (four-part, `<version>.0`) and `Description`
- `visual-studio/extension/Properties/AssemblyInfo.cs`: `AssemblyVersion` and `AssemblyFileVersion` (four-part)

## Code Style

- No comments unless the WHY is non-obvious
- No emojis in code or commit messages
- Prefer editing existing files over creating new ones
- TypeScript strict mode (Tauri tsconfig is strictest)
- The shared code must compile under every shell's tsconfig: `tauri/tsconfig.json`, `tauri/tsconfig.v1.json`, `vscode/tsconfig.json` and `visual-studio/tsconfig.json`

## Testing a file

To manually test, open a file with many revisions in a large repo. A good stress test is a file with 500+ commits.
