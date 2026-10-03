import { mkdirSync } from "node:fs";
import { resolve } from "node:path";

mkdirSync(resolve(import.meta.dir, "../var/agent-tmp"), { recursive: true });
