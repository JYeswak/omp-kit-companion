---
description: "rea-ttsr candidate 6 (bead ompkit-gbkj.2.20): runtime tracing against a shipped target; rule qualification pending ompkit-gbkj.2.9; never interrupts"
condition:
  # Quiet when the tracer word sits in a command segment whose command word is echo/printf
  # (metamorphic quoting relation). A segment starts at the input, the JSON command value,
  # ; & | newline backtick, $( or an unescaped JSON \n. The lookbehind follows the literal and is
  # bounded (64 spaces, 256 segment chars), so its cost is constant per tracer word: the
  # unbounded form measured quadratic. Tradeoff: an echo more than 256 segment chars before the
  # word is not seen and the rule still fires, as it did before. Pinned by
  # tests/cli/echo-literal-rules.test.ts. The leading `/` outside the path alternation is the
  # regex-budget literal probe.
  - '\b(lldb|dtruss|fs_usage)\b(?<!(?:^|"command"\s{0,8}:\s{0,8}"|[;&|\n\x60]|\$\(|(?<!\\)(?:\\\\){0,32}\\n)\s{0,64}(?:echo|printf)\b(?:[^;&|\n\x60$\\]|\$(?!\()|\\[^n]){0,256})[\s\S]*?\/(Applications\/|(?<=\.app\/)Contents\/MacOS\/|opt\/homebrew\/|opt\/local\/|usr\/bin\/|usr\/sbin\/|sbin\/|System\/(Library|Applications)\/)'
scope: "tool:bash"
interruptMode: never
---
Tracing a **shipped target** with `lldb`, `dtruss`, or `fs_usage` may be answerable with REA `capture_process_scenario` (proven on a shipped fixture in ompkit-gbkj.2.20) or `observe_native_calls` (debugger attach was denied on the hardened fixture; enabling it is a machine-security change, not attempted here). Ordinary debugging of code you own, bare OS-level diagnostics, pid-only attaches, and user-managed paths (`/usr/local/`, `./`, `~/Developer`) stay quiet: they carry no shipped-target signal and REA is not the route. A command that only prints such a command line (`echo`, `printf`) stays quiet too. Other prose that quotes one (docs, heredocs) is a known residual gap: it can still fire.
