import type { CommandDefinition } from "./registry.js"

/** Print top-level usage. Hidden commands are deliberately omitted. */
export function printHelp(commands: readonly CommandDefinition[], log: (line: string) => void = console.log): void {
	log(`kimchictl — manage kimchi remote workspaces
`)
	log(`Usage:
  kimchictl <command> [options]
`)
	log(`Commands:`)
	const visible = commands.filter((c) => !c.hidden)
	const width = Math.max(...visible.map((c) => c.name.length))
	for (const command of visible) {
		log(`  ${command.name.padEnd(width)}  ${command.summary}`)
	}
	log(`
Global flags:
  -h, --help     Show this help
  -v, --version  Print the version`)
}
