import { expect } from "bun:test";
import { createHash } from "node:crypto";
import { performance } from "node:perf_hooks";
import { chmodSync, copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, readlinkSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { FullTestReport } from "../../src/full-test-runner.ts";
import type { ReleaseAsset, ReleasePlatform } from "../../src/kit-release.ts";
import { acquireKitUpdateLock, auditMutations, beginKitUpdateReceipt, inspectPendingKitUpdate } from "../../src/mutations.ts";
import { CASE_HEADER } from "../../src/case-corpus.ts";
import { ownedTmp } from "../../src/kitlib/tmp";
import { run as runBounded } from "../../src/kitlib/run";
import { recordOptOut } from "../../src/activation.ts";
import { KNOWN_JOBS } from "../../src/service.ts";
import { releaseProcess } from "./release-process.ts";
import { fixtureDeadlineS } from "./fixture-process.ts";
const repoRoot = resolve(import.meta.dir, "../..");

export { sha, platform, hostPlatform, scratch, tar, binary, manifest, fixtureContractFiles, fixture, input,
 RECONCILE_PROFILES, reconcilePluginLink, preparePartialReconcile, runPartialReconcile,
 buildNPlusTwoCandidate, buildCompiledReleaseFixture, writeSyntheticGhVerifier,
 copyReleaseSource, journeyWorkload, assertJourneyWorkload, JOURNEY_WORKLOAD, MINIMAL_SCENARIOS, runCandidateFullTest };
export type { FixtureContext, CompiledReleaseFixture };
const sha = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const platform: ReleasePlatform = { os: "darwin", arch: "arm64", libc: "none" };

const hostPlatform: ReleasePlatform = process.platform === "darwin"
	? { os: "darwin", arch: process.arch === "arm64" ? "arm64" : "x64", libc: "none" }
	: { os: "linux", arch: process.arch === "arm64" ? "arm64" : "x64", libc: "gnu" };
const scratch = process.env.TMPDIR ?? join(import.meta.dir, "../../var/agent-tmp");
type FixtureFile = { name: string; bytes: Buffer };
type FixtureContext = { root: string; prefix: string; stateRoot: string; home: string; source: string;
	indexPath: string; archivePath: string; oldBinary: Buffer; contractFiles: FixtureFile[];
	platform: ReleasePlatform; currentVersion: string; nextVersion: string };
type FixtureOptions = { platform?: ReleasePlatform; currentVersion?: string; nextVersion?: string };

function tar(entries: { name: string; bytes: Buffer }[]): Buffer {
	const blocks: Buffer[] = [];
	for (const entry of entries) {
		const header = Buffer.alloc(512);
		header.write(entry.name, 0, 100);
		header.write("0000755\0", 100, "ascii");
		header.write("0000000\0", 108, "ascii");
		header.write("0000000\0", 116, "ascii");
		header.write(entry.bytes.length.toString(8).padStart(11, "0") + "\0", 124, "ascii");
		header.write("00000000000\0", 136, "ascii");
		header.fill(32, 148, 156);
		header.write("0", 156, "ascii");
		header.write("ustar\0", 257, "ascii");
		header.write("00", 263, "ascii");
		const sum = header.reduce((total, byte) => total + byte, 0);
		header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "ascii");
		blocks.push(header, entry.bytes, Buffer.alloc((512 - entry.bytes.length % 512) % 512));
	}
	return Buffer.concat([...blocks, Buffer.alloc(1024)]);
}
function binary(version: string, selectedPlatform: ReleasePlatform = platform): Buffer {
	const info = JSON.stringify(JSON.stringify({ version, source_tag: "v" + version,
		platform: { os: selectedPlatform.os, arch: selectedPlatform.arch } }));
	return Buffer.from("#!/bin/sh\nprintf '%s\\n' " + info + "\n");
}
function manifest(version: string, executable: Buffer, extraFiles: readonly FixtureFile[] = []): Buffer {
	const files = [{ path: "bin/omp-kit", sha256: sha(executable) },
		...extraFiles.map(({ name, bytes }) => ({ path: name, sha256: sha(bytes) }))]
		.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
	return Buffer.from(JSON.stringify({ schema_version: 1, version, source_tag: "v" + version, files }));
}
function fixtureContractFiles(): FixtureFile[] {
	const rule = Buffer.from("# Rule A\n");
	const manifestFile = Buffer.from("name\tsha256\tclass\tpack\nrule-a\t" + sha(rule) + "\ttripwire\t1234567\n");
	const cases = Buffer.from(CASE_HEADER + "\n" +
		"rule-a\tfire\ttext\t-\t-\tbr close x\tfixture fire\t\n" +
		"rule-a\tquiet\ttext\t-\t-\tbr list\tfixture quiet\t\n");
	return [{ name: "MANIFEST.tsv", bytes: manifestFile }, { name: "cases/cases.tsv", bytes: cases }, { name: "rules/rule-a.md", bytes: rule }];
}
async function fixture<T>(run: (ctx: FixtureContext) => Promise<T>, options: FixtureOptions = {}): Promise<T> {
	const directory = ownedTmp("kit-update", { root: scratch });
	const root = realpathSync(directory.path);
	const prefix = join(root, "prefix"), stateRoot = join(root, "state"), home = join(root, "home"), source = join(root, "source");
	const selectedPlatform = options.platform ?? platform;
	const currentVersion = options.currentVersion ?? "1.2.2", nextVersion = options.nextVersion ?? "1.2.3";
	mkdirSync(join(prefix, "bin"), { recursive: true });
	mkdirSync(join(prefix, "releases", currentVersion, "bin"), { recursive: true });
	mkdirSync(home);
	mkdirSync(source);
	const oldBinary = binary(currentVersion, selectedPlatform);
	writeFileSync(join(prefix, "releases", currentVersion, "bin", "omp-kit"), oldBinary, { mode: 0o755 });
	chmodSync(join(prefix, "releases", currentVersion, "bin", "omp-kit"), 0o755);
	writeFileSync(join(prefix, "releases", currentVersion, "release-manifest.json"), manifest(currentVersion, oldBinary));
	symlinkSync("../releases/" + currentVersion + "/bin/omp-kit", join(prefix, "bin", "omp-kit"));
	const contractFiles = fixtureContractFiles();
	const next = binary(nextVersion, selectedPlatform), releaseManifest = manifest(nextVersion, next, contractFiles);
	const archive = tar([{ name: "bin/omp-kit", bytes: next }, ...contractFiles, { name: "release-manifest.json", bytes: releaseManifest }]);
	const key = [selectedPlatform.os, selectedPlatform.arch, selectedPlatform.libc].join("-");
	const filename = "omp-kit-v" + nextVersion + "-" + key + ".tar";
	const archivePath = join(source, filename), indexPath = join(source, "release-index.json");
	writeFileSync(archivePath, archive);
	writeFileSync(`${archivePath}.sigstore.json`, JSON.stringify({ fixture: true }));
	writeFileSync(indexPath, JSON.stringify({ schema_version: 1, version: nextVersion, source_tag: "v" + nextVersion, assets: {
		[key]: { ...selectedPlatform, filename, sha256: sha(archive), manifest_sha256: sha(releaseManifest) },
	} }));
	const previousPath = process.env.PATH;
	process.env.PATH = join(import.meta.dir, "../fixtures/kit-release") + ":" + previousPath;
	try { return await run({ root, prefix, stateRoot, home, source, indexPath, archivePath, oldBinary, contractFiles,
		platform: selectedPlatform, currentVersion, nextVersion }); }
	finally {
		if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
		directory.cleanup();
	}
}
const input = (ctx: FixtureContext) => ({ prefix: ctx.prefix, stateRoot: ctx.stateRoot, home: ctx.home,
	indexPath: ctx.indexPath, archivePath: ctx.archivePath, platform: ctx.platform,
	version: ctx.nextVersion, sourceTag: "v" + ctx.nextVersion });
const RECONCILE_PROFILES = ["default", "claude", "codex", "muse"] as const;

function reconcilePluginLink(home: string, profile: string): string {
	const profileRoot = profile === "default" ? join(home, ".omp", "plugins") : join(home, ".omp", "profiles", profile, "plugins");
	return join(profileRoot, "node_modules", "omp-kit-companion");
}

function writeReconcilePluginStore(root: string, version: string): void {
	mkdirSync(join(root, "rules"), { recursive: true });
	mkdirSync(join(root, "extensions"), { recursive: true });
	writeFileSync(join(root, "package.json"), JSON.stringify({ name: "omp-kit-companion", version }));
	writeFileSync(join(root, "rules", "rule-a.md"), `# ${version}\n`);
}

type PreparedPartialReconcile = { receiptId: string; store: string; oldStore: string; env: Record<string, string> };

function preparePartialReconcile(ctx: FixtureContext, skipLinkProfile = ""): PreparedPartialReconcile {
	const stateRoot = join(ctx.root, "omp-kit");
	mkdirSync(stateRoot, { recursive: true, mode: 0o700 });
	chmodSync(stateRoot, 0o700);
	const lock = acquireKitUpdateLock(stateRoot);
	let receiptId: string;
	try {
		receiptId = beginKitUpdateReceipt(stateRoot, lock, {
			scope: "kit", identitySha256: sha(ctx.oldBinary), kitVersion: ctx.currentVersion, ompVersion: null, channel: null,
		}).id;
	} finally { lock.release(); }

	const oldStore = join(ctx.prefix, "releases", ctx.currentVersion);
	const store = join(ctx.prefix, "releases", ctx.nextVersion);
	writeReconcilePluginStore(oldStore, ctx.currentVersion);
	writeReconcilePluginStore(store, ctx.nextVersion);
	const cliPath = join(repoRoot, "src", "cli.ts");
	const installedCli = Buffer.from(`#!/bin/sh\nexec '${process.execPath.split("'").join("'\\''")}' '${cliPath.split("'").join("'\\''")}' "$@"\n`);
	mkdirSync(join(store, "bin"), { recursive: true });
	writeFileSync(join(store, "bin", "omp-kit"), installedCli, { mode: 0o755 });
	chmodSync(join(store, "bin", "omp-kit"), 0o755);
	const stable = join(ctx.prefix, "bin", "omp-kit");
	renameSync(stable, join(ctx.prefix, "bin", "omp-kit.previous"));
	symlinkSync(`../releases/${ctx.nextVersion}/bin/omp-kit`, stable);

	for (const profile of RECONCILE_PROFILES) {
		const agent = profile === "default"
			? join(ctx.home, ".omp", "agent")
			: join(ctx.home, ".omp", "profiles", profile, "agent");
		mkdirSync(agent, { recursive: true });
		writeFileSync(join(agent, "config.yml"), "ttsr:\n  disabledRules: []\n");
		const link = reconcilePluginLink(ctx.home, profile);
		mkdirSync(dirname(link), { recursive: true });
		symlinkSync(oldStore, link);
	}

	const activationPath = join(stateRoot, `kit-activation-${receiptId}.json`);
	writeFileSync(activationPath, JSON.stringify({
		schema_version: 1, id: receiptId,
		before: { version: ctx.currentVersion, sha256: sha(ctx.oldBinary),
			target: `../releases/${ctx.currentVersion}/bin/omp-kit`,
			binary: join(ctx.prefix, "releases", ctx.currentVersion, "bin", "omp-kit") },
		after: { version: ctx.nextVersion, sha256: sha(installedCli),
			target: `../releases/${ctx.nextVersion}/bin/omp-kit`,
			binary: join(ctx.prefix, "releases", ctx.nextVersion, "bin", "omp-kit") },
		state: "READY",
	}), { mode: 0o600 });
	chmodSync(activationPath, 0o600);

	const ompBin = join(ctx.root, "omp-bin");
	mkdirSync(ompBin);
	writeFileSync(join(ompBin, "omp"), String.raw`#!/bin/sh
set -e
profile=default
if [ "$1" = "--profile" ]; then profile=$2; shift 2; fi
if [ "$profile" = default ]; then plugin_dir="$HOME/.omp/plugins"; else plugin_dir="$HOME/.omp/profiles/$profile/plugins"; fi
link="$plugin_dir/node_modules/omp-kit-companion"
case "$1 $2" in
  "plugin list")
    if [ -L "$link" ]; then
      printf '{"npm":[{"name":"omp-kit-companion","path":"%s"}]}\n' "$(readlink "$link")"
    else
      printf '{"npm":[]}\n'
    fi
    ;;
  "plugin link")
    if [ "$OMP_FAKE_SKIP_LINK" = "$profile" ]; then exit 0; fi
    target=$3
    rm -f "$link"
    mkdir -p "$plugin_dir/node_modules"
    ln -s "$target" "$link"
    ;;
  "plugin uninstall")
    rm -f "$link"
    ;;
  "config get")
    printf '{"key":"ttsr.disabledRules","value":[]}\n'
    ;;
  *)
    printf 'unsupported OMP command\n' >&2
    exit 2
    ;;
esac
`, { mode: 0o755 });
	writeFileSync(join(ompBin, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-coding-agent", version: "1.2.3" }));
	for (const relativePath of ["export/ttsr.ts", "capability/rule.ts", "discovery/helpers.ts"]) {
		const sourcePath = join(ompBin, "src", relativePath);
		mkdirSync(dirname(sourcePath), { recursive: true });
		writeFileSync(sourcePath, "export {};\n");
	}
	const nativePackage = join(ompBin, "node_modules", "@oh-my-pi", "pi-natives");
	mkdirSync(nativePackage, { recursive: true });
	writeFileSync(join(nativePackage, "package.json"), JSON.stringify({ name: "@oh-my-pi/pi-natives" }));
	return {
		receiptId, store, oldStore,
		env: {
			...process.env,
			HOME: ctx.home,
			XDG_CONFIG_HOME: join(ctx.root, "xdg-config"),
			XDG_STATE_HOME: ctx.root,
			XDG_DATA_HOME: join(ctx.root, "xdg-data"),
			XDG_CACHE_HOME: join(ctx.root, "xdg-cache"),
			PATH: `${ompBin}:/usr/bin:/bin`,
			OMP: "", OMP_BIN: "", OMP_PATH: "", OMP_SRC: "", NO_COLOR: "1",
			TMPDIR: process.env.TMPDIR ?? ctx.root,
			OMP_FAKE_SKIP_LINK: skipLinkProfile,
		},
	};
}

async function runPartialReconcile(prepared: PreparedPartialReconcile) {
	const result = await runBounded([
		process.execPath, join(repoRoot, "src", "cli.ts"), "update", "--reconcile", prepared.receiptId, "--yes", "--json",
	], { deadline_s: 60, cwd: repoRoot, env: prepared.env });
	if (result.timed_out || result.rc === null)
		throw new Error(`update --reconcile timed out or was not reaped: ${Buffer.from(result.stderr).toString("utf8")}`);
	return { rc: result.rc, output: JSON.parse(Buffer.from(result.stdout).toString("utf8")) as { data: Record<string, unknown> } };
}
// KITUPDATELOAD1: the journey tests judge the updater, not the corpus. Their candidate keeps every ladder stage
// real but ships a minimal rule set: the plant's bash rule (kit-close-needs-evidence), one write rule
// (kit-skill-forbidden-instruction) and the two other rules docs/flywheel-invariants.tsv names as mechanisms, so that
// stage still judges its unmodified map. Each keeps one fire and one near-miss row and its harness cases, plus the
// admission guard pair live coverage requires and the e2e plant. The full corpus stays judged where it is the
// subject: package-release-live, the full suite's e2e and native certification.
const MINIMAL_RULES = {
	"rules": ["kit-close-needs-evidence", "kit-close-reason-no-evidence"],
	"rules-fleet": ["kit-skill-forbidden-instruction", "kit-no-shared-merge"],
} as const;
const MINIMAL_SCENARIOS = ["close-bare-fire", "close-help-near", "close-bare-word-reason", "close-reason-evidenced-near",
	"skill-forbidden-fire", "skill-forbidden-near", "shared-merge-fire", "shared-merge-base-near",
	"scratch-is-not-a-home-fire", "scratch-is-not-a-home-near", "plant-streamed-evidenced-close"] as const;
// The workload a journey candidate may carry: TTSR rule rows (one fire, one near-miss per rule) and rules.
const JOURNEY_WORKLOAD = { ruleScenarioRows: 8, rules: 4 } as const;

function minimizeCorpus(root: string): void {
	// Case rows of removed TTSR rules go; admission-guard rows (no rules/*.md) stay, as the harness gate requires.
	const removed = new Set<string>();
	for (const [directory, names] of Object.entries(MINIMAL_RULES)) {
		const keep = new Set<string>(names.map(name => name + ".md"));
		for (const entry of readdirSync(join(root, directory)))
			if (entry.endsWith(".md") && !keep.has(entry)) { rmSync(join(root, directory, entry)); removed.add(entry.slice(0, -3)); }
	}
	for (const file of readdirSync(join(root, "cases")).filter(name => name.endsWith(".tsv"))) {
		const casesPath = join(root, "cases", file);
		const caseLines = readFileSync(casesPath, "utf8").replace(/\r\n/g, "\n").replace(/\n+$/, "").split("\n");
		if (caseLines[0] !== CASE_HEADER) throw new Error("minimal candidate cases have an unknown schema: " + file);
		const caseRows = caseLines.slice(1).filter(row => row.trim() !== "" && !row.startsWith("#") && !removed.has(row.split("\t")[0]!));
		writeFileSync(casesPath, [CASE_HEADER, ...caseRows].join("\n") + "\n");
	}
	const scenariosPath = join(root, "tests", "live", "scenarios.json");
	const scenarios = JSON.parse(readFileSync(scenariosPath, "utf8")) as { id: string }[];
	const selected = MINIMAL_SCENARIOS.map(id => scenarios.find(row => row.id === id)
		?? (() => { throw new Error("minimal candidate scenario missing: " + id); })());
	writeFileSync(scenariosPath, "[\n" + selected.map(row => "  " + JSON.stringify(row)).join(",\n") + "\n]\n");
}

/** Workload a candidate's ladder will run; journeys refuse a candidate above JOURNEY_WORKLOAD before any timing. */
function journeyWorkload(root: string): { ruleScenarioRows: number; rules: number } {
	const scenarios = JSON.parse(readFileSync(join(root, "tests", "live", "scenarios.json"), "utf8")) as
		{ backend?: string; plant?: boolean }[];
	const rules = ["rules", "rules-fleet"].flatMap(directory => existsSync(join(root, directory))
		? readdirSync(join(root, directory)).filter(entry => entry.endsWith(".md")) : []);
	return { ruleScenarioRows: scenarios.filter(row => (row.backend ?? "ttsr") === "ttsr" && !row.plant).length, rules: rules.length };
}

function assertJourneyWorkload(root: string): void {
	const workload = journeyWorkload(root);
	if (workload.ruleScenarioRows > JOURNEY_WORKLOAD.ruleScenarioRows || workload.rules > JOURNEY_WORKLOAD.rules)
		throw new Error(`KITUPDATELOAD1: journey candidate exceeds its workload bound: ${workload.ruleScenarioRows} rule scenario rows `
			+ `(max ${JOURNEY_WORKLOAD.ruleScenarioRows}), ${workload.rules} rules (max ${JOURNEY_WORKLOAD.rules})`);
}

async function copyReleaseSource(sourceRoot: string, destination: string, options: { minimal?: boolean } = {}): Promise<void> {
	mkdirSync(destination, { recursive: true });
	for (const directory of ["src", "installer", "scripts", "rules", "rules-fleet", "retired", "cases", "policy", "extensions", "examples", "checkers", "config", "skills", "tests/live", "plugins/omp-kit-tern"]) {
		const target = join(destination, directory);
		mkdirSync(dirname(target), { recursive: true });
		cpSync(join(sourceRoot, directory), target, { recursive: true });
	}
	mkdirSync(join(destination, "docs"), { recursive: true });
	for (const file of ["flywheel-invariants.tsv", "tern-integration.md", "tern-verb-map.md", "tern-coverage.tsv", "sources.md"])
		copyFileSync(join(sourceRoot, "docs", file), join(destination, "docs", file));
	for (const file of ["LICENSE", "MANIFEST.fleet.tsv", "package.json", ".github/test-budget.json"]) {
		const target = join(destination, file);
		mkdirSync(dirname(target), { recursive: true });
		copyFileSync(join(sourceRoot, file), target);
	}
	if (options.minimal) minimizeCorpus(destination);
	// MANIFEST.tsv is generated and gitignored, so an exact-commit export has
	// no copy to take. Regenerate it from the candidate's own rules with the
	// same generator the release packaging uses (package-release.ts
	// packageRuleManifest); a stale live-tree copy is never an input.
	// Bounded through kitlib run, not a raw spawn: the generator measured
	// 0.7-0.9 s wall on this Mac (2026-10-27); the 60 s deadline only bounds hangs.
	// A minimal candidate also prunes rules-fleet/, so it rewrites both manifests in place.
	const manifest = await runBounded(["sh", join(destination, "scripts", "build-manifest.sh"), ...(options.minimal ? [] : ["--stdout"])], {
		deadline_s: 60, cwd: destination, env: { ...process.env, TMPDIR: process.env.TMPDIR ?? dirname(destination) },
	});
	if (manifest.timed_out) throw new Error("candidate MANIFEST.tsv generation timed out");
	if (manifest.rc !== 0)
		throw new Error("candidate MANIFEST.tsv generation failed: " + new TextDecoder().decode(manifest.stdout) + new TextDecoder().decode(manifest.stderr));
	if (manifest.stdout.length === 0) throw new Error("candidate MANIFEST.tsv generation produced no output");
	if (!options.minimal) writeFileSync(join(destination, "MANIFEST.tsv"), manifest.stdout);
}

async function buildNPlusTwoCandidate(ctx: FixtureContext): Promise<{
	root: string; executable: string; baseCases: number; baseQuiet: number;
	targetCases: number; targetQuiet: number; packageBuildDurationMs: number;
}> {
	const sourceRoot = join(ctx.root, "candidate-source");
	await copyReleaseSource(resolve(import.meta.dir, "../.."), sourceRoot, { minimal: true });
	assertJourneyWorkload(sourceRoot);
	const casesPath = join(sourceRoot, "cases", "cases.tsv");
	const rawCases = readFileSync(casesPath, "utf8").replace(/\r\n/g, "\n").replace(/\n+$/, "");
	const caseLines = rawCases.split("\n");
	if (caseLines[0] !== CASE_HEADER) throw new Error("candidate cases fixture has an unknown schema");
	const rows = caseLines.slice(1).filter(row => row.trim() !== "" && !row.startsWith("#"));
	// These existing controls have no known metamorphic breaks; N+2 tests case-count drift only.
	const fire = rows.find(row => {
		const columns = row.split("\t");
		return columns[0] === "kit-close-needs-evidence" && columns[1] === "fire" && columns[5] === "br close x";
	});
	const quiet = rows.find(row => {
		const columns = row.split("\t");
		return columns[0] === "kit-close-needs-evidence" && columns[1] === "quiet" &&
			columns[5] === 'br close x --reason "cargo test -> 41 passed; commit a1b2c3d"';
	});
	if (!fire || !quiet) throw new Error("candidate cases fixture needs metamorphic-clean fire and quiet controls");
	const annotate = (row: string, label: string): string => {
		const columns = row.split("\t");
		columns[6] = ((columns[6] ?? "") + " " + label).trim();
		return columns.join("\t");
	};
	const baseCases = rows.length, baseQuiet = rows.filter(row => row.split("\t")[1] === "quiet").length;
	const additions = [annotate(fire, "U1-N-plus-two-fire"), annotate(quiet, "U1-N-plus-two-quiet")];
	const targetCases = baseCases + additions.length;
	const targetQuiet = baseQuiet + additions.filter(row => row.split("\t")[1] === "quiet").length;
	writeFileSync(casesPath, rawCases + "\n" + additions.join("\n") + "\n");
	const output = join(ctx.root, "candidate-package");
	mkdirSync(output);
	const key = [ctx.platform.os, ctx.platform.arch, ctx.platform.libc].join("-");
	const packageBuildStarted = performance.now();
	const build = await releaseProcess(["sh", join(sourceRoot, "scripts", "package-release.sh"), "--version", ctx.nextVersion,
		"--platform", key, "--out", output], { cwd: sourceRoot, env: { ...process.env, TMPDIR: ctx.root }, stdout: "pipe", stderr: "pipe", deadline_s: 120 });
	const packageBuildDurationMs = Math.round(performance.now() - packageBuildStarted);
	if (build.exitCode !== 0) throw new Error("N+2 candidate package build failed: " + build.stdout.toString() + build.stderr.toString());
	const asset = JSON.parse(build.stdout.toString()) as { os: string; arch: string; libc: string; filename: string; sha256: string; manifest_sha256: string };
	const packagedArchive = join(output, asset.filename), archive = readFileSync(packagedArchive);
	writeFileSync(ctx.archivePath, archive);
	writeFileSync(ctx.indexPath, JSON.stringify({ schema_version: 1, version: ctx.nextVersion, source_tag: "v" + ctx.nextVersion, assets: { [key]: asset } }));
	const root = join(ctx.root, "candidate-release");
	mkdirSync(root);
	const extract = await releaseProcess(["tar", "xf", packagedArchive, "-C", root], { cwd: ctx.root, env: { ...process.env, TMPDIR: ctx.root }, stdout: "pipe", stderr: "pipe", deadline_s: 120 });
	if (extract.exitCode !== 0) throw new Error("N+2 candidate extraction failed: " + extract.stdout.toString() + extract.stderr.toString());
	return { root, executable: join(root, "bin", "omp-kit"), baseCases, baseQuiet, targetCases, targetQuiet, packageBuildDurationMs };
}
type CompiledReleaseFixture = { version: string; archivePath: string; indexPath: string };


async function buildCompiledReleaseFixture(
	scratchRoot: string, repoRoot: string, home: string, version: string, selectedPlatform: ReleasePlatform,
	plant?: (sourceRoot: string) => void,
): Promise<CompiledReleaseFixture> {
	const output = join(scratchRoot, `package-${version}`);
	mkdirSync(output, { mode: 0o700 });
	const sourceRoot = join(scratchRoot, `source-${version}`);
	await copyReleaseSource(repoRoot, sourceRoot, { minimal: true });
	plant?.(sourceRoot);
	assertJourneyWorkload(sourceRoot);
	const platformKey = [selectedPlatform.os, selectedPlatform.arch, selectedPlatform.libc].join("-");
	const path = [dirname(process.execPath), process.env.PATH ?? "", "/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin"]
		.filter(Boolean).join(":");
	const build = await releaseProcess(["/bin/sh", join(sourceRoot, "scripts/package-release.sh"), "--version", version,
		"--platform", platformKey, "--out", output], { cwd: sourceRoot,
		env: { PATH: path, HOME: home, TMPDIR: scratchRoot, LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
		stdout: "pipe",
		stderr: "pipe", deadline_s: 120 });
	if (build.exitCode !== 0) {
		throw new Error(`compiled fixture release ${version} failed (${build.exitCode}): ${build.stdout.toString()} ${build.stderr.toString()}`);
	}
	const asset = JSON.parse(build.stdout.toString()) as ReleaseAsset;
	const archivePath = join(output, asset.filename);
	const indexPath = join(output, "release-index.json");
	writeFileSync(indexPath, `${JSON.stringify({
		schema_version: 1, version, source_tag: `v${version}`, assets: { [platformKey]: asset },
	})}\n`, { mode: 0o600, flag: "wx" });
	writeFileSync(`${archivePath}.sigstore.json`, `${JSON.stringify({ fixture: true })}\n`, { mode: 0o600, flag: "wx" });
	return { version, archivePath, indexPath };
}

/** Extract a compiled fixture release and run its own `test --full` (the update postcheck's ladder) in a private HOME. */
async function runCandidateFullTest(release: CompiledReleaseFixture, scratchRoot: string): Promise<FullTestReport> {
	const root = join(scratchRoot, `extracted-${release.version}`), home = join(scratchRoot, `full-home-${release.version}`);
	mkdirSync(root, { mode: 0o700 });
	mkdirSync(home, { mode: 0o700 });
	const extract = await runBounded(["tar", "xf", release.archivePath, "-C", root], { deadline_s: fixtureDeadlineS(60), cwd: scratchRoot });
	if (extract.rc !== 0) throw new Error("candidate extraction failed: " + Buffer.from(extract.stderr).toString("utf8"));
	const omp = Bun.which("omp");
	if (!omp) throw new Error("omp is required to run the candidate ladder");
	const full = await runBounded([join(root, "bin", "omp-kit"), "test", "--full", "--json"], { deadline_s: fixtureDeadlineS(900), cwd: home,
		env: { PATH: [dirname(omp), dirname(process.execPath), "/usr/bin", "/bin"].join(":"), HOME: home, TMPDIR: scratchRoot, CI: "1" } });
	const stdout = Buffer.from(full.stdout).toString("utf8");
	if (full.timed_out) throw new Error("candidate full test timed out: " + stdout.slice(-2000));
	const envelope: unknown = JSON.parse(stdout);
	const data = envelope && typeof envelope === "object" && "data" in envelope ? envelope.data : null;
	const report = data && typeof data === "object" && "test" in data ? data.test : null;
	if (!report || typeof report !== "object" || !("failures" in report) || !Array.isArray(report.failures))
		throw new Error("candidate full test printed no report: " + stdout.slice(-2000));
	// Shape checked above; the producer is this repository's own runFullTest.
	const typed: FullTestReport = report as FullTestReport;
	return typed;
}

function writeSyntheticGhVerifier(root: string, repoRoot: string): string {
	const bin = join(root, "synthetic-gh-bin");
	mkdirSync(bin, { mode: 0o700 });
	const executable = join(bin, "gh");
	const fixture = join(repoRoot, "tests/fixtures/kit-release/gh");
	const source = `#!/usr/bin/env python3
import json, os, sys

ROOT = ${JSON.stringify(root)}
FIXTURE = ${JSON.stringify(fixture)}
GH_TOKEN = "SYNTHETIC_GH_TOKEN_V66L21_NOT_A_CREDENTIAL"
GITHUB_TOKEN = "SYNTHETIC_GITHUB_TOKEN_V66L21_NOT_A_CREDENTIAL"
args = sys.argv[1:]
source_lookup = args[:1] == ["api"] and any("/commits/v" in arg for arg in args)
bundle_verify = args[:2] == ["attestation", "verify"]
if not source_lookup and not bundle_verify:
    os.execv(sys.executable, [sys.executable, FIXTURE, *args])

config = os.environ.get("GH_CONFIG_DIR", "")
try:
    config_root = os.path.realpath(ROOT)
    config_real = os.path.realpath(config)
    config_scoped = bool(config) and os.path.isdir(config_real) and os.path.commonpath([config_root, config_real]) == config_root
except (OSError, ValueError):
    config_scoped = False
token_auth = os.environ.get("GH_TOKEN") == GH_TOKEN and os.environ.get("GITHUB_TOKEN") == GITHUB_TOKEN
config_auth = "GH_TOKEN" not in os.environ and "GITHUB_TOKEN" not in os.environ and os.path.isfile(os.path.join(config, "synthetic-gh-auth"))
report = {
    "auth_mode": "tokens" if token_auth else "config-only" if config_auth else "invalid",
    "source_lookup": source_lookup,
    "bundle_verify": bundle_verify,
    "gh_config_dir_scoped": config_scoped,
    "unrelated_context_absent": all(key not in os.environ for key in (
        "PI_BRIDGE_SENTINEL", "MCP_PROVIDER_SENTINEL", "GH_ENTERPRISE_TOKEN")),
}
if config_scoped:
    with open(os.path.join(config, "observed.ndjson"), "a", encoding="utf-8") as output:
        output.write(json.dumps(report) + "\\n")
if not config_scoped or report["auth_mode"] == "invalid" or not report["unrelated_context_absent"]:
    print("synthetic GitHub verifier context refused", file=sys.stderr)
    sys.exit(1)
if source_lookup and os.path.isfile(os.path.join(config, "reject-source")):
    print("synthetic source authority refused", file=sys.stderr)
    sys.exit(1)
os.execv(sys.executable, [sys.executable, FIXTURE, *args])
`;
	writeFileSync(executable, source, { mode: 0o700, flag: "wx" });
	chmodSync(executable, 0o755);
	return bin;
}
export async function runCompiledUpdateJourney(mode: "success" | "relink"): Promise<void> {
	const repoRoot = realpathSync(resolve(import.meta.dir, "../.."));
	const runtimeScratchParent = join(repoRoot, "var", "agent-tmp");
	mkdirSync(runtimeScratchParent, { recursive: true, mode: 0o700 });
	const callerWorkRoot = ownedTmp("kit-update-caller", { root: runtimeScratchParent });
	const scratchOwned = ownedTmp("kit-update-compiled", { root: scratch });
	const scratchRoot = realpathSync(scratchOwned.path);
		const home = join(scratchRoot, "home");
		const buildHome = join(scratchRoot, "build-home");
		const prefix = join(scratchRoot, "positive-prefix");
		const negativeHome = join(scratchRoot, "negative-home");
		const negativePrefix = join(scratchRoot, "negative-prefix");
		for (const directory of [home, buildHome, negativeHome]) mkdirSync(directory, { mode: 0o700 });
		const previous = await buildCompiledReleaseFixture(scratchRoot, repoRoot, buildHome, "1.2.2", hostPlatform);
		const candidate = await buildCompiledReleaseFixture(scratchRoot, repoRoot, buildHome, "1.2.3", hostPlatform);
		const tokenConfig = join(scratchRoot, "gh-config-token");
		const configOnly = join(scratchRoot, "gh-config-only");
		mkdirSync(tokenConfig, { mode: 0o700 });
		mkdirSync(configOnly, { mode: 0o700 });
		writeFileSync(join(configOnly, "synthetic-gh-auth"), "test fixture only\n", { mode: 0o600, flag: "wx" });
		const ghBin = writeSyntheticGhVerifier(scratchRoot, repoRoot);
		const toolBin = join(scratchRoot, "test-tools");
		mkdirSync(toolBin, { mode: 0o700 });
		const python = Bun.which("python3");
		if (!python) throw new Error("python3 is required for the compiled updater regression");
		symlinkSync(python, join(toolBin, "python3"));
		symlinkSync(process.execPath, join(toolBin, "bun"));
		const launchctlStub = join(toolBin, "launchctl");
		writeFileSync(launchctlStub, "#!/bin/sh\nprintf '%s\\n' 'unexpected launchctl call in isolated updater test' >&2\nexit 97\n", { mode: 0o700, flag: "wx" });
		const path = [ghBin, toolBin, "/usr/bin", "/bin"].join(":");
		const installerEnv = {
			PATH: path, HOME: home, TMPDIR: scratchRoot,
			GH_TOKEN: "SYNTHETIC_GH_TOKEN_V66L21_NOT_A_CREDENTIAL",
			GITHUB_TOKEN: "SYNTHETIC_GITHUB_TOKEN_V66L21_NOT_A_CREDENTIAL",
			GH_CONFIG_DIR: tokenConfig,
		};
		const installer = await releaseProcess(["/bin/sh", join(repoRoot, "installer/install.sh"),
			"--version", previous.version, "--index", previous.indexPath, "--offline", previous.archivePath, "--prefix", prefix], { cwd: repoRoot, env: installerEnv, stdout: "pipe", stderr: "pipe", deadline_s: 120 });
		if (installer.exitCode !== 0) {
			throw new Error(`synthetic previous install failed (${installer.exitCode}): ${installer.stdout.toString()} ${installer.stderr.toString()}`);
		}

		const configOnlyEnv = { PATH: path, HOME: home, TMPDIR: scratchRoot, GH_CONFIG_DIR: configOnly };
		const configOnlyVerifier = await releaseProcess([python, "-I", "-c", readFileSync(join(repoRoot, "installer/install.py"), "utf8"),
			"attestation", candidate.archivePath, candidate.version, "unused"], { cwd: repoRoot, env: configOnlyEnv, stdout: "pipe", stderr: "pipe", deadline_s: 120 });
		expect(configOnlyVerifier.exitCode, configOnlyVerifier.stderr.toString()).toBe(0);
		const configOnlyReports = readFileSync(join(configOnly, "observed.ndjson"), "utf8").trim()
			.split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
		expect(configOnlyReports.length).toBeGreaterThan(0);
		expect(configOnlyReports.every(report => report.auth_mode === "config-only" &&
			report.gh_config_dir_scoped === true && report.unrelated_context_absent === true)).toBe(true);

		for (const name of Object.keys(KNOWN_JOBS))
			recordOptOut(home, `service:${name}`, "isolated updater test must not touch launchd");
		const updaterEnv = {
			PATH: path, HOME: home, TMPDIR: scratchRoot, CI: "1",
			GH_TOKEN: "SYNTHETIC_GH_TOKEN_V66L21_NOT_A_CREDENTIAL",
			GITHUB_TOKEN: "SYNTHETIC_GITHUB_TOKEN_V66L21_NOT_A_CREDENTIAL",
			GH_CONFIG_DIR: tokenConfig,
			GH_ENTERPRISE_TOKEN: "SYNTHETIC_UNRELATED_GH_TOKEN",
			PI_BRIDGE_SENTINEL: "SYNTHETIC_PI_BRIDGE_CONTEXT",
			MCP_PROVIDER_SENTINEL: "SYNTHETIC_MCP_PROVIDER_CONTEXT",
			OMP_KIT_TEST_WORK_ROOT: callerWorkRoot.path, OMP_KIT_CASE_CWD: repoRoot,
			OMP_KIT_TEST_LABEL_NAMESPACE: "com.omp-kit.test.compiled-update",
		};
		const stable = join(prefix, "bin", "omp-kit");
		const update = await releaseProcess([stable, "update", "--apply", "--yes", "--version", candidate.version,
			"--index", candidate.indexPath, "--archive", candidate.archivePath, "--json"], { cwd: home, env: updaterEnv, stdout: "pipe", stderr: "pipe", deadline_s: 120 });
		const updateStdout = update.stdout.toString();
		const updateStderr = update.stderr.toString();
		// OMP is deliberately absent, so this update stays PARTIAL before relink or manifest application.
		expect(update.exitCode).toBe(1);
		const updateEnvelope = JSON.parse(updateStdout) as {
			data: {
				action: string; active_version: string | null; postcheck: string; reason: string | null; receipt_id: string | null;
				postcheck_detail: { failed_stages: string[]; failures: string[] };
			};
		};
		expect(updateEnvelope.data).toMatchObject({
			action: "PARTIAL", active_version: candidate.version, postcheck: "FAIL",
		});
		expect(updateEnvelope.data.postcheck_detail.failed_stages).toContain("fast-test");
		expect(updateEnvelope.data.postcheck_detail.failed_stages).toContain("omp-version");
		expect(updateEnvelope.data.receipt_id).toBeTruthy();
		expect(updateEnvelope.data).not.toHaveProperty("plugin_relink");
		expect(updateEnvelope.data).not.toHaveProperty("manifest");
		expect(readlinkSync(stable)).toBe(`../releases/${candidate.version}/bin/omp-kit`);
		const version = await releaseProcess([stable, "--version"], { cwd: home, env: updaterEnv, stdout: "pipe", stderr: "pipe", deadline_s: 120 });
		expect(version.exitCode).toBe(0);
		expect(version.stdout.toString().trim()).toBe(`omp-kit ${candidate.version}`);
		const stateRoot = join(home, ".local", "state", "omp-kit");
		const pending = inspectPendingKitUpdate(stateRoot);
		expect(pending?.id).toBe(updateEnvelope.data.receipt_id);
		expect(auditMutations(stateRoot)).toEqual(expect.arrayContaining([
			expect.objectContaining({ scope: "kit", status: "PENDING" }),
		]));
		const tokenReports = readFileSync(join(tokenConfig, "observed.ndjson"), "utf8").trim()
			.split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
		expect(tokenReports.some(report => report.source_lookup === true && report.auth_mode === "tokens")).toBe(true);
		expect(tokenReports.some(report => report.bundle_verify === true && report.auth_mode === "tokens")).toBe(true);
		expect(tokenReports.every(report => report.gh_config_dir_scoped === true &&
			report.unrelated_context_absent === true)).toBe(true);

		const negativeInstall = await releaseProcess(["/bin/sh", join(repoRoot, "installer/install.sh"),
			"--version", previous.version, "--index", previous.indexPath, "--offline", previous.archivePath, "--prefix", negativePrefix], { cwd: repoRoot, env: installerEnv, stdout: "pipe", stderr: "pipe", deadline_s: 120 });
		if (negativeInstall.exitCode !== 0) {
			throw new Error(`synthetic negative previous install failed (${negativeInstall.exitCode}): ${negativeInstall.stdout.toString()} ${negativeInstall.stderr.toString()}`);
		}
		writeFileSync(join(configOnly, "reject-source"), "synthetic invalid authority\n", { mode: 0o600, flag: "wx" });
		const noTokenUpdaterEnv = {
			PATH: path, HOME: negativeHome, TMPDIR: scratchRoot, GH_CONFIG_DIR: configOnly,
			OMP_KIT_TEST_WORK_ROOT: callerWorkRoot.path, OMP_KIT_CASE_CWD: repoRoot,
		};
		const negativeStable = join(negativePrefix, "bin", "omp-kit");
		const refused = await releaseProcess([negativeStable, "update", "--apply", "--yes", "--version", candidate.version,
			"--index", candidate.indexPath, "--archive", candidate.archivePath, "--json"], { cwd: negativeHome, env: noTokenUpdaterEnv, stdout: "pipe", stderr: "pipe", deadline_s: 120 });
		expect(refused.exitCode).not.toBe(0);
		const refusal = JSON.parse(refused.stdout.toString()) as { errors?: { code?: string }[] };
		expect(refusal.errors?.[0]?.code).toBe("KIT_ATTESTATION_SOURCE_UNVERIFIED");
		expect(readlinkSync(negativeStable)).toBe(`../releases/${previous.version}/bin/omp-kit`);
		expect(existsSync(join(negativePrefix, "releases", candidate.version))).toBe(false);
		expect(inspectPendingKitUpdate(join(negativeHome, ".local", "state", "omp-kit"))).toBeNull();
		const configOnlyAfterRefusal = readFileSync(join(configOnly, "observed.ndjson"), "utf8").trim()
			.split("\n").filter(Boolean).map(line => JSON.parse(line) as Record<string, unknown>);
		expect(configOnlyAfterRefusal.some(report => report.source_lookup === true &&
			report.auth_mode === "config-only" && report.gh_config_dir_scoped === true)).toBe(true);
		const ompPath = Bun.which("omp");
		if (!ompPath) throw new Error("omp is required for the successful compiled updater regression");
		for (const name of Object.keys(KNOWN_JOBS))
			recordOptOut(negativeHome, `service:${name}`, "isolated updater test must not touch launchd");
		mkdirSync(join(negativeHome, ".omp"), { recursive: true, mode: 0o700 });
		writeFileSync(join(negativeHome, ".omp", "marketplaces.json"), "{}\n");
		for (const profile of RECONCILE_PROFILES) {
			const agent = profile === "default"
				? join(negativeHome, ".omp", "agent")
				: join(negativeHome, ".omp", "profiles", profile, "agent");
			mkdirSync(agent, { recursive: true, mode: 0o700 });
			writeFileSync(join(agent, "config.yml"), "ttsr:\n  disabledRules: []\n");
			const pluginDir = profile === "default"
				? join(negativeHome, ".omp", "plugins")
				: join(negativeHome, ".omp", "profiles", profile, "plugins");
			const link = reconcilePluginLink(negativeHome, profile);
			mkdirSync(dirname(link), { recursive: true, mode: 0o700 });
			symlinkSync(join(negativePrefix, "releases", previous.version), link);
			writeFileSync(join(pluginDir, "omp-plugins.lock.json"), JSON.stringify({
				plugins: { "omp-kit-companion": { version: previous.version, enabled: true } }, settings: {},
			}));
			writeFileSync(join(pluginDir, "installed_plugins.json"), "{}");
			writeFileSync(join(pluginDir, "package.json"), JSON.stringify({
				name: "omp-plugins", private: true,
				dependencies: { "omp-kit-companion": `github:JYeswak/omp-kit-companion#v${previous.version}` },
			}));
		}
		const successPath = [ghBin, toolBin, dirname(ompPath), "/usr/bin", "/bin"].join(":");
		const successEnv = { ...updaterEnv, PATH: successPath, HOME: negativeHome };
		const liveOutput: string[] = [];
		if (mode === "success") {
		const success = await runBounded([negativeStable, "update", "--apply", "--yes", "--version", candidate.version,
			"--index", candidate.indexPath, "--archive", candidate.archivePath, "--json"], {
			deadline_s: 900, cwd: negativeHome, env: successEnv,
		});
		const successStdout = Buffer.from(success.stdout).toString("utf8");
		const successStderr = Buffer.from(success.stderr).toString("utf8");
		const successEnvelope = JSON.parse(successStdout) as {
			data: {
				action: string; active_version: string | null; postcheck: string; reason?: string | null;
				postcheck_detail?: { failed_stages?: string[]; failures?: string[] };
				plugin_relink: string; plugin_relink_detail?: string;
				manifest: { status: string; rules_applied: number; extensions_applied: number; skipped: { item: string }[]; failed: { item: string; detail: string }[] };
			};
			errors?: { code?: string }[];
		};
		const failureSummary = JSON.stringify({
			action: successEnvelope.data?.action, reason: successEnvelope.data?.reason,
			postcheck: successEnvelope.data?.postcheck, postcheck_detail: successEnvelope.data?.postcheck_detail,
			plugin_relink: successEnvelope.data?.plugin_relink, plugin_relink_detail: successEnvelope.data?.plugin_relink_detail,
			manifest_failed: successEnvelope.data?.manifest?.failed,
			error_codes: successEnvelope.errors?.map(error => error.code),
		});
		expect(success.timed_out, failureSummary).toBe(false);
		expect(success.rc, failureSummary).toBe(0);
		expect(successEnvelope.data).toMatchObject({
			action: "UPDATED", active_version: candidate.version, postcheck: "PASS", plugin_relink: "APPLIED",
		});
		expect(successEnvelope.data.manifest.status).toBe("APPLIED");
		expect(successEnvelope.data.manifest.rules_applied).toBeGreaterThan(0);
		expect(successEnvelope.data.manifest.extensions_applied).toBeGreaterThan(0);
		expect(successEnvelope.data.manifest.failed).toEqual([]);
		expect(successEnvelope.data.manifest.skipped.filter(row => row.item.startsWith("service:")))
			.toHaveLength(Object.keys(KNOWN_JOBS).length);
		for (const profile of RECONCILE_PROFILES)
			expect(realpathSync(reconcilePluginLink(negativeHome, profile)))
				.toBe(realpathSync(join(negativePrefix, "releases", candidate.version)));
		expect(readlinkSync(negativeStable)).toBe(`../releases/${candidate.version}/bin/omp-kit`);
		liveOutput.push(successStdout, successStderr);
		} else {
		const failureCandidate = await buildCompiledReleaseFixture(scratchRoot, repoRoot, buildHome, "1.2.4", hostPlatform);
		const dualProfile = join(negativeHome, ".omp", "profiles", "relink-negative", "agent");
		mkdirSync(dualProfile, { recursive: true, mode: 0o700 });
		writeFileSync(join(dualProfile, "config.yml"), "ttsr:\n  disabledRules: []\n");
		writeFileSync(join(dualProfile, "config.yaml"), "ttsr:\n  disabledRules: []\n");
		const relinkFailure = await runBounded([negativeStable, "update", "--apply", "--yes", "--version", failureCandidate.version,
			"--index", failureCandidate.indexPath, "--archive", failureCandidate.archivePath, "--json"], {
			deadline_s: 900, cwd: negativeHome, env: successEnv,
		});
		const relinkFailureStdout = Buffer.from(relinkFailure.stdout).toString("utf8");
		const relinkFailureSummary = JSON.stringify({ rc: relinkFailure.rc, timed_out: relinkFailure.timed_out,
			stdout: relinkFailureStdout, stderr: Buffer.from(relinkFailure.stderr).toString("utf8") });
		const relinkFailureEnvelope = JSON.parse(relinkFailureStdout) as {
			data: { overall: string; plugin_relink: string; manifest: unknown };
			errors?: { code?: string }[];
		};
		expect(relinkFailure.timed_out, relinkFailureSummary).toBe(false);
		expect(relinkFailure.rc, relinkFailureSummary).not.toBe(0);
		expect(relinkFailureEnvelope.data).toMatchObject({
			overall: "FINDINGS", plugin_relink: "FAILED", manifest: null,
		});
		expect(relinkFailureEnvelope.data.overall).not.toBe("UPDATED");
		expect(relinkFailureEnvelope.errors?.map(error => error.code)).toContain("PLUGIN_RELINK_FAILED");
		liveOutput.push(relinkFailureStdout, Buffer.from(relinkFailure.stderr).toString("utf8"));
		}

		const visible = [installer.stdout.toString(), installer.stderr.toString(), configOnlyVerifier.stdout.toString(),
			configOnlyVerifier.stderr.toString(), updateStdout, updateStderr, ...liveOutput,
			version.stdout.toString(), version.stderr.toString(), negativeInstall.stdout.toString(), negativeInstall.stderr.toString(),
			refused.stdout.toString(), refused.stderr.toString(), JSON.stringify(auditMutations(stateRoot)),
			readFileSync(join(tokenConfig, "observed.ndjson"), "utf8"), readFileSync(join(configOnly, "observed.ndjson"), "utf8")].join("\n");
		for (const sentinel of ["SYNTHETIC_GH_TOKEN_V66L21_NOT_A_CREDENTIAL",
			"SYNTHETIC_GITHUB_TOKEN_V66L21_NOT_A_CREDENTIAL", "SYNTHETIC_UNRELATED_GH_TOKEN",
			"SYNTHETIC_PI_BRIDGE_CONTEXT", "SYNTHETIC_MCP_PROVIDER_CONTEXT"])
			expect(visible).not.toContain(sentinel);
		callerWorkRoot.cleanup();
		scratchOwned.cleanup();
}
