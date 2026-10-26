import { expect, test } from "bun:test";
import { checkGapMentions, type FlywheelExec } from "../../extensions/kit-flywheel-guard";
import { run } from "../../src/kitlib/run";

const cwd = import.meta.dir + "/../..";
const exec: FlywheelExec = async (command, args, options) => {
  const result = await run([command, ...args], { cwd: options?.cwd, deadline_s: 30 });
  return { stdout: new TextDecoder().decode(result.stdout), stderr: new TextDecoder().decode(result.stderr), code: result.rc ?? 1, killed: result.killed };
};
for (const [name, text, blocked] of [
  ["positive", "the gate should say X", true],
  ["bead citation", "the gate should say X, see ompkit-ab12c", false],
  ["quoted negative", 'adds the test "a defect row"', false],
] as const) {
  test(`GAPFADE1 br comments ${name}`, async () => {
    console.log(new Date().toISOString(), name);
    const result = await checkGapMentions({ toolName: "bash", input: { command: `br comments add ompkit-ab12c '${text}'` } }, exec, cwd);
    expect(result?.block === true).toBe(blocked);
    if (blocked) expect(result?.reason).toContain("GAP_UNFILED");
  });
  test(`GAPFADE1 DONE mail ${name}`, async () => {
    console.log(new Date().toISOString(), "DONE", name);
    const result = await checkGapMentions({ toolName: "write", input: { path: "xd://mcp__mcp_agent_mail_send_message", content: JSON.stringify({ subject: `DONE ${text}` }) } }, exec, cwd);
    expect(result?.block === true).toBe(blocked);
  });
}
