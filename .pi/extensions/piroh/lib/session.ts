/**
 * Wire format for a session entry sent over iroh.
 * Mirrors Pi's internal entry shape but with only the fields needed for replay.
 */
export interface WireEntry {
  id: string;
  type: string;
  role?: string;
  content?: unknown;
  timestamp: number;
  toolCallId?: string;
  toolName?: string;
  details?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface SnapshotMessage {
  op: "snapshot";
  entries: WireEntry[];
  seq: number;
}

/**
 * Build a snapshot of entries starting after lastSeq.
 *
 * lastSeq=0 means "send everything" (full snapshot).
 * lastSeq=N means "send entries with index >= N" (delta).
 */
export function buildSnapshot(entries: WireEntry[], lastSeq: number): SnapshotMessage {
  const clamped = Math.max(0, Math.min(lastSeq, entries.length));
  const delta = entries.slice(clamped);
  return {
    op: "snapshot",
    entries: delta,
    seq: entries.length,
  };
}
