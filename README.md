# Skylark Drones — monday.com BI Agent (prototype)

Conversational agent that answers founder-level BI questions over two live
monday.com boards (Work Orders, Deal Funnel), using Claude's native remote-MCP
connector to monday's hosted MCP server (`https://mcp.monday.com/mcp`) — no
custom monday API wrapper code needed.

## Architecture
- **Frontend**: single Next.js page, plain chat UI (`pages/index.js`)
- **Backend**: one serverless API route (`pages/api/chat.js`) that calls the
  Anthropic Messages API and attaches monday's MCP server via the `mcp_servers`
  param. Claude decides when/what to query on monday.com — you never write
  GraphQL by hand.
- **Data**: nothing hardcoded. Every answer is pulled live from monday.com.

## 1. monday.com setup
1. Create a free monday.com account (or use an existing workspace).
2. Create two boards and import the two CSVs (export the provided .xlsx
   sheets to CSV first) — "Work Order Tracker" and "Deal Funnel". Use
   monday's built-in "Import from Excel/CSV" on board creation; map columns
   to Status/Date/Text/Number column types as monday suggests.
3. Get a personal API token: monday.com → avatar (bottom-left) → Developers →
   My Access Tokens → copy token.

## 2. Local env
```
cp .env.example .env.local
# fill ANTHROPIC_API_KEY and MONDAY_API_TOKEN
npm install
npm run dev
```

## 3. Deploy on Vercel (free)
1. Push this folder to a new GitHub repo.
2. vercel.com → New Project → Import the repo.
3. In Project Settings → Environment Variables, add `ANTHROPIC_API_KEY` and
   `MONDAY_API_TOKEN` (same values as `.env.local`). Do NOT commit `.env.local`.
4. Deploy. You get a public `https://<project>.vercel.app` URL — that's your
   hosted prototype link for submission.

## Notes / caveats
- The MCP connector on the Messages API is currently beta
  (`anthropic-beta: mcp-client-2025-04-04` header) — verify this header name
  against current Anthropic docs before the demo, since beta header names can
  change.
- monday's hosted MCP is read+write capable by default; since the assignment
  requires read-only, either (a) rely on the system prompt instruction never
  to call write tools, and/or (b) create a monday API token restricted to
  read scopes if your plan supports scoped tokens.
- No conversation memory persistence beyond the browser session — fine for a
  prototype; mention as a "future work" item in the Decision Log.
