- bash-pipe-exit: condition 0 checks the echo/printf quote lookbehinds after the pipe-to-head/tail match, not before it, so near-miss cost stays flat (16K: 1958 ms to 0.14 ms) with fire/quiet cases unchanged (ompkit-ex6l).
<!-- release coverage: (commit 5334e9a) -->
