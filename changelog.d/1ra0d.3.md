### Fixed

- Goal keepalive no longer wakes a seat whose fleet-watch session is paused (`pullEnabled: false`); a paused project spends no keepalive turns. An unreadable config or a seat outside every session keeps the wake. (ompkit-1ra0d.3, KEEPALIVEPAUSE1)
