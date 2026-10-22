/**
 * Browser login — ported from the kimchi harness (kimchi-dev:src/cli-auth/):
 * transient 127.0.0.1 callback server → open `webApp/cli-auth?callback=…&state=…`
 * → web app delivers the API key back to the callback. Same URL grammar and
 * state-CSRF validation so both tools can drive the same web flow.
 *
 * The server also serves the CAST AI SSO flow (`mode: "code"`): the Auth0
 * redirect delivers an OAuth Authorization Code instead of a token, on the
 * fixed registered port `http://localhost:8765/callback` — mirroring the
 * harness's consolidated src/cli-auth/callback-server.ts.
 */

import { randomBytes } from "node:crypto"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import open from "open"

const CALLBACK_PATH = "/callback"
const CALLBACK_TIMEOUT_MS = 300_000 // 5 minutes, mirrors the harness
const SUCCESS_MESSAGE = "Your CLI is now connected. You can close this window and return to kimchictl."

const DEFAULT_WEB_APP_URL = "https://app.kimchi.dev"

/** Web app base URL: KIMCHI_WEB_APP_URL override, default https://app.kimchi.dev. */
export function resolveWebAppUrl(options?: { webAppUrl?: string }): string {
	return options?.webAppUrl ?? process.env.KIMCHI_WEB_APP_URL ?? DEFAULT_WEB_APP_URL
}

export type CallbackMode = "token" | "code"

/** The fixed loopback port the CAST AI Auth0 application registers as its
 * redirect URI (`http://localhost:8765/callback`) — same constant as the
 * harness's src/cli-auth/callback-server.ts. */
export const CAST_AI_SSO_CALLBACK_PORT = 8765

/** Human-readable guidance when the fixed port is taken (another Kimchi
 * sign-in is mid-flight on this machine). */
export function callbackPortInUseError(port: number): Error {
	return new Error(
		`Port ${port} is in use, probably by an unfinished CAST AI sign-in in another Kimchi session. Cancel that sign-in and try again.`,
	)
}

export interface CallbackServerOptions {
	/** What the callback URL delivers. Defaults to "token" (legacy key
	 * handoff); the SSO flow passes "code" (OAuth Authorization Code). */
	mode?: CallbackMode
	/** Copy shown on the success page (mode: "code" only). */
	successMessage?: string
	/** Port selection: `{ kind: "fixed", value }` binds a specific port (the
	 * SSO redirect URI); the default/ephemeral binds :0 like before. */
	port?: { kind: "fixed"; value: number } | { kind: "ephemeral" }
}

export interface CallbackResult {
	/** OAuth Authorization Code flow: the `code` query param. */
	code?: string
	/** Legacy `castai_v1_` key handoff: the `token` query param. */
	token?: string
	error?: string
	/** RFC 6749 `error` value when the IdP returned one (OAuth flows only). */
	errorCode?: string
}

export interface CallbackServer {
	port: number
	url: string
	result: Promise<CallbackResult>
	close: () => void
}

export function generateState(): string {
	return randomBytes(32).toString("hex")
}

function escapeHtml(text: string): string {
	return text
		.replaceAll("&", "&amp;")
		.replaceAll("<", "&lt;")
		.replaceAll(">", "&gt;")
		.replaceAll('"', "&quot;")
		.replaceAll("'", "&#39;")
}

function pageHtml(title: string, heading: string, message: string, ok: boolean): string {
	const color = ok ? "#16a34a" : "#dc2626"
	return `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>${escapeHtml(title)}</title>
<style>body{font-family:system-ui,sans-serif;display:flex;min-height:100vh;margin:0;align-items:center;justify-content:center;background:#fafafa}
main{max-width:28rem;padding:2rem;text-align:center}h1{color:${color};font-size:1.25rem}p{color:#444}</style></head>
<body><main><h1>${escapeHtml(heading)}</h1><p>${escapeHtml(message)}</p></main></body></html>`
}

const successHtml = (message: string) => pageHtml("Login successful", "Login successful", message, true)
const errorHtml = (title: string, message: string) => pageHtml(title, title, message, false)

/**
 * Start a temporary HTTP server on 127.0.0.1 to receive the callback from
 * the browser — the API-key handoff (token) or the OAuth code, picked by
 * `mode`. Validates the state parameter against CSRF; times out after
 * 5 minutes.
 */
export function startCallbackServer(
	expectedState: string,
	options: CallbackServerOptions = {},
): Promise<CallbackServer> {
	const mode: CallbackMode = options.mode ?? "token"
	return new Promise<CallbackServer>((resolveStart, rejectStart) => {
		let server: Server | undefined
		let resolved = false
		let timeoutTimer: ReturnType<typeof setTimeout> | undefined
		let resolveResult: ((r: CallbackResult) => void) | undefined

		function finish(result: CallbackResult) {
			if (resolved) return
			resolved = true
			if (timeoutTimer) clearTimeout(timeoutTimer)
			resolveResult?.(result)
			// Defer socket destruction so the HTTP response has time to flush
			setTimeout(closeServer, 100)
		}

		function closeServer() {
			if (!server) return
			try {
				server.closeAllConnections?.()
				server.close()
			} catch {
				// Already closing or closed — safe to ignore
			}
			server = undefined
		}

		function onRequest(req: IncomingMessage, res: ServerResponse) {
			try {
				const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`)

				const remote = req.socket.remoteAddress ?? ""
				if (!(remote.startsWith("127.") || remote === "::1" || remote === "::ffff:127.0.0.1")) {
					res.writeHead(403, { "Content-Type": "text/html", Connection: "close" })
					res.end(errorHtml("Forbidden", "Only localhost connections are allowed."))
					return
				}

				if (url.pathname !== CALLBACK_PATH) {
					res.writeHead(404, { "Content-Type": "text/plain", Connection: "close" })
					res.end("Not found")
					return
				}

				// Validate state parameter for CSRF protection. OAuth flows surface
				// the standard RFC 6749 wording ("state mismatch") so callers can
				// match on it; the legacy token handoff keeps its gentler copy.
				const state = url.searchParams.get("state")
				if (!state || state !== expectedState) {
					const errorMsg =
						mode === "code"
							? "OAuth state mismatch — the sign-in attempt was rejected for your protection"
							: "This request isn't valid. Please try logging in again from your terminal."
					const heading = mode === "code" ? "Sign-in failed" : "Login error"
					res.writeHead(400, { "Content-Type": "text/html", Connection: "close" })
					res.end(errorHtml(heading, errorMsg))
					finish({ error: errorMsg })
					return
				}

				const error = url.searchParams.get("error")
				if (error) {
					const errorMsg = url.searchParams.get("error_description") || error
					res.writeHead(200, { "Content-Type": "text/html", Connection: "close" })
					res.end(errorHtml("Authentication failed", errorMsg))
					// The RFC 6749 error code is only consumed by the OAuth flow;
					// the legacy token handoff keeps its exact historical shape.
					finish(mode === "code" ? { error: errorMsg, errorCode: error } : { error: errorMsg })
					return
				}

				// Extract the deliverable (token or code) based on the flow mode.
				const deliverable = mode === "code" ? url.searchParams.get("code") : url.searchParams.get("token")
				if (!deliverable) {
					const errorMsg =
						mode === "code"
							? "Missing authorization code in the OAuth callback"
							: "No token was returned by the authentication server"
					const pageTitle = mode === "code" ? "Missing code" : "Missing token"
					res.writeHead(400, { "Content-Type": "text/html", Connection: "close" })
					res.end(errorHtml(pageTitle, errorMsg))
					finish({ error: errorMsg })
					return
				}

				res.writeHead(200, { "Content-Type": "text/html", Connection: "close" })
				res.end(successHtml(mode === "code" ? (options.successMessage ?? SUCCESS_MESSAGE) : SUCCESS_MESSAGE))
				finish(mode === "code" ? { code: deliverable } : { token: deliverable })
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err)
				res.writeHead(500, { "Content-Type": "text/plain", Connection: "close" })
				res.end("Internal server error")
				finish({ error: `Unexpected server error: ${message}` })
				req.socket.destroy()
			}
		}

		server = createServer(onRequest)

		const portSelection = options.port ?? { kind: "ephemeral" as const }
		const fixedPort = portSelection.kind === "fixed" ? portSelection.value : 0

		server.once("error", (err) => {
			if (
				portSelection.kind === "fixed" &&
				err &&
				"code" in err &&
				(err as NodeJS.ErrnoException).code === "EADDRINUSE"
			) {
				closeServer()
				rejectStart(callbackPortInUseError(fixedPort))
				return
			}
			closeServer()
			rejectStart(err)
		})

		server.listen(fixedPort, "127.0.0.1", () => {
			const addr = server?.address()
			if (!addr || typeof addr === "string") {
				closeServer()
				rejectStart(new Error("Could not determine callback server port"))
				return
			}

			const port = addr.port

			timeoutTimer = setTimeout(() => {
				finish({ error: "Browser login timed out — please try again" })
			}, CALLBACK_TIMEOUT_MS)

			const resultPromise = new Promise<CallbackResult>((resolve) => {
				resolveResult = resolve
			})

			resolveStart({
				port,
				// OAuth flows must advertise `localhost` (the Auth0-registered
				// redirect URI host) so the IdP's exact-string-match on the
				// callback succeeds; the legacy token handoff keeps the raw
				// loopback IP, matching its pre-OAuth wiring.
				url: `http://${mode === "code" ? "localhost" : "127.0.0.1"}:${port}${CALLBACK_PATH}`,
				result: resultPromise,
				close: () => {
					finish({ error: "Login cancelled" })
				},
			})
		})
	})
}

export interface BrowserAuthOptions {
	/** Base URL of the Kimchi web app (default: https://app.kimchi.dev; env: KIMCHI_WEB_APP_URL) */
	webAppUrl?: string
	/** Abort the flow (tears down the callback server early). */
	signal?: AbortSignal
	/** Invoked with the browser URL before the browser opens. */
	onBrowserUrl?: (url: string) => void
	/** Injected browser opener (tests). */
	open?: (url: string) => Promise<unknown>
}

export interface BrowserAuthResult {
	token: string
}

/**
 * Authenticate via browser: redirect the user to the Kimchi web app; the
 * resulting API key is sent back to the transient localhost callback server.
 */
export async function authenticateViaBrowser(options: BrowserAuthOptions = {}): Promise<BrowserAuthResult> {
	const webAppUrl = resolveWebAppUrl(options)
	const state = generateState()
	const callbackServer = await startCallbackServer(state)

	const onAbort = () => callbackServer.close()

	try {
		if (options.signal?.aborted) {
			callbackServer.close()
			throw new Error("Login cancelled")
		}
		options.signal?.addEventListener("abort", onAbort, { once: true })

		const callbackUrl = encodeURIComponent(callbackServer.url)
		const browserUrl = `${webAppUrl}/cli-auth?callback=${callbackUrl}&state=${encodeURIComponent(state)}`

		options.onBrowserUrl?.(browserUrl)

		console.log("Opening your browser to complete login…")
		const opener = options.open ?? open
		try {
			await opener(browserUrl)
		} catch {
			console.log("Couldn't open your browser automatically. Please visit the URL above manually.")
		}

		const result = await callbackServer.result

		if (result.error) {
			throw new Error(result.error)
		}
		if (!result.token) {
			throw new Error("Browser login completed but no token was received")
		}

		callbackServer.close()
		return { token: result.token }
	} catch (err) {
		callbackServer.close()
		throw err
	} finally {
		options.signal?.removeEventListener("abort", onAbort)
	}
}
