import express from "express";
import "dotenv/config";
import crypto from "node:crypto";
import connectorRoutes from "./src/connectors/routes.js";
const app = express();
const PORT = process.env.PORT || 3000;
app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), async (req, res) => {\n  const secret = process.env.STRIPE_WEBHOOK_SECRET;\n  const signature = req.headers["stripe-signature"];\n  if (!secret || !signature) return res.status(400).send("Webhook signature is not configured.");\n  const parts = Object.fromEntries(signature.split(",").map(p => p.split("=").map(x => x.trim())));\n  const expected = crypto.createHmac("sha256", secret).update(`${parts.t}.${req.body.toString("utf8")}`).digest("hex");\n  const a = Buffer.from(expected); const b = Buffer.from(parts.v1 || "");\n  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return res.status(400).send("Invalid signature.");\n  let event; try { event = JSON.parse(req.body.toString("utf8")); } catch { return res.status(400).send("Invalid JSON."); }\n  const supabaseUrl = process.env.SUPABASE_URL; const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;\n  if (!supabaseUrl || !serviceKey) return res.status(500).send("Billing database is not configured.");\n  const sub = event.data?.object;\n  if (["checkout.session.completed", "customer.subscription.updated", "customer.subscription.deleted"].includes(event.type)) {\n    const userId = sub?.metadata?.user_id || sub?.client_reference_id;\n    const plan = sub?.metadata?.plan;\n    if (userId && (plan === "plus" || plan === "pro" || event.type !== "checkout.session.completed")) {\n      const row = { user_id: userId, stripe_customer_id: sub.customer || null, stripe_subscription_id: sub.subscription || sub.id || null, plan: event.type === "customer.subscription.deleted" ? "free" : (plan || "free"), subscription_status: event.type === "checkout.session.completed" ? "active" : (sub.status || "inactive"), current_period_end: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null, updated_at: new Date().toISOString() };\n      await fetch(`${supabaseUrl}/rest/v1/forgepilot_billing?on_conflict=user_id`, { method: "POST", headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" }, body: JSON.stringify(row) });\n    }\n  }\n  return res.json({ received: true });\n});\napp.use(express.json({ limit: "1mb" }));
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
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
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


// Billing configuration. Stripe keys must remain server-side.
const PLANS = {
  free: { limit: 20, priceId: null },
  plus: { limit: 200, priceId: "price_1UVCBwGUzHM6YjX0D9twKhI4" },
  pro: { limit: 1000, priceId: "price_1UVCByGUzHM6YjX0TVlmNnol" }
};
async function supabaseRest(path, method, body) {
  const url = process.env.SUPABASE_URL; const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error("SUPABASE_SERVICE_ROLE_KEY is not configured on the server.");
  const r = await fetch(url + "/rest/v1/" + path, { method, headers: { apikey: key, Authorization: "Bearer " + key, "Content-Type": "application/json", Prefer: "return=representation" }, ...(body ? { body: JSON.stringify(body) } : {}) });
  const text = await r.text(); let data; try { data = JSON.parse(text); } catch { data = {}; }
  if (!r.ok) throw new Error(data.message || "Billing database request failed.");
  return data;
}
async function getPlan(userId) {
  const rows = await supabaseRest("forgepilot_billing?user_id=eq." + encodeURIComponent(userId) + "&select=plan,subscription_status", "GET");
  const row = rows[0];
  if (row && ["plus","pro"].includes(row.plan) && ["active","trialing"].includes(row.subscription_status)) return row.plan;
  return "free";
}
app.get("/api/billing/status", verifySupabaseToken, async (req,res) => {
  try {
    const plan = await getPlan(req.authUser.id);
    const rows = await supabaseRest("forgepilot_daily_usage?user_id=eq." + encodeURIComponent(req.authUser.id) + "&usage_date=eq." + new Date().toISOString().slice(0,10) + "&select=chats_used", "GET");
    res.json({ plan, dailyLimit: PLANS[plan].limit, chatsUsed: rows[0]?.chats_used || 0, mode: "test" });
  } catch (e) { res.status(503).json({ error: e.message }); }
});
app.post("/api/billing/checkout", verifySupabaseToken, async (req,res) => {
  const plan = req.body?.plan;
  if (!["plus","pro"].includes(plan)) return res.status(400).json({ error: "Choose Plus or Pro." });
  const secret = process.env.STRIPE_SECRET_KEY;
  if (!secret || !secret.startsWith("sk_test_")) return res.status(503).json({ error: "Test-mode STRIPE_SECRET_KEY (sk_test_...) is required." });
  try {
    const origin = (process.env.APP_URL || "https://forgepilot-ai.onrender.com").replace(/\/$/, "");
    const form = new URLSearchParams();
    form.set("mode","subscription"); form.set("line_items[0][price]",PLANS[plan].priceId); form.set("line_items[0][quantity]","1");
    form.set("success_url",origin+"/?billing=success"); form.set("cancel_url",origin+"/?billing=cancel");
    form.set("client_reference_id",req.authUser.id); form.set("metadata[user_id]",req.authUser.id); form.set("metadata[plan]",plan);
    form.set("subscription_data[metadata][user_id]",req.authUser.id); form.set("subscription_data[metadata][plan]",plan);
    if (req.authUser.email) form.set("customer_email",req.authUser.email);
    const upstream = await fetch("https://api.stripe.com/v1/checkout/sessions",{method:"POST",headers:{Authorization:"Bearer "+secret,"Content-Type":"application/x-www-form-urlencoded"},body:form});
    const data = await upstream.json();
    if (!upstream.ok) return res.status(502).json({error:data?.error?.message||"Could not create checkout session."});
    res.json({url:data.url,mode:"test"});
  } catch (e) { res.status(502).json({error:e.message}); }
});

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

  let plan, usage;\n  try {\n    plan = await getPlan(req.authUser.id);\n    usage = await supabaseRest("rpc/forgepilot_claim_daily_chat", "POST", { p_user_id: req.authUser.id, p_limit: PLANS[plan].limit });\n    if (!usage?.[0]?.allowed) return res.status(429).json({ error: `Daily chat limit reached (${usage?.[0]?.daily_limit || PLANS[plan].limit}/day). Upgrade your plan or try again tomorrow.`, plan, dailyLimit: usage?.[0]?.daily_limit || PLANS[plan].limit, chatsUsed: usage?.[0]?.chats_used || PLANS[plan].limit });\n  } catch (e) { return res.status(503).json({ error: "Could not check your daily usage: " + e.message }); }\n\n  const controller = new AbortController();
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
