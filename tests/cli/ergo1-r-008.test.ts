// Pass when attached string values preserve every '=': heavy's runtime-budget diagnostic identifies a=b=c exactly, as separate argv does.
// The child only sleeps; this is the explicitly requested read-only heavy probe, not a build or mutating child.
import { expect, test } from "bun:test";
import { resolve, join } from "node:path";
import { ownedTmp } from "../../src/kitlib/tmp.ts";
import { run as runCommand } from "../../src/kitlib/run";
const entry = resolve(import.meta.dir, "../../src/cli.ts");
async function run(label: string[]) {
 const tmp = ownedTmp("ergo1-equals");
 try {
  const p = await runCommand([process.execPath, entry, "heavy", ...label, "--disk-observer", "statfs", "--max-runtime", "1", "--", "sleep", "5"], {
   cwd: tmp.path, deadline_s: 20,
   env: { ...process.env, HOME: tmp.path, XDG_CONFIG_HOME: join(tmp.path, "config"), XDG_STATE_HOME: join(tmp.path, "state"), NO_COLOR: "1" },
  });
  return { code: p.rc, text: Buffer.from(p.stderr).toString() + Buffer.from(p.stdout).toString() };
 } finally { tmp.cleanup(); }
}
test("attached and separate labels survive into the runtime-budget error", async () => {
 const separate = await run(["--label", "a=b=c"]);
 expect(separate.code).toBe(124);
 expect(separate.text).toContain("RUNTIME_BUDGET_EXCEEDED");
 expect(separate.text).toContain("a=b=c");
 const attached = await run(["--label=a=b=c"]);
 expect(attached.code).toBe(124);
 expect(attached.text).toContain("RUNTIME_BUDGET_EXCEEDED");
 expect(attached.text).toContain("a=b=c");
}, 45000);
for (const flag of ["--label=", "--no-wait=true"]) test(`${flag} retains value refusal`, async () => {
 const p = await runCommand([process.execPath, entry, "heavy", flag, "--json"], { deadline_s: 15 });
 expect(p.rc).toBe(2);
 expect(JSON.parse(Buffer.from(p.stdout).toString()).errors[0].code).toBe(flag === "--label=" ? "MISSING_VALUE" : "UNEXPECTED_VALUE");
});
