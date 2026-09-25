/**
 * Control-plane client types — mirror of the harness's
 * kimchi-dev:src/sandbox/cloud types (trimmed to what kimchictl v1 needs).
 */

export class RemoteAuthError extends Error {
	constructor(
		message: string,
		public readonly statusCode: number,
	) {
		super(message)
		this.name = "RemoteAuthError"
	}
}

export class RemoteNetworkError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "RemoteNetworkError"
	}
}

/**
 * Thrown when the control plane rejects a request because the user's
 * resource quota is exhausted (HTTP 429 with a quota body). The message is
 * already user-facing — surface verbatim.
 */
export class RemoteQuotaError extends RemoteNetworkError {
	constructor(
		message: string,
		public readonly statusCode: number,
	) {
		super(message)
		this.name = "RemoteQuotaError"
	}
}

export interface ApiOptions {
	/**
	 * Override the cloud API endpoint. Resolution order:
	 *   1. this option
	 *   2. KIMCHI_REMOTE_ENDPOINT env var
	 *   3. production default https://app.kimchi.dev/api
	 */
	endpoint?: string
	/** Override global fetch (tests). */
	fetch?: typeof globalThis.fetch
	/** External abort signal. */
	signal?: AbortSignal
}
