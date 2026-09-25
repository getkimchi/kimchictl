import { readFileSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import {
	captureConsole,
	cleanupTempDirs,
	jsonResponse,
	makeTempDir,
	stubAgentDirEnv,
	stubFetch,
} from "../test-support.js"
import { runLogin } from "./login.js"

afterEach(() => {
	cleanupTempDirs()
	vi.unstubAllEnvs()
	vi.restoreAllMocks()
})

const aiEnablerOnlyFetch = stubFetch(async () => jsonResponse({ models: [{ slug: "m1", provider: "ai-enabler" }] }))

describe("kimchictl login --api-key", () => {
	it("stores the key in auth.json and config.json (shared with the harness)", async () => {
		const dir = makeTempDir()
		stubAgentDirEnv(dir)
		const { lines, errors } = captureConsole()

		const fetch = stubFetch(async () =>
			jsonResponse({
				models: [
					{ slug: "m1", provider: "ai-enabler" },
					{ slug: "m2", provider: "anthropic" },
				],
			}),
		)

		const code = await runLogin(["--api-key", "test-key"], { fetch })

		expect(code).toBe(0)
		expect(JSON.parse(readFileSync(join(dir, "auth.json"), "utf-8"))).toEqual({
			"kimchi-dev": { type: "api_key", key: "test-key" },
			"kimchi-dev/anthropic": { type: "api_key", key: "test-key" },
		})
		expect(JSON.parse(readFileSync(join(dir, "config.json"), "utf-8"))).toEqual({ apiKey: "test-key" })
		expect(lines.some((l) => l.includes("Logged in to Kimchi"))).toBe(true)
		expect(errors).toEqual([])
	})

	it("unions provider ids from an existing harness models.json", async () => {
		const dir = makeTempDir()
		stubAgentDirEnv(dir)
		writeFileSync(
			join(dir, "models.json"),
			JSON.stringify({ providers: { "kimchi-dev": {}, "kimchi-dev/openai": {}, ollama: {} } }),
		)
		captureConsole()

		const code = await runLogin(["--api-key", "test-key"], { fetch: aiEnablerOnlyFetch })

		expect(code).toBe(0)
		expect(JSON.parse(readFileSync(join(dir, "auth.json"), "utf-8"))).toEqual({
			"kimchi-dev": { type: "api_key", key: "test-key" },
			"kimchi-dev/openai": { type: "api_key", key: "test-key" },
		})
	})

	it("rejects an invalid key (401) and writes nothing", async () => {
		const dir = makeTempDir()
		stubAgentDirEnv(dir)
		const { errors } = captureConsole()
		const fetch = stubFetch(async () => new Response("nope", { status: 401, statusText: "Unauthorized" }))

		const code = await runLogin(["--api-key", "bad-key"], { fetch })

		expect(code).toBe(1)
		expect(errors[0]).toMatch(/Invalid API key/)
		expect(() => readFileSync(join(dir, "auth.json"))).toThrow()
	})

	it("fails hard when verification is unreachable for --api-key", async () => {
		const dir = makeTempDir()
		stubAgentDirEnv(dir)
		const { errors } = captureConsole()
		const fetch = stubFetch(async () => new Response("down", { status: 503, statusText: "Unavailable" }))

		const code = await runLogin(["--api-key", "key"], { fetch })

		expect(code).toBe(1)
		expect(errors[0]).toMatch(/Could not verify the API key/)
	})

	it("treats an empty --api-key as a usage error", async () => {
		stubAgentDirEnv(makeTempDir())
		const { errors } = captureConsole()

		expect(await runLogin(["--api-key", "  "])).toBe(2)
		expect(errors[0]).toMatch(/--api-key must not be empty/)
	})
})

describe("kimchictl login (browser)", () => {
	it("completes the OAuth round trip and saves the token", async () => {
		const dir = makeTempDir()
		stubAgentDirEnv(dir)
		captureConsole()

		const code = await runLogin([], {
			interactive: true,
			fetch: aiEnablerOnlyFetch,
			open: async (url) => {
				const parsed = new URL(url)
				const callback = new URL(decodeURIComponent(parsed.searchParams.get("callback") ?? ""))
				callback.searchParams.set("state", parsed.searchParams.get("state") ?? "")
				callback.searchParams.set("token", "browser-token")
				await fetch(callback)
			},
		})

		expect(code).toBe(0)
		expect(JSON.parse(readFileSync(join(dir, "auth.json"), "utf-8"))).toEqual({
			"kimchi-dev": { type: "api_key", key: "browser-token" },
		})
	})

	it("keeps the credential with a warning when the metadata fetch is unreachable", async () => {
		const dir = makeTempDir()
		stubAgentDirEnv(dir)
		const { errors } = captureConsole()
		const downFetch = stubFetch(async () => new Response("down", { status: 503, statusText: "Unavailable" }))

		const code = await runLogin([], {
			interactive: true,
			fetch: downFetch,
			open: async (url) => {
				const parsed = new URL(url)
				const callback = new URL(decodeURIComponent(parsed.searchParams.get("callback") ?? ""))
				callback.searchParams.set("state", parsed.searchParams.get("state") ?? "")
				callback.searchParams.set("token", "browser-token")
				await fetch(callback)
			},
		})

		expect(code).toBe(0)
		expect(JSON.parse(readFileSync(join(dir, "auth.json"), "utf-8"))).toEqual({
			"kimchi-dev": { type: "api_key", key: "browser-token" },
		})
		expect(errors.some((l) => l.includes("Could not refresh the Kimchi model list"))).toBe(true)
	})

	it("requires a TTY without --api-key", async () => {
		stubAgentDirEnv(makeTempDir())
		const { errors } = captureConsole()
		const code = await runLogin([], { interactive: false })
		expect(code).toBe(1)
		expect(errors[0]).toMatch(/requires a TTY/)
	})
})
