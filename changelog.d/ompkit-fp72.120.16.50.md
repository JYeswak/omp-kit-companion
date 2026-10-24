### Fixed

- The cc command-center service no longer runs under background QoS, which made its 10 s fast-lane deadline overrun at ordinary fleet load. Kit service jobs now declare a QoS class (`ServiceJobDef.qos`). cc is `deadline`: ProcessType Standard, Nice 10 and no LowPriorityIO. Every other job keeps the `background` shape, byte for byte. `service doctor`'s `contract-processtype` check now follows the declared class and FAILs a deadline job rendered Background. systemd units are unchanged. (ompkit-fp72.120.16.50)
