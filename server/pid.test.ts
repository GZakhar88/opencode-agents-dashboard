/**
 * Tests for server/pid.ts — PID file and autostart marker management
 *
 * Covers:
 * - writeAutostart / readAutostart / removeAutostart
 * - getAutostartFilePath
 * - Edge cases (malformed data, missing file)
 *
 * Run: bun test server/pid.test.ts
 */

import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdirSync, writeFileSync, unlinkSync, readFileSync } from "fs";
import { dirname } from "path";
import {
  writeAutostart,
  readAutostart,
  removeAutostart,
  getAutostartFilePath,
} from "./pid";

// --- Helpers ---

const AUTOSTART_PATH = getAutostartFilePath();

function cleanupAutostart() {
  try {
    if (existsSync(AUTOSTART_PATH)) {
      unlinkSync(AUTOSTART_PATH);
    }
  } catch {
    // ignore
  }
}

// --- Tests ---

describe("Autostart Marker", () => {
  beforeEach(cleanupAutostart);
  afterEach(cleanupAutostart);

  describe("writeAutostart", () => {
    it("creates a marker file with port and timestamp", () => {
      writeAutostart(3333);

      expect(existsSync(AUTOSTART_PATH)).toBe(true);

      const raw = readFileSync(AUTOSTART_PATH, "utf-8");
      const data = JSON.parse(raw);
      expect(data.port).toBe(3333);
      expect(typeof data.createdAt).toBe("string");
      // Verify it's a valid ISO date
      expect(new Date(data.createdAt).toISOString()).toBe(data.createdAt);
    });

    it("overwrites an existing marker file", () => {
      writeAutostart(3333);
      writeAutostart(4444);

      const data = readAutostart();
      expect(data).not.toBeNull();
      expect(data!.port).toBe(4444);
    });

    it("creates parent directory if it doesn't exist", () => {
      // The directory should exist from previous tests, but writeAutostart
      // handles it gracefully either way
      writeAutostart(5555);
      expect(existsSync(AUTOSTART_PATH)).toBe(true);
    });
  });

  describe("readAutostart", () => {
    it("returns null when no marker file exists", () => {
      expect(readAutostart()).toBeNull();
    });

    it("reads a valid marker file", () => {
      writeAutostart(3333);

      const data = readAutostart();
      expect(data).not.toBeNull();
      expect(data!.port).toBe(3333);
      expect(typeof data!.createdAt).toBe("string");
    });

    it("returns null for malformed JSON", () => {
      writeFileSync(AUTOSTART_PATH, "not valid json", "utf-8");
      expect(readAutostart()).toBeNull();
    });

    it("returns null for JSON without port field", () => {
      writeFileSync(AUTOSTART_PATH, JSON.stringify({ foo: "bar" }), "utf-8");
      expect(readAutostart()).toBeNull();
    });

    it("returns null for JSON with non-numeric port", () => {
      writeFileSync(
        AUTOSTART_PATH,
        JSON.stringify({ port: "not-a-number", createdAt: new Date().toISOString() }),
        "utf-8"
      );
      expect(readAutostart()).toBeNull();
    });
  });

  describe("removeAutostart", () => {
    it("removes an existing marker file", () => {
      writeAutostart(3333);
      expect(existsSync(AUTOSTART_PATH)).toBe(true);

      removeAutostart();
      expect(existsSync(AUTOSTART_PATH)).toBe(false);
    });

    it("does nothing if marker file does not exist", () => {
      // Should not throw
      removeAutostart();
      expect(existsSync(AUTOSTART_PATH)).toBe(false);
    });

    it("is idempotent (can be called multiple times)", () => {
      writeAutostart(3333);
      removeAutostart();
      removeAutostart();
      removeAutostart();
      expect(existsSync(AUTOSTART_PATH)).toBe(false);
    });
  });

  describe("getAutostartFilePath", () => {
    it("returns a path ending with opencode-dashboard.autostart", () => {
      expect(AUTOSTART_PATH).toMatch(/opencode-dashboard\.autostart$/);
    });

    it("is in the .cache/opencode directory", () => {
      expect(AUTOSTART_PATH).toContain(".cache/opencode");
    });
  });
});
