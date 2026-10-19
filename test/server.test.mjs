// Protocol tests for server/claude-mcp.mjs, using a fake `claude`.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SERVER = join(HERE, "..", "server", "claude-mcp.mjs");
const FAKE = join(HERE, "fixtures", "fake-claude.mjs");

// Start the server and return helpers to talk to it.
function startServer(env = {}) {
  const proc = spawn(process.execPath, [SERVER], {
    env: { ...process.env, SIDEKICKS_CLAUDE_BIN: FAKE, SIDEKICKS_DEPTH: "", ...env },
    stdio: ["pipe", "pipe", "inherit"],
  });
  proc.stdout.setEncoding("utf8");
  const messages = [];
  const waiters = [];
  let buf = "";
  proc.stdout.on("data", (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf("\n")) !== -1) {
      const msg = JSON.parse(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
      messages.push(msg);
      for (const w of [...waiters]) w();
    }
  });
  const sendRaw = (text) => proc.stdin.write(text + "\n");
  const send = (msg) => sendRaw(JSON.stringify({ jsonrpc: "2.0", ...msg }));
  const next = (pred, ms = 10_000) =>
    new Promise((resolve, reject) => {
      const check = () => {
        const i = messages.findIndex(pred);
        if (i === -1) return false;
        resolve(messages.splice(i, 1)[0]);
        return true;
      };
      if (check()) return;
      const timer = setTimeout(() => reject(new Error("timed out waiting for message")), ms);
      const w = () => {
        if (check()) {
          clearTimeout(timer);
          waiters.splice(waiters.indexOf(w), 1);
        }
      };
      waiters.push(w);
    });
  const call = async (id, name, args) => {
    send({ id, method: "tools/call", params: { name, arguments: args } });
    return next((m) => m.id === id);
  };
  const stop = () => proc.stdin.end();
  return { proc, send, sendRaw, next, call, stop, messages };
}

test("initialize, ping and tools/list", async () => {
  const s = startServer();
  s.send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {} } });
  const init = await s.next((m) => m.id === 1);
  assert.equal(init.result.protocolVersion, "2025-06-18");
  assert.equal(init.result.serverInfo.name, "claude-sidekicks");

  s.send({ id: 2, method: "initialize", params: { protocolVersion: "1999-01-01" } });
  assert.equal((await s.next((m) => m.id === 2)).result.protocolVersion, "2025-06-18");

  s.send({ id: 3, method: "ping" });
  assert.deepEqual((await s.next((m) => m.id === 3)).result, {});

  s.send({ id: 4, method: "tools/list" });
  const names = (await s.next((m) => m.id === 4)).result.tools.map((t) => t.name);
  assert.deepEqual(names, ["ask_claude", "ask_claude_write"]);
  s.stop();
});

test("bad input gets error replies, never silence", async () => {
  const s = startServer();
  s.sendRaw("{not json");
  assert.equal((await s.next((m) => m.error?.code === -32700)).id, null);
  s.send({ id: 5, method: "nope" });
  assert.equal((await s.next((m) => m.id === 5)).error.code, -32601);
  s.send({ id: 6, method: "tools/call", params: { name: "missing" } });
  assert.equal((await s.next((m) => m.id === 6)).error.code, -32602);
  const empty = await s.call(7, "ask_claude", { prompt: "   " });
  assert.equal(empty.result.isError, true);
  const badModel = await s.call(8, "ask_claude", { prompt: "hi", model: "x; rm -rf /" });
  assert.equal(badModel.result.isError, true);
  s.send({ id: 9 }); // no method at all
  s.send({ method: "notifications/initialized" }); // notification: no reply
  s.send({ id: 10, method: "ping" });
  await s.next((m) => m.id === 10);
  assert.equal(s.messages.length, 0);
  s.stop();
});

test("read-only call: prompt via stdin, side-effect tools disabled, depth bumped", async () => {
  const s = startServer();
  const res = await s.call(1, "ask_claude", { prompt: "hello", model: "opus", effort: "high" });
  assert.equal(res.result.isError, false);
  const seen = JSON.parse(res.result.content[0].text);
  assert.equal(seen.prompt, "hello");
  assert.equal(seen.depth, "1");
  for (const flag of ["-p", "--safe-mode", "--strict-mcp-config", "--disallowedTools", "Bash", "Edit", "Write"]) {
    assert.ok(seen.args.includes(flag), `missing ${flag}`);
  }
  assert.deepEqual(seen.args.slice(-4), ["--model", "opus", "--effort", "high"]);
  s.stop();
});

test("write call: accepts edits, user settings only, no shell", async () => {
  const s = startServer();
  const seen = JSON.parse((await s.call(1, "ask_claude_write", { prompt: "edit" })).result.content[0].text);
  assert.ok(seen.args.includes("acceptEdits"));
  assert.ok(seen.args.includes("--setting-sources"));
  assert.ok(seen.args.includes("Bash"));
  assert.ok(!seen.args.includes("--safe-mode"));
  s.stop();
});

test("claude errors and garbage output are reported as tool errors", async () => {
  const s = startServer();
  const failed = await s.call(1, "ask_claude", { prompt: "FAIL" });
  assert.equal(failed.result.isError, true);
  assert.equal(failed.result.content[0].text, "boom");
  const garbage = await s.call(2, "ask_claude", { prompt: "GARBAGE" });
  assert.equal(garbage.result.isError, true);
  assert.match(garbage.result.content[0].text, /exited with code 3/);
  s.stop();
});

test("answers are cleaned of escape codes and private keys", async () => {
  const s = startServer();
  const res = await s.call(1, "ask_claude", { prompt: "DIRTY" });
  assert.equal(res.result.content[0].text, "aredbc\td\n[redacted private key]");
  s.stop();
});

test("timeouts kill claude and report it", async () => {
  const s = startServer({ SIDEKICKS_TIMEOUT_SEC: "1" });
  const res = await s.call(1, "ask_claude", { prompt: "SLEEP" });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /timed out/);
  s.stop();
});

test("cancelled requests are killed and get no reply", async () => {
  const s = startServer();
  s.send({ id: 1, method: "tools/call", params: { name: "ask_claude", arguments: { prompt: "SLEEP" } } });
  await new Promise((r) => setTimeout(r, 500));
  s.send({ method: "notifications/cancelled", params: { requestId: 1 } });
  s.send({ id: 2, method: "ping" });
  await s.next((m) => m.id === 2);
  await new Promise((r) => setTimeout(r, 1000));
  assert.equal(s.messages.filter((m) => m.id === 1).length, 0);
  s.stop();
});

test("recursion guard refuses past the depth limit", async () => {
  const s = startServer({ SIDEKICKS_DEPTH: "2" });
  const res = await s.call(1, "ask_claude", { prompt: "hi" });
  assert.equal(res.result.isError, true);
  assert.match(res.result.content[0].text, /hops deep/);
  s.stop();
});

test("runs claude in the client's first root folder", async () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "sidekicks-root-")));
  const s = startServer();
  s.send({ id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: { roots: {} } } });
  await s.next((m) => m.id === 1);
  s.send({ method: "notifications/initialized" });
  const req = await s.next((m) => m.method === "roots/list");
  s.send({ id: req.id, result: { roots: [{ uri: pathToFileURL(root).href, name: "ws" }] } });
  const seen = JSON.parse((await s.call(2, "ask_claude", { prompt: "where" })).result.content[0].text);
  assert.equal(realpathSync(seen.cwd), root);
  s.stop();
});
