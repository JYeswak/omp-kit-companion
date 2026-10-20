# FAQ

**Does omp-kit install or update OMP?**
No. It reads the OMP you have, refuses with `OMP_UNAVAILABLE` when there is
none, and leaves OMP updates to your OMP install method. The
[compatibility matrix](omp-compatibility.md) lists the OMP releases each
certification tested.

**Do I need both the installer and the plugin?**
The plugin alone gives you the rules and extensions inside OMP. The installer
gives you the CLI for testing, diagnosis, receipts, services and updates. Most
setups use both.

**How do I see which release I have and what changed?**
`omp-kit --info` prints the installed version and paths. What changed in each
release is in [CHANGELOG.md](../CHANGELOG.md) and on the GitHub release page.

**Can I write my own rules and test them the same way?**
Yes. Put rules in a directory and cases in the eight-column TSV format, then
run `omp-kit test --rules /abs/rules --cases /abs/cases.tsv --json`. `review
rules` compares a candidate against the incumbent's witnesses. The
[usage guide](usage.md) covers the format.

**Does anything run in the background?**
Only service jobs you install with `omp-kit service install`. The CLI itself is
not a daemon.

**How do agents drive it?**
`omp-kit robot-docs guide`, `omp-kit capabilities --json` and
`omp-kit schema --json` describe the grammar, the runnable commands, and the
envelope. Repository rules for agents working on the kit are in
[AGENTS.md](../AGENTS.md).

**Where do I report a bug or a vulnerability?**
Bugs: [CONTRIBUTING.md](../CONTRIBUTING.md). Sensitive reports:
[SECURITY.md](../SECURITY.md).
