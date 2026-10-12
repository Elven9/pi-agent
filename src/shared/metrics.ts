import {
  ENTRY,
  METRICS_ENTRY_VERSION,
  type MetricsSamples,
  type SessionMetricsEntry,
} from "./protocol.ts";
import type { CacheMiss, Metrics, Phase, ToolMetrics } from "./report.ts";
import type { RecordSink, StreamRecord } from "./stream.ts";

/** Nearest-rank percentile; null for no samples. */
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.max(1, Math.ceil((p / 100) * sorted.length));
  return Math.round(sorted[rank - 1]);
}

const round = (n: number) => Math.round(n);

/** A request reading less than this share of the expected cached prefix is a cache miss. */
export const CACHE_MISS_RATIO = 0.95;

interface Usage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost?: { total: number };
}

/**
 * Run metrics from pi's session events, timed with the consumer's clock as records arrive.
 * Keeps summaries, not every event; the session file is the detailed record.
 *
 * Two consumers:
 * - The wrapper feeds it pi's JSON event stream. The stream only carries this run's events (a
 *   forked session's earlier entries are not replayed), so tokens and cost need no baseline.
 *   The context peak comes from the metrics extension's entry, because pi does not stream
 *   context usage.
 * - The metrics extension feeds it the same events from inside pi (plus `compaction()` and
 *   `sampleContext()`), restores it from the branch's earlier entries (`restore()`), and
 *   appends `entry()` to the session.
 */
export class MetricsCollector implements RecordSink {
  private readonly now: () => number;
  private readonly t0: number;
  private readonly phases: Metrics["phases"] = {};
  private current?: { name: Phase; start: number };

  private readonly tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
  private cost = 0;
  private turns = 0;
  private retries = 0;
  private compactions = 0;
  private contextPeak: number | null = null;

  /**
   * Tokens the last successful request left in the prompt cache (`cacheRead + cacheWrite`);
   * undefined before the first request and after a compaction, when there is nothing to expect.
   */
  private cachedPrefix?: number;
  private readonly cacheMisses: CacheMiss[] = [];

  /**
   * Time the current model request was sent. pi emits `message_start` only once the response
   * stream has started, so the request is timed from `turn_start` (sent right after it).
   */
  private requestStart?: number;
  /** In-flight assistant message: request start and time of first streamed token. */
  private message?: { start: number; firstToken?: number };
  private readonly ttft: number[] = [];
  private readonly latency: number[] = [];

  /** Tool calls run in parallel, so they are paired by toolCallId, not by order. */
  private readonly toolStarts = new Map<string, { name: string; start: number }>();
  private readonly toolDurations = new Map<string, { calls: number; errors: number; ms: number[] }>();

  /** Samples already written to an entry: counts per list, so entries carry only new ones. */
  private written = { ttft: 0, latency: 0, tools: new Map<string, number>() };
  /** The last entry's cumulative part, to skip writing an unchanged one. */
  private lastEntryKey?: string;

  constructor(now: () => number = () => performance.now()) {
    this.now = now;
    this.t0 = now();
  }

  /** Ends the current phase (if any) and starts `name`. */
  phase(name: Phase): void {
    this.endPhase();
    this.current = { name, start: this.now() };
  }

  get currentPhase(): Phase | undefined {
    return this.current?.name;
  }

  endPhase(): void {
    if (!this.current) return;
    this.phases[`${this.current.name}Ms`] = round(this.now() - this.current.start);
    this.current = undefined;
  }

  /** A successful compaction, with the usage of its summary request. */
  compaction(usage: unknown): void {
    this.compactions++;
    this.addUsage(usage as Usage | undefined);
    // The summary replaces the history: the next request starts a new prefix.
    this.cachedPrefix = undefined;
  }

  /** Context usage in percent (0-100), as pi reports it; keeps the highest. */
  sampleContext(percent: number | null | undefined): void {
    if (percent != null) this.contextPeak = Math.max(this.contextPeak ?? 0, percent);
  }

  private addUsage(usage: Usage | undefined): void {
    if (!usage) return;
    this.tokens.input += usage.input ?? 0;
    this.tokens.output += usage.output ?? 0;
    this.tokens.cacheRead += usage.cacheRead ?? 0;
    this.tokens.cacheWrite += usage.cacheWrite ?? 0;
    this.cost += usage.cost?.total ?? 0;
  }

  /**
   * Compares a request's cache read with what the previous request cached. Requests that
   * failed before the provider reported usage (all zeros) are skipped and don't move the
   * baseline. A prefix too short to cache leaves the baseline at 0, so it is never a miss.
   */
  private checkCache(usage: Usage | undefined): void {
    const read = usage?.cacheRead ?? 0;
    const cached = read + (usage?.cacheWrite ?? 0);
    if (!usage || cached + (usage.input ?? 0) === 0) return;
    const expected = this.cachedPrefix;
    if (expected !== undefined && expected > 0 && read < expected * CACHE_MISS_RATIO) {
      this.cacheMisses.push({ turn: this.turns, expected, cacheRead: read });
    }
    this.cachedPrefix = cached;
  }

  onRecord(record: StreamRecord, t: number = this.now()): void {
    switch (record.type) {
      case "turn_start":
        this.turns++;
        this.requestStart = t;
        break;
      case "message_start":
        if (record.message.role === "assistant") {
          this.message = { start: this.requestStart ?? t };
          this.requestStart = undefined;
        }
        break;
      case "message_update": {
        // First streamed content of any kind (text, thinking or tool call) counts as first token,
        // so turns that only call tools still get a TTFT sample.
        const kind = record.assistantMessageEvent.type;
        if (this.message && this.message.firstToken === undefined && kind.endsWith("_delta")) {
          this.message.firstToken = t;
        }
        break;
      }
      case "message_end":
        if (record.message.role === "assistant") {
          const usage = (record.message as { usage?: Usage }).usage;
          this.addUsage(usage);
          this.checkCache(usage);
          if (this.message) {
            this.latency.push(t - this.message.start);
            if (this.message.firstToken !== undefined) this.ttft.push(this.message.firstToken - this.message.start);
            this.message = undefined;
          }
        }
        break;
      case "tool_execution_start":
        this.toolStarts.set(record.toolCallId, { name: record.toolName, start: t });
        break;
      case "tool_execution_end": {
        const started = this.toolStarts.get(record.toolCallId);
        this.toolStarts.delete(record.toolCallId);
        const name = started?.name ?? record.toolName;
        let entry = this.toolDurations.get(name);
        if (!entry) this.toolDurations.set(name, (entry = { calls: 0, errors: 0, ms: [] }));
        entry.calls++;
        if (record.isError) entry.errors++;
        if (started) entry.ms.push(t - started.start);
        break;
      }
      case "auto_retry_start":
        this.retries++;
        break;
      case "compaction_end":
        if (!record.aborted && record.result) this.compaction(record.result.usage);
        break;
      case "entry_appended": {
        const entry = record.entry;
        if (entry.type === "custom" && entry.customType === ENTRY.metrics) {
          this.contextPeak = (entry.data as Partial<SessionMetricsEntry> | undefined)?.contextPeakPercent ?? this.contextPeak;
        }
        break;
      }
    }
  }

  snapshot(): Metrics {
    const tools: Record<string, ToolMetrics> = {};
    for (const [name, { calls, errors, ms }] of this.toolDurations) {
      tools[name] = {
        calls,
        errors,
        msP50: percentile(ms, 50) ?? 0,
        msMax: ms.length ? round(Math.max(...ms)) : 0,
      };
    }
    return {
      wallMs: round(this.now() - this.t0),
      phases: { ...this.phases },
      tokens: { ...this.tokens },
      costUsd: Math.round(this.cost * 1e6) / 1e6,
      turns: this.turns,
      model: {
        calls: this.latency.length,
        ttftMsP50: percentile(this.ttft, 50),
        latencyMsP50: percentile(this.latency, 50),
        latencyMsMax: this.latency.length ? round(Math.max(...this.latency)) : null,
      },
      tools,
      retries: this.retries,
      compactions: this.compactions,
      contextPeakPercent: this.contextPeak === null ? null : Math.round(this.contextPeak),
      cacheMisses: [...this.cacheMisses],
    };
  }

  /**
   * Data for a `pi-agent.metrics` session entry: the cumulative metrics plus the samples since
   * the previous entry. Undefined when nothing changed since the previous one. Marks the
   * samples as written.
   */
  entry(): SessionMetricsEntry | undefined {
    const metrics = this.entryMetrics();
    const samples: MetricsSamples = {
      ttftMs: this.ttft.slice(this.written.ttft).map(round),
      latencyMs: this.latency.slice(this.written.latency).map(round),
      toolMs: {},
    };
    for (const [name, { ms }] of this.toolDurations) {
      const fresh = ms.slice(this.written.tools.get(name) ?? 0);
      if (fresh.length) samples.toolMs[name] = fresh.map(round);
    }
    const key = JSON.stringify(metrics);
    if (key === this.lastEntryKey) return undefined;
    this.lastEntryKey = key;
    this.written = {
      ttft: this.ttft.length,
      latency: this.latency.length,
      tools: new Map([...this.toolDurations].map(([name, { ms }]) => [name, ms.length])),
    };
    return { version: METRICS_ENTRY_VERSION, ...metrics, samples };
  }

  /**
   * Continues from a branch's earlier `pi-agent.metrics` entries (oldest first): counters from
   * the newest, samples from all of them. Entries of another version are ignored. The cache
   * check starts over (the first request after a resume is not checked).
   */
  restore(entries: readonly unknown[]): void {
    const valid = entries.filter(
      (e): e is SessionMetricsEntry => (e as SessionMetricsEntry | undefined)?.version === METRICS_ENTRY_VERSION,
    );
    const last = valid.at(-1);
    if (!last) return;
    Object.assign(this.tokens, last.tokens);
    this.cost = last.costUsd;
    this.turns = last.turns;
    this.compactions = last.compactions;
    this.contextPeak = last.contextPeakPercent;
    this.cacheMisses.splice(0, this.cacheMisses.length, ...last.cacheMisses);
    this.ttft.splice(0, this.ttft.length, ...valid.flatMap((e) => e.samples.ttftMs));
    this.latency.splice(0, this.latency.length, ...valid.flatMap((e) => e.samples.latencyMs));
    this.toolDurations.clear();
    for (const [name, { calls, errors }] of Object.entries(last.tools)) {
      this.toolDurations.set(name, { calls, errors, ms: valid.flatMap((e) => e.samples.toolMs[name] ?? []) });
    }
    this.written = {
      ttft: this.ttft.length,
      latency: this.latency.length,
      tools: new Map([...this.toolDurations].map(([name, { ms }]) => [name, ms.length])),
    };
    this.lastEntryKey = JSON.stringify(this.entryMetrics());
  }

  /** The snapshot without what only the wrapper measures. */
  private entryMetrics(): Omit<SessionMetricsEntry, "version" | "samples"> {
    const { wallMs: _w, phases: _p, retries: _r, ...metrics } = this.snapshot();
    return metrics;
  }
}
