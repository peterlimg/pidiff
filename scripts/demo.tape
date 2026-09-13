# Recorded with VHS 0.11.0 and Pi 0.85.1. Requires ttyd, ffmpeg, and npm install.
# Run from the repo root: vhs scripts/demo.tape
Output assets/demo.gif
Output assets/demo.mp4

Set Shell "bash"
Set Width 1440
Set Height 520
Set FontFamily "Menlo"
Set FontSize 18
Set Padding 20
Set Theme "Catppuccin Mocha"
Set WindowBar Colorful
Set BorderRadius 8
Set Margin 12
Set MarginFill "#11111b"
Set Framerate 12
Set TypingSpeed 80ms
Set CursorBlink false
Set PlaybackSpeed 1

Hide
Type "node scripts/demo.mjs"
Enter
Wait+Screen /Trimmed names/
Sleep 1s
Show
Sleep 2s
Type "/diff"
Enter
Wait+Screen /2 files changed/
Sleep 3s
Type "Also test a blank name."
Sleep 6s
Ctrl+Alt+Shift+Right
Ctrl+Alt+Shift+Right
Ctrl+Alt+Shift+Right
Sleep 2s
Ctrl+Alt+Right
Sleep 3s
Ctrl+C
Type "/diff view"
Enter
Sleep 2s
Enter
Sleep 4s
Escape
Escape
Sleep 1s
Type "/diff"
Enter
Sleep 2s
Hide
Type "/quit"
Enter
Sleep 1s
