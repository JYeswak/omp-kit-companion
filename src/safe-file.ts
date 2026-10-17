import { closeSync, constants, fstatSync, openSync, readFileSync } from "node:fs";

const NOFOLLOW = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0);

/** Read a regular file without following symlinks; refuse files above the optional byte cap. */
export function readSafeFile(path: string, maxBytes?: number, unsafeMessage = "unsafe or oversized file"): Buffer {
	const fd = openSync(path, NOFOLLOW);
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || (maxBytes !== undefined && stat.size > maxBytes)) throw new Error(unsafeMessage);
		const bytes = readFileSync(fd);
		if (maxBytes !== undefined && bytes.length > maxBytes) throw new Error(unsafeMessage);
		return bytes;
	} finally { closeSync(fd); }
}
