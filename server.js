import express from "express";
import "dotenv/config";
import crypto from "node:crypto";
import connectorRoutes from "./src/connectors/routes.js";
const app = express();
const PORT = process.env.PORT || 3000;

app.disable("x-powered-by");
app.set("trust proxy", 1);
app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  res.setHeader("Cross-Origin-Opener-Policy", "same-origin");
  res.setHeader("Content-Security-Policy", "default-src 'self'; base-uri 'self'; object-src 'none'; frame-ancestors 'none'; form-action 'self' https://checkout.stripe.com; upgrade-insecure-requests; script-src 'self' 'unsafe-inline' https://cdn.jsdelivr.net; style-src 'self' 'unsafe-inline' https://fonts.googleapis.com; font-src 'self' https://fonts.gstatic.com data:; img-src 'self' data: blob: https:; connect-src 'self' https://*.supabase.co https://api.stripe.com https://openrouter.ai");
  next();
});
const rateBuckets = new Map();
function rateLimit({ windowMs, max, key = req => req.ip, message = "Too many requests. Please wait and try again." }) {
  return (req, res, next) => {
    const now = Date.now(); const id = key(req); let item = rateBuckets.get(id);
    if (!item || item.resetAt <= now) { item = { count: 0, resetAt: now + windowMs }; rateBuckets.set(id, item); }
    item.count++;
    res.setHeader("RateLimit-Limit", String(max));
    res.setHeader("RateLimit-Remaining", String(Math.max(0, max - item.count)));
    if (item.count > max) {
      res.setHeader("Retry-After", String(Math.max(1, Math.ceil((item.resetAt - now) / 1000))));
      return res.status(429).json({ error: message });
    }
    // Bound memory growth from random IPs.
    if (rateBuckets.size > 5000) for (const [k, v] of rateBuckets) if (v.resetAt <= now) rateBuckets.delete(k);
    next();
  };
}
app.post("/api/stripe/webhook", express.raw({ type: "application/json" }), async (req, res) => {
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  const signature = req.headers["stripe-signature"];
  if (!secret || !signature) return res.status(400).send("Webhook signature is not configured.");
  const parts = Object.fromEntries(signature.split(",").map(p => p.split("=").map(x => x.trim())));
  if (!parts.t || Math.abs(Date.now() / 1000 - Number(parts.t)) > 300) return res.status(400).send("Expired webhook signature.");
  const expected = crypto.createHmac("sha256", secret).update(`${parts.t}.${req.body.toString("utf8")}`).digest("hex");
  const signatures = signature.split(",").filter(p => p.trim().startsWith("v1=")).map(p => p.trim().slice(3));
  const valid = signatures.some(sig => { const a = Buffer.from(expected); const b = Buffer.from(sig); return a.length === b.length && crypto.timingSafeEqual(a, b); });
  if (!valid) return res.status(400).send("Invalid signature.");
  let event; try { event = JSON.parse(req.body.toString("utf8")); } catch { return res.status(400).send("Invalid JSON."); }
  const supabaseUrl = process.env.SUPABASE_URL; const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!supabaseUrl || !serviceKey) return res.status(500).send("Billing database is not configured.");
  const sub = event.data?.object;
  if (["checkout.session.completed", "customer.subscription.updated", "customer.subscription.deleted"].includes(event.type)) {
    const userId = sub?.metadata?.user_id || sub?.client_reference_id;
    const plan = sub?.metadata?.plan;
    if (userId && (plan === "plus" || plan === "pro" || event.type !== "checkout.session.completed")) {
      const row = { user_id: userId, stripe_customer_id: sub.customer || null, stripe_subscription_id: sub.subscription || sub.id || null, plan: event.type === "customer.subscription.deleted" ? "free" : (plan || "free"), subscription_status: event.type === "checkout.session.completed" ? "active" : (sub.status || "inactive"), current_period_end: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null, updated_at: new Date().toISOString() };
      await fetch(`${supabaseUrl}/rest/v1/forgepilot_billing?on_conflict=user_id`, { method: "POST", headers: { apikey: serviceKey, Authorization: `Bearer ${serviceKey}`, "Content-Type": "application/json", Prefer: "resolution=merge-duplicates" }, body: JSON.stringify(row) });
    }
  }
  return res.json({ received: true });
});
app.use(express.json({ limit: "1mb", strict: true }));
app.use(express.static("public"));

app.use((req, res, next) => {
  if (req.method !== "POST" || req.path === "/api/stripe/webhook") return next();
  const origin = req.headers.origin;
  if (!origin) return next(); // Bearer-token clients and Stripe webhook clients may omit Origin.
  let allowed = false;
  try {
    const parsed = new URL(origin);
    const configured = new URL(process.env.APP_URL || `https://${req.headers.host}`);
    allowed = parsed.origin === configured.origin ||
      (process.env.NODE_ENV !== "production" && ["localhost", "127.0.0.1"].includes(parsed.hostname));
  } catch {}
  if (!allowed) return res.status(403).json({ error: "Cross-origin request blocked." });
  next();
});
app.use("/api/connectors", connectorRoutes);
app.get("/api/config", rateLimit({ windowMs: 60000, max: 60 }), (_req, res) => {
  res.json({
    supabaseUrl: process.env.SUPABASE_URL || "",
    supabasePublishableKey: process.env.SUPABASE_PUBLISHABLE_KEY || ""
  });
});

app.get("/api/health", rateLimit({ windowMs: 60000, max: 60 }), (_req, res) => {
  res.json({ status: "online", provider: "OpenRouter", keyConfigured: Boolean(process.env.OPENROUTER_API_KEY) });
});

async function verifySupabaseToken(req, res, next) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_PUBLISHABLE_KEY) return res.status(503).json({ error: "Authentication is not configured." });
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
  free: {
    creditLimit: 100, period: "day", priceId: null,
    features: ["100 credits daily", "Basic AI chat", "Chat history", "Standard models"]
  },
  plus: {
    creditLimit: 3000, period: "month", priceId: "price_1UVCBwGUzHM6YjX0D9twKhI4",
    features: ["3,000 credits every month", "More capable AI models", "Longer conversations", "File and code help", "Priority access when available"]
  },
  pro: {
    creditLimit: null, period: "unlimited", priceId: "price_1UVCByGUzHM6YjX0TVlmNnol",
    features: ["Unlimited credits", "All available AI models", "Long-context assistance", "Advanced coding and file help", "Priority access when available"]
  }
};
function creditPeriod(plan, now = new Date()) {
  const day = now.toISOString().slice(0, 10);
  const month = now.toISOString().slice(0, 7);
  return plan === "plus" ? "plus:" + month : plan === "pro" ? "pro:" + month : "free:" + day;
}
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
app.get("/api/billing/status", rateLimit({ windowMs: 60000, max: 30 }), verifySupabaseToken, async (req,res) => {
  try {
    const plan = await getPlan(req.authUser.id);
    const cfg = PLANS[plan];
    const periodKey = creditPeriod(plan);
    const rows = await supabaseRest("forgepilot_credit_usage?user_id=eq." + encodeURIComponent(req.authUser.id) + "&period_key=eq." + encodeURIComponent(periodKey) + "&select=credits_used", "GET");
    const creditsUsed = rows[0]?.credits_used || 0;
    res.json({
      plan, period: cfg.period, periodKey, creditsUsed,
      creditLimit: cfg.creditLimit, creditsRemaining: cfg.creditLimit === null ? null : Math.max(0, cfg.creditLimit - creditsUsed),
      unlimited: cfg.creditLimit === null, features: cfg.features, mode: "test"
    });
  } catch { res.status(503).json({ error: "Could not load plan and credits. Check server billing configuration." }); }
});
app.post("/api/billing/checkout", rateLimit({ windowMs: 60000, max: 5 }), verifySupabaseToken, async (req,res) => {
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
  } catch { res.status(502).json({error:"Could not create checkout session. Check Stripe test-mode configuration."}); }
});

app.post("/api/chat", rateLimit({ windowMs: 60000, max: 20 }), verifySupabaseToken, async (req, res) => {
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

  let plan, usage;
  try {
    plan = await getPlan(req.authUser.id);
    const cfg = PLANS[plan];
    const periodKey = creditPeriod(plan);
    const creditLimit = cfg.creditLimit === null ? 2147483647 : cfg.creditLimit;
    usage = await supabaseRest("rpc/forgepilot_claim_credits", "POST", {
      p_user_id: req.authUser.id, p_period_key: periodKey, p_credit_cost: 1, p_credit_limit: creditLimit
    });
    if (!usage?.[0]?.allowed) {
      const periodLabel = cfg.period === "month" ? "this month" : "today";
      return res.status(429).json({
        error: `You have used all ${cfg.creditLimit} credits for ${periodLabel}. Upgrade your plan or wait for your credits to reset.`,
        plan, creditLimit: cfg.creditLimit, creditsUsed: usage?.[0]?.credits_used || cfg.creditLimit,
        creditsRemaining: 0, period: cfg.period
      });
    }
  } catch { return res.status(503).json({ error: "Could not check your account credits. Please try again shortly." }); }

  const allowedModels = new Set(["openrouter/free", "openrouter/auto", "google/gemini-2.5-flash", "deepseek/deepseek-chat-v3-0324:free", "qwen/qwen3-coder:free"]);
  const requestedModel = typeof req.body?.model === "string" ? req.body.model : "openrouter/free";
  const model = allowedModels.has(requestedModel) ? requestedModel : "openrouter/free";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 80000);
  try {
    const upstream = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST", signal: controller.signal,
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json",
        "HTTP-Referer": process.env.APP_URL || `http://localhost:${PORT}`, "X-Title": "ForgePilot AI" },
      body: JSON.stringify({ model,
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
