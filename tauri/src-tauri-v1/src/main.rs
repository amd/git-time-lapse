// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT
// Prevents an additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Tauri v1 shell entry point for git-time-lapse.
//!
//! This crate exists only for RHEL8/9, where Tauri v2's glib/webkit2gtk/libsoup
//! requirements cannot be met. The commands are not duplicated: the module below
//! is the exact same source file the v2 shell compiles, included by path so the
//! two shells can never drift apart.
//!
//! The only v1-specific wiring here is the Builder. There is no dialog plugin
//! crate in v1; the native file dialog is core, gated by the `dialog-open`
//! feature in Cargo.toml and the `dialog.open` allowlist in tauri.conf.json.

#[path = "../../src-tauri/src/commands.rs"]
mod commands;

fn main() {
    tauri::Builder::default()
        // Persist and restore the window's position, size, and monitor across
        // launches (stored by the plugin in its own state file, saved on exit
        // and on move/resize).
        .plugin(tauri_plugin_window_state::Builder::default().build())
        .invoke_handler(tauri::generate_handler![
            commands::run_git,
            commands::read_config,
            commands::write_config,
            commands::config_file_path,
            commands::open_in_editor
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
