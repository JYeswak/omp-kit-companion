import { expect, test } from "bun:test";
import { dirname, join, resolve } from "node:path";
import { writeFileSync } from "node:fs";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { next, type Adapters, type Observation } from "../../src/next.ts";
import { run } from "../../src/kitlib/run.ts";
import { fixtureDeadlineS } from "./fixture-process.ts";

const root = resolve(import.meta.dir, "../..");
async function cli(...args: string[]) {
	const result = await run([process.execPath, resolve(root, "src/cli.ts"), ...args], {
		cwd: root, deadline_s: fixtureDeadlineS(15), max_output_bytes: 1024 * 1024,
		env: { ...process.env, NO_COLOR: "1", AGENT_NAME: "" },
	});
	expect(result.timed_out).toBe(false);
	expect(result.truncated).toBe(false);
	return { code: result.rc, stdout: new TextDecoder().decode(result.stdout), stderr: new TextDecoder().decode(result.stderr) };
}

// Synthetic adapter observations test payload projection and decision preservation, not live fleet health.
test("next summarizes large facts without changing its decision or hiding full facts", async () => {
	const issues = Array.from({ length: 1200 }, (_, i) => ({ id: `work-${i}`, status: "in_progress", assignee: "Me", description: "detail ".repeat(100) }));
	const values = { issues, ready: issues, cycles: [], blocked: [], triage: { triage: { quick_wins: [] } },
		git: { ahead: 0 }, changes: { paths: ["src/example.ts"], diffText: "large diff\n".repeat(10000) },
		acks: [], scratch: { data: { sessions: [] } }, pulse: {}, sitrep: {} };
	const adapter = (name: keyof typeof values) => async (): Promise<Observation> => ({ status: "KNOWN", source: `test ${name}`, value: values[name] });
	const adapters: Adapters = {
		issues: adapter("issues"), ready: adapter("ready"), cycles: adapter("cycles"), blocked: adapter("blocked"),
		triage: adapter("triage"), git: adapter("git"), changes: adapter("changes"), acks: adapter("acks"),
		scratch: adapter("scratch"), pulse: adapter("pulse"), sitrep: adapter("sitrep"),
	};
	const options = { role: "worker", agent: "Me", repo: "/stock" };
	const compact = await next(options, adapters);
	const full = await next({ ...options, fullFacts: true }, adapters);
	expect(compact.code).toBe(0);
	expect(Buffer.byteLength(JSON.stringify(compact))).toBeLessThan(65536);
	expect(compact.data.next_action).toEqual(full.data.next_action);
	expect(compact.data.next_action).toEqual({ station: "finish", why: "held in_progress work-0: finish or release before another claim (source: test issues)", commands: ["cd '/stock' && br show 'work-0' --no-auto-import --no-auto-flush --json"] });
	expect(compact.data.actions).toEqual(full.data.actions);
	expect(compact.data.applicable_skills).toEqual(full.data.applicable_skills);
	expect(compact.data.adapters).toEqual(full.data.adapters);
	expect(compact.warnings).toEqual(full.warnings);
	expect(compact.data.facts?.issues).toEqual({ status: "KNOWN", source: "test issues", value: { count: 1200, ids: issues.slice(0, 10).map(row => row.id), ids_omitted: 1190 } });
	expect(full.data.facts?.issues.value).toEqual(issues);
	expect(full.data.facts?.changes.value).toEqual(values.changes);
});

test("next help advertises explicit full-facts opt-in", async () => {
	const result = await cli("next", "--help");
	expect(result.code).toBe(0);
	expect(result.stdout).toContain("--full-facts");
	expect(result.stdout).toContain("summary");
});

test("capabilities filters one command, repeated names and comma lists", async () => {
	const one = await cli("capabilities", "--json", "--command", "land");
	expect(one.code).toBe(0);
	expect(one.stderr).toBe("");
	const envelope = JSON.parse(one.stdout);
	expect(envelope.data.commands.map((command: { name: string }) => command.name)).toEqual(["land"]);
	expect(Buffer.byteLength(JSON.stringify(envelope))).toBeLessThan(20000);
	const several = await cli("capabilities", "--json", "--command", "land,next", "--command", "capabilities", "--command", "land");
	expect(several.code).toBe(0);
	expect(JSON.parse(several.stdout).data.commands.map((command: { name: string }) => command.name).sort()).toEqual(["capabilities", "land", "next"]);
	const nested = await cli("capabilities", "--json", "--command", "service status");
	expect(nested.code).toBe(0);
	const parents = JSON.parse(nested.stdout).data.commands;
	expect(parents.map((command: { name: string }) => command.name)).toEqual(["service"]);
	expect(parents[0].subcommands.map((command: { name: string }) => command.name)).toEqual(["status"]);
});

test("unknown capabilities selection teaches an exact correction without running it", async () => {
	const result = await cli("capabilities", "--json", "--command", "lnad");
	expect(result.code).toBe(2);
	expect(result.stderr).toBe("");
	const envelope = JSON.parse(result.stdout);
	expect(envelope.data.overall).toBe("NOT_RUN");
	expect(envelope.errors[0].code).toBe("UNKNOWN_COMMAND");
	expect(envelope.errors[0].remediation).toContain("omp-kit capabilities --json --command land");
	expect(envelope.errors[0].remediation).toContain("no command was run");
});

test("command hints rank a transposition before a tied substitution and retain substitution-only hints", async () => {
	const result = await cli("lnad", "--help");
	expect(result.code).toBe(2);
	expect(result.stdout).toBe("");
	expect(result.stderr).toContain("omp-kit land");
	expect(result.stderr).toContain("omp-kit load");
	expect(result.stderr.indexOf("omp-kit land")).toBeLessThan(result.stderr.indexOf("omp-kit load"));
	expect(result.stderr).toContain("no command was run");
	const substitution = await cli("vqrify", "--help");
	expect(substitution.code).toBe(2);
	expect(substitution.stdout).toBe("");
	expect(substitution.stderr).toContain("omp-kit verify exactly");
	expect(substitution.stderr).toContain("no command was run");
});

test("handoff redirects to the existing landing and verification commands without execution", async () => {
	const result = await cli("handoff", "--help");
	expect(result.code).toBe(2);
	expect(result.stdout).toBe("");
	expect(result.stderr).toContain("omp-kit land --checkout <n> --bead <id> --review auto");
	expect(result.stderr).toContain("omp-kit verify <bead> --export <sha> --dry-run");
	expect(result.stderr).toContain("no command was run");
});

test("help and robot guide teach scoped discovery and summary opt-in", async () => {
	const help = await cli("capabilities", "--help");
	expect(help.code).toBe(0);
	expect(help.stdout).toContain("--command");
	const guide = await cli("robot-docs", "guide");
	expect(guide.code).toBe(0);
	expect(guide.stdout).toContain("omp-kit capabilities --json --command land");
	expect(guide.stdout).toContain("--full-facts");
});

test("standalone identity discovery is not advertised as a per-command operation", async () => {
	const help = await cli("land", "--help");
	expect(help.code).toBe(0);
	expect(help.stdout).not.toContain("--info");
	const discovery = await cli("capabilities", "--json");
	expect(discovery.code).toBe(0);
	expect(JSON.parse(discovery.stdout).data.global_flags.find((flag: { name: string }) => flag.name === "--info").standalone).toBe(true);
	const refused = await cli("land", "--info", "--json");
	expect(refused.code).toBe(2);
	expect(JSON.parse(refused.stdout).errors[0].remediation).toContain("omp-kit --info");
});

test("uninstall refusal teaches supported inspection, not an undeclared preview flag", async () => {
	const result = await cli("service", "uninstall", "omp-watch", "--json");
	expect(result.code).toBe(2);
	const envelope = JSON.parse(result.stdout);
	expect(envelope.errors[0].code).toBe("UNINSTALL_REQUIRES_APPLY");
	expect(envelope.errors[0].remediation).toContain("omp-kit service status omp-watch --json");
	expect(envelope.errors[0].remediation).not.toContain("--dry-run");
});

test("CLI full-facts flag returns the complete patch from a real owned git repository", async () => {
	const scratch = ownedTmp("ergo2-full-facts");
	try {
		const git = Bun.which("git");
		if (!git) throw new Error("git required for full-facts regression");
		const env = { ...process.env, HOME: scratch.path, PATH: dirname(git), AGENT_NAME: "", OMP_KIT_CC: "0" };
		const invoke = async (argv: string[]) => {
			const result = await run(argv, { cwd: scratch.path, env, deadline_s: fixtureDeadlineS(15), max_output_bytes: 1024 * 1024 });
			expect(result.timed_out).toBe(false);
			expect(result.truncated).toBe(false);
			expect(result.rc, new TextDecoder().decode(result.stderr)).toBe(0);
			return new TextDecoder().decode(result.stdout);
		};
		await invoke([git, "init", "--initial-branch=main"]);
		writeFileSync(join(scratch.path, "notes.txt"), "baseline\n");
		await invoke([git, "add", "notes.txt"]);
		await invoke([git, "-c", "user.name=ERGO2 Test", "-c", "user.email=ergo2@example.invalid", "commit", "-m", "fixture baseline"]);
		await invoke([git, "update-ref", "refs/remotes/origin/main", "HEAD"]);
		writeFileSync(join(scratch.path, "notes.txt"), "ERGO2 complete patch marker\n".repeat(3000));
		const args = [process.execPath, resolve(root, "src/cli.ts"), "next", "--role", "worker", "--repo", scratch.path, "--json"];
		const compact = JSON.parse(await invoke(args));
		const full = JSON.parse(await invoke([...args, "--full-facts"]));
		expect(compact.data.next_action).toEqual(full.data.next_action);
		expect(compact.data.facts.changes.value).toEqual({ count: 1, ids: ["notes.txt"], ids_omitted: 0 });
		expect(full.data.facts.changes.value.paths).toEqual(["notes.txt"]);
		expect(full.data.facts.changes.value.diffText).toContain("+ERGO2 complete patch marker");
		expect(Buffer.byteLength(JSON.stringify(compact))).toBeLessThan(65536);
		expect(Buffer.byteLength(JSON.stringify(full))).toBeGreaterThan(65536);
	} finally { scratch.cleanup(); }
}, Math.round(fixtureDeadlineS(30) * 1000));
