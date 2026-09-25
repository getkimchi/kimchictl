import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanupTempDirs, makeTempDir, stubAgentDirEnv, writeSharedConfigJson } from "../test-support.js"
import { requireApiKey, resolveApiKey } from "./resolve.js"

afterEach(() => {
	cleanupTempDirs()
	vi.unstubAllEnvs()
})

describe("resolveApiKey precedence", () => {
	it("prefers KIMCHI_API_KEY over both files", () => {
		const dir = makeTempDir()
		const { home } = stubAgentDirEnv(dir)
		vi.stubEnv("KIMCHI_API_KEY", "env-key")
		writeSharedConfigJson(home, { apiKey: "config-key" })
		writeFileSync(join(dir, "auth.json"), JSON.stringify({ "kimchi-dev": { type: "api_key", key: "auth-key" } }))

		expect(resolveApiKey()).toEqual({ key: "env-key", source: "environment" })
	})

	it("falls back to config.json, then auth.json", () => {
		const dir = makeTempDir()
		const { home } = stubAgentDirEnv(dir)
		writeSharedConfigJson(home, { apiKey: "config-key" })
		writeFileSync(join(dir, "auth.json"), JSON.stringify({ "kimchi-dev": { type: "api_key", key: "auth-key" } }))

		expect(resolveApiKey()).toEqual({ key: "config-key", source: "config" })
	})

	it("uses auth.json when no config key exists", () => {
		const dir = makeTempDir()
		stubAgentDirEnv(dir)
		writeFileSync(join(dir, "auth.json"), JSON.stringify({ "kimchi-dev": { type: "api_key", key: "auth-key" } }))

		expect(resolveApiKey()).toEqual({ key: "auth-key", source: "auth-json" })
	})

	it("returns undefined when nothing is stored", () => {
		stubAgentDirEnv(makeTempDir())
		expect(resolveApiKey()).toBeUndefined()
	})
})

describe("requireApiKey", () => {
	it("throws the standard not-logged-in error", () => {
		stubAgentDirEnv(makeTempDir())
		expect(() => requireApiKey()).toThrowError(/Not logged in/)
	})
})

describe("default layout (no env overrides) — regression: the real harness paths", () => {
	// These pin the fix for "harness is logged in but kimchictl says Not logged
	// in": with no env vars at all, credentials must be found at the harness's
	// real locations, not a guessed directory.
	it("resolves auth.json from ~/.config/kimchi/harness", () => {
		const home = makeTempDir()
		const agentDir = join(home, ".config", "kimchi", "harness")
		mkdirSync(agentDir, { recursive: true })
		writeFileSync(join(agentDir, "auth.json"), JSON.stringify({ "kimchi-dev": { type: "api_key", key: "auth-key" } }))

		expect(resolveApiKey({ HOME: home })).toEqual({ key: "auth-key", source: "auth-json" })
	})

	it("resolves the apiKey from ~/.config/kimchi/config.json (sibling of the agent dir)", () => {
		const home = makeTempDir()
		writeSharedConfigJson(home, { apiKey: "config-key" })

		expect(resolveApiKey({ HOME: home })).toEqual({ key: "config-key", source: "config" })
	})
})
