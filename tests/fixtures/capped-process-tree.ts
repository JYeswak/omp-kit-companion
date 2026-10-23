import { join } from "node:path";
import { atomicReplaceBytes } from "../../src/kitlib/io.ts";
import { runWithCap } from "../../src/service-run.ts";

const [mode, root, cap = "10000"] = process.argv.slice(2);
if (!root) throw new Error("fixture root required");
if (mode === "runner") {
	const result = await runWithCap({ argv: [process.execPath, import.meta.path, "tree", root], cwd: root,
		env: { ...process.env } as Record<string, string>, capMs: Number(cap) });
	console.log(JSON.stringify(result));
	process.exit(result.exit ?? 1);
} else if (mode === "tree" || mode === "orphan") {
	process.on("SIGTERM", () => {});
	process.on("SIGINT", () => {});
	// Pollers read the PID files while the tree starts; a rename publishes
	// them whole, never as the empty file a truncating write first creates.
	atomicReplaceBytes(join(root, "child.pid"), Buffer.from(String(process.pid)), { mode: 0o600, durability: "none" });
	Bun.spawn([process.execPath, import.meta.path, "grandchild", root], { stdout: "inherit", stderr: "inherit" });
	if (mode === "orphan") {
		// Real-process readiness: let the grandchild establish its signal
		// handlers and inherited descriptors before its parent exits.
		const deadline = Date.now() + 3000;
		while (!(await Bun.file(join(root, "grandchild.pid")).exists())) {
			if (Date.now() >= deadline) throw new Error("grandchild did not start");
			await Bun.sleep(10);
		}
		process.exit(0);
	}
	setInterval(() => {}, 1000);
} else if (mode === "grandchild") {
	process.on("SIGTERM", () => {});
	process.on("SIGINT", () => {});
	atomicReplaceBytes(join(root, "grandchild.pid"), Buffer.from(String(process.pid)), { mode: 0o600, durability: "none" });
	console.log("grandchild-ready");
	console.error("grandchild-stderr");
	setInterval(() => {}, 1000);
} else if (mode === "exit") {
	await Bun.write(Bun.stdout, "actual stdout\n");
	await Bun.write(Bun.stderr, "actual stderr\n");
	process.exit(Number(cap));
} else if (mode === "pressure") {
	await Promise.all([Bun.write(Bun.stdout, "o".repeat(256 * 1024)), Bun.write(Bun.stderr, "e".repeat(256 * 1024))]);
} else {
	throw new Error(`unknown fixture mode ${mode}`);
}
