#!/usr/bin/env bun
/**
 * Spike Validation Script
 *
 * Automated tests for the dashboard spike (Phase 0) success criteria:
 *   1. Server starts and responds to health checks
 *   2. SSE endpoint streams events to clients
 *   3. POST /api/plugin/event ingests events and broadcasts via SSE
 *   4. Multiple plugin instances can connect without conflicts
 *   5. Server info endpoint reports connected plugins and event counts
 *   6. Server handles invalid input gracefully
 *
 * Prerequisites:
 *   - bun installed
 *   - Server running: bun run server/spike.ts
 *
 * Usage:
 *   bun run server/validate-spike.ts              # test against running server
 *   bun run server/validate-spike.ts --start       # auto-start server, test, then stop
 */

const SERVER_URL =
  process.env.DASHBOARD_URL ||
  `http://localhost:${process.env.DASHBOARD_PORT || "3333"}`;
const HEALTH_URL = `${SERVER_URL}/api/health`;
const EVENTS_URL = `${SERVER_URL}/api/events`;
const EVENT_POST_URL = `${SERVER_URL}/api/plugin/event`;
const INFO_URL = `${SERVER_URL}/api/info`;

// ── Helpers ────────────────────────────────────────────────────────

let passCount = 0;
let failCount = 0;
let skipCount = 0;

function pass(name: string, detail?: string) {
  passCount++;
  console.log(`  ✅ ${name}${detail ? ` — ${detail}` : ""}`);
}

function fail(name: string, detail?: string) {
  failCount++;
  console.log(`  ❌ ${name}${detail ? ` — ${detail}` : ""}`);
}

function skip(name: string, detail?: string) {
  skipCount++;
  console.log(`  ⏭️  ${name}${detail ? ` — ${detail}` : ""}`);
}

function section(name: string) {
  console.log(`\n── ${name} ${"─".repeat(Math.max(0, 60 - name.length))}`);
}

async function fetchJson(url: string, options?: RequestInit): Promise<any> {
  const res = await fetch(url, {
    ...options,
    // Only add a default timeout if the caller didn't provide a signal
    signal: options?.signal ?? AbortSignal.timeout(5000),
  });
  return { status: res.status, body: await res.json() };
}

// ── Auto-start logic ──────────────────────────────────────────────

let serverProc: ReturnType<typeof Bun.spawn> | null = null;
const autoStart = process.argv.includes("--start");

async function isServerRunning(): Promise<boolean> {
  try {
    const res = await fetch(HEALTH_URL, { signal: AbortSignal.timeout(2000) });
    return res.ok;
  } catch {
    return false;
  }
}

async function startServer(): Promise<boolean> {
  const serverPath = new URL("./spike.ts", import.meta.url).pathname;
  console.log(`Starting server: bun run ${serverPath}`);
  serverProc = Bun.spawn(["bun", "run", serverPath], {
    stdio: ["ignore", "pipe", "pipe"],
  });

  // Wait up to 5s for server to come up
  for (let i = 0; i < 10; i++) {
    await Bun.sleep(500);
    if (await isServerRunning()) return true;
  }
  return false;
}

function stopServer() {
  if (serverProc) {
    console.log(`\nStopping server (PID: ${serverProc.pid})...`);
    serverProc.kill();
    serverProc = null;
  }
}

// ── Test: Health Check ────────────────────────────────────────────

async function testHealthCheck() {
  section("Health Check");
  try {
    const { status, body } = await fetchJson(HEALTH_URL);
    if (status === 200 && body.status === "ok") {
      pass("GET /api/health returns 200 with status: ok");
    } else {
      fail("GET /api/health", `status=${status}, body=${JSON.stringify(body)}`);
    }

    if (typeof body.uptime === "number" && body.uptime > 0) {
      pass("Health response includes uptime", `${body.uptime.toFixed(2)}s`);
    } else {
      fail("Health response uptime", `got: ${body.uptime}`);
    }

    if (typeof body.clients === "number") {
      pass("Health response includes client count", `${body.clients}`);
    } else {
      fail("Health response client count missing");
    }

    if (typeof body.plugins === "number") {
      pass("Health response includes plugin count", `${body.plugins}`);
    } else {
      fail("Health response plugin count missing");
    }

    if (typeof body.events === "number") {
      pass("Health response includes event count", `${body.events}`);
    } else {
      fail("Health response event count missing");
    }
  } catch (err) {
    fail("Health check request failed", String(err));
  }
}

// ── Test: CORS Headers ────────────────────────────────────────────

async function testCORS() {
  section("CORS Headers");
  try {
    const res = await fetch(HEALTH_URL, {
      signal: AbortSignal.timeout(5000),
    });
    const cors = res.headers.get("access-control-allow-origin");
    if (cors === "*") {
      pass("CORS Allow-Origin header present", `"${cors}"`);
    } else {
      fail("CORS Allow-Origin", `expected "*", got "${cors}"`);
    }

    // Test preflight
    const preflight = await fetch(HEALTH_URL, {
      method: "OPTIONS",
      signal: AbortSignal.timeout(5000),
    });
    if (preflight.status === 204) {
      pass("OPTIONS preflight returns 204");
    } else {
      fail("OPTIONS preflight", `status=${preflight.status}`);
    }

    const methods = preflight.headers.get("access-control-allow-methods");
    if (methods && methods.includes("POST")) {
      pass("Preflight allows POST method", `"${methods}"`);
    } else {
      fail("Preflight methods", `got "${methods}"`);
    }
  } catch (err) {
    fail("CORS test failed", String(err));
  }
}

// ── Test: Event POST + SSE Broadcast ──────────────────────────────

async function testEventPostAndSSE() {
  section("Event POST + SSE Broadcast");

  // We'll manually connect to SSE, post an event, then verify it arrived
  const receivedEvents: Array<{ event: string; data: string }> = [];
  let sseConnected = false;

  // Connect SSE manually using fetch (not EventSource, which isn't in Bun)
  const sseController = new AbortController();
  const ssePromise = (async () => {
    try {
      const res = await fetch(EVENTS_URL, {
        signal: sseController.signal,
      });
      if (!res.body) return;

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });

        // Parse SSE messages from buffer
        const messages = buffer.split("\n\n");
        buffer = messages.pop() || ""; // Keep incomplete message in buffer

        for (const msg of messages) {
          if (!msg.trim()) continue;

          // Check for the connected event which signals SSE is ready
          if (msg.includes("event: connected")) {
            sseConnected = true;
          }

          // Parse event/data from SSE format
          const lines = msg.split("\n");
          let event = "";
          let data = "";
          for (const line of lines) {
            if (line.startsWith("event: ")) event = line.slice(7);
            if (line.startsWith("data: ")) data = line.slice(6);
          }
          if (event && data) {
            receivedEvents.push({ event, data });
          }
        }
      }
    } catch {
      // AbortError is expected when we cancel
    }
  })();

  // Wait for SSE to connect
  for (let i = 0; i < 20; i++) {
    await Bun.sleep(100);
    if (sseConnected) break;
  }

  if (sseConnected) {
    pass("SSE connection established", "received 'connected' event");
  } else {
    fail("SSE connection", "did not receive 'connected' event within 2s");
    sseController.abort();
    return;
  }

  // Clear events received so far (the connection event)
  const prePostCount = receivedEvents.length;

  // POST a test event
  const testPluginId = `test-${Date.now()}`;
  const testEvent = "test:validation";
  const testData = {
    pluginId: testPluginId,
    projectPath: "/test/validation",
    projectName: "validation",
    message: "Hello from validation script",
    timestamp: Date.now(),
  };

  try {
    const { status, body } = await fetchJson(EVENT_POST_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pluginId: testPluginId,
        event: testEvent,
        data: testData,
      }),
    });

    if (status === 200 && body.ok) {
      pass("POST /api/plugin/event returns 200 with ok:true", `eventCount=${body.eventCount}`);
    } else {
      fail("POST /api/plugin/event", `status=${status}, body=${JSON.stringify(body)}`);
    }

    if (typeof body.clients === "number" && body.clients >= 1) {
      pass("POST response includes SSE client count", `${body.clients} client(s)`);
    } else {
      fail("POST response client count", `got: ${body.clients}`);
    }
  } catch (err) {
    fail("POST /api/plugin/event request failed", String(err));
  }

  // Wait for SSE to deliver the event
  await Bun.sleep(500);

  const newEvents = receivedEvents.slice(prePostCount);
  const matchingEvent = newEvents.find((e) => e.event === testEvent);

  if (matchingEvent) {
    pass("SSE received the POSTed event", `event="${matchingEvent.event}"`);

    try {
      const parsed = JSON.parse(matchingEvent.data);
      if (parsed.message === testData.message) {
        pass("SSE event data matches POSTed data");
      } else {
        fail("SSE event data mismatch", `got message="${parsed.message}"`);
      }

      if (typeof parsed._serverTimestamp === "number") {
        pass("Server enriched event with _serverTimestamp");
      } else {
        fail("Server did not add _serverTimestamp");
      }

      if (typeof parsed._eventCount === "number") {
        pass("Server enriched event with _eventCount");
      } else {
        fail("Server did not add _eventCount");
      }
    } catch (err) {
      fail("Failed to parse SSE event data", String(err));
    }
  } else {
    fail(
      "SSE did not receive the POSTed event",
      `received ${newEvents.length} events after POST: ${JSON.stringify(newEvents.map((e) => e.event))}`
    );
  }

  // Clean up SSE connection
  sseController.abort();
  await ssePromise;
}

// ── Test: Multiple Plugin Instances ───────────────────────────────

async function testMultiplePlugins() {
  section("Multiple Plugin Instances");

  const plugin1Id = `plugin-1-${Date.now()}`;
  const plugin2Id = `plugin-2-${Date.now()}`;

  // Register two simulated plugins
  try {
    await fetchJson(EVENT_POST_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pluginId: plugin1Id,
        event: "plugin:connected",
        data: {
          pluginId: plugin1Id,
          projectPath: "/test/project-a",
          projectName: "project-a",
          timestamp: Date.now(),
        },
      }),
    });

    await fetchJson(EVENT_POST_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        pluginId: plugin2Id,
        event: "plugin:connected",
        data: {
          pluginId: plugin2Id,
          projectPath: "/test/project-b",
          projectName: "project-b",
          timestamp: Date.now(),
        },
      }),
    });

    pass("Two plugin instances registered without conflict");
  } catch (err) {
    fail("Multiple plugin registration", String(err));
    return;
  }

  // Check server info to verify both are tracked
  try {
    const { status, body } = await fetchJson(INFO_URL);
    if (status === 200) {
      pass("GET /api/info returns 200");

      const plugins = body.plugins || [];
      const hasPlugin1 = plugins.some((p: any) => p.id === plugin1Id);
      const hasPlugin2 = plugins.some((p: any) => p.id === plugin2Id);

      if (hasPlugin1 && hasPlugin2) {
        pass("Server tracks both plugin instances", `${plugins.length} total plugin(s)`);
      } else {
        fail(
          "Server plugin tracking",
          `plugin1=${hasPlugin1}, plugin2=${hasPlugin2}, total=${plugins.length}`
        );
      }

      if (typeof body.pid === "number") {
        pass("Server reports its PID", `PID=${body.pid}`);
      } else {
        fail("Server PID missing from info");
      }
    } else {
      fail("GET /api/info", `status=${status}`);
    }
  } catch (err) {
    fail("Server info request failed", String(err));
  }
}

// ── Test: Error Handling ──────────────────────────────────────────

async function testErrorHandling() {
  section("Error Handling");

  // POST with invalid JSON
  try {
    const res = await fetch(EVENT_POST_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "not valid json{{{",
      signal: AbortSignal.timeout(5000),
    });
    if (res.status === 400) {
      pass("Invalid JSON returns 400");
    } else {
      fail("Invalid JSON handling", `expected 400, got ${res.status}`);
    }
  } catch (err) {
    fail("Invalid JSON test failed", String(err));
  }

  // POST with missing event field
  try {
    const { status, body } = await fetchJson(EVENT_POST_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ data: { foo: "bar" } }),
    });
    if (status === 400 && body.error) {
      pass("Missing 'event' field returns 400", body.error);
    } else {
      fail("Missing event field", `status=${status}, body=${JSON.stringify(body)}`);
    }
  } catch (err) {
    fail("Missing event field test failed", String(err));
  }

  // GET unknown route
  try {
    const { status, body } = await fetchJson(`${SERVER_URL}/api/nonexistent`);
    if (status === 404) {
      pass("Unknown route returns 404");
    } else {
      fail("Unknown route", `expected 404, got ${status}`);
    }
  } catch (err) {
    fail("Unknown route test failed", String(err));
  }
}

// ── Test: Server Survives Plugin Disconnect ───────────────────────

async function testServerSurvivesDisconnect() {
  section("Server Resilience");

  // Just verify server is still healthy after all the above tests
  try {
    const { status, body } = await fetchJson(HEALTH_URL);
    if (status === 200 && body.status === "ok") {
      pass("Server still healthy after all tests", `uptime=${body.uptime?.toFixed(2)}s, events=${body.events}`);
    } else {
      fail("Server health after tests", `status=${status}`);
    }
  } catch (err) {
    fail("Server health check after tests", String(err));
  }
}

// ── Test: Plugin File Validation ──────────────────────────────────

async function testPluginFile() {
  section("Plugin File Validation");

  const pluginPath = `${process.env.HOME}/.config/opencode/plugins/dashboard-spike.ts`;

  try {
    const file = Bun.file(pluginPath);
    const exists = await file.exists();
    if (exists) {
      pass("Plugin file exists", pluginPath);
    } else {
      skip("Plugin file not found — install it to validate", pluginPath);
      return;
    }

    const content = await file.text();

    // Check for required export
    if (content.includes("export const DashboardSpike: Plugin")) {
      pass("Plugin exports DashboardSpike as Plugin type");
    } else {
      fail("Plugin missing DashboardSpike export");
    }

    // Check for required import
    if (content.includes('@opencode-ai/plugin')) {
      pass("Plugin imports from @opencode-ai/plugin");
    } else {
      fail("Plugin missing @opencode-ai/plugin import");
    }

    // Check for auto-start logic
    if (content.includes("isServerRunning") && content.includes("spawnServer")) {
      pass("Plugin has auto-start logic (isServerRunning + spawnServer)");
    } else {
      fail("Plugin missing auto-start logic");
    }

    // Check for graceful degradation
    if (content.includes("if (!serverReady) return")) {
      pass("Plugin has graceful degradation guards");
    } else {
      fail("Plugin missing graceful degradation");
    }

    // Check for required hooks
    const hooks = ["event", "tool.execute.after", "chat.message"];
    for (const hook of hooks) {
      if (content.includes(`"${hook}"`)) {
        pass(`Plugin implements "${hook}" hook`);
      } else {
        fail(`Plugin missing "${hook}" hook`);
      }
    }

    // Check for detached spawn
    if (content.includes("detached: true") && content.includes("proc.unref()")) {
      pass("Server spawn is detached and unref'd");
    } else {
      fail("Server spawn not properly detached");
    }

    // Check for timeout on fetch calls
    if (content.includes("AbortSignal.timeout")) {
      pass("Fetch calls use AbortSignal.timeout");
    } else {
      fail("Fetch calls missing timeout");
    }

    // Check for unique plugin ID generation
    if (content.includes("pluginId") && content.includes("Date.now()")) {
      pass("Plugin generates unique instance ID");
    } else {
      fail("Plugin missing unique ID generation");
    }
  } catch (err) {
    fail("Plugin file validation failed", String(err));
  }
}

// ── Main ──────────────────────────────────────────────────────────

async function main() {
  console.log("╔══════════════════════════════════════════════════════════╗");
  console.log("║  Dashboard Spike Validation (Phase 0)                   ║");
  console.log("╚══════════════════════════════════════════════════════════╝");
  console.log(`\nServer URL: ${SERVER_URL}`);

  // Plugin file validation (doesn't need server)
  await testPluginFile();

  // Server tests
  const serverAlreadyRunning = await isServerRunning();

  if (!serverAlreadyRunning && autoStart) {
    console.log("\nServer not running, starting with --start flag...");
    const started = await startServer();
    if (!started) {
      console.log("\n❌ Failed to start server. Aborting server tests.");
      console.log("   Run manually: bun run server/spike.ts");
      printSummary();
      process.exit(1);
    }
    console.log("Server started successfully.\n");
  } else if (!serverAlreadyRunning) {
    console.log("\n⚠️  Server not running. Skipping server tests.");
    console.log("   Start it with: bun run server/spike.ts");
    console.log("   Or run with --start flag: bun run server/validate-spike.ts --start\n");
    skip("All server tests", "server not running");
    printSummary();
    process.exit(0);
  }

  try {
    await testHealthCheck();
    await testCORS();
    await testEventPostAndSSE();
    await testMultiplePlugins();
    await testErrorHandling();
    await testServerSurvivesDisconnect();
  } finally {
    if (autoStart) {
      stopServer();
    }
  }

  printSummary();
  process.exit(failCount > 0 ? 1 : 0);
}

function printSummary() {
  console.log("\n══════════════════════════════════════════════════════════");
  console.log(`  Results: ${passCount} passed, ${failCount} failed, ${skipCount} skipped`);
  if (failCount === 0 && skipCount === 0) {
    console.log("  🎉 All tests passed!");
  } else if (failCount === 0) {
    console.log("  ⚠️  All run tests passed (some skipped)");
  } else {
    console.log("  💥 Some tests failed");
  }
  console.log("══════════════════════════════════════════════════════════\n");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  stopServer();
  process.exit(1);
});
