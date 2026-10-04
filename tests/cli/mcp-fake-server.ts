// Fake stdio MCP server for omp-kit MCP tests. argv[2] selects the mode:
//   echo   - one tool "echo" that returns its "text" argument
//   zero   - initializes and lists 0 tools
//   fail   - one tool "echo" whose calls return isError
//   banner - like echo, but first prints a non-JSON banner line, which OMP's strict stdio reader rejects
const mode = process.argv[2] ?? "echo";
if (mode === "banner") process.stdout.write("fake-server banner: starting up\n");
const tools = mode === "zero" ? [] : [{
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
			send({ jsonrpc: "2.0", id: request.id, result: mode === "fail"
				? { content: [{ type: "text", text: "fake failure" }], isError: true }
				: { content: [{ type: "text", text: `echo:${text}` }] } });
		} else send({ jsonrpc: "2.0", id: request.id, error: { code: -32601, message: "method not found" } });
	}
});
