import type { ApiOptions } from "./types.js"
import { RemoteAuthError } from "./types.js"
import { getWorkspace, type Workspace } from "./workspaces.js"

/**
 * Poll getWorkspace until the workspace is ACTIVE or the deadline passes.
 * Shared by `workspace create` (post-create wait) and `ssh` (post-resume
 * wait) — kap's 2s cadence, deadline-based, progress via onTick.
 *
 * Transient get failures (the workspace is still registering with the
 * control plane) are tolerated until the deadline; auth failures abort.
 */
export async function waitForWorkspaceActive(
	apiKey: string,
	id: string,
	options: ApiOptions & {
		timeoutMs: number
		pollMs?: number
		sleep?: (ms: number) => Promise<void>
		onTick?: (elapsedSeconds: number) => void
	},
): Promise<Workspace> {
	const pollMs = options.pollMs ?? 2000
	const sleep = options.sleep ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)))

	const start = Date.now()
	const deadline = start + options.timeoutMs
	let current: Workspace | undefined
	while (Date.now() < deadline) {
		await sleep(pollMs)
		options.onTick?.(Math.round((Date.now() - start) / 1000))
		try {
			current = await getWorkspace(apiKey, id, options)
		} catch (err) {
			if (err instanceof RemoteAuthError) throw err
			continue
		}
		if (current.status === "active") break
	}
	if (!current) {
		// Every poll failed; fetch once without tolerance so the real error surfaces.
		current = await getWorkspace(apiKey, id, options)
	}
	return current
}
