### Changed

- Withdrew the unreleased bead-reference and elapsed-acceptance lint changes after independent review found false dependency requirements; the previous lint behavior remains, and the repair stays open. (ompkit-fp72.135.3.36)
- Reimplemented check_i typed causal edges with mention-local patterns (at most two plain words, never across clause punctuation) so a causal word about another subject no longer demands a blocks edge; historical evidence with genuine discovered-from now passes, edgeless mentions still fail. Restored elapsed classification for numbered/bullet/prose acceptance including 24 h windows. (ompkit-fp72.135.3.36)
