import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { ENTRY } from "../shared/protocol.ts";
import {
  firstText,
  formatSkillLoads,
  type KnownSkill,
  SKILL_LOAD_ENTRY_VERSION,
  type SkillLoadEntry,
  skillAt,
  skillCommandOf,
  summarizeSkillLoads,
} from "../shared/skill-loads.ts";

/**
 * Skill loads extension, loaded by personal pi (package manifest, after the worktree extension)
 * and the runner (`-e dist/skill-loads.js`). Appends one `pi-agent.skill-load` custom entry
 * (never model context) per load of a skill (src/shared/skill-loads.ts):
 *
 * - a successful `read` of a loaded skill's SKILL.md, called by the model or by another tool
 *   (a codemode script: `tool_call` sees nested calls too, with `parentToolCallId`). The path is
 *   taken in `tool_call`, after the worktree extension made it absolute, and the load is
 *   recorded at `tool_execution_end` unless the call failed or was blocked;
 * - a user message pi expanded from `/skill:name`.
 *
 * The loaded skills are those of the current run's system prompt options, read at call time
 * (the scenario profile extension may narrow them). Reads through other tools (bash `cat`) are
 * not seen. `/skills-loaded` lists the loads on the current branch.
 */
export default function skillLoads(pi: ExtensionAPI) {
  /** The current run's system prompt options; `skills` is read when a call happens. */
  let options: { skills?: readonly KnownSkill[] } | undefined;
  /** Reads of a SKILL.md that have not ended yet, by tool call id. */
  const pending = new Map<string, SkillLoadEntry>();

  const append = (load: Omit<SkillLoadEntry, "version">) =>
    pi.appendEntry<SkillLoadEntry>(ENTRY.skillLoad, { version: SKILL_LOAD_ENTRY_VERSION, ...load });

  pi.on("session_start", () => {
    options = undefined;
    pending.clear();
  });

  pi.on("before_agent_start", (event) => {
    options = event.systemPromptOptions;
  });

  pi.on("message_end", (event) => {
    const message = event.message as { role?: string; content?: unknown };
    if (message.role !== "user") return;
    const command = skillCommandOf(firstText(message.content));
    if (command) append({ ...command, via: "command" });
  });

  pi.on("tool_call", (event, ctx) => {
    if (event.toolName !== "read") return;
    const path = (event.input as { path?: unknown }).path;
    if (typeof path !== "string") return;
    const skill = skillAt(path, ctx.cwd, options?.skills ?? []);
    if (!skill) return;
    pending.set(event.toolCallId, {
      version: SKILL_LOAD_ENTRY_VERSION,
      name: skill.name,
      location: skill.filePath,
      via: event.parentToolCallId ? "codemode" : "read",
      toolCallId: event.toolCallId,
    });
  });

  pi.on("tool_execution_end", (event) => {
    const load = pending.get(event.toolCallId);
    if (!load) return;
    pending.delete(event.toolCallId);
    if (!event.isError) pi.appendEntry<SkillLoadEntry>(ENTRY.skillLoad, load);
  });

  pi.registerCommand("skills-loaded", {
    description: "List the skills loaded on this branch (read by the model, from codemode, or /skill:name)",
    handler: async (_args, ctx) => {
      ctx.ui.notify(formatSkillLoads(summarizeSkillLoads(ctx.sessionManager.getBranch())), "info");
    },
  });
}
