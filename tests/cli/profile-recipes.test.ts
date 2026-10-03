import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, readdirSync, mkdirSync, writeFileSync, rmSync, lstatSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { renderRecipe, validateRecipeProfileName } from "../../src/profile-recipes.ts";

const releaseRoot = join(import.meta.dir, "../..");
const scratch = join(releaseRoot, "var/agent-tmp");

function snapshot(root: string): string[] {
	return readdirSync(root).sort().flatMap(name => {
		const file = join(root, name);
		const stat = lstatSync(file);
		return stat.isDirectory() ? [`${name}:directory`, ...snapshot(file).map(row => `${name}/${row}`)] : [`${name}:${stat.mode & 0o777}:${readFileSync(file).toString("hex")}`];
	});
}

test("rendering the memory-off recipe never touches an operator profile or project", () => {
	const isolated = mkdtempSync(join(scratch, "profile-recipes-"));
	try {
		mkdirSync(join(isolated, "home"));
		mkdirSync(join(isolated, "project"));
		writeFileSync(join(isolated, "home", "config.yml"), "memory:\n  backend: mnemopi\n");
		writeFileSync(join(isolated, "project", "keep"), "private");
		const before = snapshot(isolated);
		const recipe = renderRecipe("memory-off", releaseRoot);
		const parsed = Bun.YAML.parse(recipe.content) as Record<string, unknown>;
		expect(parsed.memory).toEqual({ backend: "off" });
		expect(recipe).toMatchObject({ kind: "memory-off", version: 1, status: "UNVERIFIED" });
		expect(snapshot(isolated)).toEqual(before);
	} finally {
		rmSync(isolated, { recursive: true, force: true });
	}
});

test("manual Mnemopi recipe isolates project banks and disables every automatic or model-backed memory route", () => {
	const recipe = renderRecipe("mnemopi-manual", releaseRoot);
	const parsed = Bun.YAML.parse(recipe.content) as Record<string, unknown>;
	expect(parsed.memory).toEqual({ backend: "mnemopi" });
	expect(parsed.mnemopi).toEqual({ scoping: "per-project", autoRetain: false, autoRecall: false, noEmbeddings: true, llmMode: "none" });
	expect(recipe.guidance).toMatch(/manual retain.*private/i);
	expect(recipe.status).toBe("UNVERIFIED");
});

test("model role recipe contains no runnable choice, fallback, provider enablement, or credential", () => {
	const recipe = renderRecipe("model-roles", releaseRoot);
	const parsed = Bun.YAML.parse(recipe.content) as Record<string, unknown>;
	expect(parsed).toEqual({ modelRoles: {} });
	expect(recipe.status).toBe("UNVERIFIED");
	expect(recipe.guidance).toMatch(/missing role.*NOT VERIFIED/i);
	expect(recipe.guidance).toMatch(/unavailable.*NOT VERIFIED/i);
	expect(recipe.guidance).toMatch(/disabled provider.*NOT VERIFIED/i);
	for (const kind of ["memory-off", "mnemopi-manual", "model-roles"] as const) {
		const rendered = renderRecipe(kind, releaseRoot);
		expect(rendered.content + rendered.guidance).not.toMatch(/\/Users\/|\/home\/|https?:\/\/|api[_-]?key|sk-[A-Za-z0-9]/i);
	}
});

test("profile name validation refuses default, invalid and already-owned names without touching them", () => {
	const occupied = ["existing", "another"];
	for (const name of ["default", "", "../existing", "CON", "existing", " existing ", "another"]) {
		expect(() => validateRecipeProfileName(name, occupied)).toThrow();
	}
	expect(validateRecipeProfileName("fresh-profile", occupied)).toBe("fresh-profile");
	expect(occupied).toEqual(["existing", "another"]);
});

test("rendering a recipe refuses a symlinked asset directory rather than disclosing its target", () => {
	const isolated = mkdtempSync(join(scratch, "profile-recipes-link-"));
	try {
		const release = join(isolated, "release");
		const privateDir = join(isolated, "private");
		mkdirSync(join(release, "examples", "profiles"), { recursive: true });
		mkdirSync(privateDir);
		writeFileSync(join(privateDir, "memory-off.yml"), "private content must not be rendered\n");
		symlinkSync(privateDir, join(release, "examples", "profiles", "v1"));
		expect(() => renderRecipe("memory-off", release)).toThrow(/unsafe|symlink|directory/i);
	} finally {
		rmSync(isolated, { recursive: true, force: true });
	}
});
