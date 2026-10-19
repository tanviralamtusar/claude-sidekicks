// Stand-in for `claude -p` in tests. What it does depends on the prompt.
let prompt = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) prompt += chunk;

const out = (obj) => process.stdout.write(JSON.stringify(obj));
if (prompt === "SLEEP") {
  setTimeout(() => {}, 60_000);
} else if (prompt === "GARBAGE") {
  process.stdout.write("not json");
  process.exit(3);
} else if (prompt === "DIRTY") {
  const key = "-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----";
  out({ is_error: false, result: `a\u001b[31mred\u001b[0m\u001b]0;title\u0007b\u0000c\td\n${key}\u001b` });
} else if (prompt === "FAIL") {
  out({ is_error: true, result: "boom" });
} else {
  out({
    is_error: false,
    result: JSON.stringify({ prompt, args: process.argv.slice(2), cwd: process.cwd(), depth: process.env.SIDEKICKS_DEPTH }),
  });
}
