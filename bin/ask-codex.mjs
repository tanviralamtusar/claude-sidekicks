#!/usr/bin/env node
// Send one prompt (read from stdin) to Codex and print its final answer.
//
//   node ask-codex.mjs [options] <<'EOF'
//   <self-contained prompt>
//   EOF
//
// Read-only by default: Codex runs in its read-only sandbox. --write lets it
// edit files inside the working folder (workspace-write sandbox).

import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

const USAGE = `usage: node ask-codex.mjs [--write] [--model NAME] [--effort LEVEL] [--cd DIR] [--timeout SEC] < prompt

  --write          allow Codex to edit files in the working folder (default: read-only)
  --model NAME     Codex model (default: your Codex default)
  --effort LEVEL   reasoning effort: minimal, low, medium, high, xhigh
  --cd DIR         folder Codex works in (default: current folder)
  --timeout SEC    hard limit, default 540 (stays under Claude's 10-minute tool limit)`;

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
  checkName("effort", opts.effort);
  const timeoutSec = parseTimeout(opts.timeout, 540);
  const dir = resolveDir(opts.cd);

  const prompt = (await readStdin()).trim();
  if (!prompt) throw new UsageError("No prompt on stdin. Pipe it in with a heredoc.");

  if (currentDepth() >= MAX_DEPTH) {
    throw new Error(`Refusing to call Codex: already ${currentDepth()} assistant hops deep (limit ${MAX_DEPTH}).`);
  }

  const codex = resolveCli("codex", "SIDEKICKS_CODEX_BIN");
  if (!codex) throw new Error("codex is not installed or not on PATH. Install it: npm install -g @openai/codex");

  // Codex writes its final message here; that is cleaner than scraping stdout.
  const tmp = mkdtempSync(join(tmpdir(), "ask-codex-"));
  const answerFile = join(tmp, "answer.md");

  const args = [
    "exec",
    "--sandbox", opts.write ? "workspace-write" : "read-only",
    "--skip-git-repo-check",
    "--ephemeral",
    "--color", "never",
    "--cd", dir,
    "--output-last-message", answerFile,
  ];
  if (opts.model) args.push("--model", opts.model);
  if (opts.effort) args.push("-c", `model_reasoning_effort="${opts.effort}"`);
  args.push("-"); // prompt comes from stdin

  try {
    const run = runProcess({ cli: codex, args, cwd: dir, input: prompt, env: childEnv(), timeoutMs: timeoutSec * 1000 });
    child = run.child;
    const res = await run.done;

    let answer = "";
    try {
      answer = readFileSync(answerFile, "utf8").trim();
    } catch {}

    if (res.error) throw new Error(`Could not start codex: ${res.error.message}`);
    if (res.timedOut) throw new Error(`codex timed out after ${timeoutSec}s.${answer ? `\nPartial answer:\n${answer}` : ""}`);
    if (res.code !== 0 || !answer) {
      const detail = (res.stderr || res.stdout).trim().split("\n").slice(-25).join("\n");
      throw new Error(`codex exited with code ${res.code} and no answer.\n${detail}`);
    }
    process.stdout.write(answer + "\n");
    return 0;
  } finally {
    rmSync(tmp, { recursive: true, force: true, maxRetries: 3 });
  }
}, USAGE);
