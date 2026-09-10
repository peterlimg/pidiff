import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtemp, writeFile, mkdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { currentView, diffBuffers, filePatch, git, parseNumstat, safeText, snapshot, type View } from "./git.ts";
import extension from "./index.ts";
import { DiffViewer } from "./viewer.ts";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, KeybindingsManager, TUI_KEYBINDINGS, type TUI } from "@earendil-works/pi-tui";

async function repo() {
  const cwd = await mkdtemp(join(tmpdir(), "pidiff-test-"));
  await git(cwd, ["init", "-b", "main"]);
  await git(cwd, ["config", "user.email", "test@example.com"]);
  await git(cwd, ["config", "user.name", "Test"]);
  return cwd;
}

async function commit(cwd: string) {
  await git(cwd, ["add", "-A"]);
  await git(cwd, ["-c", "commit.gpgsign=false", "commit", "-m", "fixture", "--no-verify"]);
}

test("Current covers staged, unstaged, deleted, binary, untracked and literal paths without changing the index", async () => {
  const cwd = await repo();
  try {
    for (const path of ["staged", "unstaged", "deleted", ":(glob)*", "line\nbreak\t中"]) await writeFile(join(cwd, path), "old\n");
    await writeFile(join(cwd, "binary"), Buffer.from([0, 1]));
    await writeFile(join(cwd, ".gitignore"), "ignored\n");
    await commit(cwd);
    await writeFile(join(cwd, "staged"), "stage\n");
    await git(cwd, ["add", "staged"]);
    for (const path of ["unstaged", ":(glob)*", "line\nbreak\t中"]) await writeFile(join(cwd, path), "new\n");
    await rm(join(cwd, "deleted"));
    await writeFile(join(cwd, "binary"), Buffer.from([0, 2]));
    await writeFile(join(cwd, "new"), "hello\nworld");
    await writeFile(join(cwd, "empty"), "");
    await writeFile(join(cwd, "ignored"), "not shown");
    await symlink("does-not-exist", join(cwd, "link"));
    await mkdir(join(cwd, "sub"));
    const before = await git(cwd, ["status", "--porcelain=v1", "-z"]);
    const view = await currentView(join(cwd, "sub"));
    assert.equal(view.files.length, 9);
    for (const path of ["staged", "unstaged", ":(glob)*", "line\nbreak\t中"]) {
      const file = view.files.find((file) => file.path === path)!;
      assert.equal(file.added, 1);
      assert.equal(file.removed, 1);
      const patch = await filePatch(view, file);
      assert.match(patch, /-old/);
      assert.equal((patch.match(/^diff --git /gm) ?? []).length, 1);
    }
    assert.equal(view.files.find((file) => file.path === "binary")?.binary, true);
    assert.equal(view.files.find((file) => file.path === "new")?.added, 2);
    assert.equal(view.files.find((file) => file.path === "deleted")?.removed, 1);
    assert.match(await filePatch(view, view.files.find((file) => file.path === "empty")!), /New empty file/);
    assert.match(await filePatch(view, view.files.find((file) => file.path === "link")!), /\+does-not-exist/);
    assert.equal(await git(cwd, ["status", "--porcelain=v1", "-z"]), before);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("unborn HEAD, branch fallback, explicit base, and non-repository errors", async () => {
  const cwd = await repo();
  const outside = await mkdtemp(join(tmpdir(), "pidiff-outside-"));
  try {
    await writeFile(join(cwd, "new"), "staged\n");
    await git(cwd, ["add", "new"]);
    await writeFile(join(cwd, "new"), "actual\n");
    const initial = await currentView(cwd);
    assert.equal(initial.files.length, 1);
    assert.match(await filePatch(initial, initial.files[0]), /\+actual/);
    await commit(cwd);
    assert.equal((await currentView(cwd)).files.length, 0);
    await git(cwd, ["switch", "-c", "feature"]);
    await writeFile(join(cwd, "new"), "branch\n");
    await commit(cwd);
    const branch = await currentView(cwd);
    assert.match(branch.label, /since main/);
    assert.equal(branch.files.length, 1);
    await writeFile(join(cwd, "new"), "uncommitted\n");
    assert.match((await currentView(cwd)).label, /uncommitted/);
    const explicit = await currentView(cwd, "main");
    assert.match(await filePatch(explicit, explicit.files[0]), /-actual/);
    await assert.rejects(currentView(cwd, "--output=oops"), /Cannot resolve base/);
    await assert.rejects(currentView(outside), /not a git repository/);
    await assert.rejects(currentView(cwd, undefined, AbortSignal.abort()), /abort/i);
  } finally {
    await rm(cwd, { recursive: true, force: true });
    await rm(outside, { recursive: true, force: true });
  }
});

test("snapshot diffs, bounded previews and terminal-safe text", async () => {
  const cwd = await repo();
  try {
    const change = await diffBuffers("file", Buffer.from("++old\n"), Buffer.from("++new\n"));
    assert.equal(change.added, 1);
    assert.equal(change.removed, 1);
    assert.equal((await diffBuffers("same", Buffer.from("x"), Buffer.from("x"))).patch, "");
    assert.equal((await diffBuffers("empty", null, Buffer.alloc(0))).patch, "New empty file");
    assert.equal((await diffBuffers("empty", Buffer.alloc(0), null)).patch, "Deleted empty file");
    assert.equal((await diffBuffers("binary", null, Buffer.from([0, 1]))).binary, true);
    assert.deepEqual(parseNumstat("1\t2\todd\tname\n中\0")[0].path, "odd\tname\n中");
    assert.equal(safeText("\x1b[2J\r\n\t中"), "\\x1b[2J\\x0d\\x0a    中");
    await writeFile(join(cwd, "large"), Buffer.alloc(2 * 1024 * 1024 + 1));
    await assert.rejects(snapshot(join(cwd, "large")), /2 MiB/);
    const view = await currentView(cwd);
    assert.match(view.files[0].patch!, /Preview unavailable/);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("extension records net edits across calls, ignores failed tools, and registers /diff", async () => {
  const cwd = await repo();
  try {
    const hooks = new Map<string, Function>();
    const entries: View[] = [];
    let command = "";
    extension({
      on: (name: string, handler: Function) => hooks.set(name, handler),
      appendEntry: (_name: string, data: View) => entries.push(data),
      registerCommand: (name: string) => { command = name; },
    } as any);
    assert.equal(command, "diff");
    await hooks.get("before_agent_start")!({ prompt: "Change greeting" });
    await hooks.get("agent_start")!();
    await writeFile(join(cwd, "file"), "before\n");
    for (const [id, text, isError] of [["a", "middle\n", false], ["b", "after\n", false], ["c", "ignored", true]] as const) {
      const event = { toolName: "edit", toolCallId: id, input: { path: "file" }, isError };
      await hooks.get("tool_call")!(event, { cwd });
      if (!isError) await writeFile(join(cwd, "file"), text);
      await hooks.get("tool_result")!(event);
    }
    await hooks.get("agent_end")!({}, { cwd });
    assert.equal(entries.length, 1);
    assert.match(entries[0].files[0].patch!, /-before\n\+after/);
    assert.doesNotMatch(entries[0].files[0].patch!, /middle/);
    await hooks.get("agent_start")!();
    await hooks.get("agent_end")!({}, { cwd });
    assert.equal(entries.length, 1);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("viewer navigation, scrolling, narrow terminals, escaping, and exit", async () => {
  // Use real Pi components and keybindings, with an identity theme for assertions.
  const theme = { fg: (_color: string, text: string) => text, bg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
  const terminal = { rows: 24 };
  const tui = { terminal, requestRender() {} } as TUI;
  const kb = new KeybindingsManager(TUI_KEYBINDINGS);
  const current: View = { label: "Current", files: [{ path: "中\x1b[2J", added: 100, removed: 0, patch: "@@ -0,0 +1,100 @@\n" + Array.from({ length: 100 }, (_, i) => `+line ${i}`).join("\n") }] };
  const turn: View = { label: "Turn", files: [] };
  let closed = false;
  const viewer = new DiffViewer(tui, theme, kb, () => { closed = true; }, [current, turn], async () => current);
  assert.match(viewer.render(80).join("\n"), /Current/);
  viewer.handleInput("\x1b[C");
  assert.match(viewer.render(80).join("\n"), /Turn/);
  viewer.handleInput("\x1b[D");
  viewer.handleInput("\r");
  await new Promise((resolve) => setImmediate(resolve));
  assert.match(viewer.render(80).join("\n"), /1 \+ line 0/);
  viewer.handleInput("\x1b[6~");
  assert.match(viewer.render(80).join("\n"), /14 \+ line 13/);
  for (const width of [1, 10, 40, 80]) {
    const lines = viewer.render(width);
    assert.ok(lines.every((line) => visibleWidth(line) <= width));
    assert.ok(lines.every((line) => !line.includes("\x1b[2J")));
    assert.ok(lines.length <= terminal.rows);
  }
  viewer.handleInput("\x1b");
  assert.equal(closed, false);
  viewer.handleInput("\x1b");
  assert.equal(closed, true);
});
