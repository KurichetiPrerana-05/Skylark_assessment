// lib/monday.js
// Read-only wrapper around monday.com's GraphQL API, PLUS a server-side
// summarizer. We fetch ALL rows from a board (no cap, satisfies "read all
// data from both boards"), then compute aggregates/distributions in plain
// JS — only the compact summary (not raw rows) goes to the LLM. This keeps
// every answer grounded in the full board while staying far under the
// Groq free-tier token-per-minute limit.

const MONDAY_API_URL = "https://api.monday.com/v2";

async function mondayRequest(query, variables = {}) {
  const res = await fetch(MONDAY_API_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: process.env.MONDAY_API_TOKEN,
      "API-Version": "2024-10",
    },
    body: JSON.stringify({ query, variables }),
  });
  const json = await res.json();
  if (json.errors) {
    throw new Error("monday.com API error: " + JSON.stringify(json.errors));
  }
  return json.data;
}

// ---- Raw fetch: ALL items, ALL columns, fully paginated, no cap. ----
async function fetchAllBoardItems(boardId) {
  const query = `
    query ($boardId: [ID!], $limit: Int!, $cursor: String) {
      boards(ids: $boardId) {
        id
        name
        items_page(limit: $limit, cursor: $cursor) {
          cursor
          items {
            id
            name
            column_values {
              id
              text
              column { title }
            }
          }
        }
      }
    }
  `;

  let items = [];
  let cursor = null;
  let boardName = null;

  do {
    const data = await mondayRequest(query, {
      boardId: [String(boardId)],
      limit: 100,
      cursor,
    });
    const board = data.boards?.[0];
    if (!board) break;
    boardName = board.name;
    const page = board.items_page;
    items = items.concat(
      page.items.map((it) => ({
        id: it.id,
        name: it.name,
        ...Object.fromEntries(
          it.column_values.map((cv) => [
            cv.column.title,
            cv.text && cv.text.trim() !== "" ? cv.text.trim() : null,
          ])
        ),
      }))
    );
    cursor = page.cursor;
  } while (cursor);

  return { boardId, boardName, items };
}

// ---- Normalization helpers (handle messy real-world data) ----

// Parse loosely-formatted numbers like "₹1,20,000", "1200.50 HA", "5360"
function parseLooseNumber(text) {
  if (text == null) return null;
  const cleaned = String(text).replace(/[^0-9.\-]/g, "");
  if (cleaned === "" || cleaned === "-" || cleaned === ".") return null;
  const n = parseFloat(cleaned);
  return Number.isFinite(n) ? n : null;
}

// Normalize a category label for grouping (case/whitespace-insensitive)
// while keeping the most common original spelling for display.
function normalizeKey(text) {
  return String(text).trim().toLowerCase().replace(/\s+/g, " ");
}

// Parse a real calendar date, e.g. "2026-02-26" (monday.com's date column
// format). IMPORTANT: this must run BEFORE numeric classification — without
// it, parseLooseNumber("2025-07-31") silently returns 2025 (parseFloat stops
// at the first non-leading "-"), which makes every date column look like a
// "numeric" column whose min/max happen to be small years like 2024-2026.
// That false signal is what previously made the agent believe date columns
// only stored a year, when the real data has full day-level dates.
function parseLooseDate(text) {
  if (text == null) return null;
  const s = String(text).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  const d = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  return Number.isNaN(d.getTime()) ? null : d;
}
function toISODate(d) {
  return d.toISOString().slice(0, 10);
}
function quarterKey(d) {
  return d.getUTCFullYear() + "-Q" + (Math.floor(d.getUTCMonth() / 3) + 1);
}

// Decide whether a column looks like a date, numeric (money/quantity),
// categorical (status/sector/etc.), or free text, by sampling non-null
// values. Date check runs first — see parseLooseDate's comment above.
function classifyColumn(values) {
  const nonNull = values.filter((v) => v != null && v !== "");
  if (nonNull.length === 0) return "empty";
  const dateCount = nonNull.filter((v) => parseLooseDate(v) != null).length;
  if (dateCount / nonNull.length > 0.8) return "date";
  const numericCount = nonNull.filter((v) => parseLooseNumber(v) != null).length;
  if (numericCount / nonNull.length > 0.8) return "numeric";
  const uniqueRatio = new Set(nonNull.map(normalizeKey)).size / nonNull.length;
  if (uniqueRatio < 0.5 && nonNull.length >= 3) return "categorical";
  return "text";
}

// ---- Summarizer: compact JSON safe to hand to a small-context LLM. ----
function summarizeBoard({ boardId, boardName, items }, { sampleSize = 0 } = {}) {
  const totalItems = items.length;
  const columns = new Set();
  items.forEach((it) =>
    Object.keys(it).forEach((k) => k !== "id" && k !== "name" && columns.add(k))
  );

  const nullCounts = {};
  const columnSummaries = {};

  for (const col of columns) {
    const values = items.map((it) => it[col]);
    const nullCount = values.filter((v) => v == null).length;
    if (nullCount > 0) nullCounts[col] = nullCount;

    const kind = classifyColumn(values);
    if (kind === "date") {
      const dates = values.map(parseLooseDate).filter((d) => d != null);
      const quarterCounts = {};
      dates.forEach((d) => {
        const qk = quarterKey(d);
        quarterCounts[qk] = (quarterCounts[qk] || 0) + 1;
      });
      const sortedQuarters = Object.entries(quarterCounts).sort((a, b) =>
        a[0].localeCompare(b[0])
      );
      columnSummaries[col] = {
        type: "date",
        count: dates.length,
        minDate: dates.length ? toISODate(new Date(Math.min(...dates))) : null,
        maxDate: dates.length ? toISODate(new Date(Math.max(...dates))) : null,
        // Full day-level granularity is stored; this is a quarterly rollup
        // for a compact summary, not the actual stored precision.
        byQuarter: sortedQuarters.map(([q, count]) => ({ quarter: q, count })),
      };
    } else if (kind === "numeric") {
      const nums = values.map(parseLooseNumber).filter((n) => n != null);
      const sum = nums.reduce((a, b) => a + b, 0);
      columnSummaries[col] = {
        type: "numeric",
        count: nums.length,
        sum: Math.round(sum * 100) / 100,
        avg: nums.length ? Math.round((sum / nums.length) * 100) / 100 : null,
        min: nums.length ? Math.min(...nums) : null,
        max: nums.length ? Math.max(...nums) : null,
      };
    } else if (kind === "categorical") {
      const counts = {};
      values.forEach((v) => {
        if (v == null) return;
        const key = normalizeKey(v);
        counts[key] = counts[key] || { label: v, count: 0 };
        counts[key].count++;
      });
      const sorted = Object.values(counts).sort((a, b) => b.count - a.count);
      // Cap to top 12 categories to keep payload small; roll up the rest.
      const top = sorted.slice(0, 6);
      const restCount = sorted.slice(6).reduce((s, c) => s + c.count, 0);
      columnSummaries[col] = {
        type: "categorical",
        distribution: top.map((c) => ({ value: c.label, count: c.count })),
        ...(restCount > 0
          ? { otherValuesRolledUp: { count: restCount, uniqueValues: sorted.length - 6 } }
          : {}),
      };
    } else if (kind === "text") {
      columnSummaries[col] = { type: "text", nonNullCount: totalItems - nullCount };
    } else {
      columnSummaries[col] = { type: "empty" };
    }
  }

  // Small illustrative sample of raw rows for the model to ground specific
  // lookups against (e.g. "what's the status of deal X").
  const sample = items.slice(0, sampleSize);

  return {
    boardId,
    boardName,
    totalItems,
    dataQuality: { note: "full board, " + totalItems + " rows.", nullCounts },
    columnSummaries,
    sampleRows: sample,
  };
}

// Public: fetch + summarize a board in one call. This is the primary tool
// the agent uses for BI questions (revenue, pipeline, sector breakdowns).
async function getBoardSummary(boardId) {
  const raw = await fetchAllBoardItems(boardId);
  return summarizeBoard(raw);
}

// Public: search/filter raw items by a simple case-insensitive text match
// against item name or any column value — for specific record lookups
// ("what's the status of the Naruto deal") without pulling the whole board.
async function searchBoardItems(boardId, searchText, { maxResults = 10 } = {}) {
  const raw = await fetchAllBoardItems(boardId);
  const needle = normalizeKey(searchText);
  const matches = raw.items.filter((it) =>
    Object.values(it).some(
      (v) => v != null && normalizeKey(String(v)).includes(needle)
    )
  );
  return {
    boardId,
    boardName: raw.boardName,
    query: searchText,
    matchCount: matches.length,
    results: matches.slice(0, maxResults),
  };
}

async function listBoards() {
  const query = `query { boards(limit: 50) { id name items_count } }`;
  const data = await mondayRequest(query);
  return data.boards;
}

// Public: cross-tabulate two columns against each other (e.g. "Deal status"
// x "Sector") — exact counts computed over the FULL board, not an estimate.
// This is what lets the agent answer "how's X doing within Y" accurately
// instead of applying overall proportions to a subset.
// Case-insensitive column-name resolver: matches the caller's guess against
// the board's real column names, so minor case/wording mismatches don't
// silently produce all-blank results.
function resolveColumnName(items, requestedName) {
  const allCols = new Set();
  items.forEach((it) => Object.keys(it).forEach((k) => k !== "id" && k !== "name" && allCols.add(k)));
  const cols = Array.from(allCols);
  if (cols.includes(requestedName)) return { resolved: requestedName, availableColumns: cols };
  const needle = normalizeKey(requestedName);
  const match = cols.find((c) => normalizeKey(c) === needle || normalizeKey(c).includes(needle));
  return { resolved: match || null, availableColumns: cols };
}

async function getCrossTab(boardId, columnA, columnB) {
  const raw = await fetchAllBoardItems(boardId);

  const resA = resolveColumnName(raw.items, columnA);
  const resB = resolveColumnName(raw.items, columnB);
  if (!resA.resolved || !resB.resolved) {
    return {
      error: "Column not found on this board.",
      requested: { columnA, columnB },
      availableColumns: resA.availableColumns,
    };
  }
  columnA = resA.resolved;
  columnB = resB.resolved;

  const counts = {}; // { "valueA||valueB": count }
  const totalsA = {};
  const totalsB = {};

  for (const item of raw.items) {
    const vA = item[columnA];
    const vB = item[columnB];
    const keyA = vA == null ? "(blank)" : normalizeKey(vA);
    const keyB = vB == null ? "(blank)" : normalizeKey(vB);
    const labelA = vA == null ? "(blank)" : vA;
    const labelB = vB == null ? "(blank)" : vB;

    const cellKey = keyA + "||" + keyB;
    counts[cellKey] = counts[cellKey] || { labelA, labelB, count: 0 };
    counts[cellKey].count++;

    totalsA[keyA] = totalsA[keyA] || { label: labelA, count: 0 };
    totalsA[keyA].count++;
    totalsB[keyB] = totalsB[keyB] || { label: labelB, count: 0 };
    totalsB[keyB].count++;
  }

  return {
    boardId,
    boardName: raw.boardName,
    columnA,
    columnB,
    totalItems: raw.items.length,
    cells: Object.values(counts)
      .sort((a, b) => b.count - a.count)
      .slice(0, 15), // cap cross-tab cells to keep payload small
    totalsByColumnA: Object.values(totalsA)
      .sort((a, b) => b.count - a.count)
      .slice(0, 8),
    totalsByColumnB: Object.values(totalsB)
      .sort((a, b) => b.count - a.count)
      .slice(0, 8),
    note: "exact counts, all " + raw.items.length + " rows.",
  };
}

// Public: sum a numeric column grouped by a categorical column (e.g. total
// Masked Deal value per Sector) — computed once over the FULL board, capped
// to the top groups by row count so payload stays small and fast.
async function getGroupedSum(boardId, groupByColumn, sumColumn, { topN = 8 } = {}) {
  const raw = await fetchAllBoardItems(boardId);

  const resG = resolveColumnName(raw.items, groupByColumn);
  const resS = resolveColumnName(raw.items, sumColumn);
  if (!resG.resolved || !resS.resolved) {
    return {
      error: "Column not found on this board.",
      requested: { groupByColumn, sumColumn },
      availableColumns: resG.availableColumns,
    };
  }
  groupByColumn = resG.resolved;
  sumColumn = resS.resolved;

  const groups = {}; // key -> { label, count, sum, nonNumericCount }

  for (const item of raw.items) {
    const gv = item[groupByColumn];
    const key = gv == null ? "(blank)" : normalizeKey(gv);
    const label = gv == null ? "(blank)" : gv;
    groups[key] = groups[key] || { label, count: 0, sum: 0, nonNumericCount: 0 };
    groups[key].count++;

    const raw_v = item[sumColumn];
    const n = parseLooseNumber(raw_v);
    if (n != null) {
      groups[key].sum += n;
    } else if (raw_v != null) {
      groups[key].nonNumericCount++;
    }
  }

  const sorted = Object.values(groups)
    .map((g) => ({ ...g, sum: Math.round(g.sum * 100) / 100 }))
    .sort((a, b) => b.sum - a.sum);

  const top = sorted.slice(0, topN);
  const restCount = sorted.slice(topN).reduce((s, g) => s + g.count, 0);
  const restSum = sorted.slice(topN).reduce((s, g) => s + g.sum, 0);

  return {
    boardId,
    boardName: raw.boardName,
    groupByColumn,
    sumColumn,
    totalItems: raw.items.length,
    groups: top,
    ...(sorted.length > topN
      ? { otherGroupsRolledUp: { count: restCount, sum: Math.round(restSum * 100) / 100 } }
      : {}),
    note: "exact sums, all " + raw.items.length + " rows.",
  };
}

// Public: ONE consolidated call that answers "filtered by category AND/OR
// date range, then summed/broken down" questions (e.g. "Renewables +
// Powerline deals closing in Q3 2026") in a single round trip. Doing this
// as one tool call instead of get_board_summary + get_cross_tab +
// get_grouped_sum separately is what keeps a combined sector+time question
// under the Groq free-tier token-per-minute limit — every extra tool call
// re-sends the growing conversation (system prompt + prior tool results) to
// the model, so 3 calls costs roughly 3x the tokens of 1.
//
// filters: [{ column, values: [...] }] — row matches if its value for
//   `column` case-insensitively equals ANY of `values` (OR within a filter,
//   AND across filters).
// dateColumns: date column name(s) to check — a row is "in range" if ANY
//   of them falls within [startDate, endDate] (inclusive; either bound may
//   be omitted). Column names are auto-corrected like the other tools.
// sumColumn / groupByColumn: optional, computed only over rows that match
//   both the filters and the date range.
async function getFilteredAggregate(
  boardId,
  { filters = [], dateColumns = [], startDate = null, endDate = null, sumColumn = null, groupByColumn = null } = {}
) {
  const raw = await fetchAllBoardItems(boardId);

  const resolvedFilters = [];
  for (const f of filters) {
    const res = resolveColumnName(raw.items, f.column);
    if (!res.resolved) {
      return {
        error: "Filter column not found on this board.",
        requested: f.column,
        availableColumns: res.availableColumns,
      };
    }
    resolvedFilters.push({ column: res.resolved, values: (f.values || []).map(normalizeKey) });
  }

  let resolvedDateColumns = [];
  for (const dc of dateColumns) {
    const res = resolveColumnName(raw.items, dc);
    if (!res.resolved) {
      return { error: "Date column not found on this board.", requested: dc, availableColumns: res.availableColumns };
    }
    resolvedDateColumns.push(res.resolved);
  }

  let resolvedSumColumn = null;
  if (sumColumn) {
    const res = resolveColumnName(raw.items, sumColumn);
    if (!res.resolved) {
      return { error: "Sum column not found on this board.", requested: sumColumn, availableColumns: res.availableColumns };
    }
    resolvedSumColumn = res.resolved;
  }

  let resolvedGroupByColumn = null;
  if (groupByColumn) {
    const res = resolveColumnName(raw.items, groupByColumn);
    if (!res.resolved) {
      return { error: "Group-by column not found on this board.", requested: groupByColumn, availableColumns: res.availableColumns };
    }
    resolvedGroupByColumn = res.resolved;
  }

  const start = startDate ? parseLooseDate(startDate) : null;
  const end = endDate ? parseLooseDate(endDate) : null;

  const matchesFilters = (item) =>
    resolvedFilters.every((f) => {
      const v = item[f.column];
      return v != null && f.values.includes(normalizeKey(v));
    });

  const dateInRange = (item) => {
    if (resolvedDateColumns.length === 0) return true; // no date filter requested
    return resolvedDateColumns.some((col) => {
      const d = parseLooseDate(item[col]);
      if (!d) return false;
      if (start && d < start) return false;
      if (end && d > end) return false;
      return true;
    });
  };

  const hasAnyDate = (item) => resolvedDateColumns.some((col) => parseLooseDate(item[col]) != null);

  const filterMatches = raw.items.filter(matchesFilters);
  const inRangeMatches = filterMatches.filter(dateInRange);
  const noDateAtAll = resolvedDateColumns.length
    ? filterMatches.filter((it) => !hasAnyDate(it)).length
    : null;

  const sumOf = (rows) => {
    if (!resolvedSumColumn) return null;
    return Math.round(rows.reduce((s, it) => s + (parseLooseNumber(it[resolvedSumColumn]) || 0), 0) * 100) / 100;
  };

  let groupDistribution = null;
  if (resolvedGroupByColumn) {
    const counts = {};
    inRangeMatches.forEach((it) => {
      const v = it[resolvedGroupByColumn];
      const label = v == null ? "(blank)" : v;
      const key = normalizeKey(label);
      counts[key] = counts[key] || { label, count: 0 };
      counts[key].count++;
    });
    groupDistribution = Object.values(counts).sort((a, b) => b.count - a.count);
  }

  return {
    boardId,
    boardName: raw.boardName,
    filtersApplied: resolvedFilters,
    dateRangeApplied: resolvedDateColumns.length
      ? { dateColumns: resolvedDateColumns, startDate, endDate }
      : null,
    matchingFilters: filterMatches.length,
    matchingFiltersAndDateRange: inRangeMatches.length,
    matchingFiltersWithNoDateRecorded: noDateAtAll,
    sum: resolvedSumColumn
      ? { column: resolvedSumColumn, forDateRangeMatches: sumOf(inRangeMatches), forAllFilterMatches: sumOf(filterMatches) }
      : null,
    groupDistribution,
    note:
      "Computed over all " +
      raw.items.length +
      " rows on the board; matchingFiltersAndDateRange is the number actually inside the requested date window.",
  };
}

module.exports = {
  getBoardSummary,
  searchBoardItems,
  getCrossTab,
  getGroupedSum,
  getFilteredAggregate,
  listBoards,
};