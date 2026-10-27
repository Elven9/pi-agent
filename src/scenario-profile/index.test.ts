import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import scenarioProfile from "./index.ts";
import { addGlobalRules, keepSkill, scenarioActiveTools, scenarioRules } from "./profile.ts";
import { GLOBAL_RULES } from "./global-rules.ts";
import { ENTRY, SCENARIO_CHANNEL } from "../shared/protocol.ts";
import { defineScenario, getScenario } from "../shared/scenarios/index.ts";
import { Type } from "typebox";

const SKILLS = "/pkg/skills";
const builtin = (name: string) => ({ name, sourceInfo: { path: `builtin:${name}` } });
const fromExt = (name: string) => ({ name, sourceInfo: { path: "/ext/index.js" } });
const skill = (baseDir: string) => ({ name: baseDir.split("/").pop(), baseDir });

/** Minimal stand-in for the parts of ExtensionAPI the extension uses. */
function fakePi(flags: Record<string, string | undefined>, externalRoots: string[] = [], globalRules: string[] = []) {
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  const entries: Array<{ customType: string; data: unknown }> = [];
  let active = ["read", "bash", "edit", "write", "my_tool"];
  let shutdown = false;
  const announced: unknown[] = [];
  const pi = {
    events: { emit: (channel: string, data: unknown) => void announced.push({ channel, data }), on() {} },
    registerFlag() {},
    getFlag: (name: string) => flags[name],
    on: (event: string, handler: (event: any, ctx: any) => any) => void handlers.set(event, handler),
    getActiveTools: () => active,
    getAllTools: () => [...["read", "bash", "edit", "write", "grep"].map(builtin), fromExt("my_tool")],
    setActiveTools: (names: string[]) => void (active = names),
    appendEntry: (customType: string, data: unknown) => void entries.push({ customType, data }),
  } as unknown as ExtensionAPI;
  scenarioProfile(pi, SKILLS, externalRoots, globalRules);
  const ctx = { shutdown: () => (shutdown = true) };
  return {
    entries,
    announced,
    get active() {
      return active;
    },
    get shutdown() {
      return shutdown;
    },
    emit: (name: string, event: object = {}) => handlers.get(name)?.({ type: name, ...event }, ctx),
  };
}

function promptOptions() {
  return {
    customPrompt: undefined as string | undefined,
    toolGuidelines: { read: ["Use read to examine files"], my_tool: ["Use my_tool for X"] } as Record<string, string[]>,
    promptGuidelines: [] as string[],
    sections: {} as Record<string, string>,
    skills: [
      skill(join(SKILLS, "shared")),
      skill(join(SKILLS, "synology", "synology-nas")),
      skill(join(SKILLS, "demo", "demo-only")),
      skill(join(SKILLS, "work-request-triage", "triage-only")),
      skill("/Users/me/.agents/skills/personal"),
    ],
  };
}

test("is inert without --scenario", () => {
  const pi = fakePi({});
  pi.emit("session_start");
  assert.deepEqual(pi.announced, []);
  assert.deepEqual(pi.active, ["read", "bash", "edit", "write", "my_tool"]);
  const options = promptOptions();
  pi.emit("before_agent_start", { systemPromptOptions: options });
  assert.deepEqual(options, promptOptions());
});

test("global rules without --scenario: only added to promptGuidelines (pi's <rules>)", () => {
  const pi = fakePi({}, [], [" Global 1 ", "Global 2"]);
  pi.emit("session_start");
  for (let i = 0; i < 2; i++) {
    const options = promptOptions();
    options.promptGuidelines.push("Global 2");
    pi.emit("before_agent_start", { systemPromptOptions: options });
    assert.deepEqual(options.promptGuidelines, ["Global 2", "Global 1"]);
    assert.deepEqual({ ...options, promptGuidelines: [] }, promptOptions());
  }
});

test("global rules with --scenario: last in the scenario's <rules>", () => {
  const pi = fakePi({ scenario: "work-request-triage" }, [], ["Global 1"]);
  pi.emit("session_start");
  const options = promptOptions();
  pi.emit("before_agent_start", { systemPromptOptions: options });
  assert.equal(options.sections.rules, "- Use my_tool for X\n- Global 1");
});

test("addGlobalRules: trimmed, appended once", () => {
  const guidelines = ["a"];
  addGlobalRules(guidelines, [" b ", "a", "", "b"]);
  addGlobalRules(guidelines, ["b"]);
  assert.deepEqual(guidelines, ["a", "b"]);
});

test("GLOBAL_RULES: no empty or duplicate rules", () => {
  const trimmed = GLOBAL_RULES.map((r) => r.trim());
  assert.ok(trimmed.every((r) => r !== ""), "empty global rule");
  assert.equal(new Set(trimmed).size, trimmed.length, "duplicate global rule");
});

test("unknown scenario: records an error entry and shuts down", () => {
  const pi = fakePi({ scenario: "nope" });
  pi.emit("session_start");
  assert.equal(pi.shutdown, true);
  assert.deepEqual(pi.announced, []);
  assert.equal(pi.entries[0].customType, ENTRY.error);
  assert.match((pi.entries[0].data as { message: string }).message, /Unknown scenario/);
});

test("applies the scenario's prompt, tools and skills", () => {
  const pi = fakePi({ scenario: "work-request-triage" });
  pi.emit("session_start");
  assert.deepEqual(pi.announced, [{ channel: SCENARIO_CHANNEL, data: { name: "work-request-triage" } }]);
  assert.deepEqual(pi.active, ["codemode", "read", "my_tool"]);

  // Twice: pi rebuilds the options for every prompt.
  for (let i = 0; i < 2; i++) {
    const options = promptOptions();
    pi.emit("before_agent_start", { systemPromptOptions: options });
    assert.equal(options.customPrompt, getScenario("work-request-triage").systemPrompt);
    assert.deepEqual(
      options.skills.map((s) => s.name),
      // "personal" is an external skill the scenario does not include.
      ["shared", "synology-nas", "triage-only"],
    );
    // Only the extension tool's guideline; read's (built-in) stays out.
    assert.deepEqual(options.sections, { rules: "- Use my_tool for X" });
  }
});

test("externalSkills: only included external skills stay; installed missing ones are added once", async () => {
  const root = await mkdtemp(join(tmpdir(), "pi-agent-ext-"));
  for (const name of ["agent-browser", "extra"]) {
    await mkdir(join(root, name));
    await writeFile(join(root, name, "SKILL.md"), `---\nname: ${name}\ndescription: The ${name} skill\n---\n`);
  }
  const demo = getScenario("demo");
  const saved = demo.externalSkills;
  demo.externalSkills = { include: ["agent-browser", "not-installed", "extra", "shared"] };
  try {
    const pi = fakePi({ scenario: "demo" }, [root]);
    pi.emit("session_start");
    for (let i = 0; i < 2; i++) {
      const options = promptOptions();
      // pi already loaded agent-browser (e.g. from ~/.agents/skills): kept, not added twice.
      options.skills.push(skill(join(root, "agent-browser")));
      pi.emit("before_agent_start", { systemPromptOptions: options });
      assert.deepEqual(
        options.skills.map((s) => s.name),
        // "shared" is this package's skill (kept as is); "personal" is not included; "extra" is added.
        ["shared", "synology-nas", "demo-only", "agent-browser", "extra"],
      );
      assert.equal((options.skills.at(-1) as { baseDir: string }).baseDir, join(root, "extra"));
    }
  } finally {
    demo.externalSkills = saved;
  }
});

test("scenarioRules: extension tools' and global guidelines only, de-duplicated", () => {
  const all = [builtin("read"), builtin("bash"), fromExt("a"), fromExt("b"), fromExt("inactive")];
  const guidelines = { read: ["r"], bash: ["b"], a: [" A1 ", "shared"], b: ["shared", ""], inactive: ["x"] };
  assert.equal(scenarioRules([], ["read", "bash", "b", "a"], all, guidelines, ["global", "A1"]), "- shared\n- A1\n- global");
  assert.equal(scenarioRules([], ["read", "bash"], all, guidelines, []), undefined);
});

test("scenarioRules: the scenario's own rules come first, de-duplicated with the rest", () => {
  const all = [builtin("read"), fromExt("a")];
  const guidelines = { read: ["r"], a: ["A", "own 2"] };
  assert.equal(scenarioRules(["own 1", "own 2"], ["read", "a"], all, guidelines, ["global"]), "- own 1\n- own 2\n- A\n- global");
  assert.equal(scenarioRules(["own"], ["read"], all, guidelines, []), "- own");
});

test("defineScenario trims rules and rejects empty ones", () => {
  const base = { name: "t", detailKind: "t/v1", systemPrompt: "p", tools: [], detailSchema: Type.Object({}) };
  assert.deepEqual(defineScenario({ ...base, rules: [" a ", "b"] }).rules, ["a", "b"]);
  assert.equal(defineScenario(base).rules, undefined);
  assert.throws(() => defineScenario({ ...base, rules: ["a", "  "] }), /rules must not be empty/);
});

test("scenarioRules: codemode's guidelines stay; hidden tools' are left out (they are in codemode's description)", () => {
  const all = [builtin("codemode"), builtin("read"), fromExt("a"), fromExt("b")];
  const guidelines = { codemode: ["Use codemode"], read: ["r"], a: ["A"], b: ["B"] };
  assert.equal(scenarioRules([], ["codemode", "read", "a", "b"], all, guidelines, [], ["read", "a"]), "- Use codemode\n- B");
});

test("scenarioActiveTools: built-ins are the scenario's, extension tools stay", () => {
  const all = [builtin("read"), builtin("bash"), builtin("grep"), fromExt("submit_result")];
  assert.deepEqual(scenarioActiveTools(["grep", "read"], ["read", "bash", "submit_result"], all), [
    "grep",
    "read",
    "submit_result",
  ]);
});

test("keepSkill drops only other scenarios' folders under the skills dir", () => {
  const known = ["demo", "work-request-triage"];
  const keep = (dir: string) => keepSkill(dir, SKILLS, "demo", known);
  assert.equal(keep(join(SKILLS, "shared")), true);
  assert.equal(keep(join(SKILLS, "synology", "x")), true);
  assert.equal(keep(join(SKILLS, "demo", "x")), true);
  assert.equal(keep(join(SKILLS, "work-request-triage", "x")), false);
  assert.equal(keep("/elsewhere/work-request-triage/x"), true);
  assert.equal(keep(SKILLS), true);
});
