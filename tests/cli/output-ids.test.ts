import { afterAll, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { COMMANDS } from "../../src/commands.ts";
import { PROFILE_RECIPE_KINDS } from "../../src/profile-recipes.ts";
import { cleanupAllOwnedTmp, ownedTmp } from "../../src/kitlib/tmp.ts";
import { cliOutputBundle } from "./cli-bundle-fixture.ts";
import { runFixture } from "./fixture-process.ts";
afterAll(cleanupAllOwnedTmp);

const cli = resolve(import.meta.dir, "../../src/cli.ts");
const scratch = join(import.meta.dir, "../../var/agent-tmp");
const home = ownedTmp("output-ids", { root: scratch }).path;
afterAll(() => rmSync(home, { recursive: true, force: true }));

// Internal tracker ids (bead numbers, bead slugs, epic suffixes) mean nothing to an operator.
const INTERNAL_ID = /\b(P\d{2}|ompkit-[a-z0-9-]+|rz5(\.\d+)?)\b/g;

const surfaces: string[][] = [
	[], ["--version"], ["-V"], ["help"],
	...COMMANDS.map((command) => ["help", command.name]),
	...COMMANDS.flatMap((command) => (command.subcommands ?? []).map((child) => ["help", command.name, child.name])),
	["capabilities", "--json"], ["schema", "--json"], ["quickstart"], ["examples"], ["examples", "mcp"],
	...PROFILE_RECIPE_KINDS.map((kind) => ["examples", kind]),
	["status", "--json"], ["doctor", "--json"], ["test", "--json"],
	// Refusal and usage-error paths render remediation text too.
	["update", "--apply", "--json"], ["undo", "not-a-receipt", "--json"], ["no-such-command"],
];

test("rendered CLI output never names internal tracker ids", () => {
	const { XDG_STATE_HOME: _state, XDG_DATA_HOME: _data, XDG_CONFIG_HOME: _config, ...inherited } = process.env;
	const hits: { argv: string; id: string }[] = [];
	const silent: { argv: string; code: number }[] = [];
	// Help, grammar and examples are declarative output. Bundle their real CLI
	// once instead of loading its entire module graph for every fresh process.
	// Runtime commands retain the source entry point and its checkout identity.
	const outputCli = cliOutputBundle();
	for (const args of surfaces) {
		const declarative = args.length === 0 || ["--version", "-V", "help", "capabilities", "schema", "quickstart", "examples", "no-such-command"].includes(args[0]!);
		const result = runFixture([process.execPath, declarative ? outputCli : cli, ...args], {
			cwd: home, env: { ...inherited, HOME: home }, floor_s: 120,
		});
		const argv = `omp-kit ${args.join(" ")}`.trim();
		const output = `${new TextDecoder().decode(result.stdout)}${new TextDecoder().decode(result.stderr)}`;
		if (output.trim() === "") silent.push({ argv, code: result.rc ?? -1 });
		for (const match of output.matchAll(INTERNAL_ID)) hits.push({ argv, id: match[0] });
	}
	// A surface that printed nothing would pass the scan vacuously.
	expect(silent, `surfaces with empty stdout+stderr (expected none): ${JSON.stringify(silent)}`).toEqual([]);
	expect(hits, `internal ids in rendered output (expected none) over ${surfaces.length} surfaces: ${JSON.stringify(hits)}`).toEqual([]);
}, 120_000);
