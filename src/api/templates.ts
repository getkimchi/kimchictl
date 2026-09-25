/**
 * Server-side workspace templates — PLACEHOLDER.
 *
 * Templates are created and stored in the API (they are not local files).
 * The API contract is being finalised server-side; until it lands,
 * `workspace create --template <name>` is accepted at the CLI and fails here
 * with a graceful, actionable error instead of a 4xx surprise.
 */

export class TemplatesUnavailableError extends Error {
	constructor(templateName: string) {
		super(
			`Workspace templates are not available yet (requested "${templateName}") — ` +
				`the templates API is being finalised. Omit --template for now.`,
		)
		this.name = "TemplatesUnavailableError"
	}
}

/**
 * Resolve a template name to its create-time parameters.
 *
 * TODO(templates-api): replace with the real call once the contract lands —
 * expected to return resources/dependencies applied at create time.
 */
export function resolveTemplate(templateName: string): never {
	throw new TemplatesUnavailableError(templateName)
}
