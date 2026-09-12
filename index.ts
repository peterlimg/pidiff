import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BorderedLoader } from "@earendil-works/pi-coding-agent";
import { resolve, relative } from "node:path";
import { homedir } from "node:os";
import { currentView, diffBuffers, safeText, snapshot, type Change, type View } from "./git.ts";
import { DiffViewer } from "./viewer.ts";
import { openPanel } from "./panel.ts";

const ENTRY = "pidiff.turn.v1";

export default function (pi: ExtensionAPI) {
  let panel: ReturnType<typeof openPanel> | undefined;
  let clearWidget: (() => void) | undefined;
  function closePanel() {
    panel?.dispose();
    panel = undefined;
    clearWidget?.();
    clearWidget = undefined;
  }
  pi.on("session_shutdown", closePanel);
  pi.on("tool_execution_end", (event) => {
    if (["edit", "write", "bash", "powershell"].includes(event.toolName)) panel?.refreshSoon();
  });

  let prompt = "Edits";
  let omitted = false;
  const pending = new Map<string, string>();
  const files = new Map<string, { before?: Buffer | null; after?: Buffer | null; error?: string; changed?: boolean }>();

  pi.on("before_agent_start", (event) => { prompt = event.prompt.slice(0, 120); });
  pi.on("agent_start", () => { files.clear(); pending.clear(); omitted = false; });

  // Best-effort observation only. A failed preview must never block a tool call.
  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "edit" && event.toolName !== "write") return;
    const input = event.input as { path?: unknown };
    if (typeof input.path !== "string") return;
    let path = input.path.replace(/^@/, "");
    if (path.startsWith("~/")) path = resolve(homedir(), path.slice(2));
    path = resolve(ctx.cwd, path);
    if (!files.has(path)) {
      // ponytail: at most 25 files per turn; use on-disk snapshots if larger turns need history.
      if (files.size >= 25) { omitted = true; return; }
      try { files.set(path, { before: await snapshot(path) }); }
      catch (error) { files.set(path, { error: (error as Error).message }); }
    }
    pending.set(event.toolCallId, path);
  });

  pi.on("tool_result", async (event) => {
    const path = pending.get(event.toolCallId);
    pending.delete(event.toolCallId);
    if (!path || event.isError) return;
    const state = files.get(path)!;
    state.changed = true;
    try { state.after = await snapshot(path); }
    catch (error) { state.error = (error as Error).message; }
  });

  pi.on("agent_end", async (_event, ctx) => {
    const changes: Change[] = [];
    for (const [path, state] of files) {
      if (!state.changed) continue;
      const name = relative(ctx.cwd, path);
      try {
        if (state.error) throw new Error(state.error);
        const change = await diffBuffers(name, state.before!, state.after!);
        if (!change.patch) continue;
        // Bound persisted history, which lives in the session but never enters model context.
        if (change.patch.length > 32_000) change.patch = change.patch.slice(0, 32_000) + "\n[Turn preview truncated at 32,000 characters. Use Current for the working-tree diff.]";
        changes.push(change);
      } catch (error) {
        changes.push({ path: name, added: 0, removed: 0, patch: `Turn preview unavailable: ${(error as Error).message}` });
      }
    }
    files.clear();
    pending.clear();
    if (changes.length || omitted) {
      pi.appendEntry(ENTRY, { label: `Turn · ${prompt}`, files: changes, note: omitted ? "Only the first 25 edited files were recorded." : undefined } satisfies View);
    }
    panel?.refreshSoon();
  });

  pi.registerCommand("diff", {
    description: "Toggle unstaged diff. /diff <base-ref> for an explicit comparison; /diff view [base-ref] for the modal and recorded turns.",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        if (ctx.hasUI) ctx.ui.notify("/diff requires Pi's terminal UI.", "warning");
        return;
      }
      const argument = args.trim();
      const modal = /^view(?:\s|$)/.test(argument);
      const base = (modal ? argument.slice(4).trim() : argument) || undefined;
      if (!modal) {
        if (panel && !base) { closePanel(); return; }
        closePanel();
        let error: unknown;
        clearWidget = () => ctx.ui.setWidget("pidiff-panel", undefined);
        // An empty widget obtains Pi's stable TUI reference without replacing
        // the editor, opening an overlay, or taking keyboard focus.
        ctx.ui.setWidget("pidiff-panel", (tui, theme) => {
          try {
            panel = openPanel(tui, theme, ctx.cwd, base, closePanel);
          } catch (cause) { error = cause; }
          return { render: () => [], invalidate() {} };
        });
        if (error) {
          closePanel();
          ctx.ui.notify(safeText((error as Error).message), "warning");
        } else if (panel) {
          ctx.ui.notify("Diff split view opened. /diff closes it. Needs at least 110 columns; resize to reveal a hidden pane.", "info");
        }
        return;
      }
      const load = (signal?: AbortSignal) => currentView(ctx.cwd, base, signal);
      const current = await ctx.ui.custom<View | undefined>((tui, theme, _kb, done) => {
        const loader = new BorderedLoader(tui, theme, "Loading changes...");
        let cancelled = false;
        loader.onAbort = () => { cancelled = true; done(undefined); };
        load(loader.signal).then((view) => { if (!cancelled) done(view); }).catch((error) => {
          if (!cancelled) {
            ctx.ui.notify(safeText((error as Error).message), "error");
            done(undefined);
          }
        });
        return loader;
      });
      if (!current) return;
      const turns = ctx.sessionManager.getBranch().flatMap((entry) =>
        entry.type === "custom" && entry.customType === ENTRY ? [entry.data as View] : [],
      ).reverse();
      await ctx.ui.custom<void>((tui, theme, kb, done) =>
        new DiffViewer(tui, theme, kb, () => done(), [current, ...turns], load),
        { overlay: true, overlayOptions: { width: "95%", maxHeight: "90%", anchor: "center" } },
      );
    },
  });
}
