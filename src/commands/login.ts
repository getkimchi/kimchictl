import { kimchiProviderIdsFromModelsJson, readAuthJson, syncSharedAuth, syncSharedOAuth } from "../auth/auth-file.js"
import { authenticateViaBrowser } from "../auth/browser-login.js"
import { readRegionFromConfig, writeApiKeyToConfig } from "../auth/config-file.js"
import { applyOrganizationHeader } from "../auth/models-org-header.js"
import { fetchKimchiProviderIds, ModelsFetchError } from "../auth/models-providers.js"
import { loginWithCastAiOauth, type SsoCredential } from "../auth/oauth.js"
import { isSsoRegionId, oauthConfigForRegion, type SsoRegionId } from "../auth/oauth-config.js"
import { resolveAuthJsonPath, resolveConfigJsonPath, resolveModelsJsonPath } from "../auth/paths.js"
import { ensureSshIntegration } from "../ssh/connect.js"
import { parseFlags } from "./flags.js"
import { isInteractive } from "./prompt.js"

export interface LoginDeps {
	/** Browser opener override (tests). */
	open?: (url: string) => Promise<unknown>
	fetch?: typeof globalThis.fetch
	env?: NodeJS.ProcessEnv
	/** Override TTY interactivity detection (tests). */
	interactive?: boolean
	/** Org-prompt ask override (tests). */
	ask?: (question: string) => Promise<string>
	/** SSO flow override (tests); defaults to the real loginWithCastAiOauth. */
	loginSso?: typeof import("../auth/oauth.js").loginWithCastAiOauth
}

type LoginMethod = "sso" | "browser" | "api-key"

const METHOD_SUMMARY: Record<LoginMethod, string> = {
	sso: "Sign in with CAST AI (SSO)",
	browser: "Browser login (API key)",
	"api-key": "Enter an API key",
}

/**
 * `kimchictl login` — authenticate and store the credential in the harness's
 * shared files. Additive: three methods, all preserved:
 *
 *   1. CAST AI SSO (default) — OAuth Authorization Code + PKCE against the
 *      per-region CAST AI Auth0 tenant; stores a refreshable,
 *      organization-scoped `{ type: "oauth" }` credential fan-out in auth.json
 *      (the same shape the harness writes — either tool's SSO login works in
 *      the other). config.json's apiKey stays unset so the harness's startup
 *      sync never clobbers the OAuth entries.
 *   2. Browser login — the legacy web-app handoff, delivering a long-lived
 *      API key.
 *   3. --api-key — non-interactive key entry (CI path).
 */
export async function runLogin(args: string[], deps: LoginDeps = {}): Promise<number> {
	const { values } = parseFlags("login", args, {
		"api-key": { type: "string" },
		sso: { type: "boolean" },
		region: { type: "string" },
	})
	const env = deps.env ?? process.env

	const authPath = resolveAuthJsonPath(env)
	const configPath = resolveConfigJsonPath(env)
	const modelsPath = resolveModelsJsonPath(env)

	// --- Method selection ----------------------------------------------------
	const apiKeyFlag = values["api-key"]
	const apiKeyProvided = apiKeyFlag !== undefined

	let method: LoginMethod
	if (values.sso === true) {
		if (apiKeyProvided) {
			console.error("kimchictl login: --sso and --api-key are mutually exclusive")
			return 2
		}
		method = "sso"
	} else if (apiKeyProvided) {
		method = "api-key"
	} else {
		const interactive = deps.interactive ?? isInteractive()
		if (!interactive) {
			console.error("kimchictl login: interactive login requires a TTY; use --api-key for non-interactive mode")
			return 1
		}
		const envMethod = env.KIMCHICTL_LOGIN_METHOD
		if (envMethod === "sso" || envMethod === "browser" || envMethod === "api-key") {
			method = envMethod
		} else {
			method = await promptMethod(deps.ask)
		}
	}

	// --- Region (SSO only) ---------------------------------------------------
	let ssoRegion: SsoRegionId | undefined
	if (method === "sso") {
		const regionFlag = values.region
		if (regionFlag !== undefined) {
			if (typeof regionFlag !== "string" || !isSsoRegionId(regionFlag)) {
				console.error("kimchictl login: --region must be us or eu")
				return 2
			}
			ssoRegion = regionFlag
		} else {
			ssoRegion = readRegionFromConfig(configPath) ?? "us"
		}
	}

	// --- Run the selected method --------------------------------------------
	if (method === "sso") {
		if (!ssoRegion) {
			console.error("kimchictl login: could not resolve the SSO region")
			return 1
		}
		const config = oauthConfigForRegion(ssoRegion, env)
		const loginSso = deps.loginSso ?? loginWithCastAiOauth
		let credential: SsoCredential
		try {
			credential = await loginSso(config, {
				open: deps.open,
				ask: deps.ask,
				fetch: deps.fetch,
				onUrl: (url) => console.log(`If the browser does not open, visit:\n${url}`),
			})
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err)
			console.error(`✗ CAST AI SSO login failed: ${detail}`)
			return 1
		}

		// Provider-id fan-out: best-effort metadata fetch with the fresh
		// bearer; falls back to the ids already in models.json/auth.json.
		let fetchedIds: string[] = []
		try {
			fetchedIds = await fetchKimchiProviderIds(credential.access, { fetch: deps.fetch })
		} catch (err) {
			const detail = err instanceof Error ? err.message : String(err)
			console.error(
				`⚠ Could not refresh the Kimchi model list (${detail}); saving the base credential. ` +
					`Run \`kimchictl login\` again when the endpoint is reachable to pick up sub-provider credentials.`,
			)
		}

		const providerIds = [...new Set([...kimchiProviderIdsFromModelsJson(modelsPath), ...fetchedIds])]
		// Preserve ids already fanned out in auth.json (a harness SSO login
		// may know more sub-providers than the local models.json).
		providerIds.push(...Object.keys(readAuthJson(authPath)))
		await syncSharedOAuth(authPath, credential, [...new Set(providerIds)])

		// SSO credentials live only in auth.json: a stale config.json apiKey
		// (from an earlier key login) must go, or the harness's startup sync
		// would mirror it over the OAuth entries at the next launch.
		writeApiKeyToConfig(configPath, undefined)

		// Stamp the selected organization onto every Kimchi provider entry in
		// models.json — the gateway routes by X-Organization-ID.
		applyOrganizationHeader(modelsPath, credential.orgId)

		console.log(
			`✓ Logged in to Kimchi${credential.orgName ? ` — ${credential.orgName}` : ""} — credentials saved to ${authPath}`,
		)
		console.log("  Shared with the kimchi coding harness; no second login needed there.")
		await ensureSshIntegration({ env })
		return 0
	}

	// --- Legacy methods (unchanged behavior) ---------------------------------
	let apiKey: string
	if (method === "api-key") {
		if (apiKeyProvided) {
			// parseArgs guarantees a string here (--api-key is declared type: "string").
			apiKey = typeof apiKeyFlag === "string" ? apiKeyFlag.trim() : ""
		} else {
			// Menu option 3: interactive key entry.
			apiKey = (await (deps.ask ?? askLine)("API key: ")).trim()
		}
		if (!apiKey) {
			console.error("kimchictl login: --api-key must not be empty")
			return 2
		}
	} else {
		const { token } = await authenticateViaBrowser({
			open: deps.open,
			onBrowserUrl: (url) => console.log(`If the browser does not open, visit:\n${url}`),
		})
		apiKey = token
	}

	// Validate the key against the models metadata API and derive the full
	// Kimchi provider-id set (kimchi-dev + kimchi-dev/<upstream>) in one call.
	let fetchedIds: string[] = []
	try {
		fetchedIds = await fetchKimchiProviderIds(apiKey, { fetch: deps.fetch })
	} catch (err) {
		if (err instanceof ModelsFetchError && err.status === 401) {
			console.error("✗ Invalid API key. Please check the key and try again.")
			return 1
		}
		const detail = err instanceof Error ? err.message : String(err)
		if (method === "api-key") {
			// Mirror the harness's strict api-key login: an unverifiable key is not saved.
			console.error(`✗ Could not verify the API key (${detail}). Try again later.`)
			return 1
		}
		// Browser login: the token came from the web app seconds ago, so keep it and
		// fall back to the ids we know. (Harness: non-strict refresh with cache fallback.)
		console.error(
			`⚠ Could not refresh the Kimchi model list (${detail}); saving the base credential. ` +
				`Run \`kimchictl login\` again when the endpoint is reachable to pick up sub-provider credentials.`,
		)
	}

	const providerIds = [...new Set([...kimchiProviderIdsFromModelsJson(modelsPath), ...fetchedIds])]
	await syncSharedAuth(authPath, apiKey, providerIds)
	writeApiKeyToConfig(configPath, apiKey)

	// Key-based logins carry no organization: drop a stale X-Organization-ID
	// a previous CAST AI SSO login left in models.json.
	applyOrganizationHeader(modelsPath, undefined)

	console.log(`✓ Logged in to Kimchi — credentials saved to ${authPath}`)
	console.log("  Shared with the kimchi coding harness; no second login needed there.")
	// First login is the natural moment to finish the native SSH integration
	// (automatic-with-notice; KIMCHICTL_NO_SSH_SETUP opts out).
	await ensureSshIntegration({ env })
	return 0
}

/** Plain readline ask (the production default behind the deps.ask seam). */
async function askLine(question: string): Promise<string> {
	const { createInterface } = await import("node:readline/promises")
	const rl = createInterface({ input: process.stdin, output: process.stdout })
	try {
		return await rl.question(question)
	} finally {
		rl.close()
	}
}

/** Numbered method menu; SSO first (the recommended method), Enter = SSO. */
async function promptMethod(ask?: (question: string) => Promise<string>): Promise<LoginMethod> {
	const asker = ask ?? askLine
	for (;;) {
		const answer = await asker(
			`Select a login method:\n1) ${METHOD_SUMMARY.sso}\n2) ${METHOD_SUMMARY.browser}\n3) ${METHOD_SUMMARY["api-key"]}\nNumber [1-3, Enter = 1]: `,
		)
		const trimmed = answer.trim()
		if (trimmed === "" || trimmed === "1") return "sso"
		if (trimmed === "2") return "browser"
		if (trimmed === "3") return "api-key"
		console.log("Enter a number between 1 and 3.")
	}
}
