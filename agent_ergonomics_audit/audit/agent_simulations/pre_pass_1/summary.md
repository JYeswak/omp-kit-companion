# Pre-pass simulation status: NOT RUN

No fresh-agent CLI task was executed: the mandatory wrapper path was refused by fleet-guard. Source-only scoring and skipped intent candidates do not constitute simulation transcripts.

Resume with five explicit safe tasks after the binary prerequisite is resolved:
1. Discover available automation capabilities: `omp-kit capabilities --json`.
2. Inspect one command's schema: `omp-kit schema --json`.
3. Learn the automation workflow: `omp-kit robot-docs guide`.
4. Recover from a transposed discovery flag: `omp-kit capabilities --jsno`.
5. Find the next worker station: `omp-kit next --role worker --json` (currently absent; source/user-reported gap, not re-probed).

Use the authorized wrapper for every target call, nice 10, serial calls, stdin closed, 30-second deadlines, and complete stdout/stderr/exit captures. No --apply or --yes.
