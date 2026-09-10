import { getLanguageFromPath, highlightCode, type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { safeText } from "./git.ts";

type Row = { text: string; sign?: string; number?: number; code?: string };

/** Render a single-file unified patch, keeping notices but hiding Git's transport headers. */
export function renderDiff(patch: string, path: string, width: number, theme: Theme): string[] {
  const rows: Row[] = [];
  const hunks: Row[][] = [];
  let hunk: Row[] = [];
  let old = 0, next = 0, oldLeft = 0, newLeft = 0;
  for (const raw of patch.replace(/\n$/, "").split("\n")) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(raw);
    if (header) {
      if (hunks.length) rows.push({ text: "···" });
      old = Number(header[1]); next = Number(header[3]);
      oldLeft = Number(header[2] ?? 1); newLeft = Number(header[4] ?? 1);
      hunk = [];
      hunks.push(hunk);
    } else if ((oldLeft > 0 || newLeft > 0) && /^[ +\-]/.test(raw)) {
      const sign = raw[0];
      const number = sign === "-" ? old : next;
      if (sign !== "+") { old++; oldLeft--; }
      if (sign !== "-") { next++; newLeft--; }
      const row = { text: safeText(raw.slice(1)), sign, number };
      rows.push(row);
      hunk.push(row);
    } else if (!/^(diff --git |index |--- |\+\+\+ )/.test(raw)) {
      rows.push({ text: safeText(raw) });
    }
  }

  const lang = getLanguageFromPath(path);
  if (lang) {
    // Highlight each side separately so deleted syntax cannot color the added code.
    // Hunk excerpts cannot recover syntax state from omitted source lines.
    for (const hunk of hunks) {
      for (const excluded of ["+", "-"]) {
        const side = hunk.filter((row) => row.sign !== excluded);
        if (!side.length) continue;
        const highlighted = wrapTextWithAnsi(highlightCode(side.map((row) => row.text).join("\n"), lang).join("\n"), Number.MAX_SAFE_INTEGER);
        side.forEach((row, i) => { row.code = highlighted[i]; });
      }
    }
  }

  const digits = rows.reduce((max, row) => Math.max(max, String(row.number ?? "").length), 2);
  const gutter = width >= digits + 5 ? digits + 4 : 0;
  return rows.flatMap((row) => {
    if (row.number === undefined) return wrapTextWithAnsi(theme.fg("dim", row.text), Math.max(1, width)).map((line) => truncateToWidth(line, width));
    const color = row.sign === "+" ? "toolDiffAdded" : row.sign === "-" ? "toolDiffRemoved" : "dim";
    const code = row.code ?? theme.fg("text", row.text);
    return wrapTextWithAnsi(code, Math.max(1, width - gutter)).map((part, index) => {
      const prefix = gutter ? theme.fg(color, index === 0 ? ` ${String(row.number).padStart(digits)} ${row.sign} ` : " ".repeat(gutter)) : "";
      const line = truncateToWidth(prefix + part + "\x1b[39m", width);
      const padded = line + " ".repeat(Math.max(0, width - visibleWidth(line)));
      return row.sign === "+" ? theme.bg("toolSuccessBg", padded) : row.sign === "-" ? theme.bg("toolErrorBg", padded) : line;
    });
  });
}
