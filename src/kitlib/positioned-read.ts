import { readSync } from "node:fs";

/** Fill a caller-owned buffer range from a positioned file descriptor until complete or EOF. */
export function readInto(fd: number, buffer: Buffer, bufferOffset: number, length: number, position: number): number {
	let filled = 0;
	while (filled < length) {
		const count = readSync(fd, buffer, bufferOffset + filled, length - filled, position + filled);
		if (count === 0) break;
		filled += count;
	}
	return filled;
}
