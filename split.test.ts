import assert from "node:assert/strict";
import { test } from "node:test";
import { HStack, ScrollView, Text, VStack, TuiAltScreen, type Terminal } from "@earendil-works/pi-tui";
import { mountSplit } from "./split.ts";
import { openPanel } from "./panel.ts";
import { git } from "./git.ts";
import { mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Theme } from "@earendil-works/pi-coding-agent";

// Exercise Pi's actual layout allocator, not a string mock of a side-by-side screen.
import { renderLayoutFrame } from "./node_modules/@earendil-works/pi-tui/dist/layout.js";

function terminalHarness(columns = 160, rows = 30) {
  let input: (data: string) => void = () => {};
  const terminal: Terminal = {
    columns, rows, kittyProtocolActive: false,
    start(onInput) { input = onInput; }, stop() {}, async drainInput() {},
    write() {}, moveBy() {}, hideCursor() {}, showCursor() {}, clearLine() {},
    clearFromCursor() {}, clearScreen() {}, setTitle() {}, setProgress() {},
  };
  return { terminal, input: (data: string) => input(data) };
}

test("split reserves separate chat/diff columns, preserves the prompt and restores the original layout", () => {
  const terminal = { columns: 140, rows: 30 } as Terminal;
  const tui = new TuiAltScreen(terminal);
  const transcript = new ScrollView(new Text("conversation ".repeat(100), 0, 0), { primary: true });
  const prompt = new Text("type here", 0, 0);
  const original = new VStack([{ component: transcript, grow: 1, basis: 0 }, prompt]);
  tui.setLayoutRoot(original);
  const panel = new ScrollView(new Text("DIFF\n+new line\n-old line", 0, 0));
  const close = mountSplit(tui, panel);
  const root = Reflect.get(tui, "layoutRoot");
  assert.ok(root instanceof HStack);
  const frame = renderLayoutFrame(root, 140, 30, () => {});
  assert.equal(frame.primaryScrollView, transcript);
  const chatBox = frame.root.children[0];
  const diffBox = frame.root.children.at(-1)!;
  assert.ok(chatBox.rect.width >= 40);
  assert.ok(diffBox.rect.width > chatBox.rect.width, "diff should be wider than chat by default");
  assert.ok(chatBox.rect.x + chatBox.rect.width <= diffBox.rect.x);
  assert.ok(frame.lines.some((line) => line.includes("DIFF")));
  assert.ok(frame.lines.some((line) => line.includes("type here")));
  const narrow = renderLayoutFrame(root, 80, 30, () => {});
  assert.equal(narrow.root.children.length, 1);
  assert.equal(narrow.root.children[0].rect.width, 80);
  close();
  close();
  assert.equal(Reflect.get(tui, "layoutRoot"), original);
});

test("wheel input anywhere in the diff pane never scrolls the chat", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pidiff-wheel-test-"));
  const harness = terminalHarness();
  const tui = new TuiAltScreen(harness.terminal);
  const transcript = new ScrollView(new Text(Array.from({ length: 100 }, (_, i) => `chat ${i}`).join("\n"), 0, 0), { primary: true });
  tui.setLayoutRoot(new VStack([{ component: transcript, basis: 0, grow: 1 }, new Text("prompt", 0, 0)]));
  const theme = { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text, bold: (text: string) => text } as Theme;
  let panel: ReturnType<typeof openPanel> | undefined;
  try {
    await git(cwd, ["init", "-b", "main"]);
    panel = openPanel(tui, theme, cwd, undefined, () => panel?.dispose());
    await panel.refresh();
    tui.start();
    tui.renderNow();
    transcript.scrollTo(30);
    tui.renderNow();
    for (const button of [64, 65]) {
      for (const [name, y] of [["empty body", 10], ["header", 1], ["footer", 30]] as const) {
        harness.input(`\x1b[<${button};150;${y}M`);
        tui.renderNow();
        assert.equal(transcript.scrollTop, 30, `wheel ${button} over diff ${name} scrolled chat`);
      }
    }
    await writeFile(join(cwd, "long.txt"), Array.from({ length: 100 }, (_, i) => `diff ${i}`).join("\n"));
    await git(cwd, ["add", "-N", "--", "long.txt"]);
    await panel.refresh();
    tui.renderNow();
    const diffScroll = panel.component.children.filter((child) => child instanceof ScrollView).at(-1)!;
    harness.input("\x1b[<65;150;10M");
    assert.ok(diffScroll.scrollTop > 0, "wheel should scroll the diff");
    assert.equal(transcript.scrollTop, 30);
    for (const boundary of ["top", "bottom"]) {
      if (boundary === "top") diffScroll.scrollToStart();
      else diffScroll.scrollToEnd();
      tui.renderNow();
      harness.input(`\x1b[<${boundary === "top" ? 64 : 65};150;10M`);
      assert.equal(transcript.scrollTop, 30, `diff ${boundary} boundary scrolled chat`);
    }
    harness.input("\x1b[<64;10;10M");
    assert.equal(transcript.scrollTop, 29, "chat must still scroll over its own column");
  } finally {
    panel?.dispose();
    tui.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("many files never push the selected patch out of view", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pidiff-many-files-"));
  const harness = terminalHarness();
  const tui = new TuiAltScreen(harness.terminal);
  const prompt = new Text("draft", 0, 0);
  const transcript = new ScrollView(new Text(Array.from({ length: 100 }, (_, i) => `chat ${i}`).join("\n"), 0, 0), { primary: true });
  tui.setLayoutRoot(new VStack([{ component: transcript, basis: 0, grow: 1 }, prompt]));
  tui.setFocus(prompt);
  const theme = { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text, bold: (text: string) => text } as Theme;
  let panel: ReturnType<typeof openPanel> | undefined;
  try {
    await git(cwd, ["init", "-b", "main"]);
    await Promise.all(Array.from({ length: 48 }, (_, i) => writeFile(join(cwd, `${String(i).padStart(2, "0")}.txt`), Array.from({ length: 80 }, (_, line) => `code-${i}-${line}`).join("\n"))));
    await git(cwd, ["add", "-N", "--", "."]);
    panel = openPanel(tui, theme, cwd, undefined, () => panel?.dispose());
    await panel.refresh();
    tui.start();
    tui.renderNow();
    const frame = () => renderLayoutFrame(Reflect.get(tui, "layoutRoot"), harness.terminal.columns, harness.terminal.rows, () => {});
    assert.match(frame().lines.join("\n"), /code-0-0/, "file list pushed the actual patch off-screen");
    const [fileScroll, codeScroll] = panel.component.children.filter((child) => child instanceof ScrollView);
    assert.ok(fileScroll.viewportHeight <= 6);
    assert.ok(codeScroll.viewportHeight > fileScroll.viewportHeight);
    const box = (scroll: ScrollView) => frame().root.children.at(-1)!.children.find((child) => child.component === scroll)!;
    function wheel(scroll: ScrollView, button: number) {
      const { x, y } = box(scroll).rect;
      harness.input(`\x1b[<${button};${x + 3};${y + 1}M`);
      tui.renderNow();
    }
    transcript.scrollTo(30);
    tui.renderNow();
    wheel(codeScroll, 65);
    assert.ok(codeScroll.scrollTop > 0);
    assert.equal(fileScroll.scrollTop, 0);
    const codeTop = codeScroll.scrollTop;
    wheel(fileScroll, 65);
    assert.ok(fileScroll.scrollTop > 0);
    assert.equal(codeScroll.scrollTop, codeTop);
    const listTop = fileScroll.scrollTop;
    await panel.refresh();
    tui.renderNow();
    assert.equal(fileScroll.scrollTop, listTop, "polling must not pull the list back to the selected file");
    for (const boundary of ["top", "bottom"]) {
      if (boundary === "top") fileScroll.scrollToStart();
      else fileScroll.scrollToEnd();
      tui.renderNow();
      const codeTop = codeScroll.scrollTop;
      wheel(fileScroll, boundary === "top" ? 64 : 65);
      assert.equal(codeScroll.scrollTop, codeTop, "file-list wheel leaked into the code");
      assert.equal(transcript.scrollTop, 30);
    }
    // Click the first visible row after scrolling the list, not file zero.
    const index = fileScroll.scrollTop;
    const { x, y } = box(fileScroll).rect;
    harness.input(`\x1b[<0;${x + 3};${y + 1}M`);
    harness.input(`\x1b[<0;${x + 3};${y + 1}m`);
    await panel.refresh();
    tui.renderNow();
    assert.match(frame().lines.join("\n"), new RegExp(`code-${index}-0`));
    assert.equal(codeScroll.scrollTop, 0);
    assert.equal(tui.getFocusedComponent(), prompt);
    // Keyboard navigation keeps the selected file visible in the short list.
    fileScroll.scrollToStart();
    harness.input("\x1b[1;7C"); // Ctrl+Alt+Right
    await panel.refresh();
    tui.renderNow();
    assert.match(frame().lines.join("\n"), new RegExp(`› ${String(index + 1).padStart(2, "0")}\\.txt`));
    assert.match(frame().lines.join("\n"), new RegExp(`code-${index + 1}-0`));
    assert.equal(tui.getFocusedComponent(), prompt);
    for (const rows of [12, 60, 30]) {
      Object.assign(harness.terminal, { rows });
      tui.renderNow();
      assert.ok(fileScroll.viewportHeight <= 6);
      assert.ok(codeScroll.viewportHeight > 0);
      assert.match(frame().lines.join("\n"), new RegExp(`code-${index + 1}-0`));
    }
  } finally {
    panel?.dispose();
    tui.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("scrolling past code boundaries selects adjacent files without skipping, wrapping or scrolling chat", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pidiff-file-scroll-"));
  const harness = terminalHarness();
  const tui = new TuiAltScreen(harness.terminal);
  const prompt = new Text("draft", 0, 0);
  const transcript = new ScrollView(new Text(Array.from({ length: 100 }, (_, i) => `chat ${i}`).join("\n"), 0, 0), { primary: true });
  tui.setLayoutRoot(new VStack([{ component: transcript, basis: 0, grow: 1 }, prompt]));
  tui.setFocus(prompt);
  const theme = { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text, bold: (text: string) => text } as Theme;
  let panel: ReturnType<typeof openPanel> | undefined;
  try {
    await git(cwd, ["init", "-b", "main"]);
    for (const [name, count] of [["00", 80], ["01", 1], ["02", 120]] as const) {
      await writeFile(join(cwd, `${name}.txt`), Array.from({ length: count }, (_, i) => `file${name}-line${i}`).join("\n"));
    }
    await git(cwd, ["add", "-N", "--", "."]);
    panel = openPanel(tui, theme, cwd, undefined, () => panel?.dispose());
    await panel.refresh();
    tui.start();
    tui.renderNow();
    transcript.scrollTo(30);
    tui.renderNow();
    const codeScroll = panel.component.children.filter((child) => child instanceof ScrollView).at(-1)!;
    const frame = () => renderLayoutFrame(Reflect.get(tui, "layoutRoot"), 160, 30, () => {});
    function wheel(button: number) {
      const { x, y } = frame().root.children.at(-1)!.children.find((child) => child.component === codeScroll)!.rect;
      harness.input(`\x1b[<${button};${x + 3};${y + 1}M`);
      tui.renderNow();
    }
    function selected(name: string, line: number) {
      const text = frame().lines.join("\n");
      assert.match(text, new RegExp(`› ${name}\\.txt`));
      assert.match(text, new RegExp(`file${name}-line${line}(?![0-9])`));
      assert.equal(transcript.scrollTop, 30, "file navigation scrolled chat");
      assert.equal(tui.getFocusedComponent(), prompt);
      assert.match(text, /draft/);
    }
    wheel(64); // First file's top does not wrap.
    await panel.refresh();
    selected("00", 0);
    wheel(65);
    assert.ok(codeScroll.scrollTop > 0, "scroll within a file before changing selection");
    codeScroll.scrollToEnd();
    codeScroll.scrollBy(-1);
    tui.renderNow();
    wheel(65);
    selected("00", 79); // Reaching the edge must not skip the last visible lines.
    wheel(65);
    wheel(65); // Extra input during loading must not skip the short middle file.
    await panel.refresh();
    selected("01", 0);
    assert.equal(codeScroll.scrollTop, 0);
    wheel(65); // A file shorter than the viewport still advances.
    await panel.refresh();
    selected("02", 0);
    assert.equal(codeScroll.scrollTop, 0);
    codeScroll.scrollToEnd();
    tui.renderNow();
    wheel(65); // Last file's bottom does not wrap.
    await panel.refresh();
    selected("02", 119);
    codeScroll.scrollToStart();
    tui.renderNow();
    harness.input("\x1b[1;7A"); // Ctrl+Alt+Up uses the same boundary navigation.
    await panel.refresh();
    selected("01", 0);
    wheel(64);
    await panel.refresh();
    selected("00", 79); // Land after layout measures the newly loaded, longer patch.
    const bottom = codeScroll.scrollTop;
    assert.ok(bottom > 0);
    harness.input("\x1b[1;7A");
    assert.equal(codeScroll.scrollTop, bottom - 3);
    await panel.refresh();
    assert.equal(codeScroll.scrollTop, bottom - 3, "polling must not pin the previous file to its bottom");
    selected("00", 76);
  } finally {
    panel?.dispose();
    tui.stop();
    await rm(cwd, { recursive: true, force: true });
  }
});

test("divider drag resizes the panes without moving focus, clamps widths, and survives terminal resize", () => {
  const harness = terminalHarness();
  const tui = new TuiAltScreen(harness.terminal);
  const prompt = new Text("draft", 0, 0);
  const original = new VStack([new Text("chat"), prompt]);
  tui.setLayoutRoot(original);
  tui.setFocus(prompt);
  const close = mountSplit(tui, new Text("diff", 0, 0));
  const root = Reflect.get(tui, "layoutRoot");
  const frame = () => renderLayoutFrame(root, harness.terminal.columns, harness.terminal.rows, () => {});
  try {
    tui.start();
    tui.renderNow();
    assert.equal(frame().root.children.length, 3, "split needs a draggable divider");
    function drag(x: number) {
      const divider = frame().root.children[1];
      harness.input(`\x1b[<0;${divider.rect.x + 1};10M`);
      harness.input(`\x1b[<32;${x + 1};10M`);
      tui.renderNow();
      harness.input(`\x1b[<0;${x + 1};10m`);
      tui.renderNow();
    }
    drag(45);
    assert.equal(frame().root.children[0].rect.width, 45);
    assert.equal(frame().root.children[2].rect.width, 114);
    drag(105);
    assert.equal(frame().root.children[2].rect.width, 54);
    drag(0);
    assert.equal(frame().root.children[0].rect.width, 40);
    drag(159);
    assert.equal(frame().root.children[2].rect.width, 44);
    drag(59);
    assert.equal(frame().root.children[2].rect.width, 100);
    Object.assign(harness.terminal, { columns: 110 });
    tui.renderNow();
    assert.equal(frame().root.children[0].rect.width, 40);
    assert.equal(frame().root.children[2].rect.width, 69);
    Object.assign(harness.terminal, { columns: 160 });
    tui.renderNow();
    assert.equal(frame().root.children[2].rect.width, 100);
    harness.input("\x1b[1;8D"); // Ctrl+Alt+Shift+Left
    tui.renderNow();
    assert.equal(frame().root.children[2].rect.width, 104);
    harness.input("\x1b[1;8C");
    tui.renderNow();
    assert.equal(frame().root.children[2].rect.width, 100);
    assert.equal(tui.getFocusedComponent(), prompt);
    assert.equal(Reflect.get(tui, "layoutRoot"), root);
  } finally { close(); tui.stop(); }
  assert.equal(Reflect.get(tui, "layoutRoot"), original);
});

test("split fails safely without fullscreen or a readable layout, and never overwrites a newer owner's layout", () => {
  assert.throws(() => mountSplit({ mode: "regular" } as any, new Text("diff")), /fullscreen/i);
  const tui = new TuiAltScreen({ columns: 140, rows: 30 } as Terminal);
  assert.throws(() => mountSplit(tui, new Text("diff")), /layout/i);
  tui.setLayoutRoot(new VStack([new Text("chat")]));
  const close = mountSplit(tui, new Text("diff"));
  const replacement = new VStack([new Text("another extension")]);
  tui.setLayoutRoot(replacement);
  close();
  assert.equal(Reflect.get(tui, "layoutRoot"), replacement);
});


test("live panel reloads patches without taking focus and disposes in-flight work", async () => {
  const cwd = await mkdtemp(join(tmpdir(), "pidiff-panel-test-"));
  const terminal = { columns: 140, rows: 30 } as Terminal;
  const tui = new TuiAltScreen(terminal);
  const prompt = new Text("draft still here", 0, 0);
  const original = new VStack([new Text("conversation"), prompt]);
  tui.setLayoutRoot(original);
  tui.setFocus(prompt);
  const theme = { fg: (_: string, text: string) => text, bg: (_: string, text: string) => text, bold: (text: string) => text } as Theme;
  let panel: ReturnType<typeof openPanel> | undefined;
  try {
    await git(cwd, ["init", "-b", "main"]);
    await writeFile(join(cwd, "file.txt"), "first version\n");
    await git(cwd, ["add", "-N", "--", "file.txt"]);
    panel = openPanel(tui, theme, cwd, undefined, () => panel?.dispose());
    await panel.refresh();
    const render = () => renderLayoutFrame(Reflect.get(tui, "layoutRoot"), 140, 30, () => {}).lines.join("\n");
    assert.match(render(), /1 \+ first version/);
    assert.match(render(), /draft still here/);
    assert.equal(tui.getFocusedComponent(), prompt);
    await writeFile(join(cwd, "file.txt"), "second version\n");
    await panel.refresh();
    assert.match(render(), /1 \+ second version/);
    assert.doesNotMatch(render(), /1 \+ first version/);
    const refresh = panel.refresh();
    panel.dispose();
    await refresh;
    assert.equal(Reflect.get(tui, "layoutRoot"), original);
    assert.equal(tui.getFocusedComponent(), prompt);
    panel.dispose();
  } finally {
    panel?.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
});
