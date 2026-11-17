import { ENTRY } from "./protocol.ts";
import type { Project } from "./project.ts";

/**
 * The session's setup: the scenario and the project its system prompt was built with, recorded
 * as `pi-agent.scenario` and `pi-agent.project` custom entries (never model context). Like the
 * tags, they belong to the whole file, not a branch: the last entry of each type in the file is
 * the session's. No entry means none was used (or the file predates these entries).
 *
 * The scenario-profile and project extensions append one at session start when a scenario or a
 * project is active and differs from the file's last one (or there is none), so a session
 * started, resumed or forked with the same setup gets exactly one.
 */

export const SCENARIO_ENTRY_VERSION = 1;
export const PROJECT_ENTRY_VERSION = 1;

/** `pi-agent.scenario`: the scenario (`--scenario`) the session runs with. */
export interface ScenarioEntry {
  version: typeof SCENARIO_ENTRY_VERSION;
  name: string;
}

/** Where a project's files come from. */
export type ProjectEntrySource =
  /** A local folder (`--project`, or settings.json `type: local`): its absolute path. */
  | { kind: "local"; dir: string }
  /** A repository pinned to a tag (settings.json `github` / `gitlab`), at the commit the tag had. */
  | { kind: "remote"; provider: string; repo: string; path?: string; tag: string; commit: string };

/** `pi-agent.project`: the project (project.yaml) the session runs with. */
export interface ProjectEntry {
  version: typeof PROJECT_ENTRY_VERSION;
  /** project.yaml `name`. */
  name: string;
  source: ProjectEntrySource;
}

/** The entry for a loaded project. */
export function projectEntry(project: Project): ProjectEntry {
  const r = project.source.remote;
  const source: ProjectEntrySource = r
    ? { kind: "remote", provider: r.provider, repo: r.repo, ...(r.path && { path: r.path }), tag: r.tag, commit: r.commit }
    : { kind: "local", dir: project.source.dir ?? project.dir ?? project.source.label };
  return { version: PROJECT_ENTRY_VERSION, name: project.manifest.name, source };
}

type Custom = { type?: unknown; customType?: unknown; data?: unknown } | null;

/** Data of the last `customType` custom entry that passes `valid` (malformed ones are skipped). */
function last<T>(entries: Iterable<unknown>, customType: string, valid: (data: Record<string, unknown>) => boolean): T | undefined {
  let found: T | undefined;
  for (const entry of entries) {
    const e = entry as Custom;
    if (e?.type !== "custom" || e.customType !== customType || e.data === null || typeof e.data !== "object") continue;
    if (valid(e.data as Record<string, unknown>)) found = e.data as T;
  }
  return found;
}

/** The session's scenario: the last valid `pi-agent.scenario` entry; undefined when there is none. */
export function sessionScenario(entries: Iterable<unknown>): ScenarioEntry | undefined {
  return last(entries, ENTRY.scenario, (d) => typeof d.name === "string");
}

/** The session's project: the last valid `pi-agent.project` entry; undefined when there is none. */
export function sessionProject(entries: Iterable<unknown>): ProjectEntry | undefined {
  return last(entries, ENTRY.project, (d) => typeof d.name === "string" && typeof d.source === "object" && d.source !== null);
}

/** Whether two entries record the same setup (all fields, so a new tag or commit is a change). */
export const sameEntry = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
