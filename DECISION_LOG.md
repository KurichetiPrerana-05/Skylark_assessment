# Decision Log

## Key architectural decision: server-side aggregation, not raw-row dumping
The assignment requires reading ALL data from both boards (no hardcoded
CSVs, dynamic monday.com queries) — but the free-tier LLM API (Groq) caps
requests at 8,000 tokens/minute, and dumping all raw rows as JSON blew past
that by several times over. Rather than sampling a subset of rows (which
would silently produce wrong totals depending on which rows happened to
come back), the agent:
1. Fetches every row from monday.com (fully paginated, no cap) in
   `lib/monday.js`.
2. Computes aggregates server-side in plain JS: sums/avg/min/max for numeric
   columns, distributions for categorical columns (status, sector), and
   missing-value counts per column — across the FULL dataset, not a sample.
3. Sends only this compact summary to the LLM, plus a small raw-row sample
   only from `get_board_summary` (for grounding illustrative lookups).

This means every BI answer is genuinely computed over 100% of the board
data, while the payload to the model stays small enough for the free tier —
and it's arguably more reliable than having an LLM eyeball hundreds of raw
JSON rows and mentally sum a column itself.

An earlier version of this agent used a fixed row-sample cap (e.g. "10
rows") and let the model report totals from that sample. Testing surfaced
that this produces subtly wrong numbers that read as confident and correct
(e.g. a total that changes depending on which handful of rows the API
happened to return first) — a genuine correctness risk given the assignment
explicitly requires the agent to never invent numbers. Moving to full-board
server-side aggregation, rather than a bigger sample, was the fix.

For single-record lookups ("what's the status of the Naruto deal"), a
separate `search_board_items` tool does a live text search across the full
board without sending every row through the LLM.

For questions combining a category filter and a date range in one ask
(e.g. "Renewables and Powerline deals closing this quarter"), a single
`get_filtered_aggregate` tool call does the filtering, date-range matching,
and optional sum/group-by server-side — rather than the model chaining
`get_board_summary` + `get_cross_tab` + `get_grouped_sum`, which would
re-send the growing conversation to the model on every extra round trip and
risk hitting the token-per-minute limit on a single multi-part question.

## Key assumptions
- Ambiguous founder phrasing (a sector name that isn't an exact column
  value, "this quarter", etc.) is **never** resolved by asking the user a
  clarifying question — the agent always resolves it itself (mapping to the
  closest matching real value(s) in the data, or computing the actual date
  range for the named period) and states the assumption made as a one-line
  note *after* the numeric answer, so the founder can correct it if wrong.
  This was a deliberate choice for a conversational BI tool: a founder
  asking a quick question expects an answer, not a round trip.
- Column values are normalized case/whitespace-insensitively when grouped
  for counts (e.g. "Open" and "open " count as the same category), while the
  most common original spelling is kept for display.
- Numeric-looking text fields (e.g. "₹1,20,000", "5360 HA") are parsed by
  stripping non-numeric characters before summing — flagged as an assumption
  since it silently drops unit context (HA vs. plain count).
- Date columns store real day-level dates (`YYYY-MM-DD`), not just a year.
  An earlier version of the column-classifier ran numeric detection before
  date detection, which caused date strings to be misparsed as small
  numeric years — fixed by classifying dates first.

## Trade-offs
- Used Groq (free, fast inference, OpenAI-style tool calling) instead of a
  paid LLM API, since no billing was available for this assessment. This
  meant giving up Anthropic's built-in remote-MCP connector to monday's
  hosted MCP server in favor of a direct monday.com GraphQL wrapper with
  server-side aggregation — more code, but free and, per above, arguably
  more reliable for exact totals.
- Chose Next.js + Vercel over a Python backend for zero-config, free hosting
  and a single-command deploy — trading away a Python-native data-science
  stack.
- Server-side aggregation trades some LLM "reasoning flexibility" (it can't
  freely re-slice raw rows in ways the summarizer/aggregate tools didn't
  anticipate) for reliability and free-tier feasibility. A production
  version with a paid tier could send more raw rows and let the model
  reason more freely, or add more specialized aggregate tools over time.
- Conversation history sent to the model is trimmed to the last 2 messages
  to keep every request under the free-tier token budget. This means the
  agent has effectively no memory of earlier turns in a long conversation —
  acceptable for single-shot founder questions, a real limitation for
  extended back-and-forth analysis sessions.
- No caching: every question triggers a fresh full-board fetch and
  aggregation from monday.com. Simpler and always up-to-date, at the cost
  of redundant API calls for repeated/similar questions in the same
  session.

## What I'd do differently with more time
- Add scoped read-only monday API tokens.
- Cache board summaries (e.g. 5 min TTL) to cut repeated full-board fetches
  and reduce Groq token usage per question.
- Add a lightweight eval set of founder questions with expected answer
  shapes, to catch regressions like the earlier date-misparsing bug
  automatically instead of by manual testing.
- Extend the conversation history window (or summarize older turns instead
  of dropping them) now that per-tool-call payloads are much smaller than
  the earlier raw-row approach — there may be more token headroom for this
  than was available before the aggregation rewrite.
- Let `get_filtered_aggregate` accept more than one `groupByColumn` for
  multi-dimensional breakdowns (e.g. "by sector AND status" in one call).
- Move off the free tier / add a paid Groq tier or alternate provider for
  production-grade rate limits.

## "Leadership updates" interpretation
Implemented as a conversational trigger ("prepare a leadership update") that
makes the agent call the aggregate tools fresh on both boards and return a
short structured summary (headline metrics, notable risks, notable wins,
data-quality caveats) — rather than a scheduled/emailed report, to keep it
in-scope for a single-session prototype built under a time constraint.

## Data quality handling
- Close Date (A) is empty for all Open deals by design (only populated once
  a deal actually closes) — not a data bug. The agent is instructed to use
  Tentative Close Date for forward-looking pipeline questions and to state
  this substitution when relevant.
- `get_board_summary`'s column summaries include per-column null/missing
  counts (`dataQuality.nullCounts`) so the agent can proactively flag
  incomplete fields rather than silently ignoring them.
- `get_filtered_aggregate` explicitly separates "zero rows matched the date
  range" from "rows matched the filter but have no date recorded at all"
  (`matchingFiltersWithNoDateRecorded`) — these are different facts about
  data quality vs. business reality, and conflating them would misrepresent
  risk (e.g. reporting "nothing closing this quarter" without noting that
  some deals simply have no close date on file at all).
- Column *type* (date/numeric/categorical/text) is inferred by sampling
  actual values rather than trusting column names, so a column named
  ambiguously (or inconsistently across the two boards) is still classified
  correctly for aggregation.