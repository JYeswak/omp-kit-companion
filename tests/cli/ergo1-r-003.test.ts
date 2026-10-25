// Pass when intent aliases produce registry-valid semantic guidance (or read-only next), never edit-distance next -> test.
import { expect, test } from "bun:test";
import { resolve } from "node:path";
import { run as runBounded } from "../../src/kitlib/run";
const entry = resolve(import.meta.dir, "../../src/cli.ts");
async function run(args: string[]) {
 const p = await runBounded([process.execPath, entry, ...args], { deadline_s: 15, env: { ...process.env, NO_COLOR: "1", CI: "true", TERM: "dumb" } });
 const stdout = new TextDecoder().decode(p.stdout);
 return { code: p.rc, text: stdout + new TextDecoder().decode(p.stderr), stdout };
}
test("next intent never redirects the agent to unrelated test", async () => {
 const p = await run(["next", "--json"]);
 expect(p.text).not.toContain("Try omp-kit test");
 if (p.code === 2) {
  expect(p.text).toContain("next");
  expect(JSON.parse(p.stdout).errors[0].code).toBe("INVALID_ROLE");
  expect(p.text).toContain("next --role");
 } else expect(JSON.parse(p.stdout).data).toHaveProperty("next_action");
});
test("legible inspect intent redirects to status without executing it", async () => {
 const p = await run(["inspect", "--json"]);
 expect(p.code).toBe(2);
 const body = JSON.parse(p.stdout);
 expect(JSON.stringify(body.errors)).toContain("omp-kit status");
 expect(body.meta.verification).toBe("NOT_RUN");
});
