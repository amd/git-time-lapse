<!-- Copyright Advanced Micro Devices, Inc. -->
<!-- SPDX-License-Identifier: MIT -->
# Git Time-Lapse View

A visual time-lapse viewer for file history in git repositories, inspired by Perforce's Time-Lapse View. Scrub through every revision of a file with syntax highlighting, diff coloring, blame, and age visualization.

## Platform Targets

| Target | Technology | Output |
|--------|-----------|--------|
| Windows Desktop | Tauri v2 (Rust + WebView2) | Portable EXE, MSI, NSIS installer |
| Linux Desktop | Tauri v2 (Rust + WebKitGTK 4.1) | Portable binary, .deb, .rpm, AppImage |
| Linux Desktop (RHEL8/9) | Tauri v1 (Rust + WebKitGTK 4.0) | Portable binary, .deb, .rpm, AppImage |
| macOS Desktop | Tauri v2 (Rust + WKWebView) | Portable binary, .app bundle, DMG |
| VS Code Extension | TypeScript + webpack | VSIX |
| Visual Studio Extension | C# + TypeScript + WebView2 | VSIX |

## Architecture

The codebase follows a **shared core + thin platform shell** pattern. All UI and git logic lives in `shared/`, and each platform target provides a thin shell that wires up platform-specific transport (how git commands are executed) and configuration.

```
shared/           Platform-agnostic TypeScript (UI, git backend, visualization)
tauri/            Desktop app shell (Rust + WebView2/WebKitGTK/WKWebView)
  src-tauri/      Tauri v2 crate (default)
  src-tauri-v1/   Tauri v1 crate (RHEL8/9 only)
vscode/           VS Code extension shell
visual-studio/    Visual Studio 2022/2026 extension shell (C# + WebView2)
```

The desktop shell ships in two Tauri flavours. They share the same frontend and the same Rust
command module (`src-tauri/src/commands.rs`); the only difference is which Tauri version wraps
them. Shell code imports the bare specifier `@shell/tauri-api`, which Vite resolves to
`src/tauri-api.v2.ts` or `src/tauri-api.v1.ts` depending on the build mode.

## Prerequisites

### Windows

| Requirement | Needed for | Install |
|------------|-----------|---------|
| Git | All targets | https://git-scm.com or `winget install Git.Git` |
| Node.js >= 20 | All targets | https://nodejs.org or `winget install OpenJS.NodeJS.LTS` |
| Rust toolchain >= 1.77.2 | Tauri desktop | https://rustup.rs (keep the MSVC toolchain as the default host triple) |
| Microsoft C++ Build Tools | Tauri desktop | Visual Studio Installer, "Desktop development with C++" workload |
| WebView2 runtime | Tauri desktop | Pre-installed on Windows 10 version 1803 and later |
| VBSCRIPT optional feature | Tauri MSI bundle | Settings > Apps > Optional features > More Windows features |
| VS Code ^1.85.0 | VS Code extension | https://code.visualstudio.com |
| Visual Studio 2022/2026 | VS extension | With "Visual Studio extension development" workload |
| .NET Framework 4.7.2 targeting pack | VS extension | Via Visual Studio Installer |
| MSBuild | VS extension | Included with Visual Studio; run it from a Developer Command Prompt or Developer PowerShell |

If you are behind a TLS-intercepting proxy (common on corporate networks), you also need its CA
certificate bundle and must set:
- `NODE_EXTRA_CA_CERTS=<path-to-ca-bundle.pem>`
- `CARGO_HTTP_CAINFO=<path-to-ca-bundle.pem>`

### Linux (on a Linux machine, or from Windows via WSL)

Linux builds can run either on a Linux machine or from Windows via WSL. The requirements below
apply to the Linux system doing the build: the machine itself, or the WSL distro.

| Requirement | Install |
|------------|---------|
| WSL (only when building from Windows) | `wsl --install` from PowerShell or Command Prompt |
| Git | `sudo apt install git` |
| Node.js >= 20 | Via nvm, nodesource, or distro package (when building via WSL, it must be a Node installed inside the distro, not the Windows node via /mnt/) |
| Rust toolchain >= 1.77.2 | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |
| Tauri v2 system deps | `sudo apt install libwebkit2gtk-4.1-dev build-essential curl wget file libxdo-dev libssl-dev libayatana-appindicator3-dev librsvg2-dev patchelf` |

Tauri v2 needs glib >= 2.70, webkit2gtk-4.1 and libsoup-3.0, so it requires Ubuntu 22.04+ or
el10. On RHEL8/9 build the v1 shell instead, see below.

If you are behind a TLS-intercepting proxy, set `NODE_EXTRA_CA_CERTS` and `CARGO_HTTP_CAINFO` as above.

### Linux (RHEL8 / RHEL9)

| Requirement | Install |
|------------|---------|
| Tauri v1 system deps | `sudo dnf install gtk3-devel webkit2gtk3-devel libsoup-devel librsvg2-devel openssl-devel curl patchelf file wget` |
| Development Tools | `sudo dnf groupinstall "Development Tools"` |

`wget` is required: Tauri v1's `appimage.sh` shells out to it and the bundle step fails with
`wget: command not found` otherwise. Tauri v1's upstream prerequisites also list
`libappindicator-gtk3-devel`, which is only needed for the system tray; this app does not use it.

### macOS

| Requirement | Install |
|------------|---------|
| Xcode Command Line Tools | `xcode-select --install` (full Xcode also works) |
| Git | Included with the Command Line Tools, or `brew install git` |
| Node.js >= 20 | https://nodejs.org or `brew install node` |
| Rust toolchain >= 1.77.2 | `curl --proto '=https' --tlsv1.2 -sSf https://sh.rustup.rs \| sh` |

## Quick Start

### Desktop app (Windows)

```
cd tauri
npm install
npx tauri build
```

Output: `tauri/src-tauri/target/release/git-time-lapse.exe`, plus MSI and NSIS installers under
`tauri/src-tauri/target/release/bundle/`.

### Desktop app (Linux)

On a Linux machine:

```
cd tauri
npm install
npx tauri build
```

From Windows via WSL, open a shell in the WSL distro at the checkout's `tauri` directory, then
run the same commands:

```
wsl --cd <absolute-windows-path-to-repo>\tauri
npm install
npx tauri build
```

Output: `tauri/src-tauri/target/release/git-time-lapse`, plus .deb, .rpm and AppImage under
`tauri/src-tauri/target/release/bundle/`.

When building via WSL from a git worktree that was created on Windows, `git` inside WSL cannot
resolve the commit hash (the worktree's `.git` file holds a Windows-absolute path), so the
About box shows "unknown". Set `SOURCE_COMMIT` to the short commit hash before building to
override it.

### Desktop app (macOS)

```
cd tauri
npm install
npx tauri build
```

Output: `tauri/src-tauri/target/release/git-time-lapse`, plus the `.app` bundle under
`tauri/src-tauri/target/release/bundle/macos/` and a DMG under
`tauri/src-tauri/target/release/bundle/dmg/`. The build targets the host architecture (arm64 on
Apple Silicon, x64 on Intel).

The app is not code-signed or notarized, so macOS Gatekeeper blocks it when it was downloaded
(for example a CI artifact). Allow it under System Settings > Privacy & Security, or remove the
quarantine attribute with `xattr -dr com.apple.quarantine "<path>.app"`.

### Desktop app (RHEL8 / RHEL9, Tauri v1)

```
cd tauri
npm install
npm run tauri:v1 -- build
```

Output: `tauri/src-tauri-v1/target/release/git-time-lapse-view-v<major>-<minor>-<patch>`, plus
.deb, .rpm and AppImage under `tauri/src-tauri-v1/target/release/bundle/`. The v1 CLI renames the
compiled binary to the kebab-cased `productName`, which includes the version, so the artifacts
carry the version in their names (`git-time-lapse-view-v<major>-<minor>-<patch>_<version>_amd64.AppImage`)
and change on every version bump.

Built on RHEL8 the binary has a glibc floor of 2.28, so the AppImage runs on RHEL8 and
everything newer. The v2 AppImage built on Ubuntu 22.04 has a 2.35 floor and runs on neither
RHEL8 nor RHEL9.

Running any AppImage needs FUSE 2 (`libfuse2` on Debian/Ubuntu, `fuse-libs` on RHEL). Without
it, use `APPIMAGE_EXTRACT_AND_RUN=1 ./<name>.AppImage`, or `--appimage-extract` and then
`./squashfs-root/AppRun`.

Known limitation: the Tauri v1 JS API has no window `setTheme`, so the native titlebar does
not follow the app theme. In-webview theming is unaffected.

### VS Code extension

```
cd vscode
npm install
npx webpack --mode production
npx @vscode/vsce package --no-dependencies
code --install-extension git-time-lapse-vscode-*.vsix --force
```

### Visual Studio extension

Run from a Developer Command Prompt or Developer PowerShell for Visual Studio, so `MSBuild.exe`
is on PATH:

```
cd visual-studio
npm install
npx webpack --mode production
cd extension
MSBuild.exe /t:Restore /p:Configuration=Release /v:q
MSBuild.exe /t:Rebuild /p:Configuration=Release /v:q
```

Output: `visual-studio/extension/bin/Release/net472/GitTimeLapse.vsix`

## Development

### Type-check all targets (fast validation)

```
(cd tauri && npx tsc --noEmit)
(cd tauri && npx tsc --noEmit -p tsconfig.v1.json)
(cd vscode && npx tsc --noEmit)
(cd visual-studio && npx tsc --noEmit)
```

### Install npm dependencies for all targets

```
(cd tauri && npm install)
(cd vscode && npm install)
(cd visual-studio && npm install)
```

## Key Design Decisions

- **All git commands are strictly read-only** (`rev-parse`, `cat-file`, `log`, `show`, `diff`, `ls-files`, `ls-tree`, `for-each-ref`, and `config` reads of `user.name`/`user.email`). No checkout, commit, push, or reset. `git blame` is never run.
- **Precaching** uses parallel `git log -p` ranges to reconstruct content and derive blame from patches in-memory, reducing total git commands from `3*N` to `1 + 2*workers`.
- **Per-platform preferences** stored in `~/.git_time_lapse.json` with platform sub-keys (`desktop`, `vscode`, `vs`).
- **Linux builds run in-tree**, either on a Linux machine or from Windows via WSL (building the Windows checkout in place through `/mnt/`), to preserve the `.git` directory (needed for build-time commit hash) and allow incremental Rust builds.
- **Dual Tauri shells** exist only because Tauri v2 cannot build on RHEL8 or RHEL9 (glib 2.56.4 / 2.68 versus the required >= 2.70). Tauri v1 builds there and its binary carries a glibc 2.28 floor. Both shells share one Rust command module and one frontend behind the `@shell/tauri-api` alias, so there is no forked logic. v2 is the default on every other platform.
