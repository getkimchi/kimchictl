import { TemplatesUnavailableError } from "../api/templates.js"
import { RemoteAuthError, RemoteNetworkError } from "../api/types.js"
import { ModelsFetchError } from "../auth/models-providers.js"
import { NotLoggedInError } from "../auth/resolve.js"
import { BridgeError } from "../ssh/bridge.js"
import { UsageError } from "./flags.js"

/**
 * Convert known domain errors into a clean message + exit code instead of a
 * stack trace. Unknown errors rethrow so real bugs stay loud.
 * A wrapped handler still fits CommandDefinition["run"] (deps optional).
 *
 *   ✗ <message>            → 1  (auth/network/usage-state errors)
 *   kimchictl cmd: <usage> → 2  (flag parsing)
 */
export function guardCommand<TDeps>(
	handler: (args: string[], deps?: TDeps) => Promise<number>,
): (args: string[], deps?: TDeps) => Promise<number> {
	return async (args, deps) => {
		try {
			return await handler(args, deps)
		} catch (err) {
			if (err instanceof UsageError) {
				console.error(err.message)
				return 2
			}
			if (
				err instanceof NotLoggedInError ||
				err instanceof ModelsFetchError ||
				err instanceof TemplatesUnavailableError ||
				err instanceof BridgeError ||
				err instanceof RemoteAuthError ||
				err instanceof RemoteNetworkError
			) {
				console.error(`✗ ${err.message}`)
				return 1
			}
			throw err
		}
	}
}
