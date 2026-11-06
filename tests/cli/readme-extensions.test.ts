import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { runFixture } from "./fixture-process.ts";

const repo = resolve(import.meta.dir, "../..");
const policy: { extensions: string[]; skipProfiles: string[] } = JSON.parse(readFileSync(join(repo, "policy/extensions.json"), "utf8"));
const readme = readFileSync(join(repo, "README.md"), "utf8");
const documented = `# Extensions\n<!-- default-extensions:start -->\n${policy.extensions.map(id => `- \`${id}\``).join("\n")}\n<!-- default-extensions:end -->\n`;

function check(text: string, extensions = policy.extensions): { code: number | null; out: string } {
	const tmp = ownedTmp("readme-extensions");
	try {
		mkdirSync(join(tmp.path, "policy"));
		writeFileSync(join(tmp.path, "policy/extensions.json"), JSON.stringify({ ...policy, extensions }));
		writeFileSync(join(tmp.path, "README.md"), text);
		const child = runFixture([process.execPath, join(repo, "scripts/readme-check.ts"), "--root", tmp.path, "--no-readme-gate"], { cwd: repo });
		const decoder = new TextDecoder();
		return { code: child.rc, out: decoder.decode(child.stdout) + decoder.decode(child.stderr) };
	} finally {
		tmp.cleanup();
	}
}

test("the README default list covers exactly the shipped profile policy", () => {
	const start = readme.indexOf("<!-- default-extensions:start -->");
	const end = readme.indexOf("<!-- default-extensions:end -->");
	const result = check(`# Extensions\n${readme.slice(start, end + "<!-- default-extensions:end -->".length)}\n`);
	expect(result.out).toContain("README-CHECK: GREEN");
	expect(result.code).toBe(0);
});

test("an extension added to a policy copy without README coverage is RED and named", () => {
	const control = check(documented);
	expect(control.out).toContain("README-CHECK: GREEN");
	expect(control.code).toBe(0);
	const planted = check(documented, [...policy.extensions, "planted-fake-extension.ts"]);
	expect(planted.out).toContain("missing default extension `planted-fake-extension.ts`");
	expect(planted.code).toBe(1);
});

test("a removed policy extension left in the README is RED", () => {
	const result = check(documented, policy.extensions.slice(1));
	expect(result.out).toContain(`lists non-default extension \`${policy.extensions[0]}\``);
	expect(result.code).toBe(1);
});

test("an extension mentioned outside the default list does not satisfy coverage", () => {
	const id = policy.extensions[0]!;
	const result = check(documented.replace(`- \`${id}\`\n`, "") + `\nOptional: \`${id}\`\n`);
	expect(result.out).toContain(`missing default extension \`${id}\``);
	expect(result.code).toBe(1);
});
