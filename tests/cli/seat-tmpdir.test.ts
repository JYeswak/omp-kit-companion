import { expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import fleetGuard from "../../extensions/fleet-guard.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { parseOwnerFile, readBudgetLedger } from "../../src/scratch.ts";
import { fixtureDeadlineS, runFixture } from "./fixture-process.ts";

const agent = "SeatScratchProof";
const session = "seat-scratch-proof-01";
const envKeys = ["TMPDIR", "TMP", "TEMP", "OMP_KIT_SCRATCH_ROOTS", "AGENT_MAIL_TOKEN", "AGENTMAIL_HTTP_BEARER_TOKEN"] as const;
type Start = (_event: unknown, ctx: { cwd: string; sessionManager: { getSessionId: () => string } }) => void | Promise<void>;

async function startup(enabled: boolean) {
	const scratch = ownedTmp("seat-tmpdir-test", { root: process.env.TMPDIR });
	const savedEnv = envKeys.map((key) => [key, process.env[key]] as const);
	try {
		const cwd = realpathSync(scratch.path);
		const inherited = join(cwd, "inherited");
		mkdirSync(inherited);
		for (const key of ["TMPDIR", "TMP", "TEMP"] as const) process.env[key] = inherited;
		delete process.env.AGENT_MAIL_TOKEN;
		delete process.env.AGENTMAIL_HTTP_BEARER_TOKEN;
		const env = { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null" };
		for (const key of Object.keys(env)) if (key.startsWith("GIT_") && key !== "GIT_CONFIG_NOSYSTEM" && key !== "GIT_CONFIG_GLOBAL") delete env[key as keyof typeof env];
		const init = runFixture(["git", "init", "-q", "--template="], { cwd, env });
		if (init.rc !== 0) throw new Error(new TextDecoder().decode(init.stderr));
		mkdirSync(join(cwd, ".omp"));
		writeFileSync(join(cwd, ".omp", "fleet.json"), JSON.stringify({ enabled }));
		const dir = join(cwd, "var", "agent-tmp", `omp.${process.pid}`);
		const ledgerPath = join(cwd, "budget.json");
		process.env.OMP_KIT_SCRATCH_ROOTS = join(cwd, "var", "agent-tmp");
		const starts: Start[] = [];
		await fleetGuard({ setLabel() {}, on(event: string, handler: (...args: never[]) => unknown) {
			if (event === "session_start") starts.push(handler as Start);
		} }, { cwd, env: { AGENT_NAME: agent }, seatScratch: { ledgerPath } });
		for (const start of starts) await start({ type: "session_start" }, { cwd, sessionManager: { getSessionId: () => session } });
		const child = runFixture(["sh", "-c", 'printf "%s\\n" "$TMPDIR" "$TMP" "$TEMP"'], { cwd, env: process.env });
		if (child.rc !== 0) throw new Error(new TextDecoder().decode(child.stderr));
		const ownerPath = join(dir, ".owner");
		return { inherited, dir, toolTemps: new TextDecoder().decode(child.stdout).trim().split("\n"),
			owner: existsSync(ownerPath) ? parseOwnerFile(readFileSync(ownerPath, "utf8")) : null,
			budget: readBudgetLedger(ledgerPath)?.dirs[dir] ?? null };
	} finally {
		for (const [key, value] of savedEnv) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		scratch.cleanup();
	}
}

test("SEATTMPDIR1: startup gives tools an owned TMPDIR and charges the seat before any tool call", async () => {
	const { dir, toolTemps, owner, budget } = await startup(true);
	expect(toolTemps).toEqual([dir, dir, dir]);
	expect(budget).toMatchObject({ agent, released: false });
	expect(owner).toMatchObject({ agent, session, pid: process.pid, bin: "throwaway" });
}, fixtureDeadlineS() * 1000);

test("SEATTMPDIR1: disabled fleet policy keeps the inherited tool environment", async () => {
	const { inherited, toolTemps, owner, budget } = await startup(false);
	expect(toolTemps).toEqual([inherited, inherited, inherited]);
	expect(owner).toBeNull();
	expect(budget).toBeNull();
}, fixtureDeadlineS() * 1000);
