// Pass when single-edit/transposition hints prioritize the current command and globals; --robto must correct to --robot, never --root.
import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { run } from "../../src/kitlib/run";
const entry = resolve(import.meta.dir, "../../src/cli.ts");
async function refusal(args: string[]) {
 const p = await run([process.execPath, entry, ...args, "--json"], { deadline_s: 15, env: { ...process.env, NO_COLOR: "1" } });
 expect(p.rc).toBe(2);
 expect(new TextDecoder().decode(p.stderr)).toBe("");
 return JSON.parse(new TextDecoder().decode(p.stdout)).errors;
}
for (const typo of ["--josn", "--jso", "--jsno", "--jsson"]) test(`${typo} teaches exact JSON spelling`, async () => {
 expect(JSON.stringify(await refusal(["capabilities", typo]))).toContain("Use --json exactly");
});
test("robot transposition cannot collide into root", async () => {
 const errors = JSON.stringify(await refusal(["capabilities", "--robto"]));
 expect(errors).toContain("Use --robot exactly");
 expect(errors).not.toContain("Use --root");
});
test("local label typo outranks unrelated flags without leaking values", async () => {
 const errors = JSON.stringify(await refusal(["heavy", "--lable=PRIVATE_TOKEN_DO_NOT_ECHO"]));
 expect(errors).toContain("Use --label exactly");
 expect(errors).not.toContain("PRIVATE_TOKEN_DO_NOT_ECHO");
});
test("an unrelated label flag is not offered as a capabilities correction", async () => {
 const errors = JSON.stringify(await refusal(["capabilities", "--labl"]));
 expect(errors).not.toContain("Use --label exactly");
});
