import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import process from "node:process";

let bundledHarness: Uint8Array | undefined;

/** Match package-release.ts: relocated fixtures have no checkout source tree. */
export function writeBundledHarness(root: string): void {
	if (!bundledHarness) {
		const repo = resolve(import.meta.dir, "../..");
		const build = Bun.spawnSync([process.execPath, "build", join(repo, "scripts/ttsr-harness.ts"),
			"--target=bun", "--format=esm"], { cwd: repo, stdout: "pipe", stderr: "pipe" });
		if (build.exitCode !== 0) throw new Error(`fixture harness bundle failed (${build.exitCode}): ${build.stderr.toString()}`);
		bundledHarness = build.stdout;
	}
	mkdirSync(join(root, "scripts"), { recursive: true });
	writeFileSync(join(root, "scripts/ttsr-harness.ts"), bundledHarness);
}

export function writeReleaseManifest(root: string): void {
	const files: { path: string; sha256: string }[] = [];
	const visit = (directory: string) => {
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const path = join(directory, entry.name);
			if (entry.isDirectory()) visit(path);
			else if (entry.isFile()) {
				const name = relative(root, path);
				if (name !== "release-manifest.json") files.push({ path: name, sha256: createHash("sha256").update(readFileSync(path)).digest("hex") });
			} else throw new Error(`fixture release contains a non-regular entry: ${path}`);
		}
	};
	visit(root);
	files.sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0);
	writeFileSync(join(root, "release-manifest.json"), JSON.stringify({ schema_version: 1, version: "1.0.0", source_tag: "v1.0.0", files }));
}
