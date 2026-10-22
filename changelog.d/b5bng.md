### Fixed

- Fleet guard now expands a leading `~/` in the path of a write or edit tool call to your home directory, the same way the omp file tools do. It used to resolve the path relative to the current directory, which broke in two ways. A seat working in omp-kit that edited `~/Developer/omp-kit-companion/...` was refused against the wrong repository, even though it held the right reservation. And a seat working outside any repository was not checked for ownership at all. A path such as `~user/...` is still taken literally.
