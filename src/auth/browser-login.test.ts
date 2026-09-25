import { afterEach, describe, expect, it, vi } from "vitest"
import { authenticateViaBrowser, startCallbackServer } from "./browser-login.js"

afterEach(() => {
	vi.unstubAllEnvs()
	vi.restoreAllMocks()
})

describe("startCallbackServer", () => {
	it("delivers the token on a valid state callback", async () => {
		const server = await startCallbackServer("state-123")
		const resp = await fetch(`${server.url}?state=state-123&token=tok-xyz`)

		expect(resp.status).toBe(200)
		expect(await resp.text()).toContain("Your CLI is now connected")
		await expect(server.result).resolves.toEqual({ token: "tok-xyz" })
	})

	it("rejects a wrong state (CSRF) and reports the error", async () => {
		const server = await startCallbackServer("expected-state")
		const resp = await fetch(`${server.url}?state=forged&token=abc`)

		expect(resp.status).toBe(400)
		const result = await server.result
		expect(result.error).toMatch(/request isn't valid/)
	})

	it("surfaces the web app's error_description", async () => {
		const server = await startCallbackServer("s")
		const resp = await fetch(`${server.url}?state=s&error=access_denied&error_description=User+denied`)

		expect(resp.status).toBe(200)
		await expect(server.result).resolves.toEqual({ error: "User denied" })
	})

	it("404s non-callback paths without resolving the result", async () => {
		const server = await startCallbackServer("s")
		try {
			const resp = await fetch(`${server.url.replace("/callback", "/other")}`)
			expect(resp.status).toBe(404)
		} finally {
			server.close()
		}
		await expect(server.result).resolves.toEqual({ error: "Login cancelled" })
	})
})

describe("authenticateViaBrowser", () => {
	it("builds the cli-auth URL and completes when the callback delivers a token", async () => {
		vi.stubEnv("KIMCHI_WEB_APP_URL", "https://app.example.test")
		const seenUrls: string[] = []

		const authPromise = authenticateViaBrowser({
			onBrowserUrl: (url) => seenUrls.push(url),
			open: async (url) => {
				const parsed = new URL(url)
				const callback = new URL(decodeURIComponent(parsed.searchParams.get("callback") ?? ""))
				callback.searchParams.set("state", parsed.searchParams.get("state") ?? "")
				callback.searchParams.set("token", "browser-token")
				await fetch(callback)
			},
		})

		const { token } = await authPromise
		expect(token).toBe("browser-token")
		expect(seenUrls).toHaveLength(1)
		expect(seenUrls[0]).toMatch(
			/^https:\/\/app\.example\.test\/cli-auth\?callback=http%3A%2F%2F127\.0\.0\.1%3A\d+%2Fcallback&state=[0-9a-f]{64}$/,
		)
	})

	it("rejects when the browser flow errors", async () => {
		const authPromise = authenticateViaBrowser({
			open: async (url) => {
				const parsed = new URL(url)
				const callback = new URL(decodeURIComponent(parsed.searchParams.get("callback") ?? ""))
				callback.searchParams.set("state", parsed.searchParams.get("state") ?? "")
				callback.searchParams.set("error", "access_denied")
				await fetch(callback)
			},
		})

		await expect(authPromise).rejects.toThrow(/access_denied/)
	})

	it("rejects with 'Login cancelled' when aborted before opening", async () => {
		const controller = new AbortController()
		controller.abort()
		await expect(authenticateViaBrowser({ signal: controller.signal, open: async () => {} })).rejects.toThrow(
			/Login cancelled/,
		)
	})
})
