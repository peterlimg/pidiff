# Updating the demo

The README demo is a recording of the real Pi terminal UI running this checkout's `index.ts`. VHS types the commands and exports both formats. The conversation is scripted sample data, not a live model response.

## Files

| File | What to change |
| --- | --- |
| [demo.tape](demo.tape) | Commands, typing speed, pauses, terminal size and appearance |
| [demo.mjs](demo.mjs) | Sample repository, conversation and timed file edits |
| [../assets/demo.gif](../assets/demo.gif) | Looping README image |
| [../assets/demo.mp4](../assets/demo.mp4) | Video linked from the README |

## Setup

The approved recording used macOS, VHS **0.11.0**, Pi **0.85.1**, the Menlo font, and FFmpeg. You also need Node.js 22.19+, Git, `ttyd`, and Chrome or Chromium. VHS can download a browser if it cannot find one.

1. Run `npm ci --ignore-scripts` from the repository root. The demo uses the local Pi dependency, not your globally installed Pi.
2. Install missing recording tools. On macOS, `brew install ttyd ffmpeg` supplies the two VHS dependencies.
3. Download VHS 0.11.0 for your OS and architecture from the [release page](https://github.com/charmbracelet/vhs/releases/tag/v0.11.0). Verify its archive against the release checksum file, extract it, and add the directory containing `vhs` to `PATH`.
4. Check `vhs --version`, `ttyd --version`, and `ffmpeg -version`.

VHS 0.12.0 printed export messages but produced no media in the original recording environment. Version 0.11.0 worked. If trying another version, verify fresh output files rather than trusting its exit status.

On other platforms, replace `Menlo` in the tape with an installed monospace font. Font metrics affect terminal columns, so check that the split still appears. The split requires at least 110 columns. Other platforms have not been verified.

## Re-record

Run everything below from the repository root. Export into a fresh directory so a failed recording cannot be mistaken for an older successful one.

```sh
node --check scripts/demo.mjs
vhs validate scripts/demo.tape

preview="$(mktemp -d)"
vhs -o "$preview/demo.gif" -o "$preview/demo.mp4" scripts/demo.tape

test -s "$preview/demo.gif" && test -s "$preview/demo.mp4"
ffprobe -v error -show_entries format=duration,size -of json "$preview/demo.mp4"
```

On macOS, open both exports with:

```sh
open "$preview/demo.mp4" "$preview/demo.gif"
```

After checking the recording, replace the committed assets:

```sh
cp "$preview/demo.gif" "$preview/demo.mp4" assets/
git diff --check
git status --short
```

The README already references these filenames. Update its duration label if the new video is no longer about 29 seconds. Commit the assets and any changed recording sources together. Do not commit temporary recordings or screenshots.

## Sequence and pacing

Keep the approved sequence:

1. Start with the full-width conversation and no diff pane.
2. Type `/diff`, open the pane, and pause on the existing changes.
3. Type a draft without submitting it. Show a new file change appearing while the draft stays in place.
4. Resize the pane and switch files.
5. Open `/diff view` and inspect a diff.
6. Close the modal and pane, returning to the conversation.

The current recording is about **29 seconds**, at **1440 × 520**. Aim for 25–35 seconds, readable typing and 2–4 second pauses on important states. Keep `PlaybackSpeed` at `1`; trim idle pauses instead of accelerating all interactions.

Do not add `LoopOffset`. It rotates the exported frames and previously caused the MP4 to start with the pane already open, skipping the introduction.

### Changing the sample or timing

- Edit `before`, `after`, `tests`, and `messages` in `demo.mjs` to change the example.
- The sample starts with two modified files. Its `10_000` ms timer adds the blank-name fallback and another test after Pi launches.
- That timer uses wall-clock time, including hidden startup, not exported video time. If you change the opening pauses or typing speed, adjust the timer too. Allow up to two seconds for the pane's refresh to show the edits.
- Keep the live edit after the pane opens and the draft is typed, with a visible pause before resizing or switching files.
- If you change the conversation or number of files, update the tape's `Wait+Screen` patterns. They check that startup and pane loading completed.
- Keep filenames and code short enough to read at README size. Increasing the font size can hide the pane by reducing the available terminal columns.

## Check before committing

Watch the full MP4 and at least one GIF loop. Confirm:

- The first frame has no pane, and typing `/diff` is visible.
- The initial diff appears before the later edit. The new `"friend"` fallback appears without submitting the draft.
- Resizing, file switching and the modal are readable, not rushed or clipped.
- There are no errors, login prompts, personal paths, credentials or unrelated extensions.
- The GIF and MP4 show the same sequence. The current GIF is under 1 MB; avoid large size increases without a visible benefit.

For a quick frame inspection:

```sh
ffmpeg -y -i "$preview/demo.mp4" -frames:v 1 "$preview/start.png"
ffmpeg -y -i "$preview/demo.mp4" \
  -vf 'fps=1/5,scale=720:-1,tile=3x2' -frames:v 1 "$preview/contact.png"
```

The first command checks the actual opening frame. The contact sheet samples the sequence but does not replace watching the video.

## Isolation

`demo.mjs` creates a temporary home, Git repository and session. It launches Pi offline with a restricted environment, disables discovered extensions and context files, and loads only pidiff. No credentials or model calls are needed. The displayed `gpt-4o` label belongs to the sample session.

The timed edits are ordinary filesystem writes observed by the real extension. They do not demonstrate model execution or turn recording. Keep the README's scripted-sample disclosure.

The temporary project is removed when Pi exits normally. Let the tape finish with `/quit`; a force-killed recording may leave its temporary directory behind. Never replace the sample session with a private session just to make the recording look more realistic.
