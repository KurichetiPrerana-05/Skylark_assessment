# Decision Log

## Key assumptions
- "This quarter" / "recurring project" / other ambiguous founder phrasing is
  resolved by asking one clarifying question, or stated as an assumption
  before answering.
- Sector/date/naming inconsistencies in the boards are normalized by Claude
  at query time via its own reasoning + the MCP read tools, not by a
  separate ETL step.

## Trade-offs
- Used Claude's native remote-MCP connector to monday's hosted MCP server
  instead of hand-writing a monday GraphQL client. Faster to build (fits a
  ~5 hour window) and satisfies "MCP or API — your choice," at the cost of
  less fine-grained control over exactly which monday endpoints get called.
- Chose Next.js + Vercel over a Python backend for zero-config, free hosting
  and a single-command deploy — trading away a Python-native data-science
  stack.
- No custom data-cleaning layer — leaned on Claude's reasoning over raw
  monday data plus explicit system-prompt instructions to handle messiness
  and surface caveats.

## What I'd do differently with more time
- Add scoped read-only monday API tokens.
- Cache/normalize board schemas so query latency and token usage go down.
- Add lightweight eval set of founder questions with expected answer shapes.
- Persist conversation + generated "leadership update" snapshots to a store.

## "Leadership updates" interpretation
Implemented as a conversational trigger ("prepare a leadership update") that
makes the agent pull fresh headline metrics from both boards and return a
short structured summary (wins, risks, key numbers) — rather than a
scheduled/emailed report, to keep it in-scope for a 5-hour prototype.
