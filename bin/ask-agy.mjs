#!/usr/bin/env node
// Send one prompt (read from stdin) to Antigravity (`agy`) and print its
// final answer.
//
//   node ask-agy.mjs [options] <<'EOF'
//   <self-contained prompt>
//   EOF
//
// agy has no read-only mode that works headless, so by default it runs on a
// throwaway copy of the working folder: whatever it changes there is thrown
// away. --write runs it in the real folder instead.

import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  MAX_DEPTH,
  UsageError,
  checkName,
  childEnv,
  currentDepth,
  killOnSignals,
  parseArgs,
  parseTimeout,
  readStdin,
  resolveCli,
  resolveDir,
  runMain,
  runProcess,
} from "../lib/common.mjs";

const USAGE = `usage: node ask-agy.mjs [--write] [--model NAME] [--effort LEVEL] [--cd DIR] [--timeout SEC] < prompt

  --write          run in the real folder so agy's edits stick (default: on a throwaway copy)
  --model NAME     agy model, see \`agy models\` (default: your agy default)
  --effort LEVEL   reasoning effort: low, medium, high, xhigh, max
  --cd DIR         folder agy works on (default: current folder)
  --timeout SEC    hard limit, default 540 (stays under Claude's 10-minute tool limit)`;

const EFFORTS = ["low", "medium", "high", "xhigh", "max"];

// Folders that are big, regenerable, and never needed for a review.
const SKIP_DIRS = new Set([
  "node_modules", ".venv", "venv", "__pycache__", ".next", ".nuxt", ".turbo",
  ".cache", ".parcel-cache", ".pytest_cache", ".mypy_cache", ".gradle", ".terraform",
]);
const MAX_FILE_BYTES = 50 * 1024 * 1024;
const MAX_TOTAL_BYTES = 1024 * 1024 * 1024;

// Copy `src` into `dst`, skipping SKIP_DIRS, huge files and every symlink
// (a link could point outside the copy and let agy write through it).
function copyTree(src, dst) {
  let total = 0;
  const walk = (from, to) => {
    mkdirSync(to, { recursive: true });
    for (const entry of readdirSync(from, { withFileTypes: true })) {
      const a = join(from, entry.name);
      const b = join(to, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(a, b);
      } else if (entry.isFile()) {
        const size = lstatSync(a).size;
        if (size > MAX_FILE_BYTES) continue;
        total += size;
        if (total > MAX_TOTAL_BYTES) {
          throw new Error("Folder is over 1 GB even without build/dependency folders. Point --cd at a smaller folder.");
        }
        copyFileSync(a, b);
      }
    }
  };
  walk(src, dst);
}

// agy's stream-json output is one JSON event per line; the last one is
// {"event":"result","result":{status, response, error}}.
function parseResult(stdout) {
  let result = null;
  for (const line of stdout.split("\n")) {
    if (!line.startsWith("{")) continue;
    try {
      const msg = JSON.parse(line);
      if (msg.event === "result") result = msg.result;
    } catch {}
  }
  return result;
}

let child = null;
killOnSignals(() => child);

runMain(async () => {
  const opts = parseArgs(process.argv.slice(2), {
    write: "bool",
    model: "string",
    effort: "string",
    cd: "string",
    timeout: "string",
  });
  checkName("model", opts.model);
  if (opts.effort && !EFFORTS.includes(opts.effort)) {
    throw new UsageError(`--effort must be one of: ${EFFORTS.join(", ")}`);
  }
  const timeoutSec = parseTimeout(opts.timeout, 540);
  const dir = resolveDir(opts.cd);

  const prompt = (await readStdin()).trim();
  if (!prompt) throw new UsageError("No prompt on stdin. Pipe it in with a heredoc.");

  if (currentDepth() >= MAX_DEPTH) {
    throw new Error(`Refusing to call agy: already ${currentDepth()} assistant hops deep (limit ${MAX_DEPTH}).`);
  }

  const agy = resolveCli("agy", "SIDEKICKS_AGY_BIN");
  if (!agy) throw new Error("agy is not installed or not on PATH. Install Antigravity and run `agy install`.");

  let workDir = dir;
  let tmp = null;
  if (!opts.write) {
    tmp = mkdtempSync(join(tmpdir(), "ask-agy-"));
    workDir = join(tmp, basename(dir) || "workspace");
    copyTree(dir, workDir);
  }

  // The prompt goes in over stdin as a stream-json message. That keeps it out
  // of the process list and avoids Windows' ~32k command-line limit.
  // agy gets its own time limit slightly under ours so it can report cleanly.
  const args = [
    "--sandbox",
    "--disable-slash-commands",
    "--print-timeout", `${Math.max(timeoutSec - 15, 5)}s`,
    "--input-format", "stream-json",
    "--output-format", "stream-json",
  ];
  if (opts.model) args.push("--model", opts.model);
  if (opts.effort) args.push("--effort", opts.effort);
  args.push("--print="); // print mode; the prompt itself arrives on stdin
  const input = JSON.stringify({ event: "user", message: { content: prompt } }) + "\n";

  try {
    const run = runProcess({ cli: agy, args, cwd: workDir, input, env: childEnv(), timeoutMs: timeoutSec * 1000 });
    child = run.child;
    const res = await run.done;
    const result = parseResult(res.stdout);
    const answer = (result?.response ?? "").trim();

    if (res.error) throw new Error(`Could not start agy: ${res.error.message}`);
    if (res.timedOut) throw new Error(`agy timed out after ${timeoutSec}s.${answer ? `\nPartial answer:\n${answer}` : ""}`);
    if (!result || result.status !== "SUCCESS" || !answer) {
      const detail = result?.error || res.stderr.trim().split("\n").slice(-25).join("\n") || `exit code ${res.code}`;
      throw new Error(`agy failed: ${detail}${answer ? `\nPartial answer:\n${answer}` : ""}`);
    }
    process.stdout.write(answer + "\n");
    return 0;
  } finally {
    if (tmp) rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
}, USAGE);
