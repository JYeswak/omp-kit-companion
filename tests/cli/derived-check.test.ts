import { expect, test } from "bun:test";
import { scanDerivedText, shouldScanFile } from "../../src/derived-check.ts";

test("planted version, path, count and pid literals each go RED with a probe", () => {
	const rows = scanDerivedText("config/app.json", [
		'{ "tool": "/Users/josh/bin/x" }',
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

test("shouldScanFile covers config extensions and skips managed dirs", () => {
	expect(shouldScanFile("config/app.json")).toBe(true);
	expect(shouldScanFile("a/b.toml")).toBe(true);
	expect(shouldScanFile("a/b.yml")).toBe(true);
	expect(shouldScanFile("a/b.yaml")).toBe(true);
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
