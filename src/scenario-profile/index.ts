import { realpathSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { loadSkillsFromDir, type ExtensionAPI, type Skill } from "@earendil-works/pi-coding-agent";
import { externalSkillRoots, findExternalSkills } from "../shared/external-skills.ts";
import { ENTRY, PROJECT_CHANNEL, SCENARIO_CHANNEL, SCENARIO_FLAG, type ScenarioSelected } from "../shared/protocol.ts";
import { getScenario, scenarioNames, type Scenario } from "../shared/scenarios/index.ts";
import { isPackageSkill, keepSkill, scenarioActiveTools, scenarioRules } from "./profile.ts";

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
 * personal pi (package manifest). Inert unless pi is started with `--scenario <name>`; then
 * the session gets that scenario's profile:
 *
 * - system prompt: the scenario's prompt replaces pi's default preamble (`customPrompt`, as
 *   `--system-prompt` would); appended prompts, context files, skills, cwd and extension
 *   sections (project context) still follow it,
 * - rules: pi drops its `<rules>` section with a custom prompt; a `<rules>` section with the
 *   scenario's own `rules` first, then only the extension tools' `promptGuidelines` (and global ones) is added back, so extensions such
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

export default function scenarioProfile(
  pi: ExtensionAPI,
  skillsDir: string = defaultSkillsDir(),
  externalRoots: readonly string[] = externalSkillRoots(),
) {
  pi.registerFlag(SCENARIO_FLAG, {
    type: "string",
    description: "pi-agent scenario: use its system prompt, tools and skills",
  });

  let scenario: Scenario | undefined;
  const root = real(skillsDir);
  /** Skill folder -> kept; skills don't move within a session. */
  const kept = new Map<string, boolean>();
  /** The scenario's included external skills that are installed (found at session start). */
  let included: Skill[] = [];
  let includedNames = new Set<string>();

  /** This extension's session_start has run (later project announcements are expected). */
  let started = false;
  /** The project extension announced itself before our session_start: it loaded first. */
  let projectLoadedFirst = false;
  pi.events.on(PROJECT_CHANNEL, () => {
    if (!started) projectLoadedFirst = true;
  });

  // Flags are only parsed after extensions load, so everything happens from session_start on.
  pi.on("session_start", (_event, ctx) => {
    started = true;
    const name = pi.getFlag(SCENARIO_FLAG);
    if (typeof name !== "string" || name === "") return;
    const fail = (message: string) => {
      // Startup entries are not streamed in --mode json, so also tell stderr.
      console.error(`[pi-agent] ${message}`);
      pi.appendEntry(ENTRY.error, { message });
      ctx.shutdown();
    };
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
    pi.events.emit(SCENARIO_CHANNEL, { name } satisfies ScenarioSelected);
    pi.setActiveTools(scenarioActiveTools(scenario.tools, pi.getActiveTools(), pi.getAllTools()));
  });

  // pi rebuilds the options from its base for every prompt, so set them every time; they
  // never change within a session, so pi sees no delta.
  pi.on("before_agent_start", (event) => {
    if (!scenario) return;
    const options = event.systemPromptOptions;
    options.customPrompt = scenario.systemPrompt;
    // A custom section, so it follows <cwd>. Set before the project extension adds its
    // sections (it loads after this one), so it stays in cache block A.
    const rules = scenarioRules(
      scenario.rules ?? [],
      pi.getActiveTools(),
      pi.getAllTools(),
      options.toolGuidelines,
      options.promptGuidelines,
      options.hiddenTools,
    );
    if (rules) options.sections.rules = rules;
    const known = scenarioNames();
    const name = scenario.name;
    options.skills = options.skills.filter((s) => {
      let keep = kept.get(s.baseDir);
      if (keep === undefined) {
        const dir = real(s.baseDir);
        keep = isPackageSkill(dir, root) ? keepSkill(dir, root, name, known) : includedNames.has(s.name);
        kept.set(s.baseDir, keep);
      }
      return keep;
    });
    const present = new Set(options.skills.map((s) => s.name));
    for (const s of included) if (!present.has(s.name)) options.skills.push(s);
  });
}
