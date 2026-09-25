import { writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanupTempDirs, makeTempDir, stubAgentDirEnv } from "../test-support.js"
import { requireApiKey, resolveApiKey } from "./resolve.js"

afterEach(() => {
	cleanupTempDirs()
	vi.unstubAllEnvs()
})

describe("resolveApiKey precedence", () => {
	it("prefers KIMCHI_API_KEY over both files", () => {
		const dir = makeTempDir()
		stubAgentDirEnv(dir)
		vi.stubEnv("KIMCHI_API_KEY", "env-key")
		writeFileSync(join(dir, "config.json"), JSON.stringify({ apiKey: "config-key" }))
		writeFileSync(join(dir, "auth.json"), JSON.stringify({ "kimchi-dev": { type: "api_key", key: "auth-key" } }))

		expect(resolveApiKey()).toEqual({ key: "env-key", source: "environment" })
	})

	it("falls back to config.json, then auth.json", () => {
		const dir = makeTempDir()
		stubAgentDirEnv(dir)
		writeFileSync(join(dir, "config.json"), JSON.stringify({ apiKey: "config-key" }))
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
