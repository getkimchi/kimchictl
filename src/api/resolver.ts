import type { ApiOptions } from "./types.js"
import { RemoteAuthError } from "./types.js"
import { getWorkspace, listWorkspaces, type Workspace, type WorkspaceCommandOptions } from "./workspaces.js"

/**
 * Workspace reference resolution — a port of kap's internal/resolver.
 *
 * Users type the alias (the first DNS label of the workspace URI) or a
 * prefix of it; the control plane addresses workspaces by UUID. Resolution:
 *   1. UUID-shaped refs go straight to GET (404 → not found).
 *   2. Anything else lists workspaces and matches, in order:
 *      exact id, exact alias, case-insensitive alias prefix.
 *   3. No match → WorkspaceNotFoundError; multiple matches →
 *      AmbiguousWorkspaceError listing the candidates.
 *
 * kap caches the list for 30s — pointless in a one-shot CLI process, so
 * this port is uncached.
 */

export class WorkspaceNotFoundError extends Error {
	constructor(ref: string) {
		super(`No workspace matches "${ref}" — list workspaces with: kimchictl workspace list`)
		this.name = "WorkspaceNotFoundError"
	}
}

export class AmbiguousWorkspaceError extends Error {
	constructor(ref: string, candidates: readonly string[]) {
		super(`Multiple workspaces match "${ref}": ${candidates.join(", ")} — use the full alias`)
		this.name = "AmbiguousWorkspaceError"
	}
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export function isWorkspaceUuid(ref: string): boolean {
	return UUID_RE.test(ref)
}

function matchesRef(ws: Workspace, ref: string): boolean {
	if (ws.id === ref) return true
	if (ws.alias === ref) return true
	return ws.alias.toLowerCase().startsWith(ref.toLowerCase())
}

/** Resolve a workspace reference (UUID, alias, or alias prefix) to the workspace. */
export async function resolveWorkspace(
	apiKey: string,
	ref: string,
	options?: WorkspaceCommandOptions & ApiOptions,
): Promise<Workspace> {
	if (isWorkspaceUuid(ref)) {
		try {
			return await getWorkspace(apiKey, ref, options)
		} catch (err) {
			if (err instanceof RemoteAuthError && err.statusCode === 404) {
				throw new WorkspaceNotFoundError(ref)
			}
			throw err
		}
	}

	const workspaces = await listWorkspaces(apiKey, options)
	const matched = workspaces.filter((ws) => matchesRef(ws, ref))
	const [unique] = matched
	if (matched.length === 1 && unique) return unique
	if (matched.length === 0) throw new WorkspaceNotFoundError(ref)
	throw new AmbiguousWorkspaceError(
		ref,
		matched.map((ws) => ws.alias),
	)
}
