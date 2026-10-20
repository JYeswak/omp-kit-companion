/**
 * ext-manifest.test.ts (bead ompkit-fp72.135.1.10 EXTMANIFEST1): every
 * non-test extensions/*.ts is either loaded through package.json
 * omp.extensions or named in omp.notLoadedExtensions with a reason, so a
 * shipped-but-never-loaded extension can never silently recur.
 */
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import secretOutputGuard from "./secret-output-guard";
import * as writeLedger from "./kit-write-ledger";
const ROOT = resolve(import.meta.dir, "..");

export interface ExtensionManifest {
	extensions: string[];
	notLoadedExtensions: Record<string, string>;
}

export function loadManifest(root: string): ExtensionManifest {
	const raw: unknown = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
	if (!raw || typeof raw !== "object" || !("omp" in raw) || !raw.omp || typeof raw.omp !== "object")
		throw new Error("package.json has no omp section");
	const omp = raw.omp as Record<string, unknown>;
	if (!Array.isArray(omp.extensions) || !omp.extensions.every((entry) => typeof entry === "string"))
		throw new Error("package.json omp.extensions is not a string list");
	if (!omp.notLoadedExtensions || typeof omp.notLoadedExtensions !== "object" || Array.isArray(omp.notLoadedExtensions))
		throw new Error("package.json omp.notLoadedExtensions is not a reason map");
	for (const [file, reason] of Object.entries(omp.notLoadedExtensions as Record<string, unknown>)) {
		if (typeof reason !== "string" || reason.trim().length === 0)
			throw new Error(`${file} has an empty not-loaded reason`);
	}
	return {
		extensions: omp.extensions as string[],
		notLoadedExtensions: omp.notLoadedExtensions as Record<string, string>,
	};
}

/** Non-test extension entrypoints shipped in extensions/. */
export function shippedExtensions(root: string): string[] {
	return readdirSync(join(root, "extensions"))
		.filter((entry) => entry.endsWith(".ts") && !entry.endsWith(".test.ts"))
		.sort()
		.map((entry) => `extensions/${entry}`);
}

export interface CoverageCheck {
	ok: boolean;
	unlisted: string[];
	overlap: string[];
}

/** Pure check so planted negatives run without touching the tree. */
export function checkExtensionCoverage(
	files: string[],
	listed: string[],
	notLoaded: Record<string, string>,
): CoverageCheck {
	const inListed = new Set(listed);
	const inNotLoaded = new Set(Object.keys(notLoaded));
	const unlisted = files.filter((file) => !inListed.has(file) && !inNotLoaded.has(file));
	const overlap = files.filter((file) => inListed.has(file) && inNotLoaded.has(file));
	return { ok: unlisted.length === 0 && overlap.length === 0, unlisted, overlap };
}

test("control: every shipped non-test extension is listed or explicitly not-loaded", () => {
	const manifest = loadManifest(ROOT);
	const files = shippedExtensions(ROOT);
	const check = checkExtensionCoverage(files, manifest.extensions, manifest.notLoadedExtensions);
	expect({ unlisted: check.unlisted, overlap: check.overlap }).toEqual({ unlisted: [], overlap: [] });
	expect(check.ok).toBe(true);
});

test("planted: an unlisted new extension fails the check", () => {
	const manifest = loadManifest(ROOT);
	const files = [...shippedExtensions(ROOT), "extensions/evil-new-guard.ts"];
	const check = checkExtensionCoverage(files, manifest.extensions, manifest.notLoadedExtensions);
	expect(check.ok).toBe(false);
	expect(check.unlisted).toEqual(["extensions/evil-new-guard.ts"]);
});

test("planted: dropping a not-loaded reason re-opens the gap", () => {
	const manifest = loadManifest(ROOT);
	const { "extensions/kit-write-ledger.ts": _dropped, ...rest } = manifest.notLoadedExtensions;
	const check = checkExtensionCoverage(shippedExtensions(ROOT), manifest.extensions, rest);
	expect(check.ok).toBe(false);
	expect(check.unlisted).toEqual(["extensions/kit-write-ledger.ts"]);
});

test("secret-output-guard is a loaded entrypoint with a default export", () => {
	const manifest = loadManifest(ROOT);
	expect(manifest.extensions).toContain("extensions/secret-output-guard.ts");
	expect(typeof secretOutputGuard).toBe("function");
});

test("kit-write-ledger is a not-loaded library with no default export", () => {
	const manifest = loadManifest(ROOT);
	expect(manifest.extensions).not.toContain("extensions/kit-write-ledger.ts");
	const reason = manifest.notLoadedExtensions["extensions/kit-write-ledger.ts"];
	expect(typeof reason).toBe("string");
	expect(reason!.length).toBeGreaterThan(0);
	expect("default" in writeLedger).toBe(false);
	expect(typeof writeLedger.appendLedgerEntry).toBe("function");
});

test("both modules import from the packaged tree (packaging load probe)", () => {
	for (const entry of ["extensions/secret-output-guard.ts", "extensions/kit-write-ledger.ts"]) {
		const probed = Bun.spawnSync([process.execPath, "-e", `import("./${entry}")`], {
			cwd: ROOT,
			stdout: "pipe",
			stderr: "pipe",
		});
		const detail = `${probed.stdout.toString()}${probed.stderr.toString()}`.trim();
		expect(`${entry} exit=${probed.exitCode} ${detail}`.trim()).toStartWith(`${entry} exit=0`);
	}
});

test("every manifest entry names a real file, and no file is both listed and not-loaded", () => {
	const manifest = loadManifest(ROOT);
	for (const file of [...manifest.extensions, ...Object.keys(manifest.notLoadedExtensions)]) {
		expect(file.endsWith(".ts")).toBe(true);
		// Throws ENOENT when the manifest names a file that is not shipped.
		readFileSync(join(ROOT, file), "utf8");
	}
	const overlap = manifest.extensions.filter((file) => file in manifest.notLoadedExtensions);
	expect(overlap).toEqual([]);
});
