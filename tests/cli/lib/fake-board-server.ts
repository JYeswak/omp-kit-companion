// Out-of-process fake Board for sync tests: the test process blocks in spawnSync, so an in-process server
// would never answer. usage: bun fake-board-server.ts PORTFILE SEEDDIR LIFETIME_S [LOGFILE]. Exits when its parent is gone.
import { writeFileSync } from "node:fs";
import { fakeBoard } from "./fake-board.ts";

const [portFile, seedDir, lifetime, logFile] = process.argv.slice(2);
const board = fakeBoard(seedDir, logFile);
writeFileSync(portFile!, board.url);
const parent = process.ppid;
const started = Date.now();
setInterval(() => {
	let alive = true;
	try { process.kill(parent, 0); } catch { alive = false; }
	if (!alive || Date.now() - started > Number(lifetime) * 1000) { board.stop(); process.exit(0); }
}, 1000);
