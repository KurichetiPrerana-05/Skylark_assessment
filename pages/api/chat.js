// /pages/api/chat.js
// Server-side route: takes the conversation, calls Claude with monday.com's
// hosted MCP server attached, and returns Claude's reply.
// Keeps both API keys server-only (never sent to the browser).

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const { messages } = req.body; // [{role:"user"|"assistant", content:"..."}]

  const SYSTEM_PROMPT = `You are a founder-facing Business Intelligence agent for Skylark Drones.
You have READ access to two monday.com boards via MCP tools:
1. "Work Order Tracker" board — project execution, billing, collection data.
2. "Deal Funnel" board — sales pipeline / deals data.

Rules:
- Always query monday.com live via the available MCP tools. Never invent numbers.
- Data is real-world messy: handle missing/null values, inconsistent sectors/date
  formats gracefully. State any data-quality caveats you relied on.
- When a query is ambiguous (e.g. "this quarter", "pipeline"), ask a brief
  clarifying question OR state the assumption you're making and proceed.
- For BI questions, don't just dump numbers — add 1-2 lines of interpretation
  (trend, risk, what a founder should do next).
- If asked to "prepare a leadership update", produce a short structured summary
  (headline metrics, notable risks, notable wins) pulled live from both boards.`;

  try {
    const response = await fetch("https://api.anthropic.com/v1/messages", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": process.env.ANTHROPIC_API_KEY,
        "anthropic-version": "2023-06-01",
        // MCP connector for the Messages API is currently a beta header
        "anthropic-beta": "mcp-client-2025-04-04",
      },
      body: JSON.stringify({
        model: "claude-sonnet-4-6",
        max_tokens: 1500,
        system: SYSTEM_PROMPT,
        messages,
        mcp_servers: [
          {
            type: "url",
            url: "https://mcp.monday.com/mcp",
            name: "monday",
            authorization_token: process.env.MONDAY_API_TOKEN,
          },
        ],
      }),
    });

    const data = await response.json();
    if (data.error) return res.status(500).json({ error: data.error });

    const text = (data.content || [])
      .filter((b) => b.type === "text")
      .map((b) => b.text)
      .join("\n");

    res.status(200).json({ text, raw: data });
  } catch (err) {
    res.status(500).json({ error: String(err) });
  }
}
