### Fixed

- The private memory audit now recognises OMP 18.11.3, the version Tern installs for the fleet. It previously refused 18.11.3 sources as unsupported. The 18.11.3 source tuple was reviewed against 18.9.2: only `mnemopi/config.ts` and `mnemopi/state.ts` changed, with no change to any store, bank, table or row. The two OMP 18.10.2 and 18.11.3 changelog entries that blocked certification are recorded as not affecting the kit, which never calls `ui.approve`. (ompkit-3zhf)
