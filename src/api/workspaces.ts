import { checkResponse, fetchWithTimeout, resolveEndpoint } from "./http.js"
import { verifyApiKey } from "./keys.js"
import { byteQuantityToBytes, cpuQuantityToMillicores } from "./resources.js"
import type { ApiOptions } from "./types.js"
import { RemoteAuthError, RemoteNetworkError } from "./types.js"

/**
 * Workspace client — mirrors the harness's (kimchi-dev:src/sandbox/cloud)
 * calls against the same control-plane API, plus kap's server-named create.
 *
 * The control plane addresses workspaces by UUID id; users type the alias
 * (first DNS label of the URI). api/resolver.ts maps between them.
 */

const HARNESS_CLIENT_TYPE = "harness" // matches kimchi-dev:src/sandbox/constants.ts
const LIST_WORKSPACES_PAGE_LIMIT = 200
const LIST_WORKSPACES_PAGE_HARD_CAP = 10

export type WorkspaceStatus = "active" | "initializing" | "suspended" | "deleting" | "terminated"

export interface Workspace {
	/** Server id — also the command-line identifier (`workspace get <id>`, `ssh <id>`). */
	id: string
	/** First DNS label of the URI — the user-facing name (NOT the server id). */
	alias: string
	description: string
	status: WorkspaceStatus
	uri?: string
	host?: string
	createdAt: Date
	/** Control-plane cluster (e.g. krep-us). */
	cluster: string
	/** Client that owns the workspace (e.g. harness). */
	clientType: string
	cpuMillicores?: number
	ramBytes?: number
	pvcSizeBytes?: number
}

export interface WorkspaceCommandOptions extends ApiOptions {
	/** Pre-resolved organization id — skips the verifyKey round-trip. */
	orgId?: string
}

async function resolveOrgId(apiKey: string, options?: WorkspaceCommandOptions): Promise<string> {
	return options?.orgId ?? (await verifyApiKey(apiKey, options))
}

export async function listWorkspaces(apiKey: string, options?: WorkspaceCommandOptions): Promise<Workspace[]> {
	const fetchImpl = options?.fetch ?? globalThis.fetch
	const endpoint = resolveEndpoint(options)

	try {
		const orgId = await resolveOrgId(apiKey, options)

		const results: Workspace[] = []
		let cursor = ""

		for (let page = 0; page < LIST_WORKSPACES_PAGE_HARD_CAP; page++) {
			const params = new URLSearchParams()
			params.set("page.limit", String(LIST_WORKSPACES_PAGE_LIMIT))
			params.set("clientType", HARNESS_CLIENT_TYPE)
			if (cursor) params.set("page.cursor", cursor)

			const url = `${endpoint}/ai-optimizer/v1beta/organizations/${encodeURIComponent(orgId)}/workspaces?${params.toString()}`
			const resp = await fetchWithTimeout(
				url,
				{ method: "GET", headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" } },
				fetchImpl,
				30_000,
				options?.signal,
			)

			await checkResponse(resp, url)

			const data: unknown = await resp.json().catch(() => undefined)
			if (typeof data !== "object" || data === null) {
				throw new RemoteNetworkError(`Unexpected response shape from ${endpoint}`)
			}
			const items = (data as { items?: unknown }).items
			if (!Array.isArray(items)) {
				throw new RemoteNetworkError(`Missing items array in list-workspaces response from ${endpoint}`)
			}

			for (const item of items) {
				results.push(mapWorkspace(item, endpoint))
			}

			const nextCursor = (data as { nextPageCursor?: unknown }).nextPageCursor
			if (typeof nextCursor !== "string" || nextCursor.length === 0) {
				return results
			}
			cursor = nextCursor
		}

		return results
	} catch (err) {
		if (err instanceof RemoteAuthError || err instanceof RemoteNetworkError) {
			throw err
		}
		throw new RemoteNetworkError(err instanceof Error ? err.message : String(err))
	}
}

export async function getWorkspace(apiKey: string, id: string, options?: WorkspaceCommandOptions): Promise<Workspace> {
	const fetchImpl = options?.fetch ?? globalThis.fetch
	const endpoint = resolveEndpoint(options)
	const orgId = await resolveOrgId(apiKey, options)

	const url = `${endpoint}/ai-optimizer/v1beta/organizations/${encodeURIComponent(orgId)}/workspaces/${encodeURIComponent(id)}`
	const resp = await fetchWithTimeout(
		url,
		{ method: "GET", headers: { Authorization: `Bearer ${apiKey}` } },
		fetchImpl,
		30_000,
		options?.signal,
	)
	await checkResponse(resp, url)

	const data: unknown = await resp.json().catch(() => undefined)
	return mapWorkspace(data, endpoint)
}

/**
 * Create a workspace. Server generates the alias (like kap) — there is no
 * client-side name input. Returns the created workspace (status likely
 * "initializing"; callers may poll getWorkspace until "active").
 */
export async function createWorkspace(
	apiKey: string,
	options: WorkspaceCommandOptions & { description?: string },
): Promise<Workspace> {
	const fetchImpl = options?.fetch ?? globalThis.fetch
	const endpoint = resolveEndpoint(options)
	const orgId = await resolveOrgId(apiKey, options)

	const url = `${endpoint}/ai-optimizer/v1beta/organizations/${encodeURIComponent(orgId)}/workspaces`
	const resp = await fetchWithTimeout(
		url,
		{
			method: "POST",
			headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
			body: JSON.stringify({
				...(options.description ? { description: options.description } : {}),
				clientType: HARNESS_CLIENT_TYPE,
			}),
		},
		fetchImpl,
		30_000,
		options?.signal,
	)
	await checkResponse(resp, url)

	const data: unknown = await resp.json().catch(() => undefined)
	return mapWorkspace(data, endpoint)
}

export async function deleteWorkspace(apiKey: string, id: string, options?: WorkspaceCommandOptions): Promise<void> {
	const fetchImpl = options?.fetch ?? globalThis.fetch
	const endpoint = resolveEndpoint(options)
	const orgId = await resolveOrgId(apiKey, options)

	const url = `${endpoint}/ai-optimizer/v1beta/organizations/${encodeURIComponent(orgId)}/workspaces/${encodeURIComponent(id)}`
	const resp = await fetchWithTimeout(
		url,
		{ method: "DELETE", headers: { Authorization: `Bearer ${apiKey}` } },
		fetchImpl,
		30_000,
		options?.signal,
	)
	await checkResponse(resp, url)
}

export function mapWorkspace(raw: unknown, endpoint: string): Workspace {
	if (typeof raw !== "object" || raw === null) {
		throw new RemoteNetworkError(`Invalid workspace entry in response from ${endpoint}`)
	}
	const r = raw as Record<string, unknown>

	const id = typeof r.id === "string" && r.id.length > 0 ? r.id : undefined
	if (!id) {
		throw new RemoteNetworkError(`Missing workspace id in response from ${endpoint}`)
	}

	const uri = typeof r.uri === "string" && r.uri.length > 0 ? r.uri : undefined
	const alias = uri?.split(".")[0] || id

	let createdAt: Date | undefined
	if (typeof r.createTime === "string") {
		const parsed = new Date(r.createTime)
		if (!Number.isNaN(parsed.getTime())) createdAt = parsed
	}

	let host: string | undefined
	if (uri) {
		try {
			host = new URL(uri.includes("://") ? uri : `wss://${uri}`).hostname
		} catch {
			host = undefined // tolerate URIs URL can't parse — host is display-only here
		}
	}

	// Provisioned sizes arrive nested under spec.resources as Kubernetes
	// quantity strings ("200m", "512Mi", "10Gi").
	const spec = typeof r.spec === "object" && r.spec !== null ? (r.spec as Record<string, unknown>) : undefined
	const res =
		spec && typeof spec.resources === "object" && spec.resources !== null
			? (spec.resources as Record<string, unknown>)
			: undefined

	return {
		id,
		alias,
		description: typeof r.description === "string" ? r.description : "",
		status: mapWorkspaceStatus(r.status),
		uri,
		host,
		createdAt: createdAt ?? new Date(0),
		cluster: typeof r.cluster === "string" ? r.cluster : "",
		clientType: typeof r.clientType === "string" ? r.clientType : "",
		cpuMillicores: cpuQuantityToMillicores(res?.cpu),
		ramBytes: byteQuantityToBytes(res?.memory),
		pvcSizeBytes: byteQuantityToBytes(res?.pvcSize),
	}
}

function mapWorkspaceStatus(raw: unknown): WorkspaceStatus {
	switch (raw) {
		case "ACTIVE":
			return "active"
		case "INITIALIZING":
			return "initializing"
		case "SUSPENDED":
			return "suspended"
		case "DELETING":
			return "deleting"
		case "TERMINATED":
			return "terminated"
		default:
			// Unknown statuses read as terminated, not "idle": dead workspaces
			// are the dominant unknown the API reports.
			return "terminated"
	}
}
