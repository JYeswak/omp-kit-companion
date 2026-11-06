### Fixed

- bead-lint's goal-path check treats a parent-child descendant of an open `kind:goal` bead as on that goal's path. Before, every child of a goal epic with other children was unplaceable: the only other edge (goal blocks child) is refused because it hides all children from `br ready`. A child of a closed goal is still refused. (ompkit-1ra0d, GOALCHILD1)
