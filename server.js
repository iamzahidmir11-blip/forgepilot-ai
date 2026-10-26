import express from "express";
import "dotenv/config";

const app = express();
const PORT = process.env.PORT || 3000;

app.use(express.json({ limit: "1mb" }));
app.use(express.static("public"));

app.get("/api/health", (req, res) => {
  res.json({
    status: "online",
    provider: "OpenRouter",
    keyConfigured: Boolean(process.env.OPENROUTER_API_KEY)
  });
});

app.post("/api/chat", async (req, res) => {
  try {
    const key = process.env.OPENROUTER_API_KEY;
    const message = req.body?.message?.trim();

    if (!key) {
      return res.status(500).json({ error: "OpenRouter API key missing." });
    }

    if (!message) {
      return res.status(400).json({ error: "Message is required." });
    }

    const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${key}`,
        "Content-Type": "application/json",
        "HTTP-Referer": "http://localhost:3000",
        "X-Title": "ForgePilot AI"
      },
      body: JSON.stringify({
        model: "openrouter/free",
        messages: [
          {
            role: "system",
            content: "You are ForgePilot AI, a helpful coding agent. Explain clearly, analyze code carefully, and never claim to have edited or tested files unless you actually did."
          },
          { role: "user", content: message }
        ]
      })
    });

    const data = await response.json();

    if (!response.ok) {
      return res.status(response.status).json({
        error: data?.error?.message || "AI provider request failed."
      });
    }

    res.json({
      reply: data?.choices?.[0]?.message?.content || "The model returned an empty response."
    });
  } catch (error) {
    res.status(500).json({ error: "Server error: " + error.message });
  }
});

app.listen(PORT, "0.0.0.0", () => {
  console.log(`ForgePilot AI running on http://localhost:${PORT}`);
});
