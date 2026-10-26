// Conformance tests for src/kitlib/tmp.ts and scripts/kitlib-tmp.sh (ompkit-41l85, KITLIB-TMP v1).
// Every case comes from tests/fixtures/kitlib-tmp/corpus.json, the same corpus
// tests/scripts/kitlib_tmp_test.py runs against scripts/kitlib_tmp.py, so the
// three languages cannot drift. Each case runs a real child process in its own
// process group under a root this test owns (made with ownedTmp itself) and
// removes in `finally`, so the test leaves nothing behind.
import { describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp";
import { parseOwnerFile } from "../../src/scratch";

type Expect = {
	rc?: number | Record<string, number>; signal?: string; dirs: "gone" | "kept"; stdout_has?: string; stderr_has?: string; outside_intact?: boolean;
};
type Case = { id: string; action: string; label?: string; kill?: string; outside?: boolean; auto_cleanup?: boolean; expect: Expect };
type Negative = { id: string; case: string; action: string; auto_cleanup?: boolean; caught_by: string };
type Lang = "ts" | "sh" | "dash";

const REPO = join(import.meta.dir, "../..");
const corpus = JSON.parse(readFileSync(join(REPO, "tests/fixtures/kitlib-tmp/corpus.json"), "utf8")) as { schema: string; cases: Case[]; planted_negatives: Negative[] };
const CHILD_DEADLINE_MS = 20_000;

const TS_CHILD = `
import { chmodSync, mkdirSync, symlinkSync, writeFileSync, writeSync } from "node:fs";
// Runtime-selected: the library path arrives in KT_LIB because this source runs as bun -e, outside the module graph.
const { ownedTmp } = await import(process.env.KT_LIB);
const root = process.env.KT_ROOT;
const action = process.env.KT_ACTION;
const autoCleanup = process.env.KT_AUTO_CLEANUP !== "0";
const a = ownedTmp("kitlib-a", { root, autoCleanup });
const b = ownedTmp("kitlib-b", { root, bead: "ompkit-41l85", autoCleanup });
writeSync(1, a.path + "\\n" + b.path + "\\n");
// The children are real processes; a pending timer keeps one alive until its signal lands or the test kills it.
const linger = () => setTimeout(() => {}, 10000);
const sig = { sigterm: "SIGTERM", sigint: "SIGINT", sighup: "SIGHUP" }[action];
if (action === "fail") throw new Error("planned failure");
else if (sig) { process.kill(process.pid, sig); linger(); }
else if (action === "sigterm-unhooked") { process.removeAllListeners("SIGTERM"); process.kill(process.pid, "SIGTERM"); linger(); }
else if (action === "sigterm-other-listener") {
	process.on("SIGTERM", () => { writeSync(1, "other-listener\\n"); process.exit(7); });
	process.kill(process.pid, "SIGTERM");
	linger();
}
else if (action === "wait") { writeSync(1, "ready\\n"); setTimeout(() => {}, 60000); }
else if (action === "cleanup-twice") { a.cleanup(); a.cleanup(); b.cleanup(); b.cleanup(); writeSync(1, "cleaned\\n"); }
else if (action === "bad-label") {
	try { ownedTmp(process.env.KT_LABEL, { root }); writeSync(1, "ACCEPTED\\n"); }
	catch (error) { writeSync(2, String(error.message) + "\\n"); writeSync(1, "REFUSED\\n"); }
}
else if (action === "readonly-tree") {
	mkdirSync(a.path + "/ro/deep", { recursive: true });
	writeFileSync(a.path + "/ro/deep/file", "x");
	chmodSync(a.path + "/ro/deep", 0o555);
	chmodSync(a.path + "/ro", 0o555);
	symlinkSync(process.env.KT_OUTSIDE, a.path + "/link");
}
else if (action !== "exit0") throw new Error("unknown child action " + action);
`;

const SH_CHILD = `
. "$KT_LIB"
KITLIB_TMP_ROOT=$KT_ROOT
KITLIB_TMP_AUTO_CLEANUP=$KT_AUTO_CLEANUP
kitlib_tmp a kitlib-a || exit 90
KITLIB_TMP_BEAD=ompkit-41l85
kitlib_tmp b kitlib-b || exit 90
unset KITLIB_TMP_BEAD
printf '%s\\n%s\\n' "$a" "$b"
case $KT_ACTION in
	exit0) exit 0 ;;
	fail) exit 3 ;;
	sigterm) kill -s TERM $$; sleep 10 ;;
	sigint) kill -s INT $$; sleep 10 ;;
	sighup) kill -s HUP $$; sleep 10 ;;
	sigterm-unhooked) trap - EXIT HUP INT TERM; kill -s TERM $$; sleep 10 ;;
	wait) sleep 60 & printf 'ready\\n'; wait ;;
	cleanup-twice) kitlib_tmp_cleanup "$a"; kitlib_tmp_cleanup "$a"; kitlib_tmp_cleanup "$b"; kitlib_tmp_cleanup "$b"; printf 'cleaned\\n' ;;
	bad-label) if kitlib_tmp c "$KT_LABEL"; then printf 'ACCEPTED\\n'; else printf 'REFUSED\\n'; fi ;;
	readonly-tree) { mkdir -p "$a/ro/deep" && printf x >"$a/ro/deep/file" && chmod 0555 "$a/ro/deep" "$a/ro" && ln -s "$KT_OUTSIDE" "$a/link"; } || exit 91 ;;
	*) printf 'unknown child action %s\\n' "$KT_ACTION" >&2; exit 92 ;;
esac
`;

function childArgv(lang: Lang): { argv: string[]; lib: string } {
	if (lang === "ts") return { argv: [process.execPath, "-e", TS_CHILD], lib: join(REPO, "src/kitlib/tmp.ts") };
	return { argv: [lang === "dash" ? "/bin/dash" : "/bin/sh", "-c", SH_CHILD], lib: join(REPO, "scripts/kitlib-tmp.sh") };
}

interface Outcome { code: number | null; signal: string | null; stdout: string; stderr: string; pid: number; timedOut: boolean }

async function runChild(lang: Lang, action: string, root: string, kase: Case, outside: string | null, autoCleanup: boolean): Promise<Outcome> {
	const { argv, lib } = childArgv(lang);
	const env: Record<string, string> = { PATH: process.env.PATH ?? "/usr/bin:/bin", TMPDIR: root, KT_LIB: lib, KT_ROOT: root, KT_ACTION: action, KT_AUTO_CLEANUP: autoCleanup ? "1" : "0" };
	if (kase.label !== undefined) env.KT_LABEL = kase.label;
	if (outside !== null) env.KT_OUTSIDE = outside;
	const child = Bun.spawn(argv, { env, stdin: "ignore", stdout: "pipe", stderr: "pipe", detached: true });
	let timedOut = false;
	// A real-clock bound on a real child process: no fake timer can drive another process.
	const deadline = setTimeout(() => {
		timedOut = true;
		try { process.kill(-child.pid, "SIGKILL"); } catch { /* group gone */ }
	}, CHILD_DEADLINE_MS);
	const stderrText = new Response(child.stderr).text();
	let stdout = "";
	try {
		if (kase.kill) {
			const reader = child.stdout.getReader();
			const decoder = new TextDecoder();
			while (!stdout.includes("ready\n")) {
				const { value, done } = await reader.read();
				if (done) break;
				stdout += decoder.decode(value, { stream: true });
			}
			try { process.kill(-child.pid, kase.kill as NodeJS.Signals); } catch { /* group gone */ }
			for (;;) {
				const { value, done } = await reader.read();
				if (done) break;
				stdout += decoder.decode(value, { stream: true });
			}
		} else {
			stdout = await new Response(child.stdout).text();
		}
		await child.exited;
	} finally {
		clearTimeout(deadline);
		try { process.kill(-child.pid, "SIGKILL"); } catch { /* group already gone */ }
	}
	return { code: child.exitCode, signal: child.signalCode, stdout, stderr: await stderrText, pid: child.pid, timedOut };
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch (error) {
		return (error as NodeJS.ErrnoException).code === "EPERM";
	}
}

/** Every way `outcome` breaks `want`; empty when the case passes. */
function judge(lang: Lang, outcome: Outcome, want: Expect, root: string): string[] {
	const failures: string[] = [];
	if (outcome.timedOut) failures.push(`child outlived ${CHILD_DEADLINE_MS} ms`);
	if (want.rc !== undefined) {
		const rc = typeof want.rc === "number" ? want.rc : want.rc[lang === "dash" ? "sh" : lang];
		if (outcome.code !== rc || outcome.signal !== null) failures.push(`want exit ${rc}, got code=${outcome.code} signal=${outcome.signal}`);
	}
	if (want.signal !== undefined && outcome.signal !== want.signal) failures.push(`want signal ${want.signal}, got code=${outcome.code} signal=${outcome.signal}`);
	const dirs = outcome.stdout.split("\n").slice(0, 2);
	const expectedName = (label: string, path: string) => new RegExp(`^${label}\\.${outcome.pid}\\.[a-z0-9]{6}$`).test(path.slice(root.length + 1));
	if (dirs.length !== 2 || !dirs[0]!.startsWith(`${root}/`) || !expectedName("kitlib-a", dirs[0]!) || !expectedName("kitlib-b", dirs[1]!)) {
		failures.push(`stdout does not start with the two owned dir paths: ${JSON.stringify(outcome.stdout)}`);
		return failures;
	}
	const left = readdirSync(root).sort();
	if (want.dirs === "gone") {
		for (const dir of dirs) if (existsSync(dir)) failures.push(`dir survived: ${dir}`);
		if (left.length !== 0) failures.push(`root not empty: ${left.join(", ")}`);
	} else {
		const names = dirs.map(dir => dir.slice(root.length + 1)).sort();
		if (JSON.stringify(left) !== JSON.stringify(names)) failures.push(`want exactly ${names.join(", ")} kept, root holds ${left.join(", ")}`);
		if (pidAlive(outcome.pid)) failures.push(`child pid ${outcome.pid} is still alive`);
		for (const dir of dirs) {
			if (!existsSync(dir)) { failures.push(`dir removed: ${dir}`); continue; }
			if ((statSync(dir).mode & 0o777) !== 0o700) failures.push(`dir mode is not 0700: ${dir}`);
			const ownerPath = join(dir, ".owner");
			if (!existsSync(ownerPath)) { failures.push(`no .owner in ${dir}`); continue; }
			if ((statSync(ownerPath).mode & 0o777) !== 0o600) failures.push(`.owner mode is not 0600: ${dir}`);
			const owner = parseOwnerFile(readFileSync(ownerPath, "utf8"));
			if (owner === null) failures.push(`.owner does not parse: ${dir}`);
			else if (owner.processStart === null) failures.push(`.owner has no process incarnation: ${dir}`);
			else if (owner.pid !== outcome.pid) failures.push(`.owner pid ${owner.pid} is not the child's ${outcome.pid}`);
		}
		const ownerB = existsSync(join(dirs[1]!, ".owner")) ? parseOwnerFile(readFileSync(join(dirs[1]!, ".owner"), "utf8")) : null;
		if (ownerB !== null && ownerB.bead !== "ompkit-41l85") failures.push(`.owner bead is ${ownerB.bead}, want ompkit-41l85`);
	}
	if (want.stdout_has !== undefined && !outcome.stdout.includes(want.stdout_has)) failures.push(`stdout lacks ${want.stdout_has}: ${JSON.stringify(outcome.stdout)}`);
	if (want.stderr_has !== undefined && !outcome.stderr.includes(want.stderr_has)) failures.push(`stderr lacks ${want.stderr_has}: ${JSON.stringify(outcome.stderr)}`);
	return failures;
}

async function runCase(lang: Lang, kase: Case, action = kase.action, autoCleanup = kase.auto_cleanup !== false): Promise<string[]> {
	const owned = ownedTmp("kitlib-tmp-test");
	try {
		const root = join(owned.path, "root");
		mkdirSync(root, { mode: 0o700 });
		let outside: string | null = null;
		if (kase.outside) {
			outside = join(owned.path, "outside");
			mkdirSync(outside, { mode: 0o700 });
			writeFileSync(join(outside, "keep"), "keep\n");
			chmodSync(outside, 0o555);
		}
		const failures = judge(lang, await runChild(lang, action, root, kase, outside, autoCleanup), kase.expect, root);
		if (kase.expect.outside_intact && outside !== null) {
			if ((statSync(outside).mode & 0o777) !== 0o555) failures.push(`OUTSIDE mode changed: ${(statSync(outside).mode & 0o777).toString(8)}`);
			if (!existsSync(join(outside, "keep"))) failures.push("OUTSIDE lost its file keep");
		}
		return failures;
	} finally {
		owned.cleanup(); // holds the 0555 OUTSIDE when the case has one: the fix dogfooded on the test's own root
	}
}

if (corpus.schema !== "kitlib-tmp-corpus.v1" || corpus.cases.length === 0) throw new Error("tests/fixtures/kitlib-tmp/corpus.json is not a kitlib-tmp-corpus.v1 corpus");

// /bin/sh is bash 3.2 on macOS, which also runs its EXIT trap on a caught fatal signal; dash (Linux /bin/sh) does
// not, so running the sh corpus under dash too proves the HUP/INT/TERM traps themselves do the cleanup.
for (const lang of ["ts", "sh", ...(existsSync("/bin/dash") ? ["dash" as const] : [])] as const) {
	describe(`kitlib tmp conformance corpus (${lang})`, () => {
		for (const kase of corpus.cases) {
			test(kase.id, async () => {
				expect(await runCase(lang, kase)).toEqual([]);
			}, CHILD_DEADLINE_MS + 10_000);
		}
		// Planted negatives: a test-only child variant (a dropped signal hook, or the default where the case asks for
		// autoCleanup: false). The library has no switch for this; the point is that the corpus judgement notices.
		for (const negative of corpus.planted_negatives) {
			test(`planted negative ${negative.id} is caught`, async () => {
				const kase = corpus.cases.find(item => item.id === negative.case)!;
				const failures = await runCase(lang, kase, negative.action, negative.auto_cleanup ?? kase.auto_cleanup !== false);
				expect(failures.some(failure => failure.startsWith(negative.caught_by))).toBe(true);
			}, CHILD_DEADLINE_MS + 10_000);
		}
	});
}

describe("kitlib tmp in-process surface", () => {
	test("labels outside ^[a-z0-9][a-z0-9-]{0,47}$ are refused naming the label", () => {
		for (const label of ["", "-a", "A", "a_b", "a.b", "a/b", "a".repeat(49), "kitlib\n"]) {
			expect(() => ownedTmp(label)).toThrow(`'${label}'`);
		}
		expect(ownedTmp("a".repeat(48)).path).toContain(`${"a".repeat(48)}.${process.pid}.`);
		cleanupAllOwnedTmp();
	});

	test("owner metadata records the creating process incarnation", () => {
		const owned = ownedTmp("kitlib-owner-identity");
		try {
			const owner = parseOwnerFile(readFileSync(join(owned.path, ".owner"), "utf8"));
			expect(owner?.pid).toBe(process.pid);
			expect(owner?.processStart).not.toBeNull();
		} finally {
			owned.cleanup();
		}
	});

	test("root defaults to os.tmpdir() and cleanupAllOwnedTmp removes every live dir", () => {
		const first = ownedTmp("kitlib-default");
		const second = ownedTmp("kitlib-default");
		expect(first.path.startsWith(`${tmpdir().replace(/\/$/, "")}/kitlib-default.${process.pid}.`)).toBe(true); // tempsafe: conformance of the default os.tmpdir root
		expect(first.path).not.toBe(second.path);
		cleanupAllOwnedTmp();
		expect(existsSync(first.path) || existsSync(second.path)).toBe(false);
		second.cleanup();
	});

	test("a missing root is refused and an invalid bead is refused", () => {
		const owned = ownedTmp("kitlib-root");
		try {
			expect(() => ownedTmp("kitlib-x", { root: join(owned.path, "absent") })).toThrow();
			expect(() => ownedTmp("kitlib-x", { root: owned.path, bead: "bad bead" })).toThrow("'bad bead'");
			expect(readdirSync(owned.path)).toEqual([".owner"]);
		} finally {
			owned.cleanup();
		}
	});

	test("with another SIGTERM listener, the dirs go and that listener decides the exit", async () => {
		const kase: Case = { id: "sigterm-other-listener", action: "sigterm-other-listener", expect: { rc: 7, dirs: "gone", stdout_has: "other-listener" } };
		expect(await runCase("ts", kase)).toEqual([]);
	}, CHILD_DEADLINE_MS + 10_000);

	test("cleanup() and cleanupAllOwnedTmp() remove a tree holding 0555 dirs", () => {
		for (const remove of ["cleanup", "all"] as const) {
			const owned = ownedTmp("kitlib-readonly");
			mkdirSync(join(owned.path, "releases", "0.0.1"), { recursive: true });
			writeFileSync(join(owned.path, "releases", "0.0.1", "bin"), "x");
			chmodSync(join(owned.path, "releases", "0.0.1"), 0o555);
			chmodSync(join(owned.path, "releases"), 0o555);
			if (remove === "cleanup") owned.cleanup();
			else cleanupAllOwnedTmp();
			expect(existsSync(owned.path)).toBe(false);
			owned.cleanup();
		}
	});
});
