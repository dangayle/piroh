# Piroh Client Connection Deadlock - Fixed

## Summary
Fixed a critical deadlock in the Piroh client connection handshake. Clients were stuck in "connecting..." state even though the host correctly showed "client connected". The root cause was incorrect use of the Iroh stream read API.

## Root Cause
The `readBuffer()` function in `lib/connection.ts` used `readToEnd()`, which:
- Waits for EOF (stream closure) before returning
- Tries to accumulate data until EOF or buffer limit
- Never returns if the stream stays open (which it does in Iroh for multiple messages)

When the host called `readBuffer()` to read the client's hello frame:
1. Client opens bistream and writes hello frame immediately
2. Host calls `acceptBiStream()` then `readBuffer()` 
3. `readBuffer()` calls `recv.readToEnd()` → **blocks waiting for EOF**
4. Client waits for hello-ack response → **deadlock**

The hello frame had arrived but the reader was blocking, never making progress.

## Solution
Changed `readBuffer()` to use `readExact()` instead, which reads exactly N bytes without waiting for EOF:

```typescript
export async function readBuffer(recv: RawRecvStream, sizeLimit: number): Promise<Buffer> {
  const s = recv as { readExact(buf: Uint8Array): Promise<void> };
  
  // Read frame header (4 bytes for length)
  const header = Buffer.alloc(4);
  try {
    await s.readExact(header);
  } catch {
    return Buffer.alloc(0);  // EOF on header
  }
  
  // Parse length and read payload
  const length = header.readUint32BE(0);
  if (length > sizeLimit) throw new Error(`Frame too large: ${length}`);
  
  const payload = Buffer.alloc(length);
  await s.readExact(payload);  // Throws if EOF before payload complete
  
  // Return one complete frame
  return Buffer.concat([header, payload]);
}
```

**Key improvements:**
- Uses `readExact(buf)` which returns as soon as exactly `buf.length` bytes are available
- Never waits for EOF if data is available
- Returns one complete frame per call (respects frame protocol boundaries)
- Properly throws on truncated frames (EOF before full payload)

## Simplified Stream Handlers
With `readBuffer()` now returning exactly one frame per call, the stream reading loops became much simpler:

**Before:** Accumulated unknown amounts of data, then looped through all frames in buffer
```typescript
let buffer = Buffer.alloc(0);
const chunk = await readBuffer(...);  // Might be partial
buffer = Buffer.concat([buffer, chunk]);
let frame = decodeFrame(buffer);
while (frame !== null) {
  // Process frame
  buffer = buffer.subarray(frame.consumed);
  frame = decodeFrame(buffer);  // Decode next frame in buffer
}
```

**After:** Process one frame per iteration
```typescript
const frameBuf = await readBuffer(...);  // One complete frame
if (frameBuf.length === 0) continue;  // EOF
const frame = decodeFrame(frameBuf);
// Process frame
```

## Testing
Created `__tests__/piroh/extension-integration.test.ts` which:
- Spins up real Iroh host and client endpoints
- Opens bistreams between them
- Exchanges hello/hello-ack/snapshot frames
- Verifies handshake completes in ~1 second (was timing out at 15 seconds)

All 51 tests pass ✅

## Files Changed
- `.pi/extensions/piroh/lib/connection.ts` - Fixed `readBuffer()` to use `readExact()`
- `.pi/extensions/piroh/index.ts` - Simplified stream reading loops, removed workaround code
- `__tests__/piroh/extension-integration.test.ts` - New end-to-end handshake test
