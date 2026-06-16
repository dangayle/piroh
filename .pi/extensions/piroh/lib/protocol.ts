import { createRequire } from "node:module";

const _require = createRequire(import.meta.url);

const CBOR_AVAILABLE = (() => {
  try {
    _require.resolve("cbor-x");
    return true;
  } catch {
    return false;
  }
})();

/**
 * Message types for the hello handshake.
 */
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
    const { encode } = _require("cbor-x");
    return Buffer.from(encode(obj));
  }
  return Buffer.from(JSON.stringify(obj), "utf-8");
}

/**
 * Decode a Buffer back to a message object using the given encoding.
 */
export function decodeMessage(buf: Buffer, encoding: "cbor" | "json"): unknown {
  if (encoding === "cbor" && CBOR_AVAILABLE) {
    const { decode } = _require("cbor-x");
    return decode(buf);
  }
  return JSON.parse(buf.toString("utf-8"));
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
