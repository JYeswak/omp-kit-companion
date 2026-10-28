import { afterEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { run as runCommand } from "../../src/kitlib/run.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";

const entry = resolve(import.meta.dir, "../../src/cli.ts");
const roots: string[] = [];
afterEach(() => {
	while (roots.length) rmSync(roots.pop()!, { recursive: true, force: true });
});

function home(): string {
	const tmp = ownedTmp("activation-optout");
	roots.push(tmp.path);
	return tmp.path;
}

async function run(args: string[], root: string) {
	const result = await runCommand([process.execPath, entry, ...args], {
		deadline_s: 60,
		cwd: root,
		env: { ...process.env, HOME: root, PATH: "/usr/bin:/bin" },
	});
	return { code: result.rc, stdout: Buffer.from(result.stdout).toString(), stderr: Buffer.from(result.stderr).toString() };
}

const optOutFile = (root: string) => join(root, ".config", "omp-kit", "activation-optouts.json");

test("activation opt-out records item, reason, actor and time", async () => {
	const root = home();
	const out = await run(["activation", "opt-out", "--item", "service:kit-fleet-watch", "--reason", "host has no launchd", "--json"], root);
	expect(out.code).toBe(0);
	const body = JSON.parse(out.stdout);
	expect(body.data.overall).toBe("OK");
	expect(body.data.optout.item).toBe("service:kit-fleet-watch");
	expect(body.data.optout.reason).toBe("host has no launchd");
	expect(typeof body.data.optout.by).toBe("string");
	expect(typeof body.data.optout.at).toBe("string");
	const stored = JSON.parse(readFileSync(optOutFile(root), "utf8"));
	expect(stored.version).toBe(1);
	expect(stored.optouts).toHaveLength(1);
	expect(stored.optouts[0].item).toBe("service:kit-fleet-watch");
});

test("planted: an opt-out with an empty reason is refused and nothing is written", async () => {
	const root = home();
	const out = await run(["activation", "opt-out", "--item", "service:kit-fleet-watch", "--reason", "   ", "--json"], root);
	expect(out.code).toBe(2);
	expect(out.stdout + out.stderr).toContain("OPT_OUT_REASON_REQUIRED");
	expect(existsSync(optOutFile(root))).toBe(false);
});

test("planted: a missing item is refused and nothing is written", async () => {
	const root = home();
	const out = await run(["activation", "opt-out", "--reason", "no launchd", "--json"], root);
	expect(out.code).toBe(2);
	expect(out.stdout + out.stderr).toContain("OPT_OUT_ITEM_REQUIRED");
	expect(existsSync(optOutFile(root))).toBe(false);
});

test("planted: a corrupt opt-out record fails closed and is never appended to", async () => {
	const root = home();
	mkdirSync(dirname(optOutFile(root)), { recursive: true });
	writeFileSync(optOutFile(root), "{nope");
	const before = readFileSync(optOutFile(root), "utf8");
	const out = await run(["activation", "opt-out", "--item", "service:kit-fleet-watch", "--reason", "no launchd", "--json"], root);
	expect(out.code).toBe(2);
	expect(readFileSync(optOutFile(root), "utf8")).toBe(before);
});
