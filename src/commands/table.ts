/** Minimal kubectl-style table renderer: pad columns to the widest cell, two-space gutter. */
export function formatTable(headers: readonly string[], rows: readonly (readonly string[])[]): string {
	const widths = headers.map((header, i) => Math.max(header.length, ...rows.map((row) => row[i]?.length ?? 0)))
	const line = (cells: readonly string[]) =>
		cells
			.map((cell, i) => cell.padEnd(widths[i] ?? 0))
			.join("  ")
			.trimEnd()
	return [line(headers), ...rows.map(line)].join("\n")
}
