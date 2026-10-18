import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

// One entrypoint for ordinary stock CI and its explicitly requested negative control.
const repo = realpathSync(join(dirname(fileURLToPath(import.meta.url)), ".."));
const args = process.argv.slice(2);
const negativeModes = ["--plant-assertion", "--restore-unconditional-flags"];
if (args.length > 1 || (args.length === 1 && !negativeModes.includes(args[0]!))) {
	throw new Error("Usage: bun scripts/test-stock-extensions.ts [--plant-assertion | --restore-unconditional-flags]");
}
const plantAssertion = args[0] === "--plant-assertion";
const restoreUnconditionalFlags = args[0] === "--restore-unconditional-flags";
if (plantAssertion || restoreUnconditionalFlags) {
	const workspace = process.env.GITHUB_WORKSPACE;
	if (process.env.GITHUB_ACTIONS !== "true" || !workspace || realpathSync(workspace) !== repo) {
		throw new Error(`${args[0]} is restricted to this repository's ephemeral GitHub Actions workspace`);
	}
}

// Resolve real executables before replacing PATH. No package install or fleet tool is needed.
const executables = new Map<string, string>([["bun", realpathSync(process.execPath)]]);
for (const name of ["git", "sh", "bash", "env"]) {
	const executable = Bun.which(name);
	if (!executable) throw new Error(`Required stock executable is unavailable: ${name}`);
	executables.set(name, realpathSync(executable));
}
const scratchParent = join(repo, "var", "agent-tmp");
mkdirSync(scratchParent, { recursive: true });
const scratch = mkdtempSync(join(scratchParent, `stock-extensions.${process.pid}.`));
writeFileSync(join(scratch, ".owner"), `pid=${process.pid}\nlabel=stock-extensions\nrepo=${repo}\ncreated=${new Date().toISOString()}\n`);
const bin = join(scratch, "bin");
const home = join(scratch, "home");
const tmp = join(scratch, "tmp");
const env: Record<string, string> = {
	PATH: bin,
	HOME: home,
	TMPDIR: tmp,
	TMP: tmp,
	TEMP: tmp,
	XDG_CONFIG_HOME: join(home, ".config"),
	XDG_CACHE_HOME: join(home, ".cache"),
	XDG_DATA_HOME: join(home, ".local", "share"),
	XDG_STATE_HOME: join(home, ".local", "state"),
	XDG_RUNTIME_DIR: join(scratch, "run"),
	LANG: "C.UTF-8",
	TZ: "UTC",
	NO_COLOR: "1",
	GIT_CONFIG_NOSYSTEM: "1",
	GIT_CONFIG_GLOBAL: "/dev/null",
	GIT_TERMINAL_PROMPT: "0",
};
for (const directory of [bin, home, tmp, env.XDG_CONFIG_HOME, env.XDG_CACHE_HOME, env.XDG_DATA_HOME, env.XDG_STATE_HOME, env.XDG_RUNTIME_DIR]) {
	mkdirSync(directory, { recursive: true, mode: 0o700 });
}
for (const [name, executable] of executables) symlinkSync(executable, join(bin, name));

// Assert against the exact PATH passed to the real test process, not the caller's PATH.
for (const name of ["br", "am", "ntm", "tmux"]) {
	const resolved = Bun.which(name, { PATH: env.PATH });
	console.log(`stock-extensions: Bun.which(${JSON.stringify(name)}) = ${JSON.stringify(resolved)}`);
	if (resolved !== null) throw new Error(`Stock PATH unexpectedly exposes ${name}`);
}
console.log(`stock-extensions: isolated HOME/TMPDIR/XDG/PATH; retained scratch ${scratch}`);
if (plantAssertion) {
	console.log("stock-extensions: NEGATIVE CONTROL changes actual extensions/kit-callback.test.ts bytes; this is NOT ordinary source qualification");
	appendFileSync(join(repo, "extensions", "kit-callback.test.ts"), '\n\ntest("STOCK_EXTENSION_NEGATIVE_CONTROL intentionally failing callback assertion", () => {\n\texpect("planted callback failure").toBe("ordinary source qualification");\n});\n');
}
if (restoreUnconditionalFlags) {
	const path = join(repo, "extensions", "kit-flywheel-guard.ts");
	let source = readFileSync(path, "utf8");
	for (const [before, after] of [
		["pendingReread.beadOk = !trackerRereadApplies(ctx.cwd, env);", "pendingReread.beadOk = false;"],
		["pendingReread.agentsOk = pendingReread.agentsPath === null;", "pendingReread.agentsOk = false;"],
	]) {
		const at = source.indexOf(before!);
		if (at < 0 || at !== source.lastIndexOf(before!)) {
			throw new Error(`Compaction mutant injection failed: expected one ${JSON.stringify(before)}`);
		}
		source = source.replace(before!, after!);
	}
	writeFileSync(path, source);
	console.log("stock-extensions: NEGATIVE CONTROL restored unconditional agentsOk=false/beadOk=false in actual kit-flywheel-guard.ts; this is NOT ordinary source qualification");
}

// Do not inherit credentials, pane/fleet settings, Bun options, or dotenv contents.
// Repository bunfig.toml still supplies the canonical test preload and timeout.
const child = Bun.spawn([join(bin, "bun"), "--no-env-file", "test", "./extensions"], {
	cwd: repo,
	env,
	stdin: "inherit",
	stdout: "inherit",
	stderr: "inherit",
});
process.exit(await child.exited);
