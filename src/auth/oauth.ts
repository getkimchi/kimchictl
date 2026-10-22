/**
 * CAST AI SSO login for kimchictl — OAuth 2.0 Authorization Code with PKCE
 * (S256) against the per-region CAST AI Auth0 tenant, mirroring the harness
 * implementation (kimchi-dev:src/cli-auth/oauth.ts, PR getkimchi/kimchi#1505).
 *
 * The OAuth protocol itself (authorize URL construction, token exchange,
 * refresh, ID-token validation) is delegated to `openid-client`; kimchictl
 * owns the CLI UX: the loopback callback (shared `startCallbackServer`,
 * `mode: "code"`), the numbered organization prompt, and translating the
 * result into the harness's shared auth.json credential shape so either
 * tool can read what the other wrote.
 *
 * Credential shape (the compatibility contract — must stay byte-identical
 * to what the harness writes):
 *   { type: "oauth", access, refresh, expires, region, tokenUrl, clientId,
 *     audience?, useIdToken, idToken?, accessToken?, orgId?, orgName? }
 */

import {
	allowInsecureRequests,
	authorizationCodeGrant,
	buildAuthorizationUrl,
	Configuration,
	calculatePKCECodeChallenge,
	randomPKCECodeVerifier,
	refreshTokenGrant,
} from "openid-client"
import { CAST_AI_SSO_CALLBACK_PORT, generateState, startCallbackServer } from "./browser-login.js"
import type { KimchiOAuthConfig } from "./oauth-config.js"

/** The registered loopback redirect URI. */
export const SSO_REDIRECT_URI = `http://localhost:${CAST_AI_SSO_CALLBACK_PORT}/callback`

/** Scope: offline_access yields the refresh token. */
export const SSO_SCOPE = "openid profile email offline_access"

/** Subtract from the IdP-reported lifetime so real clock skew never leaves
 * a request starting with a token at the edge of expiry. Mirrors the
 * harness's 60s margin. */
const EXPIRY_MARGIN_MS = 60_000

/** Refresh this long before expiry (mirrors the harness's five-minute
 * pre-expiry window; kimchictl refreshes once per invocation). */
export const REFRESH_WINDOW_MS = 5 * 60_000

const SUCCESS_MESSAGE = "Signed in with CAST AI. You can close this window and return to kimchictl."

// ---------------------------------------------------------------------------
// Credential shape (harness compatibility contract)
// ---------------------------------------------------------------------------

/** The oauth credential kimchictl and the harness exchange via auth.json. */
export interface SsoCredential {
	type: "oauth"
	/** The bearer string requests send (ID token by default). */
	access: string
	refresh: string
	/** Epoch ms expiry (IdP lifetime minus the skew margin). */
	expires: number
	region: string
	tokenUrl: string
	clientId: string
	audience?: string
	useIdToken: boolean
	/** Raw tokens, regardless of which one `access` carries. */
	idToken?: string
	accessToken?: string
	/** Selected organization (SSO credentials are org-scoped). */
	orgId?: string
	orgName?: string
}

/** Fields the token-endpoint response contributes, mapped onto the extras
 * the shared credential carries for later refreshes. */
function credentialFromTokenResponse(
	token: { access_token?: string; id_token?: string; refresh_token?: string; expires_in?: number },
	config: KimchiOAuthConfig,
	previous?: SsoCredential,
): SsoCredential {
	const accessToken = requiredString(token.access_token, "access_token")
	const idToken = typeof token.id_token === "string" && token.id_token.trim() ? token.id_token : undefined

	// Rotation: a rotated refresh token replaces the stored one; when the
	// server omits it, the existing token remains valid. (Auth0 rotation is
	// OFF for this client — the fan-out shares one refresh token — but the
	// response may still carry one.)
	const refresh =
		typeof token.refresh_token === "string" && token.refresh_token.trim() ? token.refresh_token : previous?.refresh
	if (!refresh) {
		throw new Error(
			"CAST AI sign-in did not return a refresh token — the Auth0 application must allow the 'offline_access' scope",
		)
	}
	if (typeof token.expires_in !== "number" || !Number.isFinite(token.expires_in) || token.expires_in <= 0) {
		throw new Error("OAuth token response has invalid expires_in")
	}

	// The org selection survives token refreshes (the org does not change
	// when the access token does).
	const orgId = previous?.orgId
	const orgName = previous?.orgName

	const credential: SsoCredential = {
		type: "oauth",
		access: "",
		refresh,
		expires: Date.now() + token.expires_in * 1000 - EXPIRY_MARGIN_MS,
		region: config.region,
		tokenUrl: config.tokenUrl,
		clientId: config.clientId,
		useIdToken: config.useIdToken,
		idToken,
		accessToken,
		...(orgId !== undefined ? { orgId } : {}),
		...(orgName !== undefined ? { orgName } : {}),
	}
	if (config.audience) credential.audience = config.audience

	// `access` is what requests send; which token carries it is decided by
	// the useIdToken config (default: ID token as the gateway bearer).
	const bearer = config.useIdToken ? idToken : accessToken
	if (!bearer) {
		throw new Error(
			"CAST AI sign-in did not return an ID token (set KIMCHI_OAUTH_USE_ID_TOKEN=0 to use the access token)",
		)
	}
	credential.access = bearer
	return credential
}

function requiredString(value: unknown, field: string): string {
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`OAuth token response has invalid ${field}`)
	}
	return value
}

// ---------------------------------------------------------------------------
// openid-client configuration (server metadata passed directly — no
// .well-known discovery round-trip; the endpoints come from oauth-config)
// ---------------------------------------------------------------------------

function clientConfiguration(config: KimchiOAuthConfig, fetchImpl?: typeof globalThis.fetch): Configuration {
	const configuration = new Configuration(
		{
			issuer: new URL(config.tokenUrl).origin,
			authorization_endpoint: config.authorizeUrl,
			token_endpoint: config.tokenUrl,
		},
		config.clientId,
	)
	// The Auth0 tenants are HTTPS; dev/mock AS setups (tests, local tilt
	// stacks) may be plain HTTP — openid-client refuses those by default.
	if (new URL(config.tokenUrl).protocol === "http:") {
		allowInsecureRequests(configuration)
	}
	if (fetchImpl) {
		// openid-client's customFetch injection point (tests + endpoint pinning).
		;(configuration as unknown as { fetch?: typeof globalThis.fetch }).fetch = fetchImpl
	}
	return configuration
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Token-endpoint failure carrying the RFC 6749 `error` code when the server
 * returned one (e.g. "invalid_grant"), so callers can distinguish a dead
 * credential from a transient failure without substring matching.
 */
export class OAuthTokenError extends Error {
	readonly code?: string
	readonly status?: number

	constructor(message: string, options: { code?: string; status?: number } = {}) {
		super(message)
		this.name = "OAuthTokenError"
		this.code = options.code
		this.status = options.status
	}
}

/** True when the error means the refresh token is dead and the user must sign in again. */
export function isInvalidGrantError(error: unknown): boolean {
	return error instanceof OAuthTokenError && error.code === "invalid_grant"
}

/** Normalize an openid-client/ResponseError into our typed error shape. */
function toTokenError(error: unknown): Error {
	if (error instanceof OAuthTokenError) return error
	if (error && typeof error === "object" && "error" in error) {
		const body = error as { error?: string; error_description?: string }
		if (typeof body.error === "string" && body.error) {
			return new OAuthTokenError(`Token request failed: ${body.error_description ?? body.error}`, { code: body.error })
		}
	}
	return error instanceof Error ? error : new Error(String(error))
}

// ---------------------------------------------------------------------------
// Organizations
// ---------------------------------------------------------------------------

export interface KimchiOrganization {
	id: string
	name: string
}

interface OrganizationsResponse {
	organizations?: Array<{ id?: string; name?: string }>
}

/** List the user's organizations from the Cast AI users API
 * (`GET <organizationsUrl>` — `${castApiUrl}/v1/organizations`). */
export async function listUserOrganizations(
	organizationsUrl: string,
	bearer: string,
	options: { fetch?: typeof globalThis.fetch; signal?: AbortSignal } = {},
): Promise<KimchiOrganization[]> {
	const fetchImpl = options.fetch ?? globalThis.fetch
	let response: Response
	try {
		response = await fetchImpl(organizationsUrl, {
			headers: { accept: "application/json", authorization: `Bearer ${bearer}` },
			signal: options.signal
				? AbortSignal.any([options.signal, AbortSignal.timeout(15_000)])
				: AbortSignal.timeout(15_000),
		})
	} catch (err) {
		if (options.signal?.aborted) throw new Error("Login cancelled")
		const detail = err instanceof Error ? err.message : String(err)
		throw new Error(`Fetching organizations failed: ${detail}`)
	}
	if (!response.ok) {
		throw new Error(`Fetching organizations failed (HTTP ${response.status})`)
	}
	const body = (await response.json().catch(() => null)) as OrganizationsResponse | null
	return (body?.organizations ?? [])
		.filter((org) => typeof org?.id === "string" && org.id.trim().length > 0)
		.map((org) => ({ id: org.id as string, name: typeof org.name === "string" ? org.name : (org.id as string) }))
}

/** Numbered prompt: render the org list, read a number, re-prompt on bad
 * input. `ask` is injected (readline in production, tests otherwise). */
export async function selectOrganization(
	organizations: KimchiOrganization[],
	ask: (question: string) => Promise<string>,
): Promise<KimchiOrganization> {
	if (organizations.length === 0) {
		throw new Error("This CAST AI account has no organizations")
	}
	if (organizations.length === 1) {
		const only = organizations[0]
		if (only) return only
	}
	const lines = organizations.map((org, index) => `${index + 1}) ${org.name}`)
	for (;;) {
		const answer = await ask(`Select organization:\n${lines.join("\n")}\nNumber [1-${organizations.length}]: `)
		const index = Number.parseInt(answer.trim(), 10)
		if (Number.isInteger(index) && index >= 1 && index <= organizations.length) {
			const selected = organizations[index - 1]
			if (selected) return selected
		}
		console.log(`Enter a number between 1 and ${organizations.length}.`)
	}
}

// ---------------------------------------------------------------------------
// Login + refresh
// ---------------------------------------------------------------------------

export interface SsoLoginOptions {
	/** Abort the flow (tears down the callback server early). */
	signal?: AbortSignal
	/** Injected browser opener (tests). */
	open?: (url: string) => Promise<unknown>
	/** Invoked with the authorize URL before the browser opens. */
	onUrl?: (url: string) => void
	/** Injected org-prompt ask (tests); default is the numbered readline. */
	ask?: (question: string) => Promise<string>
	/** Injected fetch (tests). */
	fetch?: typeof globalThis.fetch
	/** Test seam: the production login binds the registered fixed port;
	 * tests cannot assume it is free. */
	callbackPort?: number
}

/**
 * Run the browser-based CAST AI SSO login: authorize → loopback code
 * callback → token exchange (openid-client, ID-token validated) →
 * organization listing + selection → the harness-shaped credential.
 */
export async function loginWithCastAiOauth(
	config: KimchiOAuthConfig,
	options: SsoLoginOptions = {},
): Promise<SsoCredential> {
	const signal = options.signal ?? new AbortController().signal
	const pkceVerifier = randomPKCECodeVerifier()
	const codeChallenge = await calculatePKCECodeChallenge(pkceVerifier)
	const state = generateState()
	const fixedPort = options.callbackPort ?? CAST_AI_SSO_CALLBACK_PORT

	const callbackServer = await startCallbackServer(state, {
		mode: "code",
		successMessage: SUCCESS_MESSAGE,
		port: { kind: "fixed", value: fixedPort },
	})

	const configuration = clientConfiguration(config, options.fetch)
	const authorizeUrl = buildAuthorizationUrl(configuration, {
		redirect_uri: callbackServer.url,
		scope: SSO_SCOPE,
		state,
		code_challenge: codeChallenge,
		code_challenge_method: "S256",
		...(config.audience ? { audience: config.audience } : {}),
	})

	options.onUrl?.(authorizeUrl.href)
	console.log("Opening your browser to sign in with CAST AI…")
	const opener = options.open ?? (await import("open")).default
	try {
		await opener(authorizeUrl.href)
	} catch {
		console.log("Couldn't open your browser automatically. Please visit the URL above manually.")
	}

	try {
		const result = await callbackServer.result
		if (result.error) {
			if (result.errorCode) {
				throw new OAuthTokenError(`CAST AI sign-in failed: ${result.errorCode} — ${result.error}`, {
					code: result.errorCode,
				})
			}
			throw new Error(result.error)
		}
		if (!result.code) throw new Error("Callback server returned no authorization code")

		console.log("Exchanging the authorization code for tokens…")
		let tokenSet: { access_token?: string; id_token?: string; refresh_token?: string; expires_in?: number }
		try {
			// openid-client validates the ID token (issuer/audience/expiry)
			// as part of the code exchange; the loopback callback URL carries
			// the state + code it checks against.
			tokenSet = await authorizationCodeGrant(
				configuration,
				new URL(`${callbackServer.url}?code=${encodeURIComponent(result.code)}&state=${encodeURIComponent(state)}`),
				{
					pkceCodeVerifier: pkceVerifier,
					expectedState: state,
					...(config.audience ? { audience: config.audience } : {}),
				},
			)
		} catch (err) {
			throw toTokenError(err)
		}

		const credential = credentialFromTokenResponse(tokenSet, config)

		console.log("Fetching your organizations…")
		const organizations = await listUserOrganizations(config.organizationsUrl, credential.access, {
			fetch: options.fetch,
			signal,
		})
		const organization = await selectOrganization(organizations, options.ask ?? defaultAsk)
		return { ...credential, orgId: organization.id, orgName: organization.name }
	} finally {
		callbackServer.close()
	}
}

/** Plain readline ask for the numbered org prompt. */
async function defaultAsk(question: string): Promise<string> {
	const { createInterface } = await import("node:readline/promises")
	const rl = createInterface({ input: process.stdin, output: process.stdout })
	try {
		return await rl.question(question)
	} finally {
		rl.close()
	}
}

/** True when the credential is within the pre-expiry refresh window. */
export function needsRefresh(credential: SsoCredential, now: number = Date.now()): boolean {
	return now + REFRESH_WINDOW_MS >= credential.expires
}

/**
 * Renew a stored credential with its refresh token (rotation-safe: a new
 * refresh_token replaces the stored one; absent keeps; org fields carried
 * over). Side-effect-free besides the HTTP call — the caller rewrites the
 * shared auth.json fan-out.
 */
export async function refreshCredential(
	credential: SsoCredential,
	options: { fetch?: typeof globalThis.fetch; signal?: AbortSignal } = {},
): Promise<SsoCredential> {
	const config: KimchiOAuthConfig = {
		region: (credential.region === "eu" ? "eu" : "us") as KimchiOAuthConfig["region"],
		authorizeUrl: credential.tokenUrl, // unused for refresh; required by the type
		tokenUrl: credential.tokenUrl,
		clientId: credential.clientId,
		audience: credential.audience,
		organizationsUrl: "", // unused for refresh
		useIdToken: credential.useIdToken,
	}
	const configuration = clientConfiguration(config, options.fetch)
	let tokenSet: { access_token?: string; id_token?: string; refresh_token?: string; expires_in?: number }
	try {
		tokenSet = await refreshTokenGrant(configuration, credential.refresh, {
			...(config.audience ? { audience: config.audience } : {}),
		})
	} catch (err) {
		throw toTokenError(err)
	}
	return credentialFromTokenResponse(tokenSet, config, credential)
}
