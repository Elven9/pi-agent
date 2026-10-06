import { test } from "node:test";
import assert from "node:assert/strict";
import { JsonlSplitter } from "./events.ts";

function split(chunks: Buffer[]): string[] {
  const lines: string[] = [];
  const s = new JsonlSplitter((l) => lines.push(l));
  for (const c of chunks) s.push(c);
  s.end();
  return lines;
}

test("splits on LF only, strips CR, skips blank lines, keeps a final unterminated line", () => {
  const text = '{"a":"x\u2028y\u2029z"}\r\n\n{"b":1}\n{"c":2}';
  assert.deepEqual(split([Buffer.from(text)]), ['{"a":"x\u2028y\u2029z"}', '{"b":1}', '{"c":2}']);
});

test("joins records and multi-byte characters split across chunks", () => {
  const bytes = Buffer.from('{"t":"héllo 🙂"}\n{"u":2}\n');
  const chunks = [];
  for (let i = 0; i < bytes.length; i += 3) chunks.push(bytes.subarray(i, i + 3));
  assert.deepEqual(split(chunks), ['{"t":"héllo 🙂"}', '{"u":2}']);
});
