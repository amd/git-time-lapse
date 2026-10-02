<!-- Copyright Advanced Micro Devices, Inc. -->
<!-- SPDX-License-Identifier: MIT -->
# Git Time-Lapse View

A visual time-lapse viewer for a single file's history in a git repository.

Scrub a slider through the commits that touched a file and watch a
syntax-highlighted view of its contents change over time, with diff, blame,
and age coloring, a blame gutter, and per-revision commit details.

Requires VS Code 1.85.0 or later.

## Usage

- **Command Palette**: run **Git Time-Lapse: Open** and pick a file.
- **Context menu**: right-click a file in the Explorer, an editor tab, or the
  editor body and choose **Open Time-Lapse View**.
- **Repository view**: right-click a folder in the Explorer and choose
  **Open Time-Lapse View (Repository)**, or run it from the Command Palette and
  pick a folder.

## Controls

- **Slider / ◄ ► (Left/Right arrows)**: step through revisions.
- **▲ ▼ (Up/Down arrows)**: jump between changed chunks.
- **Coloring**: None, Diff vs. previous, Range Diff (two slider handles; shows
  the file at the end revision, colored by the accumulated diff from the start
  revision), Blame (by author), Age (older fades).
- **Gutter**: Revision, Commit Hash, Author, or Date.
- **Zoom**: − / ⟳ / + buttons or Ctrl+- / Ctrl+0 / Ctrl+= .
- **Theme**: light/dark toggle (Ctrl+D).
- **Find**: Ctrl+F; F3 / Shift+F3 for next / previous match.
- **Find in History**: Search > Find in History searches every revision of the
  file, marking where matches were added and removed.
- **File menu**: Open File..., Open File in New Tab..., Open Repo..., Open Repo
  in New Tab..., New Tab, Close Tab, and Quit (closes the panel).

VS Code also receives the keys pressed inside the panel and runs its own
binding for them. The File menu items show the desktop app's shortcuts (Ctrl+O,
Ctrl+Shift+O, Ctrl+R, Ctrl+Shift+R, Ctrl+T, Ctrl+W, Ctrl+Q), but these collide
with VS Code defaults (for example Ctrl+W is Close Editor, which closes the
whole panel), so use the menu instead. Likewise Ctrl+= and Ctrl+- also zoom the
VS Code window.

## Notes

Preferences are stored in `~/.git_time_lapse.json`. All git commands issued are
strictly read-only; the extension never modifies your working tree, index, or
branch.
