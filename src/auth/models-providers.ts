import { KIMCHI_PROVIDER_ID } from "./provider-ids.js"

/**
 * Minimal models-metadata fetch used to (a) validate an API key at login and
 * (b) derive the full set of Kimchi provider ids for auth.json
 * ("kimchi-dev" plus one "kimchi-dev/<upstream>" per upstream provider),
 * matching what the harness writes from models.json.
 *
 * Endpoint shape and derivation rules mirror kimchi-dev:src/models.ts
 * (buildModelsConfig). Only the id set matters here — models.json itself
 * remains the harness's file to write and is never created by kimchictl.
 */

const DEFAULT_LLM_ENDPOINT = "https://llm.kimchi.dev"
const FETCH_TIMEOUT_MS = 20_000

export class ModelsFetchError extends Error {
	readonly status?: number
	constructor(message: string, options: { status?: number } = {}) {
		super(message)
		this.name = "ModelsFetchError"
		this.status = options.status
	}
}

function normalizeLlmEndpoint(endpoint?: string): string {
	const trimmed = endpoint?.trim()
	if (!trimmed) return DEFAULT_LLM_ENDPOINT
	// Mirror the harness: scheme-less values get https:// so `dev.example.com` works.
	const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`
	return withScheme.replace(/\/+$/, "")
}

export interface FetchProviderIdsOptions {
	/** LLM service base URL; default https://llm.kimchi.dev. Env override: KIMCHI_LLM_ENDPOINT. */
	endpoint?: string
	fetch?: typeof globalThis.fetch
}

function resolveLlmEndpoint(options?: FetchProviderIdsOptions): string {
	return options?.endpoint ?? process.env.KIMCHI_LLM_ENDPOINT ?? DEFAULT_LLM_ENDPOINT
}

/**
 * Fetch the active model list and derive Kimchi provider ids from it.
 * Throws ModelsFetchError with .status on HTTP failure (401 = invalid key).
 */
export async function fetchKimchiProviderIds(apiKey: string, options?: FetchProviderIdsOptions): Promise<string[]> {
	const fetchImpl = options?.fetch ?? globalThis.fetch
	const url = `${normalizeLlmEndpoint(resolveLlmEndpoint(options))}/v1/models/metadata?include_in_cli=true`

	const resp = await fetchImpl(url, {
		headers: { Authorization: `Bearer ${apiKey}` },
		signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
	})
	if (!resp.ok) {
		throw new ModelsFetchError(`Failed to fetch models: ${resp.status} ${resp.statusText}`, { status: resp.status })
	}

	const body = (await resp.json().catch(() => undefined)) as { models?: unknown } | undefined
	if (!body || !Array.isArray(body.models)) {
		throw new ModelsFetchError("Unexpected response shape from models API")
	}

	const ids = new Set<string>([KIMCHI_PROVIDER_ID])
	for (const model of body.models) {
		if (model && typeof model === "object" && "provider" in model) {
			const provider = (model as { provider: unknown }).provider
			// "ai-enabler" entries live under the base "kimchi-dev" provider (mirrors buildModelsConfig).
			if (typeof provider === "string" && provider !== "ai-enabler") {
				ids.add(`${KIMCHI_PROVIDER_ID}/${provider}`)
			}
		}
	}
	return [...ids]
}
