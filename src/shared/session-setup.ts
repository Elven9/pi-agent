import { ENTRY } from "./protocol.ts";
import type { Project } from "./project.ts";

/**
 * The session's setup: the scenario and the project its system prompt was built with, recorded
 * as `pi-agent.scenario` and `pi-agent.project` custom entries (never model context). Like the
 * tags, they belong to the whole file, not a branch: the last entry of each type in the file is
 * the session's. No entry (or one with `name: null`) means none was used, or the file predates
 * these entries.
 *
 * The setup is fixed for a session (`decideSetup`), since it shapes the system prompt:
 * - startup (`pi`, `-c`, `--session`, `--fork`): a session without a recorded setup takes the
 *   process's (flags, settings.json); one with a recorded setup must be started with the same
 *   one: dropping it or changing it is an error (pi exits), unless `--allow-setup-change`.
 * - /resume, /fork, /reload: the session's recorded setup is used, whatever the process was
 *   started with; without one, the process's.
 * - /new: the process's.
 *
 * The scenario-profile and project extensions append an entry at session start when the setup
 * in use differs from the file's last one, so a session resumed with the same setup gets none.
 */

export const SCENARIO_ENTRY_VERSION = 1;
export const PROJECT_ENTRY_VERSION = 1;

/** Extension CLI flag (registered by both extensions): start a session with a setup other than its recorded one. */
export const ALLOW_SETUP_CHANGE_FLAG = "allow-setup-change";
export const ALLOW_SETUP_CHANGE_DESCRIPTION =
  "Resume a session with another scenario or project than it was recorded with (or none); the new setup is recorded";

/** `pi-agent.scenario`: the scenario (`--scenario`) the session runs with; `null`: none (after --allow-setup-change). */
export interface ScenarioEntry {
  version: typeof SCENARIO_ENTRY_VERSION;
  name: string | null;
}

/** Where a project's files come from. */
export type ProjectEntrySource =
  /** A local folder (`--project`, or settings.json `type: local`): its absolute path. */
  | { kind: "local"; dir: string }
  /** A repository pinned to a tag (settings.json `github` / `gitlab`), at the commit the tag had. */
  | { kind: "remote"; provider: "github" | "gitlab"; repo: string; path?: string; tag: string; commit: string };

/** `pi-agent.project`: the project (project.yaml) the session runs with; `name: null`: none (after --allow-setup-change). */
export type ProjectEntry =
  | { version: typeof PROJECT_ENTRY_VERSION; name: string; source: ProjectEntrySource }
  | { version: typeof PROJECT_ENTRY_VERSION; name: null };

/** The entry for a loaded project. */
export function projectEntry(project: Project): ProjectEntry {
  const r = project.source.remote;
  const source: ProjectEntrySource = r
    ? { kind: "remote", provider: r.provider, repo: r.repo, ...(r.path && { path: r.path }), tag: r.tag, commit: r.commit }
    : { kind: "local", dir: project.source.dir ?? project.dir ?? project.source.label };
  return { version: PROJECT_ENTRY_VERSION, name: project.manifest.name, source };
}

/**
 * A project's identity: the same local folder, or the same repository and folder in it (another
 * tag or commit is the same project).
 */
export type ProjectIdentity =
  | { kind: "local"; dir: string }
  | { kind: "remote"; provider: string; repo: string; path?: string };

export const projectKey = (p: ProjectIdentity) =>
  p.kind === "local" ? `local:${p.dir}` : `${p.provider}:${p.repo}${p.path ? `/${p.path}` : ""}`;
export const projectLabel = (p: ProjectIdentity) =>
  p.kind === "local" ? p.dir : `${p.repo}${p.path ? `/${p.path}` : ""}`;

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

/** The last valid `pi-agent.scenario` entry; undefined when there is none. */
export function sessionScenarioEntry(entries: Iterable<unknown>): ScenarioEntry | undefined {
  return last(entries, ENTRY.scenario, (d) => typeof d.name === "string" || d.name === null);
}

/** The session's scenario name; undefined when none is recorded. */
export function sessionScenario(entries: Iterable<unknown>): string | undefined {
  return sessionScenarioEntry(entries)?.name ?? undefined;
}

/** The last valid `pi-agent.project` entry; undefined when there is none. */
export function sessionProjectEntry(entries: Iterable<unknown>): ProjectEntry | undefined {
  return last(
    entries,
    ENTRY.project,
    (d) => d.name === null || (typeof d.name === "string" && typeof d.source === "object" && d.source !== null),
  );
}

/** The session's project (name and source); undefined when none is recorded. */
export function sessionProject(entries: Iterable<unknown>): { name: string; source: ProjectEntrySource } | undefined {
  const e = sessionProjectEntry(entries);
  return e && e.name !== null ? e : undefined;
}

/** Whether two entries record the same setup (all fields, so a new tag or commit is a change). */
export const sameEntry = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** Why the session started (pi's session_start reason). */
export type StartReason = "startup" | "reload" | "new" | "resume" | "fork";

export type SetupDecision = { use: "current" } | { use: "recorded" } | { error: string };

/**
 * Which setup a session start uses (see the module comment): the process's (`current`) or the
 * session's recorded one, or an error. Setups are compared by `key`; undefined is none.
 */
export function decideSetup<T>(o: {
  what: "scenario" | "project";
  reason: StartReason;
  recorded: T | undefined;
  current: T | undefined;
  key: (setup: T) => string;
  label: (setup: T) => string;
  allowChange: boolean;
}): SetupDecision {
  const { what, recorded, current } = o;
  if (o.reason === "new" || recorded === undefined) return { use: "current" };
  if (o.reason !== "startup") return { use: "recorded" };
  if (current !== undefined && o.key(current) === o.key(recorded)) return { use: "current" };
  if (o.allowChange) return { use: "current" };
  const was = `This session was recorded with the ${what} ${o.label(recorded)}`;
  const how = `Start it with the same ${what}, or pass --${ALLOW_SETUP_CHANGE_FLAG} to `;
  return current === undefined
    ? { error: `${was}, but none is set now. ${how}continue without it.` }
    : { error: `${was}, not ${o.label(current)}. ${how}switch to ${o.label(current)}.` };
}
