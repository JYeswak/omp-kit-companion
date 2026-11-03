import { afterAll, expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { MineLedger, type MineCell, type MineSource } from "../../src/mine-ledger.ts";
import { ownedTmp, type OwnedTmp } from "../../src/kitlib/tmp.ts";

const owned: OwnedTmp[] = [];
afterAll(() => { for (const fixture of owned) fixture.cleanup(); });
const window = { since: "2026-10-01", until: "2026-11-01" };
function fixture(): string {
	const tmp = ownedTmp("mine-ledger");
	owned.push(tmp);
	return realpathSync(tmp.path);
}
const input = (status: MineCell["status"] = "READ"): Omit<MineCell<{ evidence: string[] }>, "version" | "attempts"> => ({
	project: "project/../../labels-are-not-paths", day: "2026-10-15", source: "transcripts", input_fingerprint: "fingerprint-1",
	status, reasons: status === "PARTIAL" ? ["source interrupted"] : [], result: { evidence: ["completed evidence"] },
});
function resultPath(store: MineLedger): string {
	const manifest = JSON.parse(readFileSync(store.path, "utf8"));
	const digest = Object.values(manifest.entries)[0];
	if (typeof digest !== "string") throw new Error("fixture has no receipt");
	return join(dirname(store.path), `${digest}.json`);
}

test("READ evidence round-trips across reopen without result duplication in manifest", () => {
	const root = fixture();
	const ledger = new MineLedger(root, window, "revision-1");
	const cell = ledger.put(input());
	expect(cell.attempts).toBe(1);
	const reopened = new MineLedger(root, window, "revision-1");
	expect(reopened.get(cell.project, cell.day, cell.source, cell.input_fingerprint)).toEqual(cell);
	expect(reopened.cells).toEqual([cell]);
	expect(reopened.totals()).toEqual({ READ: 1, PARTIAL: 0, MISSING: 0, "NONE-EXISTS": 0 });
	expect(readFileSync(ledger.path, "utf8")).not.toContain("completed evidence");
});

test("PARTIAL retries increment attempts and retain diagnostics through completion", () => {
	const root = fixture();
	const ledger = new MineLedger(root, window, "r");
	const first = ledger.put(input("PARTIAL"));
	expect(ledger.get(first.project, first.day, first.source, first.input_fingerprint)?.attempts).toBe(1);
	const retry = new MineLedger(root, window, "r");
	const second = retry.put({ ...input("PARTIAL"), reasons: ["second interruption"] });
	expect(second.attempts).toBe(2);
	expect(second.reasons).toEqual(["source interrupted", "second interruption"]);
	const complete = retry.put(input());
	expect(complete.attempts).toBe(3);
	expect(complete.reasons).toEqual(second.reasons);
	expect(new MineLedger(root, window, "r").cells).toEqual([complete]);
});

test("fingerprint, revision, and full UTC window bind cached evidence", () => {
	const root = fixture();
	const ledger = new MineLedger(root, window, "r");
	const cell = ledger.put(input());
	expect(ledger.get(cell.project, cell.day, cell.source, "changed")).toBeNull();
	expect(new MineLedger(root, window, "changed").get(cell.project, cell.day, cell.source, cell.input_fingerprint)).toBeNull();
	expect(new MineLedger(root, { ...window, until: "2026-11-02" }, "r").cells).toEqual([]);
	for (const day of ["2026-09-30", "2026-11-01", "2026-10-32", "2026-10-01T00:00:00Z", "2026-02-30"]) {
		expect(() => ledger.put({ ...input(), day })).toThrow();
	}
	for (const day of [window.since, "2026-10-31"]) expect(ledger.put({ ...input(), day }).day).toBe(day);
	expect(() => new MineLedger(root, { since: "2026-02-30", until: window.until }, "r")).toThrow();
	expect(() => new MineLedger(root, { since: window.until, until: window.since }, "r")).toThrow();
});

test("missing, truncated, or altered result receipts never report READ", () => {
	for (const damage of ["missing", "truncated", "altered"] as const) {
		const root = fixture();
		const ledger = new MineLedger(root, window, "r");
		const cell = ledger.put(input());
		const path = resultPath(ledger);
		if (damage === "missing") rmSync(path);
		else writeFileSync(path, damage === "truncated" ? '{"version":1' : JSON.stringify({ ...cell, result: "fabricated" }));
		const reopened = new MineLedger(root, window, "r");
		expect(reopened.get(cell.project, cell.day, cell.source, cell.input_fingerprint)).toBeNull();
		expect(reopened.totals().READ).toBe(0);
		const repaired = reopened.put(input());
		expect(reopened.get(repaired.project, repaired.day, repaired.source, repaired.input_fingerprint)).toEqual(repaired);
	}
});

test("symlink roots, ancestor traversal, result links, and manifest references cannot escape", () => {
	const root = fixture();
	const real = join(root, "real");
	mkdirSync(real, { mode: 0o700 });
	const link = join(root, "linked");
	symlinkSync(real, link);
	expect(() => new MineLedger(link, window, "r")).toThrow();
	expect(() => new MineLedger(join(link, "child"), window, "r")).toThrow();
	expect(() => new MineLedger(`${real}/../escape`, window, "r")).toThrow();
	const ledger = new MineLedger(real, window, "r");
	const cell = ledger.put(input());
	const path = resultPath(ledger);
	const original = join(root, "original.json");
	renameSync(path, original);
	symlinkSync(original, path);
	expect(ledger.get(cell.project, cell.day, cell.source, cell.input_fingerprint)).toBeNull();
	const manifest = JSON.parse(readFileSync(ledger.path, "utf8"));
	manifest.entries[Object.keys(manifest.entries)[0]] = "../../original";
	writeFileSync(ledger.path, JSON.stringify(manifest));
	expect(new MineLedger(real, window, "r").cells).toEqual([]);
	expect(readFileSync(original, "utf8")).toContain("completed evidence");
});

test("interrupted manifest publication propagates failure and keeps previous commit recoverable", () => {
	const root = fixture();
	const ledger = new MineLedger(root, window, "r");
	const first = ledger.put(input("PARTIAL"));
	const saved = join(dirname(ledger.path), "saved-manifest.json");
	renameSync(ledger.path, saved);
	mkdirSync(ledger.path, { mode: 0o700 });
	expect(() => ledger.put(input())).toThrow();
	rmSync(ledger.path, { recursive: true });
	renameSync(saved, ledger.path);
	const recovered = new MineLedger(root, window, "r");
	expect(recovered.get(first.project, first.day, first.source, first.input_fingerprint)).toEqual(first);
	expect(recovered.put(input()).attempts).toBe(2);
});

test("truncated manifest is a miss; explicit bounds and private state are enforced", () => {
	const root = fixture();
	const ledger = new MineLedger(root, window, "r");
	ledger.put(input());
	writeFileSync(ledger.path, '{"version":');
	expect(new MineLedger(root, window, "r").cells).toEqual([]);
	expect(() => ledger.put({ ...input(), project: "" })).toThrow();
	expect(() => ledger.put({ ...input(), project: "x".repeat(4097) })).toThrow();
	expect(() => ledger.put({ ...input(), source: "other" as MineSource })).toThrow();
	expect(() => ledger.put({ ...input(), input_fingerprint: "" })).toThrow();
	expect(() => ledger.put({ ...input(), result: { evidence: ["x".repeat(8 * 1024 * 1024)] } })).toThrow();
	chmodSync(root, 0o755);
	expect(() => new MineLedger(root, window, "r")).toThrow();
	chmodSync(root, 0o700);
});

test("MISSING and NONE-EXISTS remain explicit durable coverage, not READ", () => {
	const root = fixture();
	const ledger = new MineLedger(root, window, "r");
	ledger.put({ ...input("MISSING"), day: window.since, reasons: ["expected source unavailable"] });
	ledger.put({ ...input("NONE-EXISTS"), day: "2026-10-31" });
	expect(new MineLedger(root, window, "r").totals()).toEqual({ READ: 0, PARTIAL: 0, MISSING: 1, "NONE-EXISTS": 1 });
});
