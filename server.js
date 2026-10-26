import express from "express";
import "dotenv/config";
import connectorRoutes from "./src/connectors/routes.js";
const app = express();
const PORT = process.env.PORT || 3000;
app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));
app.use("/api/connectors", connectorRoutes);
app.get("/api/config", (_req, res) => {
  res.json({
    supabaseUrl: process.env.SUPABASE_URL || "",
    supabasePublishableKey: process.env.SUPABASE_PUBLISHABLE_KEY || ""
  });
});

app.get("/api/health", (_req, res) => {
  res.json({ status: "online", provider: "OpenRouter", keyConfigured: Boolean(process.env.OPENROUTER_API_KEY) });
});

async function verifySupabaseToken(req, res, next) {
  const token = (req.headers.authorization || "").replace(/^Bearer\\s+/i, "");
  if (!token) return res.status(401).json({ error: "Please sign in first." });
  try {
    const r = await fetch(process.env.SUPABASE_URL + "/auth/v1/user", {
      headers: {
        apikey: process.env.SUPABASE_PUBLISHABLE_KEY,
        Authorization: "Bearer " + token
      }
    });
    if (!r.ok) return res.status(401).json({ error: "Session expired. Please sign in again." });
    req.authUser = await r.json();
    next();
  } catch {
    return res.status(503).json({ error: "Could not verify your login." });
  }
}

app.post("/api/chat", verifySupabaseToken, async (req, res) => {
  const key = process.env.OPENROUTER_API_KEY;
  const message = typeof req.body?.message === "string" ? req.body.message.trim() : "";
  if (!key) return res.status(503).json({ error: "OPENROUTER_API_KEY is missing from .env." });
  if (!message) return res.status(400).json({ error: "Message is required." });
  if (message.length > 65000) return res.status(413).json({ error: "Message and attachments are too large." });

  const safeHistory = Array.isArray(req.body?.messages)
    ? req.body.messages.slice(-16).filter(m => ["user", "assistant"].includes(m?.role) && typeof m?.content === "string")
      .map(m => ({ role: m.role, content: m.content.slice(0, 65000) }))
    : [{ role: "user", content: message }];
  if (!safeHistory.length || safeHistory[safeHistory.length - 1].role !== "user") safeHistory.push({ role: "user", content: message });

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 80000);
  try {
    const upstream = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST", signal: controller.signal,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json",
        "HTTP-Referer": process.env.APP_URL || `http://localhost:${PORT}`, "X-Title": "ForgePilot AI" },
      body: JSON.stringify({ model: typeof req.body?.model === "string" ? req.body.model : "openrouter/free",
        messages: [{ role: "system", content: "You are ForgePilot AI, a clear and professional AI assistant. Answer the user directly and naturally. Use concise paragraphs by default. Use Markdown headings only when they genuinely improve a long answer; use lists only for actual steps or multiple items. Avoid decorative hashtags, excessive bold text, emojis, generic intake questionnaires, repetitive summaries, and unnecessary sections. Format code in fenced code blocks with the correct language. Make links valid Markdown links when useful. Adapt the answer length to the question. For coding tasks, give practical steps and never claim to have edited files or run tests unless a real tool confirms it. Ask for approval before risky changes." }, ...safeHistory], temperature: 0.3 })
    });
    const raw = await upstream.text(); let data;
    try { data = JSON.parse(raw); } catch { data = {}; }
    if (!upstream.ok) return res.status(upstream.status >= 400 && upstream.status < 500 ? upstream.status : 502)
      .json({ error: data?.error?.message || `AI provider returned HTTP ${upstream.status}.` });
    const reply = data?.choices?.[0]?.message?.content;
    if (typeof reply !== "string" || !reply.trim()) return res.status(502).json({ error: "The model returned an empty response. Try again later." });
    return res.json({ reply });
  } catch (error) {
    const timeout = error?.name === "AbortError";
    return res.status(timeout ? 504 : 502).json({ error: timeout ? "AI provider timed out. Please retry." : "Could not reach AI provider. Check internet and try again." });
  } finally { clearTimeout(timer); }
});

app.listen(PORT, "0.0.0.0", () => console.log(`ForgePilot AI running on http://localhost:${PORT}`));
