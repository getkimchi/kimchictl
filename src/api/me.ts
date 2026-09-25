import { fetchWithTimeout, resolveEndpoint } from "./http.js"
import type { ApiOptions } from "./types.js"

/**
 * GET /v1/me — the authenticated user's profile.
 * (Mirror of kimchi-dev:src/api/me.ts.)
 */
export async function getMe(
	apiKey: string,
	options?: ApiOptions,
): Promise<{
	id: string
	username?: string
	name?: string
	email?: string
}> {
	const endpoint = resolveEndpoint(options)
	const fetchImpl = options?.fetch ?? globalThis.fetch

	const url = `${endpoint}/v1/me`
	const resp = await fetchWithTimeout(
		url,
		{
			method: "GET",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				Accept: "application/json",
			},
		},
		fetchImpl,
		30_000,
		options?.signal,
	)

	if (!resp.ok) {
		throw new Error(`GET ${url} failed with HTTP ${resp.status}`)
	}

	const data = await resp.json().catch(() => {
		throw new Error(`Unexpected non-JSON response from ${url}`)
	})

	if (typeof (data as { id?: unknown })?.id !== "string" || (data as { id: string }).id.length === 0) {
		throw new Error(`Missing id in /v1/me response from ${url}`)
	}

	return data as { id: string; username?: string; name?: string; email?: string }
}
