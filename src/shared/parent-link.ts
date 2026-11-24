import { randomBytes } from "node:crypto";
import { ENTRY } from "./protocol.ts";

/**
 * Link from a subagent's session to the leader session that started it. The leader passes it to
 * the child process in the environment (PARENT_SESSION_ENV, PARENT_AGENT_ENV); the child records
 * it as a `pi-agent.parent` custom entry at session start (never model context), and the
 * session-upload extension sends it with the upload (PARENT_HEADERS). Both sessions are on the same
 * machine, so the server finds the leader at `<machineId>/<sessionId>` of the same upload.
 *
 * The other direction: the leader records the child's session ID in its `subagent-start` entry
 * (`childSessionId`, chosen before the child starts and passed with `--session-id`).
 */

/** Leader session ID, set in a child's environment by the leader. */
export const PARENT_SESSION_ENV = "PI_AGENT_PARENT_SESSION";
/** The child's agent ID in the leader (`a3`), set with PARENT_SESSION_ENV. */
export const PARENT_AGENT_ENV = "PI_AGENT_PARENT_AGENT";

/** Upload request headers carrying the link (lowercase, as servers see them). */
export const PARENT_HEADERS = {
  sessionId: "x-pi-parent-session-id",
  agentId: "x-pi-parent-agent-id",
} as const;

/** Data of a `pi-agent.parent` entry. */
export interface ParentLink {
  /** Session ID of the leader (its header `id`). */
  sessionId: string;
  /** This session's agent ID in the leader, e.g. `a3`. */
  agentId: string;
}

/** The link from a child's environment; undefined outside a child or when the leader had no session. */
export function parentLinkFromEnv(env: NodeJS.ProcessEnv = process.env): ParentLink | undefined {
  const sessionId = env[PARENT_SESSION_ENV];
  const agentId = env[PARENT_AGENT_ENV];
  return sessionId && agentId ? { sessionId, agentId } : undefined;
}

/** The environment that passes `link` to a child. */
export function parentLinkEnv(link: ParentLink): Record<string, string> {
  return { [PARENT_SESSION_ENV]: link.sessionId, [PARENT_AGENT_ENV]: link.agentId };
}

/** The last valid `pi-agent.parent` entry's link, else undefined (not a subagent session). */
export function sessionParentLink(entries: readonly unknown[]): ParentLink | undefined {
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i] as { type?: unknown; customType?: unknown; data?: { sessionId?: unknown; agentId?: unknown } } | null;
    if (e?.type !== "custom" || e.customType !== ENTRY.parent) continue;
    const { sessionId, agentId } = e.data ?? {};
    if (typeof sessionId === "string" && sessionId && typeof agentId === "string" && agentId) return { sessionId, agentId };
  }
  return undefined;
}

/** Upload headers for `link` (none without one). */
export function parentHeaders(link: ParentLink | undefined): Record<string, string> {
  return link ? { [PARENT_HEADERS.sessionId]: link.sessionId, [PARENT_HEADERS.agentId]: link.agentId } : {};
}

/**
 * A new session ID in pi's own format (UUIDv7: time-ordered), for a child's `--session-id`.
 * pi does not export its generator.
 */
export function newSessionId(now: number = Date.now()): string {
  const b = randomBytes(16);
  b.writeUIntBE(now, 0, 6);
  b[6] = (b[6]! & 0x0f) | 0x70;
  b[8] = (b[8]! & 0x3f) | 0x80;
  const h = b.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
