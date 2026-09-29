import { applyMutation, planMutation, undoMutation } from "../../src/mutations.ts";

const stateRoot = process.argv[2];
const root = process.argv[3];
if (!stateRoot || !root) throw new Error("Expected disposable state and root paths");
const undoId = process.argv[4];
if (undoId) {
	undoMutation(stateRoot, undoId, { confirmed: true, onBoundary: boundary => {
		if (boundary === "renamed:1") process.kill(process.pid, "SIGKILL");
	} });
	throw new Error("Expected the inverse process death boundary");
}
applyMutation(planMutation({ stateRoot, roots: [{ id: "home", path: root }], files: [
	{ root: "home", relativePath: "crash-probe.txt", expectedBefore: null,
		after: { bytes: Buffer.from("committed after rename\n"), mode: 0o600 } },
] }), { onBoundary: boundary => {
	if (boundary === "renamed:0") process.kill(process.pid, "SIGKILL");
} });
throw new Error("Expected the one-file process death boundary");
