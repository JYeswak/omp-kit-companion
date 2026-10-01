import { afterEach, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readTestReceipt, recordTestReceipt, renderOmpWatch, type TestReceipt } from "../../src/omp-watch.ts";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function scratch(): string {
	const dir = mkdtempSync(join(tmpdir(), "omp-kit-watch-"));
	roots.push(dir);
	return dir;
}
const mode = (path: string) => (statSync(path).mode & 0o777).toString(8);
const receipt: TestReceipt = { schema_version: 1, kit_version: "0.0.0-test", scope: "fast", status: "PASS",
	recorded_at: "2026-10-01T00:00:00.000Z", version: "18.4.5", launcher_sha256: "a".repeat(64) };

test("test receipts are written only into a private state root", () => {
	const base = scratch();
	const fresh = join(base, "state", "omp-kit");
	expect(recordTestReceipt(fresh, receipt)).toBe(true);
	expect(mode(fresh)).toBe("700");
	expect(mode(join(fresh, "last-test.json"))).toBe("600");
	expect(readTestReceipt(fresh)).toEqual(receipt);

	const shared = join(base, "shared");
	mkdirSync(shared);
	chmodSync(shared, 0o755);
	expect(recordTestReceipt(shared, receipt)).toBe(false);
	expect(existsSync(join(shared, "last-test.json"))).toBe(false);
	expect(mode(shared)).toBe("755");

	const linked = join(base, "linked");
	symlinkSync(fresh, linked);
	expect(recordTestReceipt(linked, { ...receipt, status: "FAIL" })).toBe(false);
	expect(readTestReceipt(fresh)?.status).toBe("PASS");
});

test("the rendered job runs the kit test with --record and notifies only when it does not pass", () => {
	const base = scratch();
	const bin = join(base, "bin with 'quote");
	mkdirSync(bin);
	const launcher = join(bin, "omp-kit");
	const calls = join(base, "calls"), notified = join(base, "notified"), exitCode = join(base, "exit-code");
	writeFileSync(launcher, `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nexit "$(cat '${exitCode}')"\n`);
	chmodSync(launcher, 0o755);
	// The notifier resolves from the job's PATH, so this substitute records the notification instead of showing it.
	const fakes = join(base, "fakes");
	mkdirSync(fakes);
	writeFileSync(join(fakes, "osascript"), `#!/bin/sh\nprintf '%s\\n' "$2" >> '${notified}'\n`);
	chmodSync(join(fakes, "osascript"), 0o755);
	const { program_arguments } = renderOmpWatch({ kitLauncher: launcher, ompPackageJson: join(base, "package.json"), path: "/usr/bin:/bin" });
	const runJob = (code: number) => {
		writeFileSync(exitCode, String(code));
		return Bun.spawnSync(program_arguments, { env: { PATH: `${fakes}:/usr/bin:/bin` }, stdout: "pipe", stderr: "pipe" });
	};

	const passed = runJob(0);
	expect(passed.exitCode, passed.stderr.toString()).toBe(0);
	expect(existsSync(notified)).toBe(false);
	runJob(1);
	expect(readFileSync(notified, "utf8")).toContain("omp-kit test did not pass after an OMP update");
	expect(readFileSync(calls, "utf8")).toBe("test --record --json\ntest --record --json\n");
});

const plutil = process.platform === "darwin" ? Bun.which("plutil") : null;
const systemdAnalyze = process.platform === "linux" ? Bun.which("systemd-analyze") : null;
// Skipped only where neither platform validator exists; CI runs it on macOS (plutil) and Linux (systemd-analyze).
test.skipIf(!plutil && !systemdAnalyze)("rendered units pass the platform's own validator with shell and unit metacharacters in paths", () => {
	const base = scratch();
	const kitLauncher = join(base, `odd %h $HOME "dir" 'x' & <y>`, "omp-kit");
	const render = renderOmpWatch({ kitLauncher, ompPackageJson: join(base, "omp %i", "package.json"), path: "/usr/bin:/bin" });
	if (plutil) {
		const plist = join(base, "watch.plist");
		writeFileSync(plist, render.launchd_plist);
		const lint = Bun.spawnSync([plutil, "-lint", plist], { stdout: "pipe", stderr: "pipe" });
		expect(lint.exitCode, lint.stdout.toString() + lint.stderr.toString()).toBe(0);
		// XML escaping must round-trip: launchd runs exactly the argv the operator was shown.
		const argv = Bun.spawnSync([plutil, "-extract", "ProgramArguments", "json", "-o", "-", plist], { stdout: "pipe", stderr: "pipe" });
		expect(JSON.parse(argv.stdout.toString())).toEqual(render.program_arguments);
	}
	if (systemdAnalyze) {
		const pathUnit = join(base, "omp-kit-omp-watch.path"), serviceUnit = join(base, "omp-kit-omp-watch.service");
		writeFileSync(pathUnit, render.systemd_path_unit);
		writeFileSync(serviceUnit, render.systemd_service_unit);
		const verify = Bun.spawnSync([systemdAnalyze, "verify", "--man=no", pathUnit, serviceUnit], { stdout: "pipe", stderr: "pipe" });
		expect(verify.exitCode, verify.stdout.toString() + verify.stderr.toString()).toBe(0);
	}
});
