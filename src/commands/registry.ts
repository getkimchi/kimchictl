import { runVersion } from "./version.js"

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
	{ name: "version", summary: "Print the kimchictl version", run: runVersion },
]

export function findCommand(name: string): CommandDefinition | undefined {
	return COMMANDS.find((c) => c.name === name)
}

export function isKnownCommand(name: string | undefined): boolean {
	return name !== undefined && COMMANDS.some((c) => c.name === name)
}
