import { afterAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve } from "node:path";
import { applyActivationManifest, recordOptOut, updatePostApplyEnvelope } from "../../src/activation.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import type { HookRefreshIo } from "../../src/hook-refresh.ts";

const base = resolve(ownedTmp("activation-apply").path);
afterAll(() => rmSync(base, { recursive: true, force: true }));

function sha(bytes: Buffer | string): string {
	return createHash("sha256").update(bytes).digest("hex");
}
function fixtureDirs(tag: string): { root: string; home: string; stateRoot: string } {
	const dir = join(base, tag);
	const root = join(dir, "root"), home = join(dir, "home");
	mkdirSync(join(root, "rules"), { recursive: true });
	mkdirSync(join(root, "rules-fleet"), { recursive: true });
	mkdirSync(join(root, "policy"), { recursive: true });
	mkdirSync(join(root, "retired"), { recursive: true });
	mkdirSync(join(root, "extensions"), { recursive: true });
	mkdirSync(home, { recursive: true });
	const rule = "# Foo rule\n";
	const fleetRule = "# Bar fleet rule\n";
	writeFileSync(join(root, "policy", "extensions.json"), JSON.stringify({ extensions: ["hello.ts"], skipProfiles: [] }));
	writeFileSync(join(root, "extensions", "hello.ts"), "// hello\nexport const x = 1;\n");
	writeFileSync(join(root, "rules", "foo.md"), rule);
	writeFileSync(join(root, "MANIFEST.tsv"), `name\tsha256\tclass\tpack\nfoo\t${sha(rule)}\ttripwire\t1234567\n`);
	writeFileSync(join(root, "rules-fleet", "bar.md"), fleetRule);
	writeFileSync(join(root, "MANIFEST.fleet.tsv"), `name\tsha256\tclass\tpack\nbar\t${sha(fleetRule)}\ttripwire\t1234567\n`);
	writeFileSync(join(root, "package.json"), JSON.stringify({ version: "9.9.9", omp: { extensions: ["extensions/hello.ts"], notLoadedExtensions: {} } }));
	return { root, home, stateRoot: join(home, ".local", "state", "omp-kit") };
}
const okService = () => async (_argv: readonly string[]) => ({ exit: 0, stdout: JSON.stringify({ code: 0, data: {} }), stderr: "" });
function hookIo(record: string[]): HookRefreshIo {
	return {
		repos: () => [],
		kitRoot: () => "/nonexistent-kit",
		digest: () => null,
		hooksDir: () => ({ dir: null, config: null, tracked: false }),
		pullRepos: () => [],
		runInstaller: (repo: string) => { record.push(repo); return { ok: true, detail: "fake" }; },
	};
}
const envelopeBase = { code: 0 as const, data: { overall: "UNVERIFIED", action: "UPDATED" } };

test("positive: whole manifest applies from owned fixtures, envelope UPDATED", async () => {
	const { root, home, stateRoot } = fixtureDirs("positive");
	const installed: string[] = [];
	const result = await applyActivationManifest({ root, home, stateRoot, binary: "/nonexistent/omp-kit", exec: okService(), hookIo: hookIo(installed) });
	expect(result.ok).toBe(true);
	expect(result.failed).toEqual([]);
	expect(result.rulesApplied).toBe(4);
	expect(result.extensionsApplied).toBeGreaterThan(0);
	expect(result.servicesApplied.length).toBeGreaterThan(0);
	expect(readFileSync(join(home, ".agents", "rules", "foo.md"), "utf8")).toContain("Foo rule");
	expect(readFileSync(join(home, ".agents", "rules", "bar.md"), "utf8")).toContain("Bar fleet rule");
	expect(readFileSync(join(home, ".omp", "omp-extensions", "hello.ts"), "utf8")).toContain("hello");
	const out = updatePostApplyEnvelope(envelopeBase, { ok: true, receiptId: "r1", detail: "linked" }, result, root);
	expect(out.code).toBe(0);
	expect(out.data["overall"]).toBe("UPDATED");
});

test("opt-outs skip without failure, envelope stays UPDATED with records", async () => {
	const { root, home, stateRoot } = fixtureDirs("optout");
	recordOptOut(home, "rule:rules/foo", "operator keeps custom foo");
	recordOptOut(home, "service:kit-update", "no auto service here");
	const calls: string[][] = [];
	const result = await applyActivationManifest({ root, home, stateRoot, binary: "/nonexistent/omp-kit",
		exec: async (argv) => { calls.push([...argv]); return { exit: 0, stdout: JSON.stringify({ code: 0, data: {} }), stderr: "" }; } });
	expect(result.ok).toBe(true);
	expect(result.failed).toEqual([]);
	expect(result.skipped.map((s) => s.item)).toContain("rules:rules");
	expect(result.skipped.map((s) => s.item)).toContain("service:kit-update");
	expect(calls.some((argv) => argv.includes("kit-update"))).toBe(false);
	const out = updatePostApplyEnvelope(envelopeBase, { ok: true, detail: "linked" }, result, root);
	expect(out.code).toBe(0);
	expect(out.data["overall"]).toBe("UPDATED");
});

test("planted: a failing service apply reports FINDINGS, never UPDATED", async () => {
	const { root, home, stateRoot } = fixtureDirs("servicefail");
	const result = await applyActivationManifest({ root, home, stateRoot, binary: "/nonexistent/omp-kit",
		exec: async (argv) => argv.includes("kit-update")
			? { exit: 1, stdout: JSON.stringify({ code: 1, errors: [{ code: "BOOTSTRAP_FAILED", message: "synthetic" }] }), stderr: "" }
			: { exit: 0, stdout: JSON.stringify({ code: 0, data: {} }), stderr: "" } });
	expect(result.ok).toBe(false);
	expect(result.failed.map((f) => f.item)).toContain("service:kit-update");
	const out = updatePostApplyEnvelope(envelopeBase, { ok: true, detail: "linked" }, result, root);
	expect(out.code).toBe(1);
	expect(out.data["overall"]).toBe("FINDINGS");
	const section = out.data["manifest"];
	expect(section !== null && typeof section === "object" && "status" in section ? section.status : null).toBe("FINDINGS");
});
test("planted: a failed relink reports FINDINGS, never UPDATED", async () => {
	const out = updatePostApplyEnvelope(envelopeBase,
		{ ok: false, detail: "synthetic relink break" }, null, "/nonexistent/store");
	expect(out.code).toBe(1);
	expect(out.data["overall"]).toBe("FINDINGS");
	expect(out.data["manifest"]).toBeNull();
	expect(out.errors?.some((e) => e.code === "PLUGIN_RELINK_FAILED")).toBe(true);
});

test("corrupt opt-out record fails the loop without applying", async () => {
	const { root, home, stateRoot } = fixtureDirs("badoptout");
	mkdirSync(join(home, ".config", "omp-kit"), { recursive: true });
	writeFileSync(join(home, ".config", "omp-kit", "activation-optouts.json"), "{corrupt");
	let execCalls = 0;
	const result = await applyActivationManifest({ root, home, stateRoot, binary: "/nonexistent/omp-kit",
		exec: async () => { execCalls += 1; return { exit: 0, stdout: "{}", stderr: "" }; } });
	expect(result.ok).toBe(false);
	expect(result.failed.map((f) => f.item)).toContain("opt-outs");
	expect(execCalls).toBe(0);
	expect(result.rulesApplied).toBe(0);
});
