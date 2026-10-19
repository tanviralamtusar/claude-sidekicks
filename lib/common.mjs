// Shared helpers: finding CLIs safely, running them with hard limits,
// argument parsing, and the recursion guard.

import { spawn, spawnSync } from "node:child_process";
import { accessSync, constants, existsSync, readFileSync, statSync } from "node:fs";
import { delimiter, dirname, extname, isAbsolute, join, resolve } from "node:path";

export const IS_WIN = process.platform === "win32";

// ---------------------------------------------------------------------------
// Finding executables

function isFile(p) {
  try {
    return statSync(p).isFile();
  } catch {
    return false;
  }
}

function isExecutable(p) {
  if (!isFile(p)) return false;
  try {
    accessSync(p, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

// npm installs Windows commands as .cmd shims, which Node will not spawn
// without a shell. Every npm shim ends by running `node "%dp0%\...\x.js"`,
// so we read that script path out and run it with our own Node instead.
function unwrapNpmShim(shimPath) {
  let text;
  try {
    text = readFileSync(shimPath, "utf8");
  } catch {
    return null;
  }
  const m = text.match(/"%dp0%\\([^"%]+?\.(?:js|mjs|cjs))"/i);
  if (!m) return null;
  const script = join(dirname(shimPath), m[1]);
  return isFile(script) ? { cmd: process.execPath, args: [script] } : null;
}

function fromExplicitPath(p) {
  const full = resolve(p);
  const ext = extname(full).toLowerCase();
  if ([".js", ".mjs", ".cjs"].includes(ext)) return { cmd: process.execPath, args: [full] };
  if (ext === ".cmd") return unwrapNpmShim(full);
  return isFile(full) ? { cmd: full, args: [] } : null;
}

// Look a CLI up on PATH, skipping relative PATH entries, so a cloned repo can
// never plant a fake binary that gets picked up from the current folder.
// Returns { cmd, args } for spawn(), or null when it is not installed.
// `overrideVar` names an environment variable that can point at the binary.
export function resolveCli(name, overrideVar) {
  const override = overrideVar && process.env[overrideVar];
  if (override) return fromExplicitPath(override);

  for (const raw of (process.env.PATH ?? "").split(delimiter)) {
    const dir = raw.trim().replace(/^"(.*)"$/, "$1");
    if (!dir || !isAbsolute(dir)) continue;
    if (IS_WIN) {
      const exe = join(dir, `${name}.exe`);
      if (isFile(exe)) return { cmd: exe, args: [] };
      const shim = join(dir, `${name}.cmd`);
      if (isFile(shim)) {
        const unwrapped = unwrapNpmShim(shim);
        if (unwrapped) return unwrapped;
      }
    } else {
      const bin = join(dir, name);
      if (isExecutable(bin)) return { cmd: bin, args: [] };
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// Running a child process with a timeout, an output cap and tree-kill

// Kill a process and everything it started. On Windows a plain kill only
// takes out the top process and leaves e.g. node -> codex.exe running.
export function killTree(child) {
  if (!child || child.exitCode !== null || child.pid === undefined) return;
  if (IS_WIN) {
    const taskkill = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "taskkill.exe");
    spawnSync(taskkill, ["/pid", String(child.pid), "/T", "/F"], { windowsHide: true, stdio: "ignore" });
  } else {
    try {
      process.kill(-child.pid, "SIGKILL"); // whole process group
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {}
    }
  }
}

// Start a process. Returns { child, done } where `done` always resolves (never
// rejects) to { code, stdout, stderr, timedOut, overflow, error }.
export function runProcess({ cli, args = [], cwd, input, env, timeoutMs, maxOutput = 4 * 1024 * 1024 }) {
  const child = spawn(cli.cmd, [...cli.args, ...args], {
    cwd,
    env,
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    detached: !IS_WIN, // own process group, so killTree can take all of it
  });
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");

  const done = new Promise((resolveDone) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let overflow = false;
    let settled = false;

    const finish = (extra) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolveDone({ code: child.exitCode, stdout, stderr, timedOut, overflow, ...extra });
    };

    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          killTree(child);
        }, timeoutMs)
      : null;

    child.stdout.on("data", (d) => {
      stdout += d;
      if (stdout.length > maxOutput) {
        overflow = true;
        killTree(child);
      }
    });
    child.stderr.on("data", (d) => {
      if (stderr.length < maxOutput) stderr += d;
    });
    child.on("error", (error) => finish({ error }));
    child.on("close", (code) => finish({ code }));
  });

  // A child that exits before reading its input must not crash us.
  child.stdin.on("error", () => {});
  if (input !== undefined) child.stdin.write(input);
  child.stdin.end();

  return { child, done };
}

// ---------------------------------------------------------------------------
// Recursion guard. Each hop (Claude -> Codex -> Claude -> ...) bumps the
// depth, and the wrappers refuse to go past MAX_DEPTH, so two assistants
// can't bounce work back and forth and burn through both subscriptions.

export const MAX_DEPTH = 2;
export const DEPTH_VAR = "SIDEKICKS_DEPTH";

export function currentDepth() {
  const n = Number.parseInt(process.env[DEPTH_VAR] ?? "0", 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

export function childEnv(extra = {}) {
  return { ...process.env, [DEPTH_VAR]: String(currentDepth() + 1), ...extra };
}

// ---------------------------------------------------------------------------
// Small CLI helpers for the bin/ wrappers

// A mistake in how the wrapper was called; runMain prints the usage text.
export class UsageError extends Error {}

// Parse `--flag value` / `--flag=value` / `--switch` arguments against a spec
// like { write: "bool", model: "string" }. Throws on anything unknown.
export function parseArgs(argv, spec) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const m = arg.match(/^--([a-z-]+)(?:=(.*))?$/);
    if (!m || !(m[1] in spec)) throw new UsageError(`Unknown argument: ${arg}`);
    const [, name, inline] = m;
    const key = name.replace(/-([a-z])/g, (_, c) => c.toUpperCase());
    if (spec[name] === "bool") {
      if (inline !== undefined) throw new UsageError(`--${name} takes no value`);
      out[key] = true;
    } else {
      const value = inline ?? argv[++i];
      if (value === undefined) throw new UsageError(`--${name} needs a value`);
      out[key] = value;
    }
  }
  return out;
}

export async function readStdin() {
  if (process.stdin.isTTY) return "";
  process.stdin.setEncoding("utf8");
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

// Model names and effort levels end up as CLI arguments, so only allow a
// conservative character set.
export function checkName(label, value) {
  if (value !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:\/-]{0,99}$/.test(value)) {
    throw new UsageError(`Invalid ${label}: ${value}`);
  }
  return value;
}

export function parseTimeout(value, fallbackSec) {
  if (value === undefined) return fallbackSec;
  const sec = Number(value);
  if (!Number.isInteger(sec) || sec < 10 || sec > 24 * 3600) {
    throw new UsageError("--timeout must be a whole number of seconds between 10 and 86400");
  }
  return sec;
}

export function resolveDir(value) {
  const dir = resolve(value ?? process.cwd());
  if (!existsSync(dir) || !statSync(dir).isDirectory()) throw new Error(`Not a directory: ${dir}`);
  return dir;
}

// Run `main`, printing errors as one clean line and exiting non-zero.
export function runMain(main, usage) {
  if (usage && process.argv.slice(2).some((a) => a === "--help" || a === "-h")) {
    process.stdout.write(`${usage}\n`);
    process.exit(0);
  }
  main().then(
    (code) => process.exit(code ?? 0),
    (err) => {
      process.stderr.write(`error: ${err.message}\n`);
      if (usage && err instanceof UsageError) process.stderr.write(`\n${usage}\n`);
      process.exit(err instanceof UsageError ? 2 : 1);
    }
  );
}

// Make sure Ctrl+C / a parent's kill also takes down the child tree.
export function killOnSignals(getChild) {
  for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) {
    process.on(sig, () => {
      killTree(getChild());
      process.exit(130);
    });
  }
}
