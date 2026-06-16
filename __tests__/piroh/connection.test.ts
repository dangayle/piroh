import { describe, it, expect } from "vitest";
import { backoffDelay, ConnectionState, acceptPiroh } from "../../.pi/extensions/piroh/lib/connection";

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

  describe("acceptPiroh", () => {
    it("is exported and returns a Promise", () => {
      const promise = acceptPiroh();
      expect(promise).toBeInstanceOf(Promise);
    });

    it("does not reject or resolve without a connection", async () => {
      const promise = acceptPiroh();
      // Give a tick for any immediate side effects
      await new Promise((r) => setTimeout(r, 10));
      // The promise should still be pending (not settled)
      const winner = await Promise.race([
        promise.then(
          () => "resolved",
          () => "rejected"
        ),
        new Promise((r) => setTimeout(() => r("timeout"), 50)),
      ]);
      expect(winner).toBe("timeout");
    });
  });
});
