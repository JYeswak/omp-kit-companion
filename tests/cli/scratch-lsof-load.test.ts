import { expect, test } from "bun:test";
import { LSOF_TIMEOUT_MS, snapshotClear, takeLsofSnapshot, type ScratchRunner } from "../../src/scratch.ts";

test("LSOFLOAD1: a loaded host can complete a snapshot past the quiet-host deadline", () => {
	const saved = process.env.OMP_KIT_LOAD_OVERRIDE;
	try {
		const deadlines: number[] = [];
		const run: ScratchRunner = (argv, opts) => {
			expect(argv).toEqual(["lsof", "-nP", "-Fn"]);
			const deadline = opts?.timeoutMs ?? 0;
			deadlines.push(deadline);
			return deadline < 32_000
				? { code: null, stdout: "n/partial-name\n", stderr: "", timedOut: true }
				: { code: 0, stdout: "p22\nf3\nn/scratch/in-use/file\n", stderr: "" };
		};
		let why = "";
		const note = (value: string) => { why = value; };
		process.env.OMP_KIT_LOAD_OVERRIDE = "0/32";
		expect(snapshotClear(takeLsofSnapshot(run, undefined, note), "/scratch/free")).toBeNull();
		expect(why).toBe(`lsof-timeout deadline_ms=${LSOF_TIMEOUT_MS}`);
		process.env.OMP_KIT_LOAD_OVERRIDE = "40/32";
		const snapshot = takeLsofSnapshot(run);
		expect(snapshotClear(snapshot, "/scratch/free")).toBe(true);
		expect(snapshotClear(snapshot, "/scratch/in-use")).toBe(false);
		// An explicit deadline remains exact, even on a loaded host.
		expect(snapshotClear(takeLsofSnapshot(run, 20_000, note), "/scratch/free")).toBeNull();
		expect(why).toBe("lsof-timeout deadline_ms=20000");
		expect(deadlines).toEqual([LSOF_TIMEOUT_MS, 60_000, 20_000]);
	} finally {
		if (saved === undefined) delete process.env.OMP_KIT_LOAD_OVERRIDE;
		else process.env.OMP_KIT_LOAD_OVERRIDE = saved;
	}
});
