import { readFileSync, statSync, utimesSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanupTempDirs, makeTempDir } from "../test-support.js"
import {
	clearSharedAuth,
	kimchiProviderIdsFromModelsJson,
	readAuthJson,
	readSavedApiKey,
	syncSharedAuth,
} from "./auth-file.js"

// These tests mirror the fixtures in kimchi-dev:src/pi-auth.test.ts — the
// auth.json byte format is a cross-tool contract: the harness must be able to
// read what kimchictl writes and vice versa.

afterEach(() => {
	cleanupTempDirs()
	vi.unstubAllEnvs()
})

describe("syncSharedAuth", () => {
	it("creates auth.json on first run with the base provider", async () => {
		const dir = makeTempDir()
		const authPath = join(dir, "auth.json")

		await syncSharedAuth(authPath, "kimchi-key", [])

		expect(JSON.parse(readFileSync(authPath, "utf-8"))).toEqual({
			"kimchi-dev": { type: "api_key", key: "kimchi-key" },
		})
	})

	it("stores the key for every supplied Kimchi provider id and preserves other providers", async () => {
		const dir = makeTempDir()
		const authPath = join(dir, "auth.json")
		writeFileSync(
			authPath,
			JSON.stringify({
				anthropic: { type: "api_key", key: "keep-me" },
				"kimchi-experimental": { type: "api_key", key: "old-kimchi-key" },
			}),
		)

		await syncSharedAuth(authPath, "kimchi-key", ["kimchi-dev/openai", "kimchi-experimental"])

		expect(JSON.parse(readFileSync(authPath, "utf-8"))).toEqual({
			anthropic: { type: "api_key", key: "keep-me" },
			"kimchi-dev": { type: "api_key", key: "kimchi-key" },
			"kimchi-dev/openai": { type: "api_key", key: "kimchi-key" },
			"kimchi-experimental": { type: "api_key", key: "kimchi-key" },
		})
		expect(statSync(authPath).mode & 0o777).toBe(0o600)
	})

	it("ignores non-Kimchi ids in the provider list (defense in depth)", async () => {
		const dir = makeTempDir()
		const authPath = join(dir, "auth.json")

		await syncSharedAuth(authPath, "kimchi-key", ["ollama"])

		expect(JSON.parse(readFileSync(authPath, "utf-8"))).toEqual({
			"kimchi-dev": { type: "api_key", key: "kimchi-key" },
		})
	})

	it("removes stale Kimchi credentials when the key is cleared", async () => {
		const dir = makeTempDir()
		const authPath = join(dir, "auth.json")
		writeFileSync(
			authPath,
			JSON.stringify({
				"kimchi-dev": { type: "api_key", key: "old" },
				"kimchi-experimental": { type: "api_key", key: "old" },
				ollama: { type: "api_key", key: "keep" },
			}),
		)

		await syncSharedAuth(authPath, "", [])

		expect(JSON.parse(readFileSync(authPath, "utf-8"))).toEqual({
			ollama: { type: "api_key", key: "keep" },
		})
	})

	it("does not rewrite unchanged storage (mtime preserved), only re-chmod", async () => {
		const dir = makeTempDir()
		const authPath = join(dir, "auth.json")
		const originalAuth = JSON.stringify({
			anthropic: { type: "api_key", key: "keep-me" },
			"kimchi-dev": { type: "api_key", key: "kimchi-key" },
		})
		writeFileSync(authPath, originalAuth)
		const fixedTime = new Date("2000-01-01T00:00:00.000Z")
		utimesSync(authPath, fixedTime, fixedTime)
		const originalMtime = statSync(authPath).mtimeMs

		await syncSharedAuth(authPath, "kimchi-key", [])

		expect(readFileSync(authPath, "utf-8")).toBe(originalAuth)
		expect(statSync(authPath).mtimeMs).toBe(originalMtime)
		expect(statSync(authPath).mode & 0o777).toBe(0o600)
	})
})

describe("clearSharedAuth", () => {
	it("removes every Kimchi credential, keeps other providers, needs no models.json", async () => {
		const dir = makeTempDir()
		const authPath = join(dir, "auth.json")
		writeFileSync(
			authPath,
			JSON.stringify({
				"kimchi-dev": { type: "api_key", key: "old" },
				"kimchi-dev/anthropic": { type: "api_key", key: "old" },
				"kimchi-experimental": { type: "api_key", key: "old" },
				anthropic: { type: "api_key", key: "keep" },
			}),
		)

		await clearSharedAuth(authPath)

		expect(JSON.parse(readFileSync(authPath, "utf-8"))).toEqual({
			anthropic: { type: "api_key", key: "keep" },
		})
	})

	it("is a no-op when auth.json does not exist", async () => {
		const dir = makeTempDir()
		await expect(clearSharedAuth(join(dir, "auth.json"))).resolves.toBeUndefined()
	})
})

describe("readSavedApiKey / readAuthJson", () => {
	it("reads the kimchi-dev key", () => {
		const dir = makeTempDir()
		const authPath = join(dir, "auth.json")
		writeFileSync(authPath, JSON.stringify({ "kimchi-dev": { type: "api_key", key: "abc" } }))
		expect(readSavedApiKey(authPath)).toBe("abc")
	})

	it("returns undefined for missing file / missing entry / empty key", () => {
		const dir = makeTempDir()
		expect(readSavedApiKey(join(dir, "nope.json"))).toBeUndefined()
		const authPath = join(dir, "auth.json")
		writeFileSync(authPath, JSON.stringify({ "kimchi-dev": { type: "api_key", key: "" } }))
		expect(readSavedApiKey(authPath)).toBeUndefined()
		expect(readAuthJson(join(dir, "nope.json"))).toEqual({})
	})
})

describe("kimchiProviderIdsFromModelsJson", () => {
	it("returns Kimchi provider ids only", () => {
		const dir = makeTempDir()
		const modelsPath = join(dir, "models.json")
		writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: { "kimchi-dev": {}, "kimchi-dev/openai": {}, "kimchi-experimental": {}, ollama: {} },
			}),
		)
		expect(new Set(kimchiProviderIdsFromModelsJson(modelsPath))).toEqual(
			new Set(["kimchi-dev", "kimchi-dev/openai", "kimchi-experimental"]),
		)
	})

	it("tolerates missing/corrupt/unexpected models.json", () => {
		const dir = makeTempDir()
		expect(kimchiProviderIdsFromModelsJson(join(dir, "absent.json"))).toEqual([])
		const corrupt = join(dir, "corrupt.json")
		writeFileSync(corrupt, "{ not json")
		expect(kimchiProviderIdsFromModelsJson(corrupt)).toEqual([])
		const noProviders = join(dir, "empty.json")
		writeFileSync(noProviders, JSON.stringify({ something: 1 }))
		expect(kimchiProviderIdsFromModelsJson(noProviders)).toEqual([])
	})
})
