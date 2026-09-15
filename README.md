# pi-diff

A live diff viewer for [Pi](https://pi.dev). Keep your conversation and prompt on the left, with changed files and syntax-colored diffs on the right.

![pi-diff showing live diffs, pane resizing, file switching, and the modal viewer](https://raw.githubusercontent.com/peterlimg/pi-diff/main/assets/demo.gif)

[Watch the 29-second demo](https://github.com/peterlimg/pi-diff/blob/main/assets/demo.mp4). Recorded in Pi with a scripted sample project.

- Watch diffs update as Pi works or files change externally.
- Resize the pane and browse files without leaving your prompt.
- Review Pi's edits by turn in the pane or modal viewer.

## Install

```sh
pi install git:github.com/peterlimg/pi-diff
```

Run `/reload`, then set **TUI mode** to **fullscreen** in `/settings`. Open a Git repository and run `/diff`.

The split pane needs at least **110 terminal columns**. Use `/diff view` for a modal viewer in regular TUI mode or a narrower terminal.

Requires Node.js 22.19+ and Git. Tested with Pi 0.85.1; older Pi versions are unsupported.

## Use

| Command | Action |
| --- | --- |
| `/diff` | Toggle the live pane showing unstaged changes |
| `/diff HEAD` | Show net staged and unstaged changes, plus untracked files |
| `/diff main` | Compare against the merge-base with `main` |
| `/diff view` | Open unstaged changes and recorded turns in the modal |
| `/diff view main` | Open the modal comparing against `main` |

By default, `/diff` works like `git diff`: staged-only and untracked files are excluded. Viewing diffs does not modify your files or index.

### Split pane

Use Alt/Option+Left / Right to switch between Current and recorded turns, in the same order as `/diff view`. Current refreshes live; recorded turns show saved edits. New turns appear without changing your selection.

Click a filename or use Alt/Option+Up / Down to open its diff. Drag the divider to resize. Scroll over the file list or code independently; scrolling past a diff's end opens the next file. Click `×` or run `/diff` again to close.

| Shortcut | Action |
| --- | --- |
| Ctrl+Alt+Up / Down | Scroll code |
| Alt+Left / Right | Switch between Current and recorded turns |
| Alt+Up / Down | Select a file |
| Ctrl+Alt+Shift+Left / Right | Resize the pane |

Alt is Option on macOS. The pane uses modified arrows so plain arrows stay available in the prompt. While the pane is visible, its shortcuts take precedence over prompt word movement and other editor bindings.

### Modal viewer

| Key | Action |
| --- | --- |
| Left / Right | Switch between Current and recorded turns |
| Up / Down, j / k | Select a file or scroll code |
| Enter | Open a diff |
| PageUp / PageDown | Page through files or code |
| r | Refresh Current |
| Esc, Ctrl+C, q | Go back, then close |

Turn history covers Pi's `edit` and `write` calls while pi-diff is loaded. Shell and external edits appear in Current, not as recorded turns.

### Privacy

Turn history saves prompt excerpts and file diffs in your local Pi session, even when the diff pane is closed. Secrets in edited files are not redacted. Review session exports and keep backups private if they contain sensitive content.

## License

[MIT](LICENSE)
