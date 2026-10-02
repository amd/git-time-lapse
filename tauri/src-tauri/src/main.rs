// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT
// Prevents an additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

//! Tauri v2 shell entry point for git-time-lapse.
//!
//! All the actual commands live in `commands.rs`, which is shared verbatim with
//! the Tauri v1 shell in `../../src-tauri-v1`. This file holds only the v2
//! Builder wiring: the dialog and window-state plugins, and the handler list.

mod commands;

fn main() {
    tauri::Builder::default()
        .plugin(tauri_plugin_dialog::init())
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
