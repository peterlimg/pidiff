# pidiff

A live `/diff` split view for Pi: conversation and prompt on the left, changed files and a colored diff on the right. Inspired by [Claude Code's diff panel](https://code.claude.com/docs/en/interactive-mode#review-changes-with-/diff).

## Install

From this directory:

```sh
pi install "$PWD"
```

Run `/reload` in Pi. In `/settings`, change **TUI mode** to **fullscreen**, then run `/diff` from a Git repository. The split needs at least 110 terminal columns.

To try it without installing:

```sh
cd /path/to/your/repository
pi --tui-mode fullscreen -e /path/to/pidiff/index.ts
```

Requires Git and Pi's interactive terminal UI. Tested with `@earendil-works/pi-coding-agent` 0.85.1. No model call is needed to view diffs.

## Use

```text
/diff            Open or close the live split pane
/diff main       Open the split comparing against the merge-base with main
/diff view       Open the modal viewer, including recorded turns
/diff view main  Open the modal comparing against main
```

### Split pane

The conversation reflows into the left column. The pane does not cover the chat or take keyboard focus, so you can keep typing while Pi works. It refreshes after file-edit and shell tools, and polls every two seconds while open for external changes.

- The diff starts at 60% of the terminal width, without a maximum-column cap. Drag the vertical `│` divider to resize it. The selected width stays in columns while the pane is open, shrinking as needed to leave at least 40 columns for chat and 44 for the diff.
- `Ctrl+Alt+Shift+Left/Right` widens or narrows the diff by four columns without a mouse.
- The file list shows at most six rows and scrolls separately from the code. Filenames sit beside right-aligned addition/deletion counts. Click a filename to show its diff immediately below the list, with the selected path fixed above the code.
- Wheel over the file list to browse files, or over the code to scroll the patch. Neither scroll area spills into the other or into chat at its boundaries. Wheel over the header/footer scrolls only the code.
- `Ctrl+Alt+Up/Down` scrolls the code; `Ctrl+Alt+Left/Right` selects the previous or next file and brings its filename into view. Normal editing and transcript keys stay with Pi.
- Click `×` or run `/diff` again to close the pane and restore the full-width conversation.
- Below 110 columns, the pane hides and the conversation gets the full width. Widen the terminal to reveal it again.
- `/reload`, session changes, and exit close the pane and stop its background work.

Regular TUI mode cannot host this split. `/diff` explains how to switch rather than silently opening a popup. Use `/diff view` if you want the modal instead.

### Modal viewer

| Key | Action |
| --- | --- |
| Left / Right | Switch between Current and recorded turns, newest first |
| Up / Down, j / k | Select a file or scroll its diff |
| Enter | Open the selected diff |
| PageUp / PageDown | Page through the list or diff |
| Home / End | Jump to the start or end of an open diff |
| r | Reload Current from disk |
| Esc, Ctrl+C, q | Return to the list, then close |

Pi's configured selection keys also work.

Both viewers show syntax-colored code, line numbers and a `+`/`-` gutter. Added and removed lines use the active theme's success/error backgrounds, including wrapped continuations. Deleted lines carry their old line numbers; additions and context carry their new numbers. Git's `diff`, `index`, and filename headers are hidden, with `···` between hunks. Binary, file-mode, missing-newline and preview-limit notices remain visible. Syntax highlighting uses each side of each hunk separately, so it cannot recover syntax state from omitted source lines.

### Current

Shows net changes between HEAD and files on disk, including staged and unstaged changes, deletions, and non-ignored untracked files. It includes other people's edits, not just Pi's. Staged changes canceled out by unstaged changes have no net diff. Renames appear as a deletion and an addition.

When the working tree and index are clean, it compares against the merge-base with the first available default-branch candidate: `origin/HEAD`, `origin/main`, `origin/master`, local `main`, then local `master`. Use `/diff <base-ref>` for another branch. It never fetches from a remote.

Works from repository subdirectories and before the first commit. Binary files show a binary-change notice. Symlinks show their link targets, not the contents of the linked files.

### Turns

While installed, pidiff records before/after snapshots for successful local `edit` and `write` tool calls. It combines repeated edits to a file into one net diff per agent run. These diffs persist as custom session entries and follow the active `/tree` branch when reloaded or resumed. They are not sent to the model.

Turn history starts when the extension is loaded; it cannot reconstruct earlier edits. Shell commands and other tools are visible through Current, not separately tracked in turn history. Concurrent external edits to the same file can also enter a snapshot. This is a review aid, not an attribution audit or backup.

## Limits

- The split pane shows the selected file's diff under a capped, independently scrolling file list. It does not attach selected lines to prompts or automatically open when Pi first edits a file.
- Pi 0.85.1 exposes `setLayoutRoot`, but no public getter. `split.ts` uses one guarded read of the existing layout to preserve Pi's transcript and input dock. Unsupported layouts fail without being modified. No Pi installation files are patched.
- Untracked-file and turn snapshots are limited to 2 MiB per file. Turn history records up to 25 files per agent run and 32,000 patch characters per file.
- Open previews display up to 200,000 characters. Git commands have a 15-second timeout and an 8 MiB output limit. Limit failures and truncation are shown explicitly.
- Previewing does not change the repository's files or index. Temporary snapshot files are deleted after comparison. Recorded turn diffs remain in Pi's session file.

## Development

Node 22.18+ is required for the dependency-free TypeScript test runner.

```sh
npm install --ignore-scripts
npm run check
npm test
```

Tests use temporary Git repositories and real Pi TUI components and layout allocation. They cover Git comparisons, unusual filenames, binary and empty files, preview limits, turn recording, hunk numbering, syntax colors and backgrounds in dark/light themes, wrapped gutters, navigation, split sizing, large file lists, divider dragging, scroll isolation, focus preservation, live updates, and cleanup.

Manual smoke test: launch Pi with `--tui-mode fullscreen -e /path/to/pidiff/index.ts` from a changed repository in a wide terminal. Run `/diff`, type a draft without submitting it, and edit a file externally. Confirm the right pane updates while the draft stays in the left prompt. Drag the divider in both directions. Wheel above the first diff line and below the last, and over its header/footer; the chat must not move. Resize below and above 110 columns, then run `/diff` to close it. Check `/diff view` separately for the modal.
