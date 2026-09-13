import assert from "node:assert/strict";
import { test, mock } from "node:test";
import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { mkdtemp, writeFile, mkdir, rm, symlink, readFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { homedir, tmpdir } from "node:os";
import { currentView, diffBuffers, filePatch, git, parseNumstat, safeText, snapshot, type View } from "./git.ts";
import extension from "./index.ts";
import { DiffViewer } from "./viewer.ts";
import { createEditToolDefinition, createWriteToolDefinition, initTheme, type Theme } from "@earendil-works/pi-coding-agent";
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

test("default compares index to working tree, excluding staged-only, untracked and committed changes", async () => {
  const cwd = await repo();
  try {
    await writeFile(join(cwd, "partial"), "head\n");
    await writeFile(join(cwd, "staged-only"), "head\n");
    await commit(cwd);
    await git(cwd, ["switch", "-c", "feature"]);
    await writeFile(join(cwd, "partial"), "committed\n");
    await commit(cwd);
    assert.equal((await currentView(cwd)).files.length, 0, "clean tree must not fall back to branch changes");
    const explicit = await currentView(cwd, "main");
    assert.deepEqual(explicit.files.map((file) => file.path), ["partial"]);
    assert.match(await filePatch(explicit, explicit.files[0]), /-head\n\+committed/);

    await writeFile(join(cwd, "partial"), "staged\n");
    await writeFile(join(cwd, "staged-only"), "staged\n");
    await git(cwd, ["add", "partial", "staged-only"]);
    await writeFile(join(cwd, "untracked"), "not in git diff\n");
    assert.equal((await currentView(cwd)).files.length, 0, "staged-only and untracked files are not unstaged diffs");
    // Reverting the working file to HEAD still differs from its staged contents.
    await writeFile(join(cwd, "partial"), "committed\n");
    const before = await git(cwd, ["status", "--porcelain=v1", "-z"]);
    const view = await currentView(cwd);
    assert.equal(view.label, "Current · unstaged");
    assert.deepEqual(view.files.map((file) => file.path), ["partial"]);
    assert.equal(view.files[0].added, 1);
    assert.equal(view.files[0].removed, 1);
    const patch = await filePatch(view, view.files[0]);
    assert.equal(patch, await git(cwd, ["diff", "--", "partial"]));
    assert.match(patch, /-staged\n\+committed/);
    assert.equal(await git(cwd, ["status", "--porcelain=v1", "-z"]), before);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("explicit HEAD covers staged, unstaged, deleted, binary, untracked and literal paths without changing the index", async () => {
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
    const view = await currentView(join(cwd, "sub"), "HEAD");
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

test("unborn HEAD, no branch fallback, explicit base, and non-repository errors", async () => {
  const cwd = await repo();
  const outside = await mkdtemp(join(tmpdir(), "pidiff-outside-"));
  try {
    await writeFile(join(cwd, "new"), "staged\n");
    await git(cwd, ["add", "new"]);
    await writeFile(join(cwd, "new"), "actual\n");
    const initial = await currentView(cwd);
    assert.equal(initial.files.length, 1);
    assert.match(await filePatch(initial, initial.files[0]), /-staged\n\+actual/);
    await commit(cwd);
    assert.equal((await currentView(cwd)).files.length, 0);
    await git(cwd, ["switch", "-c", "feature"]);
    await writeFile(join(cwd, "new"), "branch\n");
    await commit(cwd);
    const branch = await currentView(cwd);
    assert.equal(branch.label, "Current · unstaged");
    assert.equal(branch.files.length, 0);
    await writeFile(join(cwd, "new"), "uncommitted\n");
    assert.equal((await currentView(cwd)).label, "Current · unstaged");
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
    await git(cwd, ["-c", "commit.gpgsign=false", "commit", "--allow-empty", "-m", "baseline", "--no-verify"]);
    await writeFile(join(cwd, "large"), Buffer.alloc(2 * 1024 * 1024 + 1));
    await assert.rejects(snapshot(join(cwd, "large")), /2 MiB/);
    const view = await currentView(cwd, "HEAD");
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

async function recordBuiltin(cwd: string, toolName: "edit" | "write", path: string) {
  const hooks = new Map<string, Function>();
  const entries: View[] = [];
  extension({
    on: (name: string, handler: Function) => hooks.set(name, handler),
    appendEntry: (_name: string, data: View) => entries.push(data),
    registerCommand() {},
  } as any);
  const input = { path, content: "after\n", edits: [{ oldText: "before", newText: "after" }] };
  const event = { toolName, toolCallId: "mutation", input, isError: false };
  await hooks.get("agent_start")!();
  await hooks.get("tool_call")!(event, { cwd });
  const tool = toolName === "edit" ? createEditToolDefinition(cwd) : createWriteToolDefinition(cwd);
  await tool.execute(event.toolCallId, input, undefined, undefined, { cwd } as any);
  await hooks.get("tool_result")!(event);
  await hooks.get("agent_end")!({}, { cwd });
  return entries;
}

for (const tool of ["edit", "write"] as const) {
  test(`turn snapshots follow symlinks for built-in ${tool}, Current keeps link text`, async () => {
    const cwd = await repo();
    try {
      await writeFile(join(cwd, "target"), "before\n");
      await symlink("target", join(cwd, "link"));
      const entries = await recordBuiltin(cwd, tool, "link");
      assert.equal(await readFile(join(cwd, "target"), "utf8"), "after\n");
      assert.equal(entries.length, 1);
      assert.equal(entries[0].files[0].path, "link");
      assert.match(entries[0].files[0].patch!, /-before\n\+after/);
      assert.equal((await snapshot(join(cwd, "link")))!.toString(), "target");
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
}

for (const tool of ["edit", "write"] as const) {
  test(`turn paths match built-in ${tool} normalization`, async () => {
    const cwd = await repo();
    const target = join(cwd, "space target");
    try {
      const paths = [
        ...["\u00a0", "\u202f", "\u2000", "\u200a", "\u205f", "\u3000"].map((space) => `space${space}target`),
        "@space target", target, pathToFileURL(target).href, `@${pathToFileURL(target).href}`,
        `~/${relative(homedir(), target)}`,
      ];
      for (const path of paths) {
        await writeFile(target, "before\n");
        const entries = await recordBuiltin(cwd, tool, path);
        assert.equal(await readFile(target, "utf8"), "after\n", path);
        assert.equal(entries.length, 1, path);
        assert.equal(entries[0].files[0].path, "space target", path);
        assert.match(entries[0].files[0].patch!, /-before\n\+after/, path);
      }
    } finally { await rm(cwd, { recursive: true, force: true }); }
  });
}

test("currentView lists unmerged paths once with unsupported-conflict notices", async () => {
  const cwd = await repo();
  try {
    for (const path of ["conflict\t中", "deleted"]) await writeFile(join(cwd, path), "base\n");
    await commit(cwd);
    await git(cwd, ["switch", "-c", "other"]);
    await writeFile(join(cwd, "conflict\t中"), "other\n");
    await rm(join(cwd, "deleted"));
    await commit(cwd);
    await git(cwd, ["switch", "main"]);
    for (const path of ["conflict\t中", "deleted"]) await writeFile(join(cwd, path), "main\n");
    await commit(cwd);
    await assert.rejects(git(cwd, ["-c", "commit.gpgsign=false", "merge", "other"]));
    const before = await git(cwd, ["status", "--porcelain=v1", "-z"]);
    for (const base of [undefined, "HEAD"]) {
      const view = await currentView(cwd, base);
      assert.deepEqual(view.files.map((file) => file.path).sort(), ["conflict\t中", "deleted"]);
      for (const file of view.files) {
        const patch = await filePatch(view, file);
        assert.match(patch, /conflict.*unsupported/i);
        assert.doesNotMatch(patch, /diff --cc|@@@/);
      }
    }
    assert.equal(await git(cwd, ["status", "--porcelain=v1", "-z"]), before);
  } finally { await rm(cwd, { recursive: true, force: true }); }
});

test("viewer pages the list with configured keys and clamps at both bounds", () => {
  const theme = { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text, bold: (text: string) => text } as Theme;
  const tui = { terminal: { rows: 24 }, requestRender() {} } as TUI;
  for (const configured of [false, true]) {
    const kb = new KeybindingsManager(TUI_KEYBINDINGS, configured ? { "tui.select.pageUp": "u", "tui.select.pageDown": "d" } : {});
    const down = configured ? "d" : "\x1b[6~", up = configured ? "u" : "\x1b[5~";
    for (const count of [0, 1, 30]) {
      const view: View = { label: "Current", files: Array.from({ length: count }, (_, i) => ({ path: `file-${i}`, added: 0, removed: 0 })) };
      const viewer = new DiffViewer(tui, theme, kb, () => {}, [view], async () => view);
      viewer.render(80);
      viewer.handleInput(down);
      assert.equal(Reflect.get(viewer, "selected"), Math.min(12, Math.max(0, count - 1)));
      if (count > 1) assert.match(viewer.render(80).join("\n"), /→ .*file-12/);
      for (let i = 0; i < 5; i++) viewer.handleInput(down);
      assert.equal(Reflect.get(viewer, "selected"), Math.max(0, count - 1));
      for (let i = 0; i < 5; i++) viewer.handleInput(up);
      assert.equal(Reflect.get(viewer, "selected"), 0);
      viewer.dispose();
    }
  }
});

// Hold Git at the process boundary so cancellation and late completions need no sleeps.
test("viewer aborts open/reload work on back, close, tab switch, replacement and dispose", async () => {
  const theme = { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text, bold: (text: string) => text } as Theme;
  const kb = new KeybindingsManager(TUI_KEYBINDINGS);
  const current: View = { label: "Current", root: tmpdir(), files: [{ path: "file", added: 0, removed: 0 }] };
  let gitSignal: AbortSignal | undefined;
  let finishGit: (error: Error | null, stdout: string, stderr: string) => void;
  const exec = mock.method(childProcess, "execFile", ((_cmd: string, _args: string[], options: { signal?: AbortSignal }, callback: typeof finishGit) => {
    gitSignal = options.signal;
    finishGit = callback;
    return { stdin: { end() {} } };
  }) as any);
  syncBuiltinESMExports();
  try {
    for (const work of ["openFile", "reload"]) for (const action of ["back", "close", "tab", "replace", "dispose"]) for (const fail of [false, true]) {
      let renders = 0;
      let reloadSignal: AbortSignal | undefined;
      let finishReload: (view: View) => void;
      let rejectReload: (error: Error) => void;
      const viewer = new DiffViewer({ terminal: { rows: 24 }, requestRender() { renders++; } } as TUI, theme, kb, () => {}, [current, { label: "Turn", files: [] }], (signal?: AbortSignal) => {
        reloadSignal = signal;
        return new Promise<View>((resolve, reject) => { finishReload = resolve; rejectReload = reject; });
      });
      viewer.render(80);
      if (work === "reload" && action === "back") Reflect.set(viewer, "opened", true);
      const pending = Reflect.get(viewer, work).call(viewer) as Promise<void>;
      const signal = work === "openFile" ? gitSignal : reloadSignal;
      const completeGit = finishGit!, completeReload = finishReload!, failReload = rejectReload!;
      const settle = work === "openFile" ? () => completeGit(fail ? new Error("STALE") : null, "STALE", "")
        : fail ? () => failReload(new Error("STALE")) : () => completeReload({ label: "STALE", files: [] });
      assert.ok(signal, `${work} must receive a signal`);
      assert.equal(signal.aborted, false);
      // Capture completion before a replacement installs its own callback.
      let replacement: Promise<void> | undefined;
      if (action === "dispose") viewer.dispose();
      else if (action === "replace") replacement = Reflect.get(viewer, work).call(viewer);
      else {
        viewer.handleInput(action === "tab" ? "\x1b[C" : "\x1b");
        if (action === "close" && work === "openFile") viewer.handleInput("\x1b");
      }
      assert.equal(signal.aborted, true, `${work}/${action}`);
      const before = viewer.render(80).join("\n"), count = renders;
      settle();
      await pending;
      assert.equal(viewer.render(80).join("\n"), before, `${work}/${action}: stale state`);
      assert.equal(renders, count, `${work}/${action}: stale render`);
      viewer.dispose();
      if (replacement) {
        if (work === "openFile") finishGit!(null, "", "");
        else finishReload!(current);
        await replacement;
      }
    }
  } finally { exec.mock.restore(); syncBuiltinESMExports(); }
});

test("initial modal loading aborts on disposal without late notifications or completion", async () => {
  initTheme("dark");
  let command: Function;
  extension({ on() {}, registerCommand(_name: string, definition: { handler: Function }) { command = definition.handler; } } as any);
  let signal: AbortSignal | undefined;
  let finish: (error: Error, stdout: string, stderr: string) => void;
  const exec = mock.method(childProcess, "execFile", ((_cmd: string, _args: string[], options: { signal?: AbortSignal }, callback: typeof finish) => {
    signal = options.signal;
    finish = callback;
    return { stdin: { end() {} } };
  }) as any);
  syncBuiltinESMExports();
  let completed = 0, notified = 0;
  const theme = { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text, bold: (text: string) => text } as Theme;
  try {
    await command!("view", {
      cwd: tmpdir(), mode: "tui", hasUI: true,
      ui: {
        notify() { notified++; },
        async custom(factory: Function) {
          const loader = factory({ requestRender() {} }, theme, new KeybindingsManager(TUI_KEYBINDINGS), () => { completed++; });
          loader.dispose(); // Host replacement/teardown, not keyboard cancellation.
          assert.equal(signal?.aborted, true);
          finish!(new Error("late failure"), "", "");
          await new Promise((resolve) => setImmediate(resolve));
          return undefined;
        },
      },
    });
    assert.equal(completed, 0);
    assert.equal(notified, 0);
  } finally { exec.mock.restore(); syncBuiltinESMExports(); }
});
