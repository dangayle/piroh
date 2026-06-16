import { describe, it, expect } from "vitest";
import {
  encodeFrame,
  decodeFrame,
  encodeMessage,
  decodeMessage,
  negotiateEncoding,
  CBOR_AVAILABLE,
  type HelloMessage,
  type HelloAckMessage,
  type DecodeResult,
} from "../../.pi/extensions/piroh/lib/protocol";
import { buildSnapshot, type WireEntry, type SnapshotMessage } from "../../.pi/extensions/piroh/lib/session";
import {
  ConnectionState,
  backoffDelay,
} from "../../.pi/extensions/piroh/lib/connection";

// ---------------------------------------------------------------------------
// Helper: create a WireEntry with reasonable defaults
// ---------------------------------------------------------------------------

function makeEntry(id: string, content: string, overrides?: Partial<WireEntry>): WireEntry {
  return {
    id,
    type: "message",
    role: "assistant",
    content,
    timestamp: Date.now(),
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Integration Tests
// ---------------------------------------------------------------------------

describe("integration", () => {
  describe("handshake flow (hello / hello-ack)", () => {
    it("completes full hello → hello-ack exchange over mock stream", async () => {
      // ── Client side ──
      const clientHello: HelloMessage = {
        op: "hello",
        version: 0,
        encoding: CBOR_AVAILABLE ? "cbor" : "json",
        lastSeq: 0,
      };

      // Encode client hello and wrap in a frame
      const clientHelloFrame = encodeFrame(encodeMessage(clientHello, "json"));

      // ── Host side ──
      // Host decodes the incoming frame
      const hostDecodeResult = decodeFrame(clientHelloFrame);
      expect(hostDecodeResult).not.toBeNull();
      const hostHello = decodeMessage(
        (hostDecodeResult as DecodeResult).payload,
        "json"
      ) as HelloMessage;
      expect(hostHello.op).toBe("hello");
      expect(hostHello.version).toBe(0);
      expect(hostHello.lastSeq).toBe(0);

      // Host negotiates encoding and sends ack
      const hostAck = negotiateEncoding(hostHello, CBOR_AVAILABLE);
      expect(hostAck.op).toBe("hello-ack");
      const hostAckFrame = encodeFrame(encodeMessage(hostAck, "json"));

      // ── Client side ──
      // Client decodes the ack
      const clientDecodeResult = decodeFrame(hostAckFrame);
      expect(clientDecodeResult).not.toBeNull();
      const clientAck = decodeMessage(
        (clientDecodeResult as DecodeResult).payload,
        "json"
      ) as HelloAckMessage;
      expect(clientAck.op).toBe("hello-ack");
      expect(clientAck.encoding).toBe(CBOR_AVAILABLE ? "cbor" : "json");

      // Verify encoding was negotiated correctly
      const expectedEncoding = CBOR_AVAILABLE ? "cbor" : "json";
      expect(clientAck.encoding).toBe(expectedEncoding);
    });

    it("handles host without CBOR support (fallback to JSON)", () => {
      const hello: HelloMessage = {
        op: "hello",
        version: 0,
        encoding: "cbor",
        lastSeq: 5,
      };

      // Host does NOT support CBOR
      const ack = negotiateEncoding(hello, false);
      expect(ack.op).toBe("hello-ack");
      expect(ack.encoding).toBe("json");
    });

    it("handles client proposing JSON encoding", () => {
      const hello: HelloMessage = {
        op: "hello",
        version: 0,
        encoding: "json",
        lastSeq: 0,
      };

      const ack = negotiateEncoding(hello, true);
      expect(ack.encoding).toBe("json");
    });

    it("handles hello with non-zero lastSeq (reconnect)", () => {
      const hello: HelloMessage = {
        op: "hello",
        version: 0,
        encoding: "cbor",
        lastSeq: 42,
      };

      const ack = negotiateEncoding(hello, CBOR_AVAILABLE);
      expect(ack.op).toBe("hello-ack");
      // Encoding should match capability
      expect(ack.encoding).toBe(CBOR_AVAILABLE ? "cbor" : "json");
    });
  });

  describe("snapshot replay integration", () => {
    it("builds, encodes, decodes, and replays a full snapshot", () => {
      const entries = [
        makeEntry("1", "Hello from host"),
        makeEntry("2", "Second message"),
        makeEntry("3", "Third message"),
      ];

      // Build snapshot (full — lastSeq=0)
      const snapshot = buildSnapshot(entries, 0);
      expect(snapshot.op).toBe("snapshot");
      expect(snapshot.entries).toHaveLength(3);
      expect(snapshot.seq).toBe(3);

      // Encode snapshot into a frame
      const encoding: "cbor" | "json" = CBOR_AVAILABLE ? "cbor" : "json";
      const frame = encodeFrame(encodeMessage(snapshot, encoding));

      // Decode the frame
      const decodeResult = decodeFrame(frame);
      expect(decodeResult).not.toBeNull();

      // Decode the message
      const decoded = decodeMessage(
        (decodeResult as DecodeResult).payload,
        encoding
      ) as SnapshotMessage;
      expect(decoded.op).toBe("snapshot");
      expect(decoded.entries).toHaveLength(3);
      expect(decoded.seq).toBe(3);

      // Verify each entry roundtrips
      for (let i = 0; i < entries.length; i++) {
        expect(decoded.entries[i].id).toBe(entries[i].id);
        expect(decoded.entries[i].content).toBe(entries[i].content);
      }
    });

    it("builds, encodes, decodes, and replays a delta snapshot", () => {
      const entries = [
        makeEntry("1", "Old"),
        makeEntry("2", "Current"),
        makeEntry("3", "New"),
      ];

      // Build delta — client already saw entries at index 1
      const snapshot = buildSnapshot(entries, 1);
      expect(snapshot.entries).toHaveLength(2); // entries 2 and 3
      expect(snapshot.seq).toBe(3);
      expect(snapshot.entries[0].id).toBe("2");
      expect(snapshot.entries[1].id).toBe("3");

      // Roundtrip
      const encoding: "cbor" | "json" = CBOR_AVAILABLE ? "cbor" : "json";
      const frame = encodeFrame(encodeMessage(snapshot, encoding));
      const decodeResult = decodeFrame(frame);
      const decoded = decodeMessage(
        (decodeResult as DecodeResult).payload,
        encoding
      ) as SnapshotMessage;
      expect(decoded.entries).toHaveLength(2);
      expect(decoded.entries[0].id).toBe("2");
    });

    it("handles empty snapshot (no new entries)", () => {
      const entries = [makeEntry("1", "Only")];
      const snapshot = buildSnapshot(entries, 1); // already seen the single entry
      expect(snapshot.entries).toHaveLength(0);
      expect(snapshot.seq).toBe(1);

      // Roundtrip
      const encoding: "cbor" | "json" = CBOR_AVAILABLE ? "cbor" : "json";
      const frame = encodeFrame(encodeMessage(snapshot, encoding));
      const decodeResult = decodeFrame(frame);
      const decoded = decodeMessage(
        (decodeResult as DecodeResult).payload,
        encoding
      ) as SnapshotMessage;
      expect(decoded.entries).toHaveLength(0);
      expect(decoded.seq).toBe(1);
    });

    it("roundtrips entries with tool-specific fields", () => {
      const entries: WireEntry[] = [
        makeEntry("1", "User message"),
        {
          id: "2",
          type: "tool-execution",
          role: "assistant",
          content: "Running tool...",
          timestamp: Date.now(),
          toolCallId: "call_abc123",
          toolName: "read_file",
          details: { path: "/tmp/test.txt" },
        },
      ];

      const snapshot = buildSnapshot(entries, 0);
      const encoding: "cbor" | "json" = CBOR_AVAILABLE ? "cbor" : "json";
      const frame = encodeFrame(encodeMessage(snapshot, encoding));
      const decodeResult = decodeFrame(frame);
      const decoded = decodeMessage(
        (decodeResult as DecodeResult).payload,
        encoding
      ) as SnapshotMessage;

      expect(decoded.entries).toHaveLength(2);
      const toolEntry = decoded.entries[1];
      expect(toolEntry.toolCallId).toBe("call_abc123");
      expect(toolEntry.toolName).toBe("read_file");
      expect((toolEntry.details as Record<string, unknown>)?.path).toBe("/tmp/test.txt");
    });
  });

  describe("state machine lifecycle", () => {
    it("transitions through full host lifecycle: idle → connecting → connected → disconnected → idle", () => {
      const state = new ConnectionState();
      expect(state.current).toBe("idle");

      // Host starts
      state.transition("idle"); // Host mode set, state stays idle until accept
      expect(state.current).toBe("idle");

      // Client connects
      state.transition("connecting");
      expect(state.current).toBe("connecting");

      // Connection established
      state.transition("connected");
      expect(state.current).toBe("connected");

      // Client disconnects
      state.transition("disconnected");
      expect(state.current).toBe("disconnected");

      // Reset for next session
      state.transition("idle");
      expect(state.current).toBe("idle");
    });

    it("transitions through full client lifecycle: idle → connecting → connected → disconnected → idle", () => {
      const state = new ConnectionState();
      expect(state.current).toBe("idle");

      // Initiate connection
      state.transition("connecting");
      expect(state.current).toBe("connecting");

      // Connection established
      state.transition("connected");
      expect(state.current).toBe("connected");

      // Connection lost, start reconnecting
      state.transition("reconnecting");
      expect(state.current).toBe("reconnecting");

      // Reconnection succeeds
      state.transition("connected");
      expect(state.current).toBe("connected");

      // Clean disconnect
      state.transition("disconnected");
      expect(state.current).toBe("disconnected");

      // Reset
      state.transition("idle");
      expect(state.current).toBe("idle");
    });

    it("transitions: connected → reconnecting (with retries) → disconnected after exhaustion", () => {
      const state = new ConnectionState();
      state.transition("connecting");
      state.transition("connected");
      expect(state.current).toBe("connected");

      // Connection drops, start retry loop
      for (let i = 0; i < 5; i++) {
        state.transition("reconnecting");
        expect(state.current).toBe("reconnecting");
        state.incrementRetry();
        expect(state.retryCount).toBe(i + 1);
      }

      // All retries exhausted
      state.transition("disconnected");
      expect(state.current).toBe("disconnected");
      expect(state.retryCount).toBe(5);
    });

    it("resets retry count on successful connect after reconnecting", () => {
      const state = new ConnectionState();
      state.transition("connecting");
      state.transition("connected");

      // Simulate reconnect cycle
      state.transition("reconnecting");
      state.incrementRetry();
      state.incrementRetry();
      state.incrementRetry();
      expect(state.retryCount).toBe(3);

      // Reconnection succeeds
      state.resetRetries();
      expect(state.retryCount).toBe(0);
      state.transition("connected");
      expect(state.current).toBe("connected");
    });
  });

  // Disconnect cleanup tests removed.
  // They duplicated source logic by mocking state transitions instead of
  // testing the real /iroh-disconnect handler. The real handler requires Pi
  // ExtensionContext mocking which isn't practical for unit tests. Cleanup
  // behavior is verified manually as part of end-to-end validation.

  describe("retry counting and backoff integration", () => {
    it("increments retry count and applies correct backoff delay for each attempt", () => {
      const state = new ConnectionState();

      // Attempt 1: 1s backoff
      state.incrementRetry();
      expect(state.retryCount).toBe(1);
      expect(backoffDelay(state.retryCount)).toBe(1000);

      // Attempt 2: 2s backoff
      state.incrementRetry();
      expect(state.retryCount).toBe(2);
      expect(backoffDelay(state.retryCount)).toBe(2000);

      // Attempt 3: 4s backoff
      state.incrementRetry();
      expect(state.retryCount).toBe(3);
      expect(backoffDelay(state.retryCount)).toBe(4000);

      // Attempt 4: 8s backoff
      state.incrementRetry();
      expect(state.retryCount).toBe(4);
      expect(backoffDelay(state.retryCount)).toBe(8000);

      // Attempt 5: 16s backoff
      state.incrementRetry();
      expect(state.retryCount).toBe(5);
      expect(backoffDelay(state.retryCount)).toBe(16000);
    });

    it("resets retry count to zero after successful connect", () => {
      const state = new ConnectionState();
      state.incrementRetry();
      state.incrementRetry();
      state.incrementRetry();
      expect(state.retryCount).toBe(3);

      state.resetRetries();
      expect(state.retryCount).toBe(0);

      // First retry after reset should be 1s again
      state.incrementRetry();
      expect(state.retryCount).toBe(1);
      expect(state.backoffMs).toBe(1000);
    });

    it("backoffDelay caps at 16 seconds regardless of high attempt number", () => {
      expect(backoffDelay(10)).toBe(16000);
      expect(backoffDelay(20)).toBe(16000);
      expect(backoffDelay(100)).toBe(16000);
    });

    it("backoffDelay produces exponential sequence without exceeding max", () => {
      const delays = [1, 2, 3, 4, 5, 6].map((a) => backoffDelay(a));
      expect(delays).toEqual([1000, 2000, 4000, 8000, 16000, 16000]);
    });
  });

  describe("cross-module frame integrity", () => {
    it("sends a message through encodeFrame, decodes it, and matches the original", () => {
      const original = { op: "input", text: "Hello from client", seq: 1 };
      const encoding: "cbor" | "json" = CBOR_AVAILABLE ? "cbor" : "json";
      const frame = encodeFrame(encodeMessage(original, encoding));

      const result = decodeFrame(frame);
      expect(result).not.toBeNull();
      const decoded = decodeMessage((result as DecodeResult).payload, encoding) as typeof original;

      expect(decoded).toEqual(original);
    });

    it("roundtrips a relay message (output from host to client)", () => {
      const relayMsg = {
        op: "message-start",
        seq: 5,
        message: { role: "assistant", content: "Hello world" },
      };
      const encoding: "cbor" | "json" = CBOR_AVAILABLE ? "cbor" : "json";
      const frame = encodeFrame(encodeMessage(relayMsg, encoding));

      const result = decodeFrame(frame);
      expect(result).not.toBeNull();
      const decoded = decodeMessage((result as DecodeResult).payload, encoding) as typeof relayMsg;

      expect(decoded.op).toBe("message-start");
      expect(decoded.seq).toBe(5);
      expect((decoded.message as Record<string, unknown>).content).toBe("Hello world");
    });

    it("roundtrips a disconnect message", () => {
      const disconnect = { op: "disconnect" as const, seq: 10, reason: "user" };
      const encoding: "cbor" | "json" = CBOR_AVAILABLE ? "cbor" : "json";
      const frame = encodeFrame(encodeMessage(disconnect, encoding));

      const result = decodeFrame(frame);
      expect(result).not.toBeNull();
      const decoded = decodeMessage((result as DecodeResult).payload, encoding) as typeof disconnect;

      expect(decoded.op).toBe("disconnect");
      expect(decoded.seq).toBe(10);
      expect(decoded.reason).toBe("user");
    });
  });

  // This test is a "true integration" that simulates the full handshake+
  // snapshot flow as it would happen in the real extension, using only
  // the public module APIs (no iroh transport dependency).
  describe("end-to-end handshake + snapshot flow (without iroh)", () => {
    it("simulates host→client handshake with snapshot replay via mock stream", async () => {
      const encoding: "cbor" | "json" = CBOR_AVAILABLE ? "cbor" : "json";
      const entries = [
        makeEntry("1", "First message"),
        makeEntry("2", "Second message"),
      ];

      // ── Phase 1: Client sends hello → Host receives it ──
      const clientHello: HelloMessage = {
        op: "hello",
        version: 0,
        encoding,
        lastSeq: 0,
      };
      const helloFrame = encodeFrame(encodeMessage(clientHello, "json"));

      // Host decodes hello
      const hostDecode = decodeFrame(helloFrame);
      expect(hostDecode).not.toBeNull();
      const hostHello = decodeMessage(
        (hostDecode as DecodeResult).payload,
        "json"
      ) as HelloMessage;
      expect(hostHello.op).toBe("hello");
      expect(hostHello.lastSeq).toBe(0);

      // ── Phase 2: Host sends hello-ack → Client receives it ──
      const hostAck = negotiateEncoding(hostHello, CBOR_AVAILABLE);
      expect(hostAck.op).toBe("hello-ack");
      expect(hostAck.encoding).toBe(encoding);
      const ackFrame = encodeFrame(encodeMessage(hostAck, "json"));

      const clientDecode = decodeFrame(ackFrame);
      expect(clientDecode).not.toBeNull();
      const clientAck = decodeMessage(
        (clientDecode as DecodeResult).payload,
        "json"
      ) as HelloAckMessage;
      expect(clientAck.op).toBe("hello-ack");
      expect(clientAck.encoding).toBe(encoding);

      // ── Phase 3: Host builds snapshot from entries + lastSeq ──
      const snapshot = buildSnapshot(entries, hostHello.lastSeq);
      expect(snapshot.op).toBe("snapshot");
      expect(snapshot.entries).toHaveLength(2);
      expect(snapshot.seq).toBe(2);

      // Host encodes and sends snapshot
      const snapshotFrame = encodeFrame(encodeMessage(snapshot, encoding));

      // Client decodes snapshot
      const clientSnapResult = decodeFrame(snapshotFrame);
      expect(clientSnapResult).not.toBeNull();
      const clientSnapshot = decodeMessage(
        (clientSnapResult as DecodeResult).payload,
        encoding
      ) as SnapshotMessage;

      // ── Phase 4: Client replays snapshot entries ──
      expect(clientSnapshot.entries).toHaveLength(2);
      expect(clientSnapshot.entries[0].id).toBe("1");
      expect(clientSnapshot.entries[0].content).toBe("First message");
      expect(clientSnapshot.entries[1].id).toBe("2");
      expect(clientSnapshot.entries[1].content).toBe("Second message");
      expect(clientSnapshot.seq).toBe(2);
    });
  });
});
