import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { MetricsCollector } from "../shared/metrics.ts";
import { ENTRY, METRICS_FLUSH_CHANNEL, type SessionMetricsEntry } from "../shared/protocol.ts";
import type { StreamRecord } from "../shared/stream.ts";

/**
 * Session metrics extension, loaded by both the runner (`-e dist/metrics.js`) and personal pi
 * (package manifest). Keeps a MetricsCollector in memory, fed with pi's events, and writes its
 * totals into the session file as `pi-agent.metrics` custom entries (not model context):
 *
 * - at `agent_before_settle` (once per prompt; also seen by the wrapper in the JSON stream),
 * - at `session_shutdown` (/quit, /new, /resume, /fork, /reload), if anything changed,
 * - on request through `pi.events` (METRICS_FLUSH_CHANNEL), e.g. right before an upload.
 *
 * On session start it continues from the branch's earlier entries, so the newest entry is the
 * session's total across resumes. See SessionMetricsEntry.
 */
export default function sessionMetrics(pi: ExtensionAPI) {
  let collector: MetricsCollector | undefined;
  let unsubscribe: (() => void) | undefined;

  const feed = (event: unknown) => collector?.onRecord(event as StreamRecord, performance.now());
  const append = () => {
    const data = collector?.entry();
    if (data) pi.appendEntry<SessionMetricsEntry>(ENTRY.metrics, data);
  };

  pi.on("session_start", (_event, ctx) => {
    collector = new MetricsCollector();
    collector.restore(
      ctx.sessionManager
        .getBranch()
        .filter((e) => e.type === "custom" && e.customType === ENTRY.metrics)
        .map((e) => (e as { data?: unknown }).data),
    );
    unsubscribe?.();
    unsubscribe = pi.events.on(METRICS_FLUSH_CHANNEL, append);
  });

  pi.on("turn_start", feed);
  pi.on("message_start", feed);
  pi.on("message_update", feed);
  pi.on("message_end", (event, ctx) => {
    feed(event);
    if (event.message.role === "assistant") sampleContext(ctx);
  });
  pi.on("tool_execution_start", feed);
  pi.on("tool_execution_end", feed);
  pi.on("session_compact", (event, ctx) => {
    collector?.compaction(event.compactionEntry.usage);
    sampleContext(ctx);
  });

  const sampleContext = (ctx: ExtensionContext) => collector?.sampleContext(ctx.getContextUsage()?.percent);

  // Returned entries replace the ones earlier handlers proposed, so keep theirs.
  pi.on("agent_before_settle", (event) => {
    const data = collector?.entry();
    if (!data) return;
    return { entries: [...event.entries, { type: "custom", customType: ENTRY.metrics, data }] };
  });

  pi.on("session_shutdown", () => {
    append();
    unsubscribe?.();
    unsubscribe = undefined;
    collector = undefined;
  });
}
