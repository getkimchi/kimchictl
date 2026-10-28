import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	captureConsole,
	cleanupTempDirs,
	jsonResponse,
	makeTempDir,
	sharedConfigPath,
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
		const { home } = stubAgentDirEnv(dir)
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
		expect(JSON.parse(readFileSync(sharedConfigPath(home), "utf-8"))).toEqual({ apiKey: "test-key" })
		expect(lines.some((l) => l.includes("Logged in to Kimchi"))).toBe(true)
		// First login finishes the SSH integration automatically (with notice).
		expect(errors.some((l) => l.includes("SSH integration configured"))).toBe(true)
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
	beforeEach(() => {
		// Interactive login with no method flag now shows the additive method
		// menu; the browser tests pin the legacy method via the env preselect.
		vi.stubEnv("KIMCHICTL_LOGIN_METHOD", "browser")
	})

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

describe("kimchictl login --sso", () => {
	const ssoCredential = {
		type: "oauth" as const,
		access: "sso-id-token",
		refresh: "sso-refresh",
		expires: Date.now() + 3600_000,
		region: "us",
		tokenUrl: "https://login.kimchi.dev/oauth/token",
		clientId: "rG3I0gwpiMzjzv1qC2W5s21UMQlNzSlS",
		useIdToken: true,
		idToken: "sso-id-token",
		accessToken: "sso-access-token",
		orgId: "org-beta",
		orgName: "Beta Org",
	}

	it("stores the oauth fan-out in auth.json and leaves config.json's apiKey unset", async () => {
		const dir = makeTempDir()
		const { home } = stubAgentDirEnv(dir)
		captureConsole()

		// A stale key login's apiKey must not survive an SSO login (the
		// harness's startup sync would mirror it over the oauth entries).
		const configPath = sharedConfigPath(home)
		mkdirSync(dirname(configPath), { recursive: true })
		writeFileSync(configPath, JSON.stringify({ apiKey: "stale-key", llmEndpoint: "https://x" }))
		// Seed a models.json so the org-header stamp is observable.
		writeFileSync(
			join(dir, "models.json"),
			JSON.stringify({ providers: { "kimchi-dev": { baseUrl: "https://x", models: [] } } }),
		)

		const fetch = stubFetch(async () =>
			jsonResponse({
				models: [
					{ slug: "m1", provider: "ai-enabler" },
					{ slug: "m2", provider: "anthropic" },
				],
			}),
		)
		const code = await runLogin(["--sso"], {
			fetch,
			loginSso: async () => ssoCredential,
		})

		expect(code).toBe(0)
		const auth = JSON.parse(readFileSync(join(dir, "auth.json"), "utf-8"))
		expect(auth["kimchi-dev"]).toEqual(ssoCredential)
		expect(auth["kimchi-dev/anthropic"]).toEqual(ssoCredential)
		// config.json keeps other fields, drops apiKey.
		const config = JSON.parse(readFileSync(configPath, "utf-8"))
		expect(config).toEqual({ llmEndpoint: "https://x" })
		// The org header is stamped on models.json's Kimchi providers.
		const models = JSON.parse(readFileSync(join(dir, "models.json"), "utf-8"))
		expect(models.providers["kimchi-dev"].headers["X-CastAi-Organization-Id"]).toBe("org-beta")
	})

	it("fails with guidance when the SSO flow errors", async () => {
		const dir = makeTempDir()
		stubAgentDirEnv(dir)
		const { errors } = captureConsole()

		const code = await runLogin(["--sso"], {
			loginSso: async () => {
				throw new Error("Login cancelled")
			},
		})

		expect(code).toBe(1)
		expect(errors[0]).toMatch(/CAST AI SSO login failed: Login cancelled/)
		expect(() => readFileSync(join(dir, "auth.json"))).toThrow()
	})

	it("rejects --sso together with --api-key", async () => {
		stubAgentDirEnv(makeTempDir())
		const { errors } = captureConsole()
		expect(await runLogin(["--sso", "--api-key", "k"])).toBe(2)
		expect(errors[0]).toMatch(/mutually exclusive/)
	})

	it("forwards --org-id to the SSO flow (skips the org picker)", async () => {
		const dir = makeTempDir()
		stubAgentDirEnv(dir)
		const loginSso = vi.fn().mockResolvedValue(ssoCredential)

		const code = await runLogin(["--sso", "--org-id", "org-beta"], { loginSso })

		expect(code).toBe(0)
		expect(loginSso).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ orgId: "org-beta" }))
	})

	it("rejects --org-id with an API-key login", async () => {
		stubAgentDirEnv(makeTempDir())
		const { errors } = captureConsole()
		expect(await runLogin(["--api-key", "k", "--org-id", "org-beta"])).toBe(2)
		expect(errors[0]).toMatch(/org-id only applies/)
	})

	it("validates --region", async () => {
		stubAgentDirEnv(makeTempDir())
		const { errors } = captureConsole()
		expect(await runLogin(["--sso", "--region", "mars"])).toBe(2)
		expect(errors[0]).toMatch(/--region must be us or eu/)
	})

	it("resolves the region from the harness's stored config region", async () => {
		const dir = makeTempDir()
		const { home } = stubAgentDirEnv(dir)
		captureConsole()
		const configPath = sharedConfigPath(home)
		mkdirSync(dirname(configPath), { recursive: true })
		writeFileSync(configPath, JSON.stringify({ region: "eu" }))

		const seen: string[] = []
		const code = await runLogin(["--sso"], {
			fetch: aiEnablerOnlyFetch,
			loginSso: async (config) => {
				seen.push(config.region)
				return ssoCredential
			},
		})

		expect(code).toBe(0)
		expect(seen).toEqual(["eu"])
	})
})

describe("kimchictl login (method menu)", () => {
	it("shows the additive method menu when interactive with no flags", async () => {
		const dir = makeTempDir()
		stubAgentDirEnv(dir)
		captureConsole()

		// The menu and the interactive API-key entry both read through the
		// deps.ask seam: "3" picks "Enter an API key", then the key itself.
		const answers = ["3", "test-key"]
		const code = await runLogin([], {
			interactive: true,
			fetch: aiEnablerOnlyFetch,
			ask: async () => answers.shift() ?? "",
		})

		expect(code).toBe(0)
		// The picked method stored a classic api_key credential — the legacy
		// methods stay reachable from the menu.
		expect(JSON.parse(readFileSync(join(dir, "auth.json"), "utf-8"))["kimchi-dev"]).toEqual({
			type: "api_key",
			key: "test-key",
		})
	})
})
