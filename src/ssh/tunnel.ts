import { verifyApiKey } from "../api/keys.js"
import { resolveWorkspace } from "../api/resolver.js"
import { exchangeWorkspaceToken, resumeWorkspace } from "../api/tokens.js"
import type { ApiOptions } from "../api/types.js"
import { RemoteNetworkError } from "../api/types.js"
import { waitForWorkspaceActive } from "../api/wait.js"

/**
 * Tunnel resolution for the SSH bridge (TS port of kap's
 * internal/ssh/bridge.go ResolveTunnel — refs resolve via api/resolver.ts,
 * extended to wake suspended workspaces before dialing).
 */

/** Post-resume wait budget for a suspended workspace to reach ACTIVE. */
const RESUME_WAIT_TIMEOUT_MS = 90_000

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
	/** Poll sleep seam (tests) for the post-resume wait. */
	sleep?: (ms: number) => Promise<void>
}

export async function resolveTunnel(
	apiKey: string,
	wsRef: string,
	options?: ResolveTunnelOptions,
): Promise<TunnelCreds> {
	const ref = workspaceIdFromRef(wsRef)
	// Org-scoped SSO credentials: the stored organization id routes the
	// workspace lookup and the token exchange (skips the verifyKey round-trip).
	let workspace = await resolveWorkspace(apiKey, ref, { ...options, organizationId: options?.organizationId })

	// A suspended workspace has no live SSH endpoint: resume it and wait for
	// ACTIVE *before* the token exchange, so the WS URL and JWT reflect the
	// running instance. Details go to stderr — as a ProxyCommand, stdout is
	// the SSH data channel and must stay clean.
	if (workspace.status === "suspended") {
		process.stderr.write(`[proxy] workspace ${workspace.alias} is suspended — resuming\n`)
		await resumeForConnect(apiKey, workspace.id, { ...options, orgId: options?.organizationId })
		workspace = await waitForWorkspaceActive(apiKey, workspace.id, {
			...options,
			organizationId: options?.organizationId,
			timeoutMs: RESUME_WAIT_TIMEOUT_MS,
			sleep: options?.sleep,
			onTick: (elapsedSeconds) => process.stderr.write(`\r[proxy] resuming ${workspace.alias}… ${elapsedSeconds}s`),
		})
		process.stderr.write("\n")
		if (workspace.status === "active") {
			process.stderr.write(`[proxy] workspace ${workspace.alias} is active — connecting\n`)
		} else {
			process.stderr.write(
				`[proxy] ⚠ workspace ${workspace.alias} is still ${workspace.status} after ` +
					`${Math.round(RESUME_WAIT_TIMEOUT_MS / 1000)}s — connecting anyway\n`,
			)
		}
	}

	if (!workspace.uri) {
		throw new RemoteNetworkError(`Workspace ${ref} has no connection URI yet — it may still be provisioning`)
	}
	const { token } = await exchangeWorkspaceToken(apiKey, workspace.id, {
		...options,
		organizationId: options?.organizationId,
	})
	return { wsUrl: buildWsUrl(workspace.uri, options?.port), token }
}

/** Wake a hibernated workspace. Best-effort by contract: resume is idempotent server-side. */
export async function resumeForConnect(
	apiKey: string,
	workspaceId: string,
	options?: ApiOptions & { orgId?: string },
): Promise<void> {
	const orgId = options?.orgId ?? (await verifyApiKey(apiKey, options)).organizationId
	await resumeWorkspace(apiKey, workspaceId, { ...options, orgId })
}
