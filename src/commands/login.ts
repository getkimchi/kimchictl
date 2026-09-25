import { kimchiProviderIdsFromModelsJson, syncSharedAuth } from "../auth/auth-file.js"
import { authenticateViaBrowser } from "../auth/browser-login.js"
import { writeApiKeyToConfig } from "../auth/config-file.js"
import { fetchKimchiProviderIds, ModelsFetchError } from "../auth/models-providers.js"
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
}

/**
 * `kimchictl login` — obtain an API key (browser OAuth or --api-key) and
 * store it in the harness's shared credential files:
 *   - auth.json: one `{ type: "api_key", key }` per Kimchi provider id
 *     (ids from an existing models.json plus a fresh metadata fetch)
 *   - config.json: the `apiKey` field
 * …so the harness picks the login up without its own `kimchi login`.
 */
export async function runLogin(args: string[], deps: LoginDeps = {}): Promise<number> {
	const { values } = parseFlags("login", args, {
		"api-key": { type: "string" },
	})
	const env = deps.env ?? process.env

	const authPath = resolveAuthJsonPath(env)
	const configPath = resolveConfigJsonPath(env)
	const modelsPath = resolveModelsJsonPath(env)

	let apiKey: string
	const apiKeyFlag = values["api-key"]
	const apiKeyProvided = apiKeyFlag !== undefined
	if (apiKeyProvided) {
		// parseArgs guarantees a string here (--api-key is declared type: "string").
		apiKey = typeof apiKeyFlag === "string" ? apiKeyFlag.trim() : ""
		if (!apiKey) {
			console.error("kimchictl login: --api-key must not be empty")
			return 2
		}
	} else {
		const interactive = deps.interactive ?? isInteractive()
		if (!interactive) {
			console.error("kimchictl login: interactive login requires a TTY; use --api-key for non-interactive mode")
			return 1
		}
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
		if (apiKeyProvided) {
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

	console.log(`✓ Logged in to Kimchi — credentials saved to ${authPath}`)
	console.log("  Shared with the kimchi coding harness; no second login needed there.")
	// First login is the natural moment to finish the native SSH integration
	// (automatic-with-notice; KIMCHICTL_NO_SSH_SETUP opts out).
	await ensureSshIntegration({ env })
	return 0
}
