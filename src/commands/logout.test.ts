import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { captureConsole, cleanupTempDirs, makeTempDir, stubAgentDirEnv } from "../test-support.js"
import { runLogout } from "./logout.js"

afterEach(() => {
	cleanupTempDirs()
	vi.unstubAllEnvs()
	vi.restoreAllMocks()
})

function seedCredentials(dir: string): void {
	writeFileSync(
		join(dir, "auth.json"),
		JSON.stringify({
			"kimchi-dev": { type: "api_key", key: "key" },
			"kimchi-dev/openai": { type: "api_key", key: "key" },
			anthropic: { type: "api_key", key: "keep" },
		}),
	)
	writeFileSync(join(dir, "config.json"), JSON.stringify({ apiKey: "key", other: true }))
}

describe("kimchictl logout", () => {
	it("removes shared credentials with --force (both files, other entries preserved)", async () => {
		const dir = makeTempDir()
		stubAgentDirEnv(dir)
		seedCredentials(dir)
		const { lines } = captureConsole()

		expect(await runLogout(["--force"])).toBe(0)

		expect(JSON.parse(readFileSync(join(dir, "auth.json"), "utf-8"))).toEqual({
			anthropic: { type: "api_key", key: "keep" },
		})
		expect(JSON.parse(readFileSync(join(dir, "config.json"), "utf-8"))).toEqual({ other: true })
		expect(lines.some((l) => l.includes("Logged out"))).toBe(true)
	})

	it("confirms via the prompt by default (interactive path)", async () => {
		const dir = makeTempDir()
		stubAgentDirEnv(dir)
		seedCredentials(dir)
		const { errors } = captureConsole()

		expect(await runLogout([], { confirm: async () => true })).toBe(0)
		expect(errors[0]).toMatch(/also signs out the kimchi coding harness/)
		expect(JSON.parse(readFileSync(join(dir, "config.json"), "utf-8"))).toEqual({ other: true })
	})

	it("leaves everything untouched when the confirmation is declined", async () => {
		const dir = makeTempDir()
		stubAgentDirEnv(dir)
		seedCredentials(dir)
		const { lines } = captureConsole()

		expect(await runLogout([], { confirm: async () => false })).toBe(0)

		expect(lines.some((l) => l.includes("Aborted"))).toBe(true)
		expect(JSON.parse(readFileSync(join(dir, "auth.json"), "utf-8"))["kimchi-dev"]).toBeDefined()
		expect(JSON.parse(readFileSync(join(dir, "config.json"), "utf-8")).apiKey).toBe("key")
	})

	it("requires --force when non-interactive", async () => {
		const dir = makeTempDir()
		stubAgentDirEnv(dir)
		seedCredentials(dir)
		const { errors } = captureConsole()

		expect(await runLogout([], { interactive: false })).toBe(1)
		expect(errors.some((l) => l.includes("--force"))).toBe(true)
		expect(JSON.parse(readFileSync(join(dir, "auth.json"), "utf-8"))["kimchi-dev"]).toBeDefined()
	})

	it("reports when already logged out", async () => {
		stubAgentDirEnv(makeTempDir())
		const { lines } = captureConsole()
		expect(await runLogout([])).toBe(0)
		expect(lines).toEqual(["Not logged in."])
	})
})
