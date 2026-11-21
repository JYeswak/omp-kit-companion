import { afterAll, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync, symlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import { run, RunResult } from "../../src/kitlib/run.ts";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";
import { nativeBr } from "./lib/native-br.ts";
import { fixtureDeadlineS } from "./fixture-process.ts";

const TEST_BUDGET_MS = fixtureDeadlineS(120) * 1_000;

afterAll(cleanupAllOwnedTmp);
const ROOT = resolve(import.meta.dir, "../..");
const decoder = new TextDecoder();
const AUTHOR = "FxAuthor";
const BUILDER = "FxBuilder";

const ROSTER = {
	sessions: {
		fx: {
			director: "FxObserver",
			seats: {
				FxAuthor: { role: "builder", profile: "codex", model: "openai-codex/gpt-6.2-sol" },
				FxBuilder: { role: "builder", profile: "codex", model: "openai-codex/gpt-6.2-sol" },
				FxPeerSame: { role: "builder", profile: "codex", model: "openai-codex/gpt-6.2-sol" },
				FxPeerOther: { role: "grader", profile: "claude", model: "anthropic/claude-sonnet-5-5" },
				FxObserver: { role: "director", profile: "codex", model: "openai-codex/gpt-6.2-sol" },
			},
		},
	},
};

function statusOf(node: unknown): string {
	if (node && typeof node === "object" && "status" in node && typeof node.status === "string") return node.status;
	throw new Error("native tracker returned no status");
}
function titleOf(node: unknown): string {
	if (node && typeof node === "object" && "title" in node && typeof node.title === "string") return node.title;
	return "";
}
function textOf(node: unknown): string {
	if (node && typeof node === "object" && "text" in node && typeof node.text === "string") return node.text;
	return "";
}
function issueRows(node: unknown): unknown[] {
	if (node && typeof node === "object" && "issues" in node && Array.isArray(node.issues)) return node.issues;
	if (Array.isArray(node)) return node;
	return [];
}
function idOf(node: unknown): string {
	if (node && typeof node === "object" && "id" in node && typeof node.id === "string") return node.id;
	throw new Error("fixture bead has no id");
}
async function fixture(agents: string[]) {
	const dir = ownedTmp("review-route-native").path;
	const repo = join(dir, "repo"), origin = join(dir, "origin.git"), bin = join(dir, "bin");
	mkdirSync(repo); mkdirSync(bin);
	const backend = nativeBr();
	symlinkSync(backend, join(bin, "br"));
	const mailLog = join(dir, "mail.log");
	const env: Record<string, string> = {
		HOME: dir, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_COUNT: "0",
		PATH: `${bin}:${process.env.PATH ?? ""}`, AGENT_NAME: BUILDER, BR_REAL: backend,
		OMP_KIT_FLEET_ROSTER: join(dir, "roster.json"),
		REVIEW_ROUTE_SESSION: "fx",
		AM_FIXTURE_AGENTS: JSON.stringify(agents),
		AM_MAIL_LOG: mailLog,
	};
	for (const [key, value] of Object.entries(process.env)) if (typeof value === "string" && !(key in env)) env[key] = value;
	for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE", "BEADS_DB", "BD_DB", "BD_DATABASE", "BEADS_JSONL", "GRADE_WAVE_SCRATCH"]) delete env[key];
	const checked = async (argv: string[], cwd = repo) => {
		const result = await run(argv, { cwd, env, deadline_s: fixtureDeadlineS(30), max_output_bytes: 4 << 20 });
		if (result.rc !== 0 || result.timed_out || result.truncated) throw new Error(`${argv.join(" ")}: ${result.rc}\n${decoder.decode(result.stdout)}${decoder.decode(result.stderr)}`);
		return decoder.decode(result.stdout).trim();
	};
	const git = (args: string[]) => checked(["git", "-C", repo, ...args]);
	await checked(["git", "init", "--bare", "-q", origin], dir);
	await git(["init", "-q", "-b", "main"]);
	await git(["config", "user.name", "Fixture"]);
	await git(["config", "user.email", "fixture@invalid.example"]);
	await git(["commit", "--allow-empty", "-q", "-m", "owned native fixture", "-m", "Bead: rr-trailer", "-m", `Agent: ${BUILDER}`]);
	await git(["remote", "add", "origin", origin]);
	await git(["push", "-q", "--set-upstream", "origin", "main"]);
	const published = await git(["rev-parse", "HEAD"]);
	const db = join(repo, ".beads/beads.db");
	const br = (args: string[]) => checked([backend, "--db", db, "--no-auto-import", "--no-auto-flush", ...args]);
	await br(["init", "--prefix", "rr", "--actor", BUILDER]);
	mkdirSync(join(repo, "tests"));
	writeFileSync(join(repo, "payload.txt"), "preserved\n");
	writeFileSync(join(repo, "tests/replay.sh"), "#!/bin/sh\n[ -f payload.txt ]\n", { mode: 0o755 });
	writeFileSync(join(dir, "roster.json"), JSON.stringify(ROSTER));
// Only the agent registry and mail transport are fixture adapters. Guard,
// publication checks, tracker database and the resulting transition are real.
	writeFileSync(join(bin, "am"), `#!${process.execPath}
const fs = require("node:fs");
const a = process.argv.slice(2);
if (a[0] === "agents" && a[1] === "show") console.log(JSON.stringify({name:process.env.AGENT_NAME}));
else if (a[0] === "agents" && a[1] === "list") console.log(process.env.AM_FIXTURE_AGENTS || "[]");
else if (a[0] === "file_reservations" && a[1] === "conflicts") console.log("No conflicts detected.");
else if (a[0] === "mail" && a[1] === "send") { fs.appendFileSync(process.env.AM_MAIL_LOG, a.join("\\n") + "\\n---\\n"); console.log("sent"); }
else process.exit(9);
`, { mode: 0o755 });
	mkdirSync(join(repo, ".git/omp-kit"), { recursive: true });
	writeFileSync(join(repo, ".git/omp-kit/fresh-gate-runs.jsonl"), JSON.stringify({ version: 2, commit: published, rc: 0, evidence: { complete: true } }) + "\n");
	const records = [
		{ id: "rr-main", created_by: AUTHOR, assignee: BUILDER },
		{ id: "rr-self", created_by: AUTHOR, assignee: AUTHOR },
	].map(({ id, created_by, assignee }) => ({
		id, title: "Route a named non-author reviewer on review entry", issue_type: "task", priority: 2,
		created_at: "2026-11-01T00:00:00Z", updated_at: "2026-11-01T00:00:00Z", created_by,
		status: "in_progress", assignee, labels: ["fixture"],
		description: "WHAT: entering in_review assigns a live non-author reviewer. WHY: review-age must fall without a chief queue.",
		acceptance_criteria: "- [x] [a] [build] fixture routes the reviewer wake `sh tests/replay.sh` -> rc 0; planted negative refuses a missing payload",
		dependencies: [], comments: [],
	}));
	writeFileSync(join(repo, ".beads/issues.jsonl"), records.map(record => JSON.stringify(record)).join("\n") + "\n");
	await br(["sync", "--import-only", "--actor", BUILDER]);
	const state = async (id: string) => {
		const parsed: unknown = JSON.parse(await br(["show", id, "--json"]));
		return statusOf(Array.isArray(parsed) ? parsed[0] : parsed);
	};
	const comments = async (id: string): Promise<string[]> => {
		const parsed: unknown = JSON.parse(await br(["comments", "list", id, "--json"]));
		const rows: unknown[] = Array.isArray(parsed) ? parsed : [];
		return rows.map(textOf);
	};
	const shim = (args: string[], actor = BUILDER) => run(["sh", join(ROOT, "scripts/br-shim.sh"), "--db", db, ...args], {
		cwd: repo, env: { ...env, AGENT_NAME: actor }, deadline_s: fixtureDeadlineS(60), max_output_bytes: 4 << 20,
	});
	const reason = `DONE ${repo}@${published}: native fixture qualification`;
	return { dir, repo, origin, published, env, git, br, state, comments, shim, reason, mailLog };
}

function output(result: RunResult): string {
	return decoder.decode(result.stdout) + decoder.decode(result.stderr);
}

function mailSent(logPath: string): string {
	try { return readFileSync(logPath, "utf8"); } catch { return ""; }
}

test("REVIEWROUTE review entry assigns a live non-author seat and wakes it with the exact verify command", async () => {
	const f = await fixture([AUTHOR, BUILDER, "FxPeerSame", "FxPeerOther", "FxObserver"]);
	// FxPeerOther carries one in_review load but a different model family, so it wins
	// over the same-family zero-load FxPeerSame; the zero-load author is never chosen.
	await f.br(["create", "--title", "load holder", "--actor", BUILDER]);
	const holder = idOf(issueRows(JSON.parse(await f.br(["list", "--json"]))).find(row => titleOf(row) === "load holder"));
	await f.br(["update", holder, "--assignee", "FxPeerOther", "--actor", BUILDER]);
	await f.br(["update", holder, "--status", "in_review", "--transition-comment", f.reason, "--actor", BUILDER]);
	expect(await f.state(holder)).toBe("in_review");
	const moved = await f.shim(["update", "rr-main", "--status", "in_review", "--transition-comment", f.reason]);
	expect(await f.state("rr-main")).toBe("in_review");
	const expected = `omp-kit verify rr-main --export ${f.published} --project ${f.repo} --actor FxPeerOther --family anthropic`;
	const texts = await f.comments("rr-main");
	expect(texts.some(text => text.includes(`REVIEWROUTE FxPeerOther: ${expected}`))).toBe(true);
	const mail = mailSent(f.mailLog);
	expect(mail.includes("FxPeerOther") && mail.includes(expected)).toBe(true);
}, TEST_BUDGET_MS);

test("REVIEWROUTE planted author-as-reviewer negative: the least-loaded author is never chosen", async () => {
	const f = await fixture([AUTHOR, "FxPeerSame"]);
	// rr-self is the author's own build; the author sits at zero load while the
	// only eligible peer carries two in_review loads. The peer must still win.
	for (let i = 0; i < 2; i++) {
		await f.br(["create", "--title", `peer load ${i}`, "--actor", AUTHOR]);
		const holder = idOf(issueRows(JSON.parse(await f.br(["list", "--json"]))).find(row => titleOf(row) === `peer load ${i}`));
		await f.br(["update", holder, "--assignee", "FxPeerSame", "--actor", AUTHOR]);
		await f.br(["update", holder, "--status", "in_review", "--transition-comment", f.reason, "--actor", AUTHOR]);
	}
	const moved = await f.shim(["update", "rr-self", "--status", "in_review", "--transition-comment", f.reason], AUTHOR);
	expect(moved.rc, output(moved)).toBe(0);
	// Holder loads were set directly through the backend, so only the author's own entry routes.
	const texts = await f.comments("rr-self");
	const routed = texts.filter(text => text.startsWith("REVIEWROUTE FxPeerSame:"));
	expect(routed.length).toBe(1);
	expect(texts.some(text => text.includes(`REVIEWROUTE ${AUTHOR}:`))).toBe(false);
	expect(mailSent(f.mailLog).includes(`--to\n${AUTHOR}\n`)).toBe(false);
}, TEST_BUDGET_MS);

test("REVIEWROUTE planted out-of-project negative: a foreign live seat is never chosen", async () => {
	const f = await fixture([BUILDER, "FxForeign", "FxPeerSame", "FxObserver"]);
	// FxObserver carries one direct-backend in_review load, so the zero-load FxPeerSame
	// wins the tiebreak among same-family peers; the zero-load foreign seat must lose.
	await f.br(["create", "--title", "observer load", "--actor", BUILDER]);
	const holder = idOf(issueRows(JSON.parse(await f.br(["list", "--json"]))).find(row => titleOf(row) === "observer load"));
	await f.br(["update", holder, "--assignee", "FxObserver", "--actor", BUILDER]);
	await f.br(["update", holder, "--status", "in_review", "--transition-comment", f.reason, "--actor", BUILDER]);
	const moved = await f.shim(["update", "rr-main", "--status", "in_review", "--transition-comment", f.reason]);
	expect(moved.rc, output(moved)).toBe(0);
	const texts = await f.comments("rr-main");
	expect(texts.some(text => text.startsWith("REVIEWROUTE FxPeerSame:"))).toBe(true);
	expect(texts.some(text => text.includes("REVIEWROUTE FxForeign"))).toBe(false);
	expect(mailSent(f.mailLog).includes("FxForeign")).toBe(false);
}, TEST_BUDGET_MS);

test("REVIEWROUTE no eligible seat routes pending to the observer and keeps the handoff", async () => {
	const f = await fixture([BUILDER]);
	const moved = await f.shim(["update", "rr-main", "--status", "in_review", "--transition-comment", f.reason]);
	expect(moved.rc, output(moved)).toBe(0);
	expect(await f.state("rr-main")).toBe("in_review");
	const texts = await f.comments("rr-main");
	expect(texts.some(text => text.includes("REVIEWROUTE PENDING rr-main"))).toBe(true);
	const mail = mailSent(f.mailLog);
	expect(mail.includes("FxObserver") && mail.includes("PENDING")).toBe(true);
}, TEST_BUDGET_MS);
