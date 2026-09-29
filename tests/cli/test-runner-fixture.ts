import process from "node:process";
import { runFastTest } from "../../src/test-runner.ts";

const inputText = process.env.OMP_KIT_TEST_INPUT;
if (!inputText) {
	process.stderr.write("test-runner fixture: OMP_KIT_TEST_INPUT is required\n");
	process.exitCode = 3;
} else {
	try {
		const input: unknown = JSON.parse(inputText);
		const report = await runFastTest(input as Parameters<typeof runFastTest>[0]);
		process.stdout.write(`${JSON.stringify(report)}\n`);
		process.exitCode = report.exitCode;
	} catch (error) {
		process.stderr.write(`test-runner fixture: ${error instanceof Error ? error.message : String(error)}\n`);
		process.exitCode = 3;
	}
}
