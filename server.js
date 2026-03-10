const cors = require("cors");
const express = require("express");
const axios = require("axios");
require("dotenv").config();
const rateLimit = require("express-rate-limit");

const app = express();
app.use(cors());
app.set('trust proxy', 1);
app.use(express.json());

// ═══════════════════════════════════════════════════
// Rate limit（自己用，global 共用）
// ═══════════════════════════════════════════════════
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

// ═══════════════════════════════════════════════════
// 固定層（所有角色共用，快取）
// ═══════════════════════════════════════════════════
const BASE_RULES = `所有回覆必須是 JSON 陣列，每個元素是一條消息。
每次輸出 1–7 條消息。
只能純語言聊天，不描寫動作、表情或心理。
禁止輸出 JSON 陣列以外內容。`;

const INTERFACE_RULES = `可用消息類型（只能用以下格式）：
"文字內容"
{"type":"reply_to","message_id":"真實ID","content":""}
{"type":"recall","target":"previous"}
{"type":"emoji","description":""}
{"type":"voice_message","content":""}
{"type":"ai_photo","description":""}
{"type":"location","locationName":"","coordinates":""}
{"type":"transfer","amount":0,"note":""}
{"type":"transfer_action","action":"accept或reject"}
{"type":"poke"}
{"type":"voice_call","reason":""}
{"type":"video_call","reason":""}
{"type":"block_user","reason":""}
{"type":"friend_request","message":""}
{"type":"change_avatar","avatar_url":"","reason":""}
{"type":"update_nickname","nickname":""}
{"type":"update_poke_suffix","suffix":""}
{"type":"create_anniversary","name":"","date":"YYYY-MM-DD","anniversary_type":"birthday/meeting/relationship/first_time/special_moment/other","description":""}
{"type":"create_appointment","name":"","date":"YYYY-MM-DD","appointment_type":"date/meeting/promise/activity/other","description":""}`;

// ═══════════════════════════════════════════════════
// 限制常數
// ═══════════════════════════════════════════════════
const MAX_HISTORY   = 20;    // 保留幾條歷史
const MAX_MSGS_IN   = 100;   // 前端最多傳幾條
const MAX_MSG_LEN   = 500;   // 單條消息最多幾字元
const MAX_MSGS_OUT  = 7;     // Claude 最多回幾條
const MAX_PERSONA   = 3000;  // 角色人設最多幾字元

// ═══════════════════════════════════════════════════
// 模型列表
// ═══════════════════════════════════════════════════
app.get("/v1/models", (req, res) => {
  res.json({
    object: "list",
    data: [
      {
        id: "claude-sonnet-4-5",
        object: "model",
        created: 1700000000,
        owned_by: "anthropic"
      }
    ]
  });
});

// ═══════════════════════════════════════════════════
// 主要對話路由
// ═══════════════════════════════════════════════════
app.post("/v1/chat/completions", checkDailyLimit, async (req, res) => {
  console.log("REQUEST BODY:", JSON.stringify(req.body,null,2));
  try {
    const { messages, max_tokens = 600 } = req.body;

    // 1. 擋超量 history
    if (messages.length > MAX_MSGS_IN) {
      return res.status(400).json({ error: `消息數量超限（最多 ${MAX_MSGS_IN} 條）` });
    }

    // 2. 抽出前端的 system message（角色人設）並限制長度
    const systemMsg = messages.find(m => m.role === "system");
    const persona = systemMsg?.content ?? "";
    if (persona.length > MAX_PERSONA) {
      return res.status(400).json({ error: `人設過長（最多 ${MAX_PERSONA} 字元）` });
    }

    // 3. 過濾 system、驗證格式、擋超長單條、截斷歷史
    const chatMessages = messages
      .filter(m => m.role !== "system")
      .map(m => {
        if (typeof m.content !== "string") {
          throw new Error("message content 必須是字串");
        }
        if (m.content.length > MAX_MSG_LEN) {
          throw new Error(`單條消息過長（最多 ${MAX_MSG_LEN} 字元）`);
        }
        return { role: m.role, content: m.content };
      })
      .slice(-MAX_HISTORY);

    // 4. 送 Claude
    const safeMaxTokens = Math.min(max_tokens, 1500);
    const response = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-5",
        max_tokens: safeMaxTokens,
        system: [
          { type: "text", text: BASE_RULES,      cache_control: { type: "ephemeral" } },
          { type: "text", text: INTERFACE_RULES, cache_control: { type: "ephemeral" } },
          { type: "text", text: persona },
        ],
        messages: chatMessages,
      },
      {
        headers: {
          "x-api-key": process.env.CLAUDE_API_KEY,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": "prompt-caching-2024-07-31",
          "Content-Type": "application/json",
        }
      }
    );

    // 5. 合併所有 text block
    let text = response.data.content
      .filter(c => c.type === "text")
      .map(c => c.text)
      .join("");

    // 6. 清洗多餘的 markdown fence
    text = text.trim().replace(/^```json\s*|^```\s*|```$/g, "").trim();

    // 7. 截斷超過 7 條的回覆
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed) && parsed.length > MAX_MSGS_OUT) {
        text = JSON.stringify(parsed.slice(0, MAX_MSGS_OUT));
      }
    } catch (_) {}

    // 8. 回傳 GPT 格式
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
    console.error(err.message);
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// ═══════════════════════════════════════════════════
app.get("/", (req, res) => res.send("Claude proxy running"));

app.listen(process.env.PORT || 3000, () => console.log("Server started"));
