/**
 * connection.ts — Iroh adapter for @number0/iroh 0.31.0 and 1.0.0
 *
 * Detects the installed version at runtime and normalises the API surface
 * so index.ts never branches on version. The adapter covers:
 *
 *   - Node creation + shutdown
 *   - Node ID retrieval
 *   - Accepting incoming connections (host)
 *   - Connecting to remote peers (client)
 *   - Stream read/write (returns Buffer both ways)
 *   - Connection close / closed()
 *
 * Public API (version-agnostic):
 *   createEndpoint(key)          → NodeHandle
 *   NodeHandle.nodeId()          → string
 *   NodeHandle.acceptConnection() → Connection
 *   NodeHandle.connectTo(remote)  → Connection
 *   NodeHandle.destroy()          → void
 *
 *   readBuffer(recv, size)       → Buffer
 *   writeBuffer(send, data)      → void
 *   finishStream(send)           → void
 *   closeConnection(conn, code, reason) → void
 *   connectionClosed(conn)       → string
 */

import { createRequire } from "node:module";

const _require = createRequire(import.meta.url);

// ---------------------------------------------------------------------------
// Version detection
// ---------------------------------------------------------------------------

type IrohVersion = "0.31" | "1.0";

function detectVersion(): IrohVersion {
  const iroh = _require("@number0/iroh");

  // 0.31.x has Iroh.memory — 1.0.x dropped the Iroh class entirely.
  // Check this first: Endpoint.bind collides with Function.prototype.bind.
  if (iroh.Iroh && typeof iroh.Iroh.memory === "function") return "0.31";

  // 1.0.x has Endpoint.prototype.id (instance method, no Function.prototype collision).
  if (iroh.Endpoint?.prototype && typeof iroh.Endpoint.prototype.id === "function") return "1.0";

  throw new Error(
    "Unknown @number0/iroh version — expected 0.31.x (Iroh.memory) or 1.0.x (Endpoint.prototype.id)"
  );
}

const VERSION = detectVersion();

// ---------------------------------------------------------------------------
// ALPN
// ---------------------------------------------------------------------------

/** ALPN protocol identifier for piroh sessions: "piroh/session/0" */
export const PIROH_ALPN = Buffer.from("piroh/session/0");

function alpnBytes(): number[] {
  return Array.from(PIROH_ALPN);
}

function buffersEqual(a: number[] | Uint8Array, b: number[] | Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// Backoff + state machine (version-agnostic)
// ---------------------------------------------------------------------------

export function backoffDelay(attempt: number, baseMs = 1000, maxMs = 16000): number {
  const clamped = Math.max(1, attempt);
  const delay = baseMs * Math.pow(2, clamped - 1);
  return Math.min(delay, maxMs);
}

export type ConnState = "idle" | "connecting" | "connected" | "reconnecting" | "disconnected";

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

// ---------------------------------------------------------------------------
// Type shims (subset of @number0/iroh types we depend on)
// ---------------------------------------------------------------------------

// ---- 0.31 types ----

interface Iroh031 {
  node: {
    endpoint(): { nodeId(): string; connect(nodeAddr: { nodeId: string; relayUrl?: string; addresses?: string[] }, alpn: Uint8Array): Promise<unknown> };
    shutdown(): Promise<void>;
  };
  net: {
    nodeAddr(): Promise<{ nodeId: string; relayUrl?: string; addresses?: string[] }>;
  };
}

type Endpoint031 = ReturnType<Iroh031["node"]["endpoint"]>;

interface Connecting031 {
  connect(): Promise<unknown>; // → Connection
  alpn?(): Promise<Buffer>;
}

// ---- 1.0 types ----

interface Endpoint100 {
  id(): { toString(): string };
  addr(): unknown;
  bind?(options: Record<string, unknown>): Promise<Endpoint100>;
  connect(addr: { constructor: new (...args: unknown[]) => unknown }, alpn: number[]): Promise<unknown>;
  acceptNext(): Promise<Incoming100 | null>;
  close(): Promise<void>;
}

interface Incoming100 {
  accept(): Promise<Accepting100>;
  refuse(): Promise<void>;
  ignore(): Promise<void>;
}

interface Accepting100 {
  connect(): Promise<unknown>;
  alpn(): Promise<number[]>;
}

// ---- Common ----

type RawConnection = unknown;
type RawSendStream = unknown;
type RawRecvStream = unknown;

// ---------------------------------------------------------------------------
// Exported NodeHandle
// ---------------------------------------------------------------------------

export interface NodeHandle {
  nodeId(): string;
  /** Returns a base64-encoded JSON blob containing the full address info
   *  needed by a remote peer to connect (nodeId + relayUrl + addresses). */
  getAddress(): Promise<string>;
  acceptConnection(): Promise<RawConnection>;
  connectTo(address: string): Promise<RawConnection>;
  destroy(): Promise<void>;
}

// ---------------------------------------------------------------------------
// 0.31 implementation
// ---------------------------------------------------------------------------

function create031Handle(endpoint031: Endpoint031, iroh031: Iroh031): NodeHandle {
  return {
    nodeId() {
      return endpoint031.nodeId();
    },

    async getAddress(): Promise<string> {
      const addr = await iroh031.net.nodeAddr();
      return Buffer.from(JSON.stringify(addr)).toString("base64");
    },

    async acceptConnection(): Promise<RawConnection> {
      // acceptQueue is populated by the protocol handler
      return new Promise((resolve) => {
        acceptQueue031.push(resolve);
      });
    },

    async connectTo(address: string): Promise<RawConnection> {
      // The address may be either:
      //   1. A base64-encoded JSON blob (full NodeAddr from getAddress())
      //   2. A bare 64-char hex node ID (legacy / manual entry)
      let nodeAddr: { nodeId: string; relayUrl?: string; addresses?: string[] };

      try {
        const decoded = JSON.parse(Buffer.from(address, "base64").toString("utf-8"));
        if (decoded && typeof decoded.nodeId === "string") {
          nodeAddr = decoded;
        } else {
          throw new Error("not a valid address blob");
        }
      } catch {
        // Not base64 JSON — treat as bare node ID
        if (!/^[0-9a-f]{64}$/i.test(address)) {
          throw new Error(
            `Invalid address: "${address}". Expected a 64-character hex node ID or a base64-encoded address blob.`
          );
        }
        nodeAddr = { nodeId: address };
      }

      return endpoint031.connect(nodeAddr, PIROH_ALPN);
    },

    async destroy(): Promise<void> {
      await iroh031.node.shutdown();
    },
  };
}

/** Queue fed by the 0.31 protocol handler, drained by acceptConnection() */
const acceptQueue031: Array<(conn: RawConnection) => void> = [];

/**
 * Build the 0.31 protocols map entry for our ALPN.
 * The accept handler receives a Connecting (must call .connect() first).
 */
function build031ProtocolHandler(): unknown {
  const key = PIROH_ALPN.toString();
  const handler = (_err: Error | null, _ep: Endpoint031) => ({
    accept: async (err: Error | null, connecting: Connecting031) => {
      if (err) return;
      try {
        const conn = await connecting.connect();
        const resolve = acceptQueue031.shift();
        if (resolve) resolve(conn);
      } catch {
        // Connection failed silently — acceptConnection will retry
      }
    },
    shutdown: (_err: Error | null) => {
      // no-op
    },
  });

  return { [key]: handler };
}

// ---------------------------------------------------------------------------
// 1.0 implementation
// ---------------------------------------------------------------------------

function create100Handle(endpoint100: Endpoint100): NodeHandle {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { EndpointId, EndpointAddr } = _require("@number0/iroh") as any;

  return {
    nodeId() {
      return endpoint100.id().toString();
    },

    async getAddress(): Promise<string> {
      const addr = endpoint100.addr();
      return Buffer.from(JSON.stringify(addr)).toString("base64");
    },

    async acceptConnection(): Promise<RawConnection> {
      // Loop until we get a connection with matching ALPN
      while (true) {
        const incoming = await endpoint100.acceptNext();
        if (!incoming) continue;

        try {
          const accepting = await incoming.accept();
          const gotAlpn = await accepting.alpn();

          if (!buffersEqual(gotAlpn, alpnBytes())) {
            // Wrong protocol — refuse and keep listening
            await incoming.refuse();
            continue;
          }

          return accepting.connect();
        } catch {
          // Accept failed — try next
          continue;
        }
      }
    },

    async connectTo(address: string): Promise<RawConnection> {
      // The address may be either:
      //   1. A base64-encoded JSON blob (full address from getAddress())
      //   2. A bare 64-char hex node ID (legacy / manual entry)
      let nodeId: string;

      try {
        const decoded = JSON.parse(Buffer.from(address, "base64").toString("utf-8"));
        if (decoded && typeof decoded.nodeId === "string") {
          nodeId = decoded.nodeId;
        } else {
          throw new Error("not a valid address blob");
        }
      } catch {
        // Not base64 JSON — treat as bare node ID
        nodeId = address;
      }

      if (!/^[0-9a-f]{64}$/i.test(nodeId)) {
        throw new Error(
          `Invalid node ID: "${nodeId}". Expected a 64-character hex string.`
        );
      }
      const addr = new EndpointAddr(EndpointId.fromString(nodeId));
      return endpoint100.connect(addr, alpnBytes());
    },

    async destroy(): Promise<void> {
      await endpoint100.close();
    },
  };
}

// ---------------------------------------------------------------------------
// Public factory: createEndpoint
// ---------------------------------------------------------------------------

export function loadOrGenerateKey(existing?: Uint8Array): Uint8Array {
  if (existing && existing.byteLength === 32) {
    return existing;
  }
  const key = new Uint8Array(32);
  crypto.getRandomValues(key);
  return key;
}

export async function createEndpoint(key: Uint8Array): Promise<NodeHandle> {
  if (VERSION === "1.0") {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const { Endpoint } = _require("@number0/iroh") as any;
    const ep = (await Endpoint.bind({
      secretKey: Array.from(key),
      alpns: [alpnBytes()],
    })) as Endpoint100;
    return create100Handle(ep);
  }

  // 0.31
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const { Iroh } = _require("@number0/iroh") as any;
  const protocols = build031ProtocolHandler();
  const iroh = (await Iroh.memory({
    secretKey: Array.from(key),
    protocols,
  })) as Iroh031;
  const endpoint = iroh.node.endpoint();
  return create031Handle(endpoint, iroh);
}

// ---------------------------------------------------------------------------
// Stream helpers (return/accept Buffer uniformly)
// ---------------------------------------------------------------------------

export async function readBuffer(recv: RawRecvStream, sizeLimit: number): Promise<Buffer> {
  const s = recv as { readToEnd(n: number): Promise<Buffer | number[]> };
  const result = await s.readToEnd(sizeLimit);
  return Buffer.isBuffer(result) ? result : Buffer.from(result);
}

export async function writeBuffer(send: RawSendStream, data: Buffer): Promise<void> {
  // 0.31 takes Buffer/Uint8Array, 1.0 takes Array<number> — Array.from works for both
  const s = send as { writeAll(buf: Uint8Array | number[]): Promise<void> };
  await s.writeAll(VERSION === "1.0" ? Array.from(data) : data);
}

export async function finishStream(send: RawSendStream): Promise<void> {
  const s = send as { finish(): Promise<void> };
  await s.finish();
}

// ---------------------------------------------------------------------------
// Connection helpers
// ---------------------------------------------------------------------------

export function closeConnection(conn: RawConnection, code: bigint, reason: Buffer): void {
  // close() is sync void in both versions; 1.0 takes Array<number> for reason
  const c = conn as { close(code: bigint, reason: Uint8Array | number[]): void };
  c.close(code, VERSION === "1.0" ? Array.from(reason) : reason);
}

export function connectionClosed(conn: RawConnection): Promise<string> {
  const c = conn as { closed(): Promise<string> };
  return c.closed();
}

export async function openBiStream(conn: RawConnection): Promise<{ send: RawSendStream; recv: RawRecvStream }> {
  const c = conn as { openBi(): Promise<{ send: RawSendStream; recv: RawRecvStream }> };
  return c.openBi();
}

export async function acceptBiStream(conn: RawConnection): Promise<{ send: RawSendStream; recv: RawRecvStream }> {
  const c = conn as { acceptBi(): Promise<{ send: RawSendStream; recv: RawRecvStream }> };
  return c.acceptBi();
}
