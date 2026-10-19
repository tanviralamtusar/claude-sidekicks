#!/usr/bin/env node
// MCP server (stdio) that lets other agents, such as Codex and Antigravity,
// ask Claude Code for help. Two tools:
//
//   ask_claude        read-only: review, explain, second opinion
//   ask_claude_write  may edit files in the working folder
//
// Each call runs `claude -p` (answer one prompt, then exit) in the folder the
// server was started in and returns Claude's answer. No dependencies.

import { statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  MAX_DEPTH,
  childEnv,
  currentDepth,
  killTree,
  resolveCli,
  runProcess,
} from "../lib/common.mjs";

const VERSION = "2.0.0";
const SUPPORTED_PROTOCOLS = ["2024-11-05", "2025-03-26", "2025-06-18", "2025-11-25"];

const envInt = (name, fallback) => {
  const n = Number.parseInt(process.env[name] ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
};
const TIMEOUT_MS = envInt("SIDEKICKS_TIMEOUT_SEC", 600) * 1000; // kill a stuck Claude
const MAX_CONCURRENT = envInt("SIDEKICKS_MAX_CONCURRENT", 4);
const MAX_OUTPUT_CHARS = 2 * 1024 * 1024;
const MAX_PROMPT_CHARS = 1024 * 1024;
const MAX_LINE_CHARS = 8 * 1024 * 1024;

// Claude runs in the client's workspace: the first folder the client lists
// as an MCP root, or else the folder the server was started in. The model
// calling the tools has no say in this.
let workspace = process.cwd();

// Tools that change things. Read-only calls run with all of them switched off,
// on top of --safe-mode (no hooks, plugins, MCP servers, CLAUDE.md or skills).
const SIDE_EFFECT_TOOLS = ["Bash", "PowerShell", "Edit", "Write", "NotebookEdit", "WebFetch", "WebSearch"];

const NOTE =
  " Claude sees the files on disk, so refer to them by path. Claude has no memory " +
  "of your conversation: send one complete, self-contained instruction.";

const inputSchema = {
  type: "object",
  properties: {
    prompt: { type: "string", description: "A complete, self-contained instruction for Claude." },
    model: { type: "string", description: "Optional Claude model alias or name, e.g. 'opus' or 'sonnet'." },
    effort: {
      type: "string",
      enum: ["low", "medium", "high", "xhigh", "max"],
      description: "Optional reasoning effort.",
    },
  },
  required: ["prompt"],
  additionalProperties: false,
};

const TOOLS = [
  {
    name: "ask_claude",
    title: "Ask Claude (read-only)",
    description:
      "Ask Claude Code about the code in this workspace and get its answer. Claude can read " +
      "files but cannot edit them, run commands, or browse the web. Use for code review, " +
      "second opinions, and explanations." + NOTE,
    inputSchema,
    annotations: { readOnlyHint: true, openWorldHint: false },
  },
  {
    name: "ask_claude_write",
    title: "Ask Claude to make changes",
    description:
      "Ask Claude Code to change code in this workspace (fixes, refactors, new code). " +
      "Claude MAY edit files. It cannot run shell commands." + NOTE,
    inputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: false },
  },
];

const CLAUDE = resolveCli("claude", "SIDEKICKS_CLAUDE_BIN");
const running = new Map(); // JSON-RPC request id -> child process
const cancelled = new Set(); // request ids the client cancelled

function claudeArgs(write, { model, effort }) {
  const args = ["-p", "--output-format", "json"];
  if (write) {
    // Edits are auto-accepted. Only user-level settings load, so hooks,
    // plugins or MCP servers shipped inside a cloned repo can't join in.
    args.push("--permission-mode", "acceptEdits", "--setting-sources", "user");
    args.push("--disallowedTools", "Bash", "PowerShell");
  } else {
    args.push("--safe-mode", "--strict-mcp-config");
    args.push("--disallowedTools", ...SIDE_EFFECT_TOOLS);
  }
  if (model) args.push("--model", model);
  if (effort) args.push("--effort", effort);
  return args;
}

function validate(a) {
  if (typeof a.prompt !== "string" || !a.prompt.trim()) return "`prompt` must be a non-empty string.";
  if (a.prompt.length > MAX_PROMPT_CHARS) return "`prompt` is too long (limit 1 MB).";
  if (a.model !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._:\[\]-]{0,99}$/.test(String(a.model))) {
    return "`model` contains unexpected characters.";
  }
  if (a.effort !== undefined && !inputSchema.properties.effort.enum.includes(a.effort)) {
    return `\`effort\` must be one of: ${inputSchema.properties.effort.enum.join(", ")}.`;
  }
  return null;
}

async function askClaude(requestId, write, a) {
  const problem = validate(a);
  if (problem) return { ok: false, text: problem };
  if (!CLAUDE) {
    return { ok: false, text: "The claude CLI was not found on PATH. Install Claude Code and sign in once." };
  }
  if (currentDepth() >= MAX_DEPTH) {
    return { ok: false, text: `Refusing to call Claude: already ${currentDepth()} assistant hops deep.` };
  }
  if (rootsPending) await rootsPending;
  if (running.size >= MAX_CONCURRENT) {
    return { ok: false, text: `Too many Claude calls at once (limit ${MAX_CONCURRENT}). Try again shortly.` };
  }

  // The prompt goes in over stdin so it never shows in the process list.
  const { child, done } = runProcess({
    cli: CLAUDE,
    args: claudeArgs(write, a),
    cwd: workspace,
    input: a.prompt,
    env: childEnv(),
    timeoutMs: TIMEOUT_MS,
    maxOutput: MAX_OUTPUT_CHARS,
  });
  running.set(requestId, child);
  const res = await done;
  running.delete(requestId);
  // The spec says a cancelled request gets no response at all.
  if (cancelled.delete(requestId)) return null;

  if (res.error) return { ok: false, text: `Failed to launch claude: ${res.error.message}` };
  if (res.timedOut) return { ok: false, text: `Claude timed out after ${TIMEOUT_MS / 60000} minutes.` };
  if (res.overflow) return { ok: false, text: "Claude's answer was over the 2 MB cap; aborted." };
  try {
    const parsed = JSON.parse(res.stdout);
    if (parsed.is_error) return { ok: false, text: parsed.result || "Claude reported an error." };
    return { ok: true, text: String(parsed.result ?? "") };
  } catch {
    const detail = (res.stderr || res.stdout).trim().slice(-4000);
    return { ok: false, text: `claude exited with code ${res.code} and no usable answer.\n${detail}`.trim() };
  }
}

// Clean Claude's answer before it lands in the caller's context: drop
// terminal escape sequences and control characters (newlines, tabs and
// carriage returns survive), and blank out PEM private keys. The key check
// is a safety net, not a guarantee that no secret slips through.
const ESC = "\u001b";
const BEL = "\u0007";
const PEM_KEY = /-{5}BEGIN ((?:[A-Z0-9]+ )*)PRIVATE KEY-{5}[^]*?-{5}END \1PRIVATE KEY-{5}/g;
const KEEP = new Set(["\n", "\t", "\r"]);

function stripEscapes(text) {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === ESC) {
      const kind = text[i + 1];
      if (kind === "[") {
        // CSI: parameters and intermediates, then one final byte in @..~
        i += 2;
        while (i < text.length && !(text[i] >= "@" && text[i] <= "~")) i++;
      } else if (kind === "]") {
        // OSC: runs until BEL or ESC backslash
        i += 2;
        while (i < text.length && text[i] !== BEL && !(text[i] === ESC && text[i + 1] === "\\")) i++;
        if (text[i] === ESC) i++;
      } else {
        i++; // two-character escape, or a lone ESC at the end
      }
      continue;
    }
    const code = ch.charCodeAt(0);
    if ((code < 0x20 && !KEEP.has(ch)) || code === 0x7f) continue;
    out += ch;
  }
  return out;
}

function sanitize(text) {
  return stripEscapes(String(text)).replace(PEM_KEY, "[redacted private key]");
}

// ---------------------------------------------------------------------------
// JSON-RPC over stdio, one message per line

const send = (msg) => process.stdout.write(JSON.stringify(msg) + "\n");
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const fail = (id, code, message) => send({ jsonrpc: "2.0", id, error: { code, message } });

// Ask the client for its workspace folders (MCP "roots"), if it supports them.
// Tool calls wait (up to 2 s) for the answer so they run in the right folder.
let clientHasRoots = false;
let rootsRequest = 0;
let rootsPending = null;
let rootsDone = () => {};
function requestRoots() {
  if (!clientHasRoots) return;
  rootsPending = new Promise((res) => {
    rootsDone = res;
    setTimeout(res, 2000);
  });
  send({ jsonrpc: "2.0", id: `roots-${++rootsRequest}`, method: "roots/list" });
}
function onRoots(result) {
  rootsDone();
  for (const root of result?.roots ?? []) {
    try {
      const dir = fileURLToPath(root.uri);
      if (statSync(dir).isDirectory()) {
        workspace = dir;
        return;
      }
    } catch {}
  }
}

async function handle(msg) {
  if (!msg || typeof msg !== "object" || Array.isArray(msg)) {
    return fail(null, -32600, "Invalid request");
  }
  const { id, method, params } = msg;

  // A response to a request we sent (only roots/list).
  if (method === undefined) {
    if (typeof id === "string" && id.startsWith("roots-")) onRoots(msg.result);
    return;
  }

  // Notifications have no id and never get a reply.
  if (id === undefined || id === null) {
    if (method === "notifications/initialized" || method === "notifications/roots/list_changed") {
      requestRoots();
    } else if (method === "notifications/cancelled") {
      const child = running.get(params?.requestId);
      if (child) {
        cancelled.add(params.requestId);
        killTree(child);
      }
    }
    return;
  }

  switch (method) {
    case "initialize": {
      const asked = params?.protocolVersion;
      clientHasRoots = Boolean(params?.capabilities?.roots);
      return reply(id, {
        protocolVersion: SUPPORTED_PROTOCOLS.includes(asked) ? asked : "2025-06-18",
        capabilities: { tools: {} },
        serverInfo: { name: "claude-sidekicks", title: "Claude", version: VERSION },
      });
    }
    case "ping":
      return reply(id, {});
    case "tools/list":
      return reply(id, { tools: TOOLS });
    case "tools/call": {
      const tool = TOOLS.find((t) => t.name === params?.name);
      if (!tool) return fail(id, -32602, `Unknown tool: ${params?.name}`);
      const args = params.arguments && typeof params.arguments === "object" ? params.arguments : {};
      const result = await askClaude(id, tool.name === "ask_claude_write", args);
      if (!result) return;
      const { ok, text } = result;
      return reply(id, { content: [{ type: "text", text: sanitize(text) }], isError: !ok });
    }
    default:
      return fail(id, -32601, `Method not found: ${method}`);
  }
}

function onLine(line) {
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return fail(null, -32700, "Parse error");
  }
  // One bad call must never take the whole server down or leave a caller hanging.
  handle(msg).catch((err) => {
    if (msg?.id !== undefined && msg?.id !== null) fail(msg.id, -32603, `Internal error: ${err.message}`);
  });
}

// Read line by line. A line over the size cap is dropped, not buffered forever.
let buffer = "";
let discarding = false;
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  buffer += chunk;
  let nl;
  while ((nl = buffer.indexOf("\n")) !== -1) {
    const line = buffer.slice(0, nl);
    buffer = buffer.slice(nl + 1);
    if (discarding) {
      discarding = false; // this newline ends the dropped line
    } else if (line.length > MAX_LINE_CHARS) {
      fail(null, -32700, "Message too large; discarded.");
    } else if (line.trim()) {
      onLine(line.trim());
    }
  }
  if (!discarding && buffer.length > MAX_LINE_CHARS) {
    buffer = "";
    discarding = true;
    fail(null, -32700, "Message too large; discarded.");
  } else if (discarding) {
    buffer = "";
  }
});

// When the client goes away, take every running Claude with us.
function shutdown() {
  for (const child of running.values()) killTree(child);
  process.exit(0);
}
process.stdin.on("end", shutdown);
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"]) process.on(sig, shutdown);
