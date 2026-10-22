import { mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { cleanupTempDirs, makeTempDir } from "../test-support.js"
import { readSharedOAuthCredential, syncSharedOAuth } from "./auth-file.js"
import { readRegionFromConfig } from "./config-file.js"
import { applyOrganizationHeader } from "./models-org-header.js"
import type { SsoCredential } from "./oauth.js"
import { resolveAuthJsonPath, resolveConfigJsonPath } from "./paths.js"
import { RefreshRequiredError, resolveApiKey, resolveCredential } from "./resolve.js"

/**
 * Cross-tool compatibility tests: the auth.json oauth entries kimchictl
 * writes must be exactly what the harness reads (and vice versa) —
 * whichever process writes the file, the other works without issues.
 * Fixtures mirror kimchi-dev:src/pi-auth.test.ts's
 * syncOAuthCredentialToKimchiProviders expectations.
 */

afterEach(() => {
	cleanupTempDirs()
	vi.unstubAllEnvs()
})

const ssoCredential: SsoCredential = {
	type: "oauth",
	access: "mock-id-token-1",
	refresh: "mock-refresh-token-1",
	expires: Date.now() + 3600_000,
	region: "us",
	tokenUrl: "https://login.cast.ai/oauth/token",
	clientId: "rG3I0gwpiMzjzv1qC2W5s21UMQlNzSlS",
	useIdToken: true,
	idToken: "mock-id-token-1",
	accessToken: "mock-access-token-1",
	orgId: "org-beta",
	orgName: "Beta Org",
}

describe("syncSharedOAuth", () => {
	it("fans the oauth credential out to every Kimchi provider, preserving others", async () => {
		const dir = makeTempDir()
		const authPath = join(dir, "auth.json")
		writeFileSync(
			authPath,
			JSON.stringify({
				anthropic: { type: "api_key", key: "keep-me" },
				"kimchi-dev": { type: "api_key", key: "stale-key" },
				"kimchi-dev/openai": { type: "api_key", key: "stale-key" },
			}),
		)

		await syncSharedOAuth(authPath, ssoCredential, ["kimchi-dev/openai", "kimchi-experimental"])

		const stored = JSON.parse(readFileSync(authPath, "utf-8"))
		expect(stored.anthropic).toEqual({ type: "api_key", key: "keep-me" })
		for (const providerId of ["kimchi-dev", "kimchi-dev/openai", "kimchi-experimental"]) {
			expect(stored[providerId]).toEqual(ssoCredential)
		}
	})

	it("always includes the base kimchi-dev provider even with no ids supplied", async () => {
		const dir = makeTempDir()
		const authPath = join(dir, "auth.json")

		await syncSharedOAuth(authPath, ssoCredential, [])

		expect(JSON.parse(readFileSync(authPath, "utf-8"))).toEqual({ "kimchi-dev": ssoCredential })
	})

	it("round-trips through readSharedOAuthCredential (harness-written shape)", async () => {
		const dir = makeTempDir()
		const authPath = join(dir, "auth.json")

		await syncSharedOAuth(authPath, ssoCredential, ["kimchi-dev/anthropic"])
		expect(readSharedOAuthCredential(authPath)).toEqual(ssoCredential)

		// A harness-shaped entry (as kimchi-dev's syncOAuthCredentialToKimchiProviders
		// writes it, including unknown-extra-field tolerance) reads back too.
		writeFileSync(
			authPath,
			JSON.stringify({
				"kimchi-dev": {
					type: "oauth",
					access: "harness-id-token",
					refresh: "harness-refresh",
					expires: Date.now() + 1000,
					region: "eu",
					tokenUrl: "https://login.eu.cast.ai/oauth/token",
					clientId: "Bw2sA2DJyUAN2wpGiHU72Wh2Xenw6xma",
					useIdToken: true,
					orgId: "org-eu",
					futureField: "ignored-but-preserved-on-rewrite",
				},
			}),
		)
		const read = readSharedOAuthCredential(authPath)
		expect(read?.access).toBe("harness-id-token")
		expect(read?.region).toBe("eu")
		expect(read?.orgId).toBe("org-eu")
	})

	it("returns undefined for api_key entries and missing files", () => {
		const dir = makeTempDir()
		const authPath = join(dir, "auth.json")
		expect(readSharedOAuthCredential(authPath)).toBeUndefined()
		writeFileSync(authPath, JSON.stringify({ "kimchi-dev": { type: "api_key", key: "k" } }))
		expect(readSharedOAuthCredential(authPath)).toBeUndefined()
	})
})

describe("readRegionFromConfig", () => {
	it("reads the harness's stored region", () => {
		const dir = makeTempDir()
		const configPath = join(dir, "config.json")
		writeFileSync(configPath, JSON.stringify({ region: "eu", apiKey: "" }))
		expect(readRegionFromConfig(configPath)).toBe("eu")
		writeFileSync(configPath, JSON.stringify({}))
		expect(readRegionFromConfig(configPath)).toBeUndefined()
		writeFileSync(configPath, JSON.stringify({ region: "self-hosted" }))
		expect(readRegionFromConfig(configPath)).toBeUndefined()
	})
})

describe("applyOrganizationHeader", () => {
	it("adds and strips the org header on Kimchi providers without touching others", () => {
		const dir = makeTempDir()
		const modelsPath = join(dir, "models.json")
		writeFileSync(
			modelsPath,
			JSON.stringify({
				providers: {
					"kimchi-dev": { baseUrl: "https://example.invalid", headers: { "X-Provider-Type": "ai-enabler" } },
					"kimchi-dev/openai": {},
					"kimi-coding": {},
					ollama: {},
				},
			}),
		)

		applyOrganizationHeader(modelsPath, "org-9")
		let providers = JSON.parse(readFileSync(modelsPath, "utf-8")).providers
		expect(providers["kimchi-dev"].headers["X-CastAi-Organization-Id"]).toBe("org-9")
		expect(providers["kimchi-dev"].headers["X-Provider-Type"]).toBe("ai-enabler")
		expect(providers["kimchi-dev/openai"].headers["X-CastAi-Organization-Id"]).toBe("org-9")
		expect(providers["kimi-coding"].headers).toBeUndefined()
		expect(providers.ollama.headers).toBeUndefined()

		// Strip (api-key login path).
		applyOrganizationHeader(modelsPath, undefined)
		providers = JSON.parse(readFileSync(modelsPath, "utf-8")).providers
		expect(providers["kimchi-dev"].headers).toEqual({ "X-Provider-Type": "ai-enabler" })
		expect(providers["kimchi-dev/openai"].headers).toEqual({})
	})

	it("tolerates a missing models.json", () => {
		expect(() => applyOrganizationHeader(join(makeTempDir(), "absent.json"), "org-1")).not.toThrow()
	})
})

describe("resolveCredential / resolveApiKey OAuth tier", () => {
	function stubEnv(dir: string): NodeJS.ProcessEnv {
		return { HOME: dir, KIMCHI_CODING_AGENT_DIR: join(dir, "harness") }
	}

	it("uses the harness's stored oauth credential as-is (no refresh, org attached)", async () => {
		const dir = makeTempDir()
		const env = stubEnv(dir)
		const authPath = resolveAuthJsonPath(env)
		await syncSharedOAuth(authPath, ssoCredential, [])

		const credential = await resolveCredential(env)
		expect(credential.bearer).toBe("mock-id-token-1")
		expect(credential.organizationId).toBe("org-beta")
		expect(credential.sso?.refresh).toBe("mock-refresh-token-1")
		expect(credential.source).toBe("auth-json-oauth")

		// The resolveApiKey legacy view exposes the same bearer.
		expect(resolveApiKey(env)).toEqual({ key: "mock-id-token-1", source: "auth-json-oauth" })
	})

	it("refreshes an expiring credential once and rewrites the fan-out", async () => {
		const dir = makeTempDir()
		const env = stubEnv(dir)
		const authPath = resolveAuthJsonPath(env)
		const expiring: SsoCredential = { ...ssoCredential, expires: Date.now() + 60_000 }
		await syncSharedOAuth(authPath, expiring, ["kimchi-dev/openai"])

		const refreshed: SsoCredential = {
			...ssoCredential,
			access: "fresh-id-token",
			refresh: "fresh-refresh",
			expires: Date.now() + 7200_000,
		}
		const oauthModule = await import("./oauth.js")
		const refreshSpy = vi.spyOn(oauthModule, "refreshCredential").mockResolvedValue(refreshed)

		const credential = await resolveCredential(env)
		expect(refreshSpy).toHaveBeenCalledTimes(1)
		expect(credential.bearer).toBe("fresh-id-token")
		// The fan-out was rewritten with the fresh credential.
		const stored = JSON.parse(readFileSync(authPath, "utf-8"))
		expect(stored["kimchi-dev"]).toEqual(refreshed)
		expect(stored["kimchi-dev/openai"]).toEqual(refreshed)

		refreshSpy.mockRestore()
	})

	it("surfaces a dead refresh token as RefreshRequiredError and keeps the file intact", async () => {
		const dir = makeTempDir()
		const env = stubEnv(dir)
		const authPath = resolveAuthJsonPath(env)
		const expiring: SsoCredential = { ...ssoCredential, expires: Date.now() + 60_000 }
		await syncSharedOAuth(authPath, expiring, [])
		const before = readFileSync(authPath, "utf-8")

		const oauthModule = await import("./oauth.js")
		const refreshSpy = vi
			.spyOn(oauthModule, "refreshCredential")
			.mockRejectedValue(
				new oauthModule.OAuthTokenError("Token request failed: refresh token revoked", { code: "invalid_grant" }),
			)

		await expect(resolveCredential(env)).rejects.toThrow(RefreshRequiredError)
		expect(readFileSync(authPath, "utf-8")).toBe(before)

		refreshSpy.mockRestore()
	})

	it("prefers env key, then config key, then auth.json api_key, then oauth", async () => {
		const dir = makeTempDir()
		const env = stubEnv(dir)
		const authPath = resolveAuthJsonPath(env)
		const configPath = resolveConfigJsonPath(env)

		await syncSharedOAuth(authPath, ssoCredential, [])
		expect(resolveApiKey({ ...env, KIMCHI_API_KEY: "env-key" })?.source).toBe("environment")

		mkdirSync(dirname(configPath), { recursive: true })
		writeFileSync(configPath, JSON.stringify({ apiKey: "config-key" }))
		expect(resolveApiKey(env)?.source).toBe("config")

		// An auth.json api_key entry ranks BELOW the config key...
		writeFileSync(authPath, JSON.stringify({ "kimchi-dev": { type: "api_key", key: "auth-key" } }))
		expect(resolveApiKey(env)?.key).toBe("config-key")
		// ...but above the oauth entry once the config key is gone.
		writeFileSync(configPath, JSON.stringify({}))
		expect(resolveApiKey(env)).toEqual({ key: "auth-key", source: "auth-json" })
	})
})
