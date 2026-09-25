import { printHelp } from "./commands/help.js"
import { COMMANDS, findCommand } from "./commands/registry.js"
import { VERSION } from "./version.js"

/** Usage errors (unknown command, bad flags) exit with this code. */
export const EXIT_USAGE = 2

/**
 * Shared CLI dispatcher — the single entry behind the standalone `kimchictl`
 * binary, the npm bin shim, and the kimchi harness bridge (`kimchi workspace`).
 * Returns the exit code instead of calling process.exit so hosts can run it
 * in-process.
 */
export async function run(argv: readonly string[]): Promise<number> {
	const [head, ...rest] = argv

	if (head === undefined || head === "help" || head === "--help" || head === "-h") {
		printHelp(COMMANDS)
		return 0
	}
	if (head === "--version" || head === "-v") {
		console.log(`kimchictl ${VERSION}`)
		return 0
	}

	const command = findCommand(head)
	if (!command) {
		console.error(`kimchictl: unknown command "${head}"`)
		printHelp(COMMANDS, (line) => console.error(line))
		return EXIT_USAGE
	}

	return (await command.run(rest)) ?? 0
}
