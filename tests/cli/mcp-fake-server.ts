// Fake stdio MCP server for omp-kit MCP tests. argv[2] selects the mode:
//   echo       - one tool "echo" that returns its "text" argument
//   zero       - initializes and lists 0 tools
//   fail       - one tool "echo" whose calls return isError
//   banner     - like echo, but first prints a non-JSON banner line, which OMP's strict stdio reader rejects
//   auth       - like echo, but every call answers "FAKE_AUTH_ERROR (HTTP 401)" as normal text with isError false
//   agent-mail      - one read-only "health_check" tool with a deterministic response
//   agent-mail-fail - exposes "health_check" but returns a tool-call error
const mode = process.argv[2] ?? "echo";
if (mode === "banner") process.stdout.write("fake-server banner: starting up\n");
const isAgentMailMode = mode === "agent-mail" || mode === "agent-mail-fail";
const tools = mode === "zero" ? [] : isAgentMailMode ? [{
	name: "health_check",
	description: "Return fake Agent Mail health",
	inputSchema: { type: "object", properties: {} },
}] : [{
	name: "echo",
	description: "Echo the text argument",
	inputSchema: { type: "object", properties: { text: { type: "string" } }, required: ["text"] },
}];
function send(message: unknown): void { process.stdout.write(`${JSON.stringify(message)}\n`); }
let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk: string) => {
	buffer += chunk;
	for (let index = buffer.indexOf("\n"); index >= 0; index = buffer.indexOf("\n")) {
		const line = buffer.slice(0, index).trim();
		buffer = buffer.slice(index + 1);
		if (!line) continue;
		const request = JSON.parse(line) as { id?: number | string; method: string; params?: { arguments?: { text?: unknown } } };
		if (request.id === undefined) continue;
		if (request.method === "initialize") send({ jsonrpc: "2.0", id: request.id, result: {
			protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: `fake-${mode}`, version: "1.0.0" } } });
		else if (request.method === "tools/list") send({ jsonrpc: "2.0", id: request.id, result: { tools } });
		else if (request.method === "tools/call") {
			const text = String(request.params?.arguments?.text ?? "");
			const result = mode === "fail"
				? { content: [{ type: "text", text: "fake failure" }], isError: true }
				: mode === "auth" ? { content: [{ type: "text", text: "FAKE_AUTH_ERROR (HTTP 401): invalid appid" }], isError: false }
				: mode === "agent-mail-fail" ? { content: [{ type: "text", text: "fake tool call failed" }], isError: true }
				: mode === "agent-mail" ? { content: [{ type: "text", text: "{\"ok\":true,\"version\":\"fake-agent-mail-1\"}" }] }
				: { content: [{ type: "text", text: `echo:${text}` }] };
			send({ jsonrpc: "2.0", id: request.id, result });
		} else send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "method not found" } });
	}
});
