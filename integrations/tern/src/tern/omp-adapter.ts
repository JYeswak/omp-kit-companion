import { TERN_COMMAND } from './registry.ts';
import { runTern } from './command.ts';
import type { CommandResult } from './command.ts';
/** Matches the inspected ParsedCommand shape without importing cli.ts back into itself. */
export type KitRequest = {
    command: {
        name: string;
    };
    flags: ReadonlyMap<string, string | boolean>;
    json: boolean;
    robot: boolean;
};
export function registerTernHandlers(register: (path: string, handler: (request: KitRequest) => Promise<CommandResult>) => void): void {
    register('tern', async () => runTern({ command: 'catalog', flags: {} }));
    for (const sub of TERN_COMMAND.subcommands)
        register(`tern ${sub.name}`, async (request) => {
            const allowed = new Set(sub.flags.map(f => f.name));
            const flags: Record<string, string | boolean> = {};
            for (const [key, value] of request.flags) {
                if (allowed.has(key))
                    flags[key] = value;
            }
            if (request.json)
                flags['--json'] = true;
            if (request.robot)
                flags['--robot'] = true;
            return runTern({ command: sub.name, flags });
        });
}
