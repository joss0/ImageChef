# (superseded)

This document described ImageChef's original design: a CyberChef-style ordered
list of user-toggleable, reorderable operations.

That model has been replaced. The recipe is now a fixed-schema record run
through one fixed pipeline — there is no operation list, no drag-to-reorder,
and no per-op enable toggle. See:

- [`ImageChef.md`](./ImageChef.md) — what the tool is and why
- [`ImageChef-design-brief.md`](./ImageChef-design-brief.md) — the implementation
  spec, in Q&A form, with the acceptance tests the engine is checked against

Kept for history rather than deleted outright; do not use it as current
documentation.
