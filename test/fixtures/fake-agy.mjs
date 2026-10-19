// Stand-in for `agy --print` in tests. FAKE_AGY_MODE picks the behaviour:
//   image       saves an image on the first turn
//   late        ends the first turn early; saves the image when resumed
//   denied      saves an image, then fails on a denied tool call
//   never       never saves anything
//   png         saves a PNG instead of a JPEG
//   elsewhere   saves an image in another conversation's folder
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

let input = "";
process.stdin.setEncoding("utf8");
for await (const chunk of process.stdin) input += chunk;

const args = process.argv.slice(2);
const resumeAt = args.indexOf("--conversation");
const id = resumeAt === -1 ? "11111111-2222-3333-4444-555555555555" : args[resumeAt + 1];
const mode = process.env.FAKE_AGY_MODE;
const brain = process.env.SIDEKICKS_AGY_BRAIN;

const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(100)]);
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(100)]);
const save = (convId, name, bytes) => {
  mkdirSync(join(brain, convId), { recursive: true });
  writeFileSync(join(brain, convId, name), bytes);
};

const emit = (obj) => process.stdout.write(JSON.stringify(obj) + "\n");
emit({ event: "init", conversation_id: id, init: { cwd: process.cwd() } });

if (mode === "image" || (mode === "late" && resumeAt !== -1)) save(id, "dog_1.jpg", JPEG);
if (mode === "png") save(id, "dog_1.png", PNG);
if (mode === "elsewhere") save("99999999-0000-0000-0000-000000000000", "other.jpg", JPEG);
if (mode === "denied") {
  save(id, "dog_1.jpg", JPEG);
  emit({ event: "result", result: { conversation_id: id, status: "ERROR", error: "tool required the command permission" } });
  process.exit(1);
}

const response = resumeAt === -1 && mode === "late" ? "Waiting for the image generator subagent..." : "dog_1.jpg";
emit({ event: "result", result: { conversation_id: id, status: "SUCCESS", response, args, prompt: input } });
