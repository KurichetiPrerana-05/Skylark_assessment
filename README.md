# Skylark Drones — monday.com BI Agent (prototype)

Conversational agent that answers founder-level BI questions over two live
monday.com boards (Work Order Tracker, Deal Funnel), using **Groq
(`openai/gpt-oss-120b`, free tier)** with OpenAI-style function calling, and
**direct monday.com GraphQL API** calls (read-only) for live data.

## Architecture
- **Frontend**: single Next.js page, plain chat UI (`pages/index.js`)
- **Backend**: one serverless API route (`pages/api/chat.js`) that runs a
  Groq function-calling loop (up to 8 tool-call rounds per question, with
  retry-with-backoff on rate-limit errors). The model decides which tool(s)
  to call; the actual monday.com fetch and all aggregation happens in
  `lib/monday.js`.
- **monday.com access**: `lib/monday.js` is a wrapper around monday's `/v2`
  GraphQL endpoint (`items_page` query) — no SDK, read-only, fully
  paginated with no row cap.
- **Data**: nothing hardcoded. Every answer is computed live from monday.com
  on each request (no caching yet — see Decision Log).

### Tools (all implemented server-side in `lib/monday.js`)
Raw board rows are never sent to the LLM — every tool fetches the **entire**
board (paginated, uncapped) and returns only a compact, pre-computed result.
This is what lets the agent honestly satisfy "read all data from both
boards" while staying under Groq's free-tier token-per-minute limit.

- **`get_board_summary`** — full-board stats: numeric sum/avg/min/max per
  numeric column, categorical distributions (top 6 values + rolled-up
  "other"), per-column null/missing counts, and for date columns a real
  min/max date plus a quarterly breakdown. Also returns a small sample of
  raw rows for grounding. Use this to discover what columns/values exist,
  or for whole-board totals with no date/category filter.
- **`get_filtered_aggregate`** — the main tool for anything combining a
  category filter and/or a date range in one question ("Renewables +
  Powerline deals closing this quarter"). Filters and dates are resolved
  and summed server-side in a single call, returning matched counts, an
  optional sum, an optional group breakdown, and — importantly — a
  separate count of matching rows that have **no date recorded at all**
  (`matchingFiltersWithNoDateRecorded`), since "zero results in this date
  range" and "no date on file" are different facts.
- **`get_cross_tab`** — exact counts for every combination of two columns
  (e.g. Deal status × Sector), for questions with no date component.
- **`get_grouped_sum`** — exact sum of a numeric column grouped by a
  category, for questions with no date component.
- **`search_board_items`** — case-insensitive text search across all
  columns, for single-record lookups ("what's the status of the Naruto
  deal") without pulling full-board aggregates.
- **`list_boards`** — lists board IDs visible to the API token.

`get_cross_tab`, `get_grouped_sum`, and `get_filtered_aggregate` all
auto-correct near-miss column names (case/wording) against the board's real
columns, and return `availableColumns` on a genuine miss so the model can
retry once instead of reporting a false zero/blank result.

### Data normalization
Normalization happens **once, in code, before aggregation** — not left to
the model to reason around on every query:
- **Categorical values** (status, sector, etc.) are grouped
  case/whitespace-insensitively (`"Open"` and `"open "` count together),
  while the most common original spelling is kept for display.
- **Dates** are parsed from monday.com's stored `YYYY-MM-DD` text format.
  Date detection runs *before* numeric detection in column classification —
  otherwise a column of dates like `"2025-07-31"` gets misread as small
  numeric years, which was a real bug caught during development.
- **Numeric/currency values** (e.g. `"₹1,20,000"`, `"5360 HA"`) are parsed
  by stripping non-numeric characters before summing. This is a stated
  assumption, not silent: unit context (HA vs. plain count) is not
  preserved by this simple parse.
- Column *type* (date / numeric / categorical / text) is inferred by
  sampling each column's non-null values, not by column name.

## 1. monday.com setup
1. Create the boards and import your CSVs — "Work Order Tracker" and
   "Deal Funnel".
2. Get a personal API token: avatar → Admin → API (or
   `https://<yoursubdomain>.monday.com/admin/integrations/api`).
3. Get each board's ID: open the board → the ID is in the URL
   (`.../boards/1234567890`), or ask the agent itself via `list_boards`
   once deployed (temporarily hardcode any board ID to bootstrap this).

## 2. Groq API key (free)
1. Go to https://console.groq.com/keys
2. Create an API key — the free tier is generous enough for a demo/eval
   session (rate-limited, not unlimited, but no billing required).

## 3. Local env
```
cp .env.example .env.local
# fill GROQ_API_KEY, MONDAY_API_TOKEN, MONDAY_WORK_ORDER_BOARD_ID, MONDAY_DEAL_BOARD_ID
npm install
npm run dev
```

**Never commit `.env.local` or share it in a submission zip** — it holds
live credentials. Only `.env.example` (placeholders) should ever be shared.

## 4. Deploy on Vercel (free)
1. Push this folder to a new GitHub repo (`.env.local` is gitignored).
2. vercel.com → New Project → Import the repo.
3. In Project Settings → Environment Variables, add all four variables from
   `.env.example` with your real values (these do **not** carry over from a
   local `.env.local` file — they must be entered in Vercel directly).
4. Deploy. You get a public `https://<project>.vercel.app` URL — that's your
   hosted prototype link for submission.
5. Rotate/revoke any API key that was ever visible in a shared file or chat
   log before using it in the live deployment.

## Notes / caveats
- **No row cap on board fetches.** Every tool pages through the entire
  board with no `hardCap` — this satisfies "read all data" exactly, but
  means a serverless function call could get slow if either board grows
  very large. Fine at current data size; worth revisiting if the boards
  grow substantially (see Decision Log).
- **Conversation history is trimmed** to the last 2 messages before being
  sent to Groq, to keep requests under the free-tier token-per-minute
  limit. This means the agent will not recall context from further back in
  a long conversation (e.g. "what about last quarter?" referring to
  something asked several turns earlier may lose that reference).
- **The agent never asks clarifying questions.** Per the system prompt, any
  ambiguous term (sector name, time window, etc.) is silently resolved to
  the closest matching real value in the data, and the assumption made is
  stated as a one-line note *after* the numeric answer — not asked as a
  question before answering.
- Groq's free tier has rate limits (requests/minute and tokens/minute).
  `pages/api/chat.js` retries transient 429s with backoff (using Groq's
  suggested wait time when provided); if retries are exhausted, the user
  sees a plain-language message asking them to wait and retry, rather than
  a raw error.
- monday API token has whatever read/write scope your account grants by
  default; this app only ever issues read (`query`) operations, never
  mutations, even though the token itself may be capable of more.
- Auth and connection failures from monday.com (bad token, network error)
  surface as thrown errors from `lib/monday.js`, caught per-tool-call in
  `pages/api/chat.js` and passed back to the model as a plain `{ error }`
  object rather than crashing the request — the model can then explain the
  failure to the user in plain language instead of showing a stack trace.