import { type ParseArgsOptionsConfig, parseArgs } from "node:util"

/** Bad CLI input — surfaced with exit code 2, distinct from runtime failures (1). */
export class UsageError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "UsageError"
	}
}

export type FlagValues = Record<string, string | boolean | undefined>

/**
 * Strict flag parsing with a uniform usage-error shape across commands.
 * Values keep their raw type (declared options are TypeScript-blind here —
 * narrow at the call site, relying on the declared option `type`).
 */
export function parseFlags(
	command: string,
	args: string[],
	options: ParseArgsOptionsConfig,
): { values: FlagValues; positionals: string[] } {
	try {
		const parsed = parseArgs({ args, options, strict: true, allowPositionals: true })
		return { values: parsed.values as FlagValues, positionals: parsed.positionals }
	} catch (err) {
		throw new UsageError(`kimchictl ${command}: ${err instanceof Error ? err.message : String(err)}`)
	}
}
