# claude-sidekicks

Let **Claude Code**, **Codex** and **Antigravity** call each other, so you never copy and
paste between them. Everything runs on the subscriptions you already have (Claude, ChatGPT,
Google). No API keys, no dependencies, just Node.

| From | To | How |
|---|---|---|
| Claude | Codex | `bin/ask-codex.mjs` (Claude runs it from its shell) |
| Claude | Antigravity | `bin/ask-agy.mjs` |
| Claude | Codex image generation | `bin/codex-image.mjs` |
| Claude | Antigravity image generation | `bin/agy-image.mjs` |
| Codex | Claude | MCP server `server/claude-mcp.mjs`: tools `ask_claude`, `ask_claude_write` |
| Antigravity | Claude | the same MCP server, registered with `agy mcp add` |

Everything is **read-only by default**. Each agent only changes files when you ask for that
explicitly.

Not affiliated with Anthropic, OpenAI or Google. MIT licensed.

## Requirements

- Node.js 18 or newer
- The `claude` CLI, installed and signed in
- At least one of: the `codex` CLI, or the Antigravity CLI `agy` (installed and signed in)

## Install

Clone the repo somewhere permanent, then run the installer from inside it:

```bash
git clone https://github.com/tanviralamtusar/claude-sidekicks.git
cd claude-sidekicks
bash install.sh          # macOS / Linux
.\install.ps1            # Windows PowerShell
```

The installer:

1. Checks that `claude`, `codex` and `agy` are installed. It skips whichever of Codex and
   Antigravity you don't have.
2. Adds a section to `~/.claude/CLAUDE.md` that teaches Claude how to use Codex and
   Antigravity.
3. Registers the Claude MCP server with Codex (`~/.codex/config.toml`). It also offers to
   register it with Antigravity (`agy mcp add`).

When it's done, restart Codex and Antigravity. **Keep the folder where it is**, because the
configs point at it.

The installer is safe to run again: it updates its own sections in place. It backs up every
file before changing it (`*.bak-<time>`). It also replaces leftovers from older
Codex-relay setups, but leaves anything it didn't create alone.

| Command | What it does |
|---|---|
| `bash install.sh --yes` | Install without prompts |
| `bash install.sh --uninstall` | Remove everything it added |

### Let an AI do the setup

Paste the prompt below into Claude Code, Codex or Antigravity. The agent needs permission to
run shell commands and to write to your home folder. In Codex, that means not running it in
the read-only sandbox.

```text
Set up claude-sidekicks (https://github.com/tanviralamtusar/claude-sidekicks) on this
machine. It lets Claude Code, Codex and Antigravity call each other. Do these steps in
order, and stop and tell me if any step fails:

1. Check the prerequisites with `node --version` (it must be 18 or newer), then
   `claude --version`, `codex --version` and `agy --version`. Claude is required. At least
   one of codex or agy is required. Tell me which ones are installed.
2. Clone the repo into a permanent folder in my home directory:
   `git clone https://github.com/tanviralamtusar/claude-sidekicks.git ~/claude-sidekicks`.
   If that folder already exists, run `git pull` inside it instead.
3. From inside that folder, run the installer without prompts:
   - macOS/Linux: `bash install.sh --yes`
   - Windows PowerShell: `.\install.ps1 --yes`
     (if scripts are blocked: `powershell -ExecutionPolicy Bypass -File install.ps1 --yes`)
4. Show me the installer output and list each file it changed. It backs up changed files as
   *.bak-<time> next to them.
5. Run `npm test` in the folder and report the pass/fail counts.
6. Smoke-test each installed agent from that folder, using a heredoc as stdin:
   - Codex: `node bin/ask-codex.mjs`, sending the prompt "Reply with only the name
     field from package.json."
   - Antigravity: `node bin/ask-agy.mjs`, sending the same prompt.
   Both should answer `claude-sidekicks`.
7. Remind me to restart Codex and Antigravity so they load the new config, and not to
   move the folder, because the configs point at it.

Don't edit ~/.claude/CLAUDE.md, ~/.codex/config.toml or the Antigravity MCP list by hand.
The installer manages them.
```

## Use it

**In Claude:**
> "Have Codex review this diff."
> "Ask Antigravity for a second opinion on `src/auth.ts`."
> "Get Codex to generate a hero image into `public/hero.png`."
> "Let Antigravity fix the failing test." (Claude adds `--write`)

**In Codex or Antigravity:**
> "Ask Claude to review app.py."
> "Have Claude refactor this file." (uses `ask_claude_write`, which always asks for approval)

You can also run the wrappers yourself:

```bash
node bin/ask-codex.mjs --help
node bin/ask-agy.mjs --effort high <<'EOF'
Review src/ for race conditions. Reply with a short list.
EOF
node bin/codex-image.mjs "a flat blue circle" out.png
node bin/agy-image.mjs "a flat blue circle" out.png   # prints out.jpg if agy made a JPEG
```

| Option | Applies to | Meaning |
|---|---|---|
| `--write` | ask-codex, ask-agy | Allow edits in the real folder (default: read-only) |
| `--cd DIR` | ask-codex, ask-agy | Folder to work in (default: current folder) |
| `--model NAME` | all | Model to use (default: that CLI's default) |
| `--effort LEVEL` | all | Codex: minimal to xhigh. agy: low, medium, high, xhigh, max |
| `--timeout SEC` | all | Hard limit, default 540 s (under Claude's 10-minute tool limit) |

## How it stays safe

- **Codex, read-only:** runs in `--sandbox read-only`. With `--write` it runs in
  `workspace-write`, which limits edits to the working folder.
- **Antigravity, read-only:** `agy` has no read-only mode that works headless, so the wrapper
  copies the folder to a temp directory and runs `agy` there. The copy leaves out
  `node_modules`, virtualenvs, caches and symlinks. Anything `agy` changes is discarded with
  the copy.
- **`ask_claude`:** runs `claude -p --safe-mode`, so none of your hooks, plugins, MCP
  servers, CLAUDE.md or skills load. On top of that, the shell, file editing and web tools
  are switched off.
- **`ask_claude_write`:** may edit files but can't run commands. It loads only your
  user-level settings, so a cloned repo can't slip its own hooks or MCP servers in. Only
  `ask_claude` is auto-approved in Codex. Approving the write tool would let any text Codex
  reads (a web page, a README) trigger edits without you seeing them.
- **Folder:** Claude runs in the client's workspace folder (from MCP roots, or the folder
  the server started in). The model calling the tool can't change it.
- **Finding the CLIs:** they are looked up on `PATH`, skipping relative entries, so a repo
  can't plant a fake `claude`, `codex` or `agy`. npm's Windows `.cmd` shims are run through
  Node directly, never through a shell.
- **Prompts:** always passed over stdin, so they stay out of process lists and Windows
  command-line limits.
- **Limits on every call:** a timeout that kills the whole process tree, an output cap, at
  most 4 parallel Claude calls, and support for MCP cancellation.
- **Recursion guard:** the wrappers and the server refuse to go more than 2 agent hops deep
  (for example Claude, then Codex, then Claude). The hop count travels in the
  `SIDEKICKS_DEPTH` environment variable. A host that clears environment variables for
  MCP servers can bypass this, so it is best effort.

## Known limits

- **Each call starts fresh.** The other agent has no memory of your conversation, so prompts
  must be self-contained.
- **Rate limits are shared.** Codex CLI calls draw on the same ChatGPT limits as the app,
  and `agy` calls on your Google quota.
- **Images use Codex or Antigravity.** They come from each CLI's built-in image tool.
  Video isn't supported. `agy` saves images in its conversation folder
  (`~/.gemini/antigravity-cli/brain/<id>/`), and `agy-image.mjs` copies them from there
  itself, because headless `agy` can't run the shell command a copy would need. In print
  mode `agy` sometimes ends its turn before the image is done; the wrapper then resumes the
  same conversation (up to 3 rounds) until the image shows up.
- **Pinned Codex models can break `codex exec`.** If your Codex config pins a
  `model = "..."` that has since been retired, every `codex exec` run fails with "model
  rejected". Delete that line and Codex uses its current default. The installer warns you
  about this.

## Development

```bash
npm test     # protocol tests for the MCP server (with a fake claude) and installer tests
```

The tests need no network and no API calls. The installer tests run against a throwaway
home folder.
