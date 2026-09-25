/**
 * Browser login — ported from the kimchi harness (kimchi-dev:src/cli-auth/):
 * transient 127.0.0.1 callback server → open `webApp/cli-auth?callback=…&state=…`
 * → web app delivers the API key back to the callback. Same URL grammar and
 * state-CSRF validation so both tools can drive the same web flow.
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

export interface CallbackResult {
	token?: string
	error?: string
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

/**
 * Start a temporary HTTP server on 127.0.0.1 to receive the token callback.
 * Validates the state parameter against CSRF; times out after 5 minutes.
 */
export function startCallbackServer(expectedState: string): Promise<CallbackServer> {
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

				const state = url.searchParams.get("state")
				if (!state || state !== expectedState) {
					const errorMsg = "This request isn't valid. Please try logging in again from your terminal."
					res.writeHead(400, { "Content-Type": "text/html", Connection: "close" })
					res.end(errorHtml("Login error", errorMsg))
					finish({ error: errorMsg })
					return
				}

				const error = url.searchParams.get("error")
				if (error) {
					const errorMsg = url.searchParams.get("error_description") || error
					res.writeHead(200, { "Content-Type": "text/html", Connection: "close" })
					res.end(errorHtml("Authentication failed", errorMsg))
					finish({ error: errorMsg })
					return
				}

				const token = url.searchParams.get("token")
				if (!token) {
					const errorMsg = "No token was returned by the authentication server"
					res.writeHead(400, { "Content-Type": "text/html", Connection: "close" })
					res.end(errorHtml("Missing token", errorMsg))
					finish({ error: errorMsg })
					return
				}

				res.writeHead(200, { "Content-Type": "text/html", Connection: "close" })
				res.end(successHtml(SUCCESS_MESSAGE))
				finish({ token })
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err)
				res.writeHead(500, { "Content-Type": "text/plain", Connection: "close" })
				res.end("Internal server error")
				finish({ error: `Unexpected server error: ${message}` })
				req.socket.destroy()
			}
		}

		server = createServer(onRequest)

		server.listen(0, "127.0.0.1", () => {
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
				url: `http://127.0.0.1:${port}${CALLBACK_PATH}`,
				result: resultPromise,
				close: () => {
					finish({ error: "Login cancelled" })
				},
			})
		})

		server.on("error", (err) => {
			closeServer()
			rejectStart(err)
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
