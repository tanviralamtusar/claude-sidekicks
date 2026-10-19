// Tests for install.mjs against a throwaway home folder.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const INSTALL = join(dirname(fileURLToPath(import.meta.url)), "..", "install.mjs");

function freshHome(files = {}) {
  const home = mkdtempSync(join(tmpdir(), "sidekicks-home-"));
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(home, rel)), { recursive: true });
    writeFileSync(join(home, rel), text);
  }
  return home;
}

function install(home, ...extra) {
  const res = spawnSync(process.execPath, [INSTALL, "--yes", "--home", home, ...extra], { encoding: "utf8" });
  return { ...res, md: read(home, ".claude/CLAUDE.md"), toml: read(home, ".codex/config.toml") };
}
const read = (home, rel) => (existsSync(join(home, rel)) ? readFileSync(join(home, rel), "utf8") : null);
const count = (text, needle) => text.split(needle).length - 1;

const LEGACY_MD = `# My rules
Be nice.

# Codex is always available

Use it:
\`\`\`bash
codex exec --sandbox read-only - <<'X'
# not a heading, inside a fence
X
\`\`\`

# Antigravity is always available

Run agy like this.

# Later section
Keep me.
`;

const LEGACY_TOML = `model = "gpt-x"

[mcp_servers.other]
command = "x"

[mcp_servers.claude]
command = "C:/node.exe"
args = ["C:/Users/me/old-relay/ask-claude-mcp.mjs"]
tool_timeout_sec = 600

[mcp_servers.claude.tools.ask_claude]
approval_mode = "approve"

[projects.'c:\\code']
trust_level = "trusted"
`;

test("install replaces legacy sections and is idempotent", (t) => {
  const home = freshHome({ ".claude/CLAUDE.md": LEGACY_MD, ".codex/config.toml": LEGACY_TOML });
  const first = install(home);
  if (first.status !== 0 && /claude not found|Neither codex/.test(first.stderr)) {
    return t.skip("claude/codex not installed on this machine");
  }
  assert.equal(first.status, 0, first.stderr);

  // Markdown: old sections gone, user content kept, one managed section.
  assert.doesNotMatch(first.md, /Codex is always available|Antigravity is always available/);
  assert.match(first.md, /# My rules\nBe nice\./);
  assert.match(first.md, /# Later section\nKeep me\./);
  assert.equal(count(first.md, "claude-sidekicks:begin"), 1);
  assert.match(first.md, /bin\/ask-agy\.mjs/);
  assert.doesNotMatch(first.md, /\{\{BIN\}\}/);

  // TOML: old relay replaced, everything else kept.
  assert.doesNotMatch(first.toml, /ask-claude-mcp/);
  assert.equal(count(first.toml, "[mcp_servers.claude]"), 1);
  assert.match(first.toml, /server\/claude-mcp\.mjs/);
  assert.match(first.toml, /\[mcp_servers\.other\]\ncommand = "x"/);
  assert.match(first.toml, /\[projects\.'c:\\code'\]\ntrust_level = "trusted"/);
  assert.match(first.toml, /^model = "gpt-x"/);

  // Backups were written.
  assert.ok(readdirSync(join(home, ".claude")).some((f) => f.startsWith("CLAUDE.md.bak-")));

  // Second run changes nothing.
  const second = install(home);
  assert.equal(second.status, 0, second.stderr);
  assert.equal(second.md, first.md);
  assert.equal(second.toml, first.toml);
  assert.match(second.stdout, /already up to date/);

  // Uninstall removes our parts and keeps the rest.
  const gone = install(home, "--uninstall");
  assert.equal(gone.status, 0, gone.stderr);
  assert.doesNotMatch(gone.md, /sidekicks/);
  assert.match(gone.md, /Keep me\./);
  assert.doesNotMatch(gone.toml, /mcp_servers\.claude|sidekicks/);
  assert.match(gone.toml, /\[mcp_servers\.other\]/);
});

test("leaves a user's own [mcp_servers.claude] alone", (t) => {
  const own = `[mcp_servers.claude]\ncommand = "my-own-thing"\n`;
  const home = freshHome({ ".codex/config.toml": own });
  const res = install(home);
  if (res.status !== 0 && /claude not found|Neither codex/.test(res.stderr)) return t.skip("tools not installed");
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.toml, own);
  assert.match(res.stdout, /isn't from this project/);
});

test("refuses a begin marker without an end marker", (t) => {
  const home = freshHome({ ".claude/CLAUDE.md": "<!-- claude-sidekicks:begin (x) -->\nstuff\n" });
  const res = install(home);
  if (res.status !== 0 && /claude not found|Neither codex/.test(res.stderr)) return t.skip("tools not installed");
  assert.equal(res.status, 1);
  assert.match(res.stderr, /without its end marker/);
});
