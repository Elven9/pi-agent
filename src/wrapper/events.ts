export type { RecordSink, StreamRecord } from "../shared/stream.ts";

/**
 * Splits pi's JSONL stdout into records. Splits on LF only (strips an optional CR), as
 * `docs/json.md` requires: U+2028/U+2029 inside JSON strings are not record boundaries, which
 * is why Node's `readline` is not used. Splitting the raw bytes on 0x0A is safe in UTF-8.
 */
export class JsonlSplitter {
  private pending: Buffer[] = [];
  private readonly onLine: (line: string) => void;

  constructor(onLine: (line: string) => void) {
    this.onLine = onLine;
  }

  push(chunk: Buffer): void {
    let start = 0;
    let nl: number;
    while ((nl = chunk.indexOf(0x0a, start)) !== -1) {
      this.pending.push(chunk.subarray(start, nl));
      this.emit();
      start = nl + 1;
    }
    if (start < chunk.length) this.pending.push(chunk.subarray(start));
  }

  /** Emits a final record without a trailing LF, if any. */
  end(): void {
    if (this.pending.length) this.emit();
  }

  private emit(): void {
    let line = Buffer.concat(this.pending).toString("utf8");
    this.pending = [];
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line.trim() !== "") this.onLine(line);
  }
}
