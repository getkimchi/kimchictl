// Provider-id predicates. Dependency-free mirror of kimchi-dev's
// src/kimchi-provider.ts — the auth.json contract is shared with the harness,
// so the id grammar must stay in lockstep.

export const KIMCHI_PROVIDER_ID = "kimchi-dev"
const KIMCHI_EXPERIMENTAL_PROVIDER_ID = "kimchi-experimental"

/** True for every Kimchi-managed provider, including experimental models. */
export function isKimchiProvider(provider: string): boolean {
	return (
		provider === KIMCHI_PROVIDER_ID ||
		provider.startsWith(`${KIMCHI_PROVIDER_ID}/`) ||
		provider === KIMCHI_EXPERIMENTAL_PROVIDER_ID
	)
}
