import type { JsonAgentSessionEvent, SessionHeader } from "@earendil-works/pi-coding-agent";

/** One record of `pi --mode json` stdout: the session header first, then session events. */
export type StreamRecord = SessionHeader | JsonAgentSessionEvent;

/** Anything that consumes the stream. `t` is the consumer's clock when the record arrived. */
export interface RecordSink {
  onRecord(record: StreamRecord, t: number): void;
}
