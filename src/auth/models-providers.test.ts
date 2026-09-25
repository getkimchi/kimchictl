import { afterEach, describe, expect, it, vi } from "vitest"
import { jsonResponse, stubFetch } from "../test-support.js"
import { fetchKimchiProviderIds, ModelsFetchError } from "./models-providers.js"

afterEach(() => {
	vi.unstubAllEnvs()
})

describe("fetchKimchiProviderIds", () => {
	it("derives kimchi-dev plus one id per non-ai-enabler upstream provider", async () => {
		const requested: string[] = []
		const fetch = stubFetch(async (url) => {
			requested.push(url)
			return jsonResponse({
				models: [
					{ slug: "m1", provider: "ai-enabler" },
					{ slug: "m2", provider: "anthropic" },
					{ slug: "m3", provider: "anthropic" },
					{ slug: "m4", provider: "openai" },
				],
			})
		})

		const ids = await fetchKimchiProviderIds("key", { fetch })

		expect(new Set(ids)).toEqual(new Set(["kimchi-dev", "kimchi-dev/anthropic", "kimchi-dev/openai"]))
		expect(requested).toEqual(["https://llm.kimchi.dev/v1/models/metadata?include_in_cli=true"])
	})

	it("yields only kimchi-dev when every model is ai-enabler", async () => {
		const fetch = stubFetch(async () => jsonResponse({ models: [{ slug: "m1", provider: "ai-enabler" }] }))
		expect(await fetchKimchiProviderIds("key", { fetch })).toEqual(["kimchi-dev"])
	})

	it("throws ModelsFetchError with the HTTP status (401 = invalid key)", async () => {
		const fetch = stubFetch(async () => new Response("unauthorized", { status: 401, statusText: "Unauthorized" }))
		try {
			await fetchKimchiProviderIds("bad-key", { fetch })
			expect.unreachable("should have thrown")
		} catch (err) {
			expect(err).toBeInstanceOf(ModelsFetchError)
			expect((err as ModelsFetchError).status).toBe(401)
		}
	})

	it("normalizes scheme-less endpoints and duplicated slashes", async () => {
		vi.stubEnv("KIMCHI_LLM_ENDPOINT", "llm.internal.example/")
		const requested: string[] = []
		const fetch = stubFetch(async (url) => {
			requested.push(url)
			return jsonResponse({ models: [] })
		})

		await fetchKimchiProviderIds("key", { fetch })

		expect(requested).toEqual(["https://llm.internal.example/v1/models/metadata?include_in_cli=true"])
	})

	it("rejects malformed response bodies", async () => {
		const fetch = stubFetch(async () => jsonResponse({ notModels: true }))
		await expect(fetchKimchiProviderIds("key", { fetch })).rejects.toThrow(/Unexpected response shape/)
	})
})
