# piroh — Remote Pi Sessions over Iroh

**Design Document** · 2026-06-15

## Overview

A Pi extension that connects two Pi sessions over [Iroh](https://iroh.computer) (P2P encrypted transport), making them behave as one shared session. The host runs the agent; the client acts as an I/O relay. Both sides see identical output and can type input. The experience is seamless — like working directly on the same session.

```
Work Computer (Host)                    Laptop (Client)
┌─────────────────────┐                ┌─────────────────────┐
│ Pi TUI              │                │ Pi TUI              │
│   ↑↓ local keyboard │    iroh QUIC   │   ↑↓ local keyboard │
│ ┌─────────────────┐ │  ◄══════════►  │ ┌─────────────────┐ │
│ │ piroh extension │ │  bi streams   │ │ piroh extension │ │
│ │  input relay  ← ┼─┼───────────────┼─┼─ input relay    │ │
│ │  output relay → ┼─┼───────────────┼─┼─ output relay   │ │
│ └────────┬────────┘ │                │ └─────────────────┘ │
│          ↓           │                │                     │
│   Pi Agent Loop      │                │   (agent dormant)   │
└─────────────────────┘                └─────────────────────┘
```

## Technology Choice: `@number0/iroh`

The official Iroh Node.js bindings, published at [`@number0/iroh`](https://www.npmjs.com/package/@number0/iroh) (v0.35.0) from the [iroh-ffi](https://github.com/n0-computer/iroh-ffi) repo.

- **napi-rs** native addon — Rust compiled to `.node` binary
- **Prebuilt binaries** for macOS (universal arm64/x86_64), Linux (arm64/x86_64, musl + gnu), Windows, Android
- **No Rust toolchain needed at runtime** — `npm install` and `import`
- Covers iroh 1.0 surface: `Endpoint`, `SecretKey`, `Connection`, `SendStream`, `RecvStream`, `BiStream`, `EndpointId`, `EndpointAddr`, `EndpointTicket`

The extension is a single TypeScript file that imports `@number0/iroh` and `cbor-x` (with JSON fallback). No sidecar binary, no subprocess, no Rust build pipeline.

## Commands

Three slash commands registered via `pi.registerCommand()`:

### `/iroh-host`

Starts listening. Creates an iroh endpoint with ALPN `"piroh/session/0"`, generates a secret key, binds, and prints the `EndpointId`. Sets status to `"listening on <endpointId>"`. The host's Pi session continues normally.

```
> /iroh-host
Hosting on 12D3KooW...
Share this ID with the client.
```

### `/iroh-connect <EndpointId>`

Connects to a host. Opens an iroh connection to the given ID with ALPN `"piroh/session/0"`. On connect:
1. Sends a `hello` handshake frame (encoding negotiation, lastSeq)
2. Host replies with `snapshot` frame (full session history)
3. Client replays history into its local session
4. Client switches to relay mode — all input forwarded to host, TUI renders host output

```
> /iroh-connect 12D3KooW...
Connected to host.
```

### `/iroh-disconnect`

Closes the iroh connection on either side. Client restores local input handling. Host status reverts to idle. Connection is torn down cleanly with a `disconnect` frame (so the peer knows it was intentional, not a crash).

## Session Sync: Replay Log

The host's session is an append-only sequence of entries. On connect, the client requests a replay from a starting point:

```
Client → Host: { op: "hello", encoding: "cbor", lastSeq: 0 }
Host → Client: { op: "snapshot", entries: [...all entries...], seq: 47 }
Host → Client: { op: "message-start", seq: 48, ... }  ← live streaming begins
```

- **`lastSeq: 0`**: Full snapshot — send everything. Used on first connect.
- **`lastSeq: N` (nonzero)**: Delta — skip entries ≤ N. Used on reconnect.

The host responds with `entries: []` and `seq: N` if no new entries exist. Then live streaming resumes from `seq: N+1`.

The client replays historical entries via `pi.sendMessage()` into its local session, preserving branch/leaf structure.

## Wire Protocol

### Transport

- **ALPN**: `"piroh/session/0"` — registered on both endpoint builders. The host uses `Endpoint.accept(ALPN)` so only piroh peers connect. Accidental or malicious connections on wrong protocols are rejected at the QUIC layer.
- **Streams**: One bidirectional stream carries all message types. `open_bi()` from client, `accept_bi()` on host.

### Framing

Each message is a length-prefixed binary frame:

```
[4-byte big-endian length] [encoded payload]
```

### Encoding Negotiation

A handshake frame exchanged immediately after stream open:

```
Client → Host: { op: "hello", version: 0, encoding: "cbor", lastSeq: 0 }
Host → Client: { op: "hello-ack", encoding: "cbor" }
```

- If the host supports CBOR: replies with `"encoding": "cbor"`. Both sides use CBOR for all subsequent frames.
- If the host doesn't support CBOR: replies with `"encoding": "json"`. Both sides fall back to JSON.
- The handshake is a one-time negotiation per connection.

### Message Types

| `op` | direction | payload | notes |
|---|---|---|---|
| `hello` | client→host | `{ encoding, version, lastSeq }` | connection handshake |
| `hello-ack` | host→client | `{ encoding }` | encoding negotiation response |
| `snapshot` | host→client | `{ entries: [...], seq }` | session history replay |
| `input` | client→host | `{ text, images? }` | forwarded user input |
| `message-start` | host→client | message entry | LLM response begins |
| `message-update` | host→client | message entry | streaming delta |
| `message-end` | host→client | message entry | finalized message |
| `tool-start` | host→client | `{ toolCallId, toolName, args }` | tool execution begins |
| `tool-update` | host→client | `{ toolCallId, partialResult }` | tool progress |
| `tool-end` | host→client | `{ toolCallId, result, isError }` | tool execution complete |
| `disconnect` | either | `{ reason? }` | intentional disconnect |

Every op except `hello`/`hello-ack` carries a monotonically increasing `seq` field. Gaps are detected and trigger reconnection.

### CBOR Fallback

The extension bundles `cbor-x` as an npm dependency. On load, it attempts `require("cbor-x")`. If unavailable (older Node, broken install), it falls back to JSON encoding/decoding. Both sides use whichever encoding is negotiated in the handshake.

## Event Flow

### Input (client → host)

```
Client user types "fix the bug"
    │
    ▼
pi.on("input") → { action: "handled" }     ← suppressed locally
    │
    ▼
iroh send: { op: "input", text: "fix the bug", seq: 1 }
    │
    ▼
Host receives, calls pi.sendUserMessage("fix the bug")
    │
    ▼
Agent processes (turns, tools, messages)
```

The host's `pi.on("input")` handler distinguishes local vs. remote input source. Remote input forwarded from the client is injected via `pi.sendUserMessage()` which triggers the agent turn exactly as if typed locally.

### Output (host → client)

```
Agent produces output
    │
    ▼
pi.on("message_start")  → frame { op: "message-start", ... } → iroh
pi.on("message_update") → frame { op: "message-update", ... } → iroh
pi.on("message_end")    → frame { op: "message-end", ... } → iroh
pi.on("tool_execution_start")  → frame { op: "tool-start", ... } → iroh
pi.on("tool_execution_update") → frame { op: "tool-update", ... } → iroh
pi.on("tool_execution_end")    → frame { op: "tool-end", ... } → iroh
    │
    ▼
Client receives frame, calls pi.sendMessage() or pi.appendEntry()
    │
    ▼
Client TUI renders output inline
```

## Connection Lifecycle

### What Iroh Handles (no code needed)

| Concern | Mechanism |
|---|---|
| NAT traversal / hole-punching | `Endpoint.connect()` — automatic |
| Relay fallback | Automatic when direct connection fails |
| End-to-end encryption | QUIC — always encrypted |
| Stream multiplexing | `open_bi()` / `accept_bi()` |
| Connection drop detection | `Connection.closed()` promise + `close_reason()` |
| Address changes | `Endpoint.watch_addr()` streams updates |
| Flow control / backpressure | QUIC stream-level — `SendStream.write()` blocks on slow receiver |
| Idle timeout | QUIC idle timeout — Iroh configures |

### What We Build (application layer)

| Concern | Mechanism | Effort |
|---|---|---|
| Reconnect logic | When `connection.closed()` resolves, retry connect with exponential backoff. Re-handshake, request snapshot with last known `seq`. | ~30 lines |
| Connection status UI | Map `closed()`, reconnect state to `ctx.ui.setStatus("piroh", state)`. Show "connected", "reconnecting...", "disconnected". | ~15 lines |
| Graceful disconnect | Send `disconnect` frame before closing stream so peer knows it's intentional. | ~5 lines |
| Session snapshot batching | For sessions > 1000 entries, chunk snapshots. (Future optimization — not in MVP.) | — |

## State Management

The extension stores configuration in Pi's persistent state via `pi.appendEntry()`:

- **Keypair**: `SecretKey` (generated once, reused across sessions so `EndpointId` is stable)
- **Connection config**: relay mode, bind address, last known peer ID
- **Client lastSeq**: highest seq seen, for delta sync on reconnect

On `session_start`, the extension restores persisted state. On `session_shutdown`, it tears down the iroh endpoint and closes connections cleanly.

## Status Display

Both host and client use `ctx.ui.setStatus("piroh", ...)` for a visible connection indicator in the Pi TUI footer:

| State | Host Status | Client Status |
|---|---|---|
| Idle | (none) | (none) |
| Hosting | `listening on 12D3K...` | — |
| Connected | `client connected` | `connected to 12D3K...` |
| Reconnecting | `client reconnecting...` | `reconnecting... (attempt 3/5)` |
| Disconnected | `idle` | `disconnected from 12D3K...` |
| Error | `connection error: <reason>` | `connection error: <reason>` |

## Error Handling

- **Host unreachable**: Client retries with exponential backoff (1s, 2s, 4s, 8s, 16s). After 5 failures, notifies user and returns to local mode.
- **Client crashes**: Host detects connection closure via `closed()`, tears down relay, returns to local-only mode.
- **Stream errors**: Read/write errors on the iroh stream trigger reconnection (new stream over same or new connection).
- **Protocol mismatch**: Invalid frames or unknown opcodes are logged and ignored. Seq gaps trigger reconnection.
- **Large session**: If snapshot exceeds stream buffer, the handshake sets a `maxSeq` and entries are sent in batches. (Future optimization.)

## Dependencies

- `@number0/iroh` (npm) — Iroh Node.js bindings, napi-rs
- `cbor-x` (npm) — CBOR codec with JSON fallback
- `@earendil-works/pi-coding-agent` — Pi extension types

## Open Questions / Future Work

1. **Multiple clients**: Currently one host, one client. Multiple simultaneous clients would need output fan-out and input conflict resolution.
2. **Input ordering on conflict**: Two users typing simultaneously — currently FIFO at the host. Turn-taking could be added.
3. **Session snapshot batching**: For very large sessions, chunked transfer with progress.
4. **Tickets for easier sharing**: Iroh tickets (`EndpointTicket`) bundle NodeId + relay config + auth, so sharing is a single string instead of raw `EndpointId`.
5. **Encryption at rest for session sync**: The CBOR/JSON payloads are encrypted in transit (QUIC). Full payload encryption is unnecessary unless the extension stores session data locally.

## Extension Structure

```
.pi/extensions/piroh/
├── package.json       # npm dependencies (@number0/iroh, cbor-x)
├── package-lock.json
├── node_modules/
└── index.ts           # single-file extension
```

The extension is a single TypeScript file (~300-400 lines) that registers three commands and wires Pi events to iroh streams.
