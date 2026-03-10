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
const MAX_HISTORY  = 20;
const MAX_MSGS_IN  = 100;
const MAX_MSGS_OUT = 7;

// EVEChat 格式規則從這裡開始，切掉後面所有內容
// 保留：角色人設 + 當前情景 + 情景記憶 + 動態記憶
// 丟棄：輸出格式規則（換成我們自己的）
const CUT_MARKER = "# **首要规则：输出格式**";

// ═══════════════════════════════════════════════════
// content 統一轉字串
// ═══════════════════════════════════════════════════
function normalizeContent(content) {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.filter(c => c.type === "text").map(c => c.text).join("");
  }
  return String(content);
}

// ═══════════════════════════════════════════════════
// 從 EVEChat 的 system prompt 抽出有用的部分
// 切掉格式規則，保留角色人設 + 時間情境 + 記憶
// ═══════════════════════════════════════════════════
function extractPersona(rawSystem) {
  if (!rawSystem) return "";
  const cutIndex = rawSystem.indexOf(CUT_MARKER);
  if (cutIndex !== -1) {
    return rawSystem.slice(0, cutIndex).trim();
  }
  // 找不到切割點，直接回傳（可能是自訂角色沒有這段）
  return rawSystem.trim();
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

    // 2. 抓 system（EVEChat 可能放在 req.body.system 或 messages 裡）
    let rawSystem = "";
    if (typeof req.body.system === "string" && req.body.system) {
      rawSystem = req.body.system;
    } else {
      const systemMsg = messages.find(m => m.role === "system");
      if (systemMsg) rawSystem = normalizeContent(systemMsg.content);
    }

    // 3. 切掉格式規則，只保留人設 + 時間情境 + 記憶
    const persona = extractPersona(rawSystem);

    console.log(`[請求] 原始 system：${rawSystem.length} 字，切割後：${persona.length} 字，消息數：${messages.length}`);

    // 4. 過濾 system、統一格式、截斷歷史
    const chatMessages = messages
      .filter(m => m.role !== "system")
      .map(m => ({
        role: m.role,
        content: normalizeContent(m.content)
      }))
      .slice(-MAX_HISTORY);

    // 5. 組裝 system blocks
    const systemBlocks = [
      { type: "text", text: BASE_RULES,      cache_control: { type: "ephemeral" } },
      { type: "text", text: INTERFACE_RULES, cache_control: { type: "ephemeral" } },
    ];
    if (persona) {
      systemBlocks.push({ type: "text", text: persona });
    }

    // 6. 送 Claude（不傳 temperature，Claude 不支援）
    const safeMaxTokens = Math.min(max_tokens, 1500);
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

    // 7. 合併所有 text block
    let text = response.data.content
      .filter(c => c.type === "text")
      .map(c => c.text)
      .join("");

    // 8. 清洗 markdown fence
    text = text.trim().replace(/^```json\s*|^```\s*|```$/g, "").trim();

    // 9. 截斷超過 7 條
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed) && parsed.length > MAX_MSGS_OUT) {
        text = JSON.stringify(parsed.slice(0, MAX_MSGS_OUT));
      }
    } catch (_) {}

    // 10. 回傳 GPT 格式
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
