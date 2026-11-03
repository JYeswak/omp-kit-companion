import { run, type RunOptions } from "../../src/kitlib/run.ts";

/** Keep fixture assertions on real exit codes and bytes, never timeout-shaped refusals. */
export async function releaseProcess(argv: readonly string[], options: {
 cwd?: string; env?: Record<string, string | undefined>; deadline_s: number;
 stdout?: "pipe"; stderr?: "pipe";
}) {
 const input: RunOptions = { deadline_s: options.deadline_s, cwd: options.cwd, max_output_bytes: 4 * 1024 * 1024 };
 if (options.env) input.env = Object.fromEntries(Object.entries(options.env)
  .filter((entry): entry is [string, string] => entry[1] !== undefined));
 const result = await run(argv, input);
 const stdout = Buffer.from(result.stdout.buffer, result.stdout.byteOffset, result.stdout.byteLength);
 const stderr = Buffer.from(result.stderr.buffer, result.stderr.byteOffset, result.stderr.byteLength);
 if (result.rc === null || result.timed_out || result.killed || result.truncated || result.total_truncated)
  throw new Error(`Release fixture process incomplete (${argv[0]}): ${stdout.toString()}\n${stderr.toString()}`);
 return { exitCode: result.rc, stdout, stderr };
}
