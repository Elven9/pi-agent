import type { SessionHeader } from "@earendil-works/pi-coding-agent";
import { ENTRY, SUBMIT_RESULT } from "../shared/protocol.ts";
import type { RecordSink, StreamRecord } from "./events.ts";

/**
 * What the run produced, from pi's JSON event stream: the session header, the last
 * successful `submit_result` (its `details`), the final model error and errors the extension
 * reported.
 */
export class RunOutcome implements RecordSink {
  header?: SessionHeader;
  /** `details` of the last successful submit_result call (validated later by the wrapper). */
  result?: unknown;
  /** Set once the agent loop started (pi got past startup). */
  started = false;
  /** Error message of the last assistant message, if that model response failed. */
  modelError?: string;
  /** Errors reported by the extension (e.g. unknown scenario). */
  readonly extensionErrors: string[] = [];
  /** Records that could not be parsed. */
  badRecords = 0;

  onRecord(record: StreamRecord): void {
    switch (record.type) {
      case "session":
        this.header = record;
        break;
      case "agent_start":
        this.started = true;
        break;
      case "message_end": {
        const m = record.message;
        if (m.role !== "assistant") break;
        this.modelError =
          m.stopReason === "error" || m.stopReason === "aborted"
            ? (m.errorMessage ?? `model response ${m.stopReason}`)
            : undefined;
        break;
      }
      case "tool_execution_end":
        if (record.toolName === SUBMIT_RESULT && !record.isError && !record.parentToolCallId) {
          this.result = (record.result as { details?: unknown } | undefined)?.details;
        }
        break;
      case "entry_appended": {
        const e = record.entry;
        if (e.type === "custom" && e.customType === ENTRY.error) {
          this.extensionErrors.push(String((e.data as { message?: unknown } | undefined)?.message ?? "extension error"));
        }
        break;
      }
    }
  }
}
