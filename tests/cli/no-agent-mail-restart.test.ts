// Agent Mail is off for good (J-2026-11-24-09, bead ompkit-tnqyr.3): nothing the kit ships may restart its launchd job.
import { expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "../..");
const RESTART_VERBS = ["kickstart", "bootstrap", "launchctl start", "launchctl load"];
const restartsAgentMail = (text: string): boolean => text.includes("com.agent-mail") && RESTART_VERBS.some((verb) => text.includes(verb));

function shippedSources(dir: string): string[] {
	return readdirSync(dir).flatMap((name) => {
		const path = join(dir, name);
		if (name === "node_modules" || name.endsWith(".test.ts")) return [];
		if (statSync(path).isDirectory()) return shippedSources(path);
		return /\.(ts|sh|py|mjs|js)$/.test(name) ? [path] : [];
	});
}

test("NOAMRESTART1 am-watch is gone and no shipped source kickstarts com.agent-mail", () => {
	expect(existsSync(join(root, "src", "am-watch.ts"))).toBe(false);
	const offenders = ["src", "extensions", "scripts"].flatMap((dir) => shippedSources(join(root, dir)))
		.filter((path) => {
			return restartsAgentMail(readFileSync(path, "utf8"));
		});
	expect(offenders).toEqual([]);
});

test("NOAMRESTART1 planted: the scan does catch a file that kickstarts com.agent-mail", () => {
	const planted = 'launchctl kickstart -k gui/501/com.agent-mail';
	expect(restartsAgentMail(planted)).toBe(true);
});
