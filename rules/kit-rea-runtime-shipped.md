---
description: "rea-ttsr candidate 6 (bead ompkit-gbkj.2.20): runtime tracing against a shipped target; rule qualification pending ompkit-gbkj.2.9; never interrupts"
condition:
  - '\b(lldb|dtruss|fs_usage)\b[\s\S]*?(\/Applications\/|\.app\/Contents\/MacOS\/|\/opt\/homebrew\/|\/opt\/local\/|\/usr\/bin\/|\/usr\/sbin\/|\/sbin\/|\/System\/(Library|Applications)\/)'
scope: "tool:bash"
interruptMode: never
---
Tracing a **shipped target** with `lldb`, `dtruss`, or `fs_usage` may be answerable with REA `capture_process_scenario` (proven on a shipped fixture in ompkit-gbkj.2.20) or `observe_native_calls` (debugger attach was denied on the hardened fixture; enabling it is a machine-security change, not attempted here). Ordinary debugging of code you own, bare OS-level diagnostics, pid-only attaches, and user-managed paths (`/usr/local/`, `./`, `~/Developer`) stay quiet: they carry no shipped-target signal and REA is not the route. Prose that merely quotes such a command (docs, heredocs) is a known residual gap, not a fire.
