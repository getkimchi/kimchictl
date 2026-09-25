import { resolveWorkspace, WorkspaceNotFoundError } from "./api/resolver.js"
import { formatAge, formatBytes, formatMillicores } from "./api/resources.js"
import { listWorkspaces } from "./api/workspaces.js"
import { NotLoggedInError, requireApiKey } from "./auth/resolve.js"
import { formatTable } from "./commands/table.js"

/**
 * pi extension entry — `kimchi install npm:@kimchi-dev/kimchictl` loads this
 * module and registers the in-session `/workspace` command.
 *
 * The package serves three surfaces off one engine:
 *   - standalone CLI: `kimchictl workspace …` (src/cli.ts)
 *   - compiled-in harness subcommand: `kimchi workspace …` (kimchi-dev's
 *     commands/workspace.ts bridge imports the exported runners)
 *   - this runtime extension: `/workspace list|get` inside a session
 *
 * The in-session surface is deliberately read-only: create waits on
 * provisioning and delete prompts for confirmation — both are interactive
 * flows that belong to a terminal (the CLI), not a TUI command handler.
 */

/**
 * Structural subset of pi's ExtensionAPI — avoids depending on
 * @earendil-works/pi-coding-agent in this standalone package. The CLI never
 * imports this module; the extension only runs inside a harness/pi process,
 * where the real API satisfies this shape.
 */
interface PiCommandContext {
	ui: {
		notify: (message: string, type?: "info" | "warning" | "error") => void
	}
}

export type { PiCommandContext }

interface PiExtensionApi {
	registerCommand: (
		name: string,
		options: {
			description?: string
			handler: (args: string, ctx: PiCommandContext) => Promise<void>
		},
	) => void
}

const USAGE = "usage: /workspace list [--output table|json]  |  /workspace get <name>"

const CLI_HINT = "run `kimchictl workspace …` in a terminal (or `kimchi workspace …` once the harness bridge ships)"

/** Build the /workspace handler; deps are injectable for tests. */
export function createWorkspaceCommandHandler(deps: { fetch?: typeof globalThis.fetch } = {}) {
	return async (args: string, ctx: PiCommandContext): Promise<void> => {
		const notify = ctx.ui.notify.bind(ctx.ui)
		const argv = args.trim().split(/\s+/).filter(Boolean)
		const [verb, ...rest] = argv

		try {
			switch (verb) {
				case "list":
				case "ls":
					await handleList(rest, notify, deps)
					return
				case "get":
					await handleGet(rest, notify, deps)
					return
				case "create":
				case "delete":
				case "rm":
					notify(`create/delete are interactive flows — ${CLI_HINT}`, "warning")
					return
				case undefined:
					notify(USAGE, "warning")
					return
				default:
					notify(`unknown verb "${verb}"\n${USAGE}`, "error")
			}
		} catch (err) {
			if (err instanceof NotLoggedInError) {
				notify("Not logged in — run `kimchi login` in a terminal first.", "error")
				return
			}
			const message = err instanceof Error ? err.message : String(err)
			notify(`✗ ${message}`, "error")
		}
	}
}

async function handleList(
	args: string[],
	notify: (message: string, type?: "info" | "warning" | "error") => void,
	deps: { fetch?: typeof globalThis.fetch },
): Promise<void> {
	const json = args.includes("--output") && args[args.indexOf("--output") + 1] === "json"
	if (args.some((a) => a.startsWith("--")) && !json) {
		notify("only --output json is supported in-session; the table is the default", "warning")
	}

	const { key } = requireApiKey()
	const workspaces = await listWorkspaces(key, { fetch: deps.fetch })

	if (json) {
		notify(
			JSON.stringify(
				workspaces.map((w) => ({
					id: w.id,
					alias: w.alias,
					status: w.status,
					uri: w.uri,
					createdAt: w.createdAt.getTime() > 0 ? w.createdAt.toISOString() : undefined,
				})),
				null,
				2,
			),
		)
		return
	}

	const now = new Date()
	const rows = workspaces.map((w) => [
		w.alias,
		w.status,
		formatMillicores(w.cpuMillicores),
		formatBytes(w.ramBytes),
		formatAge(w.createdAt, now),
	])
	notify(formatTable(["NAME", "STATUS", "CPU", "MEMORY", "AGE"], rows))
}

async function handleGet(
	args: string[],
	notify: (message: string, type?: "info" | "warning" | "error") => void,
	deps: { fetch?: typeof globalThis.fetch },
): Promise<void> {
	const name = args.find((a) => !a.startsWith("--"))
	if (!name || args.filter((a) => !a.startsWith("--")).length > 1) {
		notify("usage: /workspace get <name>  (alias, alias prefix, or UUID)", "warning")
		return
	}

	const { key } = requireApiKey()
	const workspace = await resolveWorkspace(key, name, { fetch: deps.fetch })

	const lines = [
		`name:    ${workspace.alias}`,
		`status:  ${workspace.status}`,
		workspace.uri ? `uri:     ${workspace.uri}` : undefined,
		`cpu:     ${formatMillicores(workspace.cpuMillicores)}`,
		`memory:  ${formatBytes(workspace.ramBytes)}`,
	].filter((line): line is string => line !== undefined)
	notify(lines.join("\n"))
}

/** pi extension factory — referenced from package.json's `pi.extensions` field. */
export default function kimchictlExtension(pi: PiExtensionApi): void {
	pi.registerCommand("workspace", {
		description: "kimchi remote workspaces: list | get <name> (create/delete: use the CLI)",
		handler: createWorkspaceCommandHandler(),
	})
}

// Re-exported for consumers that want to surface the same error type.
export { WorkspaceNotFoundError }
