# pidiff

A live `/diff` split view for Pi: conversation and prompt on the left, changed files and a colored diff on the right. Inspired by [Claude Code's diff panel](https://code.claude.com/docs/en/interactive-mode#review-changes-with-/diff).

## Install

From npm:

```sh
pi install npm:pidiff
```

Or install from GitHub:

```sh
pi install git:github.com/peterlimg/pidiff
```

Run `/reload` in Pi. In `/settings`, change **TUI mode** to **fullscreen**, then run `/diff` from a Git repository. The split needs at least 110 terminal columns.

To try it without installing:

```sh
cd /path/to/your/repository
pi --tui-mode fullscreen -e /path/to/pidiff/index.ts
```

Requires Node.js 22.19+, Git, and Pi's interactive terminal UI. Targets `@earendil-works/pi-coding-agent` 0.85.1; older Pi versions are unsupported. No model call is needed to view diffs.

## Use

```text
/diff            Open or close the split showing unstaged changes
/diff main       Compare against the merge-base with main
/diff HEAD       Show net uncommitted changes, including untracked files
/diff view       Open unstaged changes and recorded turns in the modal
/diff view main  Open the modal comparing against main
```

### Split pane

The conversation reflows into the left column. The pane does not cover the chat or take keyboard focus, so you can keep typing while Pi works. It refreshes after file-edit and shell tools, and polls every two seconds while open for external changes.

- The diff starts at 60% of the terminal width, without a maximum-column cap. Drag the vertical `│` divider to resize it. The selected width stays in columns while the pane is open, shrinking as needed to leave at least 40 columns for chat and 44 for the diff.
- `Ctrl+Alt+Shift+Left/Right` widens or narrows the diff by four columns without a mouse.
- The file list shows at most six rows and scrolls separately from the code. Filenames sit beside right-aligned addition/deletion counts. Click a filename to show its diff immediately below the list, with the selected path fixed above the code.
- Wheel over the file list to browse filenames without changing the selected file. Over the code, scrolling past the bottom opens the next file at its top; scrolling past the top opens the previous file at its bottom. The selected filename stays visible in the list. Scrolling stops at the first and last files, never wraps or scrolls chat. Wheel over the header/footer behaves like scrolling over the code.
- `Ctrl+Alt+Up/Down` uses the same scrolling and file-boundary navigation; `Ctrl+Alt+Left/Right` selects a file directly. Normal editing and transcript keys stay with Pi.
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

Pi's configured selection keys also work. Closing, going back, switching tabs, or replacing a load cancels pending modal work.

Both viewers show syntax-colored code, line numbers and a `+`/`-` gutter. Added and removed lines use the active theme's success/error backgrounds, including wrapped continuations. Deleted lines carry their old line numbers; additions and context carry their new numbers. Git's `diff`, `index`, and filename headers are hidden, with `···` between hunks. Binary, file-mode, missing-newline and preview-limit notices remain visible. Syntax highlighting uses each side of each hunk separately, so it cannot recover syntax state from omitted source lines.

### Current

By default, shows tracked, unstaged changes between the index and working tree, like `git diff`. Staged-only changes, untracked files, and committed changes are excluded. A clean working tree shows "No unstaged changes", even if the branch is ahead of its remote. Partially staged files show only the differences from their staged contents. Files marked with `git add -N` appear just as they do in `git diff`.

Comparisons against a branch or commit require `/diff <base-ref>`. This compares the working tree against the merge-base of HEAD and the specified ref, and also includes non-ignored untracked files. Use `/diff HEAD` for net staged and unstaged changes plus untracked files. It never selects a base automatically or fetches from a remote.

Both modes include other people's local edits, not just Pi's. Renames are not inferred. The default works from repository subdirectories and before the first commit. Binary files show a binary-change notice. Unmerged paths appear once with an unsupported-conflict preview notice; resolve them with Git before previewing. Symlinks show their link targets, not the contents of the linked files.

### Turns

While installed, pidiff records before/after snapshots for successful local `edit` and `write` tool calls. Snapshot paths follow Pi's tool normalization, including Unicode spaces and file URLs. Unlike Current, turn snapshots follow symlinks to record the linked file's contents. It combines repeated edits to a file into one net diff per agent run. These diffs persist as custom session entries and follow the active `/tree` branch when reloaded or resumed. They are not sent to the model.

Turn history starts when the extension is loaded; it cannot reconstruct earlier edits. Shell commands and other tools are visible through Current, not separately tracked in turn history. Concurrent external edits to the same file can also enter a snapshot. This is a review aid, not an attribution audit or backup.

## Limits

- The split pane shows the selected file's diff under a capped, independently scrolling file list. It does not attach selected lines to prompts or automatically open when Pi first edits a file.
- Pi 0.85.1 exposes `setLayoutRoot`, but no public getter. `split.ts` uses one guarded read of the existing layout to preserve Pi's transcript and input dock. Unsupported layouts fail without being modified. No Pi installation files are patched.
- Untracked-file and turn snapshots are limited to 2 MiB per file. Turn history records up to 25 files per agent run and 32,000 patch characters per file.
- Open previews display up to 200,000 characters. Git commands have a 15-second timeout and an 8 MiB output limit. Limit failures and truncation are shown explicitly.
- Previewing does not change the repository's files or index. Temporary snapshot files are deleted after comparison. Recorded turn diffs remain in Pi's session file.

## Development

Use Node.js 22.19+ for Pi and the built-in TypeScript test runner. To install a local checkout, run `pi install "$PWD"` from this directory.

```sh
npm install --ignore-scripts
npm run check
npm test
```

Tests use temporary Git repositories and real Pi TUI components and layout allocation. They cover Git comparisons, unusual filenames, binary and empty files, preview limits, turn recording, hunk numbering, syntax colors and backgrounds in dark/light themes, wrapped gutters, navigation, split sizing, large file lists, divider dragging, cross-file scrolling in both directions, scroll isolation, focus preservation, live updates, and cleanup.

Manual smoke test: launch Pi with `--tui-mode fullscreen -e /path/to/pidiff/index.ts` from a changed repository in a wide terminal. Run `/diff`, type a draft without submitting it, and edit a file externally. Confirm the right pane updates while the draft stays in the left prompt. Drag the divider in both directions. Scroll past the code's bottom to open the next file at its top, then past its top to return to the previous file's bottom. Try a one-line diff too. The first and last files must not wrap. Wheel over the header/footer; the chat must not move. Resize below and above 110 columns, then run `/diff` to close it. Check `/diff view` separately for the modal.

## License

[MIT](LICENSE). Report bugs on [GitHub Issues](https://github.com/peterlimg/pidiff/issues).
