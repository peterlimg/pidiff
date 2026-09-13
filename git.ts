import { execFile } from "node:child_process";
import { stat, lstat, open, readlink, mkdtemp, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface Change {
  path: string;
  added: number;
  removed: number;
  binary?: boolean;
  patch?: string;
  untracked?: boolean;
}

export interface View {
  label: string;
  files: Change[];
  root?: string;
  ref?: string;
  note?: string;
}

const MAX_BYTES = 2 * 1024 * 1024;
const DIFF_OPTIONS = ["--no-ext-diff", "--no-textconv", "--no-color", "--no-renames"];

export function git(cwd: string, args: string[], allowDifference = false, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = execFile("git", ["--no-pager", "--literal-pathspecs", ...args], {
      cwd, signal, encoding: "utf8", timeout: 15_000, maxBuffer: 8 * 1024 * 1024,
      env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", LC_ALL: "C" },
    }, (error, stdout, stderr) => {
      if (error && !(allowDifference && error.code === 1 && !error.killed)) {
        reject(new Error(stderr.trim() || error.message));
      } else resolve(stdout);
    });
    child.stdin?.end();
  });
}

// Current reads link text; turn snapshots follow links like edit/write. Bound growing files too.
export async function snapshot(path: string, followSymlinks = false): Promise<Buffer | null> {
  try {
    const info = await (followSymlinks ? stat(path) : lstat(path));
    if (info.isSymbolicLink()) return Buffer.from(await readlink(path));
    if (!info.isFile()) throw new Error("Not a regular file");
    if (info.size > MAX_BYTES) throw new Error("File exceeds the 2 MiB preview limit");
    const file = await open(path, "r");
    try {
      const buffer = Buffer.alloc(MAX_BYTES + 1);
      let size = 0;
      while (size < buffer.length) {
        const { bytesRead } = await file.read(buffer, size, buffer.length - size, size);
        if (!bytesRead) break;
        size += bytesRead;
      }
      if (size > MAX_BYTES) throw new Error("File exceeds the 2 MiB preview limit");
      return buffer.subarray(0, size);
    } finally {
      await file.close();
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

export function summarize(path: string, patch: string): Change {
  let added = 0, removed = 0, inHunk = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("@@ ")) inHunk = true;
    else if (inHunk && line.startsWith("+")) added++;
    else if (inHunk && line.startsWith("-")) removed++;
  }
  return { path, patch, added, removed, binary: /^Binary files /m.test(patch) };
}

export async function diffBuffers(path: string, before: Buffer | null, after: Buffer | null, signal?: AbortSignal): Promise<Change> {
  if (before?.equals(after ?? Buffer.alloc(0)) && after !== null) return summarize(path, "");
  const dir = await mkdtemp(join(tmpdir(), "pidiff-"));
  try {
    await writeFile(join(dir, "before"), before ?? "");
    await writeFile(join(dir, "after"), after ?? "");
    let patch = await git(dir, ["diff", ...DIFF_OPTIONS, "--no-index", "--", "before", "after"], true, signal);
    // Temp names are implementation details; the viewer supplies the real filename.
    patch = patch.replace(/^diff --git .*\nindex .*\n/m, "")
      .replace(/^--- a\/before$/m, before === null ? "--- /dev/null" : "--- before")
      .replace(/^\+\+\+ b\/after$/m, after === null ? "+++ /dev/null" : "+++ after");
    if (!patch && (before === null) !== (after === null)) {
      patch = before === null ? "New empty file" : "Deleted empty file";
    }
    return summarize(path, patch);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

export function parseNumstat(output: string): Change[] {
  return output.split("\0").filter(Boolean).map((record) => {
    const match = /^(\d+|-)\t(\d+|-)\t([\s\S]+)$/.exec(record);
    if (!match) throw new Error("Unexpected git numstat output");
    return { path: match[3], added: Number(match[1]) || 0, removed: Number(match[2]) || 0, binary: match[1] === "-" };
  });
}

async function resolveRef(root: string, ref: string, signal?: AbortSignal): Promise<string | undefined> {
  try {
    return (await git(root, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], false, signal)).trim();
  } catch {
    signal?.throwIfAborted();
    return undefined;
  }
}

export async function currentView(cwd: string, base?: string, signal?: AbortSignal): Promise<View> {
  const root = (await git(cwd, ["rev-parse", "--show-toplevel"], false, signal)).replace(/\r?\n$/, "");
  const run = (args: string[]) => git(root, args, false, signal);
  let ref: string | undefined;
  let label = "Current · unstaged";
  if (base) {
    const commit = await resolveRef(root, base, signal);
    if (!commit) throw new Error(`Cannot resolve base: ${base}`);
    ref = (await run(["merge-base", "HEAD", commit])).trim();
    label = `Current · since ${base.replace(/^refs\/(heads|remotes)\//, "")}`;
  }
  // No ref means index → working tree, just like plain git diff.
  const changes = new Map(parseNumstat(await run(["diff", ...DIFF_OPTIONS, "--numstat", "-z", ...(ref ? [ref] : []), "--"]))
    .map((file) => [file.path, file]));
  const unmerged = await run(["diff", ...DIFF_OPTIONS, "--name-only", "--diff-filter=U", "-z", "--"]);
  for (const path of unmerged.split("\0").filter(Boolean)) {
    changes.set(path, { path, added: 0, removed: 0, patch: "Unmerged conflict preview unsupported. Resolve the conflict with Git before previewing." });
  }
  const files = [...changes.values()];
  const known = new Set(changes.keys());
  const untracked = (base ? await run(["ls-files", "--others", "--exclude-standard", "-z"]) : "").split("\0").filter(Boolean);
  for (const path of untracked) {
    signal?.throwIfAborted();
    if (known.has(path)) continue;
    try {
      const content = await snapshot(join(root, path));
      if (content === null) continue;
      const binary = content.includes(0);
      const text = binary ? "" : content.toString("utf8");
      const added = text ? text.split("\n").length - (text.endsWith("\n") ? 1 : 0) : 0;
      files.push({ path, added, removed: 0, binary, untracked: true });
    } catch (error) {
      files.push({ path, added: 0, removed: 0, untracked: true, patch: `Preview unavailable: ${(error as Error).message}` });
    }
  }
  return { label, files, root, ref, note: files.length ? undefined : base ? "No changes since the specified base." : "No unstaged changes." };
}

export async function filePatch(view: View, file: Change, signal?: AbortSignal): Promise<string> {
  if (file.patch !== undefined) return file.patch || "No net changes.";
  if (file.untracked) return (await diffBuffers(file.path, null, await snapshot(join(view.root!, file.path)), signal)).patch || "File no longer exists. Press r to refresh.";
  return await git(view.root!, ["diff", ...DIFF_OPTIONS, ...(view.ref ? [view.ref] : []), "--", file.path], false, signal) || "No net changes. Press r to refresh.";
}

// Repository text is not terminal markup. Escape control characters before rendering.
export function safeText(text: string): string {
  return text.replace(/\t/g, "    ").replace(/[\x00-\x1f\x7f-\x9f]/g,
    (char) => `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`);
}
