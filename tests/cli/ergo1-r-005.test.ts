/** R-005 passing behavior: introspection explains missing br separately from unwired
 * handlers, preserves runnable-only capabilities.commands, and publishes the catalog
 * in the actual command_data.capabilities schema. No dependency is installed/executed. */
import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { run } from "../../src/kitlib/run.ts";

type Command = { name: string; runnable?: boolean; subcommands?: Command[] };
type Unavailable = { path: string; reason: string; missing_tools: string[]; remediation: string };
const entry = resolve(import.meta.dir, "../../src/cli.ts");

test("R-005: capability discovery distinguishes missing native tools from unwired handlers", async () => {
	const tmp = ownedTmp("ergo1-r-005");
	try {
		const results = await Promise.all([["capabilities", "--json"], ["schema", "--json"], ["help", "planning convert", "--json"]].map(async args => {
			const result = await run([process.execPath, entry, ...args], {
				cwd: tmp.path, deadline_s: 15,
				env: { HOME: tmp.path, PATH: tmp.path, ...(process.env.TMPDIR ? { TMPDIR: process.env.TMPDIR } : {}), NO_COLOR: "1", OMP: "", OMP_BIN: "", OMP_PATH: "", OMP_SRC: "",
					XDG_CONFIG_HOME: join(tmp.path, "config"), XDG_STATE_HOME: join(tmp.path, "state"), XDG_DATA_HOME: join(tmp.path, "data"), XDG_CACHE_HOME: join(tmp.path, "cache") },
			});
			expect(result.rc).toBe(0);
			expect(new TextDecoder().decode(result.stderr)).toBe("");
			return JSON.parse(new TextDecoder().decode(result.stdout)).data;
		}));
		const [capabilities, schema, help] = results;
		const paths = new Set<string>();
		const pending: { command: Command; prefix: string }[] = capabilities.commands.map((command: Command) => ({ command, prefix: "" }));
		while (pending.length) {
			const { command, prefix } = pending.pop()!;
			const path = `${prefix}${command.name}`;
			expect(command.runnable).toBe(true);
			paths.add(path);
			for (const child of command.subcommands ?? []) pending.push({ command: child, prefix: `${path} ` });
		}
		expect(paths.has("status")).toBe(true);
		expect(paths.has("planning convert")).toBe(false);
		const unavailable: Unavailable[] = capabilities.unavailable_commands;
		expect(Array.isArray(unavailable)).toBe(true);
		const missing = unavailable.find(command => command.path === "planning convert");
		expect(missing).toBeDefined();
		expect(missing!.missing_tools).toContain("br");
		expect(typeof missing!.reason).toBe("string");
		expect(missing!.reason.length).toBeGreaterThan(0);
		expect(missing!.remediation.length).toBeGreaterThan(0);
		for (const command of unavailable) {
			expect(paths.has(command.path)).toBe(false);
			// A genuinely unwired route must not inherit a missing-tool reason.
			if (command.missing_tools.length === 0) expect(command.reason).not.toBe(missing!.reason);
		}
		expect(help.text).toContain("br");
		expect(help.text).not.toContain("Handler not yet available");
		const catalogSchema = schema.command_data.capabilities.properties.unavailable_commands;
		expect(catalogSchema.type).toBe("array");
		for (const key of ["path", "reason", "missing_tools", "remediation"]) {
			expect(catalogSchema.items.required).toContain(key);
		}
	} finally {
		tmp.cleanup();
	}
}, 50_000);
