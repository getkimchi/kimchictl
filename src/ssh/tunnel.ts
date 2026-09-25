import { verifyApiKey } from "../api/keys.js"
import { exchangeWorkspaceToken, resumeWorkspace } from "../api/tokens.js"
import type { ApiOptions } from "../api/types.js"
import { RemoteNetworkError } from "../api/types.js"
import { getWorkspace } from "../api/workspaces.js"

/**
 * Tunnel resolution for the SSH bridge (TS port of kap's
 * internal/ssh/bridge.go ResolveTunnel, simplified: alias == id, no resolver
 * round-trip).
 */

export interface TunnelCreds {
	/** wss://<workspace-host>/ssh */
	wsUrl: string
	/** Short-lived workspace JWT for the Authorization header. */
	token: string
}

/**
 * Accepts a bare workspace id or a full hostname (id.domain) — the domain
 * suffix is stripped, which is what makes this usable as the ProxyCommand
 * target (`%h` expands to the full hostname).
 */
export function workspaceIdFromRef(wsRef: string): string {
	const dot = wsRef.indexOf(".")
	return dot > 0 ? wsRef.slice(0, dot) : wsRef
}

/** wss://{uri}/ssh — explicit port appended only when not 0/443 (kap parity). */
export function buildWsUrl(uri: string, port = 443): string {
	// The API may return a bare host or a scheme-prefixed URI; normalize to host[:port].
	const host = uri.includes("://") ? new URL(uri).host : uri
	if (!host) throw new RemoteNetworkError(`Invalid workspace URI from server: ${uri}`)
	return `wss://${host}${port === 0 || port === 443 ? "" : `:${port}`}/ssh`
}

export interface ResolveTunnelOptions extends ApiOptions {
	/** WebSocket port override (dev; default 443). */
	port?: number
}

export async function resolveTunnel(
	apiKey: string,
	wsRef: string,
	options?: ResolveTunnelOptions,
): Promise<TunnelCreds> {
	const id = workspaceIdFromRef(wsRef)
	const workspace = await getWorkspace(apiKey, id, options)
	if (!workspace.uri) {
		throw new RemoteNetworkError(`Workspace ${id} has no connection URI yet — it may still be provisioning`)
	}
	const { token } = await exchangeWorkspaceToken(apiKey, id, options)
	return { wsUrl: buildWsUrl(workspace.uri, options?.port), token }
}

/** Wake a hibernated workspace. Best-effort by contract: resume is idempotent server-side. */
export async function resumeForConnect(
	apiKey: string,
	workspaceId: string,
	options?: ApiOptions & { orgId?: string },
): Promise<void> {
	const orgId = options?.orgId ?? (await verifyApiKey(apiKey, options))
	await resumeWorkspace(apiKey, workspaceId, { ...options, orgId })
}
