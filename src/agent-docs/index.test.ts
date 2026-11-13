import { test } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import agentDocs, { DOCS_FLAG, docsRequest, renderDocs, TOPIC_NAMES } from "./index.ts";
import scenarioDoc from "./docs/scenario.md";
import overviewDoc from "./docs/overview.md";
import { scenarioNames } from "../shared/scenarios/index.ts";

function run(argv: string[]) {
  const flags: Array<{ name: string; description?: string }> = [];
  const out: string[] = [];
  const err: string[] = [];
  const codes: number[] = [];
  const pi = { registerFlag: (name: string, o: { description?: string }) => void flags.push({ name, ...o }) } as unknown as ExtensionAPI;
  agentDocs(pi, argv, { out: (t) => void out.push(t), err: (t) => void err.push(t), exit: (c) => void codes.push(c) });
  return { flags, out: out.join(""), err: err.join(""), codes };
}

test("docsRequest parses the flag like pi parses extension flags", () => {
  assert.equal(docsRequest([]), undefined);
  assert.equal(docsRequest([`--${DOCS_FLAG}`]), true);
  assert.equal(docsRequest([`--${DOCS_FLAG}`, "project"]), "project");
  assert.equal(docsRequest([`--${DOCS_FLAG}=scenario`]), "scenario");
  assert.equal(docsRequest([`--${DOCS_FLAG}`, "-p"]), true);
  assert.equal(docsRequest(["--", `--${DOCS_FLAG}`]), undefined);
});

test("without the flag: registers it (shown in pi --help) and does nothing else", () => {
  const r = run(["--scenario", "demo"]);
  assert.equal(r.flags.length, 1);
  assert.equal(r.flags[0]!.name, DOCS_FLAG);
  for (const topic of TOPIC_NAMES.filter((t) => t !== "overview")) assert.match(r.flags[0]!.description!, new RegExp(topic));
  assert.deepEqual(r.codes, []);
  assert.equal(r.out, "");
});

test("bare flag prints the overview and exits 0", () => {
  const r = run([`--${DOCS_FLAG}`]);
  assert.deepEqual(r.codes, [0]);
  assert.equal(r.out, `${overviewDoc.trimEnd()}\n`);
});

test("unknown topic: error on stderr, exit 2", () => {
  const r = run([`--${DOCS_FLAG}`, "nope"]);
  assert.deepEqual(r.codes, [2]);
  assert.equal(r.out, "");
  assert.match(r.err, /Unknown docs topic "nope" \(known: overview, project, scenario, worktree\)/);
});

test("scenario docs: every registered scenario is described and listed in the generated table", () => {
  const docs = renderDocs("scenario");
  assert.ok("text" in docs);
  for (const name of scenarioNames()) {
    assert.match(scenarioDoc, new RegExp(`^- \`${name}\`:`, "m"), `describe ${name} in docs/scenario.md`);
    assert.match(docs.text, new RegExp(`^\\| \`${name}\` \\|`, "m"));
  }
});

test("the overview lists every other topic", () => {
  for (const topic of TOPIC_NAMES.filter((t) => t !== "overview")) assert.match(overviewDoc, new RegExp(`^- \`${topic}\`:`, "m"));
});
