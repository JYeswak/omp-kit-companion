### Fixed

- The ownership census no longer reports an unreadable directory as an observed zero. `omp-kit doctor --scope ownership` read every directory error (EACCES included) as an absent directory, so an RCH job-leases directory it could not read counted 0 records and 0 untracked. Only ENOENT and ENOTDIR now mean "absent"; any other read error makes that census row UNKNOWN (census null, the reason names the error) and the summary is not OK. This applies to the scratch, quarantine and lock censuses too. A truly absent directory is still a legitimate zero (ompkit-uj4af).
