import { createHash } from "node:crypto";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

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
