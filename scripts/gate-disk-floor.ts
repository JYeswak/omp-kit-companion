#!/usr/bin/env bun
// gate-disk-floor.ts — CIGATE1 (ompkit-v66l.27.1): the pre-push gate's hard disk floor for its tests.
//
// Usage: bun scripts/gate-disk-floor.ts DIR
//
// Reads OS statfs for DIR and judges it with heavy's own statfs verdict (SAVEFIRST1,
// ompkit-774u.16: physical bytes decide; sbh's percentage floor is a WARN, never a veto). The
// affected tests either run or the gate refuses here with a typed reason; there is no third outcome
// in which tests are skipped and the push passes.
//   exit 0  `disk-floor: OK free=<bytes> need=<bytes> observer=statfs path=DIR`
//   exit 1  `FRESH-GATE: REFUSED reason=DISK_BELOW_FLOOR need=10G need_bytes=... free_bytes=... ...`
//   exit 69 statfs could not be read (reason=DISK_OBSERVER_UNAVAILABLE); never treated as healthy.
//   exit 2  usage.
import { statfsSync } from "node:fs";
import process from "node:process";
import { decideDiskPressure, HEAVY_DISK_NEED, HEAVY_DISK_NEED_BYTES, HEAVY_PREREQ_MISSING } from "../src/heavy.ts";
import type { DiskCapacity } from "../src/heavy.ts";

const dir = process.argv[2];
if (!dir || process.argv.length !== 3) {
	process.stderr.write("usage: gate-disk-floor.ts DIR\n");
	process.exit(2);
}
let capacity: DiskCapacity | null = null;
try {
	const observed = statfsSync(dir);
	const blocks = Number(observed.blocks);
	const bavail = Number(observed.bavail);
	const bsize = Number(observed.bsize);
	if (blocks > 0 && bavail >= 0 && bsize > 0) capacity = { freeBytes: bavail * bsize, freePct: Math.min(100, (bavail / blocks) * 100) };
} catch { /* unreadable: judged unavailable below */ }
const verdict = decideDiskPressure(capacity, null);
if (verdict.kind === "unavailable" || capacity === null) {
	process.stderr.write(`FRESH-GATE: REFUSED reason=DISK_OBSERVER_UNAVAILABLE observer=statfs path=${dir}: cannot read free space, so the affected tests cannot be admitted; no test was skipped silently\n`);
	process.exit(HEAVY_PREREQ_MISSING);
}
const gib = (bytes: number) => (bytes / 1024 ** 3).toFixed(1);
if (verdict.kind === "pressure") {
	process.stderr.write(`FRESH-GATE: REFUSED reason=DISK_BELOW_FLOOR need=${HEAVY_DISK_NEED} need_bytes=${HEAVY_DISK_NEED_BYTES} free_bytes=${capacity.freeBytes} observer=statfs path=${dir}: the affected tests need ${HEAVY_DISK_NEED} free and ${gib(capacity.freeBytes)} GiB is free; free ${gib(HEAVY_DISK_NEED_BYTES - capacity.freeBytes)} GiB (sbh waste management, ompkit-774u.15) and push again\n`);
	process.exit(1);
}
process.stdout.write(`disk-floor: OK free_bytes=${capacity.freeBytes} need_bytes=${HEAVY_DISK_NEED_BYTES} observer=statfs path=${dir}\n`);
