import { realpathSync } from "node:fs";
import { resolveRealBr } from "../../../src/kitlib/readonly-br.ts";

// Owned fixture trackers use the native backend, never an agent's guarded live-tracker alias.
export function nativeBr(): string {
	const resolved = resolveRealBr(process.env.PATH);
	if (!resolved.ok) throw new Error(`A native br executable is required for the owned tracker fixture (${resolved.reason})`);
	return realpathSync(resolved.path);
}
