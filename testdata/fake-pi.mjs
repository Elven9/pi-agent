#!/usr/bin/env node
// Stand-in for the pi CLI in wrapper tests. Replays a recorded `pi --mode json` stream.
//
//   FAKE_PI_EVENTS   JSONL file written to stdout (default: none)
//   FAKE_PI_SESSION  session file copied into --session-dir as <timestamp>_<id>.jsonl
//   FAKE_PI_STDERR   text written to stderr
//   FAKE_PI_EXIT     exit code (default 0)
//   FAKE_PI_HANG     if set, never exit (for interrupt tests)
//   FAKE_PI_ARGS     file that receives the argv as JSON
import { copyFileSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const argv = process.argv.slice(2);
const env = process.env;
if (env.FAKE_PI_ARGS) writeFileSync(env.FAKE_PI_ARGS, JSON.stringify(argv));
if (env.FAKE_PI_STDERR) process.stderr.write(env.FAKE_PI_STDERR);

if (env.FAKE_PI_SESSION) {
  const header = JSON.parse(readFileSync(env.FAKE_PI_SESSION, "utf8").split("\n", 1)[0]);
  const dir = argv[argv.indexOf("--session-dir") + 1];
  copyFileSync(env.FAKE_PI_SESSION, join(dir, `2026-01-01T00-00-00-000Z_${header.id}.jsonl`));
}
if (env.FAKE_PI_EVENTS) process.stdout.write(readFileSync(env.FAKE_PI_EVENTS));

if (env.FAKE_PI_HANG) setInterval(() => {}, 1000);
else process.exitCode = Number(env.FAKE_PI_EXIT ?? 0);
