import type { Theme } from "@earendil-works/pi-coding-agent";
import { ScrollView, VStack, isKeyRelease, matchesKey, truncateToWidth, visibleWidth, type Component, type TUI } from "@earendil-works/pi-tui";
import { currentView, filePatch, safeText, type View } from "./git.ts";
import { mountSplit } from "./split.ts";
import { renderDiff } from "./diff.ts";

export function openPanel(tui: TUI, theme: Theme, cwd: string, base: string | undefined, onClose: () => void, getTurns: () => View[] = () => []) {
  let view: View = { label: "Loading changes...", files: [] };
  let turn: View | undefined;
  let selected: string | undefined;
  let patch = "";
  let error = "";
  let closed = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let again = false;
  let cached: { width: number; lines: string[] } | undefined;
  let loading = true;
  let landing: "start" | "end" | undefined = "start";
  let controller = new AbortController();

  function invalidate() { cached = undefined; }
  function select(path: string, edge: "start" | "end" = "start") {
    if (selected === path) return;
    selected = path;
    loading = true;
    landing = edge;
    patch = "Loading diff...";
    invalidate();
    scroll.scrollToStart();
    revealSelection();
    tui.requestRender();
    void refresh();
  }

  function switchTurn(direction: number) {
    const views = [undefined, ...getTurns()];
    const index = Math.max(0, views.indexOf(turn));
    const next = views[(index + direction + views.length) % views.length];
    if (next === turn) return;
    turn = next;
    controller.abort();
    controller = new AbortController();
    running = undefined;
    again = false;
    view = turn ?? { label: "Loading Current...", files: [] };
    selected = undefined;
    patch = error = "";
    loading = true;
    landing = "start";
    scroll.scrollToStart();
    fileScroll.scrollToStart();
    invalidate();
    void refresh();
  }

  function scrollCode(delta: number) {
    if (loading || landing || !selected || !delta) return;
    const top = scroll.scrollTop;
    scroll.scrollBy(delta);
    if (scroll.scrollTop !== top) return;
    const index = view.files.findIndex((file) => file.path === selected);
    const file = view.files[index + Math.sign(delta)];
    if (file) select(file.path, delta < 0 ? "end" : "start");
  }

  function revealSelection() {
    const index = view.files.findIndex((file) => file.path === selected);
    if (index < 0) return;
    const height = Math.max(1, fileScroll.viewportHeight);
    if (index < fileScroll.scrollTop) fileScroll.scrollTo(index);
    else if (index >= fileScroll.scrollTop + height) fileScroll.scrollTo(index - height + 1);
  }

  const files: Component = {
    invalidate,
    render(width) {
      const lines: string[] = [];
      for (const file of view.files) {
        const counts = file.binary ? theme.fg("dim", "binary") : theme.fg("toolDiffAdded", `+${file.added}`) + theme.fg("toolDiffRemoved", ` -${file.removed}`);
        const name = truncateToWidth(`${file.path === selected ? "›" : " "} ${safeText(file.path)}`, Math.max(1, width - visibleWidth(counts) - 2));
        lines.push(theme.fg(file.path === selected ? "text" : "muted", name) + " ".repeat(Math.max(1, width - visibleWidth(name) - visibleWidth(counts) - 1)) + counts);
      }
      return lines.map((line) => truncateToWidth(line, width));
    },
    handleMouse(event) {
      const file = view.files[event.y];
      if (event.button !== "left" || !file) return;
      if (event.type === "click") select(file.path);
      if (event.type === "press" || event.type === "click") return { handled: true };
    },
  };
  const fileScroll = new ScrollView(files, { primary: false, overscroll: "contain", scrollbar: "auto" });
  const body: Component = {
    invalidate,
    render(width) {
      if (cached?.width === width) return cached.lines;
      const lines = error ? [theme.fg("error", safeText(error))] : [];
      if (selected) lines.push(...renderDiff(patch, selected, width, theme));
      else lines.push(theme.fg("muted", view.note ?? "No changes."));
      cached = { width, lines: lines.map((line) => truncateToWidth(line, width)) };
      return cached.lines;
    },
  };
  const scroll = new class extends ScrollView {
    override updateLayout(...args: Parameters<ScrollView["updateLayout"]>) {
      super.updateLayout(...args);
      // Land only after the new patch has loaded and its height is known.
      if (!loading && landing) {
        if (landing === "end") this.scrollToEnd();
        else this.scrollToStart();
        landing = undefined;
      }
    }
  }(body, { primary: false, overscroll: "contain", scrollbar: "auto" });
  const header: Component = {
    invalidate,
    render(width) {
      const added = view.files.reduce((sum, file) => sum + file.added, 0);
      const removed = view.files.reduce((sum, file) => sum + file.removed, 0);
      const title = truncateToWidth(theme.bold(`${view.files.length} ${view.files.length === 1 ? "file" : "files"} changed`) + theme.fg("toolDiffAdded", ` +${added}`) + theme.fg("toolDiffRemoved", ` -${removed}`), Math.max(1, width - 4));
      const turns = getTurns();
      const tab = turn ? turns.indexOf(turn) + 1 : 0;
      return [title + " ".repeat(Math.max(0, width - visibleWidth(title) - 3)) + " × ", truncateToWidth(theme.fg("dim", `${safeText(view.label)} [${tab + 1}/${turns.length + 1}]`), width)];
    },
    handleMouse(event) {
      if (event.y === 0 && event.x >= event.width - 3 && event.button === "left") {
        if (event.type === "click") onClose();
        if (event.type === "press" || event.type === "click") return { handled: true };
      }
    },
  };
  const component = new VStack([
    { component: header, basis: 2, shrink: 0 },
    { component: fileScroll, maxSize: 6 },
    { component: { render: (width) => [truncateToWidth(theme.bold(safeText(selected ?? "")), width)], invalidate }, basis: 1, shrink: 0 },
    { component: scroll, basis: 6, grow: 1, minSize: 1 },
    { component: { render: (width) => ["Drag │ resize · Ctrl+Alt+↑↓ code · /diff", "Alt+←→ Current/turns · Alt+↑↓ files"].map((line) => truncateToWidth(theme.fg("dim", line), width)), invalidate() {} }, basis: 2, shrink: 0 },
  ]);
  // Pi 0.85's wheel fallback can scroll the primary chat even after a
  // contained ScrollView hits its boundary. Own wheel input for the entire
  // pane, including its fixed header/footer, before that fallback runs.
  const pane: Component = component;
  pane.handleMouse = (event) => {
    if (event.type !== "wheel") return;
    const delta = event.wheelDelta ?? 0;
    if (event.y >= 2 && event.y < 2 + fileScroll.viewportHeight) fileScroll.scrollBy(delta);
    else scrollCode(delta);
    return { handled: true };
  };
  const unmount = mountSplit(tui, component);
  const mountedRoot = Reflect.get(tui, "layoutRoot");
  const removeInput = tui.addInputListener((data) => {
    if (closed || tui.terminal.columns < 110 || tui.hasOverlay() || isKeyRelease(data)) return;
    // Ghostty can encode Option+arrows as Kitty Alt+B / Alt+F.
    const previous = matchesKey(data, "alt+left") || matchesKey(data, "alt+b");
    const next = matchesKey(data, "alt+right") || matchesKey(data, "alt+f");
    if (matchesKey(data, "ctrl+alt+up")) scrollCode(-3);
    else if (matchesKey(data, "ctrl+alt+down")) scrollCode(3);
    else if (previous || next) switchTurn(previous ? -1 : 1);
    else if (matchesKey(data, "alt+up") || matchesKey(data, "alt+down")) {
      const direction = matchesKey(data, "alt+up") ? -1 : 1;
      const index = view.files.findIndex((file) => file.path === selected);
      const file = view.files[Math.max(0, Math.min(view.files.length - 1, index + direction))];
      if (file) select(file.path);
    } else return;
    tui.requestRender();
    return { consume: true };
  });

  async function update(signal: AbortSignal) {
    try {
      const next = turn ?? await currentView(cwd, base, signal);
      if (closed || signal.aborted) return;
      const file = next.files.find((file) => file.path === selected) ?? next.files[0];
      const path = file?.path;
      const changed = selected !== path;
      if (changed) { loading = true; landing = "start"; patch = ""; invalidate(); }
      selected = path;
      const fullPatch = file ? await filePatch(next, file, signal) : "";
      if (closed || signal.aborted) return;
      if (selected !== path) { again = true; return; }
      view = next;
      if (changed) { scroll.scrollToStart(); revealSelection(); }
      patch = fullPatch.length > 200_000 ? fullPatch.slice(0, 200_000) + "\n[Preview truncated at 200,000 characters. Use git diff for the full patch.]" : fullPatch;
      error = "";
      loading = false;
    } catch (cause) {
      if (closed || signal.aborted) return;
      error = `Refresh failed: ${(cause as Error).message}`;
    }
    invalidate();
    tui.requestRender();
  }

  function refresh(): Promise<void> {
    clearTimeout(timer);
    if (closed) return Promise.resolve();
    if (tui.mode !== "fullscreen" || Reflect.get(tui, "layoutRoot") !== mountedRoot) {
      onClose();
      return Promise.resolve();
    }
    if (running) { again = true; return running; }
    const signal = controller.signal;
    running = update(signal).finally(() => {
      if (signal.aborted) return;
      running = undefined;
      if (!closed) timer = setTimeout(() => void refresh(), again ? 100 : 2000);
      again = false;
    });
    return running;
  }

  void refresh();
  return {
    component,
    refresh,
    refreshSoon() {
      if (closed) return;
      clearTimeout(timer);
      timer = setTimeout(() => void refresh(), 150);
    },
    dispose() {
      if (closed) return;
      closed = true;
      controller.abort();
      clearTimeout(timer);
      removeInput();
      unmount();
    },
  };
}
