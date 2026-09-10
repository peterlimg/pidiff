import assert from "node:assert/strict";
import { test } from "node:test";
import { stripVTControlCharacters } from "node:util";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { theme } from "./node_modules/@earendil-works/pi-coding-agent/dist/modes/interactive/theme/theme.js";
import { renderDiff } from "./diff.ts";

const plain = (lines: string[]) => lines.map((line) => stripVTControlCharacters(line).trimEnd());

test("diff hides transport headers, numbers both sides and separates hunks without losing notices", () => {
  initTheme("dark");
  const patch = "diff --git a/file b/file\nindex 123..456 100644\n--- a/file\n+++ b/file\n@@ -10,3 +20,4 @@ function\n keep\n-old\n+new\n+++literal\n tail\n@@ -50 +60 @@\n-gone\n\\ No newline at end of file\n+here\n";
  assert.deepEqual(plain(renderDiff(patch, "file.txt", 40, theme)), [
    " 20   keep", " 11 - old", " 21 + new", " 22 + ++literal", " 23   tail", "···", " 50 - gone", "\\ No newline at end of file", " 60 + here",
  ]);
  for (const notice of ["Binary files a/file and b/file differ", "New empty file", "Deleted empty file", "old mode 100644\nnew mode 100755", "Preview unavailable: too large", "[Preview truncated]"]) {
    assert.equal(plain(renderDiff(notice, "file", 80, theme)).join("\n"), notice);
  }
  assert.deepEqual(plain(renderDiff("@@ -0,0 +1 @@\n+new\n", "file", 40, theme)), ["  1 + new"]);
  assert.deepEqual(plain(renderDiff("@@ -1 +0,0 @@\n-old\n", "file", 40, theme)), ["  1 - old"]);
});

test("syntax and full-width change backgrounds follow dark and light themes", () => {
  for (const mode of ["dark", "light"]) {
    initTheme(mode);
    const lines = renderDiff("@@ -1 +1 @@\n-/* removed comment\n+const value = 42;\n", "file.ts", 44, theme);
    assert.ok(lines[0].startsWith(theme.getBgAnsi("toolErrorBg")));
    assert.ok(lines[1].startsWith(theme.getBgAnsi("toolSuccessBg")));
    assert.ok(lines[1].includes(theme.getFgAnsi("syntaxKeyword")), "deleted comment must not swallow added syntax");
    assert.ok(lines.every((line) => visibleWidth(line) === 44 && line.endsWith("\x1b[49m")));
    const multiline = renderDiff("@@ -0,0 +1,3 @@\n+/* first\n+still a comment\n+*/\n", "file.ts", 44, theme);
    assert.ok(multiline[1].includes(theme.getFgAnsi("syntaxComment")), "syntax state survives line boundaries");
  }
});

test("wrapped code keeps the gutter, escapes terminal controls, and respects narrow Unicode widths", () => {
  initTheme("dark");
  const patch = "@@ -0,0 +123,2 @@\n+long_identifier_that_wraps\n+中🙂\t\x1b[2J\r\n";
  const wrapped = plain(renderDiff(patch, "file.txt", 18, theme));
  assert.match(wrapped[0], /^ 123 \+ /);
  assert.ok(wrapped[1].startsWith("       "), "continuations leave the number gutter blank");
  assert.equal(wrapped.filter((line) => /^ 123 \+ /.test(line)).length, 1);
  assert.match(plain(renderDiff(patch, "file.txt", 80, theme)).join("\n"), /\\x1b\[2J\\x0d/);
  for (const width of [1, 2, 7, 10, 18, 80]) {
    const lines = renderDiff(patch, "file.txt", width, theme);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    assert.ok(lines.every((line) => !line.includes("\x1b[2J")));
  }
});
