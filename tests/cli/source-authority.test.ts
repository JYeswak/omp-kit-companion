import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { authorizeSourceAct } from "../../src/source-authority.ts";
const fixtures: string[] = [];
function fixture() { const base = mkdtempSync(join(resolve(import.meta.dir, "../../var/agent-tmp"), "source-act-")); fixtures.push(base); const canonical = join(base, "product"), frozen = join(base, "frozen"); for (const root of [canonical, frozen]) { mkdirSync(join(root, "src"), { recursive: true }); writeFileSync(join(root, "src", "entry.ts"), "export const ok = true;\n"); } return { canonical, frozen }; }
afterEach(() => { for (const path of fixtures.splice(0)) rmSync(path, { recursive: true, force: true }); });
test("frozen copy refuses product build and canonical source passes", () => { const f = fixture(); expect(() => authorizeSourceAct({ canonicalRoot: f.canonical, frozenRoots: [f.frozen] }, { path: join(f.frozen, "src"), act: "build" })).toThrow(/SOURCE_ROOT_MISMATCH/); expect(authorizeSourceAct({ canonicalRoot: f.canonical }, { path: join(f.canonical, "src"), act: "build" }).status).toBe("ALLOWED"); });
test("symlink alias resolves to canonical product root", () => { const f = fixture(); const alias = join(f.canonical, "alias"); symlinkSync(f.canonical, alias); expect(authorizeSourceAct({ canonicalRoot: f.canonical }, { path: join(alias, "src"), act: "edit" }).path).toBe(join(f.canonical, "src")); });
test("tracker and unpinned grade exports refuse delivery claims", () => { const f = fixture(); expect(() => authorizeSourceAct({ canonicalRoot: f.canonical }, { path: f.canonical, act: "publish", disposition: "tracker" })).toThrow(/SOURCE_ACT_NOT_PRODUCT/); expect(() => authorizeSourceAct({ canonicalRoot: f.canonical }, { path: f.canonical, act: "publish", disposition: "grade-export", readOnly: false })).toThrow(/SOURCE_GRADE_EXPORT_NOT_READONLY/); });
