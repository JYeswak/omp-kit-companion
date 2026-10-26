### Fixed

- The config-facts rule (`kit-probe-readable-facts`) no longer reads a dotted bead id such as `ompkit-fp72.135.3.16` as a version number when the line also says `pinned`. A real version beside `pinned` (`"pinned": "0.2.75"`) still fires. On 2026-10-26 the false match rewound the omp-test director more than 70 times while it edited its milestone. (ompkit-fp72.135.3.16.2, part a)
