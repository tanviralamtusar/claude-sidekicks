#!/usr/bin/env node
// Installer for claude-sidekicks. Run it through install.sh / install.ps1,
// or directly:  node install.mjs [--yes] [--uninstall]
//
// What it does:
//   1. Checks that claude is installed, plus codex and/or agy.
//   2. Adds a managed section to ~/.claude/CLAUDE.md that teaches Claude to
//      call Codex and Antigravity through the bin/ wrappers.
//   3. Registers server/claude-mcp.mjs with Codex (~/.codex/config.toml) and,
//      if you want, with Antigravity (`agy mcp add`), so they can call Claude.
//
// Re-running it updates everything in place. Every file it changes is backed
// up first. --uninstall removes all of it again.

import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath } from "node:url";
import { IS_WIN, parseArgs, resolveCli } from "./lib/common.mjs";

const ROOT = dirname(fileURLToPath(import.meta.url));
const slash = (p) => p.replace(/\\/g, "/");
const BIN_DIR = slash(join(ROOT, "bin"));
const SERVER = slash(join(ROOT, "server", "claude-mcp.mjs"));
const NODE = slash(process.execPath);
const MCP_NAME = "claude";

const MD_BEGIN = "<!-- claude-sidekicks:begin (managed by install.mjs; re-run it to update) -->";
const MD_END = "<!-- claude-sidekicks:end -->";
const TOML_BEGIN = "# >>> claude-sidekicks (managed by install.mjs; re-run it to update) >>>";
const TOML_END = "# <<< claude-sidekicks <<<";

// Our relay script, current or from the older layout. Used to tell our own
// config entries apart from a "claude" MCP server the user set up themselves.
const OURS = /claude-mcp\.mjs|ask-claude-mcp\.mjs/;

const ok = (msg) => console.log(`  ✓ ${msg}`);
const info = (msg) => console.log(`    ${msg}`);
const warn = (msg) => console.log(`  ! ${msg}`);
class Abort extends Error {}

// ---------------------------------------------------------------------------
// Text helpers

const eolOf = (text) => (text.includes("\r\n") ? "\r\n" : "\n");
const toLines = (text) => (text === "" ? [] : text.replace(/\r\n/g, "\n").replace(/\n$/, "").split("\n"));

function trimBlankEdges(lines) {
  const out = [...lines];
  while (out.length && !out[0].trim()) out.shift();
  while (out.length && !out[out.length - 1].trim()) out.pop();
  return out;
}

// Remove the lines between (and including) a begin/end marker pair.
function stripManaged(lines, begin, end) {
  const out = [];
  let inside = false;
  for (const line of lines) {
    const t = line.trim();
    if (!inside && t.startsWith(begin.slice(0, 24))) inside = true;
    else if (inside && t === end) inside = false;
    else if (!inside) out.push(line);
  }
  if (inside) throw new Abort(`Found "${begin}" without its end marker. Fix the file by hand, then re-run.`);
  return out;
}

function writeWithBackup(file, before, after, stamp) {
  if (before === after) return false;
  if (before !== null) copyFileSync(file, `${file}.bak-${stamp}`);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, after, "utf8"); // UTF-8 without BOM
  return true;
}

const readOrNull = (file) => (existsSync(file) ? readFileSync(file, "utf8").replace(/^﻿/, "") : null);

// ---------------------------------------------------------------------------
// ~/.claude/CLAUDE.md

// Earlier relay versions appended unmarked "# Codex is always available" and
// "# Antigravity is always available" sections. Drop those, so the managed
// section replaces them instead of contradicting them.
function stripLegacyMarkdown(lines) {
  const legacy = [
    { heading: /^# Codex is always available\s*$/, mustContain: /codex exec/ },
    { heading: /^# Antigravity is always available\s*$/, mustContain: /\bagy\b/ },
  ];
  const out = [];
  let i = 0;
  let removed = 0;
  while (i < lines.length) {
    const match = legacy.find((l) => l.heading.test(lines[i]));
    if (!match) {
      out.push(lines[i++]);
      continue;
    }
    // The section runs until the next top-level heading outside a code fence.
    let j = i + 1;
    let fence = false;
    for (; j < lines.length; j++) {
      if (/^\s*(```|~~~)/.test(lines[j])) fence = !fence;
      if (!fence && /^# /.test(lines[j])) break;
    }
    const section = lines.slice(i, j);
    if (match.mustContain.test(section.join("\n"))) {
      removed++;
    } else {
      out.push(...section); // same title but not ours: keep it
    }
    i = j;
  }
  return { lines: out, removed };
}

function updateClaudeMd(file, uninstall, stamp) {
  const before = readOrNull(file);
  const eol = before ? eolOf(before) : IS_WIN ? "\r\n" : "\n";
  let lines = stripManaged(toLines(before ?? ""), MD_BEGIN, MD_END);
  const legacy = stripLegacyMarkdown(lines);
  lines = trimBlankEdges(legacy.lines);

  if (!uninstall) {
    const section = readFileSync(join(ROOT, "templates", "claude-section.md"), "utf8").replaceAll("{{BIN}}", BIN_DIR);
    if (lines.length) lines.push("");
    lines.push(MD_BEGIN, ...trimBlankEdges(toLines(section)), MD_END);
  }
  const after = lines.length ? lines.join(eol) + eol : "";
  if (before === null && uninstall) return;

  if (writeWithBackup(file, before, after, stamp)) {
    if (legacy.removed) ok(`Removed ${legacy.removed} old relay section(s) from ${file}`);
    ok(uninstall ? `Removed the sidekicks section from ${file}` : `Claude now knows how to call Codex and Antigravity (${file})`);
  } else {
    info(`${file} is already up to date.`);
  }
}

// ---------------------------------------------------------------------------
// ~/.codex/config.toml

const tomlStr = (s) => JSON.stringify(s); // JSON escapes are valid TOML basic-string escapes

function stripCodexTables(lines) {
  // Remove [mcp_servers.claude] and its [mcp_servers.claude.*] sub-tables.
  // A table runs until the next header line.
  const header = /^\s*\[\s*mcp_servers\.claude(\.[^\]]*)?\s*\]\s*(#.*)?$/;
  const anyHeader = /^\s*\[/;
  const out = [];
  const removed = [];
  let skipping = false;
  for (const line of lines) {
    if (anyHeader.test(line)) skipping = header.test(line);
    (skipping ? removed : out).push(line);
  }
  return { lines: out, removed };
}

function updateCodexConfig(file, uninstall, stamp) {
  const before = readOrNull(file);
  if (before === null && uninstall) return;
  const eol = before ? eolOf(before) : "\n";
  const all = toLines(before ?? "");

  // Pinned models go stale and then every `codex exec` fails with "model rejected".
  for (const line of all) {
    if (/^\s*\[/.test(line)) break;
    if (/^\s*model\s*=/.test(line)) {
      warn(`Your Codex config pins a model: ${line.trim()}`);
      info("If Codex calls ever fail with 'model rejected', delete that line from ~/.codex/config.toml.");
      break;
    }
  }

  const unmanaged = stripManaged(all, TOML_BEGIN, TOML_END);
  const { lines: rest, removed } = stripCodexTables(unmanaged);
  if (removed.length && !OURS.test(removed.join("\n"))) {
    warn(`${file} already has an [mcp_servers.${MCP_NAME}] entry that isn't from this project. Leaving Codex alone.`);
    info(`Rename or remove that entry and re-run the installer to connect Codex.`);
    return;
  }

  const lines = trimBlankEdges(rest);
  if (!uninstall) {
    if (lines.length) lines.push("");
    lines.push(
      TOML_BEGIN,
      `[mcp_servers.${MCP_NAME}]`,
      `command = ${tomlStr(NODE)}`,
      `args = [${tomlStr(SERVER)}]`,
      // A bit over the server's own 10-minute limit, so the server reports timeouts itself.
      "tool_timeout_sec = 630",
      "",
      // Headless `codex exec` auto-denies MCP calls unless the tool itself is
      // approved. Only the read-only tool is; ask_claude_write always asks.
      `[mcp_servers.${MCP_NAME}.tools.ask_claude]`,
      'approval_mode = "approve"',
      TOML_END
    );
  }
  const after = lines.length ? lines.join(eol) + eol : "";

  if (writeWithBackup(file, before, after, stamp)) {
    if (removed.length) ok(`Replaced the old relay entry in ${file}`);
    ok(uninstall ? `Removed the Claude relay from ${file}` : `Codex can now call Claude (${file})`);
  } else {
    info(`${file} is already up to date.`);
  }
}

// ---------------------------------------------------------------------------
// Antigravity MCP registration (through its own CLI)

function agy(cli, args) {
  return spawnSync(cli.cmd, [...cli.args, ...args], { encoding: "utf8", windowsHide: true, timeout: 60_000 });
}

function agyEntry(cli) {
  const res = agy(cli, ["mcp", "list"]);
  if (res.status !== 0) return { error: (res.stderr || res.stdout || "").trim() || `exit ${res.status}` };
  const row = (res.stdout ?? "").split(/\r?\n/).find((l) => l.split(/\s+/)[0] === MCP_NAME);
  return { row };
}

function updateAgy(cli, uninstall, wanted) {
  const { row, error } = agyEntry(cli);
  if (error) return warn(`Could not read Antigravity's MCP list: ${error}`);
  if (row && !OURS.test(row)) {
    return warn(`Antigravity already has an MCP server named "${MCP_NAME}" that isn't from this project. Leaving it alone.`);
  }
  if (uninstall || !wanted) {
    if (!row) return uninstall ? info("Antigravity has no Claude relay registered.") : undefined;
    const res = agy(cli, ["mcp", "remove", MCP_NAME]);
    return res.status === 0 ? ok("Removed the Claude relay from Antigravity.") : warn(`agy mcp remove failed: ${res.stderr}`);
  }
  const res = agy(cli, ["mcp", "add", MCP_NAME, "--", NODE, SERVER]);
  if (res.status !== 0) return warn(`agy mcp add failed: ${(res.stderr || res.stdout).trim()}`);
  ok("Antigravity can now call Claude (agy mcp list shows it as \"claude\").");
}

// ---------------------------------------------------------------------------

function version(cli) {
  if (!cli) return null;
  const res = spawnSync(cli.cmd, [...cli.args, "--version"], { encoding: "utf8", windowsHide: true, timeout: 30_000 });
  return (res.stdout ?? "").match(/\d+\.\d+\.\d+/)?.[0] ?? null;
}

async function ask(question, yes) {
  if (yes || !process.stdin.isTTY) return true;
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const answer = (await rl.question(`  ? ${question} [Y/n] `)).trim().toLowerCase();
  rl.close();
  return answer === "" || answer.startsWith("y");
}

async function main() {
  const opts = parseArgs(process.argv.slice(2), { yes: "bool", uninstall: "bool", home: "string" });
  const home = opts.home ?? homedir();
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");

  console.log(opts.uninstall ? "claude-sidekicks: uninstalling" : "claude-sidekicks: installing");
  console.log(`  from ${ROOT}\n`);

  // Paths go into config files and into shell commands Claude runs, so refuse
  // the few characters that could break out of the quoting.
  if (/[\u0000-\u001f"$`]/.test(ROOT)) {
    throw new Abort('This folder\'s path contains a quote, $, ` or a control character. Move it to a plainer path and re-run.');
  }

  const [major] = process.versions.node.split(".").map(Number);
  if (major < 18) throw new Abort(`Node ${process.versions.node} is too old; install Node 18 or newer.`);

  const claude = resolveCli("claude");
  const codex = resolveCli("codex");
  const agyCli = resolveCli("agy");

  if (!opts.uninstall) {
    if (!claude) throw new Abort("claude not found on PATH. Install Claude Code first: https://claude.com/claude-code");
    ok(`claude ${version(claude) ?? ""}`.trim());
    if (codex) {
      const v = version(codex);
      ok(`codex ${v ?? ""}`.trim());
      const [maj, min] = (v ?? "0.999").split(".").map(Number);
      if (maj === 0 && min < 144) warn("Codex older than 0.144 lacks features this needs. Update: npm install -g @openai/codex@latest");
    } else {
      warn("codex not found; skipping Codex. Install it later and re-run: npm install -g @openai/codex");
    }
    if (agyCli) ok(`agy ${version(agyCli) ?? ""}`.trim());
    else warn("agy not found; skipping Antigravity. Install Antigravity, run `agy install`, then re-run.");
    if (!codex && !agyCli) throw new Abort("Neither codex nor agy is installed, so there is nothing to connect.");
    console.log();
  }

  updateClaudeMd(join(home, ".claude", "CLAUDE.md"), opts.uninstall, stamp);

  if (codex || opts.uninstall) updateCodexConfig(join(home, ".codex", "config.toml"), opts.uninstall, stamp);

  if (agyCli && !opts.home) {
    const wanted = opts.uninstall ? false : await ask("Also let Antigravity call Claude (registers an MCP server)?", opts.yes);
    updateAgy(agyCli, opts.uninstall, wanted);
  }

  console.log();
  if (opts.uninstall) {
    console.log("Done. Backups of changed files sit next to them as *.bak-<time>.");
  } else {
    console.log("Done. Last steps:");
    console.log("  - Restart Codex and Antigravity so they load the new config.");
    console.log("  - Keep this folder where it is; the configs point here.");
    console.log("  - Not signed in yet? Run claude, codex and agy once each and log in.");
  }
}

main().catch((err) => {
  console.error(`\n  ✗ ${err.message}`);
  process.exit(1);
});
