// One selected external rule, three data-only native WRITE scenarios, and private markers.
// The existing P09 mock server, config/model helpers, runtime adapter, and process limiter
// own protocol and process isolation; caller data never supplies an action or a path.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, readFileSync, realpathSync, symlinkSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const [workspaceArg] = process.argv.slice(2);
const fail = (reason) => { throw new Error(reason); };
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const trustedPath = "/usr/bin:/bin:/usr/sbin:/sbin";


function privateTempRoot() {
	if (process.platform === "darwin") {
		const result = Bun.spawnSync(["/usr/bin/getconf", "DARWIN_USER_TEMP_DIR"], {
			stdout: "pipe", stderr: "pipe", env: { PATH: trustedPath },
		});
		if (result.exitCode !== 0) fail("PRIVATE_TEMP_ROOT_UNAVAILABLE");
		return realpathSync(result.stdout.toString().trim());
	}
	if (process.platform === "linux") return realpathSync("/tmp");
	return fail("UNSUPPORTED_PLATFORM");
}
function assertWorkspace(path) {
	if (typeof path !== "string" || !isAbsolute(path)) fail("INVALID_PRIVATE_WORKSPACE");
	const real = realpathSync(path);
	const stat = lstatSync(path);
	const relativePath = relative(privateTempRoot(), real);
	if (stat.isSymbolicLink() || !stat.isDirectory() || (stat.mode & 0o777) !== 0o700
		|| (typeof process.getuid === "function" && stat.uid !== process.getuid())
		|| relativePath === ".." || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) fail("INVALID_PRIVATE_WORKSPACE");
	return real;
}
function exactKeys(value, keys) {
	return value && typeof value === "object" && !Array.isArray(value)
		&& Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
}
function readManifest(workspace) {
	const bytes = readFileSync(join(workspace, "run.json"));
	const manifest = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
	if (!exactKeys(manifest, ["rule", "ruleSha256", "scenarios"])
		|| typeof manifest.rule !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(manifest.rule)
		|| !/^[a-f0-9]{64}$/.test(manifest.ruleSha256)
		|| !Array.isArray(manifest.scenarios) || manifest.scenarios.length !== 3) fail("INVALID_PRIVATE_MANIFEST");
	for (const scenario of manifest.scenarios) {
		if (!exactKeys(scenario, ["id", "role", "content", "expected_marker_effect", "contentSha256"])
			|| typeof scenario.id !== "string" || !/^[a-z0-9][a-z0-9_-]{0,63}$/.test(scenario.id)
			|| !["allow", "block", "quiet"].includes(scenario.role)
			|| typeof scenario.content !== "string" || !["present", "absent"].includes(scenario.expected_marker_effect)
			|| !/^[a-f0-9]{64}$/.test(scenario.contentSha256)) fail("INVALID_PRIVATE_MANIFEST");
	}
	return manifest;
}
function readSelectedRule(workspace, manifest) {
	const bytes = readFileSync(join(workspace, "selected-rule.md"));
	if (sha256(bytes) !== manifest.ruleSha256) fail("SELECTED_RULE_CHANGED");
	return bytes;
}
function safeEnv(workspace) {
	const env = { PATH: `${join(workspace, "runtime-bin")}:${trustedPath}`, HOME: process.env.HOME ?? "", TMPDIR: process.env.TMPDIR ?? "",
		TMP: process.env.TMPDIR ?? "", TEMP: process.env.TMPDIR ?? "", LANG: process.env.LANG ?? "C",
		CI: "1", NO_COLOR: "1", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: join(process.env.HOME ?? "", ".gitconfig"),
		XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME ?? "", XDG_CACHE_HOME: process.env.XDG_CACHE_HOME ?? "",
		XDG_DATA_HOME: process.env.XDG_DATA_HOME ?? "", XDG_STATE_HOME: process.env.XDG_STATE_HOME ?? "",
		BUN_INSTALL: process.env.BUN_INSTALL ?? "", OMP: process.env.OMP ?? "", OMP_BIN: process.env.OMP_BIN ?? "",
		OMP_PATH: process.env.OMP_PATH ?? "", OMP_SRC: process.env.OMP_SRC ?? "", OMP_KIT_WORK_DIR: workspace };
	return Object.fromEntries(Object.entries(env).filter(([, value]) => value !== ""));
}
function runHelper(root, lib, args, workspace) {
	const result = Bun.spawnSync([process.execPath, lib, ...args], {
		cwd: root, env: { ...safeEnv(workspace), BUN_BE_BUN: "1" }, stdout: "pipe", stderr: "pipe",
	});
	if (result.exitCode !== 0) fail("P09_HELPER_FAILED");
}
async function waitForPort(child, portFile, stdout, stderr) {
	const deadline = performance.now() + 5_000;
	while (performance.now() < deadline) {
		if (child.exitCode !== null) {
			await Promise.all([stdout, stderr]);
			fail("MOCK_SERVER_EXITED");
		}
		if (existsSync(portFile) && lstatSync(portFile).isFile()) {
			const port = Number(readFileSync(portFile, "utf8"));
			if (Number.isInteger(port) && port > 0 && port <= 65535) return port;
			fail("MOCK_SERVER_INVALID_PORT");
		}
		await Bun.sleep(10);
	}
	fail("MOCK_SERVER_START_TIMEOUT");
}
async function runOmp(limiter, identity, project, workspace) {
	const child = Bun.spawn([limiter, "30", process.execPath, identity, "-p", "--no-session", "--model", "mock/mock",
		"--approval-mode", "yolo", "--tools", "write", "go"], {
		cwd: project, env: { ...safeEnv(workspace), BUN_BE_BUN: "1" },
		stdin: "ignore", stdout: "ignore", stderr: "ignore",
	});
	const code = await child.exited;
	const diagnostic = code === 0 ? "EXIT_ZERO" : code === 124 ? "TIMEOUT" : code === 137 ? "KILLED" : "NONZERO";
	return { code, diagnostic };
}
function nativeInterrupt(messages, selectedRule) {
	const prefix = `<system-interrupt reason="rule_violation" rule="${selectedRule}" `;
	return messages.some(message => {
		if (message?.role !== "user") return false;
		if (typeof message.content === "string") return message.content.startsWith(prefix);
		return Array.isArray(message.content) && message.content.some(block =>
			block && typeof block === "object" && !Array.isArray(block)
			&& block.type === "text" && typeof block.text === "string" && block.text.startsWith(prefix));
	});
}
function readRequests(logFile, selectedRule) {
	if (!existsSync(logFile)) return { count: 0, interrupted: false };
	const text = readFileSync(logFile, "utf8");
	const rows = text.trim() ? text.trim().split("\n").map(line => JSON.parse(line)) : [];
	const main = rows.filter(row => row.main === true && row.body && Array.isArray(row.body.messages));
	return { count: main.length, interrupted: main.some(row => nativeInterrupt(row.body.messages, selectedRule)) };
}
function markerEvidence(path, scenario) {
	if (!existsSync(path)) return { present: false, sha256: null, byte_length: 0 };
	const stat = lstatSync(path);
	if (stat.isSymbolicLink() || !stat.isFile()) return { present: true, sha256: null, byte_length: stat.size, unsafe: true };
	const bytes = readFileSync(path);
	return { present: true, sha256: sha256(bytes), byte_length: bytes.length,
		matches_expected: sha256(bytes) === scenario.contentSha256 };
}
function initializeProject(root, workspace) {
	const result = Bun.spawnSync(["/usr/bin/git", "init", "-q"], { cwd: root,
		env: { ...safeEnv(workspace), GIT_CONFIG_GLOBAL: "/dev/null" },
		stdin: "ignore", stdout: "ignore", stderr: "ignore" });
	if (result.exitCode !== 0) fail("PROJECT_REPOSITORY_SETUP_FAILED");
}
async function runScenario({ root, workspace, manifest, scenario, index, adapter, mock, limiter, identity, lib, modelsPath }) {
	const project = join(workspace, `project-${index}-${scenario.id}`);
	mkdirSync(project, { mode: 0o700 });
	initializeProject(project, workspace);
	const markerPath = join(project, ".omp-kit-markers", `${scenario.id}.marker`);
	mkdirSync(dirname(markerPath), { mode: 0o700 });
	const scenarioFile = join(workspace, `scenario-${index}.json`);
	const logFile = join(workspace, `model-${index}.jsonl`);
	const portFile = join(workspace, `port-${index}.txt`);
	writeFileSync(scenarioFile, JSON.stringify({ turns: [{ text: "Working on a public synthetic write.",
		tool: { name: "write", args: { path: markerPath, content: scenario.content } } }], chunk: 6 }), { flag: "wx", mode: 0o600 });
	const server = Bun.spawn([adapter, "--work-dir", workspace, "--scenario", scenarioFile,
		"--log", logFile, "--port-file", portFile, mock], {
		cwd: root, env: safeEnv(workspace), stdout: "pipe", stderr: "pipe",
	});
	const serverStdout = new Response(server.stdout).text();
	const serverStderr = new Response(server.stderr).text();
	let omp = { code: null, diagnostic: "NOT_RUN" };
	let request = { count: 0, interrupted: false };
	let marker = { present: false, sha256: null, byte_length: 0 };
	try {
		const port = await waitForPort(server, portFile, serverStdout, serverStderr);
		runHelper(root, lib, ["models", String(port), modelsPath], workspace);
		omp = await runOmp(limiter, identity, project, workspace);
		request = readRequests(logFile, manifest.rule);
		marker = markerEvidence(markerPath, scenario);
	} finally {
		if (server.exitCode === null) {
			try { server.kill(); } catch {}
		}
		await server.exited;
		await Promise.all([serverStdout, serverStderr]);
	}
	return {
		id: scenario.id, role: scenario.role, expected_marker_effect: scenario.expected_marker_effect,
		marker, native_system_interrupt: request.interrupted, model_main_requests: request.count,
		omp_exit_code: omp.code, omp_diagnostic: omp.diagnostic,
	};
}

async function main() {
	const workspace = assertWorkspace(workspaceArg);
	const root = realpathSync(resolve(dirname(fileURLToPath(import.meta.url)), ".."));
	const manifest = readManifest(workspace);
	const ruleBytes = readSelectedRule(workspace, manifest);
	const unique = new Set(manifest.scenarios.map(scenario => scenario.id));
	if (unique.size !== 3 || manifest.scenarios.filter(scenario => scenario.role === "allow").length !== 1
		|| manifest.scenarios.filter(scenario => scenario.role === "block").length !== 1
		|| manifest.scenarios.filter(scenario => scenario.role === "quiet").length !== 1
		|| manifest.scenarios.some(scenario => (scenario.role === "block") !== (scenario.expected_marker_effect === "absent"))) {
		fail("INVALID_PRIVATE_MANIFEST");
	}
	const identity = process.env.OMP;
	if (!identity || identity !== process.env.OMP_BIN || identity !== process.env.OMP_PATH || !isAbsolute(identity)) fail("OMP_IDENTITY_INVALID");
	const home = process.env.HOME;
	if (!home || !isAbsolute(home)) fail("PRIVATE_HOME_UNAVAILABLE");
	const runtimeBin = join(workspace, "runtime-bin");
	mkdirSync(runtimeBin, { mode: 0o700 });
	symlinkSync(realpathSync(process.execPath), join(runtimeBin, "bun"));
	const rulesHome = join(home, ".agents", "rules");
	const agentHome = join(home, ".omp", "agent");
	mkdirSync(rulesHome, { recursive: true, mode: 0o700 });
	mkdirSync(agentHome, { recursive: true, mode: 0o700 });
	writeFileSync(join(rulesHome, `${manifest.rule}.md`), ruleBytes, { flag: "wx", mode: 0o600 });
	const configPath = join(agentHome, "config.yml");
	const modelsPath = join(agentHome, "models.yml");
	const lib = join(root, "tests", "live", "lib.mjs");
	const policy = join(root, "policy", "ttsr.json");
	const mock = join(root, "tests", "live", "mock-model.mjs");
	const adapter = join(root, "scripts", "runtime-adapter.sh");
	const limiter = join(root, "scripts", "limit-process-tree.sh");
	runHelper(root, lib, ["config", policy, configPath], workspace);
	const scenarios = [];
	for (let index = 0; index < manifest.scenarios.length; index++) {
		scenarios.push(await runScenario({ root, workspace, manifest, scenario: manifest.scenarios[index], index,
			adapter, mock, limiter, identity, lib, modelsPath }));
	}
	const failed = scenarios.some((scenario, index) => {
		const expected = manifest.scenarios[index];
		return scenario.omp_exit_code !== 0 || scenario.model_main_requests < 1
			|| scenario.marker.unsafe === true
			|| scenario.marker.present !== (expected.expected_marker_effect === "present")
			|| (scenario.marker.present && scenario.marker.matches_expected !== true)
			|| (scenario.native_system_interrupt !== (expected.role === "block"));
	});
	process.stdout.write(`${JSON.stringify({ status: failed ? "FAIL" : "PASS", rule: manifest.rule,
		rule_sha256: manifest.ruleSha256, scenarios })}\n`);
}

try {
	await main();
} catch (error) {
	const message = error instanceof Error ? error.message : "";
	const code = /^[A-Z][A-Z0-9_]+$/.test(message) ? message
		: error && typeof error === "object" && "code" in error && typeof error.code === "string" && /^[A-Z][A-Z0-9_]+$/.test(error.code)
			? `OS_${error.code}` : "EXTERNAL_LIVE_FAILED";
	process.stderr.write(`${code}\n`);
	process.exitCode = 1;
}
