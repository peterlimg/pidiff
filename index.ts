import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { BorderedLoader } from "@earendil-works/pi-coding-agent";
import { join, resolve, relative } from "node:path";
import { homedir } from "node:os";
import { fileURLToPath } from "node:url";
import { currentView, diffBuffers, safeText, snapshot, type Change, type View } from "./git.ts";
import { DiffViewer } from "./viewer.ts";
import { openPanel } from "./panel.ts";

const ENTRY = "pidiff.turn.v1";

// Pi 0.85.1's normalizePath/resolveToCwd are not public exports.
function normalizePath(path: string, toolInput = false): string {
  if (toolInput) path = path.replace(/[\u00a0\u2000-\u200a\u202f\u205f\u3000]/g, " ").replace(/^@/, "");
  if (process.platform === "win32" && !path.includes("\\")) {
    path = path.replace(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i,
      (_match, drive: string, suffix = "") => `${drive.toUpperCase()}:\\${suffix.replaceAll("/", "\\")}`);
  }
  if (path === "~") return homedir();
  if (path.startsWith("~/") || (process.platform === "win32" && path.startsWith("~\\"))) return join(homedir(), path.slice(2));
  return path.startsWith("file://") ? fileURLToPath(path) : path;
}

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
    let path: string;
    try { path = resolve(normalizePath(ctx.cwd), normalizePath(input.path, true)); }
    catch { return; } // Invalid file URLs also fail in the built-in tool; never block it here.
    if (!files.has(path)) {
      // ponytail: at most 25 files per turn; use on-disk snapshots if larger turns need history.
      if (files.size >= 25) { omitted = true; return; }
      try { files.set(path, { before: await snapshot(path, true) }); }
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
    try { state.after = await snapshot(path, true); }
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
    description: "Toggle unstaged diff and recorded turns. /diff <base-ref> for an explicit comparison; /diff view [base-ref] for the modal.",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") {
        if (ctx.hasUI) ctx.ui.notify("/diff requires Pi's terminal UI.", "warning");
        return;
      }
      const argument = args.trim();
      const modal = /^view(?:\s|$)/.test(argument);
      const base = (modal ? argument.slice(4).trim() : argument) || undefined;
      const getTurns = () => ctx.sessionManager.getBranch().flatMap((entry) =>
        entry.type === "custom" && entry.customType === ENTRY ? [entry.data as View] : [],
      ).reverse();
      if (!modal) {
        if (panel && !base) { closePanel(); return; }
        closePanel();
        let error: unknown;
        clearWidget = () => ctx.ui.setWidget("pidiff-panel", undefined);
        // An empty widget obtains Pi's stable TUI reference without replacing
        // the editor, opening an overlay, or taking keyboard focus.
        ctx.ui.setWidget("pidiff-panel", (tui, theme) => {
          try {
            panel = openPanel(tui, theme, ctx.cwd, base, closePanel, getTurns);
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
        const controller = new AbortController();
        loader.onAbort = () => { controller.abort(); done(undefined); };
        load(controller.signal).then((view) => { if (!controller.signal.aborted) done(view); }).catch((error) => {
          if (!controller.signal.aborted) {
            ctx.ui.notify(safeText((error as Error).message), "error");
            done(undefined);
          }
        });
        return {
          render: (width) => loader.render(width),
          invalidate: () => loader.invalidate(),
          handleInput: (data) => loader.handleInput(data),
          dispose() { controller.abort(); loader.dispose(); },
        };
      });
      if (!current) return;
      await ctx.ui.custom<void>((tui, theme, kb, done) =>
        new DiffViewer(tui, theme, kb, () => done(), [current, ...getTurns()], load),
        { overlay: true, overlayOptions: { width: "95%", maxHeight: "90%", anchor: "center" } },
      );
    },
  });
}
