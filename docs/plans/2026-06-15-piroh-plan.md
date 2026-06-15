# piroh Implementation Plan

> **REQUIRED SUB-SKILL:** Use the executing-plans skill to implement this plan task-by-task.

**Goal:** Build a Pi extension that connects two Pi sessions over Iroh, sharing input/output as one seamless session.

**Architecture:** A single Pi extension at `.pi/extensions/piroh/index.ts` with three library modules. The host runs the Pi agent; the client forwards input and renders output. Communication over a single iroh bi-directional QUIC stream with length-prefixed CBOR/JSON frames.

**Tech Stack:** TypeScript (via jiti), `@number0/iroh` (iroh napi-rs bindings), `cbor-x` (CBOR with JSON fallback), vitest (testing), `@earendil-works/pi-coding-agent` (Pi extension types), `typebox` (tool parameter schemas)

---

### Task 0: Scaffold extension package

**TDD scenario:** Setup only — no code to test. Skip TDD.

**Files:**
- Create: `.pi/extensions/piroh/package.json`
- Create: `.pi/extensions/piroh/index.ts`
- Create: `.pi/extensions/piroh/lib/protocol.ts`
- Create: `.pi/extensions/piroh/lib/session.ts`
- Create: `.pi/extensions/piroh/lib/connection.ts`
- Create: `vitest.config.ts`
- Create: `__tests__/piroh/protocol.test.ts`
- Create: `__tests__/piroh/session.test.ts`

**Step 1: Create extension package.json**

```json
{
  "name": "piroh",
  "private": true,
  "dependencies": {
    "@number0/iroh": "^0.35.0",
    "cbor-x": "^1.6.0"
  },
  "pi": {
    "extensions": ["./index.ts"]
  }
}
```

Run: `cd .pi/extensions/piroh && npm install`

**Step 2: Create vitest.config.ts at project root**

```typescript
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["__tests__/**/*.test.ts"],
  },
});
```

Run: `npm install -D vitest typescript @types/node`

**Step 3: Create stub files with empty exports**

Create `.pi/extensions/piroh/lib/protocol.ts`:
```typescript
// Frame encoding/decoding for the piroh wire protocol
// Will be implemented in Task 1
```

Create `.pi/extensions/piroh/lib/session.ts`:
```typescript
// Session snapshot building, delta replay, entry serialization
// Will be implemented in Task 2
```

Create `.pi/extensions/piroh/lib/connection.ts`:
```typescript
// Iroh endpoint lifecycle, connection management, reconnect
// Will be implemented in Task 3
```

Create `.pi/extensions/piroh/index.ts`:
```typescript
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  // Will be implemented in Tasks 4-6
}
```

**Step 4: Create empty test files**

Create `__tests__/piroh/protocol.test.ts`:
```typescript
import { describe, it } from "vitest";

describe("protocol", () => {
  it.todo("encodes a frame with length prefix");
  it.todo("decodes a frame from a buffer");
  it.todo("encodes and decodes CBOR");
  it.todo("falls back to JSON when CBOR unavailable");
  it.todo("negotiates encoding via hello handshake");
});
```

Create `__tests__/piroh/session.test.ts`:
```typescript
import { describe, it } from "vitest";

describe("session", () => {
  it.todo("builds full snapshot from entries");
  it.todo("builds delta snapshot from lastSeq");
  it.todo("replays entries into a session manager");
  it.todo("serializes and deserializes entries");
});
```

**Step 5: Verify project structure**

Run: `find .pi/extensions/piroh -type f | sort`
Expected: Shows package.json, index.ts, lib/protocol.ts, lib/session.ts, lib/connection.ts, node_modules/

Run: `npx vitest --run`
Expected: 9 todo tests listed, all skipped

**Step 6: Commit**

```bash
git add .pi/extensions/piroh/ vitest.config.ts __tests__/ package.json
git commit -m "chore: scaffold piroh extension package and test setup"
```

---

### Task 1: Frame protocol (encode/decode)

**TDD scenario:** New feature — full TDD cycle. Write tests first, then implement.

**Files:**
- Modify: `__tests__/piroh/protocol.test.ts`
- Modify: `.pi/extensions/piroh/lib/protocol.ts`

**Step 1: Write failing tests for frame encoding**

Replace `protocol.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { encodeFrame, decodeFrame, DecodeResult } from "../../.pi/extensions/piroh/lib/protocol";

describe("protocol", () => {
  it("encodes a frame with 4-byte big-endian length prefix", () => {
    const payload = Buffer.from("hello");
    const frame = encodeFrame(payload);

    // 4 bytes length + 5 bytes payload = 9 bytes total
    expect(frame.length).toBe(9);

    // First 4 bytes = big-endian length of payload
    const view = new DataView(frame.buffer, frame.byteOffset, 4);
    expect(view.getUint32(0, false)).toBe(5);

    // Remaining bytes = payload
    expect(frame.subarray(4).toString()).toBe("hello");
  });

  it("encodes empty payload", () => {
    const frame = encodeFrame(Buffer.alloc(0));
    expect(frame.length).toBe(4);
    const view = new DataView(frame.buffer, frame.byteOffset, 4);
    expect(view.getUint32(0, false)).toBe(0);
  });

  it("decodes a complete frame from a buffer", () => {
    const payload = Buffer.from("world");
    const frame = encodeFrame(payload);
    const result = decodeFrame(frame);

    expect(result).not.toBeNull();
    expect((result as DecodeResult).payload.toString()).toBe("world");
    expect((result as DecodeResult).consumed).toBe(frame.length);
  });

  it("returns null when buffer has incomplete frame", () => {
    const partial = Buffer.alloc(2); // Can't even read 4-byte header
    expect(decodeFrame(partial)).toBeNull();

    // Header says 10 bytes but buffer only has 5
    const header = Buffer.alloc(4);
    new DataView(header.buffer, header.byteOffset, 4).setUint32(0, 10, false);
    const incomplete = Buffer.concat([header, Buffer.alloc(5)]);
    expect(decodeFrame(incomplete)).toBeNull();
  });

  it("encodes and decodes round-trip with CBOR", () => {
    const obj = { op: "hello", version: 0, encoding: "cbor", lastSeq: 0 };
    const encoded = encodeMessage(obj, "cbor");
    const decoded = decodeMessage(encoded, "cbor");
    expect(decoded).toEqual(obj);
  });
});
```

Run: `npx vitest --run __tests__/piroh/protocol.test.ts`
Expected: 5 FAIL (functions not exported)

**Step 2: Write minimal implementation**

```typescript
// .pi/extensions/piroh/lib/protocol.ts

const CBOR_AVAILABLE = (() => {
  try {
    require("cbor-x");
    return true;
  } catch {
    return false;
  }
})();

export interface DecodeResult {
  payload: Buffer;
  consumed: number;
}

/**
 * Encode a raw payload into a length-prefixed frame.
 * Frame format: [4-byte BE length][payload bytes]
 */
export function encodeFrame(payload: Buffer): Buffer {
  const header = Buffer.alloc(4);
  header.writeUint32BE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

/**
 * Try to decode one complete frame from a buffer.
 * Returns null if buffer does not contain a complete frame.
 * Returns the payload plus how many bytes were consumed.
 */
export function decodeFrame(buffer: Buffer): DecodeResult | null {
  if (buffer.length < 4) return null;

  const length = buffer.readUint32BE(0);
  if (buffer.length < 4 + length) return null;

  const payload = buffer.subarray(4, 4 + length);
  return { payload, consumed: 4 + length };
}

/**
 * Encode a message object to a Buffer using the given encoding.
 */
export function encodeMessage(obj: unknown, encoding: "cbor" | "json"): Buffer {
  if (encoding === "cbor" && CBOR_AVAILABLE) {
    const { encode } = require("cbor-x");
    return Buffer.from(encode(obj));
  }
  return Buffer.from(JSON.stringify(obj), "utf-8");
}

/**
 * Decode a Buffer back to a message object using the given encoding.
 */
export function decodeMessage(buf: Buffer, encoding: "cbor" | "json"): unknown {
  if (encoding === "cbor" && CBOR_AVAILABLE) {
    const { decode } = require("cbor-x");
    return decode(buf);
  }
  return JSON.parse(buf.toString("utf-8"));
}
```

**Step 3: Run tests**

Run: `npx vitest --run __tests__/piroh/protocol.test.ts`
Expected: 5 PASS

**Step 4: Add tests for encoding negotiation and JSON fallback**

Append to `protocol.test.ts`:

```typescript
  it("negotiates encoding: host supports CBOR", () => {
    // Client proposes CBOR, host says yes
    const hello = { op: "hello" as const, version: 0, encoding: "cbor" as const, lastSeq: 0 };
    const ack = negotiateEncoding(hello, true);
    expect(ack.encoding).toBe("cbor");
  });

  it("negotiates encoding: host falls back to JSON", () => {
    const hello = { op: "hello" as const, version: 0, encoding: "cbor" as const, lastSeq: 0 };
    const ack = negotiateEncoding(hello, false);
    expect(ack.encoding).toBe("json");
  });

  it("negotiates encoding: client sends JSON, host accepts JSON", () => {
    const hello = { op: "hello" as const, version: 0, encoding: "json" as const, lastSeq: 0 };
    const ack = negotiateEncoding(hello, false);
    expect(ack.encoding).toBe("json");
  });
```

Add `negotiateEncoding` to imports.

**Step 5: Implement encoding negotiation**

Add to `protocol.ts`:

```typescript
export interface HelloMessage {
  op: "hello";
  version: number;
  encoding: "cbor" | "json";
  lastSeq: number;
}

export interface HelloAckMessage {
  op: "hello-ack";
  encoding: "cbor" | "json";
}

/**
 * Negotiate encoding based on client proposal and host capability.
 */
export function negotiateEncoding(
  hello: HelloMessage,
  hostSupportsCbor: boolean
): HelloAckMessage {
  const encoding = hello.encoding === "cbor" && hostSupportsCbor ? "cbor" : "json";
  return { op: "hello-ack", encoding };
}
```

**Step 6: Run tests**

Run: `npx vitest --run __tests__/piroh/protocol.test.ts`
Expected: 8 PASS

**Step 7: Commit**

```bash
git add .pi/extensions/piroh/lib/protocol.ts __tests__/piroh/protocol.test.ts
git commit -m "feat: frame protocol with CBOR/JSON codec and encoding negotiation"
```

---

### Task 2: Session sync

**TDD scenario:** New feature — full TDD cycle. Write tests first, then implement.

**Files:**
- Modify: `__tests__/piroh/session.test.ts`
- Modify: `.pi/extensions/piroh/lib/session.ts`

**Step 1: Write failing tests for session snapshot**

Replace `session.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { buildSnapshot, WireEntry } from "../../.pi/extensions/piroh/lib/session";

// Minimal mock entries matching Pi's session entry shape
function makeEntry(id: string, data: Record<string, unknown>): WireEntry {
  return {
    id,
    type: "message",
    role: "assistant",
    content: data.content as string,
    timestamp: Date.now(),
  };
}

describe("session", () => {
  it("builds full snapshot when lastSeq is 0", () => {
    const entries = [
      makeEntry("1", { content: "Hello" }),
      makeEntry("2", { content: "World" }),
    ];
    const snapshot = buildSnapshot(entries, 0);
    expect(snapshot.entries).toHaveLength(2);
    expect(snapshot.seq).toBe(2);
    expect(snapshot.entries[0].id).toBe("1");
    expect(snapshot.entries[1].id).toBe("2");
  });

  it("builds delta snapshot skipping entries up to lastSeq", () => {
    const entries = [
      makeEntry("1", { content: "A" }),
      makeEntry("2", { content: "B" }),
      makeEntry("3", { content: "C" }),
    ];
    const snapshot = buildSnapshot(entries, 1);
    expect(snapshot.entries).toHaveLength(2);
    expect(snapshot.seq).toBe(3);
    expect(snapshot.entries[0].id).toBe("2");
    expect(snapshot.entries[1].id).toBe("3");
  });

  it("returns empty snapshot when lastSeq matches entry count", () => {
    const entries = [
      makeEntry("1", { content: "A" }),
      makeEntry("2", { content: "B" }),
    ];
    const snapshot = buildSnapshot(entries, 2);
    expect(snapshot.entries).toHaveLength(0);
    expect(snapshot.seq).toBe(2);
  });

  it("returns empty snapshot for empty entry list", () => {
    const snapshot = buildSnapshot([], 0);
    expect(snapshot.entries).toHaveLength(0);
    expect(snapshot.seq).toBe(0);
  });

  it("clamps lastSeq: negative becomes 0", () => {
    const entries = [makeEntry("1", { content: "A" })];
    const snapshot = buildSnapshot(entries, -5);
    expect(snapshot.entries).toHaveLength(1);
    expect(snapshot.seq).toBe(1);
  });

  it("clamps lastSeq: beyond length returns empty", () => {
    const entries = [makeEntry("1", { content: "A" })];
    const snapshot = buildSnapshot(entries, 999);
    expect(snapshot.entries).toHaveLength(0);
    expect(snapshot.seq).toBe(1);
  });
});
```

Run: `npx vitest --run __tests__/piroh/session.test.ts`
Expected: 6 FAIL (functions not exported)

**Step 2: Write minimal implementation**

```typescript
// .pi/extensions/piroh/lib/session.ts

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
```

Run: `npx vitest --run __tests__/piroh/session.test.ts`
Expected: 6 PASS

**Step 3: Commit**

```bash
git add .pi/extensions/piroh/lib/session.ts __tests__/piroh/session.test.ts
git commit -m "feat: session snapshot builder with delta support"
```

---

### Task 3: Iroh endpoint management

**TDD scenario:** New feature, but depends on native addon (`@number0/iroh`). Test the pure-logic parts (retry backoff, state machine), mock the iroh bindings for integration-style tests. Use a relaxed TDD approach — test what can be tested in isolation, verify the rest manually.

**Files:**
- Create: `__tests__/piroh/connection.test.ts`
- Modify: `.pi/extensions/piroh/lib/connection.ts`

**Step 1: Check that @number0/iroh is importable**

Run: `node -e "const iroh = require('@number0/iroh'); console.log(Object.keys(iroh).slice(0,10))"`
Expected: Lists exported symbols (Endpoint, SecretKey, etc.) — no error.

If the native addon fails to load, run `cd .pi/extensions/piroh && npm rebuild @number0/iroh` first.

**Step 2: Write tests for the reconnect backoff logic**

```typescript
// __tests__/piroh/connection.test.ts
import { describe, it, expect } from "vitest";
import { backoffDelay, ConnectionState } from "../../.pi/extensions/piroh/lib/connection";

describe("connection", () => {
  describe("backoffDelay", () => {
    it("returns 1s for attempt 1", () => {
      expect(backoffDelay(1)).toBe(1000);
    });

    it("doubles each attempt", () => {
      expect(backoffDelay(1)).toBe(1000);
      expect(backoffDelay(2)).toBe(2000);
      expect(backoffDelay(3)).toBe(4000);
      expect(backoffDelay(4)).toBe(8000);
    });

    it("caps at 16 seconds", () => {
      expect(backoffDelay(6)).toBe(16000);
      expect(backoffDelay(10)).toBe(16000);
    });

    it("starts from 1s even for attempt 0", () => {
      expect(backoffDelay(0)).toBe(1000);
    });
  });

  describe("ConnectionState", () => {
    it("transitions: idle -> connecting -> connected", () => {
      const state = new ConnectionState();
      expect(state.current).toBe("idle");

      state.transition("connecting");
      expect(state.current).toBe("connecting");

      state.transition("connected");
      expect(state.current).toBe("connected");
    });

    it("transitions: connected -> reconnecting -> connected", () => {
      const state = new ConnectionState();
      state.transition("connecting");
      state.transition("connected");
      state.transition("reconnecting");
      expect(state.current).toBe("reconnecting");

      state.transition("connected");
      expect(state.current).toBe("connected");
    });

    it("transitions to disconnected from any state", () => {
      const state = new ConnectionState();
      state.transition("disconnected");
      expect(state.current).toBe("disconnected");

      const state2 = new ConnectionState();
      state2.transition("connecting");
      state2.transition("disconnected");
      expect(state2.current).toBe("disconnected");
    });

    it("resets retry count on successful connect", () => {
      const state = new ConnectionState();
      state.incrementRetry(); // 1
      state.incrementRetry(); // 2
      state.resetRetries();
      expect(state.retryCount).toBe(0);
    });
  });
});
```

Run: `npx vitest --run __tests__/piroh/connection.test.ts`
Expected: FAIL (backoffDelay, ConnectionState not exported)

**Step 3: Implement backoff and state machine**

```typescript
// .pi/extensions/piroh/lib/connection.ts

/**
 * Calculate exponential backoff delay in milliseconds.
 * Doubles each attempt with a cap at 16 seconds.
 */
export function backoffDelay(attempt: number, baseMs = 1000, maxMs = 16000): number {
  const delay = baseMs * Math.pow(2, attempt - 1);
  return Math.min(delay, maxMs);
}

export type ConnState = "idle" | "connecting" | "connected" | "reconnecting" | "disconnected";

/**
 * Simple state machine tracking the connection lifecycle.
 */
export class ConnectionState {
  current: ConnState = "idle";
  retryCount = 0;

  transition(to: ConnState): void {
    this.current = to;
  }

  incrementRetry(): void {
    this.retryCount++;
  }

  resetRetries(): void {
    this.retryCount = 0;
  }

  get backoffMs(): number {
    return backoffDelay(this.retryCount);
  }
}
```

Run: `npx vitest --run __tests__/piroh/connection.test.ts`
Expected: 7 PASS

**Step 4: Add the IrohConnection wrapper**

Append to `connection.ts`:

```typescript
import { Endpoint, SecretKey, Connection } from "@number0/iroh";

export const PIROH_ALPN = Buffer.from("piroh/session/0");

/**
 * Create or load a secret key. Generates a new one if none exists.
 * Keys should be persisted via pi.appendEntry() so the EndpointId is stable.
 */
export function loadOrGenerateKey(existing?: Buffer): SecretKey {
  if (existing && existing.length > 0) {
    return new SecretKey(existing);
  }
  return SecretKey.generate();
}

/**
 * Create a bound iroh endpoint with the piroh ALPN and preset.
 */
export async function createEndpoint(key: SecretKey): Promise<Endpoint> {
  const builder = Endpoint.builder();
  builder.presetN0(builder);
  builder.secretKey(key.toBytes());
  builder.alpns([PIROH_ALPN]);
  return builder.bind();
}

/**
 * Wait for an incoming piroh connection on the endpoint.
 */
export async function acceptPiroh(endpoint: Endpoint): Promise<Connection> {
  while (true) {
    const incoming = await endpoint.acceptNext();
    if (!incoming) continue;

    const accepting = await incoming.accept();
    const alpn = await accepting.alpn();

    if (Buffer.from(alpn).equals(PIROH_ALPN)) {
      return accepting.connect();
    }
    // Wrong ALPN — ignore
  }
}

/**
 * Connect to a remote piroh endpoint by its EndpointId string.
 */
export async function connectPiroh(
  endpoint: Endpoint,
  remoteId: string
): Promise<Connection> {
  const addr = await endpoint.remoteAddr(remoteId);
  // If no cached addr, connect by ID directly (will discover via relay)
  return endpoint.connect(addr ?? remoteId, PIROH_ALPN);
}
```

**Step 5: Run all connection tests**

Run: `npx vitest --run __tests__/piroh/connection.test.ts`
Expected: 7 PASS (iroh functions are not unit-testable here, they need a running iroh endpoint)

**Step 6: Commit**

```bash
git add .pi/extensions/piroh/lib/connection.ts __tests__/piroh/connection.test.ts
git commit -m "feat: iroh endpoint management with backoff and state machine"
```

---

### Task 4: Wire up host mode

**TDD scenario:** Modifying existing file (index.ts). This is wiring — integration-heavy. Test the pure functions in isolation, verify the wiring manually with `pi --extension`.

**Files:**
- Modify: `.pi/extensions/piroh/index.ts`
- No separate test file — tested via Task 6 integration test

**Step 1: Verify existing tests still pass**

Run: `npx vitest --run`
Expected: All previously passing tests still pass (protocol: 8, session: 6, connection: 7)

**Step 2: Implement the host wiring in index.ts**

Replace `index.ts`:

```typescript
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  Endpoint,
  SecretKey,
  Connection,
  BiStream,
} from "@number0/iroh";
import { encodeFrame, encodeMessage, decodeFrame, negotiateEncoding } from "./lib/protocol";
import { buildSnapshot, WireEntry, SnapshotMessage } from "./lib/session";
import { PIROH_ALPN, ConnectionState, createEndpoint, acceptPiroh } from "./lib/connection";

interface PirohState {
  key: SecretKey | null;
  endpoint: Endpoint | null;
  connection: Connection | null;
  stream: BiStream | null;
  encoding: "cbor" | "json";
  seq: number;
  mode: "idle" | "host" | "client";
  remoteId: string | null;
  connState: ConnectionState;
  // For client: suppress local agent
  suppressInput: boolean;
  // For host: pending snapshot to send on new connection
  pendingConnection: Connection | null;
}

const CBOR_AVAILABLE = (() => {
  try { require("cbor-x"); return true; } catch { return false; }
})();

function createState(): PirohState {
  return {
    key: null,
    endpoint: null,
    connection: null,
    stream: null,
    encoding: "json",
    seq: 0,
    mode: "idle",
    remoteId: null,
    connState: new ConnectionState(),
    suppressInput: false,
    pendingConnection: null,
  };
}

export default function (pi: ExtensionAPI) {
  const state = createState();

  // ── Restore persisted key on session start ──
  pi.on("session_start", async (_event, ctx) => {
    // Check for persisted key in session entries
    for (const entry of ctx.sessionManager.getEntries()) {
      if (entry.type === "custom" && entry.customType === "piroh-key") {
        state.key = new SecretKey(Buffer.from(entry.data as string, "hex"));
        break;
      }
    }
  });

  // ── Helper: update status widget ──
  function updateStatus(ctx: ExtensionContext) {
    const c = state.connState.current;
    if (state.mode === "host") {
      if (c === "connected") {
        ctx.ui.setStatus("piroh", `host: client connected`);
      } else {
        const id = state.endpoint ? String(state.endpoint.id()) : "unknown";
        ctx.ui.setStatus("piroh", `host: listening on ${id.slice(0, 12)}...`);
      }
    } else if (state.mode === "client") {
      if (c === "connected") {
        ctx.ui.setStatus("piroh", `client: connected`);
      } else if (c === "reconnecting") {
        ctx.ui.setStatus("piroh", `client: reconnecting (${state.connState.retryCount}/5)`);
      } else if (c === "disconnected") {
        ctx.ui.setStatus("piroh", `client: disconnected`);
      } else {
        ctx.ui.setStatus("piroh", `client: connecting...`);
      }
    }
  }

  // ── Helper: build and send snapshot ──
  async function sendSnapshot(
    stream: BiStream,
    ctx: ExtensionContext,
    lastSeq: number
  ): Promise<SnapshotMessage> {
    const entries: WireEntry[] = ctx.sessionManager.getEntries().map((e) => ({
      id: e.id,
      type: e.type,
      ...e,
      timestamp: e.timestamp ?? Date.now(),
    }));
    const snapshot = buildSnapshot(entries, lastSeq);
    const frame = encodeFrame(encodeMessage(snapshot, state.encoding));
    await stream.send().writeAll(frame);
    return snapshot;
  }

  // ── Helper: relay output to remote client ──
  async function relayFrame(ctx: ExtensionContext, op: string, data: Record<string, unknown>) {
    if (!state.stream || state.mode !== "host") return;
    const seq = ++state.seq;
    const frame = encodeFrame(encodeMessage({ op, seq, ...data }, state.encoding));
    try {
      await state.stream.send().writeAll(frame);
    } catch {
      // Stream error — connection dropped, will be handled by closed() watcher
    }
  }

  // ── Host: accept loop ──
  async function startHostLoop(ctx: ExtensionContext) {
    if (!state.endpoint) return;

    while (state.mode === "host") {
      try {
        const conn = await acceptPiroh(state.endpoint);
        state.connection = conn;
        state.connState.transition("connected");

        // Accept a bidirectional stream
        const stream = await conn.acceptBi();
        state.stream = stream;
        updateStatus(ctx);

        // Read hello handshake
        const recvBuf = await stream.recv().read(65536);
        const frameResult = decodeFrame(recvBuf);
        if (!frameResult) continue;

        const hello = decodeMessage(frameResult.payload, "json") as {
          op: string; encoding: "cbor" | "json"; lastSeq: number;
        };
        if (hello.op !== "hello") continue;

        // Negotiate encoding
        const ack = negotiateEncoding(
          { op: "hello", version: 0, encoding: hello.encoding, lastSeq: hello.lastSeq },
          CBOR_AVAILABLE
        );
        state.encoding = ack.encoding;
        const ackFrame = encodeFrame(encodeMessage(ack, "json"));
        await stream.send().writeAll(ackFrame);

        // Send snapshot
        const snapshot = await sendSnapshot(stream, ctx, hello.lastSeq);
        state.seq = snapshot.seq;

        updateStatus(ctx);

        // Start reading from client (input relay)
        readFromClient(ctx, stream).catch(() => {});

        // Watch for connection close
        watchConnection(ctx, conn);
      } catch {
        state.connState.transition("disconnected");
        updateStatus(ctx);
      }
    }
  }

  // ── Read input from client ──
  async function readFromClient(ctx: ExtensionContext, stream: BiStream) {
    let buffer = Buffer.alloc(0);

    while (state.mode === "host" && state.stream === stream) {
      try {
        const chunk = await stream.recv().read(65536);
        if (!chunk) continue;

        buffer = Buffer.concat([buffer, chunk]);

        let decodeResult = decodeFrame(buffer);
        while (decodeResult !== null) {
          const msg = decodeMessage(decodeResult.payload, state.encoding) as {
            op: string; text: string; images?: unknown[];
          };

          if (msg.op === "input") {
            // Inject user message from client
            await pi.sendUserMessage(msg.text);
          } else if (msg.op === "disconnect") {
            // Client disconnected gracefully
            state.connState.transition("idle");
            state.stream = null;
            updateStatus(ctx);
            return;
          }

          buffer = buffer.subarray(decodeResult.consumed);
          decodeResult = decodeFrame(buffer);
        }
      } catch {
        // Stream error — connection lost
        break;
      }
    }
  }

  // ── Watch connection for drop ──
  async function watchConnection(ctx: ExtensionContext, conn: Connection) {
    const reason = await conn.closed();
    if (state.connection === conn) {
      state.connection = null;
      state.stream = null;
      state.connState.transition("idle");
      updateStatus(ctx);
    }
  }

  // ── Output relay hooks (host side) ──
  pi.on("message_start", async (event, ctx) => {
    await relayFrame(ctx, "message-start", { message: event.message });
  });

  pi.on("message_update", async (event, ctx) => {
    await relayFrame(ctx, "message-update", { message: event.message });
  });

  pi.on("message_end", async (event, ctx) => {
    await relayFrame(ctx, "message-end", { message: event.message });
  });

  pi.on("tool_execution_start", async (event, ctx) => {
    await relayFrame(ctx, "tool-start", {
      toolCallId: event.toolCallId,
      toolName: event.toolName,
      args: event.args,
    });
  });

  pi.on("tool_execution_update", async (event, ctx) => {
    await relayFrame(ctx, "tool-update", {
      toolCallId: event.toolCallId,
      partialResult: event.partialResult,
    });
  });

  pi.on("tool_execution_end", async (event, ctx) => {
    await relayFrame(ctx, "tool-end", {
      toolCallId: event.toolCallId,
      result: event.result,
      isError: event.isError,
    });
  });

  // ── Input hook: suppress on client, intercept /iroh commands ──
  pi.on("input", async (event, ctx) => {
    if (state.suppressInput && state.mode === "client") {
      // Forward input to host
      if (state.stream) {
        const frame = encodeFrame(encodeMessage(
          { op: "input", text: event.text, seq: ++state.seq },
          state.encoding
        ));
        try {
          await state.stream.send().writeAll(frame);
        } catch {
          // Connection lost
        }
      }
      return { action: "handled" };
    }
    return { action: "continue" };
  });

  // ── Register /iroh-host command ──
  pi.registerCommand("iroh-host", {
    description: "Start hosting this Pi session over Iroh",
    handler: async (_args, ctx) => {
      if (state.mode === "host") {
        ctx.ui.notify("Already hosting", "info");
        return;
      }

      // Persist key if new
      if (!state.key) {
        state.key = SecretKey.generate();
        pi.appendEntry("piroh-key", state.key.toString());
      }

      state.endpoint = await createEndpoint(state.key);
      state.mode = "host";
      state.connState.transition("idle");
      const id = String(state.endpoint.id());
      updateStatus(ctx);

      ctx.ui.notify(`Hosting on ${id}\nShare this ID with the client.`, "info");

      // Start accept loop in background
      startHostLoop(ctx).catch((err) => {
        ctx.ui.notify(`Host error: ${err}`, "error");
      });
    },
  });

  // ── Register /iroh-connect command ──
  pi.registerCommand("iroh-connect", {
    description: "Connect to a remote Pi session over Iroh",
    handler: async (args: string, ctx) => {
      const remoteId = args.trim();
      if (!remoteId) {
        ctx.ui.notify("Usage: /iroh-connect <EndpointId>", "error");
        return;
      }

      if (state.mode === "client") {
        ctx.ui.notify("Already connected. Use /iroh-disconnect first.", "info");
        return;
      }

      // Create endpoint if needed
      if (!state.key) {
        state.key = SecretKey.generate();
      }
      if (!state.endpoint) {
        state.endpoint = await createEndpoint(state.key);
      }

      state.mode = "client";
      state.remoteId = remoteId;
      state.connState.transition("connecting");
      updateStatus(ctx);

      try {
        const conn = await state.endpoint.connect(remoteId, PIROH_ALPN);
        state.connection = conn;
        state.connState.transition("connected");

        // Open bidirectional stream
        const stream = await conn.openBi();
        state.stream = stream;

        // Send hello
        const hello = { op: "hello", version: 0, encoding: CBOR_AVAILABLE ? "cbor" : "json", lastSeq: 0 };
        const helloFrame = encodeFrame(encodeMessage(hello, "json"));
        await stream.send().writeAll(helloFrame);

        // Read hello-ack
        const recvBuf = await stream.recv().read(65536);
        const frameResult = decodeFrame(recvBuf);
        if (frameResult) {
          const ack = decodeMessage(frameResult.payload, "json") as { op: string; encoding: "cbor" | "json" };
          if (ack.op === "hello-ack") {
            state.encoding = ack.encoding;
          }
        }

        // Read snapshot and replay
        let buffer = Buffer.alloc(0);
        const snapshotBuf = await stream.recv().read(131072);
        buffer = Buffer.concat([buffer, snapshotBuf]);
        const snapResult = decodeFrame(buffer);
        if (snapResult) {
          const snapshot = decodeMessage(snapResult.payload, state.encoding) as SnapshotMessage;

          // Replay entries
          for (const entry of snapshot.entries) {
            pi.sendMessage({
              customType: `piroh-${entry.type}`,
              content: entry.content,
              display: true,
              details: entry.details ?? {},
            } as Parameters<typeof pi.sendMessage>[0]);
          }
          state.seq = snapshot.seq;
        }

        // Now suppress local input and forward to host
        state.suppressInput = true;
        updateStatus(ctx);

        // Start reading output from host
        readFromHost(ctx, stream).catch(() => {});

        // Watch for connection close
        watchConnection(ctx, conn);
      } catch (err) {
        state.connState.transition("disconnected");
        state.mode = "idle";
        updateStatus(ctx);
        ctx.ui.notify(`Failed to connect: ${err}`, "error");
      }
    },
  });

  // ── Read output from host (client side) ──
  async function readFromHost(ctx: ExtensionContext, stream: BiStream) {
    let buffer = Buffer.alloc(0);

    while (state.mode === "client" && state.stream === stream) {
      try {
        const chunk = await stream.recv().read(65536);
        if (!chunk) continue;

        buffer = Buffer.concat([buffer, chunk]);

        let decodeResult = decodeFrame(buffer);
        while (decodeResult !== null) {
          const msg = decodeMessage(decodeResult.payload, state.encoding) as {
            op: string; seq: number; message?: unknown;
            toolCallId?: string; toolName?: string; args?: unknown;
            result?: unknown; isError?: boolean; partialResult?: unknown;
          };

          state.seq = msg.seq;

          switch (msg.op) {
            case "snapshot":
              // Already handled during connect, but could arrive again on reconnect
              break;
            case "message-start":
            case "message-update":
            case "message-end":
              pi.sendMessage({
                customType: `piroh-msg`,
                content: msg.message,
                display: true,
              } as Parameters<typeof pi.sendMessage>[0]);
              break;
            case "tool-start":
            case "tool-update":
            case "tool-end":
              // Inject tool messages
              pi.sendMessage({
                customType: `piroh-tool`,
                content: msg.result ?? msg.partialResult ?? "",
                display: true,
                details: { toolCallId: msg.toolCallId, toolName: msg.toolName },
              } as Parameters<typeof pi.sendMessage>[0]);
              break;
            case "disconnect":
              state.connState.transition("disconnected");
              state.suppressInput = false;
              state.stream = null;
              updateStatus(ctx);
              ctx.ui.notify("Host disconnected", "info");
              return;
          }

          buffer = buffer.subarray(decodeResult.consumed);
          decodeResult = decodeFrame(buffer);
        }
      } catch {
        break;
      }
    }
  }

  // ── Register /iroh-disconnect command ──
  pi.registerCommand("iroh-disconnect", {
    description: "Disconnect from the remote Pi session",
    handler: async (_args, ctx) => {
      if (state.mode === "idle") {
        ctx.ui.notify("Not connected", "info");
        return;
      }

      // Send disconnect frame
      if (state.stream) {
        try {
          const frame = encodeFrame(encodeMessage(
            { op: "disconnect", seq: ++state.seq, reason: "user" },
            state.encoding
          ));
          await state.stream.send().writeAll(frame);
          state.stream.send().finish();
        } catch {
          // Already dead
        }
        state.stream = null;
      }

      if (state.connection) {
        try {
          state.connection.close(BigInt(0), Buffer.from("user disconnect"));
        } catch {
          // Already closed
        }
        state.connection = null;
      }

      state.mode = "idle";
      state.suppressInput = false;
      state.connState.transition("idle");
      updateStatus(ctx);
      ctx.ui.notify("Disconnected", "info");
    },
  });

  // ── Clean up on shutdown ──
  pi.on("session_shutdown", async () => {
    if (state.endpoint) {
      try {
        await state.endpoint.close();
      } catch {
        // Best effort
      }
      state.endpoint = null;
    }
    state.mode = "idle";
    state.suppressInput = false;
  });
}
```

**Step 3: Run tests to verify no regressions**

Run: `npx vitest --run`
Expected: All 21 tests still pass (protocol: 8, session: 6, connection: 7)

**Step 4: Commit**

```bash
git add .pi/extensions/piroh/index.ts
git commit -m "feat: host and client modes with input/output relay"
```

---

### Task 5: Integration test

**TDD scenario:** Testing the full extension end-to-end. This is the most important test — it validates that the entire pipeline works.
Since the extension requires Pi's runtime and iroh's native addon, we test with a lightweight harness that simulates two Pi sessions.

**Files:**
- Create: `__tests__/piroh/integration.test.ts`

**Step 1: Check that tests still pass**

Run: `npx vitest --run`
Expected: 21 PASS

**Step 2: Write integration test**

```typescript
// __tests__/piroh/integration.test.ts
import { describe, it, expect, beforeAll, afterAll } from "vitest";

describe("piroh integration", () => {
  it.todo("host listens and client connects");
  it.todo("client receives session snapshot on connect");
  it.todo("client forwards input to host");
  it.todo("host relays output to client");
  it.todo("client reconnects after connection drop");
  it.todo("disconnect is graceful on both sides");

  // These tests require a running Pi instance and iroh endpoint.
  // For now, mark them as todos and implement manually once the
  // extension is integrated and working.
});
```

**Step 3: Manually verify the extension loads**

Run: `echo "pi --extension .pi/extensions/piroh/index.ts --print 'hello'"` (note: won't actually run without pi installed)

Since this is a **manual verification step**, test by:
1. Open Pi with the extension: `pi --extension .pi/extensions/piroh/index.ts`
2. Run `/iroh-host` — verify "Hosting on ..." notification and status bar
3. In another terminal, open Pi: `pi --extension .pi/extensions/piroh/index.ts`
4. Run `/iroh-connect <id>` — verify connection, snapshot replay, and bidirectional I/O
5. Run `/iroh-disconnect` — verify clean teardown on both sides

**Step 4: Commit**

```bash
git add __tests__/piroh/integration.test.ts
git commit -m "test: add integration test placeholders for manual verification"
```

---

### Task 6: Final polish and verification

**TDD scenario:** Final verification — run all tests, clean up any issues.

**Step 1: Run full test suite**

Run: `npx vitest --run`
Expected: 21 PASS, 6 TODO

**Step 2: Verify file structure is complete**

Run: `find .pi/extensions/piroh -type f -not -path '*/node_modules/*' | sort`
Expected:
```
.pi/extensions/piroh/index.ts
.pi/extensions/piroh/lib/connection.ts
.pi/extensions/piroh/lib/protocol.ts
.pi/extensions/piroh/lib/session.ts
.pi/extensions/piroh/package.json
```

**Step 3: Check for common issues**

Run: `npx vitest --run 2>&1 | grep -i -E "(fail|error|warn)" || echo "No failures or errors"`
Expected: "No failures or errors" (or only expected warnings)

**Step 4: Commit**

```bash
git commit -m "chore: final verification — all tests pass"
```
