import { checkResponse, fetchWithTimeout, resolveEndpoint } from "./http.js"
import type { ApiOptions } from "./types.js"
import { RemoteNetworkError } from "./types.js"

/** Result of verifying an API key against the control plane. */
export interface VerifiedKey {
	organizationId: string
	/**
	 * The key owner's user id (the workspaces API `creatorId` filter value).
	 * Only the workspace listing needs it and older control planes may omit
	 * it, so its absence is enforced at the point of use — not here, where a
	 * hard failure would also break auth-only callers that discard the field.
	 */
	userId?: string
}

/**
 * Verify an API key against the control plane. Returns the organization id
 * plus, when the control plane reports it, the key owner's user id.
 * (Mirror of kimchi-dev:src/sandbox/cloud/keys.ts.)
 */
export async function verifyApiKey(apiKey: string, options?: ApiOptions): Promise<VerifiedKey> {
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
	if (typeof orgId !== "string" || orgId.length === 0) {
		throw new RemoteNetworkError(`Missing organizationId in verify response from ${endpoint}`)
	}

	const userId = (data as { userId?: unknown }).userId
	return { organizationId: orgId, userId: typeof userId === "string" && userId.length > 0 ? userId : undefined }
}
