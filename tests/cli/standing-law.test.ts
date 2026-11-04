import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { loadRuleFile } from "../../scripts/rule-class.ts";
import { readJsonl } from "../../src/kitlib/jsonl.ts";
import { fixtureDeadlineS } from "./fixture-process.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";

const root = resolve(import.meta.dir, "../..");
const file = join(root, "rules/kit-standing-law.md");
const text = readFileSync(file, "utf8");
// Private authority is optional on stock CI; its absence is NOT_RUN, not proof.
const decisions = process.env.OMP_KIT_JOSHUA_DECISIONS ?? join(homedir(), ".claude/skills/omp-kit-orchestration/decisions/joshua.jsonl");
function decisionIds(path: string): Set<string> {
	const ledger = readJsonl(path, { maxBytes: 16 * 1024 * 1024 });
	if (ledger.missing || ledger.more || ledger.pending_tail_bytes || ledger.errors.length) {
		throw new Error(`Incomplete decision authority: ${path}`);
	}
	return new Set(ledger.rows.map(row => {
		if (!row || typeof row !== "object" || !("id" in row) || typeof row.id !== "string") {
			throw new Error("Malformed decision authority row");
		}
		return row.id;
	}));
}
function validate(source: string, ids?: Set<string>): void {
	if (source.length > 1024 * 1024) throw new Error("Standing law input exceeds 1 MiB");
	if (source.trim().split(/\s+/u).length > 1800) throw new Error("Standing law exceeds 1800 words");
	const cited = [...source.matchAll(/J-\d{4}-\d{2}-\d{2}-\d+/gu)].map(match => match[0]);
	if (!cited.length) throw new Error("No decision citations");
	if (ids) for (const id of cited) if (!ids.has(id)) throw new Error(`Unknown decision: ${id}`);
	const rules = source.split("\n").filter(line => /^- R\d{2}:/u.test(line));
	if (rules.length !== 54 || new Set(rules.map(line => line.slice(2, 5))).size !== 54) throw new Error("Expected 54 unique rules");
	for (const line of rules) {
		if (!/\[J-[^\]]+\] mechanism=\S+$/u.test(line)) throw new Error("Rule lacks citation/mechanism");
	}
	for (const match of source.matchAll(/mechanism=(\S+)/gu)) {
		for (const mechanism of match[1]!.split("|")) {
			if (mechanism === "unenforced") continue;
			const path = resolve(root, mechanism);
			if (!path.startsWith(`${root}/`)) throw new Error(`Non-repo mechanism: ${mechanism}`);
			if (!existsSync(path)) throw new Error(`Missing mechanism: ${mechanism}`);
		}
	}
}

test("standing law uses OMP's valid alwaysApply parser", () => {
	const loaded = loadRuleFile(file);
	expect(loaded.cls).toBe("always");
	expect(loaded.rule.alwaysApply).toBe(true);
	expect(loaded.rule.condition ?? []).toHaveLength(0);
	expect(loaded.rule.content).toContain("A step you can satisfy by believing you did it is not a step.");
}, fixtureDeadlineS(10) * 1000);

test("standing law has complete citations, mechanisms and bounded context", () => {
	expect(() => validate(text)).not.toThrow();
});

const authorityPresent = existsSync(decisions);
(authorityPresent ? test : test.skip)(authorityPresent
	? "standing law J-id existence against private authority"
	: "NOT_RUN: standing law J-id existence (private authority absent)", () => {
	expect(() => validate(text, decisionIds(decisions))).not.toThrow();
});

test("planted unknown decision is refused using a fixture decisions file", () => {
	const fixture = ownedTmp("standing-law-decisions");
	try {
		const path = join(fixture.path, "decisions.jsonl");
		const cited = new Set([...text.matchAll(/J-\d{4}-\d{2}-\d{2}-\d+/gu)].map(match => match[0]));
		writeFileSync(path, [...cited].map(id => JSON.stringify({ id })).join("\n") + "\n");
		const ids = decisionIds(path);
		expect(() => validate(text, ids)).not.toThrow();
		expect(() => validate(text.replace("J-2026-10-25-41", "J-2099-01-01-999"), ids)).toThrow("Unknown decision: J-2099-01-01-999");
	} finally {
		fixture.cleanup();
	}
});

test("existing standing law remains byte-identical", () => {
	const prefix = text.slice(0, text.indexOf("\n## Joshua standing decisions"));
	expect(createHash("sha256").update(prefix).digest("hex")).toBe("5470d0d4088c77bb3780e5bab5493a755cfeb84cb730b3b7e0cf771e052f60fa");
});

test("planted missing mechanism is refused", () => {
	expect(() => validate(text.replace("mechanism=unenforced", "mechanism=tests/fixtures/standing-law-missing-mechanism-999"))).toThrow("Missing mechanism:");
});

test("planted oversized law and omitted rule are refused", () => {
	expect(() => validate(`${text}\n${"extra ".repeat(1801)}`)).toThrow("exceeds 1800");
	expect(() => validate(text.replace(/^- R01:.*\n/mu, ""))).toThrow("54 unique rules");
});

test("bounded long near-miss preserves citation refusal", () => {
	const started = performance.now();
	const near = text.replace("J-2026-10-25-41", `J-${"9".repeat(60000)}-01-01-999`);
	expect(() => validate(near)).not.toThrow();
	expect(performance.now() - started).toBeLessThan(fixtureDeadlineS(1) * 1000);
	expect(() => validate("x".repeat(1024 * 1024 + 1))).toThrow("exceeds 1 MiB");
});
