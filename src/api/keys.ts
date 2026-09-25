import { checkResponse, fetchWithTimeout, resolveEndpoint } from "./http.js"
import type { ApiOptions } from "./types.js"
import { RemoteNetworkError } from "./types.js"

/**
 * Verify an API key against the control plane. Returns the organization id.
 * (Mirror of kimchi-dev:src/sandbox/cloud/keys.ts.)
 */
export async function verifyApiKey(apiKey: string, options?: ApiOptions): Promise<string> {
	const endpoint = resolveEndpoint(options)
	const fetchImpl = options?.fetch ?? globalThis.fetch

	const url = `${endpoint}/ai-optimizer/v1beta/workspace-tokens:verifyKey`
	const resp = await fetchWithTimeout(
		url,
		{
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
		},
		fetchImpl,
		30_000,
		options?.signal,
	)

	await checkResponse(resp, url)

	const data = await resp.json().catch(() => {
		throw new RemoteNetworkError(`Unexpected non-JSON response from ${endpoint}`)
	})

	const orgId = (data as { organizationId?: unknown }).organizationId
	if (typeof orgId !== "string") {
		throw new RemoteNetworkError(`Missing organizationId in verify response from ${endpoint}`)
	}

	return orgId
}
