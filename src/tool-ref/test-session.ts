import type { EntryLike } from "./resolver.ts";

/** Builds session entries (a tree) for tool-ref tests. Not part of the extension. */
export class TestSession {
  readonly entries: EntryLike[] = [];
  leafId: string | null = null;
  private seq = 0;
  private time = Date.UTC(2026, 9, 22, 10, 0, 0);

  private add(entry: Omit<EntryLike, "id" | "parentId">): string {
    const id = `e${++this.seq}`;
    this.entries.push({ ...entry, id, parentId: this.leafId });
    this.leafId = id;
    return id;
  }

  message(message: Record<string, unknown>): string {
    this.time += 1000;
    return this.add({ type: "message", timestamp: new Date(this.time).toISOString(), message: { timestamp: this.time, ...message } });
  }

  user(text: string): string {
    return this.message({ role: "user", content: [{ type: "text", text }] });
  }

  /**
   * One assistant message with the calls, then one result per call. `handle` adds a trailer;
   * `content` defaults to a text block with `output`.
   */
  calls(
    ...calls: Array<{
      id: string;
      tool: string;
      input?: Record<string, unknown>;
      output?: string;
      content?: unknown[];
      isError?: boolean;
      handle?: number;
      durationMs?: number;
    }>
  ): string[] {
    this.message({
      role: "assistant",
      content: calls.map((c) => ({ type: "toolCall", id: c.id, name: c.tool, arguments: c.input ?? {} })),
    });
    return calls.map((c) => {
      const content = [...(c.content ?? [{ type: "text", text: c.output ?? "" }])];
      if (c.handle !== undefined) content.push({ type: "text", text: `[tool-ref #${c.handle}]` });
      return this.message({
        role: "toolResult",
        toolCallId: c.id,
        toolName: c.tool,
        content,
        isError: c.isError ?? false,
        ...(c.durationMs !== undefined ? { durationMs: c.durationMs } : {}),
      });
    });
  }

  /** A non-message entry (compaction, context_edit, …). */
  entry(type: string, data: Record<string, unknown> = {}): string {
    return this.add({ type, timestamp: new Date(this.time).toISOString(), ...data });
  }

  /** Moves the leaf (like /tree navigation) without writing an entry. */
  branchFrom(id: string | null): void {
    this.leafId = id;
  }

  /** The entries as a session JSONL file (with a header). */
  jsonl(): string {
    const header = { type: "session", version: 3, id: "s1", timestamp: new Date(this.time).toISOString(), cwd: "/w" };
    return [header, ...this.entries].map((e) => JSON.stringify(e)).join("\n") + "\n";
  }
}
