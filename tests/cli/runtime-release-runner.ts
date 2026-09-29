import process from "node:process";
import { runBundled } from "../../src/runtime.ts";

const root = process.env.OMP_KIT_FIXTURE_ROOT;
const executable = process.env.OMP_KIT_FIXTURE_EXECUTABLE;
const script = process.env.OMP_KIT_FIXTURE_SCRIPT;
let args: string[];
try {
	const value: unknown = JSON.parse(process.env.OMP_KIT_FIXTURE_ARGS ?? "[]");
	if (!Array.isArray(value) || value.some((item) => typeof item !== "string")) throw new Error("fixture args must be a string array");
	args = value;
} catch (error) {
	process.stderr.write(`runtime fixture: ${error instanceof Error ? error.message : String(error)}\n`);
	process.exitCode = 2;
	args = [];
}

if (root && executable && script && process.exitCode !== 2) {
	try {
		const result = await runBundled(script, args, root, executable);
		process.stdout.write(result.stdout);
		process.stderr.write(result.stderr);
		process.exitCode = result.code;
	} catch (error) {
		process.stderr.write(`runtime fixture: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 2;
	}
} else if (process.exitCode !== 2) {
	process.stderr.write("runtime fixture: missing release, executable, or script input\n");
	process.exitCode = 2;
}
