# ADR-031 · A shared headless Chrome broker

Accepted for registered browser data sources. Provider cutover remains gated on platform permission and live verification.

The normal browser path uses installed Google Chrome in sandboxed headless mode with a dedicated persistent profile. The broker holds the profile lock and runs serialized jobs from SQLite. Interactive mode is reserved for explicit owner authentication. XN-Bridge routes typed operations and receives compact evidence. The existing provider API approval and intent boundary continues to govern social writes.

This decision supersedes the blanket browser exclusion in ADR-016 for registered collection. It also supersedes the extension-first onboarding proposal for ordinary execution.
