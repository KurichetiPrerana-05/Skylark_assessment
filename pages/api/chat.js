// /pages/api/chat.js
// Groq (OpenAI-compatible tool calling) + monday.com GraphQL, read-only.
// Strategy: never hand raw board rows to the LLM. Instead, get_board_summary
// reads EVERY row from monday.com and computes counts/sums/distributions in
// plain JS, sending only a compact summary to the model — this satisfies
// "read all data from both boards" while staying under free-tier token
// limits. search_board_items is used for specific record lookups.

const Groq = require("groq-sdk");
const { getBoardSummary, searchBoardItems, getCrossTab, getGroupedSum, getFilteredAggregate, listBoards } = require("../../lib/monday");

const SYSTEM_PROMPT = `Founder-facing BI agent for Skylark Drones. READ-ONLY access to two monday.com boards:
- Work Order Tracker (id: ${process.env.MONDAY_WORK_ORDER_BOARD_ID}) — execution/billing/collection.
- Deal Funnel (id: ${process.env.MONDAY_DEAL_BOARD_ID}) — sales pipeline.

Tools:
- get_board_summary: full-board totals, numeric sums/avg, categorical distributions, null counts, and for date columns a real min/max date plus a quarterly breakdown. Use to learn column names/values, not for filtered questions.
- get_filtered_aggregate: PREFERRED for any question that filters by category and/or a date range (e.g. "Renewables deals closing this quarter", "energy pipeline this year"). Pass filters (column + list of acceptable values), dateColumns (e.g. ["Close Date (A)", "Tentative Close Date"] — a row counts if ANY of them falls in range), startDate/endDate, and optionally sumColumn/groupByColumn. It resolves near-miss column names itself and returns availableColumns on failure. This does the filtering+summing server-side in ONE call — use it INSTEAD OF chaining get_board_summary + get_cross_tab + get_grouped_sum for these questions, since each extra tool call re-sends the whole conversation to the model and is what causes free-tier rate-limit (413/429) errors. Only call get_board_summary first if you don't already know the exact column/value names this conversation.
- search_board_items: find a specific record by name/keyword.
- get_cross_tab: EXACT counts for two columns combined, only when there's no date-range component (get_filtered_aggregate covers date+category together).
- get_grouped_sum: EXACT sum of a numeric column grouped by category, only when there's no date-range component.
- list_boards: discover board IDs.

Rules: never invent numbers, and always call at least one tool before answering with numbers. Column names are exact and case-sensitive (e.g. "Deal status" not "Deal stage", "Masked Deal value" not "Deal value"); get_filtered_aggregate/get_cross_tab/get_grouped_sum auto-correct near misses and return availableColumns on failure — retry once with one of those rather than reporting a zero/blank result as a finding. Date columns store real day-level dates (YYYY-MM-DD), not just a year — never assume otherwise; use get_filtered_aggregate's dateColumns/startDate/endDate to filter to an actual quarter or month. Always separately report how many matching rows have NO date recorded at all (matchingFiltersWithNoDateRecorded) when it's non-zero — a 0-count result scoped to a date range is a different fact from "no date on file" and both must be stated if relevant.

NEVER ask the user a clarifying question and NEVER stop to make them pick from options. Always resolve ambiguity yourself and answer in the same turn:
- If the user names a category (sector, status, etc.) that isn't an exact match in the column's distinct values, silently map it to the closest related value(s) actually present — e.g. "energy" → "Renewables" (and "Powerline" if that value also exists on the board). Use whatever categories get_board_summary/get_filtered_aggregate actually show; don't guess values that aren't there.
- If the user asks for a time window (e.g. "this quarter"), compute the real start/end dates for it and pass them to get_filtered_aggregate's dateColumns covering all relevant date fields (e.g. both Close Date (A) and Tentative Close Date) — don't fall back to a whole year unless the data genuinely has no matches at that granularity AND you've said so.
- If a request could reasonably span more than one related sector, include all of them rather than picking just one.
- After answering, add one short line (max 1 sentence) stating what you assumed or substituted so the user can correct you if needed. This is a note, not a question, and it comes AFTER the numbers, never before them.

Cross-reference both boards for questions spanning sales+execution. Add 1-2 lines of interpretation, not just numbers. For "leadership update" requests, summarize both boards: headline metrics, risks, wins, data caveats.`;

const tools = [
  {
    type: "function",
    function: {
      name: "get_board_summary",
      description:
        "Read the FULL monday.com board (all rows) and return aggregated stats: totals, numeric sums/avg/min/max, categorical distributions, missing-value counts, and a small sample of raw rows. Use for any totals/sums/breakdowns question.",
      parameters: {
        type: "object",
        properties: {
          boardId: { type: "string", description: "The monday.com board ID." },
        },
        required: ["boardId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "search_board_items",
      description:
        "Search a monday.com board for specific records matching a name/customer/deal/keyword. Use for single-record lookups, not aggregate stats.",
      parameters: {
        type: "object",
        properties: {
          boardId: { type: "string", description: "The monday.com board ID." },
          searchText: { type: "string", description: "Text to search for." },
        },
        required: ["boardId", "searchText"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_cross_tab",
      description:
        "Compute EXACT counts for every combination of two columns (e.g. Deal status x Sector) across the full board. Auto-corrects near-miss column names; returns availableColumns if truly not found — retry with one of those.",
      parameters: {
        type: "object",
        properties: {
          boardId: { type: "string", description: "The monday.com board ID." },
          columnA: { type: "string", description: "First column name, e.g. 'Deal status'." },
          columnB: { type: "string", description: "Second column name, e.g. 'Sector'." },
        },
        required: ["boardId", "columnA", "columnB"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_grouped_sum",
      description:
        "Sum a numeric column grouped by a categorical column (e.g. total 'Masked Deal value' per 'Sector'), computed exactly over the full board. Auto-corrects near-miss column names; returns availableColumns if truly not found — retry with one of those.",
      parameters: {
        type: "object",
        properties: {
          boardId: { type: "string", description: "The monday.com board ID." },
          groupByColumn: { type: "string", description: "Category column, e.g. 'Sector'." },
          sumColumn: { type: "string", description: "Numeric column to sum, e.g. 'Masked Deal value'." },
        },
        required: ["boardId", "groupByColumn", "sumColumn"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "get_filtered_aggregate",
      description:
        "ONE call that filters the full board by category value(s) AND/OR a date range on one or more date columns, then returns matched counts, an optional sum, and an optional group breakdown — all computed server-side. Use this instead of chaining get_board_summary + get_cross_tab + get_grouped_sum for any question combining a category filter with a time window, to stay within the token budget.",
      parameters: {
        type: "object",
        properties: {
          boardId: { type: "string", description: "The monday.com board ID." },
          filters: {
            type: "array",
            description: "Category filters, e.g. [{ column: 'Sector/service', values: ['Renewables','Powerline'] }].",
            items: {
              type: "object",
              properties: {
                column: { type: "string" },
                values: { type: "array", items: { type: "string" } },
              },
              required: ["column", "values"],
            },
          },
          dateColumns: {
            type: "array",
            items: { type: "string" },
            description: "Date column(s) to check, e.g. ['Close Date (A)', 'Tentative Close Date']. A row counts if ANY of them falls in [startDate, endDate].",
          },
          startDate: { type: "string", description: "Inclusive ISO date (YYYY-MM-DD), or omit for no lower bound." },
          endDate: { type: "string", description: "Inclusive ISO date (YYYY-MM-DD), or omit for no upper bound." },
          sumColumn: { type: "string", description: "Optional numeric column to sum over matches, e.g. 'Masked Deal value'." },
          groupByColumn: { type: "string", description: "Optional column to break the date-range matches down by, e.g. 'Deal Stage'." },
        },
        required: ["boardId"],
      },
    },
  },
  {
    type: "function",
    function: {
      name: "list_boards",
      description: "List all monday.com boards visible to this API token.",
      parameters: { type: "object", properties: {} },
    },
  },
];

async function callTool(name, args) {
  if (name === "get_board_summary") return await getBoardSummary(args.boardId);
  if (name === "search_board_items")
    return await searchBoardItems(args.boardId, args.searchText);
  if (name === "get_cross_tab")
    return await getCrossTab(args.boardId, args.columnA, args.columnB);
  if (name === "get_grouped_sum")
    return await getGroupedSum(args.boardId, args.groupByColumn, args.sumColumn);
  if (name === "get_filtered_aggregate")
    return await getFilteredAggregate(args.boardId, {
      filters: args.filters,
      dateColumns: args.dateColumns,
      startDate: args.startDate,
      endDate: args.endDate,
      sumColumn: args.sumColumn,
      groupByColumn: args.groupByColumn,
    });
  if (name === "list_boards") return await listBoards();
  throw new Error("Unknown tool: " + name);
}

// Wrap a Groq call with retry-with-backoff for transient 429 (rate limit)
// responses. Groq's error message includes the exact wait time — use it
// when present, otherwise fall back to exponential backoff.
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function callGroqWithRetry(groq, params, { maxRetries = 4 } = {}) {
  let attempt = 0;
  while (true) {
    try {
      return await groq.chat.completions.create(params);
    } catch (err) {
      const status = err?.status || err?.response?.status;
      const isRateLimit = status === 429;
      if (!isRateLimit || attempt >= maxRetries) throw err;

      // Try to read Groq's suggested wait time from the error message,
      // e.g. "Please try again in 1.8375s."
      let waitMs = null;
      const msg = err?.message || err?.error?.message || "";
      const match = msg.match(/try again in ([\d.]+)s/i);
      if (match) waitMs = Math.ceil(parseFloat(match[1]) * 1000) + 250;
      if (!waitMs) waitMs = 1000 * Math.pow(2, attempt); // fallback backoff

      attempt++;
      await sleep(waitMs);
    }
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();
  const { messages } = req.body;

  try {
    const groq = new Groq({ apiKey: process.env.GROQ_API_KEY });

    // Only keep the last few turns of raw chat history — full tool-result
    // history from earlier questions would otherwise keep growing and
    // eventually blow the free-tier token limit even with small payloads.
    const trimmedMessages = messages.slice(-2);

    let chatMessages = [
      { role: "system", content: SYSTEM_PROMPT },
      ...trimmedMessages.map((m) => ({
        role: m.role === "assistant" ? "assistant" : "user",
        content: m.content,
      })),
    ];

    const MODEL = "openai/gpt-oss-120b";
    let guard = 0;
    let finalText = "";

    while (guard < 8) {
      const completion = await callGroqWithRetry(groq, {
        model: MODEL,
        messages: chatMessages,
        tools,
        tool_choice: "auto",
        temperature: 0.3,
      });

      const choice = completion.choices[0];
      const msg = choice.message;

      if (!msg.tool_calls || msg.tool_calls.length === 0) {
        finalText = msg.content || "";
        break;
      }

      chatMessages.push({
        role: "assistant",
        content: msg.content || null,
        tool_calls: msg.tool_calls,
      });

      for (const call of msg.tool_calls) {
        const args = JSON.parse(call.function.arguments || "{}");
        let output;
        try {
          output = await callTool(call.function.name, args);
        } catch (e) {
          output = { error: String(e) };
        }
        chatMessages.push({
          role: "tool",
          tool_call_id: call.id,
          content: JSON.stringify(output),
        });
      }

      guard++;
    }

    if (!finalText) {
      finalText =
        "I gathered some data but ran out of tool-call attempts before finishing my answer — please try asking again in a moment.";
    }

    res.status(200).json({ text: finalText });
  } catch (err) {
    const status = err?.status || err?.response?.status;
    if (status === 429) {
      return res.status(200).json({
        text:
          "The free-tier rate limit was hit and retries didn't clear it in time — please wait about 10-15 seconds and ask again.",
      });
    }
    res.status(500).json({ error: String(err) });
  }
}