import { useState } from "react";

export default function Home() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);

  async function send() {
    if (!input.trim()) return;
    const next = [...messages, { role: "user", content: input }];
    setMessages(next);
    setInput("");
    setLoading(true);
    const res = await fetch("/api/chat", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ messages: next }),
    });
    const data = await res.json();
    setLoading(false);
    if (data.error) {
      setMessages([...next, { role: "assistant", content: "Error: " + JSON.stringify(data.error) }]);
      return;
    }
    setMessages([...next, { role: "assistant", content: data.text }]);
  }

  return (
    <div style={{ maxWidth: 720, margin: "40px auto", fontFamily: "sans-serif" }}>
      <h2>Skylark Drones — BI Agent (prototype)</h2>
      <p style={{ color: "#666", fontSize: 14 }}>
        Ask founder-level questions across the Work Order Tracker and Deal Funnel monday.com boards.
      </p>
      <div style={{ border: "1px solid #ddd", borderRadius: 8, padding: 16, minHeight: 300, marginBottom: 16 }}>
        {messages.map((m, i) => (
          <div key={i} style={{ margin: "10px 0", textAlign: m.role === "user" ? "right" : "left" }}>
            <div
              style={{
                display: "inline-block",
                background: m.role === "user" ? "#0070f3" : "#f1f1f1",
                color: m.role === "user" ? "#fff" : "#000",
                padding: "8px 12px",
                borderRadius: 8,
                maxWidth: "80%",
                whiteSpace: "pre-wrap",
              }}
            >
              {m.content}
            </div>
          </div>
        ))}
        {loading && <div style={{ color: "#999" }}>Thinking…</div>}
      </div>
      <div style={{ display: "flex", gap: 8 }}>
        <input
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => e.key === "Enter" && send()}
          placeholder="e.g. How's our pipeline looking for the energy sector this quarter?"
          style={{ flex: 1, padding: 10, borderRadius: 6, border: "1px solid #ccc" }}
        />
        <button onClick={send} style={{ padding: "10px 18px", borderRadius: 6 }}>Send</button>
      </div>
    </div>
  );
}
