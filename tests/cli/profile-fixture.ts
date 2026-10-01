import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export function writeProfileConfig(home: string, name: string, content: string, mode: number): string {
	const directory = name === "default" ? join(home, ".omp", "agent") : join(home, ".omp", "profiles", name, "agent");
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const path = join(directory, "config.yml");
	writeFileSync(path, content, { mode });
	return path;
}
