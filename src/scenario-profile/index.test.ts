import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import scenarioProfile from "./index.ts";
import { keepSkill, scenarioActiveTools, scenarioRules, skillActive } from "./profile.ts";
import { GLOBAL_RULES, GLOBAL_RULES_PRECEDENCE, globalRulesSection } from "./global-rules.ts";
import { ENTRY, PROJECT_CHANNEL, SCENARIO_CHANNEL, SKILLS_CHANNEL } from "../shared/protocol.ts";
import { defineScenario, getScenario } from "../shared/scenarios/index.ts";
import { Type } from "typebox";
import { chmod } from "node:fs/promises";
import type { McpEnv } from "../shared/mcp-servers.ts";

const SKILLS = "/pkg/skills";
const builtin = (name: string) => ({ name, sourceInfo: { path: `builtin:${name}` } });
const fromExt = (name: string) => ({ name, sourceInfo: { path: "/ext/index.js" } });
const skill = (baseDir: string) => ({ name: baseDir.split("/").pop(), baseDir });

/** Minimal stand-in for the parts of ExtensionAPI the extension uses. */
interface FakeOptions {
  cwd?: string;
  hasUI?: boolean;
  mcpEnv?: McpEnv;
  /** registerMcpServer throws this message. */
  registerError?: string;
}

function fakePi(flags: Record<string, string | undefined>, externalRoots: string[] = [], globalRules = "", skillsDir = SKILLS, o: FakeOptions = {}) {
  const mcp: Array<{ name: string; config: unknown }> = [];
  const notes: Array<{ message: string; type: string }> = [];
  const handlers = new Map<string, (event: any, ctx: any) => any>();
  const listeners = new Map<string, Array<(data: unknown) => void>>();
  const entries: Array<{ customType: string; data: unknown }> = [];
  let active = ["read", "bash", "edit", "write", "my_tool"];
  let shutdown = false;
  const announced: unknown[] = [];
  /** Descriptions from the last SKILLS_CHANNEL announcement (kept out of `announced`). */
  let descriptions: Record<string, string> | undefined;
  const pi = {
    events: {
      emit: (channel: string, data: any) => {
        if (channel === SKILLS_CHANNEL) {
          const { descriptions: d, ...rest } = data;
          descriptions = d;
          data = rest;
        }
        announced.push({ channel, data });
      },
      on: (channel: string, l: (data: unknown) => void) => void listeners.set(channel, [...(listeners.get(channel) ?? []), l]),
    },
    // pi's loaded skills as commands, like promptOptions().skills.
    getCommands: () =>
      promptOptions().skills.map((s) => ({
        name: `skill:${s.name}`,
        description: `About ${s.name}`,
        source: "skill",
        sourceInfo: { path: join(s.baseDir, "SKILL.md") },
      })),
    registerFlag() {},
    getFlag: (name: string) => flags[name],
    on: (event: string, handler: (event: any, ctx: any) => any) => void handlers.set(event, handler),
    getActiveTools: () => active,
    getAllTools: () => [...["read", "bash", "edit", "write", "grep"].map(builtin), fromExt("my_tool")],
    setActiveTools: (names: string[]) => void (active = names),
    appendEntry: (customType: string, data: unknown) => void entries.push({ customType, data }),
    registerMcpServer: (name: string, config: unknown) => {
      if (o.registerError) throw new Error(o.registerError);
      mcp.push({ name, config });
    },
  } as unknown as ExtensionAPI;
  scenarioProfile(pi, skillsDir, externalRoots, globalRules, o.mcpEnv ?? { env: { PATH: "" }, home: "/nonexistent" });
  const ctx = {
    shutdown: () => (shutdown = true),
    cwd: o.cwd ?? "/nonexistent",
    hasUI: o.hasUI ?? false,
    ui: { notify: (message: string, type: string) => void notes.push({ message, type }) },
  };
  return {
    entries,
    mcp,
    notes,
    announced,
    get active() {
      return active;
    },
    get shutdown() {
      return shutdown;
    },
    emit: (name: string, event: object = {}) => handlers.get(name)?.({ type: name, ...event }, ctx),
    /** Another extension's announcement (the project extension's). */
    hear: (channel: string, data: unknown) => listeners.get(channel)?.forEach((l) => l(data)),
    get descriptions() {
      return descriptions;
    },
    /** Skill names from the last SKILLS_CHANNEL announcement. */
    get skills() {
      return (announced.filter((a: any) => a.channel === SKILLS_CHANNEL).at(-1) as any)?.data;
    },
  };
}

const ALL = ["shared", "synology-nas", "demo-only", "triage-only", "personal"];

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

test("is inert without --scenario (only announces pi's skills)", () => {
  const pi = fakePi({});
  pi.emit("session_start");
  assert.deepEqual(pi.announced, [{ channel: SKILLS_CHANNEL, data: { skills: ALL, missing: [] } }]);
  // A project without `skills` changes nothing.
  pi.hear(PROJECT_CHANNEL, { project: { name: "p", dir: "/p" }, block: "" });
  assert.equal(pi.announced.length, 1);
  assert.deepEqual(pi.active, ["read", "bash", "edit", "write", "my_tool"]);
  const options = promptOptions();
  pi.emit("before_agent_start", { systemPromptOptions: options });
  assert.deepEqual(options, promptOptions());
});

test("global rules without --scenario: only a <global_rules> section, precedence line then the rules (trimmed)", () => {
  const pi = fakePi({}, [], "\n- Global 1\n\n## More\n- Global 2\n");
  pi.emit("session_start");
  for (let i = 0; i < 2; i++) {
    const options = promptOptions();
    pi.emit("before_agent_start", { systemPromptOptions: options });
    assert.deepEqual(options.sections, { global_rules: `${GLOBAL_RULES_PRECEDENCE}\n\n- Global 1\n\n## More\n- Global 2` });
    assert.deepEqual({ ...options, sections: {} }, promptOptions());
  }
});

test("global rules with --scenario: <global_rules> after the scenario's <rules>, not in it", () => {
  const pi = fakePi({ scenario: "work-request-triage" }, [], "- Global 1");
  pi.emit("session_start");
  const options = promptOptions();
  pi.emit("before_agent_start", { systemPromptOptions: options });
  assert.deepEqual(Object.entries(options.sections), [
    ["rules", "- Use my_tool for X"],
    ["global_rules", `${GLOBAL_RULES_PRECEDENCE}\n\n- Global 1`],
  ]);
});

test("globalRulesSection: precedence line only with rules", () => {
  assert.equal(globalRulesSection(" \n "), undefined);
  assert.equal(globalRulesSection("\n- a\n"), `${GLOBAL_RULES_PRECEDENCE}\n\n- a`);
  // Empty rules file: no <global_rules> section, even with a scenario.
  const pi = fakePi({ scenario: "work-request-triage" }, [], " \n");
  pi.emit("session_start");
  const options = promptOptions();
  pi.emit("before_agent_start", { systemPromptOptions: options });
  assert.equal("global_rules" in options.sections, false);
});

test("GLOBAL_RULES: rules/global.md, trimmed, without the precedence line", () => {
  assert.ok(!GLOBAL_RULES.includes(GLOBAL_RULES_PRECEDENCE));
  assert.ok(GLOBAL_RULES !== "" && GLOBAL_RULES === GLOBAL_RULES.trim());
  assert.match(GLOBAL_RULES, /## Preferred tools\n.*\n- rg over grep\n- fd over find/);
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
  assert.deepEqual(pi.announced, [
    { channel: SCENARIO_CHANNEL, data: { name: "work-request-triage" } },
    { channel: SKILLS_CHANNEL, data: { skills: ["shared", "synology-nas", "triage-only"], missing: [] } },
  ]);
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

/** A package skills dir with a scenario skill pi did not load (e.g. sandbox -ns), plus an external root. */
async function installed() {
  const pkg = await mkdtemp(join(tmpdir(), "pi-agent-pkg-"));
  const ext = await mkdtemp(join(tmpdir(), "pi-agent-ext-"));
  const write = async (dir: string, name: string) => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: The ${name} skill\n---\n`);
  };
  await write(join(pkg, "code-writer", "golang"), "golang");
  await write(join(ext, "agent-browser"), "agent-browser");
  return { pkg, ext };
}

test("project skills without a scenario: only the project's, missing ones added, not installed reported", async () => {
  const { pkg, ext } = await installed();
  const pi = fakePi({}, [ext], "", pkg);
  pi.emit("session_start");
  pi.hear(PROJECT_CHANNEL, { project: { name: "p", dir: "/p" }, block: "", skills: ["personal", "golang", "agent-browser", "nope"] });
  // Announced again once the project's skills are known.
  assert.deepEqual(pi.skills, { skills: ["personal", "golang", "agent-browser"], missing: ["nope"] });
  // pi's (from its commands) and the added ones' (from SKILL.md).
  assert.deepEqual(pi.descriptions, { personal: "About personal", golang: "The golang skill", "agent-browser": "The agent-browser skill" });
  for (let i = 0; i < 2; i++) {
    const options = promptOptions();
    pi.emit("before_agent_start", { systemPromptOptions: options });
    assert.deepEqual(options.skills.map((s) => s.name), ["personal", "golang", "agent-browser"]);
  }
});

test("project skills with a scenario: added to the scenario's (also another scenario's skill)", async () => {
  const { ext } = await installed();
  const pi = fakePi({ scenario: "demo" }, [ext]);
  pi.emit("session_start");
  pi.hear(PROJECT_CHANNEL, { project: { name: "p", dir: "/p" }, block: "", skills: ["triage-only", "personal"] });
  assert.deepEqual(pi.skills, { skills: ["shared", "synology-nas", "demo-only", "triage-only", "personal"], missing: [] });
  const options = promptOptions();
  pi.emit("before_agent_start", { systemPromptOptions: options });
  assert.deepEqual(options.skills.map((s) => s.name), ["shared", "synology-nas", "demo-only", "triage-only", "personal"]);
});

test("project skills: an empty include leaves no skills", () => {
  const pi = fakePi({});
  pi.emit("session_start");
  pi.hear(PROJECT_CHANNEL, { block: "", skills: [] });
  assert.deepEqual(pi.skills, { skills: [], missing: [] });
});

test("skillActive: scenario rules, project includes, union", () => {
  const scenario = { name: "demo", known: ["demo", "work-request-triage"], include: new Set(["ext-in"]) };
  const on = (rules: object, name: string, dir: string) => skillActive({ skillsDir: SKILLS, ...rules }, name, dir);
  assert.equal(on({}, "x", "/anywhere/x"), true);
  assert.equal(on({ scenario }, "t", join(SKILLS, "work-request-triage", "t")), false);
  assert.equal(on({ scenario }, "ext", "/ext/ext"), false);
  assert.equal(on({ scenario }, "ext-in", "/ext/ext-in"), true);
  assert.equal(on({ scenario, project: new Set(["t"]) }, "t", join(SKILLS, "work-request-triage", "t")), true);
  assert.equal(on({ project: new Set(["t"]) }, "shared", join(SKILLS, "shared")), false);
  assert.equal(on({ project: new Set(["t"]) }, "t", "/ext/t"), true);
});

test("scenarioRules: extension tools' and global guidelines only, de-duplicated", () => {
  const all = [builtin("read"), builtin("bash"), fromExt("a"), fromExt("b"), fromExt("inactive")];
  const guidelines = { read: ["r"], bash: ["b"], a: [" A1 ", "shared"], b: ["shared", ""], inactive: ["x"] };
  assert.equal(scenarioRules(undefined, ["read", "bash", "b", "a"], all, guidelines, ["global", "A1"]), "- shared\n- A1\n- global");
  assert.equal(scenarioRules(undefined, ["read", "bash"], all, guidelines, []), undefined);
  assert.equal(scenarioRules(" \n", ["read", "bash"], all, guidelines, []), undefined);
});

test("scenarioRules: the scenario's own rules come first, as is (trimmed)", () => {
  const all = [builtin("read"), fromExt("a")];
  const guidelines = { read: ["r"], a: ["A"] };
  const own = "\n## Scenario\n- own 1\n  continued\n- own 2\n";
  assert.equal(scenarioRules(own, ["read", "a"], all, guidelines, ["global"]), "## Scenario\n- own 1\n  continued\n- own 2\n- A\n- global");
  assert.equal(scenarioRules("- own", ["read"], all, guidelines, []), "- own");
});

test("defineScenario trims rules and rejects empty ones", () => {
  const base = { name: "t", detailKind: "t/v1", systemPrompt: "p", tools: [], detailSchema: Type.Object({}) };
  assert.equal(defineScenario({ ...base, rules: "\n- a\n- b\n" }).rules, "- a\n- b");
  assert.equal(defineScenario(base).rules, undefined);
  assert.throws(() => defineScenario({ ...base, rules: " \n " }), /rules must not be empty/);
});

test("the scenario's rules open its <rules> section", () => {
  const pi = fakePi({ scenario: "the-sculptor" });
  pi.emit("session_start");
  const options = promptOptions();
  pi.emit("before_agent_start", { systemPromptOptions: options });
  assert.equal(options.sections.rules, `${getScenario("the-sculptor").rules}\n- Use my_tool for X`);
});

test("scenarioRules: codemode's guidelines stay; hidden tools' are left out (they are in codemode's description)", () => {
  const all = [builtin("codemode"), builtin("read"), fromExt("a"), fromExt("b")];
  const guidelines = { codemode: ["Use codemode"], read: ["r"], a: ["A"], b: ["B"] };
  assert.equal(scenarioRules(undefined, ["codemode", "read", "a", "b"], all, guidelines, [], ["read", "a"]), "- Use codemode\n- B");
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

/** A Go module dir and a bin dir with a fake gopls. */
async function goWorkdir() {
  const root = await mkdtemp(join(tmpdir(), "pi-agent-go-"));
  await writeFile(join(root, "go.mod"), "module example.com/m\n");
  const bin = join(root, "bin");
  await mkdir(bin);
  await writeFile(join(bin, "gopls"), "#!/bin/sh\n");
  await chmod(join(bin, "gopls"), 0o755);
  return { root, bin };
}

test("code-writer in a Go module: registers gopls (codemode only, vulncheck hidden)", async () => {
  const { root, bin } = await goWorkdir();
  const pi = fakePi({ scenario: "code-writer" }, [], "", SKILLS, { cwd: root, mcpEnv: { env: { PATH: bin }, home: root } });
  pi.emit("session_start");
  assert.equal(pi.mcp.length, 1);
  const { name, config } = pi.mcp[0] as { name: string; config: any };
  assert.equal(name, "gopls");
  assert.equal(config.command, join(bin, "gopls"));
  assert.deepEqual(config.args, ["mcp"]);
  assert.equal(config.cwd, root);
  assert.equal(config.exposure, "codemode");
  assert.deepEqual(config.toolExposure, { go_vulncheck: "hidden" });
  assert.deepEqual(pi.notes, []);
});

test("code-writer outside a Go module, or another scenario: no MCP server", async () => {
  const { root, bin } = await goWorkdir();
  const env = { env: { PATH: bin }, home: root };
  const notGo = await mkdtemp(join(tmpdir(), "pi-agent-nogo-"));
  const a = fakePi({ scenario: "code-writer" }, [], "", SKILLS, { cwd: notGo, mcpEnv: env });
  a.emit("session_start");
  const b = fakePi({ scenario: "demo" }, [], "", SKILLS, { cwd: root, mcpEnv: env });
  b.emit("session_start");
  const c = fakePi({}, [], "", SKILLS, { cwd: root, mcpEnv: env });
  c.emit("session_start");
  for (const pi of [a, b, c]) {
    assert.deepEqual(pi.mcp, []);
    assert.deepEqual(pi.notes, []);
  }
});

test("code-writer in a Go module without gopls: warns (UI) and continues without it", async () => {
  const { root } = await goWorkdir();
  const pi = fakePi({ scenario: "code-writer" }, [], "", SKILLS, { cwd: root, hasUI: true, mcpEnv: { env: { PATH: "" }, home: root } });
  pi.emit("session_start");
  assert.deepEqual(pi.mcp, []);
  assert.equal(pi.shutdown, false);
  assert.equal(pi.notes.length, 1);
  assert.equal(pi.notes[0].type, "warning");
  assert.match(pi.notes[0].message, /gopls is not installed/);
  assert.deepEqual(pi.entries, []);
  // The scenario still applies.
  assert.deepEqual(pi.announced[0], { channel: SCENARIO_CHANNEL, data: { name: "code-writer" } });
});

test("registerMcpServer failing (e.g. MCP replaced): a warning, not an error", async () => {
  const { root, bin } = await goWorkdir();
  const pi = fakePi({ scenario: "code-writer" }, [], "", SKILLS, {
    cwd: root,
    hasUI: true,
    mcpEnv: { env: { PATH: bin }, home: root },
    registerError: "boom",
  });
  pi.emit("session_start");
  assert.equal(pi.shutdown, false);
  assert.match(pi.notes[0].message, /gopls not registered: boom/);
});
