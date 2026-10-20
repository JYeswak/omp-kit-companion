import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const entry = resolve(import.meta.dir, "../../src/cli.ts");
const fixtures: string[] = [];
afterEach(() => {
	for (const fixture of fixtures.splice(0)) rmSync(fixture, { recursive: true, force: true });
});

function workspace(): string {
	const root = mkdtempSync(join(tmpdir(), "omp-kit-toolgate-"));
	fixtures.push(root);
	return root;
}

type CapsCommand = { name: string; subcommands?: CapsCommand[] };
type CapsResult = { code: number; data: { commands: CapsCommand[] }; stdout: string };

/** Stock-runner simulation: PATH carries only the caller-supplied bindir plus the OS defaults. */
function robot(args: string[], root: string, bindir: string): CapsResult & { errorsCode: string } {
	const spawned = Bun.spawnSync([process.execPath, entry, ...args], {
		cwd: root,
		env: { ...process.env, HOME: root, XDG_CONFIG_HOME: join(root, "xdg-config"), XDG_STATE_HOME: join(root, "xdg-state"), XDG_DATA_HOME: join(root, "xdg-data"), XDG_CACHE_HOME: join(root, "xdg-cache"), PATH: `${bindir}:/usr/bin:/bin`, OMP: "", OMP_BIN: "", OMP_PATH: "", OMP_SRC: "", NO_COLOR: "" },
		stdout: "pipe",
		stderr: "pipe",
	});
	const data = JSON.parse(spawned.stdout.toString()) as { data?: { commands?: CapsCommand[] }; errors?: [{ code?: string }] };
	return {
		code: spawned.exitCode,
		data: { commands: data.data?.commands ?? [] },
		stdout: spawned.stdout.toString(),
		errorsCode: data.errors?.[0]?.code ?? "",
	};
}

/** Empty bindir: none of am, ntm, rch, tern, br, tmux is on PATH. */
function stockBin(): string {
	const dir = mkdtempSync(join(tmpdir(), "omp-kit-stockbin-"));
	fixtures.push(dir);
	return dir;
}

function fakeBin(tools: string[]): string {
	const dir = mkdtempSync(join(tmpdir(), "omp-kit-fakebin-"));
	fixtures.push(dir);
	mkdirSync(dir, { recursive: true });
	for (const tool of tools) {
		writeFileSync(join(dir, tool), "#!/bin/sh\nexit 0\n");
		chmodSync(join(dir, tool), 0o755);
	}
	return dir;
}

describe("oq1h.6 tool-gated capabilities", () => {
	test("stock runner omits tool-backed verbs", () => {
		const root = workspace();
		const caps = robot(["capabilities", "--json"], root, stockBin());
		const names = caps.data.commands.map((command) => command.name);
		expect(names).not.toContain("land");
		expect(names).not.toContain("send");
		expect(names).not.toContain("rch");
		expect(names).not.toContain("fleet");
		expect(names).not.toContain("tern-ref");
		expect(names).not.toContain("drain");
		const planning = caps.data.commands.find((command) => command.name === "planning");
		expect((planning?.subcommands ?? []).map((child) => child.name)).not.toContain("convert");
	});

	test("stock runner refuses with named codes and exit 3", () => {
		const root = workspace();
		const bin = stockBin();
		const land = robot(["land", "--paths", "x", "--message", "m", "--json"], root, bin);
		expect(land.code).toBe(3);
		expect(land.errorsCode).toBe("AGENT_MAIL_UNAVAILABLE");
		const send = robot(["send", "S", "P", "hello", "--json"], root, bin);
		expect(send.code).toBe(3);
		expect(send.errorsCode).toBe("NTM_UNAVAILABLE");
		const tern = robot(["tern-ref", "build", "--json"], root, bin);
		expect(tern.code).toBe(3);
		expect(tern.errorsCode).toBe("TERN_UNAVAILABLE");
	});

	test("planted: fake rch restores rch lease; all fakes restore all verbs", () => {
		const root = workspace();
		const rchOnly = robot(["capabilities", "--json"], root, fakeBin(["rch"]));
		const rchNames = rchOnly.data.commands.map((command) => command.name);
		const rch = rchOnly.data.commands.find((command) => command.name === "rch");
		expect((rch?.subcommands ?? []).map((child) => child.name)).toContain("lease");
		expect(rchNames).not.toContain("land");
		const full = robot(["capabilities", "--json"], root, fakeBin(["am", "ntm", "rch", "tern", "br", "tmux"]));
		expect(full.data.commands.map((command) => command.name)).toEqual(expect.arrayContaining(["land", "send", "rch", "fleet", "tern-ref", "drain"]));
		const planning = full.data.commands.find((command) => command.name === "planning");
		expect((planning?.subcommands ?? []).map((child) => child.name)).toContain("convert");
	});

	test("real PATH still lists tool-backed verbs", () => {
		const root = workspace();
		const caps = robot(["capabilities", "--json"], root, process.env.PATH ?? "/usr/bin:/bin");
		expect(caps.data.commands.map((command) => command.name)).toEqual(expect.arrayContaining(["land", "send", "rch", "fleet", "tern-ref", "drain"]));
	});
});
