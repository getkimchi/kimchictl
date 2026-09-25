import { readFileSync, statSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { cleanupTempDirs, makeTempDir } from "../test-support.js"
import { readApiKeyFromConfig, writeApiKeyToConfig } from "./config-file.js"

afterEach(() => {
	cleanupTempDirs()
})

describe("writeApiKeyToConfig", () => {
	it("creates config.json with the key, mode 0600", () => {
		const configPath = join(makeTempDir(), "config.json")

		writeApiKeyToConfig(configPath, "new-key")

		expect(JSON.parse(readFileSync(configPath, "utf-8"))).toEqual({ apiKey: "new-key" })
		expect(statSync(configPath).mode & 0o777).toBe(0o600)
	})

	it("preserves unrelated fields when setting and clearing the key", () => {
		const configPath = join(makeTempDir(), "config.json")
		writeFileSync(configPath, JSON.stringify({ telemetry: { enabled: false }, apiKey: "old", other: 1 }))

		writeApiKeyToConfig(configPath, "new-key")
		expect(JSON.parse(readFileSync(configPath, "utf-8"))).toEqual({
			telemetry: { enabled: false },
			apiKey: "new-key",
			other: 1,
		})

		writeApiKeyToConfig(configPath, undefined)
		expect(JSON.parse(readFileSync(configPath, "utf-8"))).toEqual({
			telemetry: { enabled: false },
			other: 1,
		})
	})

	it("is a no-op clearing a key that is not there (including a missing file)", () => {
		const configPath = join(makeTempDir(), "config.json")
		writeApiKeyToConfig(configPath, undefined)
		expect(() => statSync(configPath)).toThrow()
	})
})

describe("readApiKeyFromConfig", () => {
	it("reads camelCase and legacy snake_case spellings", () => {
		const dir = makeTempDir()
		const camel = join(dir, "c1.json")
		writeFileSync(camel, JSON.stringify({ apiKey: "camel-key" }))
		expect(readApiKeyFromConfig(camel)).toBe("camel-key")

		const snake = join(dir, "c2.json")
		writeFileSync(snake, JSON.stringify({ api_key: "snake-key" }))
		expect(readApiKeyFromConfig(snake)).toBe("snake-key")
	})

	it("returns undefined for missing/corrupt/empty configs", () => {
		const dir = makeTempDir()
		expect(readApiKeyFromConfig(join(dir, "nope.json"))).toBeUndefined()
		const empty = join(dir, "empty.json")
		writeFileSync(empty, JSON.stringify({ apiKey: "" }))
		expect(readApiKeyFromConfig(empty)).toBeUndefined()
		const corrupt = join(dir, "corrupt.json")
		writeFileSync(corrupt, "{ nope")
		expect(readApiKeyFromConfig(corrupt)).toBeUndefined()
	})
})
