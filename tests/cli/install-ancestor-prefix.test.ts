import { expect, test } from "bun:test";
import { mkdirSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import pkg from "../../package.json";
import { renderScratchOwner } from "../../src/fleet-guard/scratch.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import type { FleetGuardBlock } from "../../src/fleet-guard/git.ts";

const manifest = '{"name":"install-scope-fixture","private":true}\n';
const session = "install-prefix-fixture";

async function fixture(run: (x: { workspace: string; scratch: string; foreign: string; call: (command: string, cwd?: string) => Promise<FleetGuardBlock | undefined> }) => Promise<void>) {
	const tmp = ownedTmp("install-scope", { root: join(process.cwd(), "var", "agent-tmp") });
	const workspace = realpathSync(tmp.path);
	const foreign = join(workspace, "var", "agent-tmp", "other-seat");
	const scratch = join(workspace, "var", "agent-tmp", "this-seat");
	const previous = process.env.AGENT_NAME;
	process.env.AGENT_NAME = "InstallProbe";
	try {
		mkdirSync(scratch, { recursive: true });
		mkdirSync(foreign, { recursive: true });
		writeFileSync(join(workspace, "package.json"), manifest);
		for (const [path, agent] of [[scratch, "InstallProbe"], [foreign, "OtherSeat"]] as const) {
			writeFileSync(join(path, ".owner"), renderScratchOwner({ pid: process.pid, label: "install-scope", repo: workspace, created: new Date().toISOString(), agent, session }));
		}
		const handlers: Array<(event: unknown, context: unknown) => Promise<FleetGuardBlock | undefined>> = [];
		const path = pkg.omp.extensions.find(entry => entry === "extensions/install-ancestor-prefix.ts");
		// Load the entry selected by the real plugin package, including the previous package with no guard.
		if (path) {
			const extension = await import(join(import.meta.dir, "../..", path));
			await extension.default({ setLabel() {}, on(_event: string, handler: typeof handlers[number]) { handlers.push(handler); } });
		}
		const call = async (command: string, cwd: string = scratch) => {
			for (const handler of handlers) {
				const block = await handler({ toolName: "bash", input: { command, cwd } }, { cwd: workspace, sessionManager: { getSessionId: () => session } });
				if (block) return block;
			}
			return undefined;
		};
		await run({ workspace, scratch, foreign, call });
	} finally {
		if (previous === undefined) delete process.env.AGENT_NAME;
		else process.env.AGENT_NAME = previous;
		tmp.cleanup();
	}
}

test("NPMPREFIX1 refuses ancestor installs before effect and names the actual ancestor", () => fixture(async ({ workspace, call }) => {
	for (const command of ["npm install left-pad", "pnpm add left-pad", "yarn install", "bun install", "npm ci"]) {
		const result = await call(command);
		expect(result?.block, command).toBe(true);
		expect(result?.reason, command).toContain(workspace);
		expect(result?.reason, command).toContain("install-ancestor-prefix");
	}
	expect(await call('printf "%s\\n" "npm install left-pad"')).toBeUndefined();
	expect(await call("npm run install")).toBeUndefined();
}));

test("NPMPREFIX1 admits local manifests and a verified npm prefix but not foreign or symlinked targets", () => fixture(async ({ workspace, scratch, foreign, call }) => {
	expect(await call("npm install", workspace)).toBeUndefined();
	expect(await call(`npm --prefix "${scratch}" install left-pad`)).toBeUndefined();
	expect(await call(`npm install --prefix="${foreign}" left-pad`)).toMatchObject({ block: true });
	const link = join(scratch, "other");
	symlinkSync(foreign, link);
	expect(await call(`npm install --prefix "${link}" left-pad`)).toMatchObject({ block: true });
	// A project-directory flag selects a cwd, not the target of an ancestor walk.
	expect(await call(`pnpm --dir "${scratch}" install`)).toMatchObject({ block: true });
	writeFileSync(join(scratch, "package.json"), manifest);
	expect(await call("npm install left-pad")).toBeUndefined();
	for (const command of [`pnpm --dir "${scratch}" install`, `yarn --cwd "${scratch}" install`, `bun --cwd "${scratch}" install`]) {
		expect(await call(command), command).toBeUndefined();
	}
}));

test("NPMPREFIX1 judges simple cd chains physically instead of using the caller's manifest", () => fixture(async ({ workspace, scratch, call }) => {
	expect(await call(`cd "${scratch}" && npm install left-pad`, workspace)).toMatchObject({ block: true });
	expect(await call(`cd "${workspace}" && npm install`, scratch)).toBeUndefined();
	expect(await call('cd "$PACKAGE_SCOPE"; npm install left-pad', workspace)).toMatchObject({ block: true });
}));
