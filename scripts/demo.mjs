// Scripted sample session for the recording. Runs real Pi/pidiff, with no model calls.
// From the repo root: vhs scripts/demo.tape. Setup and update guide: scripts/README.md.
import { spawn, execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const home = await mkdtemp(join(tmpdir(), "pidiff-demo-"));
const cwd = join(home, "greeting");
const config = join(home, "config");
await mkdir(join(cwd, "src"), { recursive: true });
await mkdir(join(cwd, "test"));
await mkdir(config);
const before = 'export function greet(name: string) {\n  return "Hello, " + name + "!";\n}\n';
const after = 'export function greet(name: string) {\n  const displayName = name.trim();\n  return `Hello, ${displayName}!`;\n}\n';
const tests = 'import assert from "node:assert/strict";\nimport { greet } from "../src/greeting.ts";\n\nassert.equal(greet("Ada"), "Hello, Ada!");\n';
await writeFile(join(cwd, "src/greeting.ts"), before);
await writeFile(join(cwd, "test/greeting.test.ts"), tests);
const git = (...args) => execFileSync("git", args, { cwd, stdio: "ignore", env: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: "1" } });
git("init", "-b", "main");
git("add", ".");
git("-c", "user.name=Demo", "-c", "user.email=demo@example.com", "-c", "commit.gpgsign=false", "commit", "-m", "Initial greeting");
await writeFile(join(cwd, "src/greeting.ts"), after);
await writeFile(join(cwd, "test/greeting.test.ts"), tests + 'assert.equal(greet("  Ada  "), "Hello, Ada!");\n');
await writeFile(join(config, "settings.json"), JSON.stringify({ quietStartup: true, theme: "dark", enableInstallTelemetry: false }));

const timestamp = "2026-01-01T12:00:00.000Z";
const session = join(home, "demo.jsonl");
const messages = [
  { role: "user", content: "Trim whitespace from names and use a friendly greeting when the name is blank.", timestamp: 0 },
  { role: "assistant", content: [{ type: "text", text: "Trimmed names and added a whitespace test.\n\nOpen `/diff` to review the changes alongside this conversation." }], api: "openai-completions", provider: "openai", model: "gpt-4o", stopReason: "stop", timestamp: 0,
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } } },
];
await writeFile(session, [
  { type: "session", version: 3, id: "00000000-0000-4000-8000-000000000001", timestamp, cwd },
  ...messages.map((message, i) => ({ type: "message", id: `0000000${i + 1}`, parentId: i ? "00000001" : null, timestamp, message })),
].map((entry) => JSON.stringify(entry)).join("\n") + "\n");

const child = spawn(process.execPath, [
  join(root, "node_modules/@earendil-works/pi-coding-agent/dist/cli.js"),
  "--offline", "--no-extensions", "-e", join(root, "index.ts"),
  "--no-skills", "--no-prompt-templates", "--no-context-files", "--no-themes",
  "--no-approve", "--tui-mode", "fullscreen", "--session", session,
  "--provider", "openai", "--model", "gpt-4o",
], {
  cwd, stdio: "inherit",
  env: { PATH: process.env.PATH, HOME: home, TERM: "xterm-256color", COLORTERM: "truecolor",
    PI_CODING_AGENT_DIR: config, PI_OFFLINE: "1", PI_TELEMETRY: "0", GIT_CONFIG_NOSYSTEM: "1" },
});
// Give the tape time to open /diff and type a draft before the external edit.
const update = setTimeout(() => {
  void Promise.all([
    writeFile(join(cwd, "src/greeting.ts"), after.replace("name.trim()", 'name.trim() || "friend"')),
    writeFile(join(cwd, "test/greeting.test.ts"), tests + 'assert.equal(greet("  Ada  "), "Hello, Ada!");\nassert.equal(greet("   "), "Hello, friend!");\n'),
  ]).catch((error) => { console.error(error); child.kill(); });
}, 10_000);
try {
  process.exitCode = await new Promise((resolve, reject) => {
    child.once("exit", (code) => resolve(code ?? 1));
    child.once("error", reject);
  });
} finally {
  clearTimeout(update);
  await rm(home, { recursive: true, force: true });
}
