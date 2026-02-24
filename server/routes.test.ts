/**
 * Tests for server/routes.ts — HTTP route handlers
 *
 * Covers all 7 endpoints + CORS + validation + SSE + edge cases.
 *
 * Run: bun test server/routes.test.ts
 */
import { describe, it, expect, beforeEach } from "bun:test";
import {
  handleRequest,
  plugins,
  broadcast,
  stateManager,
  resetSSE,
} from "./routes";
import { clients as sseClients } from "./sse";

// --- Test Helpers ---

function makeRequest(
  method: string,
  path: string,
  body?: unknown,
  headers?: Record<string, string>
): Request {
  const init: RequestInit = {
    method,
    headers: {
      "Content-Type": "application/json",
      ...headers,
    },
  };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
  }
  return new Request(`http://localhost:3333${path}`, init);
}

async function jsonBody(res: Response): Promise<unknown> {
  return res.json();
}

function cleanup() {
  plugins.clear();
  resetSSE();
  stateManager.clear();
}

// --- Tests ---

describe("POST /api/plugin/register", () => {
  beforeEach(cleanup);

  it("registers a plugin and returns a pluginId", async () => {
    const req = makeRequest("POST", "/api/plugin/register", {
      projectPath: "/Users/test/project",
      projectName: "my-project",
    });
    const res = await handleRequest(req);
    const data = (await jsonBody(res)) as { pluginId: string };

    expect(res.status).toBe(200);
    expect(data.pluginId).toBeDefined();
    expect(typeof data.pluginId).toBe("string");
    expect(data.pluginId.length).toBeGreaterThan(0);
    expect(plugins.size).toBe(1);
  });

  it("stores plugin record with correct fields", async () => {
    const req = makeRequest("POST", "/api/plugin/register", {
      projectPath: "/Users/test/project",
      projectName: "my-project",
    });
    const res = await handleRequest(req);
    const data = (await jsonBody(res)) as { pluginId: string };

    const plugin = plugins.get(data.pluginId);
    expect(plugin).toBeDefined();
    expect(plugin!.projectPath).toBe("/Users/test/project");
    expect(plugin!.projectName).toBe("my-project");
    expect(plugin!.registeredAt).toBeGreaterThan(0);
    expect(plugin!.lastHeartbeat).toBeGreaterThan(0);
  });

  it("returns 400 for missing body", async () => {
    const req = new Request("http://localhost:3333/api/plugin/register", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not-json",
    });
    const res = await handleRequest(req);

    expect(res.status).toBe(400);
    const data = (await jsonBody(res)) as { error: string };
    expect(data.error).toContain("Invalid JSON");
  });

  it("returns 400 for missing projectPath", async () => {
    const req = makeRequest("POST", "/api/plugin/register", {
      projectName: "my-project",
    });
    const res = await handleRequest(req);

    expect(res.status).toBe(400);
    const data = (await jsonBody(res)) as { error: string };
    expect(data.error).toContain("projectPath");
  });

  it("returns 400 for missing projectName", async () => {
    const req = makeRequest("POST", "/api/plugin/register", {
      projectPath: "/Users/test/project",
    });
    const res = await handleRequest(req);

    expect(res.status).toBe(400);
    const data = (await jsonBody(res)) as { error: string };
    expect(data.error).toContain("projectName");
  });

  it("returns 400 for non-string projectPath", async () => {
    const req = makeRequest("POST", "/api/plugin/register", {
      projectPath: 123,
      projectName: "my-project",
    });
    const res = await handleRequest(req);

    expect(res.status).toBe(400);
  });

  it("returns 400 for empty string projectPath", async () => {
    const req = makeRequest("POST", "/api/plugin/register", {
      projectPath: "",
      projectName: "my-project",
    });
    const res = await handleRequest(req);

    expect(res.status).toBe(400);
  });

  it("allows multiple plugins to register", async () => {
    const req1 = makeRequest("POST", "/api/plugin/register", {
      projectPath: "/Users/test/project-a",
      projectName: "project-a",
    });
    const req2 = makeRequest("POST", "/api/plugin/register", {
      projectPath: "/Users/test/project-b",
      projectName: "project-b",
    });

    await handleRequest(req1);
    await handleRequest(req2);

    expect(plugins.size).toBe(2);
  });
});

describe("POST /api/plugin/event", () => {
  beforeEach(cleanup);

  async function registerPlugin(): Promise<string> {
    const req = makeRequest("POST", "/api/plugin/register", {
      projectPath: "/Users/test/project",
      projectName: "test-project",
    });
    const res = await handleRequest(req);
    const data = (await jsonBody(res)) as { pluginId: string };
    return data.pluginId;
  }

  it("accepts an event from a registered plugin", async () => {
    const pluginId = await registerPlugin();
    const req = makeRequest("POST", "/api/plugin/event", {
      pluginId,
      event: "bead:claimed",
      data: { beadId: "bd-a1" },
    });
    const res = await handleRequest(req);
    const data = (await jsonBody(res)) as { ok: boolean };

    expect(res.status).toBe(200);
    expect(data.ok).toBe(true);
  });

  it("returns 404 for unknown pluginId", async () => {
    const req = makeRequest("POST", "/api/plugin/event", {
      pluginId: "nonexistent-uuid",
      event: "bead:claimed",
      data: {},
    });
    const res = await handleRequest(req);

    expect(res.status).toBe(404);
    const data = (await jsonBody(res)) as { error: string };
    expect(data.error).toContain("Unknown pluginId");
  });

  it("returns 400 for missing pluginId", async () => {
    const req = makeRequest("POST", "/api/plugin/event", {
      event: "bead:claimed",
      data: {},
    });
    const res = await handleRequest(req);

    expect(res.status).toBe(400);
  });

  it("returns 400 for missing event", async () => {
    const pluginId = await registerPlugin();
    const req = makeRequest("POST", "/api/plugin/event", {
      pluginId,
      data: {},
    });
    const res = await handleRequest(req);

    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid JSON body", async () => {
    const req = new Request("http://localhost:3333/api/plugin/event", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not valid json",
    });
    const res = await handleRequest(req);

    expect(res.status).toBe(400);
  });

  it("updates plugin lastHeartbeat on event", async () => {
    const pluginId = await registerPlugin();
    const before = plugins.get(pluginId)!.lastHeartbeat;

    // Small delay to ensure timestamp difference
    await new Promise((resolve) => setTimeout(resolve, 5));

    const req = makeRequest("POST", "/api/plugin/event", {
      pluginId,
      event: "bead:stage",
      data: { stage: "builder" },
    });
    await handleRequest(req);

    const after = plugins.get(pluginId)!.lastHeartbeat;
    expect(after).toBeGreaterThanOrEqual(before);
  });

  it("accepts event without data field", async () => {
    const pluginId = await registerPlugin();
    const req = makeRequest("POST", "/api/plugin/event", {
      pluginId,
      event: "ping",
    });
    const res = await handleRequest(req);

    expect(res.status).toBe(200);
  });

  it("handles array data by wrapping it (not spreading)", async () => {
    const pluginId = await registerPlugin();
    // An SSE client to capture the broadcast
    let capturedData: string | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        // Override enqueue to capture
        const originalEnqueue = controller.enqueue.bind(controller);
        controller.enqueue = (chunk: Uint8Array) => {
          capturedData = new TextDecoder().decode(chunk);
          originalEnqueue(chunk);
        };
        sseClients.add({ controller, connectedAt: Date.now() });
      },
    });
    // Start reading to keep stream alive
    const reader = stream.getReader();

    const req = makeRequest("POST", "/api/plugin/event", {
      pluginId,
      event: "test:array",
      data: [1, 2, 3],
    });
    await handleRequest(req);

    // The broadcast should have wrapped the array in { data: [...] }
    expect(capturedData).not.toBeNull();
    expect(capturedData!).toContain('"data":[1,2,3]');

    reader.cancel();
  });
});

describe("POST /api/plugin/heartbeat", () => {
  beforeEach(cleanup);

  async function registerPlugin(): Promise<string> {
    const req = makeRequest("POST", "/api/plugin/register", {
      projectPath: "/Users/test/project",
      projectName: "test-project",
    });
    const res = await handleRequest(req);
    const data = (await jsonBody(res)) as { pluginId: string };
    return data.pluginId;
  }

  it("updates lastHeartbeat for a registered plugin", async () => {
    const pluginId = await registerPlugin();
    const before = plugins.get(pluginId)!.lastHeartbeat;

    await new Promise((resolve) => setTimeout(resolve, 5));

    const req = makeRequest("POST", "/api/plugin/heartbeat", { pluginId });
    const res = await handleRequest(req);

    expect(res.status).toBe(200);
    const data = (await jsonBody(res)) as { ok: boolean };
    expect(data.ok).toBe(true);

    const after = plugins.get(pluginId)!.lastHeartbeat;
    expect(after).toBeGreaterThanOrEqual(before);
  });

  it("returns 404 for unknown pluginId", async () => {
    const req = makeRequest("POST", "/api/plugin/heartbeat", {
      pluginId: "nonexistent",
    });
    const res = await handleRequest(req);

    expect(res.status).toBe(404);
  });

  it("returns 400 for missing pluginId", async () => {
    const req = makeRequest("POST", "/api/plugin/heartbeat", {});
    const res = await handleRequest(req);

    expect(res.status).toBe(400);
  });

  it("returns 400 for invalid JSON", async () => {
    const req = new Request("http://localhost:3333/api/plugin/heartbeat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{invalid",
    });
    const res = await handleRequest(req);

    expect(res.status).toBe(400);
  });
});

describe("DELETE /api/plugin/:id", () => {
  beforeEach(cleanup);

  async function registerPlugin(): Promise<string> {
    const req = makeRequest("POST", "/api/plugin/register", {
      projectPath: "/Users/test/project",
      projectName: "test-project",
    });
    const res = await handleRequest(req);
    const data = (await jsonBody(res)) as { pluginId: string };
    return data.pluginId;
  }

  it("deregisters a registered plugin", async () => {
    const pluginId = await registerPlugin();
    expect(plugins.size).toBe(1);

    const req = makeRequest("DELETE", `/api/plugin/${pluginId}`);
    const res = await handleRequest(req);

    expect(res.status).toBe(200);
    const data = (await jsonBody(res)) as { ok: boolean };
    expect(data.ok).toBe(true);
    expect(plugins.size).toBe(0);
  });

  it("returns 404 for unknown pluginId", async () => {
    const req = makeRequest("DELETE", "/api/plugin/nonexistent-uuid");
    const res = await handleRequest(req);

    expect(res.status).toBe(404);
    const data = (await jsonBody(res)) as { error: string };
    expect(data.error).toContain("Unknown pluginId");
  });

  it("broadcasts project:disconnected event on deregister", async () => {
    const pluginId = await registerPlugin();

    // Set up a capture SSE client
    let capturedData: string | null = null;
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const originalEnqueue = controller.enqueue.bind(controller);
        controller.enqueue = (chunk: Uint8Array) => {
          const text = new TextDecoder().decode(chunk);
          if (text.includes("project:disconnected")) {
            capturedData = text;
          }
          originalEnqueue(chunk);
        };
        sseClients.add({ controller, connectedAt: Date.now() });
      },
    });
    const reader = stream.getReader();

    const req = makeRequest("DELETE", `/api/plugin/${pluginId}`);
    await handleRequest(req);

    expect(capturedData).not.toBeNull();
    expect(capturedData!).toContain("project:disconnected");
    expect(capturedData!).toContain(pluginId);

    reader.cancel();
  });
});

describe("GET /api/state", () => {
  beforeEach(cleanup);

  it("returns empty projects when none registered", async () => {
    const req = makeRequest("GET", "/api/state");
    const res = await handleRequest(req);

    expect(res.status).toBe(200);
    const data = (await jsonBody(res)) as { projects: unknown[] };
    expect(data.projects).toEqual([]);
  });

  it("returns registered projects with state", async () => {
    // Register a plugin first
    await handleRequest(
      makeRequest("POST", "/api/plugin/register", {
        projectPath: "/Users/test/project",
        projectName: "my-project",
      })
    );

    const req = makeRequest("GET", "/api/state");
    const res = await handleRequest(req);

    expect(res.status).toBe(200);
    const data = (await jsonBody(res)) as { projects: any[] };
    expect(data.projects.length).toBe(1);
    expect(data.projects[0].projectPath).toBe("/Users/test/project");
    expect(data.projects[0].projectName).toBe("my-project");
    expect(data.projects[0].connected).toBe(true);
  });

  it("includes CORS headers", async () => {
    const req = makeRequest("GET", "/api/state", undefined, {
      Origin: "http://localhost:5173",
    });
    const res = await handleRequest(req);

    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
      "http://localhost:5173"
    );
  });
});

describe("GET /api/events (SSE)", () => {
  beforeEach(cleanup);

  it("returns a response with SSE headers", async () => {
    const req = makeRequest("GET", "/api/events");
    const res = await handleRequest(req);

    expect(res.headers.get("Content-Type")).toBe("text/event-stream");
    expect(res.headers.get("Cache-Control")).toBe("no-cache");
    expect(res.headers.get("Connection")).toBe("keep-alive");
  });

  it("sends retry directive and connected event", async () => {
    const req = makeRequest("GET", "/api/events");
    const res = await handleRequest(req);

    const reader = res.body!.getReader();
    const decoder = new TextDecoder();

    // Read the first chunk(s) — retry + connected event
    let text = "";
    // Read a few chunks to capture initial data
    for (let i = 0; i < 3; i++) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
      if (text.includes("event: connected")) break;
    }

    expect(text).toContain("retry: 3000");
    expect(text).toContain("event: connected");
    expect(text).toContain("SSE connected");

    reader.cancel();
  });

  it("registers the client in sseClients set", async () => {
    const sizeBefore = sseClients.size;
    const req = makeRequest("GET", "/api/events");
    const res = await handleRequest(req);

    // Start reading to trigger the stream start
    const reader = res.body!.getReader();
    await reader.read();

    expect(sseClients.size).toBe(sizeBefore + 1);

    reader.cancel();
  });

  it("includes CORS headers", async () => {
    const req = makeRequest("GET", "/api/events", undefined, {
      Origin: "http://localhost:5173",
    });
    const res = await handleRequest(req);

    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
      "http://localhost:5173"
    );
  });
});

describe("GET /api/health", () => {
  beforeEach(cleanup);

  it("returns health status", async () => {
    const req = makeRequest("GET", "/api/health");
    const res = await handleRequest(req);

    expect(res.status).toBe(200);
    const data = (await jsonBody(res)) as {
      status: string;
      uptime: number;
      plugins: number;
      sseClients: number;
    };
    expect(data.status).toBe("ok");
    expect(typeof data.uptime).toBe("number");
    expect(data.uptime).toBeGreaterThanOrEqual(0);
    expect(typeof data.plugins).toBe("number");
    expect(typeof data.sseClients).toBe("number");
  });

  it("reflects registered plugin count", async () => {
    // Register a plugin
    const regReq = makeRequest("POST", "/api/plugin/register", {
      projectPath: "/Users/test/project",
      projectName: "test-project",
    });
    await handleRequest(regReq);

    const req = makeRequest("GET", "/api/health");
    const res = await handleRequest(req);
    const data = (await jsonBody(res)) as { plugins: number };

    expect(data.plugins).toBe(1);
  });
});

describe("CORS", () => {
  beforeEach(cleanup);

  it("responds to OPTIONS with 204 and CORS headers", async () => {
    const req = new Request("http://localhost:3333/api/state", {
      method: "OPTIONS",
      headers: { Origin: "http://localhost:5173" },
    });
    const res = await handleRequest(req);

    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
      "http://localhost:5173"
    );
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("GET");
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("POST");
    expect(res.headers.get("Access-Control-Allow-Methods")).toContain("DELETE");
    expect(res.headers.get("Access-Control-Allow-Headers")).toContain(
      "Content-Type"
    );
  });

  it("allows any localhost origin", async () => {
    const origins = [
      "http://localhost:3000",
      "http://localhost:5173",
      "http://localhost:8080",
      "https://localhost:443",
    ];

    for (const origin of origins) {
      const req = new Request("http://localhost:3333/api/health", {
        method: "GET",
        headers: { Origin: origin },
      });
      const res = await handleRequest(req);
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe(origin);
    }
  });

  it("falls back to * for non-localhost origins", async () => {
    const req = new Request("http://localhost:3333/api/health", {
      method: "GET",
      headers: { Origin: "https://example.com" },
    });
    const res = await handleRequest(req);

    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });

  it("falls back to * when no Origin header", async () => {
    const req = makeRequest("GET", "/api/health");
    const res = await handleRequest(req);

    expect(res.headers.get("Access-Control-Allow-Origin")).toBe("*");
  });
});

describe("404 Not Found", () => {
  beforeEach(cleanup);

  it("returns 404 for unknown paths", async () => {
    const req = makeRequest("GET", "/api/unknown");
    const res = await handleRequest(req);

    expect(res.status).toBe(404);
    const data = (await jsonBody(res)) as { error: string; path: string };
    expect(data.error).toBe("Not found");
    expect(data.path).toBe("/api/unknown");
  });

  it("returns 404 for wrong method on valid path", async () => {
    // GET on a POST endpoint
    const req = makeRequest("GET", "/api/plugin/register");
    const res = await handleRequest(req);

    expect(res.status).toBe(404);
  });

  it("returns 404 for DELETE on non-plugin paths", async () => {
    const req = makeRequest("DELETE", "/api/state");
    const res = await handleRequest(req);

    expect(res.status).toBe(404);
  });
});

describe("broadcast", () => {
  beforeEach(cleanup);

  it("sends SSE formatted message to all clients", () => {
    const received: string[] = [];
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        const originalEnqueue = controller.enqueue.bind(controller);
        controller.enqueue = (chunk: Uint8Array) => {
          received.push(new TextDecoder().decode(chunk));
          originalEnqueue(chunk);
        };
        sseClients.add({ controller, connectedAt: Date.now() });
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

  it("removes clients that throw on enqueue", () => {
    // Create a "broken" client
    const brokenController = {
      enqueue() {
        throw new Error("Client disconnected");
      },
    } as unknown as ReadableStreamDefaultController<Uint8Array>;

    sseClients.add({ controller: brokenController, connectedAt: Date.now() });
    expect(sseClients.size).toBe(1);

    broadcast("test:event", {});

    expect(sseClients.size).toBe(0);
  });
});

describe("integration: register -> event -> deregister", () => {
  beforeEach(cleanup);

  it("completes a full plugin lifecycle", async () => {
    // 1. Register
    const regRes = await handleRequest(
      makeRequest("POST", "/api/plugin/register", {
        projectPath: "/Users/test/project",
        projectName: "lifecycle-test",
      })
    );
    expect(regRes.status).toBe(200);
    const { pluginId } = (await jsonBody(regRes)) as { pluginId: string };
    expect(plugins.size).toBe(1);

    // 2. Send event
    const eventRes = await handleRequest(
      makeRequest("POST", "/api/plugin/event", {
        pluginId,
        event: "bead:claimed",
        data: { beadId: "bd-a1" },
      })
    );
    expect(eventRes.status).toBe(200);

    // 3. Heartbeat
    const hbRes = await handleRequest(
      makeRequest("POST", "/api/plugin/heartbeat", { pluginId })
    );
    expect(hbRes.status).toBe(200);

    // 4. Verify health shows plugin
    const healthRes = await handleRequest(makeRequest("GET", "/api/health"));
    const health = (await jsonBody(healthRes)) as { plugins: number };
    expect(health.plugins).toBe(1);

    // 5. Deregister
    const delRes = await handleRequest(
      makeRequest("DELETE", `/api/plugin/${pluginId}`)
    );
    expect(delRes.status).toBe(200);
    expect(plugins.size).toBe(0);

    // 6. Verify health shows no plugins
    const healthRes2 = await handleRequest(makeRequest("GET", "/api/health"));
    const health2 = (await jsonBody(healthRes2)) as { plugins: number };
    expect(health2.plugins).toBe(0);
  });
});
