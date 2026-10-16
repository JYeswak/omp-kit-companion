import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
	chunkLuauMembers,
	diffManifests,
	formatManifest,
	gradeRetrievalSystems,
	isPrintHtml,
	listTernCommands,
	matchCitedBeads,
	MAX_LUAU_BYTES,
	normalizeStartUrl,
	parseManifest,
	parseTernVersion,
	resolveCrawlLink,
	resolveTernRefRoot,
	ternRefDirFor,
	TernRefInputError,
	type TernRefManifest,
} from "../../src/tern-ref.ts";

const pilotLuau = resolve(import.meta.dir, "fixtures", "tern-ref-0.9.0-tern.d.luau");

function throwsCode(fn: () => unknown, code: string): void {
	try {
		fn();
	} catch (error) {
		expect((error as TernRefInputError).code).toBe(code);
		return;
	}
	throw new Error(`expected throw ${code}, nothing threw`);
}

function manifest(overrides: Partial<TernRefManifest> = {}): TernRefManifest {
	return {
		manifest_version: 1,
		tern_version: "0.9.0",
		tern_commit: "56bd59f",
		pages: [{ url: "https://docs.stencil.so/tern/index.html", etag: "\"abc\"", sha256: "00".repeat(32) }],
		chunk_count: 1,
		chunk_sha256: ["11".repeat(32)],
		index_model: "nomic-embed-text",
		built_at: "2026-10-16T00:00:00Z",
		...overrides,
	};
}

describe("normalizeStartUrl", () => {
	test("appends a trailing slash to a bare docs path", () => {
		expect(normalizeStartUrl("https://docs.stencil.so/tern")).toBe("https://docs.stencil.so/tern/");
	});
	test("keeps a trailing slash, query, and hash", () => {
		expect(normalizeStartUrl("https://docs.stencil.so/tern/?a=b#c")).toBe("https://docs.stencil.so/tern/?a=b#c");
	});
	test("file URLs stay slashless so relative links resolve beside them", () => {
		expect(normalizeStartUrl("https://docs.stencil.so/tern/index.html")).toBe("https://docs.stencil.so/tern/index.html");
		expect(resolveCrawlLink("https://docs.stencil.so/tern/index.html", "guides/lenses.html")).toBe("https://docs.stencil.so/tern/guides/lenses.html");
	});
	test("PLANT: slashless start misresolves a relative link (today's crawler defect)", () => {
		expect(resolveCrawlLink("https://docs.stencil.so/tern", "install.html")).toBe("https://docs.stencil.so/install.html");
		expect(resolveCrawlLink(normalizeStartUrl("https://docs.stencil.so/tern"), "install.html")).toBe("https://docs.stencil.so/tern/install.html");
	});
	test("refuses a non-URL", () => {
		expect(() => normalizeStartUrl("not a url")).toThrow(TernRefInputError);
	});
});

describe("isPrintHtml", () => {
	test("matches the per-page print view only", () => {
		expect(isPrintHtml("https://docs.stencil.so/tern/print.html")).toBe(true);
		expect(isPrintHtml("https://docs.stencil.so/tern/install.html")).toBe(false);
		expect(isPrintHtml("https://docs.stencil.so/tern/printing-press.html")).toBe(false);
		expect(isPrintHtml("garbage")).toBe(false);
	});
});

describe("chunkLuauMembers", () => {
	test("one chunk per member on the real 0.9.0 tern.d.luau with parent names kept", () => {
		const text = readFileSync(pilotLuau, "utf8");
		const members = chunkLuauMembers(text);
		const openers = text.split("\n").filter((l) => l.startsWith("export type ") || l.startsWith("declare ")).length;
		expect(members.length).toBe(openers);
		expect(members.length).toBeGreaterThan(100);
		expect(members[0]?.name).toBe("Context");
		const plugin = members.find((m) => m.name === "PluginInfo");
		expect(plugin?.kind).toBe("type");
		expect(plugin?.text).toContain("Manifest `id`.");
		const ternModule = members.find((m) => m.name === "tern");
		expect(ternModule?.kind).toBe("module");
		expect(ternModule?.text).toContain("carly");
	});
	test("declare-extern form opens a member", () => {
		const members = chunkLuauMembers("--- Sessions.\ndeclare extern type SessionsCx with\n\tfoo: string,\nend\n");
		expect(members.length).toBe(1);
		expect(members[0]?.name).toBe("SessionsCx");
	});
	test("rejects a file with no member opens instead of indexing one blob", () => {
		throwsCode(() => chunkLuauMembers("-- just a comment\nprint('hi')\n"), "NO_LUAU_MEMBERS");
	});
	test("refuses input over the byte cap", () => {
		throwsCode(() => chunkLuauMembers("x".repeat(MAX_LUAU_BYTES + 1)), "LUAU_TOO_LARGE");
	});
	test("long near-miss stays fast (regex-engineering §7)", () => {
		const nearMiss = `${"declare ".repeat(1)}${"x".repeat(5000)}\n`.repeat(200);
		const start = performance.now();
		throwsCode(() => chunkLuauMembers(nearMiss), "NO_LUAU_MEMBERS");
		expect(performance.now() - start).toBeLessThan(1000);
	});
});

describe("manifest round-trip", () => {
	test("format then parse preserves every field", () => {
		const parsed = parseManifest(formatManifest(manifest()));
		expect(parsed).toEqual(manifest());
	});
	test("refuses a wrong version, an empty field, and non-JSON", () => {
		throwsCode(() => parseManifest(formatManifest(manifest()).replace('"manifest_version": 1', '"manifest_version": 2')), "INVALID_MANIFEST");
		throwsCode(() => parseManifest(formatManifest(manifest({ tern_commit: "" }))), "INVALID_MANIFEST");
		throwsCode(() => parseManifest("{nope"), "INVALID_MANIFEST");
	});
});

describe("diffManifests", () => {
	test("identical manifests need no reindex", () => {
		const diff = diffManifests(manifest(), manifest());
		expect(diff.needs_reindex).toBe(false);
		expect(diff.changed_urls).toEqual([]);
	});
	test("a version bump forces reindex even with identical pages", () => {
		const diff = diffManifests(manifest(), manifest({ tern_version: "0.9.1", tern_commit: "aaaaaaa" }));
		expect(diff.version_changed).toBe(true);
		expect(diff.needs_reindex).toBe(true);
	});
	test("a changed page ETag names the URL and chunk movement", () => {
		const next = manifest({ pages: [{ url: "https://docs.stencil.so/tern/index.html", etag: "\"def\"", sha256: "00".repeat(32) }], chunk_sha256: ["22".repeat(32)] });
		const diff = diffManifests(manifest(), next);
		expect(diff.changed_urls).toEqual(["https://docs.stencil.so/tern/index.html"]);
		expect(diff.added_chunk_sha256).toEqual(["22".repeat(32)]);
		expect(diff.removed_chunk_sha256).toEqual(["11".repeat(32)]);
		expect(diff.needs_reindex).toBe(true);
	});
});

describe("matchCitedBeads", () => {
	const fixture = JSON.stringify([
		{ id: "ompkit-fp72.120.8", title: "TERNREF1 reference", description: "cites chunk PluginInfo" },
		{ id: "ompkit-other", title: "unrelated", description: "nothing here" },
	]);
	test("lists the citing bead only", () => {
		expect(matchCitedBeads(fixture, ["PluginInfo"])).toEqual([{ bead: "ompkit-fp72.120.8", anchor: "PluginInfo" }]);
	});
	test("no anchor hit means no beads, and bad JSON refuses", () => {
		expect(matchCitedBeads(fixture, ["NoSuchChunk"])).toEqual([]);
		throwsCode(() => matchCitedBeads("nope", ["x"]), "INVALID_BEAD_LIST");
	});
});

describe("state roots", () => {
	test("explicit root wins, env override next, default is version-keyed", () => {
		expect(resolveTernRefRoot("/tmp/x", {})).toBe("/tmp/x");
		expect(resolveTernRefRoot(undefined, { OMP_KIT_TERN_REF_ROOT: "/tmp/env" })).toBe("/tmp/env");
		expect(resolveTernRefRoot(undefined, { HOME: "/tmp/h", XDG_STATE_HOME: "/tmp/s" })).toBe("/tmp/s/omp-kit/tern-ref");
		expect(ternRefDirFor("/tmp/s/omp-kit/tern-ref", "0.9.0")).toBe("/tmp/s/omp-kit/tern-ref/0.9.0");
	});
	test("relative roots and non-versions refuse", () => {
		throwsCode(() => resolveTernRefRoot("rel", {}), "INVALID_STATE_ROOT");
		throwsCode(() => ternRefDirFor("/tmp/s", "0.9"), "INVALID_TERN_VERSION");
	});
});

describe("listTernCommands", () => {
	const helpFixture = resolve(import.meta.dir, "fixtures", "tern-ref-0.9.0-help.txt");
	test("required match: real 0.9.0 help yields the script commands", () => {
		const names = listTernCommands(readFileSync(helpFixture, "utf8"));
		for (const want of ["ls", "inspect", "new", "run", "browser", "send", "capture"]) expect(names).toContain(want);
	});
	test("reject: plugin subcommands and option lines never leak in", () => {
		const names = listTernCommands("  tern plugin list|reload|dir ...\n  tern open [--split X] PATH\n  tern --version\n");
		expect(names).toEqual([]);
	});
	test("wrapped pipe groups join before parsing", () => {
		expect(listTernCommands("  tern ls|inspect|new|split|run|move|pip|dock|rename|focus|close|kill|wait|keep-open|send|capture|\n      process|events|browser ...\n")).toContain("browser");
	});
	test("long near-miss stays fast (regex-engineering §7)", () => {
		const nearMiss = `${"  tern "}${"a|".repeat(3000)}${"9".repeat(3000)}\n`.repeat(50);
		const start = performance.now();
		listTernCommands(nearMiss);
		expect(performance.now() - start).toBeLessThan(1000);
	});
});

describe("parseTernVersion", () => {
	test("parses the installed 0.9.0 banner", () => {
		expect(parseTernVersion("tern 0.9.0 (56bd59f)\n")).toEqual({ version: "0.9.0", commit: "56bd59f" });
	});
	test("rejects foreign banners", () => {
		throwsCode(() => parseTernVersion("tern 0.9\n"), "BAD_TERN_VERSION");
	});
});

describe("gradeRetrievalSystems", () => {
	const sealed = JSON.stringify({
		systems: [{ name: "nomic" }, { name: "qwen" }],
		queries: [{ qid: "q1" }, { qid: "q2" }],
		runs: { nomic: { q1: ["c1", "c2"], q2: ["c3", "c4"] }, qwen: { q1: ["c2", "c1"], q2: ["c4", "c3"] } },
	});
	const labelsA = '{"item":"c1","grade":2}\n{"item":"c2","grade":0}\n{"item":"c3","grade":1}\n{"item":"c4","grade":0}\n';
	const labelsB = '{"item":"c1","grade":2}\n{"item":"c2","grade":1}\n{"item":"c3","grade":1}\n{"item":"c4","grade":0}\n';
	test("rank-1 mean grades sort into correct/partial/miss", () => {
		expect(gradeRetrievalSystems(sealed, labelsA, labelsB)).toEqual({
			nomic: { correct: 1, partial: 1, miss: 0 },
			qwen: { correct: 0, partial: 1, miss: 1 },
		});
	});
	test("unlabelled pooled items and empty ranks refuse", () => {
		const one = '{"item":"c1","grade":2}\n';
		throwsCode(() => gradeRetrievalSystems(sealed, one, one), "UNLABELLED_ITEM");
		const empty = JSON.stringify({ systems: [{ name: "nomic" }], queries: [{ qid: "q1" }], runs: { nomic: { q1: [] } } });
		throwsCode(() => gradeRetrievalSystems(empty, labelsA, labelsB), "EMPTY_RANK");
	});
});
