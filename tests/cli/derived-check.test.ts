import { expect, test } from "bun:test";
import { scanDerivedText, shouldScanFile } from "../../src/derived-check.ts";

test("planted version, path, count and pid literals each go RED with a probe", () => {
	const plantedHomePath = ["/Users", "josh", "bin", "x"].join("/");
	const rows = scanDerivedText("config/app.json", [
		'{ "tool": "' + plantedHomePath + '" }',
		'{ "pinned": "1.2.3" }',
		'{ "note": "17 profiles active" }',
		'{ "owner": "pid=98411" }',
	].join("\n"));
	expect(rows.map(row => row.kind)).toEqual(["path", "version", "count", "pid"]);
	expect(rows.every(row => row.probe.length > 0)).toBe(true);
	expect(rows[0]?.line).toBe(1);
	expect(rows[3]?.line).toBe(4);
});

test("a decision line with a reason stays quiet", () => {
	expect(scanDerivedText("c.json", '{ "pin": "1.2.3" }  # reason: repro for issue 12')).toEqual([]);
	expect(scanDerivedText("c.json", '"version": "0.2.5"')).toEqual([]);
	expect(scanDerivedText("c.json", '{ "a": 1 }')).toEqual([]);
});

test("shouldScanFile recognizes config extensions under config roots", () => {
	expect(shouldScanFile("config/app.json")).toBe(true);
	expect(shouldScanFile("config/a/b.toml")).toBe(true);
	expect(shouldScanFile("policy/a/b.yml")).toBe(true);
	expect(shouldScanFile("registry/a/b.yaml")).toBe(true);
	expect(shouldScanFile("src/a.ts")).toBe(false);
	expect(shouldScanFile("var/agent-tmp/x.json")).toBe(false);
	expect(shouldScanFile(".git/x.json")).toBe(false);
	expect(shouldScanFile("node_modules/x.json")).toBe(false);
	expect(shouldScanFile("noext")).toBe(false);
});

test("near-miss version soup stays linear", () => {
	const soup = `${"1".repeat(20000)}.${"2".repeat(20000)}x`;
	const started = performance.now();
	const rows = scanDerivedText("c.json", `{"v": "${soup}"}`);
	const elapsed = performance.now() - started;
	expect(rows).toEqual([]);
	expect(elapsed).toBeLessThan(1000);
});
test("doctor derived scans config and registry paths, not generated data", () => {
	expect(shouldScanFile("config/omp.json")).toBe(true);
	expect(shouldScanFile("registries/profiles.yaml")).toBe(true);
	expect(shouldScanFile(".omp/mission.toml")).toBe(false);
	expect(shouldScanFile(".omp/config.yml")).toBe(true);
	expect(shouldScanFile(".omp/profiles/codex/agent/config.yml")).toBe(true);
	expect(shouldScanFile(".beads/config.yaml")).toBe(true);
	expect(shouldScanFile(".beads/recovery_20261013T050019Z/config.yaml")).toBe(false);
	expect(shouldScanFile(".beads/.br-wal-index-tavhh1/prepared.json")).toBe(false);
	expect(shouldScanFile(".github/workflows/release.yml")).toBe(true);
	expect(shouldScanFile("runs/fault-matrix.json")).toBe(false);
	expect(shouldScanFile("uds-check-selftest-matrix-6mpeab4f/closure-fixture/registries/target_gate_projections.toml")).toBe(false);
	expect(shouldScanFile(".scratch-hsvg-chain-12345/closure-drift-chain/registries/beads_pointers.toml")).toBe(false);
	expect(shouldScanFile("docs/evidence/receipt.json")).toBe(false);
	expect(shouldScanFile(".omp/retired-20261013T021849Z/cfs-held-path-custody.json")).toBe(false);
	expect(shouldScanFile("src/cc-credential-shapes.v1.json")).toBe(false);
	expect(shouldScanFile("pnpm-lock.yaml")).toBe(false);
});
test("loopback address is not a version fact", () => {
	expect(scanDerivedText("config/omp.json", '{"url":"http://127.0.0.1:8765/mcp/"}')).toEqual([]);
});
test("a preceding decision comment accounts for its config value", () => {
	const config = [
		"# decision: use the target root; reason: the reader requires a host-local path; who: owner; when: 2026-10-01",
		'canonical_root = "/home/operator/Developer/franken-harvest"',
	].join("\n");
	expect(scanDerivedText("registries/target_gate_projections.toml", config)).toEqual([]);
});
test("external project and database paths remain visible to derived checks", () => {
	const config = [
		"issue_prefix: uds",
		"external_projects:",
		"  control-plane: /Users/example/Developer/control-plane",
		"db: /Users/example/.beads/beads.db",
	].join("\n");
	expect(scanDerivedText(".beads/config.yaml", config).map(row => [row.line, row.kind]))
		.toEqual([[3, "path"], [4, "path"]]);
});
