import { accessSync, closeSync, constants, openSync, readSync, realpathSync } from "node:fs";
import { join } from "node:path";

// Owned fixture trackers use the native backend, never an agent's guarded live-tracker alias.
export function nativeBr(): string {
	const header = Buffer.alloc(2);
	for (const dir of (process.env.PATH ?? "").split(":")) {
		if (!dir) continue;
		const candidate = join(dir, "br");
		let fd: number;
		try { accessSync(candidate, constants.X_OK); fd = openSync(candidate, "r"); } catch { continue; }
		try {
			if (readSync(fd, header, 0, 2, 0) === 2 && !(header[0] === 35 && header[1] === 33)) return realpathSync(candidate);
		} finally { closeSync(fd); }
	}
	throw new Error("A native br executable is required for the owned tracker fixture");
}
