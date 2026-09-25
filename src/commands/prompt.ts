import { createInterface } from "node:readline/promises"

/** True when an interactive prompt can be shown (both streams are terminals). */
export function isInteractive(): boolean {
	return Boolean(process.stdin.isTTY && process.stdout.isTTY)
}

/**
 * Ask a y/N question on the TTY. Anything but exactly "y" or "yes"
 * (case-insensitive) counts as no. Only call when isInteractive() — callers
 * must supply the non-interactive fallback (`--force` hint or a default).
 */
export async function confirm(question: string): Promise<boolean> {
	const rl = createInterface({ input: process.stdin, output: process.stdout })
	try {
		const answer = await rl.question(question)
		return /^(y|yes)$/i.test(answer.trim())
	} finally {
		rl.close()
	}
}
