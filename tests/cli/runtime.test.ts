import { createHash } from "node:crypto";
import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, readdirSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import process from "node:process";
import { delimiter, dirname, join, relative, resolve } from "node:path";
import { releaseRoot, resolveBundledScript, resolveOmpIdentity } from "../../src/paths.ts";
import { runtimeTempRoot, sanitizedEnv } from "../../src/runtime.ts";
import { createScratch, type LivenessDeps } from "../../src/scratch.ts";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";
import { installReadonlyBr, resolveRealBr } from "../../src/kitlib/readonly-br.ts";
import { run } from "../../src/kitlib/run.ts";
import { verifyBead } from "../../src/verify.ts";
import { identifyExactSource } from "../../scripts/exact-source.ts";
const createdScratchDirs: string[] = [];
afterAll(() => {
	for (const dir of createdScratchDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
	cleanupAllOwnedTmp();
});



function fixtureRoot(): string {
	// Keep owner-mismatch fixtures under the caller tree, independent of ambient TMPDIR.
	const scratchRoot = join(REPO_ROOT, "var", "agent-tmp");
	mkdirSync(scratchRoot, { recursive: true, mode: 0o700 });
	const root = realpathSync(ownedTmp("omp-kit-runtime", { root: scratchRoot }).path);
	return root;
}

function createOmp(prefix: string, version: string): { launcher: string; source: string } {
	const packageRoot = join(prefix, "releases", version);
	const source = join(packageRoot, "src");
	const launcher = join(prefix, "bin", "omp");
	mkdirSync(join(source, "export"), { recursive: true });
	mkdirSync(join(source, "capability"), { recursive: true });
	mkdirSync(join(source, "discovery"), { recursive: true });
	mkdirSync(join(packageRoot, "dist"), { recursive: true });
	mkdirSync(join(packageRoot, "node_modules", "@oh-my-pi", "pi-natives"), { recursive: true });
	writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-coding-agent" }));
	writeFileSync(join(packageRoot, "dist", "cli.js"), "#!/bin/sh\nexit 0\n");
	chmodSync(join(packageRoot, "dist", "cli.js"), 0o755);
	writeFileSync(join(packageRoot, "node_modules", "@oh-my-pi", "pi-natives", "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-natives" }));
	const piUtils = join(packageRoot, "node_modules", "@oh-my-pi", "pi-utils");
	mkdirSync(piUtils, { recursive: true });
	writeFileSync(join(piUtils, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-utils", exports: "./index.js" }));
	writeFileSync(join(piUtils, "index.js"), "export function parseFrontmatter(content) { return { frontmatter: {}, body: content }; }\n");
	for (const relative of ["export/ttsr.ts", "capability/rule.ts"]) writeFileSync(join(source, relative), "export {};\n");
	writeFileSync(join(source, "discovery", "helpers.ts"), "export const buildRuleFromMarkdown = () => ({});\nexport const createSourceMeta = () => ({});\n");
	mkdirSync(join(prefix, "bin"), { recursive: true });
	symlinkSync(join(packageRoot, "dist", "cli.js"), launcher);
	return { launcher, source };
}

function snapshotTree(root: string): string {
	const entries: string[] = [];
	const visit = (directory: string) => {
		for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
			const path = join(directory, entry.name);
			const stat = lstatSync(path);
			const name = relative(root, path);
			entries.push(`${name}\t${stat.mode & 0o777}\t${stat.size}\t${stat.mtimeMs}`);
			if (stat.isFile() && (entry.name.endsWith(".ts") || entry.name === "operator-marker" || entry.name === "TMPDIR-marker")) {
				entries.push(readFileSync(path, "utf8"));
			}
			if (entry.isDirectory()) visit(path);
			else if (entry.isSymbolicLink()) entries.push(`${name}\t->${readlinkSync(path)}`);
		}
	};
	visit(root);
	return entries.join("\n");
}

const REPO_ROOT = resolve(import.meta.dir, "../..");
/** Copy a source tree minus version control and runtime scratch. */
/** The top-level var/agent-tmp is runtime scratch, not source: sibling test files in a full gate create and delete their scratch there while this walk runs, so listing it races their deletes (ENOENT scandir). Skipping the subtree removes the race structurally. Never catch ENOENT instead: a copy that won the race would bake foreign scratch into the destination and change its digests. */
function copyTreeExceptGit(from: string, to: string, repoRoot: string, onVisit?: (srcPath: string) => void): void {
	mkdirSync(to, { recursive: true });
	for (const entry of readdirSync(from, { withFileTypes: true })) {
		if (entry.name === ".git") continue;
		const src = join(from, entry.name);
		const dst = join(to, entry.name);
		onVisit?.(src);
		const rel = relative(repoRoot, src);
		if (rel === "var/agent-tmp" || rel.startsWith("var/agent-tmp/")) continue;
		if (entry.isDirectory()) copyTreeExceptGit(src, dst, repoRoot, onVisit);
		else if (entry.isFile()) copyFileSync(src, dst);
	}
}

let canonicalScratchCount = 0;

/** A scratch dir made by the canonical writer `omp-kit scratch new --json` uses (createScratch, JSON .owner), owned by `repo`. */
function canonicalScratch(repo: string): string {
	const scratch = join(repo, "var", "agent-tmp");
	mkdirSync(scratch, { recursive: true, mode: 0o700 });
	const ledger = ownedTmp("runtime-ledger", { root: scratch }).path;
	const savedRoots = process.env.OMP_KIT_SCRATCH_ROOTS;
	process.env.OMP_KIT_SCRATCH_ROOTS = scratch;
	try {
		const liveness = { signalAlive: () => false, psVisible: () => false, processStart: () => "Mon Oct 18 17:32:44 2026",
			probe: () => { throw new Error("canonicalScratch never probes"); } } as unknown as LivenessDeps;
		const created = createScratch(`runtime-tests-${canonicalScratchCount++}`, repo,
			{ liveness, run: () => ({ code: 1, stdout: "", stderr: "" }), callerSeat: () => ({ agent: null, sessions: [], main: null }) },
			{}, true, join(ledger, "scratch-budgets.json"));
		if (!created.ok) throw new Error(`canonical scratch refused: ${created.reason} ${created.detail ?? ""}`);
		createdScratchDirs.push(created.dir);
		return realpathSync(created.dir);
	} finally {
		if (savedRoots === undefined) delete process.env.OMP_KIT_SCRATCH_ROOTS;
		else process.env.OMP_KIT_SCRATCH_ROOTS = savedRoots;
	}
}

function ownedRuntimeFixture(): { base: string; admission: Record<"OMP_KIT_TEST_WORK_ROOT" | "OMP_KIT_CASE_CWD", string> } {
	let root = process.env.OMP_KIT_TEST_WORK_ROOT;
	let caller = process.env.OMP_KIT_CASE_CWD ?? REPO_ROOT;
	if (!root) {
		// The adapter admits this root only when its .owner repo is exactly the caller workspace.
		root = canonicalScratch(REPO_ROOT);
		caller = REPO_ROOT;
	}
	// A kitlib name, omp-kit-runtime.<pid>.<6>, is the sandbox shape runtime-adapter.sh admits.
	const base = ownedTmp("omp-kit-runtime", { root }).path;
	return { base, admission: { OMP_KIT_TEST_WORK_ROOT: root, OMP_KIT_CASE_CWD: caller } };
}

async function validateWorkRoot(root: string, caller: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
	const result = await run(["sh", join(REPO_ROOT, "scripts", "runtime-adapter.sh"), "--validate-work-root"],
		{ deadline_s: 30, cwd: REPO_ROOT, env: { PATH: process.env.PATH ?? "/usr/bin:/bin", OMP_KIT_TEST_WORK_ROOT: root, OMP_KIT_CASE_CWD: caller } });
	return { code: result.rc, stdout: new TextDecoder().decode(result.stdout), stderr: new TextDecoder().decode(result.stderr) };
}

// ompkit-774u.39 WORKROOTJSON1: the adapter admits the JSON .owner `omp-kit scratch new` writes and refuses ambiguity.
describe("runtime-adapter --validate-work-root", () => {
	const mismatch = "OMP_KIT_TEST_WORK_ROOT .owner repo must match the caller workspace";

	test("admits a canonical JSON-owner scratch dir owned by the caller", async () => {
		const root = canonicalScratch(REPO_ROOT);
		expect(readFileSync(join(root, ".owner"), "utf8").trimStart().startsWith("{")).toBe(true);
		expect(await validateWorkRoot(root, REPO_ROOT)).toEqual({ code: 0, stdout: `${root}\n`, stderr: "" });
		// A value that spells "repo" is a value, not a key: `omp-kit scratch new --label repo` writes exactly this,
		// and string values may hold JSON punctuation. Indented JSON reads the same.
		for (const indent of [undefined, 2]) {
			const labeled = canonicalScratch(REPO_ROOT);
			const base = JSON.parse(readFileSync(join(labeled, ".owner"), "utf8")) as Record<string, unknown>;
			writeFileSync(join(labeled, ".owner"), JSON.stringify({ ...base, label: "repo", note: "a,b}:c{" }, null, indent));
			expect(await validateWorkRoot(labeled, REPO_ROOT)).toEqual({ code: 0, stdout: `${labeled}\n`, stderr: "" });
		}
	});

	test("refuses a JSON owner naming another repo, two repo values, a symlinked owner, or a dir outside var/agent-tmp", async () => {
		const other = fixtureRoot();
		const foreign = canonicalScratch(other);
		// A JSON owner naming another repo (its dir sits under that repo's var/agent-tmp, inside the caller's tree here).
		const foreignCase = await validateWorkRoot(foreign, REPO_ROOT);
		expect(foreignCase.code).not.toBe(0);
		expect(foreignCase.stderr).toContain(mismatch);
		// A dir outside the caller's var/agent-tmp, even with a well-formed owner.
		const outsideCase = await validateWorkRoot(canonicalScratch(REPO_ROOT), other);
		expect(outsideCase.code).not.toBe(0);
		expect(outsideCase.stderr).toContain(`must resolve under ${other}/var/agent-tmp`);
		// Foreign repo value inside the caller's own scratch tree.
		const relabeled = canonicalScratch(REPO_ROOT);
		const owner = JSON.parse(readFileSync(join(relabeled, ".owner"), "utf8")) as Record<string, unknown>;
		writeFileSync(join(relabeled, ".owner"), JSON.stringify({ ...owner, repo: other }));
		const relabeledCase = await validateWorkRoot(relabeled, REPO_ROOT);
		expect(relabeledCase.code).not.toBe(0);
		expect(relabeledCase.stdout).toBe("");
		expect(relabeledCase.stderr).toContain(mismatch);
		const doubled = canonicalScratch(REPO_ROOT);
		const text = readFileSync(join(doubled, ".owner"), "utf8").trim();
		writeFileSync(join(doubled, ".owner"), `${text.slice(0, -1)},"repo":${JSON.stringify(REPO_ROOT)}}`);
		const doubledCase = await validateWorkRoot(doubled, REPO_ROOT);
		expect(doubledCase.stderr).toContain(mismatch);
		expect(doubledCase.code).not.toBe(0);
		const escaped = canonicalScratch(REPO_ROOT);
		// `\/` decodes to `/`, so the JSON names the caller, but the adapter reads only unescaped values exactly.
		writeFileSync(join(escaped, ".owner"), JSON.stringify({ ...owner, repo: REPO_ROOT }).replace(`"repo":"/`, `"repo":"\\/`));
		expect((await validateWorkRoot(escaped, REPO_ROOT)).stderr).toContain(mismatch);
		// The only "repo" token sits in value position (malformed JSON): no real repo key, so it is refused.
		const valueToken = canonicalScratch(REPO_ROOT);
		writeFileSync(join(valueToken, ".owner"), `{"pid":${process.pid},"label":"repo":${JSON.stringify(REPO_ROOT)},"created_at":"2026-10-24T00:00:00.000Z"}`);
		const valueTokenCase = await validateWorkRoot(valueToken, REPO_ROOT);
		expect(valueTokenCase.code).not.toBe(0);
		expect(valueTokenCase.stderr).toContain(mismatch);
		// Shapes outside one flat object with a string repo value are refused: a nested repo object, text after
		// the closing brace, a repo key whose value is not a string, and (Rt39Verify) an unclosed outer object
		// whose only repo key sits in a nested object.
		for (const body of [
			`{"pid":${process.pid},"repo":{"path":${JSON.stringify(REPO_ROOT)}}}`,
			`${JSON.stringify({ ...owner, repo: REPO_ROOT })} trailing`,
			`{"pid":${process.pid},"repo":1,"label":${JSON.stringify(REPO_ROOT)}}`,
			`{"a":{"b":1,"repo":${JSON.stringify(REPO_ROOT)}}`,
		]) {
			const shaped = canonicalScratch(REPO_ROOT);
			writeFileSync(join(shaped, ".owner"), body);
			const shapedCase = await validateWorkRoot(shaped, REPO_ROOT);
			expect(shapedCase.code).not.toBe(0);
			expect(shapedCase.stderr).toContain(mismatch);
		}
		const linked = canonicalScratch(REPO_ROOT);
		const target = join(linked, "owner-target");
		writeFileSync(target, readFileSync(join(linked, ".owner")));
		rmSync(join(linked, ".owner"));
		symlinkSync(target, join(linked, ".owner"));
		const linkedCase = await validateWorkRoot(linked, REPO_ROOT);
		expect(linkedCase.code).not.toBe(0);
		expect(linkedCase.stderr).toContain("needs a regular nonsymlink .owner marker");
	});
});

test("isolated children retain the logical workspace root for case path scopes", () => {
	const identity = {
		launcher: resolve("omp/bin/omp"),
		packageRoot: resolve("omp"),
		source: resolve("omp/src"),
		nativeRoot: resolve("omp/node_modules/@oh-my-pi/pi-natives"),
	};
	const privateRoot = resolve("private-root");
	expect(sanitizedEnv(identity, { GITHUB_WORKSPACE: "/checkout" }, privateRoot).OMP_KIT_CASE_CWD).toBe("/checkout");
	expect(sanitizedEnv(identity, { OMP_KIT_CASE_CWD: "var/agent-tmp/fixture", GITHUB_WORKSPACE: "/checkout" }, privateRoot).OMP_KIT_CASE_CWD)
		.toBe(resolve("var/agent-tmp/fixture"));
	expect(sanitizedEnv(identity, {}, privateRoot).OMP_KIT_CASE_CWD).toBe(process.cwd());
});
test("native stage progress opt-in survives child environment sanitization", () => {
	const identity = {
		launcher: resolve("omp/bin/omp"),
		packageRoot: resolve("omp"),
		source: resolve("omp/src"),
		nativeRoot: resolve("omp/node_modules/@oh-my-pi/pi-natives"),
	};
	expect(sanitizedEnv(identity, { OMP_KIT_NATIVE_STAGE_PROGRESS: "1" }, resolve("private-root")).OMP_KIT_NATIVE_STAGE_PROGRESS)
		.toBe("1");
	expect(sanitizedEnv(identity, { OMP_KIT_NATIVE_STAGE_PROGRESS: "0" }, resolve("private-root")).OMP_KIT_NATIVE_STAGE_PROGRESS)
		.toBeUndefined();
});

for (const termination of ["nonzero", "signal"] as const) {
	test(`runtime shell ${termination} reports executed argv, canonical cwd, real exit, and EOF capture identities`, async () => {
		const { base, admission } = ownedRuntimeFixture();
		const release = join(base, "release");
		const executable = join(release, "bin", "omp-kit");
		const omp = createOmp(join(base, "omp"), "v1");
		for (const directory of ["release/bin", "release/scripts", "operator-home", "tmp"]) mkdirSync(join(base, directory), { recursive: true });
		writeFileSync(executable, "#!/bin/sh\nexit 99\n", { mode: 0o755 });
		const producer = join(release, "scripts", "actual-ladder.sh");
		const producerArgs = ["argument with spaces", "utf8-☃", ""];
		const fullStdout = "complete available runtime output ☃ ".repeat(200);
		const expectedStderr = termination === "nonzero" ? "complete diagnostic ☃ ".repeat(100) + "without newline" : "";
		writeFileSync(producer, [
			`printf '%s\\n' "$PWD" "$0" "$@"`,
			`printf '%s\\n' ${JSON.stringify(fullStdout)}`,
			`printf '%s' ${JSON.stringify(expectedStderr)} >&2`,
			termination === "nonzero" ? "exit 23" : `kill -TERM "$$"`,
		].join("\n"));
		symlinkSync(producer, join(release, "scripts", "ladder.sh"));
		const releaseAlias = join(base, "release-alias");
		symlinkSync(release, releaseAlias, "dir");
		const runner = `
			import { runIsolatedShell } from ${JSON.stringify(join(REPO_ROOT, "src/runtime.ts"))};
			const result = await runIsolatedShell("scripts/ladder.sh", ${JSON.stringify(producerArgs)}, ${JSON.stringify(releaseAlias)}, ${JSON.stringify(executable)});
			process.stdout.write(JSON.stringify(result));
		`;
		const child = Bun.spawn([process.execPath, "--eval", runner], {
			cwd: base, stdout: "pipe", stderr: "pipe",
			env: {
				PATH: [dirname(omp.launcher), dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
				HOME: join(base, "operator-home"), TMPDIR: join(base, "tmp"),
				OMP: omp.launcher, OMP_BIN: omp.launcher, OMP_PATH: omp.launcher, OMP_SRC: omp.source,
				...admission,
			},
		});
		const stdout = new Response(child.stdout).text();
		const stderr = new Response(child.stderr).text();
		// Watchdog only: real OS-process completion is event-driven; fake time cannot stop a hung child.
		let timer: NodeJS.Timeout | undefined;
		const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("runtime execution evidence deadline")), 6000); });
		try {
			const [code, output, diagnostic] = await Promise.race([Promise.all([child.exited, stdout, stderr]), deadline]);
			expect(code, diagnostic).toBe(0);
			const result = JSON.parse(output);
			const expectedStdout = [realpathSync(release), realpathSync(producer), ...producerArgs, fullStdout].join("\n") + "\n";
			expect(result.stdout).toBe(expectedStdout);
			expect(result.stderr).toBe(expectedStderr);
			if (termination === "nonzero") expect(result.code).toBe(23);
			else expect(result.code).not.toBe(0);
			expect(result.execution).toEqual({
				argv: ["/bin/sh", realpathSync(producer), ...producerArgs], cwd: realpathSync(release), launched: true,
				exit_code: termination === "nonzero" ? 23 : null, signal: termination === "nonzero" ? null : "SIGTERM",
				interrupted: false, stdout_complete: true, stderr_complete: true,
				stdout_capture: { bytes: Buffer.byteLength(expectedStdout), sha256: createHash("sha256").update(expectedStdout).digest("hex") },
				stderr_capture: { bytes: Buffer.byteLength(expectedStderr), sha256: createHash("sha256").update(expectedStderr).digest("hex") },
			});
		} finally {
			clearTimeout(timer);
			if (child.exitCode === null) child.kill("SIGKILL");
			await Promise.allSettled([child.exited, stdout, stderr]);
		}
	}, 12_000);
}

for (const interruption of ["stream-error", "SIGTERM", "leader-exit"] as const) {
	test(`isolated ${interruption} drains real stage evidence and stops its owned descendants before scratch cleanup`, async () => {
		const { base, admission } = ownedRuntimeFixture();
		const release = join(base, "release");
		const executable = join(release, "bin", "omp-kit");
		const omp = createOmp(join(base, "omp"), "v1");
		for (const directory of ["release/bin", "release/scripts", "operator-home", "tmp"]) mkdirSync(join(base, directory), { recursive: true });
		writeFileSync(executable, "#!/bin/sh\nexit 99\n", { mode: 0o755 });
		writeFileSync(join(release, "scripts", "ladder.sh"), [
			`trap 'if [ -d "$HOME" ]; then printf "scratch-present-during-stop\\n" >&2; else printf "scratch-missing-during-stop\\n" >&2; fi; exit 0' TERM`,
			`/bin/sh -c 'trap "" TERM; printf "%s\\n" "$$" > "$1/grandchild.pid"; while :; do /bin/sleep 1; done' descendant "$1" &`,
			`descendant=$!`,
			`printf '%s\\n' "$$" > "$1/child.pid"`,
			`printf '%s\\n' "$HOME" > "$1/private-home"`,
			`while [ ! -s "$1/grandchild.pid" ]; do /bin/sleep 0.01; done`,
			`printf 'OMP_KIT_STAGE_START name=e2e-live\\n'`,
			`printf 'current-stage-output\\n'`,
			`printf 'current-stage-diagnostic\\n' >&2`,
			interruption === "leader-exit" ? "exit 7" : `wait "$descendant"`,
		].join("\n"));
		// Fault only the reader, never the producer or its captured output.
		const runner = `
			import { Readable } from "node:stream";
			import { runIsolatedShell } from ${JSON.stringify(join(REPO_ROOT, "src/runtime.ts"))};
			import { recoverInterruptedRun, currentStageReport } from ${JSON.stringify(join(REPO_ROOT, "src/full-test-runner.ts"))};
			if (${JSON.stringify(interruption)} === "stream-error") {
				const fromWeb = Readable.fromWeb;
				Readable.fromWeb = (...args) => {
					Readable.fromWeb = fromWeb;
					const stream = fromWeb(...args);
					stream.on("data", chunk => {
						if (String(chunk).includes("current-stage-output")) queueMicrotask(() => stream.destroy(
							Object.assign(new Error("read failed at " + process.env.HOME + " Bearer synthetic-reader-credential"), { code: "STREAM_READ_FAILED" })
						));
					});
					return stream;
				};
			}
			try {
				const result = await runIsolatedShell("scripts/ladder.sh", [${JSON.stringify(base)}], ${JSON.stringify(release)}, ${JSON.stringify(executable)});
				process.stdout.write(JSON.stringify({ result, current_stage: currentStageReport(result.in_flight_stage ?? null) }));
				process.exitCode = result.code;
			} catch (error) {
				const recovered = recoverInterruptedRun(error, [${JSON.stringify(base)}]);
				process.stdout.write(JSON.stringify({ ...recovered, current_stage: currentStageReport(recovered.result.in_flight_stage ?? null) }));
				process.exitCode = 3;
			}
		`;
		const child = Bun.spawn([process.execPath, "--eval", runner], {
			cwd: base, detached: true, stdout: "pipe", stderr: "pipe",
			env: {
				PATH: [dirname(omp.launcher), dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
				HOME: join(base, "operator-home"), TMPDIR: join(base, "tmp"),
				OMP: omp.launcher, OMP_BIN: omp.launcher, OMP_PATH: omp.launcher, OMP_SRC: omp.source,
				...admission, OMP_KIT_NATIVE_STAGE_PROGRESS: "1",
			},
		});
		const { promise: ready, resolve: markReady } = Promise.withResolvers<void>();
		const stdout = new Response(child.stdout).text();
		let diagnostics = "";
		const stderr = (async () => {
			const reader = child.stderr.getReader(), decoder = new TextDecoder();
			for (;;) {
				const { done, value } = await reader.read();
				if (done) break;
				diagnostics += decoder.decode(value, { stream: true });
				if (diagnostics.includes("OMP_KIT_STAGE_START name=e2e-live")) markReady();
			}
			diagnostics += decoder.decode();
			return diagnostics;
		})();
		// A watchdog bounds a real OS-process test; readiness is signaled by actual stage output, not a sleep.
		let timer: NodeJS.Timeout | undefined;
		const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("owned runtime interruption deadline")), 6000); });
		try {
			if (interruption === "SIGTERM") {
				await Promise.race([ready, deadline, child.exited.then(() => { throw new Error("runner exited before stage readiness"); })]);
				child.kill("SIGTERM");
			}
			const [code, output, diagnostic] = await Promise.race([Promise.all([child.exited, stdout, stderr]), deadline]);
			expect(code, diagnostic).toBe(interruption === "leader-exit" ? 7 : 3);
			const report = JSON.parse(output);
			expect(report.result.execution).toMatchObject({
				argv: ["/bin/sh", realpathSync(join(release, "scripts", "ladder.sh")), base],
				cwd: realpathSync(release), launched: true,
				exit_code: interruption === "leader-exit" ? 7 : 0, signal: null,
				interrupted: interruption !== "leader-exit",
				stdout_complete: interruption !== "stream-error", stderr_complete: true,
			});
			expect(report.result.execution.stdout_capture).toEqual({
				bytes: Buffer.byteLength(report.result.stdout),
				sha256: createHash("sha256").update(report.result.stdout).digest("hex"),
			});
			expect(report.result.execution.stderr_capture).toEqual({
				bytes: Buffer.byteLength(report.result.stderr),
				sha256: createHash("sha256").update(report.result.stderr).digest("hex"),
			});
			if (interruption !== "leader-exit") {
				expect(report.cause.cause_code).toBe(interruption === "stream-error" ? "STREAM_READ_FAILED" : "SIGTERM");
				if (interruption === "stream-error") {
					expect(report.cause.cause_message).toContain("read failed at <private-path>/operator-home");
					expect(JSON.stringify(report.cause)).not.toContain("synthetic-reader-credential");
				}
			}
			expect(report.result.stdout).toContain("current-stage-output\n");
			expect(report.result.stderr).toContain("current-stage-diagnostic\n");
			if (interruption !== "leader-exit") {
				expect(report.result.stderr).toContain("scratch-present-during-stop\n");
				expect(report.result.stderr).not.toContain("scratch-missing-during-stop");
			}
			expect(report.current_stage.name).toBe("e2e-live");
			expect(report.current_stage.elapsed_ms).toBeGreaterThan(0);
			const privateHome = readFileSync(join(base, "private-home"), "utf8").trim();
			expect(existsSync(dirname(privateHome))).toBe(false);
			for (const file of ["child.pid", "grandchild.pid"]) {
				const pid = Number(readFileSync(join(base, file), "utf8").trim());
				const probe = Bun.spawnSync(["/bin/ps", "-o", "stat=", "-p", String(pid)], { stdout: "pipe", stderr: "pipe" });
				const state = probe.stdout.toString().trim();
				expect(state === "" || state.startsWith("Z"), `${file} remains live: ${state}`).toBe(true);
			}
		} finally {
			clearTimeout(timer);
			if (child.exitCode === null) child.kill("SIGKILL");
			const pidPath = join(base, "child.pid");
			if (existsSync(pidPath)) {
				const pid = Number(readFileSync(pidPath, "utf8").trim());
				if (Number.isSafeInteger(pid) && pid > 1) {
					try { process.kill(-pid, "SIGKILL"); } catch { /* Only this fixture's owned process group. */ }
				}
			}
			await Promise.allSettled([child.exited, stdout, stderr]);
		}
	}, 12_000);
}

test("isolated child exit unconfirmed keeps the runner note out of the child stderr bytes and their identity", async () => {
	const { base, admission } = ownedRuntimeFixture();
	const release = join(base, "release");
	const executable = join(release, "bin", "omp-kit");
	const omp = createOmp(join(base, "omp"), "v1");
	for (const directory of ["release/bin", "release/scripts", "operator-home", "tmp"]) mkdirSync(join(base, directory), { recursive: true });
	writeFileSync(executable, "#!/bin/sh\nexit 99\n", { mode: 0o755 });
	writeFileSync(join(release, "scripts", "ladder.sh"), [
		`printf '%s\\n' "$$" > "$1/child.pid"`,
		`printf '%s\\n' "$HOME" > "$1/private-home"`,
		`printf 'OMP_KIT_STAGE_START name=e2e-live\\n'`,
		`printf 'current-stage-diagnostic\\n' >&2`,
		`/bin/sleep 600 &`,
		`wait "$!"`,
	].join("\n"));
	const childStderr = "current-stage-diagnostic\n";
	// Withhold only the exit observation: the real child, its process group and both pipes stay untouched.
	const runner = `
		import { runIsolatedShell } from ${JSON.stringify(join(REPO_ROOT, "src/runtime.ts"))};
		import { describeFullTestProducer, recoverInterruptedRun } from ${JSON.stringify(join(REPO_ROOT, "src/full-test-runner.ts"))};
		const spawn = Bun.spawn;
		Bun.spawn = (...args) => {
			Bun.spawn = spawn;
			const child = spawn(...args);
			return new Proxy(child, {
				get(target, key) {
					if (key === "exited") return Promise.withResolvers().promise;
					const value = Reflect.get(target, key, target);
					return typeof value === "function" ? value.bind(target) : value;
				},
			});
		};
		try {
			await runIsolatedShell("scripts/ladder.sh", [${JSON.stringify(base)}], ${JSON.stringify(release)}, ${JSON.stringify(executable)});
			process.exitCode = 99;
		} catch (error) {
			const recovered = recoverInterruptedRun(error, [${JSON.stringify(base)}]);
			const producer = describeFullTestProducer(recovered.result, { source_revision: null, roots: [${JSON.stringify(base)}] });
			process.stdout.write(JSON.stringify({ ...recovered, result_ref: producer.result_ref }));
			process.exitCode = 3;
		}
	`;
	const child = Bun.spawn([process.execPath, "--eval", runner], {
		cwd: base, detached: true, stdout: "pipe", stderr: "pipe",
		env: {
			PATH: [dirname(omp.launcher), dirname(process.execPath), "/usr/bin", "/bin"].join(delimiter),
			HOME: join(base, "operator-home"), TMPDIR: join(base, "tmp"),
			OMP: omp.launcher, OMP_BIN: omp.launcher, OMP_PATH: omp.launcher, OMP_SRC: omp.source,
			...admission, OMP_KIT_NATIVE_STAGE_PROGRESS: "1",
		},
	});
	const { promise: ready, resolve: markReady } = Promise.withResolvers<void>();
	const stdout = new Response(child.stdout).text();
	let diagnostics = "";
	const stderr = (async () => {
		const reader = child.stderr.getReader(), decoder = new TextDecoder();
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			diagnostics += decoder.decode(value, { stream: true });
			if (diagnostics.includes("OMP_KIT_STAGE_START name=e2e-live")) markReady();
		}
		diagnostics += decoder.decode();
		return diagnostics;
	})();
	// A watchdog bounds a real OS-process test; readiness is signaled by actual stage output, not a sleep.
	let timer: NodeJS.Timeout | undefined;
	const deadline = new Promise<never>((_, reject) => { timer = setTimeout(() => reject(new Error("owned runtime exit-unconfirmed deadline")), 8000); });
	let privateRoot: string | undefined;
	try {
		await Promise.race([ready, deadline, child.exited.then(() => { throw new Error("runner exited before stage readiness"); })]);
		child.kill("SIGTERM");
		const [code, output, diagnostic] = await Promise.race([Promise.all([child.exited, stdout, stderr]), deadline]);
		expect(code, diagnostic).toBe(3);
		const report = JSON.parse(output);
		privateRoot = dirname(readFileSync(join(base, "private-home"), "utf8").trim());
		expect(report.cause.cause_code).toBe("SIGTERM");
		// The supervisor note is reported beside, never inside, the child's pipe bytes and capture identity.
		expect(report.result.supervisor_note).toBe("Isolated child exit unconfirmed; private runtime scratch retained.");
		expect(report.result.stderr).toBe(childStderr);
		expect(report.result.execution).toMatchObject({ exit_code: null, signal: null, interrupted: true });
		expect(report.result.execution.stderr_capture).toEqual({
			bytes: Buffer.byteLength(childStderr),
			sha256: createHash("sha256").update(childStderr).digest("hex"),
		});
		expect(report.result_ref.stderr).toMatchObject({
			bytes: Buffer.byteLength(childStderr),
			sha256: createHash("sha256").update(childStderr).digest("hex"),
			identity_matches: true,
		});
		expect(report.result_ref.supervisor_note).toBe("Isolated child exit unconfirmed; private runtime scratch retained.");
		expect(report.result_ref.execution).toBe("INTERRUPTED");
		expect(report.result_ref.producer_exit).toBe(null);
		expect(report.result_ref.execution_capture_complete).toBe(false);
		expect(report.result_ref.missing_fields).toEqual(expect.arrayContaining(["producer_exit", "execution.interrupted"]));
		expect(report.result_ref.retention).toMatchObject({ status: "UNRETAINED", durable: false });
		expect(existsSync(privateRoot)).toBe(true);
	} finally {
		clearTimeout(timer);
		if (child.exitCode === null) child.kill("SIGKILL");
		const pidPath = join(base, "child.pid");
		if (existsSync(pidPath)) {
			const pid = Number(readFileSync(pidPath, "utf8").trim());
			if (Number.isSafeInteger(pid) && pid > 1) {
				try { process.kill(-pid, "SIGKILL"); } catch { /* Only this fixture's owned process group. */ }
			}
		}
		await Promise.allSettled([child.exited, stdout, stderr]);
		// The retained scratch is this test's own: its child group was killed above.
		if (privateRoot && relative(admission.OMP_KIT_TEST_WORK_ROOT, privateRoot).split("/")[0]?.startsWith("omp-kit-runtime.")) {
			rmSync(privateRoot, { recursive: true, force: true });
		}
	}
}, 12_000);

describe("release paths", () => {
	test("follows the stable launcher to the moved versioned release", () => {
		const prefix = join(fixtureRoot(), "kit");
		const versioned = join(prefix, "releases", "v4");
		mkdirSync(join(prefix, "bin"), { recursive: true });
		mkdirSync(join(versioned, "bin"), { recursive: true });
		writeFileSync(join(versioned, "bin", "omp-kit"), "compiled executable");
		chmodSync(join(versioned, "bin", "omp-kit"), 0o755);
		const stable = join(prefix, "bin", "omp-kit");
		symlinkSync(join(versioned, "bin", "omp-kit"), stable);

		expect(releaseRoot(stable)).toBe(realpathSync(versioned));
	});

	test("refuses dangling and prefix-escaping stable launcher symlinks", () => {
		const base = fixtureRoot();
		const prefix = join(base, "kit");
		mkdirSync(join(prefix, "bin"), { recursive: true });
		const dangling = join(prefix, "bin", "omp-kit");
		symlinkSync(join(prefix, "releases", "missing", "bin", "omp-kit"), dangling);
		expect(() => releaseRoot(dangling)).toThrow(/symlink|realpath|resolve/i);

		const outside = join(base, "outside", "omp-kit");
		mkdirSync(join(base, "outside"), { recursive: true });
		writeFileSync(outside, "compiled executable");
		chmodSync(outside, 0o755);
		const escaping = join(prefix, "bin", "escaping");
		symlinkSync(outside, escaping);
		expect(() => releaseRoot(escaping)).toThrow(/escap|outside|prefix/i);
	});

	test("accepts only a packaged harness script and rejects traversal", () => {
		const root = join(fixtureRoot(), "release");
		mkdirSync(join(root, "scripts"), { recursive: true });
		writeFileSync(join(root, "scripts", "ttsr-harness.ts"), "console.log('harness');\n");
		expect(resolveBundledScript("scripts/ttsr-harness.ts", root)).toBe(realpathSync(join(root, "scripts", "ttsr-harness.ts")));
		expect(() => resolveBundledScript("../../outside.ts", root)).toThrow(/allow|packag|path/i);
		expect(() => resolveBundledScript("scripts/unknown.ts", root)).toThrow(/allow|packag|path/i);
	});

	test("runs the packaged rule classifier and refuses the retired local-model checker", () => {
		const { base, admission } = ownedRuntimeFixture();
		const prefix = join(base, "kit");
		const versioned = join(prefix, "releases", "v1.2.3");
		const executable = join(versioned, "bin", "omp-kit");
		const stable = join(prefix, "bin", "omp-kit");
		const fakeOmp = createOmp(join(base, "fake-omp"), "v18.4.2");
		mkdirSync(join(versioned, "scripts"), { recursive: true });
		mkdirSync(join(versioned, "bin"), { recursive: true });
		const ruleClass = join(REPO_ROOT, "scripts", "rule-class.ts");
		writeFileSync(join(versioned, "scripts", "rule-class.ts"), readFileSync(ruleClass));
		mkdirSync(join(versioned, "rules"), { recursive: true });
		const ruleFile = join(versioned, "rules", "zz-canary-scope-probe.md");
		writeFileSync(ruleFile, "---\ninterruptMode: never\n---\nfixture\n");
		writeFileSync(join(versioned, "scripts", "role-check.ts"), "console.log('REMOVED_ROLE_CHECK_EXECUTED');\n");
		writeFileSync(join(versioned, "scripts", "not-allowlisted.ts"), "console.log('UNALLOWLISTED_RESOURCE_EXECUTED');\n");
		mkdirSync(join(prefix, "bin"), { recursive: true });

		const buildRoot = join(base, "build-environment");
		const buildEnv = {
			HOME: join(buildRoot, "home"), TMPDIR: join(buildRoot, "tmp"),
			XDG_CONFIG_HOME: join(buildRoot, "xdg-config"), XDG_CACHE_HOME: join(buildRoot, "xdg-cache"),
			XDG_DATA_HOME: join(buildRoot, "xdg-data"), XDG_STATE_HOME: join(buildRoot, "xdg-state"),
			BUN_INSTALL: join(buildRoot, "bun-install"), PATH: process.env.PATH ?? "/usr/bin:/bin",
		};
		for (const key of ["HOME", "TMPDIR", "XDG_CONFIG_HOME", "XDG_CACHE_HOME", "XDG_DATA_HOME", "XDG_STATE_HOME", "BUN_INSTALL"] as const) {
			mkdirSync(buildEnv[key], { recursive: true });
		}
		const compile = Bun.spawnSync([
			process.execPath, "build", join(REPO_ROOT, "tests", "cli", "runtime-release-runner.ts"),
			"--compile", "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig", "--no-compile-autoload-tsconfig",
			`--outfile=${executable}`,
		], { cwd: REPO_ROOT, env: { ...buildEnv, TMP: buildEnv.TMPDIR, TEMP: buildEnv.TMPDIR }, stdout: "pipe", stderr: "pipe" });
		expect(compile.exitCode, `${compile.stdout.toString()}\n${compile.stderr.toString()}`).toBe(0);
		chmodSync(executable, 0o755);
		symlinkSync(executable, stable);

		const canaries = join(base, "operator-canaries");
		mkdirSync(canaries, { recursive: true });
		const hostile: Record<string, string> = {};
		for (const [key, name] of [
			["HOME", "home"],
			["XDG_CONFIG_HOME", "xdg-config"],
			["XDG_CACHE_HOME", "xdg-cache"],
			["XDG_DATA_HOME", "xdg-data"],
			["XDG_STATE_HOME", "xdg-state"],
			["BUN_INSTALL", "bun-install"],
		] as const) {
			const directory = join(canaries, name);
			mkdirSync(directory, { recursive: true });
			writeFileSync(join(directory, "operator-marker"), `${key}:unchanged\n`);
			hostile[key] = directory;
		}
		const hostileTmp = join(canaries, "TMPDIR-marker");
		writeFileSync(hostileTmp, "TMPDIR:regular-file\n");
		const env = {
			...hostile, PATH: [dirname(fakeOmp.launcher), "/usr/bin", "/bin"].join(delimiter),
			TMPDIR: hostileTmp, TMP: hostileTmp, TEMP: hostileTmp,
			OMP: fakeOmp.launcher, OMP_BIN: fakeOmp.launcher, OMP_PATH: fakeOmp.launcher, OMP_SRC: fakeOmp.source,
			...admission,
		};
		const releaseBefore = snapshotTree(prefix);
		const canariesBefore = snapshotTree(canaries);
		const run = (resource: string) => Bun.spawnSync([stable], {
			cwd: base,
			env: {
				...env,
				OMP_KIT_FIXTURE_ROOT: versioned,
				OMP_KIT_FIXTURE_EXECUTABLE: stable,
				OMP_KIT_FIXTURE_SCRIPT: resource,
				OMP_KIT_FIXTURE_ARGS: JSON.stringify(resource === "scripts/rule-class.ts" ? [ruleFile] : []),
			},
			stdout: "pipe", stderr: "pipe",
		});

		const allowed = run("scripts/rule-class.ts");
		expect(allowed.exitCode, allowed.stderr.toString()).toBe(0);
		expect(allowed.stdout.toString()).toBe("zz-canary-scope-probe\tcanary\n");

		const retired = run("scripts/role-check.ts");
		expect(retired.exitCode).not.toBe(0);
		expect(retired.stdout.toString()).not.toContain("REMOVED_ROLE_CHECK_EXECUTED");
		expect(retired.stderr.toString()).toContain("not an allowlisted packaged path");

		const rejected = run("scripts/not-allowlisted.ts");
		expect(rejected.exitCode).not.toBe(0);
		expect(rejected.stdout.toString()).not.toContain("UNALLOWLISTED_RESOURCE_EXECUTED");
		expect(rejected.stderr.toString()).toContain("not an allowlisted packaged path");
		expect(snapshotTree(prefix)).toBe(releaseBefore);
		expect(snapshotTree(canaries)).toBe(canariesBefore);
	});
});

test("terminating the packaged adapter closes its mock server and output streams", async () => {
	const readinessDeadline = performance.now() + 15_000;
	const { base, admission } = ownedRuntimeFixture();
	const release = join(base, "release");
	const workspace = join(base, "work");
	for (const directory of ["home", "tmp", "xdg-config", "xdg-cache", "xdg-data", "xdg-state", "bun-install", "work", "release/bin", "release/scripts", "release/tests/live"]) {
		mkdirSync(join(base, directory), { recursive: true, mode: 0o700 });
	}
	const executable = join(release, "bin", "omp-kit");
	const built = Bun.spawnSync([process.execPath, "build", join(REPO_ROOT, "tests/cli/runtime-release-runner.ts"),
		"--compile", "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig", "--no-compile-autoload-tsconfig",
		"--outfile=" + executable], { cwd: base, stdout: "pipe", stderr: "pipe",
		env: { HOME: join(base, "home"), TMPDIR: join(base, "tmp"), BUN_INSTALL: join(base, "bun-install"),
			XDG_CONFIG_HOME: join(base, "xdg-config"), XDG_CACHE_HOME: join(base, "xdg-cache"),
			XDG_DATA_HOME: join(base, "xdg-data"), XDG_STATE_HOME: join(base, "xdg-state"),
			PATH: process.env.PATH ?? "/usr/bin:/bin" },
	});
	expect(built.exitCode, built.stderr.toString()).toBe(0);
	const adapter = join(release, "scripts/runtime-adapter.sh");
	writeFileSync(adapter, readFileSync(join(REPO_ROOT, "scripts/runtime-adapter.sh")), { mode: 0o755 });
	const mock = join(release, "tests/live/mock-model.mjs");
	writeFileSync(mock, readFileSync(join(REPO_ROOT, "tests/live/mock-model.mjs")));
	const scenario = join(workspace, "scenario.json"), portFile = join(workspace, "port");
	writeFileSync(scenario, JSON.stringify({ turns: [{ text: "Done." }] }));
	const omp = resolveOmpIdentity();
	const env = {
		PATH: "/usr/bin:/bin:/usr/sbin:/sbin", HOME: join(base, "home"), TMPDIR: join(base, "tmp"),
		XDG_CONFIG_HOME: join(base, "xdg-config"), XDG_CACHE_HOME: join(base, "xdg-cache"),
		XDG_DATA_HOME: join(base, "xdg-data"), XDG_STATE_HOME: join(base, "xdg-state"),
		BUN_INSTALL: join(base, "bun-install"), OMP: omp.launcher, OMP_BIN: omp.launcher,
		OMP_PATH: omp.launcher, OMP_SRC: omp.source,
		...admission,
	};
	const server = Bun.spawn([adapter, "--work-dir", workspace, "--scenario", scenario,
		"--log", join(workspace, "requests.jsonl"), "--port-file", portFile, mock], {
		cwd: release, env, stdout: "pipe", stderr: "pipe", stdin: "ignore",
	});
	const stdout = new Response(server.stdout).text(), stderr = new Response(server.stderr).text();
	let descendants: number[] = [];
	try {
		// FSEvents can miss nested-file creation: poll the authoritative file,
		// as in service-run's bounded condition waits, never a sleep-as-proof.
		while (!existsSync(portFile) || !readFileSync(portFile, "utf8").trim()) {
			if (performance.now() >= readinessDeadline) throw new Error("mock PORTFILE readiness exceeded the existing whole-test deadline");
			await Promise.race([
				Bun.sleep(10),
				server.exited.then(code => { throw new Error("mock exited before PORTFILE readiness: " + code); }),
			]);
		}
		const url = "http://127.0.0.1:" + readFileSync(portFile, "utf8").trim() + "/v1/chat/completions";
		const request = { method: "POST", body: JSON.stringify({ messages: [], stream: true }) };
		const ready = await fetch(url, request);
		expect(ready.status).toBe(200);
		expect(await ready.text()).toContain("[DONE]");
		const processes = Bun.spawnSync(["/bin/ps", "-axo", "pid=,ppid="], { stdout: "pipe", stderr: "pipe" });
		expect(processes.exitCode, processes.stderr.toString()).toBe(0);
		descendants = processes.stdout.toString().trim().split("\n").map(row => row.trim().split(/\s+/).map(Number))
			.filter(([, parent]) => parent === server.pid).map(([pid]) => pid!);
		server.kill("SIGTERM");
		await server.exited;
		let stillListening = false;
		try {
			const response = await fetch(url, request);
			stillListening = true;
			await response.text();
		} catch { /* Connection refusal is the required shutdown effect. */ }
		expect(stillListening).toBe(false);
	} finally {
		if (server.exitCode === null) server.kill("SIGTERM");
		for (const pid of descendants) { try { process.kill(pid, "SIGTERM"); } catch {} }
		await server.exited;
		await Promise.all([stdout, stderr]);
	}
}, 15_000);

describe("OMP installation identity", () => {
	test("resolves launcher, source and native package from the same PATH install", () => {
		const first = createOmp(join(fixtureRoot(), "omp-one"), "v1");
		const resolved = resolveOmpIdentity({ PATH: dirname(first.launcher) });
		const packageRoot = realpathSync(join(first.source, ".."));

		expect(resolved.launcher).toBe(realpathSync(first.launcher));
		expect(resolved.source).toBe(realpathSync(first.source));
		expect(resolved.packageRoot).toBe(packageRoot);
		expect(resolved.nativeRoot).toBe(realpathSync(join(packageRoot, "node_modules", "@oh-my-pi", "pi-natives")));
	});

	test("refuses conflicting launcher and source overrides instead of mixing installs", () => {
		const root = fixtureRoot();
		const first = createOmp(join(root, "omp-one"), "v1");
		const second = createOmp(join(root, "omp-two"), "v2");
		const pathEnv = { PATH: dirname(first.launcher) };

		for (const key of ["OMP_BIN", "OMP", "OMP_PATH"] as const) {
			expect(() => resolveOmpIdentity({ ...pathEnv, [key]: second.launcher })).toThrow(/conflict|different|identity/i);
		}
		expect(() => resolveOmpIdentity({ ...pathEnv, OMP_SRC: second.source })).toThrow(/conflict|different|identity/i);
		expect(() => resolveOmpIdentity({ PATH: `${dirname(second.launcher)}:${dirname(first.launcher)}`, OMP_BIN: first.launcher })).toThrow(/conflict|different|identity/i);
	});

	test("rejects an OMP package without matcher source even when its launcher exists", () => {
		const root = fixtureRoot();
		const packageRoot = join(root, "release");
		const launcher = join(root, "bin", "omp");
		mkdirSync(join(packageRoot, "dist"), { recursive: true });
		mkdirSync(join(root, "bin"), { recursive: true });
		writeFileSync(join(packageRoot, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-coding-agent" }));
		writeFileSync(join(packageRoot, "dist", "cli.js"), "#!/bin/sh\nexit 0\n");
		chmodSync(join(packageRoot, "dist", "cli.js"), 0o755);
		symlinkSync(join(packageRoot, "dist", "cli.js"), launcher);

		expect(() => resolveOmpIdentity({ PATH: dirname(launcher) })).toThrow(/source|matcher/i);
	});

	describe("a compiled standalone launcher outside any package", () => {
		function compiledOmp(root: string, version: string): string {
			const bin = join(root, "compiled-bin");
			mkdirSync(bin, { recursive: true });
			writeFileSync(join(bin, "omp"), `#!/bin/sh\necho omp/${version}\n`);
			chmodSync(join(bin, "omp"), 0o755);
			return join(bin, "omp");
		}
		function versionedOmp(prefix: string, version: string): { launcher: string; source: string } {
			const install = createOmp(prefix, "v" + version);
			writeFileSync(join(install.source, "..", "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", version }));
			return install;
		}
		for (const explicitCache of [false, true]) {
			test(`isolated opaque OMP retains its ${explicitCache ? "explicit" : "default"} source cache across HOME changes`, () => {
				const root = fixtureRoot(), version = "18.4.2";
				const launcher = compiledOmp(root, version);
				const original = versionedOmp(join(root, "original"), version);
				const other = versionedOmp(join(root, "other"), version);
				const callerHome = join(root, "caller-home"), privateRoot = join(root, "private");
				const cache = explicitCache ? join(root, "explicit-cache")
					: join(callerHome, ".local", "opt", "omp-kit", "omp-src");
				const seedCache = (cacheRoot: string, source: string) => {
					const versionRoot = join(cacheRoot, version);
					const pkg = join(versionRoot, "node_modules", "@oh-my-pi", "pi-coding-agent");
					mkdirSync(dirname(pkg), { recursive: true });
					symlinkSync(dirname(source), pkg);
					// The cache serves a version only with its OTel runtime entry (hasRequiredOmpSourceFiles, 78af6e905e).
					const otel = join(versionRoot, "node_modules", "@opentelemetry", "api", "dist");
					mkdirSync(otel, { recursive: true });
					writeFileSync(join(otel, "index.mjs"), "export const context = {};\n");
					const integrity = "sha512-R7BaZ9wxsrQhxfYxt8bXczwmfDctUPklqSLAeDulbl716WxnVCSBe6MYIscyJ+oRq7bqsq+s+tDNEf1HWG/R6A==";
					writeFileSync(join(versionRoot, "bun.lock"), JSON.stringify({ packages: {
						"@oh-my-pi/pi-coding-agent": [`@oh-my-pi/pi-coding-agent@${version}`, "", {}, integrity],
					} }) + "\n");
					writeFileSync(join(versionRoot, ".verified.json"), JSON.stringify({
						package: "@oh-my-pi/pi-coding-agent", version, integrity,
					}) + "\n");
				};
				seedCache(cache, original.source);
				seedCache(join(privateRoot, "home", ".local", "opt", "omp-kit", "omp-src"), other.source);
				const inherited = {
					PATH: `${dirname(launcher)}:/usr/bin:/bin`, HOME: callerHome,
					BUN_INSTALL: join(root, "empty-global"), OMP_KIT_OMP_SRC_FETCH: "0",
					...(explicitCache ? { OMP_KIT_OMP_SRC_CACHE: cache } : {}),
				};
				const identity = resolveOmpIdentity(inherited);
				const isolated = { ...sanitizedEnv(identity, inherited, privateRoot), OMP_KIT_OMP_SRC_FETCH: "0" };
				expect(resolveOmpIdentity(isolated)).toEqual(identity);
				expect(() => resolveOmpIdentity({ ...isolated, OMP_SRC: other.source }))
					.toThrow("OMP_SRC conflicts with the PATH-selected OMP source");
			});
		}

		test("takes the same version's package from a later omp on PATH and keeps the compiled launcher", () => {
			const root = fixtureRoot();
			const compiled = compiledOmp(root, "9.9.1");
			const pkg = versionedOmp(join(root, "omp-pkg"), "9.9.1");
			const resolved = resolveOmpIdentity({ PATH: `${dirname(compiled)}:${dirname(pkg.launcher)}`, BUN_INSTALL: join(root, "no-bun") });

			expect(resolved.launcher).toBe(realpathSync(compiled));
			expect(resolved.source).toBe(realpathSync(pkg.source));
			expect(resolveOmpIdentity({ PATH: `${dirname(compiled)}:${dirname(pkg.launcher)}`, BUN_INSTALL: join(root, "no-bun"), OMP_BIN: compiled }).launcher)
				.toBe(realpathSync(compiled));
		});

		test("falls back to bun's global install of the same version", () => {
			const root = fixtureRoot();
			const compiled = compiledOmp(root, "9.9.1");
			const pkg = versionedOmp(join(root, "omp-pkg"), "9.9.1");
			const bunGlobal = join(root, "bun", "install", "global", "node_modules", "@oh-my-pi");
			mkdirSync(bunGlobal, { recursive: true });
			symlinkSync(realpathSync(join(pkg.source, "..")), join(bunGlobal, "pi-coding-agent"));

			expect(resolveOmpIdentity({ PATH: dirname(compiled), BUN_INSTALL: join(root, "bun") }).source).toBe(realpathSync(pkg.source));
		});

		test("refuses a package of another version, even when OMP_SRC names it", () => {
			const root = fixtureRoot();
			const compiled = compiledOmp(root, "9.9.1");
			const other = versionedOmp(join(root, "omp-other"), "9.9.0");
			const env = { PATH: `${dirname(compiled)}:${dirname(other.launcher)}`, BUN_INSTALL: join(root, "no-bun") };

			expect(() => resolveOmpIdentity(env)).toThrow("cannot locate @oh-my-pi/pi-coding-agent 9.9.1 for OMP launcher");
			expect(() => resolveOmpIdentity({ ...env, OMP_SRC: other.source })).toThrow("cannot locate @oh-my-pi/pi-coding-agent 9.9.1");
		});
	});
});

test("caller-owned scratch root stays in its workspace and rejects missing or foreign ownership", () => {
	const base = fixtureRoot();
	const workspace = join(base, "caller");
	const owned = join(workspace, "var", "agent-tmp", "live.123");
	mkdirSync(owned, { recursive: true });
	const keys = ["OMP_KIT_CASE_CWD", "OMP_KIT_TEST_WORK_ROOT"] as const;
	const before = keys.map(key => process.env[key]);
	process.env.OMP_KIT_CASE_CWD = workspace;
	process.env.OMP_KIT_TEST_WORK_ROOT = owned;
	try {
		expect(() => runtimeTempRoot()).toThrow("caller-owned scratch");
		writeFileSync(join(owned, ".owner"), `pid=${process.pid}\nlabel=live\nrepo=${workspace}\ncreated=2026-10-13T00:00:00Z\n`);
		expect(runtimeTempRoot()).toBe(realpathSync(owned));
		const foreign = join(base, "other", "var", "agent-tmp", "live.123");
		mkdirSync(foreign, { recursive: true });
		writeFileSync(join(foreign, ".owner"), `pid=${process.pid}\nlabel=live\nrepo=${join(base, "other")}\ncreated=2026-10-13T00:00:00Z\n`);
		process.env.OMP_KIT_TEST_WORK_ROOT = foreign;
		expect(() => runtimeTempRoot()).toThrow("caller-owned scratch");
	} finally {
		keys.forEach((key, index) => { if (before[index] === undefined) delete process.env[key]; else process.env[key] = before[index]; });
	}
});

function systemTempRoot(): string {
	if (process.platform === "darwin") {
		const result = Bun.spawnSync(["/usr/bin/getconf", "DARWIN_USER_TEMP_DIR"]);
		if (result.exitCode !== 0) throw new Error("cannot locate macOS private temp root");
		return realpathSync(result.stdout.toString().trim());
	}
	return realpathSync("/tmp");
}

describe("runtime temporary roots without caller admission", () => {
	let previousRoot: string | undefined;
	let previousCaller: string | undefined;
	beforeEach(() => {
		previousRoot = process.env.OMP_KIT_TEST_WORK_ROOT;
		previousCaller = process.env.OMP_KIT_CASE_CWD;
		delete process.env.OMP_KIT_TEST_WORK_ROOT;
		delete process.env.OMP_KIT_CASE_CWD;
	});
	afterEach(() => {
		if (previousRoot === undefined) delete process.env.OMP_KIT_TEST_WORK_ROOT;
		else process.env.OMP_KIT_TEST_WORK_ROOT = previousRoot;
		if (previousCaller === undefined) delete process.env.OMP_KIT_CASE_CWD;
		else process.env.OMP_KIT_CASE_CWD = previousCaller;
	});

test("runtime temp root rejects TMPDIR outside system temporary roots", () => {
	const base = fixtureRoot();
	const outsideSystemTemp = REPO_ROOT;
	const home = join(base, "home");
	mkdirSync(home);
	const previousHome = process.env.HOME;
	const previousTmpdir = process.env.TMPDIR;
	process.env.HOME = home;
	process.env.TMPDIR = outsideSystemTemp;
	try {
		expect(runtimeTempRoot()).toBe(systemTempRoot());
	} finally {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousTmpdir === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = previousTmpdir;
	}
});

test("runtime temp root accepts the operating-system temporary root", () => {
	const previousHome = process.env.HOME;
	const previousTmpdir = process.env.TMPDIR;
	process.env.HOME = process.cwd();
	process.env.TMPDIR = systemTempRoot();
	try {
		expect(runtimeTempRoot()).toBe(systemTempRoot());
	} finally {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousTmpdir === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = previousTmpdir;
	}
});

test("runtime temp root falls back when TMPDIR is not a directory", () => {
	const base = fixtureRoot();
	const marker = join(base, "TMPDIR-marker");
	writeFileSync(marker, "not a directory\n");
	const previous = process.env.TMPDIR;
	process.env.TMPDIR = marker;
	try {
		const root = runtimeTempRoot();
		expect(root).not.toBe(realpathSync(marker));
		expect(realpathSync(root)).toBe(root);
		expect(lstatSync(root).isDirectory()).toBe(true);
	} finally {
		if (previous === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = previous;
	}
});

test("runtime temp root avoids caller HOME when TMPDIR is nested there", () => {
	const base = fixtureRoot();
	const home = join(base, "home");
	const nested = join(home, "tmp");
	mkdirSync(nested, { recursive: true });
	const previousHome = process.env.HOME;
	const previousTmpdir = process.env.TMPDIR;
	process.env.HOME = home;
	process.env.TMPDIR = nested;
	try {
		const root = runtimeTempRoot();
		expect(root).not.toBe(realpathSync(nested));
		expect(realpathSync(root)).toBe(root);
		expect(lstatSync(root).isDirectory()).toBe(true);
	} finally {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		if (previousTmpdir === undefined) delete process.env.TMPDIR;
		else process.env.TMPDIR = previousTmpdir;
	}
});
});

test("isolated children inherit the CI judge signal through runIsolatedShell", () => {
	// RELEASE BLOCKER A3: the nested ladder keys --judge-regardless-of-load on
	// GITHUB_ACTIONS; sanitizedEnv must carry it or macOS certification refuses
	// with producer_rc=75. Non-allowlisted keys stay scrubbed either way.
	const identity = { launcher: "/bin/omp", packageRoot: "/pkg", source: "/src", nativeRoot: "/native" };
	const withSignal = sanitizedEnv(identity, { CI: "true", GITHUB_ACTIONS: "true", PATH: "/usr/bin:/bin", SECRET: "x" }, "/private");
	expect(withSignal.GITHUB_ACTIONS).toBe("true");
	expect(withSignal.CI).toBe("true");
	expect("SECRET" in withSignal).toBe(false);
	const withoutSignal = sanitizedEnv(identity, { CI: "true", PATH: "/usr/bin:/bin" }, "/private");
	expect("GITHUB_ACTIONS" in withoutSignal).toBe(false);
	expect(withoutSignal.CI).toBe("true");
});

describe("REPLAYBR1 AC3 native guard (ompkit-t7cn7.21)", () => {
	test("exact source and official br binary reach the shim guard on owned fixtures; digests recorded; one smoke via verifyBead", async () => {
		const utf8 = (b: Uint8Array) => new TextDecoder().decode(b);
		const sha256hex = (b: Uint8Array | string) => createHash("sha256").update(typeof b === "string" ? b : Buffer.from(b)).digest("hex");

		const g = process.env.GRADE_WAVE_SCRATCH || undefined;
		const root = ownedTmp("replaybr3", { bead: "ompkit-t7cn7.21", ...(g === undefined ? {} : { root: g }) }).path;
		const cdir = join(root, "code");
		mkdirSync(join(cdir, "scripts"), { recursive: true });
		writeFileSync(join(cdir, "scripts", "t.sh"), "#!/bin/sh\necho ' 16 pass'\necho ' 0 fail'\n");
		const git = async (args: string[]) => {
			const r = await run(["git", ...args], { cwd: cdir, deadline_s: 60 });
			if (r.rc !== 0) throw new Error(`git ${args.join(" ")} -> ${r.rc}: ${utf8(r.stderr)}`);
		};
		await git(["init", "-q"]);
		await git(["-c", "user.name=t", "-c", "user.email=t@x", "add", "-A"]);
		await git(["-c", "user.name=t", "-c", "user.email=t@x", "commit", "-q", "-m", "fixture [test]"]);
		const rev = await run(["git", "rev-parse", "HEAD"], { cwd: cdir, deadline_s: 60 });
		const sha = utf8(rev.stdout).trim();
		const brBin = resolveRealBr(process.env.PATH);
		if (brBin === null) throw new Error("no resolvable br on PATH; unmet prerequisite: real br binary");
		const stripped = { ...process.env } as Record<string, string>;
		delete stripped.BEADS_DB;
		const tdir = join(root, "t");
		mkdirSync(tdir, { recursive: true });
		const tinit = await run(["br", "init"], { cwd: tdir, deadline_s: 60, env: stripped });
		if (tinit.rc !== 0) throw new Error(`tracker init -> ${tinit.rc}: ${utf8(tinit.stderr)}`);
		const tdb = join(tdir, ".beads", "beads.db");
		const envT = { ...process.env, BEADS_DB: tdb } as Record<string, string>;
		const brOut = async (args: string[], cwd: string, env?: Record<string, string>) => {
			const r = await run(["br", ...args], { cwd, deadline_s: 60, env: env ?? envT });
			return { rc: r.rc, out: utf8(r.stdout) + utf8(r.stderr) };
		};
		const created = await brOut(["create", "native guard probe", "--json"], tdir);
		if (created.rc !== 0) throw new Error(`create -> ${created.rc}: ${created.out}`);
		const raw: unknown = JSON.parse(created.out);
		const id = typeof raw === "object" && raw !== null && "id" in raw && typeof raw.id === "string" ? raw.id : null;
		if (id === null) throw new Error(`create returned no id: ${created.out.slice(0, 200)}`);
		const ac = `- [ ] [a] [build] \`sh scripts/t.sh\` -> 16 pass 0 fail\n- [ ] [b] [build] admitted owned write: \`br --db "\${OWNED_TRACKER_DB:-${tdb}}" create "owned probe"\` -> Created\n- [ ] [c] [build] differential guard box: \`br --db "${tdb}" update ${id} --add-label guard-probe\` -> READONLY_TRACKER`;
		const desc = "WHAT: owned native-guard fixture.\n\nWHY: proves the exact source and the official compiled verifier reach the shim guard on owned fixtures; the old guardless binary is the refused differential.";
		const checks: Array<[string[], string]> = [
			[["update", id, "--description", desc, "--acceptance", ac, "--add-label", "kind:fix"], "shape"],
			[["update", id, "--check-acceptance", "1"], "tick 1"],
			[["update", id, "--check-acceptance", "2"], "tick 2"],
			[["update", id, "--check-acceptance", "3"], "tick 3"],
			[["update", id, "--status", "in_review", "--transition-comment", "fixture ready", "--actor", "tester"], "in_review"],
		];
		for (const [args, what] of checks) {
			const r = await brOut(args, tdir);
			if (r.rc !== 0) throw new Error(`${what} -> ${r.rc}: ${r.out}`);
		}
		const shimBin = installReadonlyBr(join(root, "guard"), brBin);
		const shim = join(shimBin, "br");
		const odir = join(root, "guard", "owned");
		mkdirSync(odir, { recursive: true });
		const oinit = await run(["br", "init"], { cwd: odir, deadline_s: 60, env: stripped });
		if (oinit.rc !== 0) throw new Error(`owned init -> ${oinit.rc}: ${utf8(oinit.stderr)}`);
		const odb = join(odir, ".beads", "beads.db");
		const before = readFileSync(join(tdir, ".beads", "issues.jsonl"), "utf8");
		const shimRun = async (args: string[], env?: Record<string, string>) => {
			const r = await run(["sh", shim, ...args], { cwd: cdir, deadline_s: 60, env: env ?? { ...process.env, BEADS_DB: tdb } as Record<string, string> });
			return { rc: r.rc, out: utf8(r.stdout) + utf8(r.stderr) };
		};
		const allowed = await shimRun(["--db", odb, "create", "native probe"]);
		expect(allowed.rc).toBe(0);
		expect(allowed.out).toContain("Created");
		const denied = await shimRun(["--db", tdb, "update", id, "--add-label", "nope"]);
		expect(denied.rc).toBe(77);
		expect(denied.out).toContain("READONLY_TRACKER");
		const strippedDeny = await shimRun(["update", id, "--add-label", "nope"], { ...process.env, BEADS_DB: "" } as Record<string, string>);
		expect(strippedDeny.rc).toBe(77);
		expect(strippedDeny.out).toContain("READONLY_TRACKER");
		expect(readFileSync(join(tdir, ".beads", "issues.jsonl"), "utf8")).toBe(before);
		// Official exact-source HOST candidate: build the unmodified official recipe
		// from the exact source tree (never the dirty shared tree), then smoke it.
		// The previous PATH-binary comparator is not this proof (old guardless release).
		// Identity via the shared helper (scripts/exact-source.ts): a tree with
		// its own .git keeps plain Git behavior (top-level guard, archive HEAD);
		// a history-free archive resolves its stamped source_revision and builds
		// from that tree. Anything else is an unmet prerequisite, never a
		// silent pass. Fresh gates run this file from a git archive with no
		// .git, where rev-parse HEAD cannot pass.
		const identity = identifyExactSource(REPO_ROOT, readFileSync(join(REPO_ROOT, "package.json")));
		if (identity === null) throw new Error("no exact source identity; unmet prerequisite: clean checkout or stamped archive export");
		let revision: string;
		let srcExport: string;
		if (identity.kind === "git") {
			const headRev = await run(["git", "-C", REPO_ROOT, "rev-parse", "HEAD"], { cwd: root, deadline_s: 60 });
			if (headRev.rc !== 0) throw new Error("no HEAD; unmet prerequisite: exact committed source");
			revision = utf8(headRev.stdout).trim();
			const topRev = await run(["git", "-C", REPO_ROOT, "rev-parse", "--show-toplevel"], { cwd: root, deadline_s: 60 });
			if (topRev.rc !== 0 || resolve(utf8(topRev.stdout).trim()) !== resolve(REPO_ROOT)) throw new Error(`source identity not exact: ${REPO_ROOT} is not a repo top-level; refusing ancestor discovery`);
			srcExport = join(root, "official-src");
			mkdirSync(srcExport, { recursive: true });
			const archived = await run(["sh", "-c", `git -C ${JSON.stringify(REPO_ROOT)} archive ${JSON.stringify(revision)} | tar -x -C ${JSON.stringify(srcExport)}`], { cwd: root, deadline_s: 300 });
			if (archived.rc !== 0) throw new Error(`exact source export -> ${archived.rc}: ${utf8(archived.stderr).slice(0, 300)}`);
		} else {
			// History-free tree: build from a .git-free copy so an empty `git init`
			// left by the harness cannot shadow the archive stamp.
			revision = identity.revision;
			srcExport = join(root, "official-src");
			// Planted negative for the 72171 race: churn a directory created and
			// removed under REPO_ROOT/var/agent-tmp DURING the copy. The shared
			// helper skips that subtree, so the copy still passes and official-src
			// contains no var/agent-tmp, while a normal source dir (scripts/) is
			// still copied. Churn every 64th visit; each churn dir is removed
			// synchronously, so no residue escapes into the shared checkout.
			let churn = 0;
			const churnScope = join(REPO_ROOT, "var", "agent-tmp");
			copyTreeExceptGit(REPO_ROOT, srcExport, REPO_ROOT, () => {
				churn += 1;
				if (churn % 64 !== 0) return;
				const d = join(churnScope, `replaybr1-churn-${process.pid}-${churn}`);
				mkdirSync(d, { recursive: true });
				rmSync(d, { recursive: true, force: true });
			});
			expect(existsSync(join(srcExport, "var", "agent-tmp"))).toBe(false);
			expect(existsSync(join(srcExport, "scripts", "package-release.ts"))).toBe(true);
		}
		const pkgVer = (JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as { version: string }).version;
		const resultDir = join(root, "official-out");
		mkdirSync(resultDir, { recursive: true });
		const built = await run(["bun", join(srcExport, "scripts", "package-release.ts"), "--version", pkgVer, "--platform", "darwin-arm64-none", "--out", resultDir], { cwd: root, deadline_s: 600 });
		if (built.rc !== 0) throw new Error(`official recipe -> ${built.rc}: ${utf8(built.stdout).slice(0, 300)} ${utf8(built.stderr).slice(0, 300)}`);
		const tarball = join(resultDir, `omp-kit-v${pkgVer}-darwin-arm64-none.tar`);
		const extractDir = join(root, "official-extract");
		mkdirSync(extractDir, { recursive: true });
		const extracted = await run(["tar", "-x", "-f", tarball, "-C", extractDir], { cwd: root, deadline_s: 300 });
		if (extracted.rc !== 0) throw new Error(`artifact extract -> ${extracted.rc}`);
		// The sealed artifact must carry the exact source revision it was built from.
		const artifactDoc: unknown = JSON.parse(readFileSync(join(extractDir, "package.json"), "utf8"));
		const artifactRevision = typeof artifactDoc === "object" && artifactDoc !== null && "source_revision" in artifactDoc ? artifactDoc.source_revision : undefined;
		expect(artifactRevision).toBe(revision);
		const ompBin = join(extractDir, "bin", "omp-kit");
		const brHash = sha256hex(readFileSync(brBin));
		const srcHash = sha256hex(readFileSync(join(srcExport, "src", "verify.ts"), "utf8"));
		const shimSrcHash = sha256hex(readFileSync(join(srcExport, "src", "kitlib", "readonly-br.ts"), "utf8"));
		const ompHash = sha256hex(readFileSync(ompBin));
		const acHash = sha256hex(ac);
		for (const h of [brHash, srcHash, shimSrcHash, ompHash, acHash]) expect(h).toMatch(/^[0-9a-f]{64}$/);
		expect(revision).toMatch(/^[0-9a-f]{40}$/);
		const fam = `guard-native src=${srcHash.slice(0, 12)} shim=${shimSrcHash.slice(0, 12)} br=${brHash.slice(0, 12)} omp=${ompHash.slice(0, 12)} ac=${acHash.slice(0, 12)} tree=${revision.slice(0, 12)}`;
		const res = await verifyBead({ bead: id, exportSha: sha, repo: cdir, actor: "Peer", env: envT, dryRun: true, family: fam });
		expect(res.code).toBe("DRY_RUN");
		expect(res.replays.map(r => [r.letter, r.pass])).toEqual([["a", true], ["b", true], ["c", true]]);
		expect(res.log).toContain("owned fixture");
		expect(res.acts[2]?.join(" ") ?? "").toContain(fam);
		expect(readFileSync(join(tdir, ".beads", "issues.jsonl"), "utf8")).toBe(before);
		// Official candidate smoke through the existing verify consumer (dry-run: no mutation, no live claim).
		const officialEnv = { ...process.env, BEADS_DB: tdb } as Record<string, string>;
		const official = await run([ompBin, "verify", id, "--export", sha, "--project", cdir, "--actor", "Peer", "--family", "official-binary", "--dry-run", "--json"], { cwd: root, deadline_s: 600, env: officialEnv });
		const officialDoc: unknown = JSON.parse(utf8(official.stdout));
		const officialData: unknown = typeof officialDoc === "object" && officialDoc !== null && "data" in officialDoc ? officialDoc.data : null;
		const officialReplays = typeof officialData === "object" && officialData !== null && "replays" in officialData && Array.isArray(officialData.replays) ? officialData.replays as Array<{ letter?: unknown; pass?: unknown }> : null;
		if (officialReplays === null) throw new Error(`official verifier returned no replays: ${utf8(official.stdout).slice(0, 300)}`);
		expect(officialReplays.map(r => [r.letter, r.pass])).toEqual([["a", true], ["b", true], ["c", true]]);
		// The close act requires the min_reviewers gate on in_review -> closed;
		// replicate the production tracker's workflow policy into the fixture.
		writeFileSync(join(tdir, ".beads", "policy.yaml"), "workflow:\n  strict: true\n  statuses: [open, in_progress, in_review, rework, blocked, deferred, closed]\n  transitions:\n    initial: [open]\n    open: [in_progress, blocked, deferred, closed]\n    in_progress: [in_review, open, blocked, deferred]\n    in_review: [closed, rework]\n    rework: [in_progress, in_review, open]\n    blocked: [open, in_progress]\n    deferred: [open]\n    closed: [open]\n  gates:\n    \"in_review -> closed\":\n      require_all:\n        - min_reviewers: 1\n");
		const cliPath = resolve(import.meta.dir, "..", "..", "src", "cli.ts");
		const closed = await run([process.execPath, "run", "--silent", cliPath, "verify", id, "--export", sha, "--project", cdir, "--actor", "Peer", "--family", fam, "--json"], { cwd: root, deadline_s: 600, env: envT });
		if (closed.rc !== 0) throw new Error(`cli close -> ${closed.rc}: out=${utf8(closed.stdout).slice(0, 500)} err=${utf8(closed.stderr).slice(0, 300)}`);
		const closedDoc: unknown = JSON.parse(utf8(closed.stdout));
		const closedPayload: unknown = typeof closedDoc === "object" && closedDoc !== null && "data" in closedDoc ? closedDoc.data : closedDoc;
		const closedCode = typeof closedPayload === "object" && closedPayload !== null && "overall" in closedPayload && typeof closedPayload.overall === "string" ? closedPayload.overall : null;
		expect(closedCode).toBe("CLOSED");
		const closedActs = typeof closedPayload === "object" && closedPayload !== null && "acts" in closedPayload && Array.isArray(closedPayload.acts) ? closedPayload.acts : [];
		expect(JSON.stringify(closedActs)).toContain(fam);
		const finalShow = await brOut(["show", id, "--json"], tdir);
		const finalParsed: unknown = JSON.parse(finalShow.out);
		const finalRow: unknown = Array.isArray(finalParsed) ? finalParsed[0] : finalParsed;
		const finalStatus = typeof finalRow === "object" && finalRow !== null && "status" in finalRow && typeof finalRow.status === "string" ? finalRow.status : null;
		expect(finalStatus).toBe("closed");
	}, 600_000);
	test("copyTreeExceptGit skips a var/agent-tmp subtree deleted mid-walk; scripts/ still copied", async () => {
		const root = ownedTmp("replaybr1-copy-race", { bead: "ompkit-t7cn7.21" }).path;
		const tree = join(root, "tree");
		const dest = join(root, "dest");
		mkdirSync(join(tree, "scripts"), { recursive: true });
		writeFileSync(join(tree, "scripts", "ok.txt"), "source\n");
		const agentTmp = join(tree, "var", "agent-tmp");
		mkdirSync(join(agentTmp, "doomed-a", "sub"), { recursive: true });
		writeFileSync(join(agentTmp, "doomed-a", "sub", "f.txt"), "scratch\n");
		mkdirSync(join(agentTmp, "doomed-b"), { recursive: true });
		// Deterministic stand-in for the 72171 gate race: the first visit to a
		// listed var/agent-tmp child deletes every pre-created child, exactly as
		// a sibling gate test deleting its scratch between the walk's listing and
		// recursion. The pre-fix helper (HEAD) throws ENOENT here; the fixed
		// helper never enters the subtree.
		let sprung = false;
		copyTreeExceptGit(tree, dest, tree, (p) => {
			if (!sprung && (p === join(agentTmp, "doomed-a") || p === join(agentTmp, "doomed-b"))) {
				sprung = true;
				rmSync(join(agentTmp, "doomed-a"), { recursive: true, force: true });
				rmSync(join(agentTmp, "doomed-b"), { recursive: true, force: true });
			}
		});
		expect(sprung).toBe(false);
		expect(readFileSync(join(dest, "scripts", "ok.txt"), "utf8")).toBe("source\n");
		expect(existsSync(join(dest, "var", "agent-tmp"))).toBe(false);
	});

	test("official-candidate source identity resolves a git checkout and a stamped export, refuses empty repos and unstamped trees", async () => {
		const utf8 = (b: Uint8Array) => new TextDecoder().decode(b);
		const g = process.env.GRADE_WAVE_SCRATCH || undefined;
		const root = ownedTmp("replaybr3-identity", { bead: "ompkit-t7cn7.21", ...(g === undefined ? {} : { root: g }) }).path;
		// Control 1: a git checkout resolves its HEAD through the same seam the AC3 test uses.
		const cdir = join(root, "code");
		mkdirSync(cdir, { recursive: true });
		const unstamped = JSON.stringify({ source_revision: "$Format:%H$" });
		writeFileSync(join(cdir, "package.json"), unstamped);
		const git = async (args: string[]) => {
			const r = await run(["git", ...args], { cwd: cdir, deadline_s: 60 });
			if (r.rc !== 0) throw new Error(`git ${args.join(" ")} -> ${r.rc}: ${utf8(r.stderr)}`);
		};
		await git(["init", "-q"]);
		await git(["add", "package.json"]);
		await git(["-c", "user.name=t", "-c", "user.email=t@x", "-c", "core.hooksPath=/dev/null", "commit", "-qm", "identity fixture [test]"]);
		const head = await run(["git", "rev-parse", "HEAD"], { cwd: cdir, deadline_s: 60 });
		const headSha = utf8(head.stdout).trim();
		expect(identifyExactSource(cdir, readFileSync(join(cdir, "package.json")))).toEqual({ kind: "git" });
		// Control 2: a stamped history-free tree resolves its stamp without git.
		const stamped = join(root, "stamped");
		mkdirSync(stamped, { recursive: true });
		const stampedBytes = Buffer.from(JSON.stringify({ source_revision: headSha }));
		writeFileSync(join(stamped, "package.json"), stampedBytes);
		expect(identifyExactSource(stamped, readFileSync(join(stamped, "package.json")))).toEqual({ kind: "stamped", revision: headSha });
		// Control 3: a bare `git init` with no commits is not a checkout even
		// with a stamped manifest; the fresh-gate archive looks exactly like this.
		const empty = join(root, "emptyrepo");
		mkdirSync(empty, { recursive: true });
		const emptyInit = await run(["git", "init", "-q"], { cwd: empty, deadline_s: 60 });
		if (emptyInit.rc !== 0) throw new Error(`git init -> ${emptyInit.rc}`);
		writeFileSync(join(empty, "package.json"), stampedBytes);
		expect(identifyExactSource(empty, readFileSync(join(empty, "package.json")))).toEqual({ kind: "stamped", revision: headSha });
		// Control 4: an unstamped history-free tree has no identity, so the
		// official-candidate path must refuse it instead of building from it.
		const bare = join(root, "bare");
		mkdirSync(bare, { recursive: true });
		writeFileSync(join(bare, "package.json"), unstamped);
		expect(identifyExactSource(bare, readFileSync(join(bare, "package.json")))).toBe(null);
	});
});
