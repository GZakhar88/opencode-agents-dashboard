/**
 * Tests for server/sse.ts — SSE client management and broadcasting
 *
 * Covers:
 * - broadcast() sends to all connected clients
 * - broadcast() removes clients that throw
 * - createSSEResponse() returns proper SSE headers
 * - createSSEResponse() sends retry, connected, and state:full events
 * - Client tracking (add/remove)
 * - reset() clears all state
 *
 * Run: bun test server/sse.test.ts
 */

import { describe, it, expect, beforeEach } from "bun:test";
import {
  broadcast,
  createSSEResponse,
  clientCount,
  currentMessageId,
  reset,
  clients,
} from "./sse";

function cleanup() {
  reset();
}

// --- Tests ---

describe("SSE broadcast", () => {
  beforeEach(cleanup);

  it("sends formatted SSE message to all connected clients", () => {
    const received: string[] = [];

    // Create a fake client via a ReadableStream
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        clients.add({ controller, connectedAt: Date.now() });
        const originalEnqueue = controller.enqueue.bind(controller);
        controller.enqueue = (chunk: Uint8Array) => {
          received.push(new TextDecoder().decode(chunk));
          originalEnqueue(chunk);
        };
      },
    });
    const reader = stream.getReader();

    broadcast("test:event", { key: "value" });

    expect(received.length).toBe(1);
    expect(received[0]).toContain("event: test:event");
    expect(received[0]).toContain('"key":"value"');
    expect(received[0]).toMatch(/^id: \d+\n/);

    reader.cancel();
  });

  it("increments message ID on each broadcast", () => {
    const before = currentMessageId();
    broadcast("test:a", {});
    broadcast("test:b", {});
    const after = currentMessageId();
    expect(after).toBe(before + 2);
  });

  it("sends to multiple clients", () => {
    const received1: string[] = [];
    const received2: string[] = [];

    const stream1 = new ReadableStream<Uint8Array>({
      start(controller) {
        clients.add({ controller, connectedAt: Date.now() });
        const orig = controller.enqueue.bind(controller);
        controller.enqueue = (chunk: Uint8Array) => {
          received1.push(new TextDecoder().decode(chunk));
          orig(chunk);
        };
      },
    });

    const stream2 = new ReadableStream<Uint8Array>({
      start(controller) {
        clients.add({ controller, connectedAt: Date.now() });
        const orig = controller.enqueue.bind(controller);
        controller.enqueue = (chunk: Uint8Array) => {
          received2.push(new TextDecoder().decode(chunk));
          orig(chunk);
        };
      },
    });

    const r1 = stream1.getReader();
    const r2 = stream2.getReader();

    broadcast("multi:test", { count: 2 });

    expect(received1.length).toBe(1);
    expect(received2.length).toBe(1);
    expect(received1[0]).toContain("event: multi:test");
    expect(received2[0]).toContain("event: multi:test");

    r1.cancel();
    r2.cancel();
  });

  it("removes clients that throw on enqueue", () => {
    const brokenController = {
      enqueue() {
        throw new Error("Client disconnected");
      },
    } as unknown as ReadableStreamDefaultController<Uint8Array>;

    clients.add({ controller: brokenController, connectedAt: Date.now() });
    expect(clientCount()).toBe(1);

    broadcast("test:event", {});

    expect(clientCount()).toBe(0);
  });

  it("handles empty client set gracefully", () => {
    expect(clientCount()).toBe(0);
    // Should not throw
    broadcast("test:empty", { data: "value" });
    expect(clientCount()).toBe(0);
  });
});

describe("SSE createSSEResponse", () => {
  beforeEach(cleanup);

  it("returns a response with SSE headers", () => {
    const res = createSSEResponse(
      () => [],
      () => ({ projects: [] }),
      null,
      () => ({ "Access-Control-Allow-Origin": "*" })
    );

    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
    expect(res.headers.get("Connection")).toBe("keep-alive");
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("sends retry, connected, and state:full events", async () => {
    const res = createSSEResponse(
      () => [
        {
          pluginId: "p1",
          projectPath: "/path/a",
          projectName: "project-a",
        },
      ],
      () => ({ projects: [{ name: "test" }] }),
      null,
      () => ({})
    );

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    let text = "";
    for (let i = 0; i < 5; i++) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.includes("state:full")) break;
    }

    // Check retry directive
    expect(text).toContain("retry: 3000");

    // Check connected event
    expect(text).toContain("event: connected");
    expect(text).toContain("SSE connected");
    expect(text).toContain("project-a");

    // Check state:full event
    expect(text).toContain("event: state:full");
    expect(text).toContain('"projects"');

    reader.cancel();
  });

  it("registers the client", async () => {
    const sizeBefore = clientCount();
    const res = createSSEResponse(
      () => [],
      () => ({ projects: [] }),
      null,
      () => ({})
    );

    const reader = res.body!.getReader();
    await reader.read();

    expect(clientCount()).toBe(sizeBefore + 1);

    reader.cancel();
  });
});

describe("SSE reset", () => {
  beforeEach(cleanup);

  it("clears all clients and resets message ID", () => {
    // Add a fake client
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        clients.add({ controller, connectedAt: Date.now() });
      },
    });
    stream.getReader(); // keep it alive

    expect(clientCount()).toBe(1);

    // Broadcast to advance message ID
    broadcast("test", {});
    const midId = currentMessageId();
    expect(midId).toBeGreaterThan(0);

    reset();

    expect(clientCount()).toBe(0);
    expect(currentMessageId()).toBe(0);
  });
});

describe("SSE clientCount", () => {
  beforeEach(cleanup);

  it("accurately reflects connected clients", () => {
    expect(clientCount()).toBe(0);

    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        clients.add({ controller, connectedAt: Date.now() });
      },
    });
    stream.getReader();

    expect(clientCount()).toBe(1);
  });
});
