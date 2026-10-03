import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, cpSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import process from "node:process";
import { writeReleaseManifest } from "./release-manifest-fixture.ts";
import { resolveOmpIdentity } from "../../src/paths.ts";

const OMP_IDENTITY = resolveOmpIdentity();

const REPO_ROOT = resolve(import.meta.dir, "../..");
const FOOTER_START = "<!-- verified-ttsr-docs:start -->";
const FOOTER_END = "<!-- verified-ttsr-docs:end -->";
const VERSION_OUTSIDE_FOOTER = /\b1[89]\.\d+\.\d+\b/;

interface VerifiedBlock {
	index: number;
	expectedExit: number;
	expectedFragment: string;
	fromStderr: boolean;
	body: string;
	firstLine: string;
}

function extractVerifiedBlocks(markdown: string, file: string): VerifiedBlock[] {
	const pattern = /```sh verified([^\n]*)\n([\s\S]*?)```/g;
	const blocks: VerifiedBlock[] = [];
	let match: RegExpExecArray | null;
	let index = 0;
	while ((match = pattern.exec(markdown)) !== null) {
		index += 1;
		const meta = match[1] ?? "";
		const body = (match[2] ?? "").trim();
		const exit = /rc=(\d+)/.exec(meta);
		const fragment = /contains="([^"]*)"|contains='([^']*)'/.exec(meta);
		const errFragment = /contains_err="([^"]*)"|contains_err='([^']*)'/.exec(meta);
		const chosen = fragment ?? errFragment;
		if (!exit || !chosen || body.length === 0) {
			throw new Error(`${file} block ${index} is missing rc, contains/contains_err, or a body; every verified fence needs all three`);
		}
		blocks.push({
			index,
			expectedExit: Number(exit[1]),
			expectedFragment: chosen[1] ?? chosen[2] ?? "",
			fromStderr: !fragment,
			body,
			firstLine: body.split("\n", 1)[0] ?? "",
		});
	}
	if (blocks.length === 0) throw new Error(`${file} has no verified blocks; the docs check must have something to run`);
	return blocks;
}

let fixtureBase = "";
let stableKit = "";

function stageRelease(): string {
	const prefix = join(fixtureBase, "kit");
	const root = join(prefix, "releases", "vDocsTest");
	mkdirSync(join(root, "bin"), { recursive: true });
	for (const directory of ["rules", "retired", "cases", "policy", "extensions", "examples"]) {
		cpSync(join(REPO_ROOT, directory), join(root, directory), { recursive: true });
	}
	mkdirSync(join(root, "scripts"), { recursive: true });
	for (const file of ["ttsr-harness.ts", "rule-class.ts", "context-inventory.ts"]) {
		writeFileSync(join(root, "scripts", file), readFileSync(join(REPO_ROOT, "scripts", file)));
	}
	const manifest = Bun.spawnSync(["sh", join(REPO_ROOT, "scripts/build-manifest.sh"), "--stdout"], {
		cwd: REPO_ROOT, stdout: "pipe", stderr: "pipe",
	});
	if (manifest.exitCode !== 0) {
		throw new Error("docs fixture manifest failed (" + manifest.exitCode + "): " + manifest.stdout.toString() + manifest.stderr.toString());
	}
	writeFileSync(join(root, "MANIFEST.tsv"), manifest.stdout);
	const executable = join(root, "bin", "omp-kit");
	const build = Bun.spawnSync([process.execPath, "build", join(REPO_ROOT, "src/cli.ts"),
		"--compile", "--no-compile-autoload-dotenv", "--no-compile-autoload-bunfig", "--no-compile-autoload-tsconfig",
		`--outfile=${executable}`,
	], { stdout: "pipe", stderr: "pipe" });
	if (build.exitCode !== 0) {
		throw new Error(`docs fixture CLI failed to compile (${build.exitCode}): ${build.stdout.toString()}${build.stderr.toString()}`);
	}
	chmodSync(executable, 0o755);
	writeReleaseManifest(root);
	const stable = join(prefix, "bin", "omp-kit");
	mkdirSync(dirname(stable), { recursive: true });
	symlinkSync(executable, stable);
	return stable;
}

beforeAll(() => {
	// The kit refuses receipt state under /tmp, so stage under the repo's own
	// scratch root instead of the OS temp directory.
	fixtureBase = join(REPO_ROOT, "var", "agent-tmp", `docs-check-${process.pid}-${Date.now()}`);
	mkdirSync(fixtureBase, { recursive: true });
	stableKit = stageRelease();
}, 120_000);

afterAll(() => {
	if (fixtureBase) rmSync(fixtureBase, { recursive: true, force: true });
});

function isolatedEnv(home: string, kit: string): Record<string, string> {
	mkdirSync(home, { recursive: true });
	const agentMailRoot = process.env.AGENT_MAIL_STORAGE_ROOT ?? join(process.env.HOME ?? home, ".local", "share", "mcp-agent-mail-rust-live");
	mkdirSync(agentMailRoot, { recursive: true });
	return {
		HOME: home,
		TMPDIR: join(home, "tmp"),
		XDG_CONFIG_HOME: join(home, "config"),
		XDG_CACHE_HOME: join(home, "cache"),
		XDG_DATA_HOME: join(home, "data"),
		XDG_STATE_HOME: join(home, "state"),
		AGENT_MAIL_STORAGE_ROOT: agentMailRoot,
		OMP: OMP_IDENTITY.launcher,
		OMP_BIN: OMP_IDENTITY.launcher,
		OMP_PATH: OMP_IDENTITY.launcher,
		OMP_SRC: OMP_IDENTITY.source,
		PATH: dirname(kit) + ":" + dirname(OMP_IDENTITY.launcher) + ":" + (process.env.PATH ?? "/usr/bin:/bin"),
		KIT: kit,
		WT: REPO_ROOT,
	};
}

function runVerifiedBlocks(file: string, markdown: string, home: string): { blocks: number } {
	const blocks = extractVerifiedBlocks(markdown, file);
	for (const key of ["tmp", "config", "cache", "data", "state"] as const) mkdirSync(join(home, key), { recursive: true });
	for (const block of blocks) {
		const child = Bun.spawnSync(["sh", "-c", block.body], {
			cwd: REPO_ROOT,
			env: isolatedEnv(home, stableKit),
			stdout: "pipe",
			stderr: "pipe",
		});
		const stdout = child.stdout.toString();
		const stderr = child.stderr.toString();
		const haystack = block.fromStderr ? stderr : stdout;
		if (child.exitCode !== block.expectedExit || !haystack.includes(block.expectedFragment)) {
			throw new Error(
				`${file} block ${block.index} (${block.firstLine}) failed: ` +
				`expected rc=${block.expectedExit} with ${JSON.stringify(block.expectedFragment)} ` +
				`in ${block.fromStderr ? "stderr" : "stdout"}, ` +
				`observed rc=${child.exitCode} stdout=${JSON.stringify(stdout.slice(0, 2000))} stderr=${JSON.stringify(stderr.slice(0, 1000))}`,
			);
		}
	}
	return { blocks: blocks.length };
}

test("docs: every verified block in the native-OMP guide passes on this OMP", () => {
	const file = "docs/native-omp.md";
	const markdown = readFileSync(join(REPO_ROOT, file), "utf8");
	const { blocks } = runVerifiedBlocks(file, markdown, join(fixtureBase, "native-home"));
	expect(blocks).toBeGreaterThan(5);
}, 600_000);

test("docs: every verified block in the README passes on this OMP", () => {
	const file = "README.md";
	const markdown = readFileSync(join(REPO_ROOT, file), "utf8");
	const { blocks } = runVerifiedBlocks(file, markdown, join(fixtureBase, "readme-home"));
	expect(blocks).toBeGreaterThan(0);
}, 600_000);

test("docs: every verified block in the usage guide passes on this OMP", () => {
	const file = "docs/usage.md";
	const markdown = readFileSync(join(REPO_ROOT, file), "utf8");
	const { blocks } = runVerifiedBlocks(file, markdown, join(fixtureBase, "usage-home"));
	expect(blocks).toBeGreaterThan(0);
}, 600_000);

test("docs: README and native guide footers use the shared OMP minimum", () => {
	const compat = JSON.parse(readFileSync(join(REPO_ROOT, "scripts/omp-compat.json"), "utf8")) as { minimum?: unknown };
	if (typeof compat.minimum !== "string" || !/^\d+\.\d+\.\d+$/.test(compat.minimum)) {
		throw new Error("scripts/omp-compat.json must contain a stable minimum OMP version");
	}
	for (const file of ["README.md", "docs/native-omp.md"]) {
		const markdown = readFileSync(join(REPO_ROOT, file), "utf8");
		const start = markdown.indexOf(FOOTER_START);
		const end = markdown.indexOf(FOOTER_END);
		expect(start, file + " is missing the generated footer start marker").toBeGreaterThan(-1);
		expect(end, file + " is missing the generated footer end marker").toBeGreaterThan(start);
		const footer = markdown.slice(start, end + FOOTER_END.length);
		expect(footer).toContain("Minimum supported OMP: " + compat.minimum + ".");
		const outside = markdown.slice(0, start) + markdown.slice(end + FOOTER_END.length);
		const found = VERSION_OUTSIDE_FOOTER.exec(outside);
		expect(found, found ? file + " has a hand-typed OMP version outside the generated footer: " + found[0] : "clean").toBeNull();
	}
});

test("docs: footer generator reads omp-compat.json for both documents", () => {
	const root = join(fixtureBase, "footer-generation");
	const scripts = join(root, "scripts");
	const docs = join(root, "docs");
	const bin = join(root, "bin");
	mkdirSync(scripts, { recursive: true });
	mkdirSync(docs, { recursive: true });
	mkdirSync(bin, { recursive: true });
	writeFileSync(join(scripts, "docs-footer.sh"), readFileSync(join(REPO_ROOT, "scripts/docs-footer.sh")));
	writeFileSync(join(scripts, "omp-compat.json"), JSON.stringify({ minimum: "19.7.3" }));
	const staleFooter = FOOTER_START + "\nOld footer\n" + FOOTER_END + "\n";
	writeFileSync(join(root, "README.md"), "# Fixture README\n\n" + staleFooter);
	writeFileSync(join(docs, "native-omp.md"), "# Fixture guide\n\n" + staleFooter);
	const omp = join(bin, "omp");
	writeFileSync(omp, "#!/bin/sh\nprintf omp/19.7.5\n");
	chmodSync(omp, 0o755);
	const child = Bun.spawnSync(["sh", join(scripts, "docs-footer.sh")], {
		cwd: root,
		env: { ...process.env, PATH: bin + ":" + (process.env.PATH ?? "/usr/bin:/bin") },
		stdout: "pipe",
		stderr: "pipe",
	});
	const stdout = child.stdout.toString();
	const stderr = child.stderr.toString();
	expect(child.exitCode, stdout + stderr).toBe(0);
	for (const file of ["README.md", "docs/native-omp.md"]) {
		const markdown = readFileSync(join(root, file), "utf8");
		const start = markdown.indexOf(FOOTER_START);
		const end = markdown.indexOf(FOOTER_END);
		const footer = markdown.slice(start, end + FOOTER_END.length);
		expect(footer).toContain("Minimum supported OMP: 19.7.3.");
		expect(footer).toContain("Last verified against OMP 19.7.5");
	}
});

test("docs: a bad flag in a verified block fails loudly and names the block", () => {
	const markdown = [
		"```sh verified rc=0 contains=\"TTSR rules\"",
		"omp ttsr list --bogus-docs-flag",
		"```",
	].join("\n");
	let message = "";
	try {
		runVerifiedBlocks("docs-negative-fixture", markdown, join(fixtureBase, "negative-home"));
	} catch (error) {
		message = error instanceof Error ? error.message : String(error);
	}
	expect(message).toContain("docs-negative-fixture block 1");
	expect(message).toContain("omp ttsr list --bogus-docs-flag");
});
