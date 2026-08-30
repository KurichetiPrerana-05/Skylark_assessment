import { useEffect, useRef, useState } from "react";
import Head from "next/head";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

// ---------------------------------------------------------------------------
// Dark-theme styling for markdown content coming back from the agent
// (tables, code, lists, etc). Kept as inline styles so it renders correctly
// regardless of where react-markdown mounts its own elements.
// ---------------------------------------------------------------------------
const markdownComponents = {
  table: ({ node, ...props }) => (
    <div style={{ overflowX: "auto", margin: "10px 0", borderRadius: 8, border: "1px solid #22314d" }}>
      <table style={{ borderCollapse: "collapse", width: "100%", fontSize: 13.5 }} {...props} />
    </div>
  ),
  th: (props) => (
    <th
      style={{
        borderBottom: "1px solid #2a3b5c",
        padding: "8px 10px",
        background: "#152238",
        color: "#eaf0f7",
        textAlign: "left",
        fontFamily: "'IBM Plex Mono', monospace",
        fontWeight: 500,
        fontSize: 12,
        letterSpacing: "0.03em",
        textTransform: "uppercase",
      }}
      {...props}
    />
  ),
  td: (props) => (
    <td style={{ borderBottom: "1px solid #1c2942", padding: "8px 10px", color: "#c9d6e8" }} {...props} />
  ),
  h1: (props) => <h3 style={{ margin: "14px 0 6px", color: "#f2f6fb", fontFamily: "'Space Grotesk', sans-serif" }} {...props} />,
  h2: (props) => <h4 style={{ margin: "12px 0 6px", color: "#f2f6fb", fontFamily: "'Space Grotesk', sans-serif" }} {...props} />,
  h3: (props) => <h4 style={{ margin: "10px 0 5px", color: "#f2f6fb", fontFamily: "'Space Grotesk', sans-serif" }} {...props} />,
  p: (props) => <p style={{ margin: "6px 0", lineHeight: 1.6, color: "#dce6f2" }} {...props} />,
  ul: (props) => <ul style={{ margin: "6px 0", paddingLeft: 20, color: "#dce6f2" }} {...props} />,
  ol: (props) => <ol style={{ margin: "6px 0", paddingLeft: 20, color: "#dce6f2" }} {...props} />,
  li: (props) => <li style={{ margin: "3px 0" }} {...props} />,
  strong: (props) => <strong style={{ color: "#f8fafc", fontWeight: 600 }} {...props} />,
  a: (props) => <a style={{ color: "#f5b84e" }} {...props} />,
  blockquote: (props) => (
    <blockquote
      style={{ borderLeft: "3px solid #e8a33d", margin: "8px 0", padding: "2px 0 2px 12px", color: "#93a6c2" }}
      {...props}
    />
  ),
  code: ({ inline, ...props }) =>
    inline ? (
      <code
        style={{
          background: "#152238",
          color: "#f5b84e",
          padding: "1px 6px",
          borderRadius: 4,
          fontFamily: "'IBM Plex Mono', monospace",
          fontSize: 13,
        }}
        {...props}
      />
    ) : (
      <code style={{ fontFamily: "'IBM Plex Mono', monospace", fontSize: 13 }} {...props} />
    ),
  pre: (props) => (
    <pre
      style={{
        background: "#0d1526",
        border: "1px solid #22314d",
        borderRadius: 8,
        padding: 12,
        overflowX: "auto",
        margin: "8px 0",
      }}
      {...props}
    />
  ),
};

// ---------------------------------------------------------------------------
// Ready-made questions a founder is likely to ask, mapped to what the agent's
// tools (get_board_summary / get_cross_tab / get_grouped_sum) can actually
// answer well. Includes the "leadership update" flow from the decision log.
// ---------------------------------------------------------------------------
const SAMPLE_QUESTIONS = [
  {
    label: "Leadership update",
    text: "Prepare a leadership update summarizing both boards — headline metrics, notable risks, notable wins, and any data-quality caveats.",
    tag: "Both boards",
  },
  {
    label: "Energy sector pipeline",
    text: "How's our pipeline looking for the energy sector this quarter?",
    tag: "Deal Funnel",
  },
  {
    label: "Deal value by sector",
    text: "What's our total deal value, broken down by sector?",
    tag: "Deal Funnel",
  },
  {
    label: "At-risk work orders",
    text: "Which work orders are overdue or at risk right now?",
    tag: "Work Orders",
  },
  {
    label: "Funnel status breakdown",
    text: "Give me the exact status breakdown across the Deal Funnel.",
    tag: "Deal Funnel",
  },
  {
    label: "Collections snapshot",
    text: "What does our collection status look like across active work orders?",
    tag: "Work Orders",
  },
];

export default function Home() {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);

  const textareaRef = useRef(null);
  const bottomRef = useRef(null);

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth", block: "end" });
  }, [messages, loading]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 220) + "px";
  }, [input]);

  async function send(overrideText) {
    const text = (overrideText ?? input).trim();
    if (!text || loading) return;
    const next = [...messages, { role: "user", content: text }];
    setMessages(next);
    setInput("");
    setLoading(true);
    try {
      const res = await fetch("/api/chat", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ messages: next }),
      });
      const data = await res.json();
      if (data.error) {
        setMessages([...next, { role: "assistant", content: "**Error:** " + JSON.stringify(data.error) }]);
      } else {
        setMessages([...next, { role: "assistant", content: data.text }]);
      }
    } catch (err) {
      setMessages([...next, { role: "assistant", content: "**Error:** couldn't reach the agent. " + String(err) }]);
    } finally {
      setLoading(false);
    }
  }

  function handleKeyDown(e) {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      send();
    }
  }

  const hasMessages = messages.length > 0;

  return (
    <div className="sk-app">
      <Head>
        <title>Skylark BI Console</title>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="true" />
        <link
          href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@500;600;700&family=IBM+Plex+Sans:wght@400;500;600&family=IBM+Plex+Mono:wght@400;500&display=swap"
          rel="stylesheet"
        />
      </Head>

      <div className="sk-shell">
        <header className="sk-header">
          <div className="sk-brand">
            <div className="sk-brand-mark">SD</div>
            <div>
              <div className="sk-brand-title">Skylark <span>BI Console</span></div>
              <p className="sk-brand-sub">
                Founder-level answers, computed live over the Work Order Tracker &amp; Deal Funnel boards.
              </p>
            </div>
          </div>
          <div className="sk-status">
            <span className="sk-status-pill">
              <span className="sk-dot" /> Work Orders
            </span>
            <span className="sk-status-pill">
              <span className="sk-dot" /> Deal Funnel
            </span>
          </div>
          <div className="sk-flightline" aria-hidden="true" />
        </header>

        <main className="sk-panel">
          <div className="sk-grid-overlay" aria-hidden="true" />

          {!hasMessages && (
            <div className="sk-hero">
              <p className="sk-eyebrow">// live board query</p>
              <h1>Ask anything about the business.</h1>
              <p className="sk-hero-copy">
                No hardcoded numbers — every figure is pulled and computed fresh from monday.com.
                Start typing below, or launch one of these.
              </p>
              <div className="sk-chip-grid">
                {SAMPLE_QUESTIONS.map((q) => (
                  <button key={q.label} className="sk-chip-card" onClick={() => send(q.text)} disabled={loading}>
                    <span className="sk-chip-tag">{q.tag}</span>
                    <span className="sk-chip-label">{q.label}</span>
                    <span className="sk-chip-text">{q.text}</span>
                  </button>
                ))}
              </div>
            </div>
          )}

          {hasMessages && (
            <>
              <div className="sk-quickbar">
                {SAMPLE_QUESTIONS.map((q) => (
                  <button key={q.label} className="sk-quickchip" onClick={() => send(q.text)} disabled={loading}>
                    {q.label}
                  </button>
                ))}
              </div>

              <div className="sk-thread">
                {messages.map((m, i) => (
                  <div key={i} className={"sk-row " + (m.role === "user" ? "sk-row-user" : "sk-row-assistant")}>
                    {m.role === "assistant" && <div className="sk-avatar">SD</div>}
                    <div className={"sk-bubble " + (m.role === "user" ? "sk-bubble-user" : "sk-bubble-assistant")}>
                      {m.role === "user" ? (
                        <span className="sk-user-text">{m.content}</span>
                      ) : (
                        <ReactMarkdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                          {m.content}
                        </ReactMarkdown>
                      )}
                    </div>
                  </div>
                ))}

                {loading && (
                  <div className="sk-row sk-row-assistant">
                    <div className="sk-avatar">SD</div>
                    <div className="sk-bubble sk-bubble-assistant sk-thinking">
                      <span className="sk-radar" />
                      <span className="sk-thinking-text">Reading board data…</span>
                    </div>
                  </div>
                )}
                <div ref={bottomRef} />
              </div>
            </>
          )}
        </main>

        <footer className="sk-composer">
          <div className="sk-composer-inner">
            <textarea
              ref={textareaRef}
              rows={1}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="e.g. How's our pipeline looking for the energy sector this quarter?"
              disabled={loading}
            />
            <button className="sk-send" onClick={() => send()} disabled={loading || !input.trim()} aria-label="Send">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none">
                <path d="M4 12L20 4L14 20L11 13L4 12Z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round" strokeLinecap="round" />
              </svg>
            </button>
          </div>
          <p className="sk-hint">Enter to send · Shift + Enter for a new line</p>
        </footer>
      </div>

      <style jsx global>{`
        html, body {
          margin: 0;
          padding: 0;
          background: #070b13;
        }
        * { box-sizing: border-box; }
      `}</style>

      <style jsx>{`
        .sk-app {
          --bg-deep: #070b13;
          --bg-shell: #0a0f1c;
          --bg-panel: #0d1424;
          --bg-raised: #141f36;
          --line: #1e2c46;
          --line-soft: #16223a;
          --text-primary: #eaf0f7;
          --text-secondary: #93a6c2;
          --text-tertiary: #5d7191;
          --accent: #e8a33d;
          --accent-strong: #f5b84e;
          --accent-soft: rgba(232, 163, 61, 0.12);
          --teal: #5ea8b8;
          --success: #6fcf97;
          --font-display: "Space Grotesk", sans-serif;
          --font-body: "IBM Plex Sans", sans-serif;
          --font-mono: "IBM Plex Mono", monospace;

          min-height: 100vh;
          background:
            radial-gradient(1200px 600px at 15% -10%, rgba(232, 163, 61, 0.07), transparent 60%),
            radial-gradient(900px 500px at 100% 0%, rgba(94, 168, 184, 0.06), transparent 55%),
            var(--bg-deep);
          font-family: var(--font-body);
          color: var(--text-primary);
          display: flex;
          justify-content: center;
          padding: 28px 16px 40px;
        }

        .sk-shell {
          width: 100%;
          max-width: 860px;
          display: flex;
          flex-direction: column;
          height: calc(100vh - 68px);
          min-height: 560px;
        }

        /* ---------------- Header ---------------- */
        .sk-header {
          position: relative;
          display: flex;
          align-items: flex-start;
          justify-content: space-between;
          gap: 16px;
          padding: 4px 4px 20px;
          flex-wrap: wrap;
        }
        .sk-brand {
          display: flex;
          align-items: center;
          gap: 14px;
        }
        .sk-brand-mark {
          width: 42px;
          height: 42px;
          flex: none;
          border-radius: 10px;
          background: linear-gradient(150deg, var(--accent-strong), #b3781f);
          color: #1a1002;
          font-family: var(--font-display);
          font-weight: 700;
          font-size: 15px;
          display: flex;
          align-items: center;
          justify-content: center;
          box-shadow: 0 0 0 1px rgba(232, 163, 61, 0.35), 0 8px 20px -6px rgba(232, 163, 61, 0.45);
        }
        .sk-brand-title {
          font-family: var(--font-display);
          font-weight: 600;
          font-size: 21px;
          letter-spacing: -0.01em;
          color: var(--text-primary);
        }
        .sk-brand-title span {
          color: var(--accent-strong);
          font-weight: 500;
        }
        .sk-brand-sub {
          margin: 4px 0 0;
          font-size: 13px;
          color: var(--text-secondary);
          max-width: 46ch;
          line-height: 1.45;
        }
        .sk-status {
          display: flex;
          gap: 8px;
          padding-top: 6px;
        }
        .sk-status-pill {
          display: flex;
          align-items: center;
          gap: 6px;
          font-family: var(--font-mono);
          font-size: 11px;
          letter-spacing: 0.02em;
          color: var(--text-secondary);
          background: var(--bg-raised);
          border: 1px solid var(--line);
          padding: 5px 10px;
          border-radius: 999px;
        }
        .sk-dot {
          width: 6px;
          height: 6px;
          border-radius: 50%;
          background: var(--success);
          box-shadow: 0 0 0 3px rgba(111, 207, 151, 0.18);
          animation: sk-pulse 2.4s ease-in-out infinite;
        }
        .sk-flightline {
          position: absolute;
          left: 4px;
          right: 4px;
          bottom: 0;
          height: 1px;
          background: linear-gradient(90deg, transparent, var(--line) 15%, var(--line) 85%, transparent);
          overflow: hidden;
        }
        .sk-flightline::after {
          content: "";
          position: absolute;
          top: 0;
          left: -30%;
          width: 30%;
          height: 100%;
          background: linear-gradient(90deg, transparent, var(--accent-strong), transparent);
          animation: sk-fly 5s linear infinite;
        }

        /* ---------------- Panel ---------------- */
        .sk-panel {
          position: relative;
          flex: 1;
          min-height: 0;
          background: var(--bg-panel);
          border: 1px solid var(--line);
          border-radius: 16px;
          overflow: hidden;
          display: flex;
          flex-direction: column;
        }
        .sk-grid-overlay {
          position: absolute;
          inset: 0;
          pointer-events: none;
          background-image:
            linear-gradient(var(--line-soft) 1px, transparent 1px),
            linear-gradient(90deg, var(--line-soft) 1px, transparent 1px);
          background-size: 32px 32px;
          opacity: 0.35;
          mask-image: radial-gradient(circle at 30% 0%, black, transparent 75%);
        }

        /* ---------------- Hero / empty state ---------------- */
        .sk-hero {
          position: relative;
          padding: 40px 32px;
          overflow-y: auto;
        }
        .sk-eyebrow {
          font-family: var(--font-mono);
          font-size: 12px;
          color: var(--accent-strong);
          letter-spacing: 0.04em;
          margin: 0 0 10px;
        }
        .sk-hero h1 {
          font-family: var(--font-display);
          font-size: 30px;
          font-weight: 600;
          margin: 0 0 10px;
          letter-spacing: -0.01em;
        }
        .sk-hero-copy {
          color: var(--text-secondary);
          font-size: 14.5px;
          line-height: 1.6;
          max-width: 56ch;
          margin: 0 0 26px;
        }
        .sk-chip-grid {
          display: grid;
          grid-template-columns: repeat(2, 1fr);
          gap: 10px;
        }
        .sk-chip-card {
          text-align: left;
          background: var(--bg-raised);
          border: 1px solid var(--line);
          border-radius: 12px;
          padding: 14px 15px;
          cursor: pointer;
          display: flex;
          flex-direction: column;
          gap: 4px;
          transition: border-color 0.15s ease, transform 0.15s ease, background 0.15s ease;
          font-family: var(--font-body);
          color: var(--text-primary);
        }
        .sk-chip-card:hover:not(:disabled) {
          border-color: var(--accent);
          background: #16223d;
          transform: translateY(-1px);
        }
        .sk-chip-card:disabled { opacity: 0.5; cursor: default; }
        .sk-chip-tag {
          font-family: var(--font-mono);
          font-size: 10px;
          letter-spacing: 0.04em;
          text-transform: uppercase;
          color: var(--teal);
        }
        .sk-chip-label {
          font-weight: 600;
          font-size: 14px;
        }
        .sk-chip-text {
          font-size: 12.5px;
          color: var(--text-tertiary);
          line-height: 1.4;
        }

        /* ---------------- Quick bar (once conversation started) ---------------- */
        .sk-quickbar {
          position: relative;
          display: flex;
          gap: 8px;
          padding: 12px 16px;
          overflow-x: auto;
          border-bottom: 1px solid var(--line);
          flex: none;
        }
        .sk-quickchip {
          flex: none;
          font-family: var(--font-mono);
          font-size: 12px;
          color: var(--text-secondary);
          background: var(--bg-raised);
          border: 1px solid var(--line);
          border-radius: 999px;
          padding: 6px 12px;
          cursor: pointer;
          white-space: nowrap;
          transition: border-color 0.15s ease, color 0.15s ease;
        }
        .sk-quickchip:hover:not(:disabled) {
          border-color: var(--accent);
          color: var(--accent-strong);
        }
        .sk-quickchip:disabled { opacity: 0.45; cursor: default; }

        /* ---------------- Thread ---------------- */
        .sk-thread {
          position: relative;
          flex: 1;
          min-height: 0;
          overflow-y: auto;
          padding: 20px;
          display: flex;
          flex-direction: column;
          gap: 16px;
        }
        .sk-row {
          display: flex;
          gap: 10px;
          align-items: flex-start;
        }
        .sk-row-user { justify-content: flex-end; }
        .sk-avatar {
          flex: none;
          width: 28px;
          height: 28px;
          border-radius: 8px;
          background: var(--bg-raised);
          border: 1px solid var(--line);
          color: var(--accent-strong);
          font-family: var(--font-mono);
          font-size: 10px;
          font-weight: 500;
          display: flex;
          align-items: center;
          justify-content: center;
        }
        .sk-bubble {
          max-width: 78%;
          padding: 12px 15px;
          border-radius: 14px;
          font-size: 14.5px;
          line-height: 1.55;
        }
        .sk-bubble-user {
          background: linear-gradient(155deg, var(--accent), #c98a2f);
          color: #1a1002;
          border-bottom-right-radius: 4px;
          font-weight: 500;
        }
        .sk-user-text { white-space: pre-wrap; }
        .sk-bubble-assistant {
          background: var(--bg-raised);
          border: 1px solid var(--line);
          border-bottom-left-radius: 4px;
        }
        .sk-thinking {
          display: flex;
          align-items: center;
          gap: 10px;
        }
        .sk-radar {
          position: relative;
          width: 14px;
          height: 14px;
          border-radius: 50%;
          border: 1px solid var(--line);
        }
        .sk-radar::after {
          content: "";
          position: absolute;
          inset: -1px;
          border-radius: 50%;
          border: 1px solid transparent;
          border-top-color: var(--accent-strong);
          animation: sk-spin 0.9s linear infinite;
        }
        .sk-thinking-text {
          font-family: var(--font-mono);
          font-size: 12.5px;
          color: var(--text-secondary);
        }

        /* ---------------- Composer ---------------- */
        .sk-composer {
          padding-top: 14px;
        }
        .sk-composer-inner {
          display: flex;
          align-items: flex-end;
          gap: 10px;
          background: var(--bg-raised);
          border: 1px solid var(--line);
          border-radius: 14px;
          padding: 8px 8px 8px 16px;
        }
        .sk-composer-inner:focus-within {
          border-color: var(--accent);
          box-shadow: 0 0 0 3px var(--accent-soft);
        }
        .sk-composer textarea {
          flex: 1;
          resize: none;
          border: none;
          outline: none;
          background: transparent;
          color: var(--text-primary);
          font-family: var(--font-body);
          font-size: 14.5px;
          line-height: 1.5;
          padding: 8px 0;
          max-height: 220px;
        }
        .sk-composer textarea::placeholder { color: var(--text-tertiary); }
        .sk-send {
          flex: none;
          width: 38px;
          height: 38px;
          border-radius: 10px;
          border: none;
          background: linear-gradient(150deg, var(--accent-strong), #b3781f);
          color: #1a1002;
          display: flex;
          align-items: center;
          justify-content: center;
          cursor: pointer;
          transition: transform 0.12s ease, opacity 0.12s ease;
        }
        .sk-send:hover:not(:disabled) { transform: translateY(-1px); }
        .sk-send:disabled { opacity: 0.4; cursor: default; }
        .sk-hint {
          margin: 8px 4px 0;
          font-size: 11.5px;
          color: var(--text-tertiary);
          font-family: var(--font-mono);
        }

        @keyframes sk-pulse {
          0%, 100% { box-shadow: 0 0 0 3px rgba(111, 207, 151, 0.18); }
          50% { box-shadow: 0 0 0 5px rgba(111, 207, 151, 0.06); }
        }
        @keyframes sk-fly {
          0% { left: -30%; }
          100% { left: 100%; }
        }
        @keyframes sk-spin {
          to { transform: rotate(360deg); }
        }

        @media (max-width: 640px) {
          .sk-chip-grid { grid-template-columns: 1fr; }
          .sk-bubble { max-width: 88%; }
          .sk-shell { height: calc(100vh - 32px); }
        }

        @media (prefers-reduced-motion: reduce) {
          .sk-dot, .sk-flightline::after, .sk-radar::after { animation: none; }
        }
      `}</style>
    </div>
  );
}