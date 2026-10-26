import { expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
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
