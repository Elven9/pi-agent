import type { Herdr, HerdrResult } from "./herdr.ts";
import { displayName, paneSuffix, shortLabel, slug, withSuffix } from "./names.ts";

/** Longest a pi session switch or quit waits for the clear. */
export const SHUTDOWN_CAP_MS = 2000;
/** Retries (on agent_start) of one requested name after a failed step. */
export const MAX_RETRIES = 3;

const NAME_TAKEN = "agent_name_taken";

export interface SessionNameSync {
  /** Show `name` in herdr, or clear all three names when undefined. Returns at once. */
  request(name: string | undefined): void;
  /** Apply the last requested name again if a step of it failed (at most MAX_RETRIES times). */
  retry(): void;
  /** Drop queued work, wait for the running sync, clear all three names. Capped; later requests are ignored. */
  shutdown(): Promise<void>;
  /** Resolves once no sync is running (tests). */
  idle(): Promise<void>;
  /** The last sync had a failed step. */
  readonly failed: boolean;
}

/**
 * Keeps one pane's herdr names in line with the pi session name. One sync runs at a time; a
 * request made meanwhile replaces any queued one, so only the latest name is applied.
 */
export function createSync(herdr: Herdr, paneId: string, o: { shutdownCapMs?: number } = {}): SessionNameSync {
  const capMs = o.shutdownCapMs ?? SHUTDOWN_CAP_MS;
  let current: string | undefined;
  let failed = false;
  let retries = 0;
  let closed = false;
  let pending: { name: string | undefined } | undefined;
  let draining: Promise<void> | undefined;
  // herdr ignores a report-metadata with a lower seq than the last one: start from the clock so a
  // later runtime (next session in the same pane) is always ahead of this one.
  let seq = Date.now() * 1000;

  const agentName = async (name: string): Promise<boolean> => {
    const base = slug(name);
    if (!base) {
      await herdr.renameAgent(); // nothing usable in the name: drop any earlier agent name
      return true;
    }
    let result = await herdr.renameAgent(base);
    if (!result.ok && result.code === NAME_TAKEN) {
      const other = withSuffix(base, paneSuffix(paneId));
      if (other) result = await herdr.renameAgent(other);
    }
    return result.ok;
  };

  // Gone is cleared: herdr drops the agent name itself when the agent exits.
  const cleared = (r: HerdrResult) => r.ok || (r.code?.endsWith("_not_found") ?? false);

  /** Every step runs even if an earlier one failed. Returns whether all of them worked. */
  const clearAll = async (): Promise<boolean> => {
    const pane = cleared(await herdr.renamePane());
    const agent = cleared(await herdr.renameAgent());
    const display = cleared(await herdr.displayAgent(undefined, ++seq));
    return pane && agent && display;
  };

  const apply = async (name: string | undefined): Promise<boolean> => {
    const label = name === undefined ? "" : shortLabel(name);
    if (name === undefined || !label) return clearAll();
    const pane = (await herdr.renamePane(label)).ok;
    const display = (await herdr.displayAgent(displayName(name), ++seq)).ok;
    const agent = await agentName(name);
    return pane && display && agent;
  };

  const drain = async () => {
    while (pending) {
      const { name } = pending;
      pending = undefined;
      failed = !(await apply(name));
    }
  };

  const kick = () => {
    if (draining || !pending) return;
    draining = drain().finally(() => {
      draining = undefined;
      kick(); // a request that came in after the loop's last check
    });
  };

  const enqueue = (name: string | undefined) => {
    if (closed) return;
    current = name;
    pending = { name };
    kick();
  };

  const idle = async () => {
    while (draining) await draining;
  };

  return {
    request(name) {
      retries = 0;
      enqueue(name);
    },
    retry() {
      if (!failed || closed || draining || retries >= MAX_RETRIES) return;
      retries++;
      enqueue(current);
    },
    async shutdown() {
      closed = true;
      pending = undefined;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const cap = new Promise<void>((resolve) => {
        timer = setTimeout(resolve, capMs);
      });
      const work = idle()
        .then(clearAll)
        .catch(() => false);
      await Promise.race([work, cap]);
      clearTimeout(timer);
    },
    idle,
    get failed() {
      return failed;
    },
  };
}
