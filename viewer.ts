import type { Theme, KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { SelectList, matchesKey, truncateToWidth, visibleWidth, type TUI } from "@earendil-works/pi-tui";
import { filePatch, safeText, type View } from "./git.ts";
import { renderDiff } from "./diff.ts";

export class DiffViewer {
  private tab = 0;
  private selected = 0;
  private list?: SelectList;
  private listHeight = 0;
  private opened = false;
  private patch = "";
  private scroll = 0;
  private page = 10;
  private lineCount = 0;
  private loading = false;
  private closed = false;
  private request = 0;
  private controller?: AbortController;
  private wrapped?: { width: number; patch: string; path: string; lines: string[] };

  private tui: TUI;
  private theme: Theme;
  private kb: Pick<KeybindingsManager, "matches">;
  private done: () => void;
  private views: View[];
  private refresh: (signal?: AbortSignal) => Promise<View>;

  constructor(tui: TUI, theme: Theme, kb: Pick<KeybindingsManager, "matches">, done: () => void, views: View[], refresh: (signal?: AbortSignal) => Promise<View>) {
    this.tui = tui;
    this.theme = theme;
    this.kb = kb;
    this.done = done;
    this.views = views;
    this.refresh = refresh;
  }

  private async openFile() {
    const file = this.views[this.tab].files[this.selected];
    if (!file || this.closed) return;
    this.cancelWork();
    this.controller = new AbortController();
    this.opened = true;
    this.scroll = 0;
    this.patch = "Loading diff...";
    const request = ++this.request;
    try {
      const patch = await filePatch(this.views[this.tab], file, this.controller.signal);
      if (request === this.request && !this.closed) {
        this.patch = patch.length > 200_000 ? patch.slice(0, 200_000) + "\n[Preview truncated at 200,000 characters. Use git diff for the full patch.]" : patch;
      }
    } catch (error) {
      if (request === this.request && !this.closed) this.patch = `Preview unavailable: ${(error as Error).message}`;
    }
    if (request === this.request && !this.closed) this.tui.requestRender();
  }

  private async reload() {
    if (this.closed) return;
    this.cancelWork();
    this.controller = new AbortController();
    this.loading = true;
    const request = ++this.request;
    try {
      const current = await this.refresh(this.controller.signal);
      if (request !== this.request || this.closed) return;
      this.views[0] = current;
      this.tab = 0;
      this.reset();
      this.tui.requestRender();
    } catch (error) {
      if (request === this.request && !this.closed) {
        this.opened = true;
        this.scroll = 0;
        this.patch = `Refresh failed: ${(error as Error).message}`;
      }
    } finally {
      if (request === this.request && !this.closed) {
        this.loading = false;
        this.tui.requestRender();
      }
    }
  }

  private cancelWork() {
    this.request++;
    this.controller?.abort();
    this.controller = undefined;
    this.loading = false;
  }

  private reset() {
    this.cancelWork();
    this.selected = 0;
    this.opened = false;
    this.list = undefined;
    this.scroll = 0;
  }

  handleInput(data: string) {
    if (this.closed) return;
    if (this.kb.matches(data, "tui.select.cancel") || data === "q") {
      if (this.opened) { this.opened = false; this.cancelWork(); }
      else { this.dispose(); this.done(); return; }
    } else if (matchesKey(data, "left") || matchesKey(data, "right")) {
      this.tab = (this.tab + (matchesKey(data, "left") ? -1 : 1) + this.views.length) % this.views.length;
      this.reset();
    } else if (data === "r") {
      void this.reload();
    } else if (this.opened) {
      if (this.kb.matches(data, "tui.select.up") || data === "k") this.scroll--;
      if (this.kb.matches(data, "tui.select.down") || data === "j") this.scroll++;
      if (this.kb.matches(data, "tui.select.pageUp")) this.scroll -= this.page;
      if (this.kb.matches(data, "tui.select.pageDown")) this.scroll += this.page;
      if (matchesKey(data, "home")) this.scroll = 0;
      if (matchesKey(data, "end")) this.scroll = this.lineCount;
      this.scroll = Math.max(0, Math.min(this.scroll, this.lineCount - this.page));
    } else if (this.kb.matches(data, "tui.select.pageUp") || this.kb.matches(data, "tui.select.pageDown")) {
      const direction = this.kb.matches(data, "tui.select.pageUp") ? -1 : 1;
      this.selected = Math.max(0, Math.min(this.views[this.tab].files.length - 1, this.selected + direction * Math.max(1, this.listHeight)));
      this.list?.setSelectedIndex(this.selected);
    } else if (this.kb.matches(data, "tui.select.confirm")) {
      void this.openFile();
    } else {
      this.list?.handleInput(data === "j" ? "\x1b[B" : data === "k" ? "\x1b[A" : data);
    }
    this.tui.requestRender();
  }

  render(width: number): string[] {
    const outerWidth = width;
    width = Math.max(1, width - 2);
    const height = Math.max(6, Math.floor(this.tui.terminal.rows * 0.8));
    this.page = Math.max(1, height - 6);
    const view = this.views[this.tab];
    const title = `${view.label}  [${this.tab + 1}/${this.views.length}]${this.loading ? " · refreshing..." : ""}`;
    const lines = [this.theme.fg("accent", this.theme.bold(safeText(title)))];
    if (this.opened) {
      lines.push(this.theme.fg("muted", safeText(view.files[this.selected]?.path ?? "Diff")));
      const path = view.files[this.selected]?.path ?? "";
      if (this.wrapped?.width !== width || this.wrapped.patch !== this.patch || this.wrapped.path !== path) {
        this.wrapped = { width, patch: this.patch, path, lines: renderDiff(this.patch, path, width, this.theme) };
      }
      const body = this.wrapped.lines;
      this.lineCount = body.length;
      this.scroll = Math.max(0, Math.min(this.scroll, body.length - this.page));
      lines.push(...body.slice(this.scroll, this.scroll + this.page));
      lines.push(this.theme.fg("dim", `${this.scroll + 1}-${Math.min(body.length, this.scroll + this.page)}/${body.length}  ↑↓ scroll · PgUp/PgDn · Esc back`));
    } else {
      lines.push(this.theme.fg("muted", `${view.files.length} files${view.note ? ` · ${safeText(view.note)}` : ""}`));
      const listHeight = Math.max(1, this.page - 1);
      if (!this.list || this.listHeight !== listHeight) {
        this.listHeight = listHeight;
        this.list = new SelectList(view.files.map((file, index) => ({
          value: String(index),
          label: `${file.binary ? "binary" : `+${file.added} -${file.removed}`}  ${file.untracked ? "[new] " : ""}${safeText(file.path)}`,
        })), listHeight, {
          selectedPrefix: (text) => this.theme.fg("accent", text),
          selectedText: (text) => this.theme.fg("accent", text),
          description: (text) => this.theme.fg("muted", text),
          scrollInfo: (text) => this.theme.fg("dim", text),
          noMatch: (text) => this.theme.fg("dim", text),
        });
        this.list.setSelectedIndex(this.selected);
        this.list.onSelectionChange = (item) => { this.selected = Number(item.value); };
      }
      if (view.files.length) lines.push(...this.list.render(width));
      lines.push(this.theme.fg("dim", "←→ Current/turns · ↑↓ files · Enter open · r refresh · Esc close"));
    }
    if (outerWidth < 3) return lines.map((line) => truncateToWidth(line, Math.max(1, outerWidth)));
    const border = (text: string) => this.theme.fg("border", text);
    return [
      border(`╭${"─".repeat(width)}╮`),
      ...lines.map((line) => {
        const text = truncateToWidth(line, width);
        return border("│") + text + " ".repeat(Math.max(0, width - visibleWidth(text))) + border("│");
      }),
      border(`╰${"─".repeat(width)}╯`),
    ];
  }

  invalidate() { this.wrapped = undefined; this.list?.invalidate(); }
  dispose() { this.closed = true; this.cancelWork(); }
}
