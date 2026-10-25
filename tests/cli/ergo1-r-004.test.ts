/** R-004 passing behavior: no-OMP help names automation discovery commands and
 * explains exit categories consistently with schema; scoped help keeps flags/examples. */
import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { run } from "../../src/kitlib/run";

const entry = resolve(import.meta.dir, "../../src/cli.ts");

test("R-004: help teaches automation and schema-backed exit semantics", async () => {
	const tmp = ownedTmp("ergo1-r-004");
	try {
		const results: string[] = [];
		for (const args of [["help"], ["schema", "--json"], ["help", "update"]]) {
			const result = await run([process.execPath, entry, ...args], {
				cwd: tmp.path, deadline_s: 15,
				env: { HOME: tmp.path, PATH: tmp.path, TMPDIR: process.env.TMPDIR ?? tmp.path, NO_COLOR: "1", OMP: "", OMP_BIN: "", OMP_PATH: "", OMP_SRC: "",
					XDG_CONFIG_HOME: join(tmp.path, "config"), XDG_STATE_HOME: join(tmp.path, "state"), XDG_DATA_HOME: join(tmp.path, "data"), XDG_CACHE_HOME: join(tmp.path, "cache") },
			});
			expect(result.rc).toBe(0);
			expect(Buffer.from(result.stderr).toString()).toBe("");
			results.push(Buffer.from(result.stdout).toString());
		}
		const [help, schemaText, scoped] = results;
		const schema = JSON.parse(schemaText!).data;
		expect(scoped).toContain("--plan");
		expect(scoped).toContain("--yes");
		expect(scoped).toContain("Example:");
		for (const command of ["omp-kit capabilities --json", "omp-kit schema --json", "omp-kit robot-docs guide", "omp-kit status --json"]) expect(help).toContain(command);
		expect(help!.toLowerCase()).toContain("automation");
		expect(help).toContain("--json");
		expect(help).toContain("--robot");
		// A concise pointer is sufficient; the authoritative category numbers stay in schema.
		const exitLines = help!.split("\n").filter(line => line.toLowerCase().includes("exit"));
		const hasSchemaExitPointer = exitLines.some(line => line.includes("schema") || line.includes("exit_codes"));
		if (!hasSchemaExitPointer) {
			for (const [category, code] of Object.entries(schema.exit_codes)) {
				const readable = category.replaceAll("_", " ");
				expect(exitLines.some(line => line.includes(String(code)) && (line.includes(category) || line.includes(readable)))).toBe(true);
			}
		}
	} finally {
		tmp.cleanup();
	}
}, 50_000);
