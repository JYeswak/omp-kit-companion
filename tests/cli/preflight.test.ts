import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { envelope, parseFindingLines, renderEnvelope } from "../../src/kitlib/findings.ts";
import { preflightBead, preflightCommit } from "../../src/preflight.ts";
import { run } from "../../src/kitlib/run.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";

const base = ownedTmp("preflight-test").path;

async function sh(cmd: string[], cwd: string): Promise<string> {
	const r = await run(cmd, { cwd, deadline_s: 60 });
	const out = new TextDecoder().decode(r.stdout);
	if (r.rc !== 0) throw new Error(`${cmd.join(" ")} -> ${r.rc}: ${new TextDecoder().decode(r.stderr)}`);
	return out;
}

async function repoWithChain(name: string): Promise<string> {
	const repo = join(base, name);
	mkdirSync(repo, { recursive: true });
	await sh(["git", "init", "-q"], repo);
	await sh(["git", "-c", "user.name=t", "-c", "user.email=t@x", "commit", "-q", "--allow-empty", "-m", "root [test]"], repo);
	const dir = join(repo, ".git", "hooks", "hooks.d");
	for (const kind of ["pre-commit", "commit-msg"]) mkdirSync(join(dir, kind), { recursive: true });
	// two members: one converted (FINDING lines, exit 0), one legacy (refuses with stderr, exit 1)
	writeFileSync(join(dir, "commit-msg", "40-converted"), "#!/bin/sh\nprintf 'FINDING\\tbead\\tBEAD_TRAILER\\tno Bead: trailer\\tadd it\\tgit commit --amend --trailer Bead=x\\n'\nprintf 'FINDING\\tnotes\\tFRAGMENT\\tno fragment\\twrite changelog.d/x.md\\t-\\n'\nexit 0\n");
	writeFileSync(join(dir, "commit-msg", "10-legacy"), "#!/bin/sh\ngrep -q '\\[test\\]' \"$1\" && exit 0\necho 'verification-level REFUSE reason=no-level' >&2\nexit 1\n");
	chmodSync(join(dir, "commit-msg", "40-converted"), 0o755);
	chmodSync(join(dir, "commit-msg", "10-legacy"), 0o755);
	return repo;
}

test("preflight commit: four defects produce ONE envelope naming all four, each with a remedy; the staged --selftest runs", async () => {
	const repo = await repoWithChain("four");
	mkdirSync(join(repo, "scripts"));
	writeFileSync(join(repo, "scripts", "broken.py"), "import sys\nif '--selftest' in sys.argv:\n    print('selftest: FAIL planted'); sys.exit(1)\n");
	writeFileSync(join(repo, "f.txt"), "x\n");
	await sh(["git", "add", "scripts/broken.py", "f.txt"], repo);
	const msg = join(repo, "msg.txt");
	writeFileSync(msg, "feat: no level\n");
	const env = await preflightCommit(repo, { message: msg });
	expect(env.ok).toBe(false);
	expect(env.snapshot).toMatch(/^tree:[0-9a-f]{40}$/);
	expect(env.findings.map(f => f.code).sort()).toEqual(["BEAD_TRAILER", "FRAGMENT", "MEMBER_REFUSED", "SELFTEST_FAILED"]);
	expect(env.findings.every(f => f.remedy.length > 0)).toBe(true);
	expect(env.findings.find(f => f.code === "BEAD_TRAILER")?.fix).toEqual(["git", "commit", "--amend", "--trailer", "Bead=x"]);
	expect(env.findings.find(f => f.code === "SELFTEST_FAILED")?.detail).toContain("scripts/broken.py: selftest: FAIL planted");
	expect(renderEnvelope(env)).toContain("commit REFUSED: 4 finding(s)");
	// planted: the same change with the legacy defect fixed and the selftest passing prints exactly the converted member's two
	writeFileSync(join(repo, "scripts", "broken.py"), "import sys\nif '--selftest' in sys.argv:\n    sys.exit(0)\n");
	await sh(["git", "add", "scripts/broken.py"], repo);
	writeFileSync(msg, "feat: one [test]\n");
	const again = await preflightCommit(repo, { message: msg });
	expect(again.findings.map(f => f.code).sort()).toEqual(["BEAD_TRAILER", "FRAGMENT"]);
	// nothing changed: the index and the message files are as we left them (no side effect)
	expect(await sh(["git", "status", "--porcelain"], repo)).toContain("A  f.txt");
});

test("preflight honors bash members and staged selftests, retaining real refusals and no-shebang scripts", async () => {
	const repo = await repoWithChain("interpreters");
	const member = join(repo, ".git", "hooks", "hooks.d", "pre-commit", "20-bash");
	writeFileSync(member, "#!/bin/bash\nread -r value < <(printf 'ready\\n')\n[ \"$value\" = ready ] || exit 7\nprintf 'FINDING\\tbash\\tREAL_REFUSAL\\tpolicy violation\\tfix policy\\t-\\n'\nexit 3\n");
	chmodSync(member, 0o755);
	writeFileSync(join(repo, "bash.sh"), "#!/bin/bash\n# --selftest\nread -r value < <(printf 'ready\\n')\n[ \"$value\" = ready ]\n");
	writeFileSync(join(repo, "plain.sh"), "# --selftest\nexit 0\n");
	writeFileSync(join(repo, "quoted.py"), "#!/usr/bin/env -S python3 -c 'import sys; sys.exit(0)'\n# --selftest\n");
	await sh(["git", "add", "bash.sh", "plain.sh", "quoted.py"], repo);
	const msg = join(repo, "msg.txt");
	writeFileSync(msg, "feat: interpreter regression [test]\n");
	const result = await preflightCommit(repo, { message: msg });
	expect(result.findings.map(f => f.code).sort()).toEqual(["BEAD_TRAILER", "FRAGMENT", "REAL_REFUSAL"]);
	expect(result.ok).toBe(false);
});

test("preflight commit: an empty index is a finding; with no prepared message that is a finding too, never a pass", async () => {
	const repo = await repoWithChain("empty");
	const prepared = await preflightCommit(repo);
	expect(prepared.findings.map(f => f.code)).toContain("NOTHING_STAGED");
	await sh(["rm", "-f", join(repo, ".git", "COMMIT_EDITMSG")], repo);
	const bare = await preflightCommit(repo);
	expect(bare.findings.map(f => f.code)).toEqual(expect.arrayContaining(["NOTHING_STAGED", "NO_MESSAGE"]));
	expect(bare.ok).toBe(false);
});

test("preflight close|in-review|claim: every tracker predicate in one envelope, bound to updated_at; a fake br answers", async () => {
	const bin = join(base, "bin");
	mkdirSync(bin, { recursive: true });
	const bead = { id: "kit-1", status: "in_review", assignee: "Author", updated_at: "2026-10-25T00:00:00Z", labels: ["human-gate"],
		acceptance_criteria: "- [x] [a] [landed] one\n- [ ] [b] [landed] two\n- [ ] three untagged\n" };
	writeFileSync(join(bin, "br"), `#!/bin/sh\ncase "$1" in show) printf '%s' '${JSON.stringify([bead])}' ;; list) printf '[{"id":"kit-9"}]' ;; esac\n`);
	chmodSync(join(bin, "br"), 0o755);
	const env = { PATH: `${bin}:${process.env.PATH ?? ""}` };
	const close = await preflightBead("close", base, "kit-1", { actor: "Author", env });
	expect(close.snapshot).toBe("bead:2026-10-25T00:00:00Z");
	expect(close.findings.filter(f => f.blocking).map(f => f.code).sort()).toEqual(["AC_UNTICKED", "SELF_CLOSE"]);
	expect(close.findings.find(f => f.code === "AC_UNTICKED")?.fix).toEqual(["br", "update", "kit-1", "--check-acceptance", "2,3"]);
	expect(close.findings.map(f => f.code)).toEqual(expect.arrayContaining(["REVIEWER_GATE", "TRANSITION_COMMENT"]));
	const peer = await preflightBead("close", base, "kit-1", { actor: "Peer", env });
	expect(peer.findings.map(f => f.code)).not.toContain("SELF_CLOSE");
	const review = await preflightBead("in-review", base, "kit-1", { env });
	expect(review.findings.map(f => f.code)).toEqual(expect.arrayContaining(["NOT_IN_PROGRESS", "AC_PHASE_MISSING"]));
	const claim = await preflightBead("claim", base, "kit-1", { actor: "Peer", env });
	expect(claim.findings.map(f => f.code).sort()).toEqual(["ASSIGNED", "GATED_LABEL", "NOT_OPEN", "SEAT_BUSY"]);
	// planted: a br that cannot answer is UNJUDGED, never ok
	writeFileSync(join(bin, "br"), "#!/bin/sh\necho 'Error: Issue not found' >&2\nexit 3\n");
	const gone = await preflightBead("claim", base, "kit-404", { env });
	expect(gone.ok).toBe(false);
	expect(gone.findings[0]?.code).toBe("UNJUDGED");
});

const hasBr = Bun.which("br") !== null;
const hasOmpKit = Bun.which("omp-kit") !== null;
const kitRoot = new URL("../../", import.meta.url).pathname;

async function nativeFixtureRoot(label: string): Promise<{ dir: string; capability: string }> {
	let repo: string | null = null;
	let scan = new URL("../../", import.meta.url).pathname;
	for (;;) {
		try { if (statSync(join(scan, ".git"))) { repo = scan; break; } } catch { /* keep walking up */ }
		const parent = join(scan, "..");
		if (parent === scan) break;
		scan = parent;
	}
	if (!repo) throw new Error("no enclosing repository found for owned fixture scratch");
	const made = await run(["omp-kit", "scratch", "new", "--label", label, "--json"], { deadline_s: 60, cwd: repo });
	const doc: unknown = JSON.parse(new TextDecoder().decode(made.stdout));
	const data: unknown = doc && typeof doc === "object" && "data" in doc ? doc.data : null;
	const dir = data && typeof data === "object" && "dir" in data && typeof data.dir === "string" ? data.dir : "";
	const capability = data && typeof data === "object" && "capability" in data && typeof data.capability === "string" ? data.capability : "";
	if (!dir || !capability) throw new Error("omp-kit scratch new printed no dir/capability");
	const owner: unknown = JSON.parse(readFileSync(join(dir, ".owner"), "utf8"));
	const agent: unknown = owner && typeof owner === "object" && "agent" in owner ? owner.agent : null;
	if (typeof agent !== "string" || agent.length === 0) throw new Error(`fixture root ${dir} lacks agent-attributed ownership; read-only guards cannot admit it`);
	return { dir, capability };
}
async function releaseFixtureRoot(root: { dir: string; capability: string }): Promise<void> {
	const r = await run(["omp-kit", "scratch", "release", root.dir, "--bin", "throwaway", "--now", "--capability", root.capability], { deadline_s: 60, cwd: kitRoot });
	if (r.rc !== 0) throw new Error(`scratch release failed: ${new TextDecoder().decode(r.stderr)}`);
}
async function claimFixture(name: string, actor: string, root: string): Promise<{ repo: string; gated: string; eligible: string }> {
	const repo = join(root, name);
	mkdirSync(repo, { recursive: true });
	await sh(["git", "init", "-q"], repo);
	await sh(["git", "-c", "user.name=t", "-c", "user.email=t@x", "commit", "-q", "--allow-empty", "-m", "root [test]"], repo);
	await sh(["br", "init"], repo);
	const ac = "- [ ] [a] [build] probe passes";
	const gatedOut = await sh(["br", "create", "gated bead [test]", "-l", "needs-director", "--acceptance-criteria", ac, "--silent", "--actor", actor], repo);
	const eligibleOut = await sh(["br", "create", "eligible bead [test]", "--acceptance-criteria", ac, "--silent", "--actor", actor], repo);
	const gated = gatedOut.trim().split("\n").filter(l => l.length > 0).at(-1)!;
	const eligible = eligibleOut.trim().split("\n").filter(l => l.length > 0).at(-1)!;
	return { repo, gated, eligible };
}

async function beadRow(repo: string, id: string): Promise<{ status: string; assignee: string | null; labels: string[] }> {
	const row = JSON.parse(await sh(["br", "show", id, "--json"], repo))[0];
	return { status: String(row.status), assignee: (typeof row.assignee === "string" && row.assignee) || null, labels: Array.isArray(row.labels) ? row.labels.map(String) : [] };
}
// Fleet-pane claim path: `br` resolves to the candidate shim, with a clear
// Agent Mail answer and the seat identity, exactly as an agent pane carries.
async function shimClaimEnv(actor: string, root: string): Promise<Record<string, string>> {
	const shimBin = join(root, "shimbin");
	mkdirSync(shimBin, { recursive: true });
	try { symlinkSync(join(import.meta.dir, "../../scripts/br-shim.sh"), join(shimBin, "br")); } catch { /* already linked */ }
	writeFileSync(join(shimBin, "am"), '#!/bin/sh\ncase "$1:$2" in agents:show) printf \'{"id":1,"name":"%s"}\\n\' "${AGENT_NAME:-unknown}"; exit 0 ;; file_reservations:conflicts) printf \'No conflicts detected.\\n\'; exit 0 ;; *) printf \'unexpected am call: %s\\n\' "$*" >&2; exit 99 ;; esac\n');
	chmodSync(join(shimBin, "am"), 0o755);
	return { ...process.env, PATH: `${shimBin}:${process.env.PATH ?? ""}`, AGENT_NAME: actor } as Record<string, string>;
}

test.skipIf(!hasBr || !hasOmpKit)("preflight claim: unresolved needs-director refuses NEEDS_DIRECTOR on the unit and the supported CLI path; recorded director resolution re-admits", { timeout: 120000 }, async () => {
	const actor = "TestSeatNeedsDirector";
	const root = await nativeFixtureRoot("needs-director");
	try {
		const { repo, gated, eligible } = await claimFixture("needs-director", actor, root.dir);
	// unit: the refusal is the named NEEDS_DIRECTOR code, and it is the sole
	// cause (open, unassigned, no other gated label, seat holds nothing)
	const pre = await preflightBead("claim", repo, gated, { actor });
	expect(pre.findings.filter(f => f.blocking).map(f => f.code)).toEqual(["NEEDS_DIRECTOR"]);
	expect(await beadRow(repo, gated)).toEqual({ status: "open", assignee: null, labels: expect.arrayContaining(["needs-director"]) });
	// review eligibility is unchanged: in-review never mentions needs-director
	const rev = await preflightBead("in-review", repo, gated, { actor });
	expect(rev.findings.map(f => f.code)).not.toContain("NEEDS_DIRECTOR");
	// supported actual claim path: the real CLI verb workers run refuses by name
	const cliPath = join(import.meta.dir, "../../src/cli.ts");
	const cli = await run([process.execPath, cliPath, "preflight", "claim", gated, "--project", repo, "--actor", actor, "--json"], { deadline_s: 120, cwd: repo });
	expect(cli.rc).not.toBe(0);
	expect(new TextDecoder().decode(cli.stdout)).toContain("NEEDS_DIRECTOR");
	expect(await beadRow(repo, gated)).toEqual({ status: "open", assignee: null, labels: expect.arrayContaining(["needs-director"]) });
	// actual supported claim boundary: the fleet-pane `br` (candidate shim) refuses by name, nothing mutates
	const mutation = await run(["br", "update", gated, "--claim", "--actor", actor], { deadline_s: 120, cwd: repo, env: await shimClaimEnv(actor, root.dir) });
	expect(mutation.rc).not.toBe(0);
	expect(new TextDecoder().decode(mutation.stderr)).toContain("NEEDS_DIRECTOR");
	expect(await beadRow(repo, gated)).toEqual({ status: "open", assignee: null, labels: expect.arrayContaining(["needs-director"]) });
	// eligible control, separate seat: preflight clean, and the real claim path mutates exactly the control bead
	const controlActor = "TestSeatControl";
	const okCtl = await preflightBead("claim", repo, eligible, { actor: controlActor });
	expect(okCtl.findings.filter(f => f.blocking)).toEqual([]);
	const okClaim = await run(["br", "update", eligible, "--claim", "--actor", controlActor], { deadline_s: 120, cwd: repo, env: await shimClaimEnv(controlActor, root.dir) });
	expect(okClaim.rc).toBe(0);
	expect(await beadRow(repo, eligible)).toEqual({ status: "in_progress", assignee: controlActor, labels: [] });
	expect(await beadRow(repo, gated)).toEqual({ status: "open", assignee: null, labels: expect.arrayContaining(["needs-director"]) });
	// recorded director disposition removes the label; the first bead becomes eligible and claims
	await sh(["br", "comments", "add", gated, "-m", "director disposition: regrade hold released, eligible to claim", "--actor", "Director"], repo);
	await sh(["br", "update", gated, "--remove-label", "needs-director", "--actor", "Director"], repo);
	const re = await preflightBead("claim", repo, gated, { actor });
	expect(re.findings.filter(f => f.blocking).map(f => f.code)).not.toContain("NEEDS_DIRECTOR");
	const reClaim = await run(["br", "update", gated, "--claim", "--actor", actor], { deadline_s: 120, cwd: repo, env: await shimClaimEnv(actor, root.dir) });
	expect(reClaim.rc).toBe(0);
	expect(await beadRow(repo, gated)).toEqual({ status: "in_progress", assignee: actor, labels: [] });
	} finally {
		await releaseFixtureRoot(root);
	}
});
test("neutralized fixture root (ownedTmp) carries no agent attribution for read-only guards", async () => {
	const dir = ownedTmp("neutralized").path;
	const raw = readFileSync(join(dir, ".owner"), "utf8");
	let agent: unknown = null;
	try {
		const parsed: unknown = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && "agent" in parsed) agent = parsed.agent;
	} catch { agent = null; }
	expect(typeof agent === "string" && agent.length > 0).toBe(false);
});

test("findings grammar: parse ignores noise and malformed lines; an empty list is ok", () => {
	const parsed = parseFindingLines("noise\nFINDING\tg\tC\td\tr\tgit x y\nFINDING\tshort\nFINDING\tg2\tC2\td2\tr2\t-\n");
	expect(parsed.map(f => [f.code, f.fix])).toEqual([["C", ["git", "x", "y"]], ["C2", null]]);
	expect(envelope("commit", null, "tree:x", []).ok).toBe(true);
});

test("every preflight verb is registered at module load (GATEDIAG1 [b] as published was HANDLER_UNAVAILABLE: the registrations sat inside rchLeaseCommand)", async () => {
	const cliPath = new URL("../../src/cli.ts", import.meta.url).pathname;
	const r = await run(["bun", "run", "--silent", cliPath, "capabilities", "--json"], { deadline_s: 120, max_output_bytes: 8 * 1024 * 1024 });
	const doc = JSON.parse(new TextDecoder().decode(r.stdout));
	const unavailable = (doc.data ?? doc).unavailable_commands ?? [];
	const names = unavailable.map((u: unknown) => (typeof u === "string" ? u : (u as { path?: string }).path ?? ""));
	expect(names.filter((n: string) => n.startsWith("preflight") || n === "verify")).toEqual([]);
});
