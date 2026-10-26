import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { afterAll, expect, test } from "bun:test";
import { rmSync } from "node:fs";
import { join } from "node:path";
import { BEAD_LINT_REFUSED, BEAD_LINT_SCRIPTS_DIR, BEAD_LINT_UNEVALUABLE, BEAD_LINT_UNVERIFIED, checkBeadLint, type FlywheelExecResult } from "../../extensions/kit-flywheel-guard";
import { createFlywheelHost, toolCall, type Responder } from "./kit-flywheel-host";

// LINTEVERY1 (ompkit-nskhp): bead-lint admission at the tool-call layer. A real
// native br tracker, the real shipped python helpers, the real guard handler.

const base = ownedTmp("kit-flywheel-bead-lint").path;
afterAll(() => rmSync(base, { recursive: true, force: true }));

const PLANTED = `br create "x" -t task --acceptance "- [ ] AC1: x"`;
const CLEAN_DESCRIPTION = "WHAT: refuse an unlinted create.\n\nWHY: ungradeable beads were created unchecked.";
/** Phase-tagged (ACPHASE1): beads created at or after the cutover must tag every item. */
const CLEAN_ACCEPTANCE = "- [ ] [build] AC1: planted negative: an unlinted create is refused";
/** The heredoc form agents use for multi-line descriptions; the guard reads its body literally. */
const clean = (title: string) => `br create '${title}' -t task -l admission --description "$(cat <<'EOF'\n${CLEAN_DESCRIPTION}\nEOF\n)" --acceptance '${CLEAN_ACCEPTANCE}'`;

function tracker() {
	const project = ownedTmp("tracker", { root: base }).path;
	const db = join(project, ".beads", "beads.db");
	const env = { ...process.env, HOME: project };
	const run = (args: string[]): FlywheelExecResult => {
		const result = Bun.spawnSync(["br", ...args, "--db", db, "--actor", "LintFixture", "--json"], {
			cwd: project, env, stdout: "pipe", stderr: "pipe", timeout: 20_000,
		});
		return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
	};
	const init = run(["init", "--prefix", "lg"]);
	if (init.code !== 0) throw new Error(init.stdout + init.stderr);
	const count = (): number => {
		const listed = run(["list", "--status", "all", "--limit", "0"]);
		if (listed.code !== 0) throw new Error(listed.stdout + listed.stderr);
		const value: unknown = JSON.parse(listed.stdout);
		const rows = Array.isArray(value) ? value : value !== null && typeof value === "object" && "issues" in value && Array.isArray(value.issues) ? value.issues : null;
		if (rows === null) throw new Error(`unexpected br list envelope: ${listed.stdout.slice(0, 200)}`);
		return rows.length;
	};
	const create = (args: string[]): string => {
		const result = run(["create", ...args]);
		if (result.code !== 0) throw new Error(result.stdout + result.stderr);
		const value: unknown = JSON.parse(result.stdout);
		if (value === null || typeof value !== "object" || !("id" in value) || typeof value.id !== "string") throw new Error("native create has no id");
		return value.id;
	};
	/** Real execution of whatever the guard asks to run, in the tracker's HOME. */
	const respond: Responder = call => {
		const result = Bun.spawnSync([call.command, ...call.args], {
			cwd: call.options?.cwd ?? project, env, stdout: "pipe", stderr: "pipe", timeout: call.options?.timeout ?? 20_000,
		});
		return { code: result.exitCode, stdout: result.stdout.toString(), stderr: result.stderr.toString() };
	};
	const exec = async (command: string, args: string[], options?: { cwd?: string; timeout?: number }) => respond({ command, args, options });
	return { project, db, run, count, create, respond, exec };
}

const lintExecs = (execs: { command: string; args: string[] }[]) => execs.filter(call => call.command === "env" && call.args.some(arg => arg.endsWith("-lint.py")));

test("LINTEVERY1 AC1 planted: an unlinted br create tool call is refused naming the failing checks, and nothing is created", async () => {
	const t = tracker();
	const h = await createFlywheelHost(base, { respond: t.respond });
	const before = t.count();
	const result = await toolCall(h, t.project, PLANTED);
	expect(result?.block).toBe(true);
	expect(result?.reason).toContain(BEAD_LINT_REFUSED);
	for (const check of ["a-label", "b-what-why-acc", "d-negative-specimen"]) expect(result?.reason).toContain(check);
	expect(result?.reason).toContain("`WHAT:` and `WHY:`");
	expect(result?.reason).toContain("Template: write a file");
	expect(lintExecs(h.execs).map(call => call.args.slice(-8))).toEqual([["python3", join(BEAD_LINT_SCRIPTS_DIR, "br-create-lint.py"), "create", "x", "-t", "task", "--acceptance", "- [ ] AC1: x"]]);
	expect(t.count()).toBe(before);
});

test("LINTEVERY1 AC1 control: a lint-clean br create is admitted, and natively creates", async () => {
	const t = tracker();
	const h = await createFlywheelHost(base, { respond: t.respond });
	const command = clean("Gate refuses unlinted create");
	const result = await toolCall(h, t.project, command);
	expect(result?.block).not.toBe(true);
	expect(h.notices).toEqual([]);
	expect(lintExecs(h.execs)).toHaveLength(1);
	const ran = t.respond({ command: "sh", args: ["-c", `${command} --db '${t.db}' --actor LintFixture`], options: { cwd: t.project } });
	expect(ran.code).toBe(0);
	expect(t.count()).toBe(1);
});

test("LINTEVERY1: wrapped, cd-prefixed and global-flag creates are refused too", async () => {
	const t = tracker();
	const h = await createFlywheelHost(base, { respond: t.respond });
	for (const command of [
		`cd '${t.project}' && ${PLANTED}`,
		`cd '${t.project}' && sh -c "br create x -t task --acceptance '- [ ] AC1: x'"`,
		`BR_ACTOR=Someone br --db '${t.db}' create "x" -t task --acceptance "- [ ] AC1: x"`,
		`br create --title=x --type=task --acceptance="- [ ] AC1: x" --db='${t.db}'`,
	]) {
		const result = await toolCall(h, base, command);
		expect({ command, block: result?.block, named: result?.reason?.includes("b-what-why-acc") }).toEqual({ command, block: true, named: true });
	}
	expect(t.count()).toBe(0);
});

test("LINTEVERY1: a lint-read value the shell expands at run time is refused UNEVALUABLE, never admitted unlinted", async () => {
	const t = tracker();
	const h = await createFlywheelHost(base, { respond: t.respond });
	for (const command of [
		`br create "x" -t task -l a --description "$DESC" --acceptance '${CLEAN_ACCEPTANCE}'`,
		`br create "x" -t task -l a --description "$(cat desc.md)" --acceptance '${CLEAN_ACCEPTANCE}'`,
		`br create "x" -t task -l a --description $'WHAT: a\\n\\nWHY: b' --acceptance '${CLEAN_ACCEPTANCE}'`,
		"br create \"x\" -t task -l a --description `cat desc.md` --acceptance 'x'",
		`br create "x" -t task -l "$LABEL" --description 'WHAT: a WHY: b' --acceptance '${CLEAN_ACCEPTANCE}'`,
		`cat desc.md | br create "x" -t task -l a --description-file - --acceptance '${CLEAN_ACCEPTANCE}'`,
		`br create "x" -t task -l a --description "$(cat <<EOF\nWHAT: $HOME\nEOF\n)" --acceptance '${CLEAN_ACCEPTANCE}'`,
		`br update lg-1 --description "\${D}"`,
	]) {
		const result = await toolCall(h, t.project, command);
		expect({ command, block: result?.block, code: result?.reason?.includes(BEAD_LINT_UNEVALUABLE) }).toEqual({ command, block: true, code: true });
	}
	expect(lintExecs(h.execs)).toEqual([]);
	const literalElsewhere = await toolCall(h, t.project, `${clean("Gate admits literal content")} --actor "$AGENT_NAME"`);
	expect(literalElsewhere?.block).not.toBe(true);
	const dollarDigits = await toolCall(h, t.project, `br create "Fee gate" -t task -l a --description 'WHAT: charge $5. WHY: cost.' --acceptance '${CLEAN_ACCEPTANCE}'`);
	expect(dollarDigits?.block).not.toBe(true);
	expect(t.count()).toBe(0);
});

test("LINTEVERY1: content-changing br update is gated; workflow-only updates spawn no helper", async () => {
	const t = tracker();
	const id = t.create(["Gate refuses unlinted update", "-t", "task", "-l", "admission", "--description", CLEAN_DESCRIPTION, "--acceptance", CLEAN_ACCEPTANCE]);
	const h = await createFlywheelHost(base, { respond: t.respond });
	const stripped = await toolCall(h, t.project, `br update ${id} --description "no sections at all"`);
	expect(stripped?.block).toBe(true);
	expect(stripped?.reason).toContain("b-what-why-acc");
	const flagFirst = await toolCall(h, t.project, `br --actor Someone update --db '${t.db}' ${id} --description "no sections"`);
	expect(flagFirst?.block).toBe(true);
	expect(flagFirst?.reason).toContain("b-what-why-acc");
	const kept = await toolCall(h, t.project, `br update ${id} --title "Gate refuses unlinted update, renamed"`);
	expect(kept?.block).not.toBe(true);
	const spawned = lintExecs(h.execs).length;
	for (const workflow of [`br update ${id} --notes close`, `br update ${id} --priority 1`, `br update ${id} --status open`, `br show ${id}`, `br update ${id} --help`]) {
		await toolCall(h, t.project, workflow);
	}
	expect(lintExecs(h.execs)).toHaveLength(spawned);
	const shown: unknown = JSON.parse(t.run(["show", id]).stdout);
	expect(shown).toEqual([expect.objectContaining({ id, description: CLEAN_DESCRIPTION })]);
});

test("LINTEVERY1: the guard's update trigger covers every flag br-update-lint.py lints (superset parity)", async () => {
	const forms = [
		["--title", "t"], ["-d", "x"], ["--description", "x"], ["--body", "x"], ["--description-file", "f"],
		["--acceptance-criteria", "x"], ["--acceptance", "x"], ["--add-acceptance", "x"], ["--set-labels", "a"],
		["--add-label", "a"], ["--remove-label", "a"], ["-t", "bug"], ["--type", "bug"], ["--status", "in_review"],
		["--title=t"], ["-tbug"], ["--status=in_review"], ["--status", "open"], ["--priority", "1"], ["--claim"],
		["--status", "in_progress"], ["-s", "in_progress"], ["-sin_progress"], ["--status=in_progress"], ["-s", "in_review"],
		["--assignee", "x"], ["--notes", "x"], ["--owner", "o"], ["--parent", "p"],
	];
	const program = [
		"import importlib.util, json, sys",
		`spec = importlib.util.spec_from_file_location("ul", ${JSON.stringify(join(BEAD_LINT_SCRIPTS_DIR, "br-update-lint.py"))})`,
		"ul = importlib.util.module_from_spec(spec); spec.loader.exec_module(ul)",
		"print(json.dumps([ul.has_content_flags(ul.parse_update(['update', 'k-1', *form])) for form in json.loads(sys.argv[1])]))",
	].join("\n");
	const python = Bun.spawnSync(["python3", "-c", program, JSON.stringify(forms)], { stdout: "pipe", stderr: "pipe", cwd: BEAD_LINT_SCRIPTS_DIR });
	expect(python.stderr.toString()).toBe("");
	const helperSays = JSON.parse(python.stdout.toString()) as boolean[];
	expect(helperSays.filter(Boolean).length).toBeGreaterThanOrEqual(17);
	for (const [index, form] of forms.entries()) {
		const calls: string[][] = [];
		await checkBeadLint({ toolName: "bash", input: { command: `br update k-1 ${form.map(word => `'${word}'`).join(" ")}` } },
			{ exec: async (_command, args) => { calls.push(args); return { code: 0, stdout: "" }; }, home: base, sessionCwd: base });
		if (helperSays[index]) expect({ form, guardSpawned: calls.length }).toEqual({ form, guardSpawned: 1 });
	}
});

test("CLAIMLINT: a claim on a failing bead is refused in every spelling and for any failing id; a passing bead is admitted", async () => {
	const t = tracker();
	const failing = t.create(["Unlinted claim target", "-t", "task", "-l", "admission", "--description", "no sections at all", "--acceptance", CLEAN_ACCEPTANCE]);
	const passing = t.create(["Linted claim target", "-t", "task", "-l", "admission", "--description", CLEAN_DESCRIPTION, "--acceptance", CLEAN_ACCEPTANCE]);
	const deps = { exec: t.exec, home: base, sessionCwd: t.project };
	for (const move of ["--claim", "--status in_progress", "-s in_progress", "--status=in_progress", "-sin_progress"]) {
		const refused = await checkBeadLint({ toolName: "bash", input: { command: `br update ${failing} ${move}` } }, deps);
		expect({ move, block: refused?.block }).toEqual({ move, block: true });
		expect(refused?.reason).toContain(BEAD_LINT_REFUSED);
		expect(refused?.reason).toContain("b-what-why-acc");
		expect(refused?.reason).toContain("this claim would start work");
	}
	const multi = await checkBeadLint({ toolName: "bash", input: { command: `br update ${passing} ${failing} --claim` } }, deps);
	expect(multi?.block).toBe(true);
	expect(multi?.reason).toContain(failing);
	expect(await checkBeadLint({ toolName: "bash", input: { command: `br update ${passing} --claim` } }, deps)).toBeUndefined();
	expect(await checkBeadLint({ toolName: "bash", input: { command: `br update ${failing} --status open --assignee ''` } }, deps)).toBeUndefined();
});

test("CLAIMLINT infra: a claim the helper cannot judge is refused, while a content edit still warns and allows", async () => {
	const t = tracker();
	const claim = { toolName: "bash", input: { command: "br update lg-1 --claim" } };
	const edit = { toolName: "bash", input: { command: `br update lg-1 --title "renamed"` } };
	const cases = [
		{ name: "missing helper", deps: { exec: t.exec, home: base, sessionCwd: t.project, scriptsDir: join(base, "no-such-release", "scripts") } },
		{ name: "no python", deps: { exec: async () => ({ code: 127, stdout: "", stderr: "env: python3: No such file or directory" }), home: base, sessionCwd: t.project } },
		{ name: "spawn throws", deps: { exec: async (): Promise<FlywheelExecResult> => { throw new Error("spawn failed"); }, home: base, sessionCwd: t.project } },
		{ name: "timed out", deps: { exec: async () => ({ code: 0, stdout: "", killed: true }), home: base, sessionCwd: t.project } },
	];
	for (const { name, deps } of cases) {
		const refused = await checkBeadLint(claim, deps);
		expect({ name, block: refused?.block }).toEqual({ name, block: true });
		expect(refused?.reason).toContain("a claim needs a bead-lint PASS");
		const allowed = await checkBeadLint(edit, deps);
		expect({ name, block: allowed?.block === true }).toEqual({ name, block: false });
		expect(allowed?.additionalContext).toContain(BEAD_LINT_UNVERIFIED);
	}
});

test("LINTEVERY1 infra: missing helper, missing python and an unreadable tracker warn UNVERIFIED and never refuse", async () => {
	const t = tracker();
	const event = { toolName: "bash", input: { command: PLANTED } };
	const missing = await checkBeadLint(event, { exec: t.exec, home: base, sessionCwd: t.project, scriptsDir: join(base, "no-such-release", "scripts") });
	expect(missing?.block).not.toBe(true);
	expect(missing?.additionalContext).toContain(BEAD_LINT_UNVERIFIED);
	expect(missing?.additionalContext).toContain("helper missing");
	const noPython = await checkBeadLint(event, { exec: async () => ({ code: 127, stdout: "", stderr: "env: python3: No such file or directory" }), home: base, sessionCwd: t.project });
	expect(noPython?.block).not.toBe(true);
	expect(noPython?.additionalContext).toContain("rc=127");
	const thrown = await checkBeadLint(event, { exec: async () => { throw new Error("spawn failed"); }, home: base, sessionCwd: t.project });
	expect(thrown?.block).not.toBe(true);
	expect(thrown?.additionalContext).toContain("spawn failed");
	const noTracker = ownedTmp("no-tracker", { root: base }).path;
	const unreadable = await checkBeadLint({ toolName: "bash", input: { command: `br create "x" -t task --db '${noTracker}'` } },
		{ exec: t.exec, home: base, sessionCwd: noTracker });
	expect(unreadable?.block).not.toBe(true);
	expect(unreadable?.additionalContext).toContain(BEAD_LINT_UNVERIFIED);
	const timedOut = await checkBeadLint(event, { exec: async () => ({ code: 0, stdout: "", killed: true }), home: base, sessionCwd: t.project });
	expect(timedOut?.block).not.toBe(true);
	expect(timedOut?.additionalContext).toContain("timed out");
});

test("LINTEVERY1: dry-run and help creates and non-br commands are admitted without refusal", async () => {
	const t = tracker();
	const h = await createFlywheelHost(base, { respond: t.respond });
	for (const command of [`br create "x" --dry-run`, `br create --help`, `echo br create "x"`, `bd-other create x`]) {
		expect((await toolCall(h, t.project, command))?.block).not.toBe(true);
	}
	expect(h.notices).toEqual([]);
});
