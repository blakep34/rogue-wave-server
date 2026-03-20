/**
 * Rogue Wave Alert Server
 * Receives TradingView webhook POSTs → sends SMS via Twilio
 *
 * Setup:
 *   npm install express twilio
 *   node server.js
 *
 * Deploy: Railway.app (free tier)
 */

const express = require("express");
const twilio  = require("twilio");
const app     = express();
app.use(express.json());

// ─── CONFIG (set these as env variables in Railway) ────────────────────────
const TWILIO_ACCOUNT_SID = process.env.TWILIO_ACCOUNT_SID || "YOUR_ACCOUNT_SID";
const TWILIO_AUTH_TOKEN  = process.env.TWILIO_AUTH_TOKEN  || "YOUR_AUTH_TOKEN";
const TWILIO_FROM        = process.env.TWILIO_FROM        || "+1XXXXXXXXXX"; // your Twilio number
const ALERT_TO           = process.env.ALERT_TO           || "+1XXXXXXXXXX"; // dad's number
const WEBHOOK_SECRET     = process.env.WEBHOOK_SECRET     || "rogue-wave-secret-2024";
// ───────────────────────────────────────────────────────────────────────────

const client = twilio(TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN);

/**
 * Send SMS via Twilio
 */
async function sendSMS(message) {
  return client.messages.create({
    body: message,
    from: TWILIO_FROM,
    to:   ALERT_TO,
  });
}

/**
 * Format signal into a concise SMS (keep it short)
 */
function formatSMS(payload) {
  const { ticker, price, time } = payload;
  const p = parseFloat(price).toFixed(2);
  return [
    `🌊 ROGUE WAVE: ${ticker} @ $${p}`,
    `All 5 conditions aligned:`,
    `✓ Vol breakout (2σ)`,
    `✓ RSI momentum`,
    `✓ BB squeeze fired`,
    `✓ VIX low / fetch clear`,
    `✓ Sector ETF rising`,
    `Time: ${time}`,
    `Check chart before acting.`,
  ].join("\n");
}

// Health check
app.get("/", (req, res) => {
  res.json({ status: "ok", server: "Rogue Wave Alert Server (Twilio)" });
});

/**
 * Webhook endpoint
 * Paste this URL into TradingView alert:
 *   https://YOUR-RAILWAY-URL/alert?secret=rogue-wave-secret-2024
 */
app.post("/alert", async (req, res) => {
  if (req.query.secret !== WEBHOOK_SECRET) {
    console.warn("Unauthorized webhook attempt");
    return res.status(401).json({ error: "Unauthorized" });
  }

  const payload = req.body;
  console.log("Received alert:", JSON.stringify(payload, null, 2));

  if (!payload.ticker || !payload.signal) {
    return res.status(400).json({ error: "Missing ticker or signal" });
  }

  try {
    const msg = formatSMS(payload);
    const result = await sendSMS(msg);
    console.log(`✅ SMS sent for ${payload.ticker} — SID: ${result.sid}`);
    res.json({ success: true, sid: result.sid });
  } catch (err) {
    console.error("Twilio error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🌊 Rogue Wave server running on port ${PORT}`);
});
