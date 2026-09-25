import { VERSION } from "../version.js"

export function runVersion(): number {
	console.log(`kimchictl ${VERSION}`)
	return 0
}
