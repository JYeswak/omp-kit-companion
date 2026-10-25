/** R-006 passes when discovery preserves legacy exits and publishes contextual custody/heavy exits,
 * including child passthrough semantics (42 must remain a child code, not a kit category).
 * The child control only exits 42; no custody mutation or build is executed. */
import { expect, test } from "bun:test";
import { join, resolve } from "node:path";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { run } from "../../src/kitlib/run.ts";

const entry = resolve(import.meta.dir, "../../src/cli.ts");

async function discover(verb: string, root: string) {
	const child = await run([process.execPath, entry, verb, "--json"], {
		cwd: root, env: { ...process.env, HOME: root,
			XDG_CONFIG_HOME: join(root, "config"), XDG_STATE_HOME: join(root, "state"),
			XDG_DATA_HOME: join(root, "data"), XDG_CACHE_HOME: join(root, "cache") },
		deadline_s: 15,
	});
	expect(child.rc).toBe(0);
	expect(new TextDecoder().decode(child.stderr)).toBe("");
	const envelope = JSON.parse(new TextDecoder().decode(child.stdout));
	expect(envelope.ok).toBe(true);
	return envelope.data;
}

type Route = { name: string; subcommands?: Route[]; exit_contract?: unknown };
function route(commands: Route[], path: string): Route {
	const [name, sub] = path.split(" ");
	const parent = commands.find(command => command.name === name);
	const result = sub ? parent?.subcommands?.find(command => command.name === sub) : parent;
	if (!result) throw new Error(`Discovery omitted route ${path}`);
	return result;
}

// Accept keyed dictionaries or entry arrays; no new wire shape is prescribed.
function exitDescription(contract: unknown, code: number): string {
	if (!contract || typeof contract !== "object") return "";
	const object = contract as Record<string, unknown>;
	const direct = object[String(code)];
	if (direct !== undefined) return JSON.stringify(direct);
	if ([object.code, object.exit_code, object.exitCode].includes(code)) return JSON.stringify(object);
	return Object.values(object).map(value => exitDescription(value, code)).filter(Boolean).join(" ");
}

for (const verb of ["schema", "capabilities"]) {
	test(`R-006 ${verb} publishes route-specific outcomes without changing the global dictionary`, async () => {
		const tmp = ownedTmp("ergo1-r-006");
		try {
			const data = await discover(verb, tmp.path);
			expect(data.exit_codes).toMatchObject({ success: 0, finding: 1, usage_or_blocked: 2, unavailable: 3, retryable: 4, not_run: 77 });
			const custody = route(data.commands, "custody check").exit_contract;
			expect(custody).toBeDefined();
			expect(exitDescription(custody, 10).includes("HELD")).toBe(true);
			expect(exitDescription(custody, 11).includes("DIRTY_UNOWNED")).toBe(true);
			const heavy = route(data.commands, "heavy").exit_contract;
			expect(heavy).toBeDefined();
			expect(["observer", "prereq", "unavailable"].some(word => exitDescription(heavy, 69).toLowerCase().includes(word))).toBe(true);
			expect(["defer", "admission", "queue", "retry"].some(word => exitDescription(heavy, 75).toLowerCase().includes(word))).toBe(true);
			// Child passthrough must be explicit, not inferred from an unknown numeric code.
			const childContract = JSON.stringify(heavy).toLowerCase();
			expect(childContract.includes("child")).toBe(true);
			expect(["passthrough", "pass-through", "preserv", "unchanged", "raw"].some(word => childContract.includes(word))).toBe(true);
			expect(childContract.includes("retry")).toBe(true);
		} finally { tmp.cleanup(); }
	}, 40_000);
}
test("heavy preserves a harmless child's exit 42", async () => {
 const tmp = ownedTmp("ergo1-child-exit");
 try {
  const child = await run([process.execPath, entry, "heavy", "--disk-observer", "statfs", "--no-wait", "--max-runtime", "5", "--", process.execPath, "-e", "process.exit(42)"], {
   cwd: tmp.path, env: { ...process.env, HOME: tmp.path, XDG_CONFIG_HOME: join(tmp.path, "config"), XDG_STATE_HOME: join(tmp.path, "state") },
   deadline_s: 15,
  });
  expect(child.rc).toBe(42);
  expect(new TextDecoder().decode(child.stdout)).toBe("");
 } finally { tmp.cleanup(); }
}, 20000);
