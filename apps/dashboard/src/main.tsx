import React, { useCallback, useEffect, useMemo, useState } from "react";
import { createRoot } from "react-dom/client";
import "./style.css";

interface LogEvent {
  id: string;
  project: string;
  timestamp: string;
  level: string;
  message: string;
  service: string;
  environment: string;
  traceId: string | null;
  requestId: string | null;
  metadata: Record<string, unknown>;
}

interface QueryResult {
  logs: LogEvent[];
  nextCursor: string | null;
}

const dashboardApiDefault = location.hostname === "localhost" && location.port === "5173"
  ? "http://127.0.0.1:8787"
  : location.origin;
const API = (import.meta.env.VITE_LOG_ARITHMIC_URL || import.meta.env.VITE_LOGFORGE_URL || dashboardApiDefault).replace(/\/+$/, "");

function App() {
  const [key, setKey] = useState(localStorage.getItem("log-arithmic-key") || "");
  const [draftKey, setDraftKey] = useState(key);
  const [logs, setLogs] = useState<LogEvent[]>([]);
  const [selected, setSelected] = useState<LogEvent | null>(null);
  const [traceEvents, setTraceEvents] = useState<LogEvent[]>([]);
  const [traceLoading, setTraceLoading] = useState(false);
  const [search, setSearch] = useState("");
  const [service, setService] = useState("");
  const [level, setLevel] = useState("");
  const [live, setLive] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [nextCursor, setNextCursor] = useState<string | null>(null);
  const [status, setStatus] = useState<"checking" | "online" | "offline">("checking");

  const params = useMemo(() => {
    const result = new URLSearchParams();
    if (search) result.set("search", search);
    if (service) result.set("service", service);
    if (level) result.set("level", level);
    result.set("limit", "100");
    return result;
  }, [search, service, level]);

  const load = useCallback(async (cursor?: string) => {
    if (!key) return;
    setLoading(true);
    setError("");
    try {
      const query = new URLSearchParams(params);
      if (cursor) query.set("cursor", cursor);
      const response = await fetch(`${API}/api/v1/logs?${query}`, { headers: { Authorization: `Bearer ${key}` } });
      if (!response.ok) throw new Error(response.status === 401 ? "API key is invalid or revoked." : `Log query failed (${response.status}).`);
      const result = await response.json() as QueryResult;
      setLogs((current) => cursor ? [...current, ...result.logs] : result.logs);
      setNextCursor(result.nextCursor);
      setStatus("online");
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to load logs.");
      setStatus("offline");
    } finally {
      setLoading(false);
    }
  }, [key, params]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    if (!live || !key) return;
    const controller = new AbortController();
    let active = true;
    const stream = async () => {
      try {
        const response = await fetch(`${API}/api/v1/stream?${params}`, {
          headers: { Authorization: `Bearer ${key}`, Accept: "text/event-stream" },
          signal: controller.signal,
        });
        if (!response.ok || !response.body) throw new Error(`Live stream failed (${response.status}).`);
        setStatus("online");
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffered = "";
        while (active) {
          const { done, value } = await reader.read();
          if (done) break;
          buffered += decoder.decode(value, { stream: true });
          const frames = buffered.split("\n\n");
          buffered = frames.pop() || "";
          for (const frame of frames) {
            const line = frame.split("\n").find((part) => part.startsWith("data: "));
            if (!line || !frame.startsWith("event: log\n")) continue;
            const event = JSON.parse(line.slice(6)) as LogEvent;
            setLogs((current) => [event, ...current].slice(0, 500));
          }
        }
      } catch (reason) {
        if (active && !controller.signal.aborted) setError(reason instanceof Error ? reason.message : "Live connection failed.");
      }
    };
    void stream();
    return () => { active = false; controller.abort(); };
  }, [live, key, params]);

  function saveKey(event: React.FormEvent) {
    event.preventDefault();
    const clean = draftKey.trim();
    localStorage.setItem("log-arithmic-key", clean);
    setKey(clean);
    setLogs([]);
  }

  async function openTrace(traceId: string) {
    if (!key) return;
    setTraceLoading(true);
    try {
      const response = await fetch(`${API}/api/v1/traces/${encodeURIComponent(traceId)}`, { headers: { Authorization: `Bearer ${key}` } });
      if (!response.ok) throw new Error(`Trace lookup failed (${response.status}).`);
      const result = await response.json() as { logs: LogEvent[] };
      setTraceEvents(result.logs);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : "Unable to load trace.");
    } finally {
      setTraceLoading(false);
    }
  }

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand"><span className="brand-mark">L</span><span>Log Arithmic<small>OBSERVABILITY</small></span></div>
        <div className="nav-label">WORKSPACE</div>
        <button className="nav-item active"><span>▤</span> Logs <kbd>⌘ K</kbd></button>
        <button className="nav-item" onClick={() => setLive((value) => !value)}><span>◉</span> Live tail</button>
        <div className="sidebar-bottom">
          <div className={`connection-dot ${status}`} />
          <div><strong>{status === "online" ? "Connected" : status === "offline" ? "Disconnected" : "Connecting"}</strong><small>{API.replace(/^https?:\/\//, "")}</small></div>
        </div>
      </aside>
      <main>
        <header className="topbar"><div className="breadcrumbs">Observability <span>/</span> <strong>Logs</strong></div><div className="top-actions"><span className={`status-pill ${live ? "is-live" : ""}`}>{live && <i />} {live ? "LIVE" : "LOG EXPLORER"}</span><button className="icon-button" title="Refresh logs" onClick={() => void load()}>↻</button></div></header>
        <section className="content">
          <div className="page-heading"><div><div className="eyebrow">EXPLORE</div><h1>Logs</h1><p>Search, filter, and inspect events from your services.</p></div><button className={`live-button ${live ? "selected" : ""}`} onClick={() => setLive((value) => !value)}><span className="live-dot" />{live ? "Stop live tail" : "Live tail"}</button></div>
          {!key && <form className="key-card" onSubmit={saveKey}><div><strong>Connect to your Log Arithmic instance</strong><p>Paste a project API key to query logs. The key stays in this browser.</p></div><input type="password" autoComplete="off" placeholder="lf_…" value={draftKey} onChange={(event) => setDraftKey(event.target.value)} aria-label="Project API key" /><button className="primary" type="submit">Connect</button></form>}
          <div className="toolbar">
            <label className="search-box"><span>⌕</span><input value={search} onChange={(event) => setSearch(event.target.value)} placeholder="Search log messages…" /><kbd>/</kbd></label>
            <select aria-label="Filter by level" value={level} onChange={(event) => setLevel(event.target.value)}><option value="">All levels</option>{["debug", "info", "warn", "error", "fatal"].map((item) => <option key={item}>{item}</option>)}</select>
            <input className="service-filter" value={service} onChange={(event) => setService(event.target.value)} placeholder="Service name" aria-label="Filter by service" />
            <span className="result-count">{logs.length} events</span>
          </div>
          {error && <div className="error-banner">{error}<button onClick={() => void load()}>Retry</button></div>}
          <div className="table-card">
            <div className="table-head"><span>LEVEL</span><span>TIMESTAMP</span><span>SERVICE</span><span>ENV</span><span>MESSAGE</span><span>TRACE</span></div>
            {logs.map((item) => <button className="log-row" key={item.id} onClick={() => setSelected(item)}>
              <span><b className={`level level-${item.level}`}>{item.level}</b></span>
              <time>{new Date(item.timestamp).toLocaleString()}</time>
              <span className="service-name">{item.service}</span>
              <span className="environment">{item.environment}</span>
              <span className="message">{item.message}<small>{Object.keys(item.metadata || {}).length > 0 && <span className="metadata-indicator">◈ metadata</span>}</small></span>
              <span className="trace">{item.traceId || "—"}</span>
            </button>)}
            {!logs.length && <div className="empty-state"><div className="empty-icon">⌁</div><strong>{loading ? "Loading events…" : key ? "No logs found" : "Your logs will appear here"}</strong><p>{key ? "Try changing the filters or send an event using the SDK." : "Connect with an API key to explore your events."}</p></div>}
            {nextCursor && <button className="load-more" disabled={loading} onClick={() => void load(nextCursor)}>{loading ? "Loading…" : "Load older events"}</button>}
          </div>
          <footer><span>Log Arithmic <b>v0.1.0</b></span><span>Structured logs, without the noise.</span></footer>
        </section>
      </main>
      {selected && <div className="overlay" role="presentation" onClick={() => { setSelected(null); setTraceEvents([]); }}><section className="detail-panel" role="dialog" aria-modal="true" aria-label="Log event details" onClick={(event) => event.stopPropagation()}><div className="detail-header"><div><div className="eyebrow">LOG EVENT</div><h2>Event details</h2></div><button className="icon-button" onClick={() => { setSelected(null); setTraceEvents([]); }} aria-label="Close details">×</button></div><div className="detail-summary"><span className={`level level-${selected.level}`}>{selected.level}</span><span>{selected.service}</span><span>{selected.environment}</span><time>{new Date(selected.timestamp).toLocaleString()}</time></div><div className="detail-message">{selected.message}</div><dl className="detail-fields"><dt>Event ID</dt><dd>{selected.id}</dd><dt>Project</dt><dd>{selected.project}</dd><dt>Trace ID</dt><dd>{selected.traceId ? <><button className="trace-link" onClick={() => void openTrace(selected.traceId!)}>{selected.traceId}</button><button className="copy-value" onClick={() => void navigator.clipboard.writeText(selected.traceId!)}>Copy</button></> : "—"}</dd><dt>Request ID</dt><dd>{selected.requestId || "—"}</dd></dl>{selected.traceId && <section className="trace-section"><div className="json-title">RELATED TRACE EVENTS <button onClick={() => void openTrace(selected.traceId!)}>Load trace</button></div>{traceLoading ? <p className="trace-loading">Loading trace…</p> : traceEvents.map((item) => <div className="trace-event" key={item.id}><time>{new Date(item.timestamp).toLocaleTimeString()}</time><b className={`level level-${item.level}`}>{item.level}</b><span>{item.service}</span><p>{item.message}</p></div>)}</section>}<div className="json-title">RAW EVENT <button onClick={() => void navigator.clipboard.writeText(JSON.stringify(selected, null, 2))}>Copy JSON</button></div><pre>{JSON.stringify(selected, null, 2)}</pre></section></div>}
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<React.StrictMode><App /></React.StrictMode>);
