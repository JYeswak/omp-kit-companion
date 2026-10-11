import { afterAll, expect, test } from "bun:test";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

// OMP's release notes are part of certification (ompkit-issue-pr-autopilot-w159.1). The changelog step reads every
// release after `certified` up to the candidate, derives kit surface terms from this checkout's code (--kit-root), and
// the body step turns a Breaking Changes / Removed entry that hits a surface without a recorded review into agent-fix.
// Each test drives the real script on offline release notes (--bodies) in a throwaway repo.
const REPO_ROOT = join(import.meta.dir, "..", "..");
const root = mkdtempSync(join(tmpdir(), "omp-kit-certify-changelog-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const breaking = (pkg: string, bullet: string) => `## ${pkg}\n\n### Breaking Changes\n\n- ${bullet}\n`;
// `ttsr.repeatMode` is written by the kit's TTSR policy (src/apply-policy.ts); `tui.fooMode` is touched by nothing in the kit.
const RENAME_USED = "Renamed the `ttsr.repeatMode` setting to `ttsr.repeatPolicy`; configs that still set `ttsr.repeatMode` are ignored.";
const RENAME_UNUSED = "Renamed the `tui.fooMode` setting to `tui.fooPolicy`; configs that still set `tui.fooMode` are ignored.";

/** A throwaway repo with the real script, release notes under notes/, and optionally a reviews file. */
function fixture(name: string, notes: Record<string, string>, reviews?: unknown): string {
	const repo = join(root, name);
	mkdirSync(join(repo, "scripts"), { recursive: true });
	cpSync(join(REPO_ROOT, "scripts", "omp-certify.ts"), join(repo, "scripts", "omp-certify.ts"));
	if (reviews !== undefined) writeFileSync(join(repo, "scripts", "omp-certify-reviews.json"), JSON.stringify(reviews));
	for (const [path, text] of Object.entries(notes)) {
		mkdirSync(dirname(join(repo, "notes", path)), { recursive: true });
		writeFileSync(join(repo, "notes", path), text);
	}
	return repo;
}
function script(repo: string, args: string[]) {
	const child = Bun.spawnSync([process.execPath, join(repo, "scripts", "omp-certify.ts"), ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
	return { code: child.exitCode, output: child.stdout.toString() + child.stderr.toString() };
}
interface Hit { surface: string; term: string; kind: string; where: string }
interface Entry { version: string; package: string; section: string; text: string; line: number; hash: string; hits: Hit[]; verdict: string | null; review: unknown; blocking: boolean }
interface Changelog { releases: { version: string; status: string; counts: Record<string, number> }[]; entries: Entry[]; reasons: string[] }
function changelog(repo: string, options: { to?: string; kitRoot?: string } = {}): Changelog {
	const result = script(repo, ["changelog", "--from", "1.0.0", "--to", options.to ?? "1.1.0", "--bodies", join(repo, "notes"),
		"--kit-root", options.kitRoot ?? REPO_ROOT, "--out", join(repo, "changelog.json"), "--md-out", join(repo, "changelog.md")]);
	expect(result.code, result.output).toBe(0);
	return JSON.parse(readFileSync(join(repo, "changelog.json"), "utf8")) as Changelog;
}
/** The publish decision for a candidate whose suites, differential and memory pins are all green: only the changelog decides. */
function decide(repo: string) {
	const tuple = { present: true, qualified: true, reason: "already reviewed on main" };
	const none = { id: null, family: null, selection: "not needed" };
	writeFileSync(join(repo, "review.json"), JSON.stringify({ schema_version: 2, from: "1.0.0", to: "1.1.0", files: [],
		tuples: { readiness: tuple, audit: tuple, redactor: tuple }, readiness_fingerprint: "", audit_pins: [], models: { advisory: none, reviewer: none } }));
	writeFileSync(join(repo, "table.md"), "| Check | 1.1.0 |\n");
	writeFileSync(join(repo, "regressions.json"), "[]");
	const result = script(repo, ["body", "--review", join(repo, "review.json"), "--pr", "7", "--suites-result", "success", "--suite-sha", "0".repeat(40),
		"--run-url", "https://example.invalid/run", "--key", "k", "--differential-table", join(repo, "table.md"),
		"--differential-regressions", join(repo, "regressions.json"), "--changelog", join(repo, "changelog.json"),
		"--body-out", join(repo, "body.md"), "--decision-out", join(repo, "decision.json"), "--issue-out", join(repo, "issue.json")]);
	expect(result.code, result.output).toBe(0);
	const decision = JSON.parse(readFileSync(join(repo, "decision.json"), "utf8")) as { eligible: boolean; reasons: string[] };
	let issue: { title: string; body: string } | null = null;
	try { issue = JSON.parse(readFileSync(join(repo, "issue.json"), "utf8")); } catch { issue = null; }
	return { ...decision, body: readFileSync(join(repo, "body.md"), "utf8"), issue };
}

test("C1: a Breaking entry renaming a setting key the kit writes blocks the merge and names the key", () => {
	const repo = fixture("c1-used-key", { "1.1.0.md": breaking("@oh-my-pi/pi-coding-agent", RENAME_USED) });
	const notes = changelog(repo);
	const [entry] = notes.entries;
	expect(entry).toMatchObject({ version: "1.1.0", package: "@oh-my-pi/pi-coding-agent", section: "breaking", verdict: "affected", blocking: true, line: 5 });
	expect(entry!.hits.map(hit => [hit.surface, hit.term, hit.kind])).toEqual([["settings", "ttsr.repeatMode", "exact"]]);
	// The term comes from the kit's code, with its source line.
	expect(entry!.hits[0]!.where).toMatch(/^src\/apply-policy\.ts:\d+$/);
	const decision = decide(repo);
	expect(decision.eligible).toBe(false);
	expect(decision.reasons).toHaveLength(1);
	expect(decision.reasons[0]).toContain("settings keys `ttsr.repeatMode` (src/apply-policy.ts:");
	expect(decision.body).toContain("| 1.1.0 Breaking Changes: Renamed the `ttsr.repeatMode` setting");
	expect(decision.body).toContain("| affected | **yes** |");
	expect(decision.issue!.title).toBe("OMP 1.1.0: certification blocked (OMP changelog)");
	expect(decision.issue!.body).toContain(`\`${entry!.hash}\` OMP 1.1.0 @oh-my-pi/pi-coding-agent Breaking Changes`);
	expect(decision.issue!.body).toContain("settings keys `ttsr.repeatMode`: kit code at `src/apply-policy.ts:");
});

test("C2: the same rename of a key the kit never touches is listed in the table but does not block", () => {
	const repo = fixture("c2-unused-key", { "1.1.0.md": breaking("@oh-my-pi/pi-coding-agent", RENAME_UNUSED) });
	const [entry] = changelog(repo).entries;
	expect(entry).toMatchObject({ section: "breaking", verdict: "needs review", blocking: false });
	expect(entry!.hits).toEqual([{ surface: "settings", term: "setting", kind: "keyword", where: "keyword" }]);
	const decision = decide(repo);
	expect(decision).toMatchObject({ eligible: true, reasons: [], issue: null });
	expect(decision.body).toContain("| 1.1.0 Breaking Changes: Renamed the `tui.fooMode` setting");
	expect(decision.body).toContain("settings keys: keyword \"setting\" | needs review | no |");
});

test("C3: notes spanning three releases are all parsed; releases outside (certified, candidate] are not read", () => {
	const repo = fixture("c3-three-releases", {
		// Certified and newer-than-candidate releases each carry a blocking entry: reading either one would block.
		"1.0.0.md": breaking("@oh-my-pi/pi-coding-agent", RENAME_USED),
		"1.2.0.md": breaking("@oh-my-pi/pi-coding-agent", RENAME_USED),
		"1.0.1.md": [
			"## @oh-my-pi/pi-ai", "", "### Changed", "", "- Improved retries", "  across providers.", "  - nested detail", "", "### Fixed", "", "- Fixed a crash.", "",
			"## @oh-my-pi/pi-tui", "", "### Removed", "", "* Removed `oldWidget()`.", "",
			"## What's Changed", "* chore: not release notes by @someone", "",
		].join("\n"),
		// 1.0.2 has no release body: its notes come from the package CHANGELOG.md, the fallback format.
		"packages/coding-agent/CHANGELOG.md": ["# Changelog", "", "## [Unreleased]", "", "## [1.0.2] - 2026-01-02", "", "### Changed", "", "- Faster startup.", "",
			"## [1.0.0] - 2026-01-01", "", "### Breaking Changes", "", `- ${RENAME_USED}`, ""].join("\n"),
		"1.1.0.md": "## @oh-my-pi/pi-utils\n\n### Breaking Changes\n\n- Renamed `takeA()` to `takeB()`.\n",
	});
	const notes = changelog(repo);
	expect(notes.releases.map(release => [release.version, release.status])).toEqual([["1.0.1", "parsed"], ["1.0.2", "parsed"], ["1.1.0", "parsed"]]);
	expect(notes.entries.map(entry => [entry.version, entry.package, entry.section, entry.text])).toEqual([
		["1.0.1", "@oh-my-pi/pi-ai", "changed", "Improved retries across providers. - nested detail"],
		["1.0.1", "@oh-my-pi/pi-ai", "fixed", "Fixed a crash."],
		["1.0.1", "@oh-my-pi/pi-tui", "removed", "Removed `oldWidget()`."],
		["1.0.2", "packages/coding-agent", "changed", "Faster startup."],
		["1.1.0", "@oh-my-pi/pi-utils", "breaking", "Renamed `takeA()` to `takeB()`."],
	]);
	expect(notes.entries[3]!.line).toBe(9);
	expect(notes.entries.find(entry => entry.section === "fixed")!.verdict).toBeNull();
	expect(notes.reasons).toEqual([]);
	expect(decide(repo).eligible).toBe(true);
});

test("C4: a review recorded under the entry's hash unblocks it; a malformed review fails closed", () => {
	const blocked = changelog(fixture("c4-blocked", { "1.1.0.md": breaking("@oh-my-pi/pi-coding-agent", RENAME_USED) })).entries[0]!;
	expect(blocked.blocking).toBe(true);
	const review = { hash: blocked.hash, verdict: "adapted", evidence: "kit policy migrated to ttsr.repeatPolicy in abc1234", reviewer: "PinkHorizon" };
	const repo = fixture("c4-reviewed", { "1.1.0.md": breaking("@oh-my-pi/pi-coding-agent", RENAME_USED) }, { schema_version: 1, reviews: [review] });
	const [entry] = changelog(repo).entries;
	expect(entry).toMatchObject({ verdict: "affected", blocking: false, review });
	const decision = decide(repo);
	expect(decision).toMatchObject({ eligible: true, reasons: [], issue: null });
	expect(decision.body).toContain("| affected; reviewed adapted by PinkHorizon: kit policy migrated to ttsr.repeatPolicy in abc1234 | reviewed |");
	const malformed = fixture("c4-malformed", { "1.1.0.md": breaking("@oh-my-pi/pi-coding-agent", RENAME_USED) }, { schema_version: 1, reviews: [{ ...review, verdict: "ok" }] });
	const result = script(malformed, ["changelog", "--from", "1.0.0", "--to", "1.1.0", "--bodies", join(malformed, "notes"), "--kit-root", REPO_ROOT, "--out", join(malformed, "changelog.json")]);
	expect(result.code).toBe(1);
	expect(result.output).toContain("verdict not-affected|adapted");
});

test("C5: match terms are derived from kit code: a key planted in kit source blocks, the same entry against the real kit does not", () => {
	const kit = join(root, "c5-kit");
	mkdirSync(join(kit, "src"), { recursive: true });
	for (const file of ["src/memory-readiness.ts", "src/memory-audit.ts"]) cpSync(join(REPO_ROOT, file), join(kit, file));
	writeFileSync(join(kit, "src", "planted.ts"), 'export const set = (invoke: Function) => invoke("default", ["config", "set", "planted.knobName", "1"]);\n');
	const notes = { "1.1.0.md": breaking("@oh-my-pi/pi-coding-agent", "Removed the `planted.knobName` setting.") };
	const planted = changelog(fixture("c5-planted", notes), { kitRoot: kit }).entries[0]!;
	expect(planted).toMatchObject({ verdict: "affected", blocking: true });
	expect(planted.hits[0]).toMatchObject({ surface: "settings", term: "planted.knobName", where: "src/planted.ts:1" });
	expect(changelog(fixture("c5-real", notes)).entries[0]).toMatchObject({ verdict: "needs review", blocking: false });
});

test("C6: surfaces derived from this checkout cover each kit surface, with their source lines and without prose noise", () => {
	const result = script(fixture("c6-surfaces", {}), ["surfaces", "--kit-root", REPO_ROOT]);
	expect(result.code, result.output).toBe(0);
	const surfaces = JSON.parse(result.output) as { id: string; terms: { text: string; kind: string; where: string }[] }[];
	const where = (id: string, text: string) => surfaces.find(surface => surface.id === id)!.terms.find(term => term.text === text)?.where;
	expect(where("settings", "ttsr.repeatMode")).toMatch(/^src\/apply-policy\.ts:\d+$/);
	expect(where("settings", "memory.backend")).toMatch(/^src\/memory-readiness\.ts:\d+$/);
	expect(where("settings", "extensions")).toMatch(/^scripts\/(doctor|install-extensions)\.sh:\d+$/);
	expect(where("ttsr", "interruptMode")).toMatch(/^rules\/.+\.md:\d+$/);
	expect(where("extension-api", "tool_call")).toMatch(/^extensions\/.+\.ts:\d+$/);
	expect(where("rpc", "--mode rpc")).toMatch(/^src\/mcp-probe\.ts:\d+$/);
	expect(where("rpc", "/mcp")).toBeDefined();
	expect(where("memory", "working_memory")).toMatch(/^src\/memory-audit\.ts:\d+$/);
	expect(where("cli", "--no-session")).toBeDefined();
	expect(where("cli", "config set")).toBeDefined();
	// Strings that only mention omp, file names and bare key names are not surface terms.
	for (const [id, text] of [["cli", "omp not"], ["cli", "omp runs"], ["cli", "omp findings"], ["settings", "ttsr.json"], ["rpc", "Enter"]])
		expect(where(id!, text!)).toBeUndefined();
});

test("C7: group keys, pinned packages and Changed entries classify as documented", () => {
	const repo = fixture("c7-rules", { "1.1.0.md": [
		breaking("@oh-my-pi/pi-coding-agent", "Removed the `ttsr.legacyKnob` setting."),
		breaking("@oh-my-pi/pi-mnemopi", "Reworked the bank layout."),
		"## @oh-my-pi/pi-natives\n\n### Changed\n\n- Updated the bundled `jq`, which `jq --version` now reports.\n",
		"## @oh-my-pi/pi-tui\n\n### Changed\n\n- `omp --no-session` now also skips the title card.\n",
	].join("\n") });
	const entries = changelog(repo).entries;
	expect(entries.map(entry => [entry.package, entry.verdict, entry.blocking, entry.hits.map(hit => `${hit.surface}:${hit.term}:${hit.kind}`)])).toEqual([
		["@oh-my-pi/pi-coding-agent", "needs review", true, ["settings:ttsr.:prefix"]],
		["@oh-my-pi/pi-mnemopi", "needs review", true, ["memory:@oh-my-pi/pi-mnemopi:package"]],
		["@oh-my-pi/pi-natives", "not affected", false, []],
		["@oh-my-pi/pi-tui", "affected", false, ["cli:--no-session:exact"]],
	]);
});

test("C8: release notes the step cannot read block until reviewed by version", () => {
	const notes = { "1.0.1.md": "## @oh-my-pi/pi-tui\n\n### Fixed\n\n- Fixed a flicker.\n" };
	const unread = fixture("c8-unread", notes);
	const result = changelog(unread);
	expect(result.releases.map(release => [release.version, release.status])).toEqual([["1.0.1", "parsed"], ["1.1.0", "unavailable"]]);
	expect(decide(unread).reasons).toEqual(["OMP changelog for 1.1.0 could not be read (no 1.1.0.md; no CHANGELOG.md section for this version); read it and record a review for v1.1.0 in scripts/omp-certify-reviews.json"]);
	const reviewed = fixture("c8-reviewed", notes, { schema_version: 1, reviews: [{ hash: "v1.1.0", verdict: "not-affected", evidence: "read the GitHub release by hand: docs only", reviewer: "PinkHorizon" }] });
	expect(changelog(reviewed).reasons).toEqual([]);
	expect(decide(reviewed).eligible).toBe(true);
});

test("C9: adversarial release text (long backtick runs, unterminated spans, many near-miss keys) is classified in bounded time", () => {
	const long = "`".repeat(100_000) + "x".repeat(100_000) + " ttsr.".repeat(20_000) + "`--json".repeat(20_000);
	const bullets = Array.from({ length: 3000 }, (_, index) => `- Entry ${index} mentions \`ttsr.repeatModeX\` and \`--jsonl\`.`).join("\n");
	const repo = fixture("c9-adversarial", { "1.1.0.md": `## @oh-my-pi/pi-coding-agent\n\n### Changed\n\n- ${long}\n${bullets}\n` });
	const started = performance.now();
	const notes = changelog(repo);
	expect(performance.now() - started).toBeLessThan(10_000);
	expect(notes.entries).toHaveLength(3001);
	// Near misses: a longer key is not the kit's `ttsr.repeatMode` (only its group is flagged) and `--jsonl` is not `--json`.
	expect(notes.entries[1]!.verdict).toBe("needs review");
	expect(notes.entries[1]!.hits.map(hit => `${hit.term}:${hit.kind}`)).toEqual(["ttsr.:prefix"]);
});
