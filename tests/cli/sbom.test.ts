import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { releaseComponents, spdxSbom, sbomFromArchive } from "../../scripts/package-release.ts";
import { ownedTmp } from "../../src/kitlib/tmp.ts";

const root = resolve(import.meta.dir, "../..");
const input = {
	version: "1.2.3", key: "darwin-arm64-none", filename: "omp-kit-v1.2.3-darwin-arm64-none.tar",
	archiveSha: "a".repeat(64), binarySha: "b".repeat(64), bunVersion: Bun.version,
	files: [{ path: "bin/omp-kit", sha256: "b".repeat(64) }],
};

test("current source SBOM inventories real embedded libraries and the pinned SDK, not compatibility aliases", () => {
	const document = spdxSbom({ ...input, components: releaseComponents(root) });
	expect(document.packages.length).toBeGreaterThan(10);
	for (const pkg of document.packages) {
		expect(pkg.name.trim()).not.toBe("");
		expect(pkg.versionInfo.trim()).not.toBe("");
	}
	expect(document.packages).toContainEqual(expect.objectContaining({ name: "sqlite", versionInfo: process.versions.sqlite }));
	expect(document.packages).toContainEqual(expect.objectContaining({ name: "boringssl", versionInfo: process.versions.boringssl }));
	expect(document.packages).toContainEqual(expect.objectContaining({ name: "tern-sdk", versionInfo: JSON.parse(readFileSync(join(root, "src/tern/catalog.json"), "utf8")).sdk_commit }));
	for (const alias of ["node", "v8", "openssl", "uv", "napi", "modules", "zig"])
		expect(document.packages.some(pkg => pkg.name === alias)).toBe(false);
	for (const pkg of document.packages.slice(3))
		expect(document.relationships).toContainEqual(expect.objectContaining({ relationshipType: "CONTAINS", relatedSpdxElement: pkg.SPDXID }));
});

test("empty, malformed, unreadable and empty-graph lockfiles refuse rather than emit a partial SBOM", () => {
	const tmp = ownedTmp("sbom-lock");
	try {
		for (const bytes of ["", "{", '{"lockfileVersion":1,"packages":{}}']) {
			writeFileSync(join(tmp.path, "bun.lock"), bytes);
			expect(() => releaseComponents(tmp.path)).toThrow("SBOM_LOCKFILE_INVALID");
		}
		mkdirSync(join(tmp.path, "unreadable.lock"));
		expect(() => releaseComponents(root, join(tmp.path, "unreadable.lock"))).toThrow("SBOM_LOCKFILE_UNREADABLE");
		expect(() => releaseComponents(root, join(tmp.path, "missing.lock"))).toThrow("SBOM_LOCKFILE_UNREADABLE");
	} finally { tmp.cleanup(); }
});

test("lockfile runtime dependency closure includes scoped/transitive packages and excludes dev-only packages", () => {
	const tmp = ownedTmp("sbom-graph");
	try {
		const lock = join(tmp.path, "bun.lock");
		writeFileSync(lock, JSON.stringify({ lockfileVersion: 1,
			workspaces: { "": { dependencies: { "@example/app": "1.0.0" }, devDependencies: { tooling: "9.0.0" } } },
			packages: {
				"@example/app": ["@example/app@1.0.0", "", { dependencies: { leaf: "2.0.0" } }, "hash"],
				leaf: ["leaf@2.0.0", "", {}, "hash"], tooling: ["tooling@9.0.0", "", {}, "hash"],
			} }));
		const packages = releaseComponents(root, lock);
		expect(packages).toContainEqual(expect.objectContaining({ name: "@example/app", version: "1.0.0" }));
		expect(packages).toContainEqual(expect.objectContaining({ name: "leaf", version: "2.0.0" }));
		expect(packages.some(pkg => pkg.name === "tooling")).toBe(false);
	} finally { tmp.cleanup(); }
});

test("archive SBOM uses the packaged builder inventory, binds final archive bytes, and refuses a missing inventory", async () => {
	const components = releaseComponents(root).map(component => component.name === "sqlite" ? { ...component, version: "3.50.0" } : component);
	const files = { "bin/omp-kit": "binary fixture", "release-components.json": JSON.stringify({ bunVersion: Bun.version, components }),
		"release-manifest.json": JSON.stringify({ schema_version: 1, version: "1.2.3", source_tag: "v1.2.3", files: input.files }) };
	const archive = await new Bun.Archive(files).bytes();
	const document = await sbomFromArchive(archive, input.filename);
	expect(document.packages).toContainEqual(expect.objectContaining({ name: "sqlite", versionInfo: "3.50.0" }));
	expect(document.packages[0]?.checksums?.[0]?.checksumValue).toBe(new Bun.CryptoHasher("sha256").update(archive).digest("hex"));
	const missing = await new Bun.Archive({ "bin/omp-kit": "binary fixture" }).bytes();
	await expect(sbomFromArchive(missing, input.filename)).rejects.toThrow("SBOM_INVENTORY_MISSING");
});
