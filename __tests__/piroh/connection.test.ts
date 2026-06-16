import { describe, it, expect } from "vitest";
import { backoffDelay, ConnectionState, loadOrGenerateKey, PIROH_ALPN } from "../../.pi/extensions/piroh/lib/connection";

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

  describe("loadOrGenerateKey", () => {
    it("generates a 32-byte key when called with no arguments", () => {
      const key = loadOrGenerateKey();
      expect(key).toBeInstanceOf(Uint8Array);
      expect(key.byteLength).toBe(32);
    });

    it("returns the existing key unchanged", () => {
      const existing = new Uint8Array(32);
      crypto.getRandomValues(existing);
      const result = loadOrGenerateKey(existing);
      expect(result).toBe(existing);
    });

    it("rejects keys that are not 32 bytes", () => {
      const tooShort = new Uint8Array(16);
      const result = loadOrGenerateKey(tooShort);
      expect(result).not.toBe(tooShort);
      expect(result.byteLength).toBe(32);
    });
  });

  describe("PIROH_ALPN", () => {
    it("is a Buffer with the expected protocol ID", () => {
      expect(PIROH_ALPN).toBeInstanceOf(Buffer);
      expect(PIROH_ALPN.toString()).toBe("piroh/session/0");
    });
  });

  // NodeHandle.acceptConnection() and connectTo() are integration-tested —
  // they need a running Iroh node and are covered by integration.test.ts.
});
