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
// Rate limit
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
const MAX_HISTORY   = 20;
const MAX_MSGS_IN   = 100;
const MAX_MSGS_OUT  = 7;
const MAX_PERSONA   = 3000;

// ═══════════════════════════════════════════════════
// 把各種 content 格式統一轉成字串
// ═══════════════════════════════════════════════════
function normalizeContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .filter(c => c.type === "text")
      .map(c => c.text)
      .join("");
  }
  return String(content);
}

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
  try {
    const { messages, max_tokens = 600 } = req.body;

    // 1. 擋超量 history
    if (messages.length > MAX_MSGS_IN) {
      return res.status(400).json({ error: `消息數量超限（最多 ${MAX_MSGS_IN} 條）` });
    }

    // 2. 從 req.body.system 抓人設（EVEChat 的格式）
    //    同時也兼容放在 messages 裡的 system message
    let persona = "";
    if (typeof req.body.system === "string") {
      persona = req.body.system;
    } else if (Array.isArray(req.body.system)) {
      persona = req.body.system.map(b => b.text ?? "").join("");
    } else {
      const systemMsg = messages.find(m => m.role === "system");
      if (systemMsg) persona = normalizeContent(systemMsg.content);
    }

    // persona 截斷到 3000 字元，不報錯，靜默截斷
    if (persona.length > MAX_PERSONA) {
      persona = persona.slice(0, MAX_PERSONA);
    }

    // debug log
    console.log(`[請求] persona 長度：${persona.length}，消息數：${messages.length}`);

    // 3. 過濾 system、統一格式、截斷歷史
    const chatMessages = messages
      .filter(m => m.role !== "system")
      .map(m => ({
        role: m.role,
        content: normalizeContent(m.content)
      }))
      .slice(-MAX_HISTORY);

    // 4. 送 Claude
    const safeMaxTokens = Math.min(max_tokens, 1500);

    const systemBlocks = [
      { type: "text", text: BASE_RULES,      cache_control: { type: "ephemeral" } },
      { type: "text", text: INTERFACE_RULES, cache_control: { type: "ephemeral" } },
    ];
    // persona 有內容才加，避免送空 block 給 Claude
    if (persona) {
      systemBlocks.push({ type: "text", text: persona });
    }

    const response = await axios.post(
      "https://api.anthropic.com/v1/messages",
      {
        model: "claude-sonnet-4-5",
        max_tokens: safeMaxTokens,
        system: systemBlocks,
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

    // 6. 清洗 markdown fence
    text = text.trim().replace(/^```json\s*|^```\s*|```$/g, "").trim();

    // 7. 截斷超過 7 條
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
    console.error("錯誤：", err.message);
    if (err.response?.data) {
      console.error("Claude 回傳：", JSON.stringify(err.response.data));
    }
    res.status(500).json({ error: err.response?.data || err.message });
  }
});

// ═══════════════════════════════════════════════════
app.get("/", (req, res) => res.send("Claude proxy running"));

app.listen(process.env.PORT || 3000, () => console.log("Server started"));
