import { checkResponse, fetchWithTimeout, resolveEndpoint } from "./http.js"
import type { ApiOptions } from "./types.js"
import { RemoteNetworkError } from "./types.js"

/**
 * Workspace token exchange + lifecycle RPCs (ports of the corresponding
 * kimchi-dev:src/sandbox/cloud/auth.ts functions, without the harness's
 * upsert semantics — kimchictl only resumes, never upserts).
 */

/** Exchange the API key for a short-lived workspace JWT (WebSocket auth). */
export async function exchangeWorkspaceToken(
	apiKey: string,
	workspaceId: string,
	options?: ApiOptions & { orgId?: string },
): Promise<{ token: string; expireTime: string }> {
	const endpoint = resolveEndpoint(options)
	const fetchImpl = options?.fetch ?? globalThis.fetch

	const url = `${endpoint}/ai-optimizer/v1beta/workspace-tokens:exchange`
	const resp = await fetchWithTimeout(
		url,
		{
			method: "POST",
			headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
			body: JSON.stringify({ workspaceId }),
		},
		fetchImpl,
		30_000,
		options?.signal,
	)

	await checkResponse(resp, url)

	const data = (await resp.json().catch(() => undefined)) as { token?: unknown; expireTime?: unknown } | undefined
	if (typeof data?.token !== "string") {
		throw new RemoteNetworkError(`Missing token in exchange response from ${endpoint}`)
	}
	return { token: data.token, expireTime: typeof data.expireTime === "string" ? data.expireTime : "" }
}

/**
 * Resume a suspended (hibernated) workspace: POST …/workspaces/{id}:resume.
 *
 * Success and "workspace is not suspended" (the control plane's FailedPrecondition
 * 400) both mean the workspace is running. Every other failure propagates.
 */
export async function resumeWorkspace(
	apiKey: string,
	workspaceId: string,
	options: ApiOptions & { orgId: string },
): Promise<void> {
	const endpoint = resolveEndpoint(options)
	const fetchImpl = options?.fetch ?? globalThis.fetch

	const url = `${endpoint}/ai-optimizer/v1beta/organizations/${encodeURIComponent(options.orgId)}/workspaces/${encodeURIComponent(workspaceId)}:resume`
	const resp = await fetchWithTimeout(
		url,
		{
			method: "POST",
			headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
			body: JSON.stringify({}),
		},
		fetchImpl,
		30_000,
		options?.signal,
	)

	if (resp.ok) return

	// Clone BEFORE consuming the body: checkResponse re-reads resp.text() and a
	// second read of the same body fails in undici.
	const rest = resp.clone()
	const body = await resp.text().catch(() => "")
	if (resp.status >= 400 && resp.status < 500 && body.includes("not suspended")) {
		return
	}

	await checkResponse(rest, url)
}
