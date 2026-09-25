import type { Readable, Writable } from "node:stream"
import { type RawData, WebSocket } from "ws"

/**
 * Binary WebSocket↔stdio bridge — the runtime behind the hidden
 * `kimchictl ssh proxy` command that the generated ssh_config references via
 * ProxyCommand. TS port of kap's internal/ssh/bridge.go.
 *
 * Exit semantics (mirroring kap): stdin EOF or a normal WS close end the
 * bridge without error; any other failure rejects with a descriptive error.
 * The proxy process is short-lived — it exits when the bridge resolves, so
 * dangling listeners cannot outlive it.
 */

export class BridgeError extends Error {
	constructor(message: string) {
		super(message)
		this.name = "BridgeError"
	}
}

export interface BridgeOptions {
	wsUrl: string
	token: string
	input?: Readable
	output?: Writable
	/** Injected WebSocket constructor (tests may pass a wrapped client). */
	_WebSocket?: typeof WebSocket
}

export async function bridgeStdioToWebSocket(options: BridgeOptions): Promise<void> {
	const WS = options._WebSocket ?? WebSocket
	const input = options.input ?? process.stdin
	const output = options.output ?? process.stdout

	let ws: InstanceType<typeof WebSocket>
	try {
		ws = new WS(options.wsUrl, {
			headers: { Authorization: `Bearer ${options.token}` },
		})
	} catch (err) {
		throw new BridgeError(`websocket dial ${options.wsUrl}: ${err instanceof Error ? err.message : String(err)}`)
	}

	await new Promise<void>((resolve, reject) => {
		let settled = false
		const done = (err?: Error) => {
			if (settled) return
			settled = true
			if (err) reject(err)
			else resolve()
		}

		ws.on("open", () => done())
		ws.on("unexpected-response", (_req, res) => {
			done(
				new BridgeError(
					`websocket dial ${options.wsUrl}: unexpected HTTP ${res.statusCode} ${res.statusMessage ?? ""}`.trim(),
				),
			)
		})
		ws.on("error", (err) => done(new BridgeError(`websocket dial ${options.wsUrl}: ${err.message}`)))
	})

	return new Promise<void>((resolve, reject) => {
		let settled = false
		const finish = (err?: Error) => {
			if (settled) return
			settled = true
			input.removeAllListeners()
			// Output is process.stdout when bridging for real — never end() that;
			// only close streams the caller explicitly passed in.
			if (options.output) output.end()
			if (err) reject(err)
			else resolve()
		}

		// WS → stdout
		ws.on("message", (data: RawData, isBinary: boolean) => {
			// The workspace bridge is binary-only; text frames would be a server bug,
			// but writing them through is still friendlier than dropping bytes.
			void isBinary
			const buffer = Buffer.isBuffer(data) ? data : Array.isArray(data) ? Buffer.concat(data) : Buffer.from(data)
			if (!output.write(buffer)) {
				// Keep memory bounded if the consumer stalls: pause the socket until drained.
				ws.pause()
				output.once("drain", () => ws.resume())
			}
		})
		ws.on("close", () => finish())
		ws.on("error", (err: Error & { code?: number }) =>
			finish(
				err.code === 1000 || err.code === 1001
					? undefined // normal / going-away closure
					: new BridgeError(`websocket error: ${err.message}`),
			),
		)

		// stdin → WS
		if (input.isPaused?.()) input.resume()
		input.on("data", (chunk: Buffer | string) => {
			if (ws.readyState !== WebSocket.OPEN) return
			ws.send(chunk, { binary: true })
		})
		input.on("end", () => {
			if (ws.readyState === WebSocket.OPEN) ws.close(1000)
		})
		input.on("error", (err) => finish(err))
	})
}
