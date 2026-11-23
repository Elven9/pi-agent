import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { ENTRY } from "./protocol.ts";

/**
 * Skill loads, recorded by the skill-loads extension as `pi-agent.skill-load` custom entries
 * (never model context), one per load, and read back by `/skills-loaded` and the Go session
 * parser (go/pkg/session-parser/skills.go).
 */

export const SKILL_LOAD_ENTRY_VERSION = 1;

/**
 * How a skill was loaded: `read` the model read its SKILL.md with the read tool, `codemode` a
 * tool call made by another tool (a codemode script) read it, `command` the user typed
 * `/skill:name` and pi put the skill into the user message.
 */
export type SkillLoadVia = "read" | "codemode" | "command";

const VIAS: readonly string[] = ["read", "codemode", "command"] satisfies SkillLoadVia[];

/** Data of a `pi-agent.skill-load` entry. */
export interface SkillLoadEntry {
  version: typeof SKILL_LOAD_ENTRY_VERSION;
  /** The skill's name (frontmatter `name`, as pi loaded it). */
  name: string;
  /** Absolute path of its SKILL.md, as pi loaded it. */
  location: string;
  via: SkillLoadVia;
  /** The read's tool call id (`<parent id>/<n>` for `codemode`); absent for `command`. */
  toolCallId?: string;
}

/** A skill pi loaded (the fields of pi's `Skill` this needs). */
export interface KnownSkill {
  name: string;
  filePath: string;
}

function real(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}

/**
 * The skill whose SKILL.md is at `path` (relative: against `cwd`), comparing real paths so
 * symlinks match; undefined when none is.
 */
export function skillAt(path: string, cwd: string, skills: readonly KnownSkill[]): KnownSkill | undefined {
  const target = real(resolve(cwd, path));
  return skills.find((s) => real(resolve(cwd, s.filePath)) === target);
}

/** Start of a user message pi expanded from `/skill:name` (pi's agent-session.js). */
const SKILL_BLOCK = /^<skill name="([^"]+)" location="([^"]+)">\n/;

/** The skill a user message's text was expanded from; undefined when it is not a /skill: command. */
export function skillCommandOf(text: string): { name: string; location: string } | undefined {
  const m = SKILL_BLOCK.exec(text);
  return m ? { name: m[1], location: m[2] } : undefined;
}

/** The first text of a message's content (a string, or the first text block). */
export function firstText(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  const block = content.find((b) => b && typeof b === "object" && b.type === "text" && typeof b.text === "string");
  return block ? block.text : "";
}

/** A `pi-agent.skill-load` entry's data; undefined for other or malformed entries. */
export function skillLoadOf(entry: unknown): SkillLoadEntry | undefined {
  if (!entry || typeof entry !== "object") return undefined;
  const e = entry as { type?: unknown; customType?: unknown; data?: unknown };
  if (e.type !== "custom" || e.customType !== ENTRY.skillLoad) return undefined;
  const d = e.data as Partial<Record<keyof SkillLoadEntry, unknown>> | undefined;
  if (!d || d.version !== SKILL_LOAD_ENTRY_VERSION) return undefined;
  if (typeof d.name !== "string" || d.name === "" || typeof d.location !== "string" || d.location === "") return undefined;
  if (typeof d.via !== "string" || !VIAS.includes(d.via)) return undefined;
  if (d.toolCallId !== undefined && typeof d.toolCallId !== "string") return undefined;
  return d as SkillLoadEntry;
}

/** One skill's loads on a branch. */
export interface SkillLoadSummary {
  name: string;
  location: string;
  loads: number;
  via: Partial<Record<SkillLoadVia, number>>;
  /** Timestamp of the first load's entry. */
  first: string;
}

/** The skills loaded among `entries` (a branch, in order), in the order of their first load. */
export function summarizeSkillLoads(entries: readonly unknown[]): SkillLoadSummary[] {
  const byLocation = new Map<string, SkillLoadSummary>();
  for (const entry of entries) {
    const load = skillLoadOf(entry);
    if (!load) continue;
    let s = byLocation.get(load.location);
    if (!s) {
      const at = (entry as { timestamp?: unknown }).timestamp;
      s = { name: load.name, location: load.location, loads: 0, via: {}, first: typeof at === "string" ? at : "" };
      byLocation.set(load.location, s);
    }
    s.loads++;
    s.via[load.via] = (s.via[load.via] ?? 0) + 1;
  }
  return [...byLocation.values()];
}

/** `/skills-loaded` output. */
export function formatSkillLoads(skills: readonly SkillLoadSummary[]): string {
  if (skills.length === 0) return "No skills loaded on this branch.";
  const total = skills.reduce((n, s) => n + s.loads, 0);
  const width = Math.max(...skills.map((s) => s.name.length));
  const time = (iso: string) => {
    const d = new Date(iso);
    return Number.isNaN(d.getTime()) ? "?" : d.toLocaleTimeString([], { hour12: false });
  };
  const lines = skills.map((s) => {
    const via = (VIAS as SkillLoadVia[]).filter((v) => s.via[v]).map((v) => `${v} ${s.via[v]}`).join(", ");
    return `  ${s.name.padEnd(width)}  ${s.loads}x (${via}), first at ${time(s.first)}\n    ${s.location}`;
  });
  const n = (k: number, word: string) => `${k} ${word}${k === 1 ? "" : "s"}`;
  return [`Skills loaded on this branch: ${n(skills.length, "skill")}, ${n(total, "load")}`, ...lines].join("\n");
}
