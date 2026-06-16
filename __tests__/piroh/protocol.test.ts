import { describe, it, expect } from "vitest";
import { encodeFrame, decodeFrame, encodeMessage, decodeMessage, negotiateEncoding, DecodeResult } from "../../.pi/extensions/piroh/lib/protocol";

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
});
