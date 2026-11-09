import { availableParallelism, loadavg } from "node:os";

/** Shared host-load factor (LANDPANETIMEOUT1, LANDRESVTIMEOUT1, GUARDGITLOAD1):
 * 1-minute load per core x 4, clamped to 1..4. OMP_KIT_LOAD_OVERRIDE
 * ("load1/ncpu", the test seam cli.ts already reads) pins it for tests; an
 * unreadable reading takes the widest bound. The same scaling as
 * tests/cli/fixture-process.ts. */
export function loadFactor(): number {
	const override = process.env.OMP_KIT_LOAD_OVERRIDE;
	let load1: number, ncpu: number;
	if (override !== undefined) {
		const parts = override.split("/");
		load1 = Number(parts[0]);
		ncpu = Number(parts[1] ?? "");
	} else {
		load1 = loadavg()[0] ?? Number.NaN;
		ncpu = availableParallelism();
	}
	if (!(load1 >= 0) || !(ncpu > 0)) return 4;
	return Math.max(1, Math.min(4, load1 / ncpu * 4));
}
