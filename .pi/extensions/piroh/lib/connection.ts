import { createRequire } from "node:module";

const _require = createRequire(import.meta.url);

/**
 * Calculate exponential backoff delay in milliseconds.
 * Doubles each attempt with a cap at 16 seconds.
 */
export function backoffDelay(attempt: number, baseMs = 1000, maxMs = 16000): number {
  const clamped = Math.max(1, attempt);
  const delay = baseMs * Math.pow(2, clamped - 1);
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

// ---------------------------------------------------------------------------
// Iroh-specific wrappers
// ---------------------------------------------------------------------------

/** ALPN protocol identifier for piroh sessions: "piroh/session/0" */
export const PIROH_ALPN = Buffer.from("piroh/session/0");

type IrohBindings = {
  Iroh: {
    memory(opts?: Record<string, unknown>): Promise<unknown>;
    persistent(path: string, opts?: Record<string, unknown>): Promise<unknown>;
  };
  Endpoint: new () => unknown;
  Connection: new () => unknown;
};

let _irohBindings: IrohBindings | null = null;

function getIrohBindings(): IrohBindings {
  if (!_irohBindings) {
    _irohBindings = _require("@number0/iroh") as unknown as IrohBindings;
  }
  return _irohBindings;
}

/**
 * Create or reuse a 32-byte secret key.
 * If `existing` is provided and 32 bytes, returns it unchanged.
 * Otherwise generates a new cryptographically random key.
 */
export function loadOrGenerateKey(existing?: Uint8Array): Uint8Array {
  if (existing && existing.byteLength === 32) {
    return existing;
  }
  const key = new Uint8Array(32);
  crypto.getRandomValues(key);
  return key;
}

export interface PirohAcceptCallback {
  (connection: unknown): void;
}

/**
 * Create an iroh node with the piroh protocol handler.
 *
 * The returned object has a `.node.endpoint()` method for outgoing connections
 * and a `.net` client for address lookups.
 *
 * Incoming connections matching the piroh ALPN are forwarded to `onConnection`.
 */
export async function createEndpoint(
  key: Uint8Array,
  onConnection?: (connection: unknown) => void
): Promise<unknown> {
  const { Iroh } = getIrohBindings();

  const protocols: Record<string, (err: Error | null, ep: unknown) => { accept: (err: Error | null, conn: unknown) => void; shutdown?: (err: Error | null) => void }> = {};

  // Use the Buffer's string representation as the key (same pattern as iroh test code)
  protocols[PIROH_ALPN.toString()] = (_err: Error | null, _ep: unknown) => ({
    accept: (err: Error | null, conn: unknown) => {
      if (err) return;
      if (onConnection) onConnection(conn);
    },
    shutdown: (_err: Error | null) => {
      // no-op for now
    },
  });

  return Iroh.memory({
    secretKey: Array.from(key),
    protocols,
  });
}

/**
 * Connect to a remote piroh endpoint.
 *
 * @param endpoint - The local endpoint (from `iroh.node.endpoint()`).
 * @param remoteAddr - The remote node address (from `iroh.net.nodeAddr()`).
 * @returns The established QUIC connection.
 */
export async function connectPiroh(
  endpoint: { connect: (addr: unknown, alpn: Buffer) => Promise<unknown> },
  remoteAddr: unknown
): Promise<unknown> {
  return endpoint.connect(remoteAddr, PIROH_ALPN);
}
