import { describe, it } from "vitest";

describe("protocol", () => {
  it.todo("encodes a frame with length prefix");
  it.todo("decodes a frame from a buffer");
  it.todo("encodes and decodes CBOR");
  it.todo("falls back to JSON when CBOR unavailable");
  it.todo("negotiates encoding via hello handshake");
});
