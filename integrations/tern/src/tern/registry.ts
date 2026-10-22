/** Structurally compatible with omp-kit's Command; no runtime import cycle. */
const flag = (name: string, description: string, value?: string) => ({ name, description, ...(value ? { value } : {}) });
const common = [flag('--json', 'Use the omp-kit result envelope'), flag('--robot', 'Noninteractive output; never grants authority'), flag('--apply', 'Request the selected effect'), flag('--yes', 'Confirm the selected effect'), flag('--plan', 'Preview only')];
const connection = [flag('--endpoint', 'Explicit Tern Unix socket path or loopback TCP port', 'EP'), flag('--timeout-ms', 'Local finite deadline; does not roll back native effects', 'N')];
const native = [flag('--binary', 'Native tern executable path or name', 'PATH'), flag('--argv', 'Native argument vector as JSON, never a shell command', 'JSON')];
const specs = [
    ['catalog', 'List source-bound SDK members and native script families', [flag('--filter', 'Substring filter', 'TEXT')]],
    ['doctor', 'Probe explicitly selected Tern endpoint and executable; no installs', [...connection, flag('--binary', 'Native tern executable', 'PATH')]],
    ['ctl', 'Forward an exact native command, preserving control/scenario grammar', [...connection, flag('--line', 'One exact native command line', 'TEXT')]],
    ['script', 'Execute a scenario file sequentially, preserving full replies', [...connection, flag('--file', 'Native scenario file', 'PATH')]],
    ['native', 'Run documented native CLI argv (plugin, browser, shot, serve, ctl, help)', [...native, flag('--timeout-ms', 'Native process deadline', 'N')]],
    ['api', 'Compile and run a window/Carly SDK call or same-VM program', [...connection, flag('--member', 'Exact canonical SDK member', 'SYMBOL'), flag('--args', 'Positional JSON argument array', 'JSON'), flag('--file', 'Same-VM JSON program', 'PATH')]],
    ['sdk', 'Emit a native Luau module or call; check installed SDK declarations', [flag('--operation', 'module, emit, or check', 'OP'), flag('--context', 'host/window/carly/host-effect/host-block/host-lens', 'CONTEXT'), flag('--member', 'SDK member or callback slot', 'SYMBOL'), flag('--file', 'Native argument expression, callback implementation, or type file', 'PATH'), flag('--receiver', 'Same-VM handle expression for emit', 'LUA'), flag('--out', 'Exclusively create a source file', 'PATH')]],
    ['coverage', 'Check independently extracted installed declarations and docs census', [flag('--types', 'File from tern plugin types or pinned upstream declarations', 'PATH'), flag('--docs-report', 'Report produced by tern-docs-census.py', 'PATH')]],
    ['surface', 'Encode/decode low-level TSP messages; native SDK still owns rendering', [flag('--operation', 'encode, decode, blob', 'OP'), flag('--file', 'JSON message, wire capture, or blob', 'PATH'), flag('--apc', 'Maximum framed chunk bytes', 'N'), flag('--mime', 'Blob MIME type', 'TYPE'), flag('--out', 'Exclusively create a wire file', 'PATH')]],
    ['render', 'Use a separately installed native TypeScript SDK to print/ask/plain', [flag('--sdk', 'Explicit native @stencil-hq/tern entry module', 'PATH'), flag('--operation', 'print, ask, plain', 'OP'), flag('--file', 'Native NodeJson view', 'PATH'), flag('--options', 'Native helper options as JSON', 'JSON')]],
] as const;
export const TERN_COMMAND = {
    name: 'tern', description: 'Source-bound native Tern SDK and control integration',
    usage: 'tern catalog|doctor|ctl|script|native|api|sdk|coverage|surface|render',
    flags: [], runnable: true, subcommandOptional: true, example: 'omp-kit tern catalog --json',
    subcommands: specs.map(([name, description, flags]) => ({
        name, description, usage: `tern ${name} [FLAGS]`, flags: [...flags, ...common],
        runnable: true, example: `omp-kit tern ${name} --help`,
        dataSchema: { type: 'object' as const, required: ['status'], properties: { status: { type: 'string' } } }
    }))
};
export type Parsed = {
    command: string;
    flags: Record<string, string | boolean>;
};
export function parseTern(argv: string[]): Parsed {
    const command = argv[0] ?? 'catalog';
    if (command === '--help' || command === 'help')
        return { command: 'help', flags: {} };
    const spec = TERN_COMMAND.subcommands.find(s => s.name === command);
    if (!spec)
        throw new Error('Unknown tern command ' + command);
    const flags: Record<string, string | boolean> = {};
    for (let i = 1; i < argv.length; i++) {
        const arg = argv[i]!;
        if (arg === '--help') {
            flags['--help'] = true;
            continue;
        }
        const at = arg.indexOf('=');
        const key = at >= 0 ? arg.slice(0, at) : arg;
        const f = spec.flags.find(x => x.name === key);
        if (!f)
            throw new Error('Unknown flag ' + key);
        if (Object.hasOwn(flags, key))
            throw new Error('Repeated flag ' + key);
        if (f.value) {
            const v = at >= 0 ? arg.slice(at + 1) : argv[++i];
            if (v === undefined || v.startsWith('--'))
                throw new Error('Missing value for ' + key);
            flags[key] = v;
        }
        else {
            if (at >= 0)
                throw new Error('Boolean flag does not take a value: ' + key);
            flags[key] = true;
        }
    }
    if (flags['--yes'] && !flags['--apply'])
        throw new Error('--yes requires --apply');
    if (flags['--plan'] && flags['--apply'])
        throw new Error('--plan and --apply are mutually exclusive');
    return { command, flags };
}
