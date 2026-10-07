import { test } from "node:test";
import assert from "node:assert/strict";
import { splitSystemPrompt } from "./cache-split.ts";

const marker = { type: "ephemeral" };
const B = "<project>\nname: x\n</project>\n\n<project_rules>\n- r\n</project_rules>";
const PROMPT = `You are a test agent.\n\n<cwd>\n/sandbox\n</cwd>\n\n${B}`;
const tools = [{ name: "read" }, { name: "bash", cache_control: marker }];
const messages = [{ role: "user", content: [{ type: "text", text: "go", cache_control: marker }] }];

/** Markers in a request, in order, labelled by where they are. */
function markers(payload: any): string[] {
  const found: string[] = [];
  payload.tools?.forEach((t: any) => t.cache_control && found.push(`tool:${t.name}`));
  payload.system?.forEach((b: any, i: number) => b.cache_control && found.push(`system:${i}`));
  payload.messages?.forEach((m: any, i: number) =>
    m.content.forEach((c: any) => c.cache_control && found.push(`message:${i}`)),
  );
  return found;
}

test("API key: one system block becomes A + B, the tools marker goes", () => {
  const payload = { model: "m", tools, system: [{ type: "text", text: PROMPT, cache_control: marker }], messages };
  const out = splitSystemPrompt(payload, B) as any;
  assert.deepEqual(out.system, [
    { type: "text", text: "You are a test agent.\n\n<cwd>\n/sandbox\n</cwd>", cache_control: marker },
    { type: "text", text: B, cache_control: marker },
  ]);
  assert.deepEqual(markers(out), ["system:0", "system:1", "message:0"]);
  assert.equal(out.system[0].text + "\n\n" + out.system[1].text, PROMPT); // same text, same order
  assert.equal(out.model, "m");
  assert.deepEqual(markers(payload), ["tool:bash", "system:0", "message:0"]); // input untouched
});

test("OAuth: the identity block keeps its text but loses its marker", () => {
  const ttl = { type: "ephemeral", ttl: "1h" };
  const identity = { type: "text", text: "You are Claude Code, Anthropic's official CLI for Claude.", cache_control: ttl };
  const payload = { tools, system: [identity, { type: "text", text: PROMPT, cache_control: ttl }], messages };
  const out = splitSystemPrompt(payload, B) as any;
  assert.deepEqual(out.system.map((b: any) => b.text.slice(0, 12)), ["You are Clau", "You are a te", "<project>\nna"]);
  assert.deepEqual(markers(out), ["system:1", "system:2", "message:0"]);
  assert.deepEqual(out.system[2].cache_control, ttl); // TTL kept as pi set it
});

test("sections after block B stay in B", () => {
  const prompt = `${PROMPT}\n\n<other>\nz\n</other>`;
  const out = splitSystemPrompt({ system: [{ type: "text", text: prompt, cache_control: marker }] }, B) as any;
  assert.equal(out.system[1].text, `${B}\n\n<other>\nz\n</other>`);
});

test("leaves other requests unchanged", () => {
  const sys = (text: string, cc: object | undefined = marker) => ({ system: [{ type: "text", text, cache_control: cc }] });
  assert.equal(splitSystemPrompt(sys(PROMPT), ""), undefined); // no block B
  assert.equal(splitSystemPrompt(sys("Summarize the conversation."), B), undefined); // compaction request
  assert.equal(splitSystemPrompt(sys(B), B), undefined); // nothing before B
  assert.equal(splitSystemPrompt({ ...sys(PROMPT), system: [{ type: "text", text: PROMPT }] }, B), undefined); // caching off
  assert.equal(splitSystemPrompt({ input: [] }, B), undefined); // another API
  assert.equal(splitSystemPrompt(null, B), undefined);
});
