import { guardCommand } from "./guard.js"
import { runLogin } from "./login.js"
import { runLogout } from "./logout.js"
import { runVersion } from "./version.js"
import { runWhoami } from "./whoami.js"

/**
 * Shape mirrors kimchi-dev's `src/commands/registry.ts` CommandDefinition so
 * the harness bridge can mount kimchictl commands without adaptation.
 */
export interface CommandDefinition {
	name: string
	summary: string
	/** Hidden commands stay functional but are omitted from help (internal bridges like `ssh proxy`). */
	hidden?: boolean
	/** Run this command. Receives args after the command name. Return the exit code; undefined means 0. */
	run: (args: string[]) => Promise<number | undefined> | number | undefined
}

export const COMMANDS: CommandDefinition[] = [
	{ name: "login", summary: "Authenticate via browser (shared with the kimchi harness)", run: guardCommand(runLogin) },
	{ name: "logout", summary: "Sign out everywhere (also signs out the harness)", run: guardCommand(runLogout) },
	{ name: "whoami", summary: "Show the authenticated user", run: guardCommand(runWhoami) },
	{ name: "version", summary: "Print the kimchictl version", run: runVersion },
]

export function findCommand(name: string): CommandDefinition | undefined {
	return COMMANDS.find((c) => c.name === name)
}

export function isKnownCommand(name: string | undefined): boolean {
	return name !== undefined && COMMANDS.some((c) => c.name === name)
}
