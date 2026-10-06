import type { ToolCallLog } from "../shared/report.ts";
import type { RecordSink, StreamRecord } from "./events.ts";

export interface ToolLogOptions {
  /** Max length of each string in `args`. */
  maxArgChars?: number;
  /** Max length of `output`. */
  maxOutputChars?: number;
  /** Wall clock in epoch ms (injectable for tests). */
  now?: () => number;
}

function cut(s: string, max: number): { text: string; cut: boolean } {
  if (s.length <= max) return { text: s, cut: false };
  return { text: `${s.slice(0, max)}… [${s.length - max} more chars]`, cut: true };
}

/** Text of a tool result: text blocks joined, images as placeholders. */
function resultText(result: unknown): string {
  const content = (result as { content?: unknown })?.content;
  if (!Array.isArray(content)) return result === undefined ? "" : JSON.stringify(result);
  return content
    .map((c: { type?: string; text?: string }) => (c?.type === "text" ? (c.text ?? "") : `[${c?.type ?? "unknown"}]`))
    .join("\n");
}

/**
 * Records every tool call of the run, in start order. Calls run in parallel, so the end event
 * is paired with its start by toolCallId.
 */
export class ToolLog implements RecordSink {
  private readonly maxArgChars: number;
  private readonly maxOutputChars: number;
  private readonly now: () => number;
  private readonly calls: ToolCallLog[] = [];
  private readonly open = new Map<string, { entry: ToolCallLog; start: number }>();
  private turn = 0;

  constructor(opts: ToolLogOptions = {}) {
    this.maxArgChars = opts.maxArgChars ?? 1000;
    this.maxOutputChars = opts.maxOutputChars ?? 2000;
    this.now = opts.now ?? Date.now;
  }

  onRecord(event: StreamRecord): void {
    switch (event.type) {
      case "turn_start":
        this.turn++;
        break;
      case "tool_execution_start": {
        const start = this.now();
        let truncated = false;
        const args = JSON.parse(
          JSON.stringify(event.args ?? null, (_key, value) => {
            if (typeof value !== "string") return value;
            const c = cut(value, this.maxArgChars);
            truncated ||= c.cut;
            return c.text;
          }),
        );
        const entry: ToolCallLog = {
          id: event.toolCallId,
          tool: event.toolName,
          turn: this.turn,
          startedAt: new Date(start).toISOString(),
          durationMs: null,
          isError: null,
          args,
          output: null,
          truncated,
        };
        this.calls.push(entry);
        this.open.set(event.toolCallId, { entry, start });
        break;
      }
      case "tool_execution_end": {
        const started = this.open.get(event.toolCallId);
        if (!started) break;
        this.open.delete(event.toolCallId);
        const { entry, start } = started;
        const out = cut(resultText(event.result), this.maxOutputChars);
        entry.durationMs = Math.round(this.now() - start);
        entry.isError = event.isError;
        entry.output = out.text;
        entry.truncated ||= out.cut;
        break;
      }
    }
  }

  entries(): ToolCallLog[] {
    return this.calls.map((c) => ({ ...c }));
  }
}
