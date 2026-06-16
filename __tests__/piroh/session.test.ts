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
