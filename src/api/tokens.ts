import { authHeaders, checkResponse, fetchWithTimeout, resolveEndpoint } from "./http.js"
import type { ApiOptions } from "./types.js"
import { RemoteNetworkError } from "./types.js"
import { getWorkspace, type WorkspaceStatus } from "./workspaces.js"

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
			headers: authHeaders(apiKey, options?.organizationId ?? options?.orgId, { "Content-Type": "application/json" }),
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
 * Success and the control plane's FailedPrecondition 400 (the workspace is
 * already running — e.g. a concurrent resume) both mean the workspace is no
 * longer suspended. The 4xx is not trusted on its prose: it is tolerated only
 * when a follow-up GET confirms the workspace has left the suspended state.
 * Every other failure propagates.
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
			headers: authHeaders(apiKey, options.orgId, { "Content-Type": "application/json" }),
			body: JSON.stringify({}),
		},
		fetchImpl,
		30_000,
		options?.signal,
	)

	if (resp.ok) return

	// FailedPrecondition (already running) is benign — but the verified
	// workspace state decides, not the error prose.
	if (resp.status >= 400 && resp.status < 500 && (await hasLeftState(apiKey, workspaceId, options, "suspended"))) {
		return
	}

	await checkResponse(resp, url)
}

/**
 * Suspend (hibernate) a running workspace: POST …/workspaces/{id}:suspend.
 *
 * Success and the control plane's FailedPrecondition 400 (already suspended
 * or still initializing) both leave the workspace non-running. The 4xx is not
 * trusted on its prose: it is tolerated only when a follow-up GET confirms
 * the workspace is no longer active. Every other failure propagates.
 */
export async function suspendWorkspace(
	apiKey: string,
	workspaceId: string,
	options: ApiOptions & { orgId: string },
): Promise<void> {
	const endpoint = resolveEndpoint(options)
	const fetchImpl = options?.fetch ?? globalThis.fetch

	const url = `${endpoint}/ai-optimizer/v1beta/organizations/${encodeURIComponent(options.orgId)}/workspaces/${encodeURIComponent(workspaceId)}:suspend`
	const resp = await fetchWithTimeout(
		url,
		{
			method: "POST",
			headers: authHeaders(apiKey, options.orgId, { "Content-Type": "application/json" }),
			body: JSON.stringify({}),
		},
		fetchImpl,
		30_000,
		options?.signal,
	)

	if (resp.ok) return

	// FailedPrecondition (already suspended / still initializing) is benign —
	// but the verified workspace state decides, not the error prose.
	if (resp.status >= 400 && resp.status < 500 && (await hasLeftState(apiKey, workspaceId, options, "active"))) {
		return
	}

	await checkResponse(resp, url)
}

/**
 * Lifecycle-4xx verification. A FailedPrecondition from :suspend/:resume (the
 * workspace is already in the target state) is benign, but the error prose is
 * not a reliable signal — other client errors can contain the same words
 * ("billing account is not active"). Confirm with a GET that the workspace
 * has actually left `from` (suspend: "active"; resume: "suspended"); when the
 * GET itself fails, report false so the POST's original error surfaces.
 */
async function hasLeftState(
	apiKey: string,
	workspaceId: string,
	options: ApiOptions & { orgId: string },
	from: WorkspaceStatus,
): Promise<boolean> {
	try {
		return (await getWorkspace(apiKey, workspaceId, options)).status !== from
	} catch {
		return false
	}
}
