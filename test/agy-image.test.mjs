// Tests for bin/agy-image.mjs, using a fake `agy`.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const SCRIPT = join(HERE, "..", "bin", "agy-image.mjs");
const FAKE = join(HERE, "fixtures", "fake-agy.mjs");

// Run the wrapper against a fresh brain folder. Returns the spawnSync result
// plus the folder the output was asked for.
function run(mode, outName = "out.png", extra = []) {
  const tmp = mkdtempSync(join(tmpdir(), "agy-image-test-"));
  const res = spawnSync(process.execPath, [SCRIPT, "a dog", join(tmp, "img", outName), ...extra], {
    encoding: "utf8",
    env: {
      ...process.env,
      SIDEKICKS_AGY_BIN: FAKE,
      SIDEKICKS_AGY_BRAIN: join(tmp, "brain"),
      SIDEKICKS_DEPTH: "",
      FAKE_AGY_MODE: mode,
    },
  });
  return { ...res, dir: join(tmp, "img") };
}

test("copies the image out of the conversation folder", () => {
  const r = run("image", "out.jpg");
  assert.equal(r.status, 0, r.stderr);
  const dest = join(r.dir, "out.jpg");
  assert.equal(r.stdout.trim(), dest);
  assert.equal(readFileSync(dest)[0], 0xff);
});

test("fixes an extension that doesn't match the image format", () => {
  const jpg = run("image", "out.png");
  assert.equal(jpg.status, 0, jpg.stderr);
  assert.equal(jpg.stdout.trim(), join(jpg.dir, "out.jpg"));
  assert.ok(!existsSync(join(jpg.dir, "out.png")));

  const png = run("png", "out.png");
  assert.equal(png.stdout.trim(), join(png.dir, "out.png"));

  const jpeg = run("image", "out.jpeg");
  assert.equal(jpeg.stdout.trim(), join(jpeg.dir, "out.jpeg"));
});

test("resumes the conversation when agy ends the turn before the image exists", () => {
  const r = run("late");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), join(r.dir, "out.jpg"));
});

test("still delivers an image that was saved before a denied tool call", () => {
  const r = run("denied");
  assert.equal(r.status, 0, r.stderr);
  assert.equal(r.stdout.trim(), join(r.dir, "out.jpg"));
});

test("ignores images in other conversations' folders", () => {
  const r = run("elsewhere");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /agy did not produce an image/);
  assert.ok(!existsSync(r.dir));
});

test("gives up with an error when no image ever appears", () => {
  const r = run("never");
  assert.equal(r.status, 1);
  assert.match(r.stderr, /agy did not produce an image/);
  assert.match(r.stderr, /Last answer:\ndog_1\.jpg/);
});

test("rejects bad arguments", () => {
  assert.equal(run("image", "out.png", ["--effort", "huge"]).status, 2);
  const tmp = mkdtempSync(join(tmpdir(), "agy-image-test-"));
  const empty = spawnSync(process.execPath, [SCRIPT, " <> ", join(tmp, "x.png")], { encoding: "utf8" });
  assert.equal(empty.status, 2);
});
