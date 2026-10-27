import express from "express";

const router = express.Router();

// Connector status is derived from server-side configuration only.
// Never report a provider as connected merely because it appears in the UI.
router.get("/github/status", (_req, res) => {
  const configured = Boolean(process.env.GITHUB_CLIENT_ID && process.env.GITHUB_CLIENT_SECRET);
  res.json({ connected: false, configured, message: configured ? "GitHub OAuth is configured but account authorization is not completed." : "GitHub OAuth is not configured on the server." });
});

router.get("/github/connect", (_req, res) => {
  if (!process.env.GITHUB_CLIENT_ID || !process.env.GITHUB_CLIENT_SECRET) {
    return res.status(503).json({ error: "GitHub OAuth is not configured. Set GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET, and APP_URL on the server first." });
  }
  const callbackUrl = new URL("/api/connectors/github/callback", process.env.APP_URL || "http://localhost:3000").toString();
  const state = crypto.randomUUID();
  // Store state in a short-lived, HTTP-only cookie; the OAuth callback is implemented separately.
  res.cookie("fp_github_oauth_state", state, { httpOnly: true, sameSite: "lax", secure: process.env.NODE_ENV === "production", maxAge: 10 * 60 * 1000 });
  const url = new URL("https://github.com/login/oauth/authorize");
  url.searchParams.set("client_id", process.env.GITHUB_CLIENT_ID);
  url.searchParams.set("redirect_uri", callbackUrl);
  url.searchParams.set("scope", "read:user repo");
  url.searchParams.set("state", state);
  return res.redirect(url.toString());
});

router.get("/supabase/status", (_req, res) => {
  const url = process.env.CONNECTOR_SUPABASE_URL || "";
  res.json({ connected: Boolean(url && process.env.CONNECTOR_SUPABASE_PUBLISHABLE_KEY), projectUrl: url });
});

router.post("/supabase/connect", async (req, res) => {
  const projectUrl = typeof req.body?.projectUrl === "string" ? req.body.projectUrl.trim() : "";
  const apiKey = typeof req.body?.apiKey === "string" ? req.body.apiKey.trim() : "";
  let parsed;
  try { parsed = new URL(projectUrl); } catch {}
  if (!parsed || parsed.protocol !== "https:" || !parsed.hostname.endsWith(".supabase.co") || !apiKey) {
    return res.status(400).json({ success: false, error: "Enter a valid Supabase HTTPS project URL and publishable/anon key." });
  }
  // Validate credentials, but never store user-submitted credentials in process memory or logs.
  try {
    const response = await fetch(projectUrl.replace(/\/$/, "") + "/auth/v1/settings", {
      headers: { apikey: apiKey, Authorization: "Bearer " + apiKey },
      signal: AbortSignal.timeout(8000)
    });
    if (!response.ok) return res.status(400).json({ success: false, error: "Supabase rejected this URL/key. Check the project URL and publishable/anon key." });
    if (!process.env.CONNECTOR_SUPABASE_URL || !process.env.CONNECTOR_SUPABASE_PUBLISHABLE_KEY) {
      return res.status(409).json({ success: false, error: "Credentials verified, but secure persistent connector storage is not configured. Add CONNECTOR_SUPABASE_URL and CONNECTOR_SUPABASE_PUBLISHABLE_KEY to server environment before connecting." });
    }
    return res.status(409).json({ success: false, error: "Persistent connector storage needs a database table and server-side encryption before this connection can be saved." });
  } catch {
    return res.status(502).json({ success: false, error: "Could not verify Supabase. Check the project URL and try again." });
  }
});

router.post("/supabase/disconnect", (_req, res) => {
  return res.status(409).json({ success: false, error: "No separately saved Supabase connector exists to disconnect. App authentication uses server environment settings." });
});

export default router;
