import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  encodeFrame,
  encodeMessage,
  decodeFrame,
  decodeMessage,
} from "../../.pi/extensions/piroh/lib/protocol";
import { buildSnapshot } from "../../.pi/extensions/piroh/lib/session";
import {
  createEndpoint,
  loadOrGenerateKey,
  readBuffer,
  writeBuffer,
  openBiStream,
  acceptBiStream,
} from "../../.pi/extensions/piroh/lib/connection";

/**
 * Test the exact handshake flow that the extension performs.
 * This simulates what happens when /iroh-host and /iroh-connect are called.
 */
describe("extension handshake flow (realistic)", () => {
  const TIMEOUT = 15_000;

  it(
    "completes host→client handshake with exact extension message sequence",
    { timeout: TIMEOUT },
    async () => {
      // Setup
      const hostKey = loadOrGenerateKey();
      const clientKey = loadOrGenerateKey();
      const hostEndpoint = await createEndpoint(hostKey);
      const clientEndpoint = await createEndpoint(clientKey);

      try {
        const hostId = hostEndpoint.nodeId();
        const hostAddr = await hostEndpoint.getAddress();

        console.log(`[TEST] Host ID: ${hostId.slice(0, 12)}...`);
        console.log(`[TEST] Client connecting to: ${hostAddr.slice(0, 20)}...`);

        // Host and client connect concurrently
        let hostConn: unknown;
        let clientConn: unknown;
        let hostError: Error | null = null;
        let clientError: Error | null = null;

        const hostConnectPromise = hostEndpoint
          .acceptConnection()
          .then((conn) => {
            hostConn = conn;
            console.log("[HOST] Connection accepted");
          })
          .catch((err) => {
            hostError = err;
            console.error("[HOST] Accept failed:", err);
          });

        const clientConnectPromise = clientEndpoint
          .connectTo(hostAddr)
          .then((conn) => {
            clientConn = conn;
            console.log("[CLIENT] Connected");
          })
          .catch((err) => {
            clientError = err;
            console.error("[CLIENT] Connect failed:", err);
          });

        // Wait for both to establish connections
        await Promise.all([hostConnectPromise, clientConnectPromise]);

        if (hostError) throw new Error(`Host connection failed: ${hostError.message}`);
        if (clientError) throw new Error(`Client connection failed: ${clientError.message}`);
        if (!hostConn || !clientConn) throw new Error("Connection objects not set");

        console.log("[TEST] Both connections established");

        // ── Host: Accept bistream ──
        let hostStream: any;
        let clientStream: any;

        const hostStreamPromise = acceptBiStream(hostConn)
          .then((stream) => {
            hostStream = stream;
            console.log("[HOST] Bistream accepted");
          })
          .catch((err) => {
            hostError = err;
            console.error("[HOST] Accept bistream failed:", err);
          });

        // ── Client: Open bistream and send hello ──
        const clientStreamPromise = openBiStream(clientConn)
          .then(async (stream) => {
            clientStream = stream;
            console.log("[CLIENT] Bistream opened");

            // Send hello immediately
            const hello = {
              op: "hello" as const,
              version: 0,
              encoding: "json" as const,
              lastSeq: 0,
            };
            const helloFrame = encodeFrame(encodeMessage(hello, "json"));
            console.log(`[CLIENT] Sending hello frame (${helloFrame.length} bytes)`);
            await writeBuffer(stream.send, helloFrame);
            console.log("[CLIENT] Hello sent");
          })
          .catch((err) => {
            clientError = err;
            console.error("[CLIENT] Open bistream failed:", err);
          });

        // Wait for bistream setup
        await Promise.all([hostStreamPromise, clientStreamPromise]);

        if (hostError) throw new Error(`Host bistream failed: ${hostError.message}`);
        if (clientError) throw new Error(`Client bistream failed: ${clientError.message}`);
        if (!hostStream || !clientStream) throw new Error("Bistream objects not set");

        console.log("[TEST] Bistreams ready");

        // ── Host: Read hello frame ──
        console.log("[HOST] Reading hello...");
        const hostRecvBuf = await readBuffer(hostStream.recv, 65536);
        console.log(`[HOST] Received ${hostRecvBuf.length} bytes`);

        const hostFrameResult = decodeFrame(hostRecvBuf);
        expect(hostFrameResult).not.toBeNull();
        const hostHello = decodeMessage(hostFrameResult!.payload, "json") as any;
        console.log(`[HOST] Decoded hello: op=${hostHello.op}`);
        expect(hostHello.op).toBe("hello");

        // ── Host: Send hello-ack and snapshot ──
        console.log("[HOST] Sending hello-ack + snapshot...");
        const ack = { op: "hello-ack" as const, encoding: "json" as const };
        const ackFrame = encodeFrame(encodeMessage(ack, "json"));

        const snapshot = buildSnapshot([], 0); // Empty entries for test
        const snapshotFrame = encodeFrame(encodeMessage(snapshot, "json"));

        await writeBuffer(hostStream.send, ackFrame);
        console.log("[HOST] Hello-ack sent");
        await writeBuffer(hostStream.send, snapshotFrame);
        console.log("[HOST] Snapshot sent");

        // ── Client: Read hello-ack and snapshot ──
        console.log("[CLIENT] Reading hello-ack + snapshot...");
        let clientBuffer = Buffer.alloc(0);
        let ackReceived = false;

        // Read first chunk (should contain both ack and snapshot)
        const clientChunk1 = await readBuffer(clientStream.recv, 65536);
        console.log(
          `[CLIENT] Received chunk 1: ${clientChunk1.length} bytes, looking for ack`
        );
        clientBuffer = Buffer.concat([clientBuffer, clientChunk1]);

        // Try to decode ack frame
        let frameResult = decodeFrame(clientBuffer);
        if (frameResult) {
          const ack = decodeMessage(frameResult.payload, "json") as any;
          console.log(`[CLIENT] Decoded frame: op=${ack.op}`);
          if (ack.op === "hello-ack") {
            ackReceived = true;
            clientBuffer = clientBuffer.subarray(frameResult.consumed);
            console.log(
              `[CLIENT] Hello-ack received, ${clientBuffer.length} bytes remaining in buffer`
            );
          }
        }

        expect(ackReceived).toBe(true);

        // Try to decode snapshot from remaining buffer
        if (clientBuffer.length > 0) {
          frameResult = decodeFrame(clientBuffer);
          if (frameResult) {
            const snapshot = decodeMessage(frameResult.payload, "json") as any;
            console.log(`[CLIENT] Snapshot decoded: op=${snapshot.op}, entries=${snapshot.entries.length}`);
            expect(snapshot.op).toBe("snapshot");
          } else {
            console.log("[CLIENT] Snapshot frame incomplete in buffer, reading more...");
            const clientChunk2 = await readBuffer(clientStream.recv, 65536);
            console.log(
              `[CLIENT] Received chunk 2: ${clientChunk2.length} bytes`
            );
            clientBuffer = Buffer.concat([clientBuffer, clientChunk2]);
            frameResult = decodeFrame(clientBuffer);
            expect(frameResult).not.toBeNull();
            const snapshot = decodeMessage(frameResult!.payload, "json") as any;
            expect(snapshot.op).toBe("snapshot");
          }
        }

        console.log("[TEST] Handshake complete!");
      } finally {
        await hostEndpoint.destroy();
        await clientEndpoint.destroy();
      }
    },
    TIMEOUT
  );
});
