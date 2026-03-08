const cors = require("cors");
const express = require("express");
console.log("SERVER VERSION 2");
const axios = require("axios");
require("dotenv").config();
const rateLimit = require("express-rate-limit");

const app = express();
app.use(cors());
app.set('trust proxy', 1);
app.use(express.json());
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
keyGenerator: () => "global"               
});

app.use(limiter);

let dailyCount = 0;
let lastReset = Date.now();

function checkDailyLimit(req, res, next) {
  const now = Date.now();

  // 超過 24 小時重置
  if (now - lastReset > 24 * 60 * 60 * 1000) {
    dailyCount = 0;
    lastReset = now;
  }

  if (dailyCount >= 700) {
    return res.status(429).json({ error: "Daily limit reached" });
  }

  dailyCount++;
  next();
}
app.get("/v1/models", (req, res) => {
  res.json({
    object: "list",
    data: [
      {
        id: "claude-sonnet-4-5",
        object: "model",
        created:1700000000,
        owned_by: "openai"
      }
    ]
  });
});
app.get("/v1/models", (req, res) => {
  res.json({
    object: "list",
    data: [
      {
        id: "claude-sonnet-4-5",
        object: "model",
        owned_by: "anthropic"
      }
    ]
  });
});
app.post("/v1/chat/completions", checkDailyLimit, async (req, res) => {
  try {
    const { messages, max_tokens = 1000 } = req.body;
    let systemPrompt = undefined;

const filteredMessages = messages.filter(m => {
  if (m.role === "system") {
    systemPrompt = m.content;
    return false;
  }
  return true;
});
    const safeMaxTokens = Math.min(max_tokens, 1500);

    const response = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-5",
        max_tokens: safeMaxTokens,
        system: systemPrompt,
        messages: filteredMessages
      },
      {
        headers: {
          "x-api-key": process.env.CLAUDE_API_KEY,
          "anthropic-version": "2023-06-01",
          "Content-Type": "application/json"
        }
      }
    );

    const text = response.data.content[0].text;

    res.json({
      id: "chatcmpl-" + Date.now(),
      object: "chat.completion",
      choices: [
        {
          index: 0,
          message: { role: "assistant", content: text },
          finish_reason: "stop"
        }
      ]
    });

  } catch (err) {
    console.error("Claude error:", err.response?.data || err.message);
    res.status(500).json({
      error: err.response?.data || err.message
    });
  }
});

app.get("/", (req, res) => {
  res.send("Claude proxy running");
});

app.listen(process.env.PORT || 3000, () => {
  console.log("Server started");
});
