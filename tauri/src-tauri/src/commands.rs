// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT
//! Rust command layer for git-time-lapse, shared by both desktop shells.
//!
//! Tauri restricts direct shell access from the webview, so all git CLI
//! invocations funnel through the `run_git` command here. The TypeScript
//! backend (`src/git_backend.ts`) calls it via `invoke("run_git", { args, cwd })`.
//!
//! This module is compiled into both shells: the Tauri v2 crate (`src-tauri`)
//! declares it with `mod commands;`, and the Tauri v1 crate (`src-tauri-v1`)
//! pulls in this same file with a `#[path = ...] mod commands;`. Everything in
//! here must therefore stick to APIs that are identical in tauri 1 and tauri 2
//! (`#[tauri::command]` and `tauri::async_runtime::spawn_blocking`).
//!
//! stdout is returned as raw bytes (`Vec<u8>`) rather than a String so the
//! frontend can make its own text/binary decoding decisions (the shared
//! backend's `runGitText` vs `runGitBytes` paths).
//!
//! Two extra commands handle preferences: `read_config` /
//! `write_config` persist user preferences as JSON at `~/.git_time_lapse.json`,
//! and `open_in_editor` opens that file in the OS default editor. The native
//! file-open dialog is provided by the dialog plugin (v2) or the dialog
//! allowlist (v1), not by this module.

use std::path::PathBuf;
use std::process::Command;

/// Result of running a git subprocess. Mirrors the `GitResult` interface in
/// `git_backend.ts`: `stdout` is a byte array, `code` is the process exit code
/// (null if the process was terminated by a signal), and `stderr` is decoded
/// lossily to a String for error reporting.
#[derive(serde::Serialize)]
pub struct GitResult {
    code: Option<i32>,
    stdout: Vec<u8>,
    stderr: String,
}

/// Run `git <args>` in `cwd` and return its output.
///
/// This never returns an `Err` for a non-zero git exit code; the caller
/// inspects `code` and decides what to do (some callers tolerate failure,
/// e.g. an empty diff). It only errors if the
/// git binary itself cannot be spawned.
///
/// The command is `async` and offloads the blocking `Command::output()` to a
/// dedicated blocking thread via `spawn_blocking`. Without this the synchronous
/// process spawn ran on Tauri's main thread, so the frontend's concurrent
/// precache calls froze the whole UI until git returned.
#[tauri::command]
pub async fn run_git(args: Vec<String>, cwd: String) -> Result<GitResult, String> {
    tauri::async_runtime::spawn_blocking(move || {
        let mut command = Command::new("git");
        command.args(&args).current_dir(&cwd);

        // On Windows, avoid flashing a console window for each git call
        // (CREATE_NO_WINDOW).
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            const CREATE_NO_WINDOW: u32 = 0x0800_0000;
            command.creation_flags(CREATE_NO_WINDOW);
        }

        match command.output() {
            Ok(output) => Ok(GitResult {
                code: output.status.code(),
                stdout: output.stdout,
                stderr: String::from_utf8_lossy(&output.stderr).to_string(),
            }),
            Err(err) => Err(format!("failed to spawn git in {cwd:?}: {err}")),
        }
    })
    .await
    .map_err(|e| format!("git task join error: {e}"))?
}

/// Absolute path to the preferences file (`~/.git_time_lapse.json`), shared
/// with the VS Code and Visual Studio extensions.
fn config_path() -> Option<PathBuf> {
    dirs_home().map(|home| home.join(".git_time_lapse.json"))
}

/// Resolve the user's home directory without pulling in an extra crate.
fn dirs_home() -> Option<PathBuf> {
    #[cfg(windows)]
    {
        std::env::var_os("USERPROFILE")
            .map(PathBuf::from)
            .filter(|p| !p.as_os_str().is_empty())
    }
    #[cfg(not(windows))]
    {
        std::env::var_os("HOME")
            .map(PathBuf::from)
            .filter(|p| !p.as_os_str().is_empty())
    }
}

/// Return the raw JSON text of the preferences file, or an empty string when it
/// does not exist / can't be read (the TS side then falls back to defaults).
#[tauri::command]
pub fn read_config() -> String {
    match config_path().and_then(|p| std::fs::read_to_string(p).ok()) {
        Some(text) => text,
        None => String::new(),
    }
}

/// Write the given JSON text to the preferences file. Write errors are reported
/// so the caller can surface them, but the TS layer treats them as non-fatal.
#[tauri::command]
pub fn write_config(contents: String) -> Result<(), String> {
    let path = config_path().ok_or_else(|| "could not resolve home directory".to_string())?;
    std::fs::write(&path, contents).map_err(|e| format!("failed to write {path:?}: {e}"))
}

/// Return the preferences file path so the UI can display it.
#[tauri::command]
pub fn config_file_path() -> String {
    config_path()
        .map(|p| p.to_string_lossy().to_string())
        .unwrap_or_default()
}

/// Open the preferences file in the OS default editor. Creates it (with the
/// given default JSON) first when missing so the editor always has content.
#[tauri::command]
pub fn open_in_editor(default_contents: String) -> Result<(), String> {
    let path = config_path().ok_or_else(|| "could not resolve home directory".to_string())?;
    if !path.exists() {
        std::fs::write(&path, default_contents)
            .map_err(|e| format!("failed to create {path:?}: {e}"))?;
    }

    #[cfg(windows)]
    {
        // `cmd /c start "" <path>` opens with the default handler; the empty
        // "" is the window title argument `start` expects before the path.
        let mut command = Command::new("cmd");
        command.args(["/C", "start", "", path.to_string_lossy().as_ref()]);
        use std::os::windows::process::CommandExt;
        const CREATE_NO_WINDOW: u32 = 0x0800_0000;
        command.creation_flags(CREATE_NO_WINDOW);
        command
            .spawn()
            .map_err(|e| format!("failed to open editor: {e}"))?;
    }
    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(path.as_os_str())
            .spawn()
            .map_err(|e| format!("failed to open editor: {e}"))?;
    }
    #[cfg(all(not(windows), not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(path.as_os_str())
            .spawn()
            .map_err(|e| format!("failed to open editor: {e}"))?;
    }
    Ok(())
}
