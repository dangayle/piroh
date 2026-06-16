import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createRequire } from "node:module";

const _require = createRequire(import.meta.url);

import {
  CBOR_AVAILABLE,
  encodeFrame,
  encodeMessage,
  decodeFrame,
  decodeMessage,
  negotiateEncoding,
} from "./lib/protocol";
import { buildSnapshot, type WireEntry, type SnapshotMessage } from "./lib/session";
import {
  ConnectionState,
  createEndpoint,
  loadOrGenerateKey,
  readBuffer,
  writeBuffer,
  finishStream,
  closeConnection,
  connectionClosed,
  openBiStream,
  acceptBiStream,
  type NodeHandle,
} from "./lib/connection";

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

/** A connected bidirectional stream — send + recv. */
type BiStream = { send: unknown; recv: unknown };

interface PirohState {
  /** Raw 32-byte secret key as Uint8Array. Persisted across sessions. */
  key: Uint8Array | null;
  /** Node handle — abstracts 0.31 / 1.0 endpoint creation, accept, connect, shutdown. */
  endpoint: NodeHandle | null;
  /** Active QUIC connection to a remote peer. */
  connection: unknown | null;
  /** Open bidirectional stream over the connection. */
  stream: BiStream | null;
  /** Negotiated frame encoding ("cbor" | "json"). */
  encoding: "cbor" | "json";
  /** Monotonic message sequence number. */
  seq: number;
  /** Current mode of the extension. */
  mode: "idle" | "host" | "client";
  /** Remote EndpointId when in client mode. */
  remoteId: string | null;
  /** Connection retry / lifecycle state. */
  connState: ConnectionState;
  /** When true, local text input is forwarded to the remote host instead of the local agent. */
  suppressInput: boolean;
}

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
  };
}

// ---------------------------------------------------------------------------
// Extension entry point
// ---------------------------------------------------------------------------

export default function (pi: ExtensionAPI) {
  const state = createState();

  // ── Restore persisted key on session start ──
  pi.on("session_start", async (_event: unknown, ctx: ExtensionContext) => {
    const entries = ctx.sessionManager.getEntries() as Array<{
      type: string;
      customType?: string;
      data?: unknown;
    }>;
    for (const entry of entries) {
      if (entry.type === "custom" && entry.customType === "piroh-key") {
        const hex = entry.data as string;
        state.key = new Uint8Array(Buffer.from(hex, "hex"));
        break;
      }
    }
  });

  // ── Helper: update status widget ──
  function updateStatus(ctx: ExtensionContext) {
    const c = state.connState.current;
    if (state.mode === "host") {
      if (c === "connected") {
        ctx.ui.setStatus("piroh", "host: client connected");
      } else {
        const id = state.endpoint ? state.endpoint.nodeId() : "unknown";
        ctx.ui.setStatus("piroh", `host: listening on ${id.slice(0, 12)}...`);
      }
    } else if (state.mode === "client") {
      if (c === "connected") {
        ctx.ui.setStatus("piroh", "client: connected");
      } else if (c === "reconnecting") {
        ctx.ui.setStatus("piroh", `client: reconnecting (${state.connState.retryCount}/5)`);
      } else if (c === "disconnected") {
        ctx.ui.setStatus("piroh", "client: disconnected");
      } else {
        ctx.ui.setStatus("piroh", "client: connecting...");
      }
    }
  }

  // ── Helper: send notification ──
  function notify(ctx: ExtensionContext, msg: string, level: "info" | "error" | "warn" = "info") {
    ctx.ui.notify(msg, level);
  }



  // ── Helper: build and send snapshot ──
  async function sendSnapshot(
    stream: BiStream,
    ctx: ExtensionContext,
    lastSeq: number
  ): Promise<SnapshotMessage> {
    const rawEntries = ctx.sessionManager.getEntries() as Array<Record<string, unknown>>;
    const entries: WireEntry[] = rawEntries.map((e) => ({
      ...e,
      id: String(e.id ?? ""),
      type: String(e.type ?? "message"),
      content: e.content,
      timestamp: (e.timestamp as number) ?? Date.now(),
    }));
    const snapshot = buildSnapshot(entries, lastSeq);
    const frame = encodeFrame(encodeMessage(snapshot, state.encoding));
    await writeBuffer(stream.send, frame);
    return snapshot;
  }

  // ── Helper: relay an output frame to the remote (host -> client) ──
  async function relayFrame(_ctx: ExtensionContext, op: string, data: Record<string, unknown>) {
    if (!state.stream || state.mode !== "host") return;
    const seq = ++state.seq;
    const frame = encodeFrame(encodeMessage({ op, seq, ...data }, state.encoding));
    try {
      await writeBuffer(state.stream.send, frame);
    } catch {
      // Stream error — connection dropped, handled by watchConnection
    }
  }

  // ── Host: accept incoming connections loop ──
  async function startHostLoop(ctx: ExtensionContext) {
    if (!state.endpoint) return;

    while (state.mode === "host") {
      try {
        const conn = await state.endpoint.acceptConnection();
        state.connection = conn;
        state.connState.transition("connected");

        // Accept a bidirectional stream
        const stream = await acceptBiStream(conn);
        state.stream = stream;
        updateStatus(ctx);

        // ── Hello handshake ──
        const recvBuf = await readBuffer(stream.recv, 65536);
        if (recvBuf.length === 0) continue;

        const frameResult = decodeFrame(recvBuf);
        if (!frameResult) continue;

        const hello = decodeMessage(frameResult.payload, "json") as {
          op: string;
          encoding: "cbor" | "json";
          lastSeq: number;
        };
        if (hello.op !== "hello") continue;

        // Negotiate encoding
        const ack = negotiateEncoding(
          { op: "hello", version: 0, encoding: hello.encoding, lastSeq: hello.lastSeq },
          CBOR_AVAILABLE
        );
        state.encoding = ack.encoding;
        const ackFrame = encodeFrame(encodeMessage(ack, "json"));
        await writeBuffer(stream.send, ackFrame);

        // Send snapshot
        const snapshot = await sendSnapshot(stream, ctx, hello.lastSeq);
        state.seq = snapshot.seq;

        updateStatus(ctx);

        // Start reading input from client in background
        readFromClient(ctx, stream).catch(() => {});

        // Watch for connection close
        watchConnection(ctx, conn).catch(() => {});
      } catch {
        state.connState.transition("disconnected");
        updateStatus(ctx);
      }
    }
  }

  // ── Read input frames from client (host side) ──
  async function readFromClient(ctx: ExtensionContext, stream: BiStream) {
    while (state.mode === "host" && state.stream === stream) {
      try {
        // readBuffer returns one complete frame (or throws on EOF)
        const frameBuf = await readBuffer(stream.recv, 65536);
        if (frameBuf.length === 0) continue;  // EOF

        const frameResult = decodeFrame(frameBuf);
        if (!frameResult) continue;  // Malformed frame

        const msg = decodeMessage(frameResult.payload, state.encoding) as {
          op: string;
          text?: string;
          images?: unknown[];
        };

        if (msg.op === "input") {
          // Inject user message from client
          await pi.sendUserMessage(msg.text ?? "");
        } else if (msg.op === "disconnect") {
          // Client disconnected gracefully
          state.connState.transition("disconnected");
          state.stream = null;
          updateStatus(ctx);
          return;
        }
      } catch {
        // Stream error or EOF — connection lost
        break;
      }
    }
  }

  // ── Watch connection for drop ──
  async function watchConnection(ctx: ExtensionContext, conn: unknown) {
    await connectionClosed(conn);
    if (state.connection === conn) {
      state.connection = null;
      state.stream = null;
      state.connState.transition("disconnected");
      updateStatus(ctx);
      // If in client mode, attempt reconnection with backoff
      if (state.mode === "client" && state.remoteId && state.endpoint) {
        startReconnect(ctx).catch(() => {});
      }
    }
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // Pi Event Hooks — Output Relay (host side)
  // ═══════════════════════════════════════════════════════════════════════════

  pi.on("message_start", async (event: { message: unknown }, ctx: ExtensionContext) => {
    await relayFrame(ctx, "message-start", { message: event.message });
  });

  pi.on("message_update", async (event: { message: unknown }, ctx: ExtensionContext) => {
    await relayFrame(ctx, "message-update", { message: event.message });
  });

  pi.on("message_end", async (event: { message: unknown }, ctx: ExtensionContext) => {
    await relayFrame(ctx, "message-end", { message: event.message });
  });

  pi.on(
    "tool_execution_start",
    async (
      event: { toolCallId: string; toolName: string; args: unknown },
      ctx: ExtensionContext
    ) => {
      await relayFrame(ctx, "tool-start", {
        toolCallId: event.toolCallId,
        toolName: event.toolName,
        args: event.args,
      });
    }
  );

  pi.on(
    "tool_execution_update",
    async (
      event: { toolCallId: string; partialResult: unknown },
      ctx: ExtensionContext
    ) => {
      await relayFrame(ctx, "tool-update", {
        toolCallId: event.toolCallId,
        partialResult: event.partialResult,
      });
    }
  );

  pi.on(
    "tool_execution_end",
    async (
      event: { toolCallId: string; result: unknown; isError: boolean },
      ctx: ExtensionContext
    ) => {
      await relayFrame(ctx, "tool-end", {
        toolCallId: event.toolCallId,
        result: event.result,
        isError: event.isError,
      });
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // Input Hook — suppress on client, forward to host
  // ═══════════════════════════════════════════════════════════════════════════

  pi.on(
    "input",
    async (
      event: { text: string },
      ctx: ExtensionContext
    ): Promise<{ action: "handled" | "continue" } | undefined> => {
      if (state.suppressInput && state.mode === "client") {
        // Forward to host
        if (state.stream) {
          const frame = encodeFrame(
            encodeMessage(
              { op: "input", text: event.text, seq: ++state.seq },
              state.encoding
            )
          );
          try {
            await writeBuffer(state.stream.send, frame);
          } catch {
            // Connection lost
          }
        }
        return { action: "handled" };
      }
      return { action: "continue" };
    }
  );

  // ═══════════════════════════════════════════════════════════════════════════
  // /iroh-host — Start hosting
  // ═══════════════════════════════════════════════════════════════════════════

  pi.registerCommand("iroh-host", {
    description: "Start hosting this Pi session over Iroh",
    handler: async (_args: string, ctx: ExtensionContext) => {
      if (state.mode === "host") {
        notify(ctx, "Already hosting", "info");
        return;
      }

      // Generate or restore key
      if (!state.key) {
        state.key = loadOrGenerateKey();
        // Persist the key for future sessions
        pi.appendEntry("piroh-key", Buffer.from(state.key).toString("hex"));
      }

      state.endpoint = await createEndpoint(state.key);
      state.mode = "host";
      state.connState.transition("idle");
      const id = state.endpoint.nodeId();
      const address = await state.endpoint.getAddress();
      updateStatus(ctx);

      notify(
        ctx,
        `Hosting on ${id}\nConnect with: /iroh-connect ${address}`,
        "info"
      );

      // Start accept loop in background
      startHostLoop(ctx).catch((err: Error) => {
        notify(ctx, `Host error: ${err.message}`, "error");
      });
    },
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // /iroh-connect <endpointId> — Connect to a remote host
  // ═══════════════════════════════════════════════════════════════════════════

  pi.registerCommand("iroh-connect", {
    description: "Connect to a remote Pi session over Iroh",
    handler: async (args: string, ctx: ExtensionContext) => {
      const address = args.trim();
      if (!address) {
        notify(ctx, "Usage: /iroh-connect <address blob or node ID>", "error");
        return;
      }

      if (state.mode === "client") {
        notify(ctx, "Already connected. Use /iroh-disconnect first.", "info");
        return;
      }

      // Create endpoint if needed
      if (!state.key) {
        state.key = loadOrGenerateKey();
      }
      if (!state.endpoint) {
        state.endpoint = await createEndpoint(state.key);
      }

      state.mode = "client";
      state.remoteId = address;
      state.connState.transition("connecting");
      updateStatus(ctx);

      try {
        const conn = await state.endpoint.connectTo(address);
        state.connection = conn;
        state.connState.transition("connected");
        updateStatus(ctx);

        await setupClientStream(ctx, conn);
      } catch (err) {
        state.connState.transition("disconnected");
        state.mode = "idle";
        updateStatus(ctx);
        notify(ctx, `Failed to connect: ${err instanceof Error ? err.message : String(err)}`, "error");
      }
    },
  });

  // ── Read output from host (client side) ──
  async function readFromHost(ctx: ExtensionContext, stream: BiStream) {
    while (state.mode === "client" && state.stream === stream) {
      try {
        // readBuffer returns one complete frame (or throws on EOF)
        const frameBuf = await readBuffer(stream.recv, 131072);
        if (frameBuf.length === 0) continue;  // EOF

        const frameResult = decodeFrame(frameBuf);
        if (!frameResult) continue;  // Malformed frame

        const msg = decodeMessage(frameResult.payload, state.encoding) as {
          op: string;
          seq: number;
          message?: unknown;
          toolCallId?: string;
          toolName?: string;
          args?: unknown;
          result?: unknown;
          isError?: boolean;
          partialResult?: unknown;
        };

        state.seq = msg.seq;

        switch (msg.op) {
          case "snapshot":
            // Already handled during connect; could arrive on reconnect
            break;
          case "message-start":
          case "message-update":
          case "message-end":
            // Relay the message object directly from host
            pi.sendMessage(msg.message as Parameters<typeof pi.sendMessage>[0]);
            break;
          case "tool-start":
          case "tool-update":
          case "tool-end":
            pi.sendMessage({
              customType: "piroh-tool",
              content: msg.result ?? msg.partialResult ?? "",
              display: true,
              details: {
                toolCallId: msg.toolCallId,
                toolName: msg.toolName,
              },
            });
            break;
          case "disconnect":
            state.connState.transition("disconnected");
            state.suppressInput = false;
            state.stream = null;
            updateStatus(ctx);
            notify(ctx, "Host disconnected", "info");
            return;
        }
      } catch {
        // Stream error or EOF — connection closed
        break;
      }
    }
  }

  // ── Set up client stream after connection (handshake, snapshot replay, readers) ──
  async function setupClientStream(ctx: ExtensionContext, conn: unknown): Promise<void> {
    const stream = await openBiStream(conn);
    state.stream = stream;

    // Send hello
    const hello = {
      op: "hello" as const,
      version: 0,
      encoding: (CBOR_AVAILABLE ? "cbor" : "json") as "cbor" | "json",
      lastSeq: 0,
    };
    const helloFrame = encodeFrame(encodeMessage(hello, "json"));
    await writeBuffer(stream.send, helloFrame);

    // Read hello-ack (readBuffer returns one complete frame)
    let ackBuf = await readBuffer(stream.recv, 65536);
    if (ackBuf.length === 0) throw new Error("Server closed connection before hello-ack");
    
    let frameResult = decodeFrame(ackBuf);
    if (!frameResult) throw new Error("Failed to decode hello-ack frame");
    
    const ack = decodeMessage(frameResult.payload, "json") as {
      op: string;
      encoding: "cbor" | "json";
    };
    if (ack.op !== "hello-ack") throw new Error(`Expected hello-ack, got ${ack.op}`);
    state.encoding = ack.encoding;

    // Read snapshot frame
    const snapBuf = await readBuffer(stream.recv, 131072);
    if (snapBuf.length === 0) throw new Error("Server closed connection before sending snapshot");
    
    frameResult = decodeFrame(snapBuf);
    if (!frameResult) throw new Error("Failed to decode snapshot frame");
    
    const snapshot = decodeMessage(
      frameResult.payload,
      state.encoding
    ) as SnapshotMessage;

    // Snapshot received — just track the sequence number
    // Don't replay entries as new messages; they're historical context only
    state.seq = snapshot.seq;

    // Now suppress local input and forward to host
    state.suppressInput = true;
    updateStatus(ctx);

    // Start reading output from host in background
    readFromHost(ctx, stream).catch(() => {});

    // Watch for connection close
    watchConnection(ctx, conn).catch(() => {});
  }

  // ── Reconnect logic with exponential backoff ──
  async function startReconnect(ctx: ExtensionContext): Promise<void> {
    if (state.mode !== "client" || !state.remoteId || !state.endpoint) return;
    state.connState.resetRetries();

    while (state.connState.retryCount < 5 && state.mode === "client") {
      state.connState.transition("reconnecting");
      state.connState.incrementRetry();
      updateStatus(ctx);

      // Wait with backoff
      await new Promise((resolve) => setTimeout(resolve, state.connState.backoffMs));

      try {
        const conn = await state.endpoint.connectTo(state.remoteId);
        state.connection = conn;
        state.connState.transition("connected");

        await setupClientStream(ctx, conn);
        return; // Success
      } catch {
        // Will retry if under maxRetries
      }
    }

    // All retries exhausted
    state.connState.transition("disconnected");
    state.mode = "idle";
    updateStatus(ctx);
    notify(ctx, "Connection lost — all reconnection attempts failed", "error");
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // /iroh-disconnect — Tear down connection
  // ═══════════════════════════════════════════════════════════════════════════

  pi.registerCommand("iroh-disconnect", {
    description: "Disconnect from the remote Pi session",
    handler: async (_args: string, ctx: ExtensionContext) => {
      if (state.mode === "idle") {
        notify(ctx, "Not connected", "info");
        return;
      }

      // Send disconnect frame
      if (state.stream) {
        try {
          const frame = encodeFrame(
            encodeMessage(
              { op: "disconnect", seq: ++state.seq, reason: "user" },
              state.encoding
            )
          );
          await writeBuffer(state.stream.send, frame);
          await finishStream(state.stream.send);
        } catch {
          // Already dead
        }
        state.stream = null;
      }

      if (state.connection) {
        try {
          closeConnection(state.connection, BigInt(0), Buffer.from("user disconnect"));
        } catch {
          // Already closed
        }
        state.connection = null;
      }

      state.mode = "idle";
      state.suppressInput = false;
      state.connState.transition("idle");
      updateStatus(ctx);
      notify(ctx, "Disconnected", "info");
    },
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Clean up on shutdown
  // ═══════════════════════════════════════════════════════════════════════════

  pi.on("session_shutdown", async () => {
    if (state.stream) {
      try {
        await finishStream(state.stream.send);
      } catch {
        // Best effort
      }
      state.stream = null;
    }
    if (state.connection) {
      try {
        closeConnection(state.connection, BigInt(0), Buffer.from("shutdown"));
      } catch {
        // Best effort
      }
      state.connection = null;
    }
    if (state.endpoint) {
      try {
        await state.endpoint.destroy();
      } catch {
        // Best effort
      }
      state.endpoint = null;
    }
    state.mode = "idle";
    state.suppressInput = false;
  });
}
