// LANDAUTHOREDON1 (ompkit-1ra0d.237).
// Affected-test source dependencies: src/land.ts scripts/check-stale-worktree.sh
import { expect, setDefaultTimeout, test } from "bun:test";
import { chmodSync, cpSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fixtureDeadlineS } from "./fixture-process.ts";
import { command, fixture, git, registerPushCheck, remoteHead, repoRoot, scratch } from "./private-index-land.helpers.ts";

setDefaultTimeout(Math.round(fixtureDeadlineS(90) * 1000));
const holds = [{ agent: "DarkFern", path: "owned.txt", exclusive: true, remaining_seconds: 3600 }];
const subject = "feat(land): edit a peer's line [test]";
const message = `${subject}\n\nBead: caller-237`;
type Mode = "paths" | "review";

function peerLine(work: string): string {
	writeFileSync(join(work, "owned.txt"), "base owned\npeer landed line\n");
	git(work, ["add", "owned.txt"]);
	git(work, ["commit", "-m", "feat(peer): add peer line [test]\n\nBead: peer-1"]);
	git(work, ["push", "origin", "HEAD:refs/heads/main"]);
	return git(work, ["rev-parse", "HEAD"]).trim();
}

function setup(afterBase = false) {
	const { work, fakeBin } = fixture();
	registerPushCheck(work, "#!/bin/sh\nexit 0\n");
	if (!afterBase) peerLine(work);
	const base = git(work, ["rev-parse", "HEAD"]).trim();
	const checkout = join(scratch, `authored-checkout-${globalThis.fixtureNumber++}`);
	cpSync(work, checkout, { recursive: true });
	if (afterBase) peerLine(work);
	writeFileSync(join(work, "owned.txt"), "base owned\ncaller edited peer line\n");
	writeFileSync(join(checkout, "owned.txt"), "base owned\ncaller edited peer line\n");
	// The real commit-msg member judges Git's --only index, not a fake gate.
	for (const name of ["check-stale-worktree.sh", "kitlib-tmp.sh"])
		cpSync(join(repoRoot, "scripts", name), join(work, ".git", "hooks", name));
	writeFileSync(join(work, ".git", "hooks", "commit-msg"), '#!/bin/sh\nexec sh "$(dirname "$0")/check-stale-worktree.sh" "$@"\n', { mode: 0o755 });
	writeFileSync(join(fakeBin, "ovnfs"), `#!/bin/sh
case "$1" in
  ls) printf '%s\\n' "$AUTHORED_CHECKOUTS" ;;
  diff) printf '%s\\n' '{"changes":[{"path":"owned.txt","status":"M"}]}' ;;
  *) exit 2 ;;
esac
`, { mode: 0o755 });
	// Keep the existing fixture's identity/reservation producer; review also
	// acquires/releases that same reservation and routes findings through mail.
	const am = join(fakeBin, "am");
	writeFileSync(am, readFileSync(am, "utf8").replace("  *) exit 2 ;;", '  "file_reservations reserve"|"file_reservations release"|"mail send") exit 0 ;;\n  *) exit 2 ;;'));
	chmodSync(am, 0o755);
	writeFileSync(join(fakeBin, "br"), "#!/bin/sh\nprintf '%s\\n' 'assignee: AuthorSeat' 'Acceptance:' '- [ ] [a] [build] Replay `test -f owned.txt` -> rc 0'\n", { mode: 0o755 });
	writeFileSync(join(fakeBin, "omp"), "#!/bin/sh\nprintf '%s\\n' 'VERDICT: LAND'\n", { mode: 0o755 });
	const repo = realpathSync(work);
	const env = {
		AUTHORED_CHECKOUTS: JSON.stringify({ checkouts: [{ name: "author", path: checkout, source: repo, dirty: true }] }),
		GIT_CEILING_DIRECTORIES: scratch,
	};
	return { work, fakeBin, checkout, base, env };
}

type Setup = { work: string; fakeBin: string; checkout: string; base: string; env: { AUTHORED_CHECKOUTS: string; GIT_CEILING_DIRECTORIES: string } };
function land(s: Setup, mode: Mode, msg = message) {
	return command(s.work, ["--checkout", "author", "--keep-checkout",
		...(mode === "paths" ? ["--paths", "owned.txt"] : ["--bead", "caller-237", "--review", "auto"]),
		"--message", msg, "--apply", "--yes"], holds, { amDir: s.fakeBin, gitEnv: s.env });
}

function publishedMessage(s: Setup): string {
	return git(s.work, ["show", "-s", "--format=%B", remoteHead(s.work)]).trimEnd();
}

for (const mode of ["paths", "review"] as const) {
	test(`LANDAUTHOREDON1 ${mode}: a peer line present at checkout base publishes`, () => {
		const s = setup();
		const result = land(s, mode);
		expect(result.status, JSON.stringify(result.body)).toBe(0);
		expect(result.body.data).toMatchObject({ overall: "PUSHED", authored_on: s.base });
		const landed = publishedMessage(s);
		expect(landed).toContain(`Authored-On: ${s.base}`);
		expect(landed.endsWith("Bead: caller-237")).toBe(true);
		expect(landed.split("\n\n").at(-1)).toContain(`Authored-On: ${s.base}`);
		if (mode === "review") expect(landed).toContain("Review-Verdict: LAND");
	});

	test(`LANDAUTHOREDON1 ${mode}: a peer line landed after the checkout base still refuses STALE_WORKTREE`, () => {
		const s = setup(true);
		const before = remoteHead(s.work);
		const result = land(s, mode);
		expect(result.status, JSON.stringify(result.body)).toBe(1);
		expect(JSON.stringify(result.body)).toContain("STALE_WORKTREE");
		expect(result.body.data).toMatchObject({ authored_on: s.base });
		expect(remoteHead(s.work)).toBe(before);
		expect(git(s.work, ["rev-parse", "HEAD"]).trim()).toBe(before);
	});

	test(`LANDAUTHOREDON1 ${mode}: an existing Authored-On trailer is retained exactly once`, () => {
		const s = setup();
		const result = land(s, mode, `${subject}\n\nAuthored-On: ${s.base}\nBead: caller-237`);
		expect(result.status, JSON.stringify(result.body)).toBe(0);
		expect(result.body.data).toMatchObject({ authored_on: null });
		const landed = publishedMessage(s);
		expect(landed.split("Authored-On:").length - 1).toBe(1);
		expect(landed).toContain(`Authored-On: ${s.base}`);
		expect(landed.endsWith("Bead: caller-237")).toBe(true);
	});
}

for (const missing of ["unresolved", "unreadable", "off-history", "foreign-repository"] as const) {
	test(`LANDAUTHOREDON1 paths: ${missing} checkout adds no provenance and creates no new refusal`, () => {
		const s = setup();
		if (missing === "unresolved") s.env.AUTHORED_CHECKOUTS = '{"checkouts":[]}';
		if (missing === "unreadable") {
			const empty = join(scratch, `authored-empty-${globalThis.fixtureNumber++}`);
			mkdirSync(empty);
			s.env.AUTHORED_CHECKOUTS = JSON.stringify({ checkouts: [{ name: "author", path: empty, source: realpathSync(s.work), dirty: true }] });
		}
		if (missing === "off-history") {
			git(s.checkout, ["add", "owned.txt"]);
			git(s.checkout, ["commit", "-m", "checkout-only commit [test]"]);
		}
		if (missing === "foreign-repository")
			s.env.AUTHORED_CHECKOUTS = JSON.stringify({ checkouts: [{ name: "author", path: s.checkout, source: s.checkout, dirty: true }] });
		// Same-bead edits already passed without provenance; resolution failure
		// must not introduce a refusal or insert an unproven Authored-On base.
		const result = land(s, "paths", `${subject}\n\nBead: peer-1`);
		expect(result.status, JSON.stringify(result.body)).toBe(0);
		expect(result.body.data).toMatchObject({ authored_on: null });
		expect(publishedMessage(s)).not.toContain("Authored-On:");
	});
}

test("LANDAUTHOREDON1 paths: body prose is not an Authored-On trailer", () => {
	const s = setup();
	const result = land(s, "paths", `${subject}\n\nAuthored-On: mentioned in body prose, not a trailer\nmore body prose\n\nBead: caller-237`);
	expect(result.status, JSON.stringify(result.body)).toBe(0);
	expect(result.body.data).toMatchObject({ authored_on: s.base });
	expect(publishedMessage(s).split("\n\n").at(-1)).toContain(`Authored-On: ${s.base}`);
});

test("LANDAUTHOREDON1 review: a checkout from another source adds no provenance or new refusal", () => {
	const s = setup();
	s.env.AUTHORED_CHECKOUTS = JSON.stringify({ checkouts: [{ name: "author", path: s.checkout, source: s.checkout, dirty: true }] });
	const result = land(s, "review", `${subject}\n\nBead: peer-1`);
	expect(result.status, JSON.stringify(result.body)).toBe(0);
	expect(result.body.data).toMatchObject({ authored_on: null });
	expect(publishedMessage(s)).not.toContain("Authored-On:");
});

test("LANDAUTHOREDON1 paths: an ancestor checkout base remains the authoring base after unrelated main advances", () => {
	const s = setup();
	writeFileSync(join(s.work, "peer.txt"), "unrelated newer main change\n");
	git(s.work, ["add", "peer.txt"]);
	git(s.work, ["commit", "-m", "feat(peer): unrelated change [test]\n\nBead: peer-2"]);
	git(s.work, ["push", "origin", "HEAD:refs/heads/main"]);
	const result = land(s, "paths");
	expect(result.status, JSON.stringify(result.body)).toBe(0);
	expect(result.body.data).toMatchObject({ authored_on: s.base });
	expect(publishedMessage(s)).toContain(`Authored-On: ${s.base}`);
});

test("LANDAUTHOREDON1 paths: a message without trailers gains a final trailer paragraph", () => {
	const s = setup();
	const result = land(s, "paths", subject);
	expect(result.status, JSON.stringify(result.body)).toBe(0);
	expect(publishedMessage(s)).toBe(`${subject}\n\nAuthored-On: ${s.base}`);
});
