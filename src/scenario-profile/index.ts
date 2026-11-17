import { realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSkillsFromDir, type ExtensionAPI, type ExtensionContext, type Skill } from "@earendil-works/pi-coding-agent";
import { abortSession } from "../shared/abort.ts";
import { externalSkillRoots, findExternalSkills } from "../shared/external-skills.ts";
import {
  ENTRY,
  PROJECT_CHANNEL,
  SCENARIO_CHANNEL,
  SCENARIO_FLAG,
  SKILLS_CHANNEL,
  type ProjectAnnounced,
  type ScenarioSelected,
  type SkillsAnnounced,
} from "../shared/protocol.ts";
import { decideMcpServers, mcpServerConfig, type McpEnv } from "../shared/mcp-servers.ts";
import { getScenario, scenarioNames, type Scenario } from "../shared/scenarios/index.ts";
import {
  ALLOW_SETUP_CHANGE_CHANNEL,
  ALLOW_SETUP_CHANGE_DESCRIPTION,
  ALLOW_SETUP_CHANGE_FLAG,
  decideSetup,
  type AllowSetupChange,
  sameEntry,
  SCENARIO_ENTRY_VERSION,
  sessionScenario,
  sessionScenarioEntry,
  type ScenarioEntry,
} from "../shared/session-setup.ts";
import { GLOBAL_RULES, GLOBAL_RULES_SECTION, globalRulesSection } from "./global-rules.ts";
import { scenarioActiveTools, scenarioRules, skillActive, type SkillRules } from "./profile.ts";

/**
 * This package's skills folder. Bundled: dist/scenario-profile.js -> ../skills. From source
 * (tests): src/scenario-profile/index.ts -> ../../skills.
 */
function defaultSkillsDir(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return basename(here) === "dist" ? join(here, "..", "skills") : join(here, "..", "..", "skills");
}

/** Real path, so symlinked package or skill folders still compare equal. */
function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * Scenario profile extension, loaded by both the runner (`-e dist/scenario-profile.js`) and
 * personal pi (package manifest). In every session it adds the global rules (GLOBAL_RULES,
 * `rules/global.md`, opened by a precedence line; none when empty) as a `<global_rules>` section, after `<rules>` (pi's own without a scenario,
 * the scenario's with one). Otherwise inert unless pi is started with `--scenario <name>`; then
 * the session gets that scenario's profile:
 *
 * - system prompt: the scenario's prompt replaces pi's default preamble (`customPrompt`, as
 *   `--system-prompt` would); appended prompts, context files, skills, cwd and extension
 *   sections (project context) still follow it,
 * - rules: pi drops its `<rules>` section with a custom prompt; a `<rules>` section with the
 *   scenario's own `rules` (its `rules/<name>.md`, as is) first, then only the extension tools' `promptGuidelines` is added back, so extensions such
 *   as tool-ref can give guidance in every scenario. Built-in tool rules stay out, except
 *   codemode's; hidden tools' rules too (with `codemode.mode: "only"` they are in codemode's
 *   description),
 * - tools: built-in tools are exactly the scenario's; tools from extensions stay,
 * - skills: other scenarios' skills (`skills/<other scenario>/`) are left out of the prompt.
 *   External skills (not from this package, e.g. ~/.agents/skills or other pi packages) are left
 *   out unless the scenario includes them (`externalSkills.include`); included ones are added
 *   (after pi's, in include order) when installed and not already there, e.g. turned off in
 *   pi's settings. Added ones are in the prompt only; pi
 *   has no `/skill:<name>` command for them.
 * - project skills: a project with `skills.include` in project.yaml (announced on
 *   PROJECT_CHANNEL) decides the skills too, also without `--scenario`: without a scenario only
 *   its skills stay, with one they are added to the scenario's (profile.ts, skillActive).
 *   Included ones pi did not load are added like the scenario's external ones, looked up in this
 *   package's skills first.
 * - MCP servers: the scenario's `mcpServers` presets that apply to the workdir are registered
 *   (`pi.registerMcpServer`, codemode exposure); one whose program is missing is a warning
 *   (notification in personal pi, stderr in a sandbox run) and the session continues without it.
 * - announces the resulting skill names on SKILLS_CHANNEL at session start (and again when the
 *   project's skills arrive), for the activation hint.
 *
 * `submit_result` and the result format stay with the runner extension (src/extension/). This
 * extension owns the `--scenario` flag and tells the runner on SCENARIO_CHANNEL.
 *
 * Load order: this extension must load before the project extension, so `<rules>` is added
 * before the project's sections (block B) and stays in cache block A. Under `--scenario` the
 * order is checked at session start: handlers run in load order, so if the project extension
 * announces itself (PROJECT_CHANNEL, sent from its session_start) before this extension's
 * session_start ran, it loaded first. That is an error (entry + shutdown), like an unknown
 * scenario.
 */
/** Included external skills, found with pi's own loader; not installed ones are left out. */
function loadIncluded(names: readonly string[], roots: readonly string[]): Skill[] {
  return findExternalSkills(names, roots, (root) => {
    try {
      return loadSkillsFromDir({ dir: root, source: "user" }).skills;
    } catch {
      return [];
    }
  });
}

/** Appends a `pi-agent.scenario` entry unless the session's last one already says the same. */
function recordScenarioEntry(pi: ExtensionAPI, entries: Iterable<unknown>, name: string | null): void {
  const entry: ScenarioEntry = { version: SCENARIO_ENTRY_VERSION, name };
  const last = sessionScenarioEntry(entries);
  // No entry already means none.
  if (name === null ? last?.name : !sameEntry(last, entry)) pi.appendEntry<ScenarioEntry>(ENTRY.scenario, entry);
}

export default function scenarioProfile(
  pi: ExtensionAPI,
  skillsDir: string = defaultSkillsDir(),
  externalRoots: readonly string[] = externalSkillRoots(),
  globalRules: string = GLOBAL_RULES,
  mcpEnv: McpEnv = {},
) {
  pi.registerFlag(SCENARIO_FLAG, {
    type: "string",
    description: "pi-agent scenario: use its system prompt, tools and skills",
  });
  // Owned here; the project extension gets its value on ALLOW_SETUP_CHANGE_CHANNEL.
  pi.registerFlag(ALLOW_SETUP_CHANGE_FLAG, { type: "boolean", description: ALLOW_SETUP_CHANGE_DESCRIPTION });
  /** A startup error in the TUI, printed on shutdown (the TUI would paint over it now). */
  let startupError: string | undefined;

  let scenario: Scenario | undefined;
  const root = real(skillsDir);
  /** Skill folder -> kept, for the current rules (cleared when they change). */
  const kept = new Map<string, boolean>();
  /** The scenario's included external skills that are installed (found at session start). */
  let included: Skill[] = [];
  let includedNames = new Set<string>();
  /** The project's `skills.include` (PROJECT_CHANNEL); undefined: the project does not set it. */
  let projectInclude: string[] | undefined;
  /** The project's skills that are installed: this package's skills first, then the external roots. */
  let projectSkills: Skill[] = [];

  const recordScenario = (ctx: ExtensionContext, name: string | null) => recordScenarioEntry(pi, ctx.sessionManager.getEntries(), name);

  pi.on("session_shutdown", () => {
    if (startupError === undefined) return;
    console.error(`[pi-agent] ${startupError}`);
    startupError = undefined;
  });

  /** This extension's session_start has run (later project announcements are expected). */
  let started = false;
  /** The project extension announced itself before our session_start: it loaded first. */
  let projectLoadedFirst = false;

  const rules = (): SkillRules => ({
    skillsDir: root,
    ...(scenario && { scenario: { name: scenario.name, known: scenarioNames(), include: includedNames } }),
    ...(projectInclude && { project: new Set(projectInclude) }),
  });

  /** `base` (pi's skills) filtered by the rules, then the installed included ones pi did not load. */
  const select = <S extends { name: string; baseDir: string }>(base: readonly S[], extra: readonly S[]): S[] => {
    const r = rules();
    const out = base.filter((s) => {
      let keep = kept.get(s.baseDir);
      if (keep === undefined) {
        keep = skillActive(r, s.name, real(s.baseDir));
        kept.set(s.baseDir, keep);
      }
      return keep;
    });
    const present = new Set(out.map((s) => s.name));
    for (const s of extra) {
      if (present.has(s.name)) continue;
      present.add(s.name);
      out.push(s);
    }
    return out;
  };

  /** Tell the activation hint which skills the prompts get (pi's loaded skills, as commands). */
  const announceSkills = () => {
    const base = pi
      .getCommands()
      .filter((c) => c.source === "skill")
      .map((c) => ({ name: c.name.replace(/^skill:/, ""), baseDir: dirname(c.sourceInfo.path), description: c.description ?? "" }));
    const selected = select(base, [...included, ...projectSkills]);
    const skills = selected.map((s) => s.name);
    const missing = (projectInclude ?? []).filter((n) => !skills.includes(n));
    const descriptions = Object.fromEntries(selected.map((s) => [s.name, s.description]));
    pi.events.emit(SKILLS_CHANNEL, { skills, missing, descriptions } satisfies SkillsAnnounced);
  };

  /** Register the scenario's MCP servers that apply here; warn about missing programs, never fail. */
  const registerMcpServers = (s: Scenario, ctx: Pick<ExtensionContext, "cwd" | "hasUI" | "ui">) => {
    if (!s.mcpServers?.length) return;
    const warn = (message: string) => {
      if (ctx.hasUI) ctx.ui.notify(message, "warning");
      else console.error(`[pi-agent] warning: ${message}`);
    };
    for (const d of decideMcpServers(s.mcpServers, ctx.cwd, mcpEnv)) {
      if (d.status === "unavailable") warn(`MCP server ${d.name}: ${d.reason}`);
      if (d.status !== "registered") continue;
      try {
        pi.registerMcpServer(d.name, mcpServerConfig(d, ctx.cwd));
      } catch (err) {
        warn(`MCP server ${d.name} not registered: ${(err as Error).message}`);
      }
    }
  };

  pi.events.on(PROJECT_CHANNEL, (data) => {
    if (!started) projectLoadedFirst = true;
    // Announced at every session start and every prompt; the skills only change with the project.
    const next = (data as ProjectAnnounced).skills;
    if (JSON.stringify(next) === JSON.stringify(projectInclude)) return;
    projectInclude = next && [...next];
    projectSkills = loadIncluded(projectInclude ?? [], [skillsDir, ...externalRoots]);
    kept.clear();
    if (started) announceSkills();
  });

  // Flags are only parsed after extensions load, so everything happens from session_start on.
  pi.on("session_start", (event, ctx) => {
    started = true;
    const allowChange = pi.getFlag(ALLOW_SETUP_CHANGE_FLAG) === true;
    pi.events.emit(ALLOW_SETUP_CHANGE_CHANNEL, { allow: allowChange } satisfies AllowSetupChange);
    const fail = (message: string) => {
      // Startup entries are not streamed in --mode json, so also tell stderr; in the TUI once it stopped.
      if (ctx.mode === "tui") startupError = message;
      else console.error(`[pi-agent] ${message}`);
      abortSession(pi, ctx, message);
    };
    // The session's setup is fixed (shared/session-setup.ts): recorded scenario vs --scenario.
    const flag = pi.getFlag(SCENARIO_FLAG);
    const current = typeof flag === "string" && flag !== "" ? flag : undefined;
    const recorded = sessionScenario(ctx.sessionManager.getEntries());
    const decision = decideSetup({
      what: "scenario",
      reason: event.reason,
      recorded,
      current,
      key: (n) => n,
      label: (n) => n,
      allowChange,
    });
    if ("error" in decision) {
      fail(decision.error);
      return;
    }
    const name = decision.use === "recorded" ? recorded : current;
    if (decision.use === "recorded" && recorded !== current && ctx.hasUI) {
      ctx.ui.notify(`[pi-agent] Scenario ${recorded}, as recorded in this session`, "info");
    }
    if (name === undefined) {
      recordScenario(ctx, null); // only after --allow-setup-change dropped a recorded one
      announceSkills();
      return;
    }
    if (projectLoadedFirst) {
      fail(
        "The scenario-profile extension must load before the project extension " +
          "(list it first in -e flags or the package manifest).",
      );
      return;
    }
    try {
      scenario = getScenario(name);
    } catch (err) {
      fail((err as Error).message);
      return;
    }
    // Synchronous: the runner registers submit_result before the tools are set below.
    included = loadIncluded(scenario.externalSkills?.include ?? [], externalRoots);
    includedNames = new Set(scenario.externalSkills?.include ?? []);
    kept.clear();
    pi.events.emit(SCENARIO_CHANNEL, { name } satisfies ScenarioSelected);
    recordScenario(ctx, name);
    pi.setActiveTools(scenarioActiveTools(scenario.tools, pi.getActiveTools(), pi.getAllTools()));
    registerMcpServers(scenario, ctx);
    announceSkills();
  });

  // pi rebuilds the options from its base for every prompt, so set them every time; they
  // never change within a session, so pi sees no delta.
  pi.on("before_agent_start", (event) => {
    const options = event.systemPromptOptions;
    // Custom sections render in insertion order after <cwd>: <rules> (with a scenario) first,
    // then <global_rules>, both before the project extension's sections (cache block A).
    const addGlobalRules = () => {
      const text = globalRulesSection(globalRules);
      if (text) options.sections[GLOBAL_RULES_SECTION] = text;
    };
    if (scenario || projectInclude) options.skills = select(options.skills, [...included, ...projectSkills]);
    if (!scenario) {
      addGlobalRules();
      return;
    }
    options.customPrompt = scenario.systemPrompt;
    // A custom section, so it follows <cwd>. Set before the project extension adds its
    // sections (it loads after this one), so it stays in cache block A.
    const sectionRules = scenarioRules(
      scenario.rules,
      pi.getActiveTools(),
      pi.getAllTools(),
      options.toolGuidelines,
      options.promptGuidelines,
      options.hiddenTools,
    );
    if (sectionRules) options.sections.rules = sectionRules;
    addGlobalRules();
  });
}
