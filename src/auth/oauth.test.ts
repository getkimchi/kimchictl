import { createPublicKey, createSign, generateKeyPairSync, type KeyObject } from "node:crypto"
import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { describe, expect, it } from "vitest"
import { loginWithCastAiOauth, needsRefresh, refreshCredential, type SsoCredential } from "./oauth.js"
import type { SsoRegionId } from "./oauth-config.js"

/**
 * Full CAST AI SSO flow tests against a mock Auth0 tenant + Cast AI users
 * API, mirroring the harness's tests/e2e/tui/login-sso.test.ts mock:
 * /authorize auto-approves (302 to the loopback callback with a fresh code +
 * echoed state), /token answers authorization_code and refresh_token grants
 * (openid-client validates the ID token, so the mock signs one with a local
 * key), and GET /v1/organizations lists the account's organizations.
 */

// --- Mock AS -----------------------------------------------------------------

interface RecordedGrant {
	grantType: string
	refreshToken?: string
}

interface MockAuthServer {
	authorizeUrl: string
	tokenUrl: string
	organizationsUrl: string
	grants: RecordedGrant[]
	orgRequests: Array<{ authorization: string | null }>
	setOrganizations: (orgs: Array<{ id: string; name: string }>) => void
	close(): Promise<void>
}

async function startMockAuthServer(): Promise<MockAuthServer> {
	const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 })
	const kid = "mock-kid"

	// openid-client validates the ID token: issuer, audience, expiry, and the
	// ES256 signature against the JWKS the config can fetch.
	const jwksPath = "/.well-known/jwks.json"
	const publicJwk = {
		...(createPublicKey(privateKey).export({ format: "jwk" }) as Record<string, unknown>),
		kid,
		use: "sig",
		alg: "RS256",
	}

	const grants: RecordedGrant[] = []
	const orgRequests: Array<{ authorization: string | null }> = []
	const organizations = [
		{ id: "org-alpha", name: "Alpha Org" },
		{ id: "org-beta", name: "Beta Org" },
	]

	const server: Server = createServer((req, res) => {
		const url = new URL(req.url ?? "/", "http://127.0.0.1")

		if (req.method === "GET" && url.pathname === jwksPath) {
			res.writeHead(200, { "content-type": "application/json" })
			res.end(JSON.stringify({ keys: [publicJwk] }))
			return
		}

		if (req.method === "GET" && url.pathname === "/v1/organizations") {
			orgRequests.push({ authorization: req.headers.authorization ?? null })
			res.writeHead(200, { "content-type": "application/json" })
			res.end(JSON.stringify({ organizations }))
			return
		}

		if (req.method === "GET" && url.pathname === "/authorize") {
			const redirectUri = url.searchParams.get("redirect_uri")
			const state = url.searchParams.get("state")
			if (!redirectUri || !state || url.searchParams.get("response_type") !== "code") {
				res.writeHead(400).end("missing redirect_uri/state or bad response_type")
				return
			}
			const target = new URL(redirectUri)
			target.searchParams.set("code", "mock-auth-code-1")
			target.searchParams.set("state", state)
			res.writeHead(302, { location: target.toString() }).end()
			return
		}

		if (req.method === "POST" && url.pathname === "/token") {
			let body = ""
			req.setEncoding("utf-8")
			req.on("data", (chunk: string) => {
				body += chunk
			})
			req.on("end", () => {
				const params = new URLSearchParams(body)
				grants.push({
					grantType: params.get("grant_type") ?? "",
					refreshToken: params.get("refresh_token") ?? undefined,
				})
				const grant = params.get("grant_type")
				if (grant !== "authorization_code" && grant !== "refresh_token") {
					res.writeHead(400, { "content-type": "application/json" })
					res.end(JSON.stringify({ error: "unsupported_grant_type" }))
					return
				}
				// A fresh, correctly-signed ID token (openid-client checks exp/iat).
				const idToken = signIdToken({ privateKey, kid })
				res.writeHead(200, {
					"content-type": "application/json",
					// openid-client enforces the RFC 6749 §5.1 response headers.
					"cache-control": "no-store, private",
					pragma: "no-cache",
				})
				res.end(
					JSON.stringify({
						access_token: "mock-access-token-1",
						id_token: idToken,
						refresh_token: "mock-refresh-token-1",
						expires_in: 3600,
						token_type: "Bearer",
					}),
				)
			})
			return
		}

		res.writeHead(404).end()
	})
	await new Promise<void>((resolveListen, rejectListen) => {
		server.once("error", rejectListen)
		server.listen(0, "127.0.0.1", () => resolveListen())
	})
	const { port } = server.address() as AddressInfo

	function signIdToken(opts: { privateKey: KeyObject; kid: string }): string {
		const header = { alg: "RS256", typ: "JWT", kid: opts.kid }
		const now = Math.floor(Date.now() / 1000)
		const payload = {
			iss: `http://127.0.0.1:${port}`,
			aud: "mock-client-id",
			sub: "auth0|mock-user",
			iat: now,
			exp: now + 3600,
		}
		const encode = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString("base64url")
		const signingInput = `${encode(header)}.${encode(payload)}`
		const signature = createSign("RSA-SHA256").update(signingInput).sign(opts.privateKey, "base64url")
		return `${signingInput}.${signature}`
	}

	return {
		authorizeUrl: `http://127.0.0.1:${port}/authorize`,
		tokenUrl: `http://127.0.0.1:${port}/token`,
		organizationsUrl: `http://127.0.0.1:${port}/v1/organizations`,
		grants,
		orgRequests,
		setOrganizations: (orgs) => {
			organizations.splice(0, organizations.length, ...orgs)
		},
		close: () =>
			new Promise<void>((done) => {
				server.closeAllConnections?.()
				server.close(() => done())
			}),
	}
}

// --- Helpers -----------------------------------------------------------------

function configFor(mock: { authorizeUrl: string; tokenUrl: string; organizationsUrl: string }) {
	// The mock AS is plain HTTP; openid-client refuses non-HTTPS token
	// endpoints unless TLS checks are disabled for the configuration. The
	// login path under test here is our orchestration (callback → exchange →
	// orgs), not openid-client's transport policy.
	return {
		region: "us" as SsoRegionId,
		authorizeUrl: mock.authorizeUrl,
		tokenUrl: mock.tokenUrl,
		clientId: "mock-client-id",
		organizationsUrl: mock.organizationsUrl,
		useIdToken: true,
	}
}

/** Bind a free port, then have the mock AS redirect the browser leg there. */
async function freePort(): Promise<number> {
	const probe = createServer()
	await new Promise<void>((resolveListen) => probe.listen(0, "127.0.0.1", () => resolveListen()))
	const { port } = probe.address() as AddressInfo
	await new Promise<void>((done) => probe.close(() => done()))
	return port
}

/**
 * The "browser": drives the authorize URL (302 → loopback callback with the
 * code), like the mock AS in the harness's e2e.
 */
async function driveBrowser(authorizeUrl: string): Promise<void> {
	await fetch(authorizeUrl, { redirect: "follow" })
}

// --- Tests -------------------------------------------------------------------

describe("loginWithCastAiOauth", () => {
	it("completes the code exchange, prompts for the org, and returns the harness-shaped credential", async () => {
		const mock = await startMockAuthServer()
		try {
			const port = await freePort()
			const selections: string[] = []
			const authorizeUrls: string[] = []
			const credential = await loginWithCastAiOauth(configFor(mock), {
				callbackPort: port,
				open: async (url) => {
					// The "browser": the mock's /authorize 302s to the loopback
					// callback with the code + echoed state.
					await driveBrowser(url)
				},
				ask: async (question) => {
					selections.push(question)
					return "2" // Beta Org
				},
				onUrl: (url) => {
					authorizeUrls.push(url)
				},
			})

			// The authorize URL targets the loopback redirect URI on our port
			// (URL-encoded inside the query string).
			expect(authorizeUrls[0]).toContain(`redirect_uri=${encodeURIComponent(`http://localhost:${port}/callback`)}`)
			// The org prompt rendered the numbered list.
			expect(selections[0]).toContain("1) Alpha Org")
			expect(selections[0]).toContain("2) Beta Org")

			// The credential is harness-shaped: oauth entry, ID token as the
			// bearer (useIdToken default), refresh token, org selection.
			expect(credential.type).toBe("oauth")
			expect(credential.access).toMatch(/^eyJ/) // the JWT ID token
			expect(credential.refresh).toBe("mock-refresh-token-1")
			expect(credential.expires).toBeGreaterThan(Date.now() + 3600_000 - 65_000)
			expect(credential.region).toBe("us")
			expect(credential.tokenUrl).toBe(mock.tokenUrl)
			expect(credential.clientId).toBe("mock-client-id")
			expect(credential.idToken).toBe(credential.access)
			expect(credential.accessToken).toBe("mock-access-token-1")
			expect(credential.orgId).toBe("org-beta")
			expect(credential.orgName).toBe("Beta Org")

			// The org listing was fetched with the ID-token bearer.
			expect(mock.orgRequests).toEqual([{ authorization: `Bearer ${credential.access}` }])
			expect(mock.grants).toEqual([{ grantType: "authorization_code", refreshToken: undefined }])
		} finally {
			await mock.close()
		}
	})

	it("drives the browser leg through the mock authorize endpoint", async () => {
		const mock = await startMockAuthServer()
		try {
			const port = await freePort()
			const loginPromise = loginWithCastAiOauth(configFor(mock), {
				callbackPort: port,
				open: async (url) => {
					await driveBrowser(url)
				},
				ask: async () => "1",
			})
			const credential = await loginPromise
			expect(credential.orgId).toBe("org-alpha")
			expect(mock.grants).toHaveLength(1)
		} finally {
			await mock.close()
		}
	})

	it("auto-selects a single organization without prompting", async () => {
		const mock = await startMockAuthServer()
		try {
			mock.setOrganizations([{ id: "org-only", name: "Only Org" }])
			const port = await freePort()
			let asked = 0
			const credential = await loginWithCastAiOauth(configFor(mock), {
				callbackPort: port,
				open: async (url) => {
					await driveBrowser(url)
				},
				ask: async () => {
					asked += 1
					return "1"
				},
			})
			expect(asked).toBe(0)
			expect(credential.orgId).toBe("org-only")
			expect(credential.orgName).toBe("Only Org")
		} finally {
			await mock.close()
		}
	})
})

describe("refreshCredential", () => {
	it("renews with grant_type=refresh_token, rotates the refresh token, and carries the org", async () => {
		const mock = await startMockAuthServer()
		try {
			const stored: SsoCredential = {
				type: "oauth",
				access: "old-id-token",
				refresh: "mock-refresh-token-1",
				expires: Date.now() - 1000,
				region: "us",
				tokenUrl: mock.tokenUrl,
				clientId: "mock-client-id",
				useIdToken: true,
				orgId: "org-beta",
				orgName: "Beta Org",
			}
			expect(needsRefresh(stored)).toBe(true)

			const next = await refreshCredential(stored)
			expect(mock.grants).toEqual([{ grantType: "refresh_token", refreshToken: "mock-refresh-token-1" }])
			// The mock returns the same refresh token — rotation-safe keep.
			expect(next.refresh).toBe("mock-refresh-token-1")
			// New ID token as bearer, fresh expiry, org carried over.
			expect(next.access).toMatch(/^eyJ/)
			expect(next.expires).toBeGreaterThan(Date.now() + 3600_000 - 65_000)
			expect(next.orgId).toBe("org-beta")
			expect(next.orgName).toBe("Beta Org")
			// needsRefresh flips false for the fresh credential.
			expect(needsRefresh(next)).toBe(false)
		} finally {
			await mock.close()
		}
	})
})
