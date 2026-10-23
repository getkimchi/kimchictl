/**
 * Per-region OAuth (Authorization Code + PKCE) metadata for CAST AI SSO
 * login — a port of the harness's kimchi-dev:src/oauth-config.ts. Both
 * tools must resolve identical config so a login in either drives the same
 * Auth0 tenant and the same user-organizations listing.
 *
 * Each region maps to its CAST AI Auth0 tenant (authorize/token URLs) plus
 * the native-app client id. The client id is a public identifier, not a
 * secret, so built-in defaults are safe to ship.
 *
 * Env overrides (resolved region first, then global):
 *   KIMCHI_OAUTH_CLIENT_ID_<REGION>  e.g. KIMCHI_OAUTH_CLIENT_ID_US
 *   KIMCHI_OAUTH_CLIENT_ID
 *   KIMCHI_OAUTH_AUTHORIZE_URL       dev/mock authorization-server override
 *   KIMCHI_OAUTH_TOKEN_URL           dev/mock token-endpoint override
 *   KIMCHI_ORGANIZATIONS_URL         dev/mock override for the user-organizations listing
 *   KIMCHI_OAUTH_AUDIENCE            optional `audience` authorize/token param
 *   KIMCHI_OAUTH_USE_ID_TOKEN        "1"/"true" (default) sends the ID token
 *                                    as the bearer; "0" sends the access token
 */

export type SsoRegionId = "us" | "eu"

export interface KimchiOAuthConfig {
	region: SsoRegionId
	authorizeUrl: string
	tokenUrl: string
	clientId: string
	/** Optional `audience` param for authorize and token requests (RFC 8707). */
	audience?: string
	/** GET endpoint listing the user's organizations (Cast AI users API):
	 * `${castApiUrl}/v1/organizations`. */
	organizationsUrl: string
	/** True: credential.access carries the ID token; false: the access token. */
	useIdToken: boolean
}

interface RegionOAuthDefaults {
	authorizeUrl: string
	tokenUrl: string
	clientId: string
	/** Cast AI API base for the region (org listing lives there). */
	castApiUrl: string
}

// Per-region native-app clients. Client ids are public identifiers, not
// secrets. The redirect URI is exactly `http://localhost:8765/callback`
// (see CAST_AI_SSO_CALLBACK_PORT in oauth.ts), offline_access is allowed,
// and refresh-token rotation must stay OFF — the credential fan-out shares
// one refresh token across Kimchi providers (mirrors the harness's
// src/pi-auth.ts constraint).
const REGION_OAUTH_DEFAULTS: Record<SsoRegionId, RegionOAuthDefaults> = {
	us: {
		authorizeUrl: "https://login.kimchi.dev/authorize",
		tokenUrl: "https://login.kimchi.dev/oauth/token",
		clientId: "rG3I0gwpiMzjzv1qC2W5s21UMQlNzSlS",
		castApiUrl: "https://api.cast.ai",
	},
	eu: {
		authorizeUrl: "https://login.eu.kimchi.dev/authorize",
		tokenUrl: "https://login.eu.kimchi.dev/oauth/token",
		clientId: "Bw2sA2DJyUAN2wpGiHU72Wh2Xenw6xma",
		castApiUrl: "https://api.eu.cast.ai",
	},
}

/** The registered Auth0 API identifier — REQUIRED for usable refresh
 * tokens: without an `audience` param Auth0 issues session-bound tokens it
 * immediately refuses on the refresh grant (verified live: seconds-old
 * refresh tokens rejected as "Unknown or invalid"). Override only for
 * dev/mock setups. */
export const OAUTH_AUDIENCE = "https://app.kimchi.dev"

function boolEnv(env: NodeJS.ProcessEnv, name: string): boolean | undefined {
	const value = env[name]?.trim().toLowerCase()
	if (value === undefined || value === "") return undefined
	return value === "1" || value === "true" || value === "yes"
}

function nonEmptyEnv(env: NodeJS.ProcessEnv, name: string): string | undefined {
	const value = env[name]?.trim()
	return value ? value : undefined
}

export function isSsoRegionId(value: unknown): value is SsoRegionId {
	return value === "us" || value === "eu"
}

/** OAuth endpoint/client metadata for a region, with env overrides applied. */
export function oauthConfigForRegion(region: SsoRegionId, env: NodeJS.ProcessEnv = process.env): KimchiOAuthConfig {
	const defaults = REGION_OAUTH_DEFAULTS[region]
	const regionTag = region.toUpperCase()
	const clientId =
		nonEmptyEnv(env, `KIMCHI_OAUTH_CLIENT_ID_${regionTag}`) ??
		nonEmptyEnv(env, "KIMCHI_OAUTH_CLIENT_ID") ??
		defaults.clientId
	return {
		region,
		authorizeUrl: nonEmptyEnv(env, "KIMCHI_OAUTH_AUTHORIZE_URL") ?? defaults.authorizeUrl,
		tokenUrl: nonEmptyEnv(env, "KIMCHI_OAUTH_TOKEN_URL") ?? defaults.tokenUrl,
		clientId,
		audience: nonEmptyEnv(env, "KIMCHI_OAUTH_AUDIENCE") ?? OAUTH_AUDIENCE,
		// The org listing lives on the Cast AI users API (castApiUrl), not the
		// Auth0 tenant — full-URL env override for dev/test (mock AS setups).
		organizationsUrl: nonEmptyEnv(env, "KIMCHI_ORGANIZATIONS_URL") ?? `${defaults.castApiUrl}/v1/organizations`,
		useIdToken: boolEnv(env, "KIMCHI_OAUTH_USE_ID_TOKEN") ?? true,
	}
}
