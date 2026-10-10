import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	captureConsole,
	cleanupTempDirs,
	makeTempDir,
	sharedConfigPath,
	sharedMcpPath,
	stubAgentDirEnv,
	writeSharedConfigJson,
	writeSharedMcpJson,
} from "../test-support.js"
import { runLogout } from "./logout.js"

afterEach(() => {
	cleanupTempDirs()
	vi.unstubAllEnvs()
	vi.restoreAllMocks()
})

function seedCredentials(dir: string, home: string): void {
	writeFileSync(
		join(dir, "auth.json"),
		JSON.stringify({
			"kimchi-dev": { type: "api_key", key: "key" },
			"kimchi-dev/openai": { type: "api_key", key: "key" },
			anthropic: { type: "api_key", key: "keep" },
		}),
	)
	writeSharedConfigJson(home, { apiKey: "key", other: true })
	writeSharedMcpJson(home, {
		mcpServers: {
			"cast-mcp": { type: "http", url: "https://api.cast.ai/mcp", headers: { Authorization: "Bearer key" } },
			other: { type: "stdio", command: "keep" },
		},
	})
}

describe("kimchictl logout", () => {
	it("removes shared credentials with --force (all three files, other entries preserved)", async () => {
		const dir = makeTempDir()
		const { home } = stubAgentDirEnv(dir)
		seedCredentials(dir, home)
		const { lines } = captureConsole()

		expect(await runLogout(["--force"])).toBe(0)

		expect(JSON.parse(readFileSync(join(dir, "auth.json"), "utf-8"))).toEqual({
			anthropic: { type: "api_key", key: "keep" },
		})
		expect(JSON.parse(readFileSync(sharedConfigPath(home), "utf-8"))).toEqual({ other: true })
		expect(JSON.parse(readFileSync(sharedMcpPath(home), "utf-8"))).toEqual({
			mcpServers: { other: { type: "stdio", command: "keep" } },
		})
		expect(lines.some((l) => l.includes("Logged out"))).toBe(true)
	})

	it("confirms via the prompt by default (interactive path)", async () => {
		const dir = makeTempDir()
		const { home } = stubAgentDirEnv(dir)
		seedCredentials(dir, home)
		const { errors } = captureConsole()

		expect(await runLogout([], { confirm: async () => true })).toBe(0)
		expect(errors[0]).toMatch(/also signs out the kimchi coding harness/)
		expect(JSON.parse(readFileSync(sharedConfigPath(home), "utf-8"))).toEqual({ other: true })
	})

	it("leaves everything untouched when the confirmation is declined", async () => {
		const dir = makeTempDir()
		const { home } = stubAgentDirEnv(dir)
		seedCredentials(dir, home)
		const { lines } = captureConsole()

		expect(await runLogout([], { confirm: async () => false })).toBe(0)

		expect(lines.some((l) => l.includes("Aborted"))).toBe(true)
		expect(JSON.parse(readFileSync(join(dir, "auth.json"), "utf-8"))["kimchi-dev"]).toBeDefined()
		expect(JSON.parse(readFileSync(sharedConfigPath(home), "utf-8")).apiKey).toBe("key")
		expect(JSON.parse(readFileSync(sharedMcpPath(home), "utf-8")).mcpServers["cast-mcp"]).toBeDefined()
	})

	it("requires --force when non-interactive", async () => {
		const dir = makeTempDir()
		const { home } = stubAgentDirEnv(dir)
		seedCredentials(dir, home)
		const { errors } = captureConsole()

		expect(await runLogout([], { interactive: false })).toBe(1)
		expect(errors.some((l) => l.includes("--force"))).toBe(true)
		expect(JSON.parse(readFileSync(join(dir, "auth.json"), "utf-8"))["kimchi-dev"]).toBeDefined()
	})

	it("proceeds when only the mcp.json entry remains", async () => {
		const dir = makeTempDir()
		const { home } = stubAgentDirEnv(dir)
		writeSharedMcpJson(home, {
			mcpServers: {
				"cast-mcp": { type: "http", url: "https://api.cast.ai/mcp", headers: { Authorization: "Bearer key" } },
			},
		})
		const { lines } = captureConsole()

		expect(await runLogout(["--force"])).toBe(0)

		expect(JSON.parse(readFileSync(sharedMcpPath(home), "utf-8"))).toEqual({ mcpServers: {} })
		expect(lines.some((l) => l.includes("Logged out"))).toBe(true)
	})

	it("reports when already logged out", async () => {
		stubAgentDirEnv(makeTempDir())
		const { lines } = captureConsole()
		expect(await runLogout([])).toBe(0)
		expect(lines).toEqual(["Not logged in."])
	})
})
