<!-- Copyright Advanced Micro Devices, Inc. -->
<!-- SPDX-License-Identifier: MIT -->
# Git Time-Lapse View - Visual Studio extension

A Visual Studio 2022/2026 extension that hosts the shared Git Time-Lapse UI in a
WebView2 tool window. It reuses the same TypeScript codebase (`../shared`) as the
Tauri desktop app and the VS Code extension.

## Architecture

Same "shared UI in a webview + thin native shell" pattern as the other targets,
following the Tauri model: the shared git backend runs **in the webview**, and
the C# host only runs `git` subprocesses and a few host services.

```
webview (WebView2)                         C# host (VS extension)
  shared/ui/app.ts        ── postMessage ──►  GitRunner.cs
  shared/git_backend.ts   ◄── reply ────────    git subprocess, config, dialog
  src/transport.ts (bridge)
```

- `src/transport.ts`: WebView2 `postMessage` bridge implementing `GitTransport`
  (throws on non-zero git exit, matching the Tauri contract) and `PlatformHost`
  (config, dialog, open-in-editor, title).
- `src/main.ts`: webview entry; wires the shared UI to the in-webview backend.
- `extension/`: the C# VSIX. An `AsyncPackage`, a `ToolWindowPane` hosting a
  `WebView2`, the "Git Time-Lapse View" command (Tools menu + Solution Explorer
  + editor context menus), and `GitRunner` (git + host services).

## Prerequisites

- Visual Studio 2022 or 2026 with the "Visual Studio extension development"
  workload.
- .NET Framework 4.7.2 targeting pack (via the Visual Studio Installer).
- WebView2 runtime (ships with recent Windows / VS).
- Node.js >= 20 with npm, on PATH.

## Build

1. Build the webview bundle (produces `extension/Resources/webview/webview.js`):

   ```powershell
   npm install
   npx webpack --mode production
   ```

2. Build the VSIX with MSBuild from a Developer Command Prompt or Developer
   PowerShell for Visual Studio, which puts `msbuild` on PATH. **Restore and
   Build must be separate invocations**: the project imports MSBuild targets
   from the restored VSSDK package, so they only exist on the second invocation.

   ```powershell
   msbuild extension\GitTimeLapseExtension.csproj /t:Restore
   msbuild extension\GitTimeLapseExtension.csproj /t:Rebuild /p:Configuration=Release
   ```

   From a plain PowerShell, locate MSBuild with `vswhere` (installed with
   Visual Studio) instead:

   ```powershell
   $vswhere = "${env:ProgramFiles(x86)}\Microsoft Visual Studio\Installer\vswhere.exe"
   $msbuild = & $vswhere -latest -requires Microsoft.Component.MSBuild -find MSBuild\**\Bin\MSBuild.exe | Select-Object -First 1
   & $msbuild extension\GitTimeLapseExtension.csproj /t:Restore
   & $msbuild extension\GitTimeLapseExtension.csproj /t:Rebuild /p:Configuration=Release
   ```

   Output: `extension\bin\Release\net472\GitTimeLapse.vsix`.

   (Building from within Visual Studio handles the restore/build ordering for
   you.)

Install the `.vsix` by double-clicking it, or run/debug with F5 from Visual
Studio (launches the experimental instance).

## Notes on the project style

The extension is an **SDK-style** project using explicit top/bottom `Sdk`
imports so `Microsoft.VsSDK.targets` is imported *after* the .NET SDK. The VSSDK
seeds several path-derived defaults with an `== ''` guard; importing it before
the SDK computes those paths captures empty strings and breaks pkgdef/VSIX
creation. See the comments in `GitTimeLapseExtension.csproj`.

The project references the 17.x `Microsoft.VisualStudio.SDK` meta-package (NuGet
has no 18.x release at the time of writing), which targets `net472`; extensions
built this way load in both VS 2022 (17.x) and VS 2026 (18.x). The manifest
declares the `[17.0, 19.0)` range.
