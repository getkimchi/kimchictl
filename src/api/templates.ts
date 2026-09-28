import { checkResponse, fetchWithTimeout, resolveEndpoint } from "./http.js"
import { verifyApiKey } from "./keys.js"
import type { ApiOptions } from "./types.js"
import { RemoteNetworkError } from "./types.js"

/**
 * Workspace-template client — read-only surface against the
 * WorkspaceTemplatesAPI (proto: workspacetemplates_api.proto).
 *
 * Templates are named, organization-scoped presets of workspace creation
 * parameters (resources, dependencies, egress policy, init script). They are
 * curated by admins; `workspace create --template <name>` resolves them.
 */

export interface WorkspaceTemplateSpec {
	resources?: {
		cpu?: string
		memory?: string
		pvcSize?: string
	}
	dependencies?: string[]
	egressPolicy?: {
		denyByDefault?: boolean
		allowed?: string[]
		denied?: string[]
	}
	initScript?: string
}

export interface WorkspaceTemplate {
	id: string
	organizationId: string
	name: string
	description: string
	spec?: WorkspaceTemplateSpec
	createdBy: string
	updatedBy: string
	createTime: Date
	updateTime: Date
}

export interface WorkspaceTemplateOptions extends ApiOptions {
	orgId?: string
}

async function resolveOrgId(apiKey: string, options?: WorkspaceTemplateOptions): Promise<string> {
	return options?.orgId ?? (await verifyApiKey(apiKey, options))
}

export class TemplateNotFoundError extends Error {
	constructor(ref: string) {
		super(`No workspace template matches "${ref}" — list with: kimchictl workspace templates list`)
		this.name = "TemplateNotFoundError"
	}
}

export class AmbiguousTemplateError extends Error {
	constructor(ref: string, candidates: string[]) {
		super(`Multiple workspace templates match "${ref}": ${candidates.join(", ")} — use the full name`)
		this.name = "AmbiguousTemplateError"
	}
}

/** Input shape for creating a template — a subset of WorkspaceTemplate. */
export interface CreateTemplateInput {
	name: string
	description?: string
	spec?: WorkspaceTemplateSpec
}

export async function createWorkspaceTemplate(
	apiKey: string,
	input: CreateTemplateInput,
	options?: WorkspaceTemplateOptions,
): Promise<WorkspaceTemplate> {
	const fetchImpl = options?.fetch ?? globalThis.fetch
	const endpoint = resolveEndpoint(options)
	const orgId = await resolveOrgId(apiKey, options)

	const body: Record<string, unknown> = { name: input.name }
	if (input.description) body.description = input.description
	if (input.spec) body.spec = input.spec

	const url = `${endpoint}/ai-optimizer/v1beta/organizations/${encodeURIComponent(orgId)}/workspace-templates`
	const resp = await fetchWithTimeout(
		url,
		{
			method: "POST",
			headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
			body: JSON.stringify(body),
		},
		fetchImpl,
		30_000,
		options?.signal,
	)
	await checkResponse(resp, url)

	const data: unknown = await resp.json().catch(() => undefined)
	return mapWorkspaceTemplate(data, endpoint)
}

export async function listWorkspaceTemplates(
	apiKey: string,
	options?: WorkspaceTemplateOptions,
): Promise<WorkspaceTemplate[]> {
	const fetchImpl = options?.fetch ?? globalThis.fetch
	const endpoint = resolveEndpoint(options)
	const orgId = await resolveOrgId(apiKey, options)

	const params = new URLSearchParams()
	params.set("page.limit", "200")

	const url = `${endpoint}/ai-optimizer/v1beta/organizations/${encodeURIComponent(orgId)}/workspace-templates?${params}`
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
		throw new RemoteNetworkError(`Unexpected response from ${endpoint}`)
	}
	const items = (data as { items?: unknown }).items
	if (!Array.isArray(items)) {
		throw new RemoteNetworkError(`Missing items array in workspace-templates response from ${endpoint}`)
	}
	return items.map((item) => mapWorkspaceTemplate(item, endpoint))
}

export async function getWorkspaceTemplate(
	apiKey: string,
	id: string,
	options?: WorkspaceTemplateOptions,
): Promise<WorkspaceTemplate> {
	const fetchImpl = options?.fetch ?? globalThis.fetch
	const endpoint = resolveEndpoint(options)
	const orgId = await resolveOrgId(apiKey, options)

	const url = `${endpoint}/ai-optimizer/v1beta/organizations/${encodeURIComponent(orgId)}/workspace-templates/${encodeURIComponent(id)}`
	const resp = await fetchWithTimeout(
		url,
		{ method: "GET", headers: { Authorization: `Bearer ${apiKey}` } },
		fetchImpl,
		30_000,
		options?.signal,
	)
	await checkResponse(resp, url)

	const data: unknown = await resp.json().catch(() => undefined)
	return mapWorkspaceTemplate(data, endpoint)
}

function mapWorkspaceTemplate(raw: unknown, endpoint: string): WorkspaceTemplate {
	if (typeof raw !== "object" || raw === null) {
		throw new RemoteNetworkError(`Invalid workspace-template entry in response from ${endpoint}`)
	}
	const r = raw as Record<string, unknown>

	const id = typeof r.id === "string" && r.id.length > 0 ? r.id : undefined
	if (!id) {
		throw new RemoteNetworkError(`Missing workspace-template id in response from ${endpoint}`)
	}

	let createTime: Date = new Date(0)
	if (typeof r.createTime === "string") {
		const parsed = new Date(r.createTime)
		if (!Number.isNaN(parsed.getTime())) createTime = parsed
	}
	let updateTime: Date = new Date(0)
	if (typeof r.updateTime === "string") {
		const parsed = new Date(r.updateTime)
		if (!Number.isNaN(parsed.getTime())) updateTime = parsed
	}

	return {
		id,
		organizationId: typeof r.organizationId === "string" ? r.organizationId : "",
		name: typeof r.name === "string" ? r.name : "",
		description: typeof r.description === "string" ? r.description : "",
		spec: mapTemplateSpec(r.spec),
		createdBy: typeof r.createdBy === "string" ? r.createdBy : "",
		updatedBy: typeof r.updatedBy === "string" ? r.updatedBy : "",
		createTime,
		updateTime,
	}
}

function mapTemplateSpec(raw: unknown): WorkspaceTemplateSpec | undefined {
	if (typeof raw !== "object" || raw === null) return undefined
	const s = raw as Record<string, unknown>

	const spec: WorkspaceTemplateSpec = {}

	if (typeof s.resources === "object" && s.resources !== null) {
		const res = s.resources as Record<string, unknown>
		spec.resources = {
			cpu: typeof res.cpu === "string" ? res.cpu : undefined,
			memory: typeof res.memory === "string" ? res.memory : undefined,
			pvcSize: typeof res.pvcSize === "string" ? res.pvcSize : undefined,
		}
	}

	if (Array.isArray(s.dependencies)) {
		spec.dependencies = s.dependencies.filter((d): d is string => typeof d === "string")
	}

	if (typeof s.egressPolicy === "object" && s.egressPolicy !== null) {
		const eg = s.egressPolicy as Record<string, unknown>
		spec.egressPolicy = {
			denyByDefault: typeof eg.denyByDefault === "boolean" ? eg.denyByDefault : undefined,
			allowed: Array.isArray(eg.allowed) ? eg.allowed.filter((d): d is string => typeof d === "string") : undefined,
			denied: Array.isArray(eg.denied) ? eg.denied.filter((d): d is string => typeof d === "string") : undefined,
		}
	}

	if (typeof s.initScript === "string") {
		spec.initScript = s.initScript
	}

	return Object.keys(spec).length > 0 ? spec : undefined
}
