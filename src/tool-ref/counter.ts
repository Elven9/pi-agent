import { maxHandle, type EntryLike } from "./resolver.ts";

/** The parts of pi's session manager the counter reads. */
export interface CounterSession {
  getSessionId(): string;
  getEntries(): readonly EntryLike[];
}

const KEY = Symbol.for("pi-agent.tool-ref");

/**
 * Next handle per session id, process-global: `/reload` creates a new extension instance, and a
 * result can reach it before its session_start while the old instance's last number is not
 * persisted yet. The new instance continues from whatever was handed out.
 */
function globalNext(): Map<string, number> {
  const g = globalThis as { [KEY]?: Map<string, number> };
  return (g[KEY] ??= new Map());
}

/**
 * Hands out handles: unique per session file, in the order results are finalized. Initialized
 * lazily (first result or session_start) from the highest handle in the whole file (all
 * branches) and the process-global next number, whichever is higher.
 */
export class HandleCounter {
  /** Session ids this instance has scanned. */
  private readonly scanned = new Set<string>();

  private readonly next: Map<string, number>;

  constructor(next: Map<string, number> = globalNext()) {
    this.next = next;
  }

  /** Scans the session once per instance; synchronous. */
  init(session: CounterSession): string {
    const id = session.getSessionId();
    if (!this.scanned.has(id)) {
      this.next.set(id, Math.max(maxHandle(session.getEntries()) + 1, this.next.get(id) ?? 1));
      this.scanned.add(id);
    }
    return id;
  }

  /** Takes the next handle. Synchronous, so concurrent results never share a number. */
  take(session: CounterSession): number {
    const id = this.init(session);
    const n = this.next.get(id)!;
    this.next.set(id, n + 1);
    return n;
  }
}
