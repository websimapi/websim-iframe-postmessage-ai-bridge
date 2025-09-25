// Configuration: optional whitelist via ?allowedOrigins=https://site1.com,https://site2.com
const params = new URLSearchParams(location.search);
const allowedOrigins = (params.get("allowedOrigins") || "*")
  .split(",")
  .map(s => s.trim())
  .filter(Boolean);
const isWildcard = allowedOrigins.includes("*");

const state = {
  embedded: window.self !== window.top,
  ready: false,
};

const $ = sel => document.querySelector(sel);
const logEl = $("#log");
function log(msg, obj) {
  const line = document.createElement("div");
  line.className = "log-line";
  line.textContent = `[${new Date().toLocaleTimeString()}] ${msg}`;
  if (obj) {
    const pre = document.createElement("pre");
    pre.className = "log-line";
    pre.textContent = JSON.stringify(obj, null, 2);
    line.appendChild(pre);
  }
  logEl.prepend(line);
}

function updateBadges() {
  $("#embed-status").textContent = state.embedded ? "Embedded" : "Not embedded";
  $("#origin-status").textContent = `Origin: ${isWildcard ? "*" : allowedOrigins.join(", ")}`;
  $("#ready-status").textContent = `Ready: ${state.ready}`;
}
updateBadges();

// Handshake: notify parent this iframe is ready
function postToParent(payload, targetOrigin = isWildcard ? "*" : allowedOrigins[0]) {
  if (!state.embedded) return;
  window.parent.postMessage(payload, targetOrigin);
  log("Outbound postMessage", payload);
}

function sendReady() {
  const payload = {
    type: "AI_BRIDGE_READY",
    timestamp: Date.now(),
    pageUrl: location.href,
  };
  postToParent(payload);
  state.ready = true;
  updateBadges();
}

if (state.embedded) {
  // auto send ready after load
  window.addEventListener("load", () => sendReady());
}

// Controls
$("#send-ready").addEventListener("click", sendReady);
$("#simulate-inbound").addEventListener("click", async () => {
  const message = {
    type: "AI_BRIDGE_INSTRUCTIONS",
    correlationId: `sim-${Math.random().toString(36).slice(2)}`,
    instructions: {
      mode: "auto",
      prompt: "Write a two-sentence summary about the importance of clean UI. Also propose a title.",
    },
  };
  await handleInbound(message, location.origin);
});

// Origin check
function isAllowedOrigin(origin) {
  if (isWildcard) return true;
  return allowedOrigins.includes(origin);
}

// Message listener
window.addEventListener("message", async (event) => {
  const origin = event.origin || event.source?.origin || "*";
  if (!isAllowedOrigin(origin)) {
    log("Rejected message from disallowed origin", { origin });
    return;
  }
  const data = event.data;
  if (!data || typeof data !== "object") return;

  if (data.type === "AI_BRIDGE_PING") {
    postToParent({
      type: "AI_BRIDGE_PONG",
      timestamp: Date.now(),
      echo: data.echo ?? null,
    }, event.origin);
    return;
  }

  if (data.type === "AI_BRIDGE_INSTRUCTIONS") {
    await handleInbound(data, event.origin);
  }
});

// Core: interpret instructions with AI, then execute generation
async function handleInbound(message, replyOrigin) {
  const { correlationId, instructions } = message;
  log("Inbound instructions", { correlationId, instructions });

  const safeReply = (payload) => {
    postToParent({
      type: "AI_BRIDGE_RESULT",
      correlationId,
      ...payload,
    }, replyOrigin);
  };

  try {
    const interpreted = await interpretInstructions(instructions);
    log("Interpreted", interpreted);

    let resultPayload;

    if (interpreted.mode === "image") {
      resultPayload = await generateImage(interpreted);
    } else if (interpreted.mode === "tts") {
      resultPayload = await generateTTS(interpreted);
    } else {
      resultPayload = await generateText(interpreted);
    }

    safeReply({
      success: true,
      data: resultPayload,
    });
  } catch (err) {
    console.error(err);
    safeReply({
      success: false,
      error: {
        message: err?.message || "Unknown error",
        stack: err?.stack || null,
      },
    });
  }
}

// Use LLM to classify and normalize the instruction payload
async function interpretInstructions(input) {
  const schema = `
Respond directly with JSON, following this JSON schema, and no other text.
{
  mode: "text" | "image" | "tts";
  prompt: string;
  options?: {
    aspect_ratio?: "1:1" | "16:9" | "21:9" | "3:2" | "2:3" | "4:5" | "5:4" | "3:4" | "4:3" | "9:16" | "9:21";
    transparent?: boolean;
    width?: number;
    height?: number;
    seed?: number;
    voice?: string; // e.g., "en-male" or ElevenLabs voice ID
    language?: string; // e.g., "en", "es", "fr"
  };
}
`.trim();

  // If the caller already specified a clear mode/prompt, we still pass through LLM to normalize
  const messages = [
    {
      role: "system",
      content:
        "Classify the user's intent into text, image, or tts. Normalize fields. Prefer 'tts' if the user asks to speak or audio. Prefer 'image' for visuals.",
    },
    {
      role: "user",
      content: [
        {
          type: "text",
          text: `${schema}\nInput:\n${JSON.stringify(input)}`,
        },
      ],
      json: true,
    },
  ];

  const completion = await websim.chat.completions.create({ messages });
  const result = JSON.parse(completion.content);

  // Fallbacks
  if (!result.mode) result.mode = "text";
  if (!result.prompt) result.prompt = typeof input === "string" ? input : JSON.stringify(input);
  if (!result.options) result.options = {};

  return result;
}

// Generators
async function generateText(parsed) {
  const { prompt, options = {} } = parsed;
  const messages = [
    { role: "system", content: "You are a concise, helpful assistant. Return polished, ready-to-use text." },
    { role: "user", content: prompt },
  ];
  const completion = await websim.chat.completions.create({ messages });
  return {
    type: "text",
    text: completion.content,
    usage: completion.usage ?? null,
  };
}

async function generateImage(parsed) {
  const { prompt, options = {} } = parsed;
  // Show loading indicator for ~10s as imageGen is slow
  addLoading("image");
  try {
    const result = await websim.imageGen({
      prompt,
      aspect_ratio: options.aspect_ratio,
      transparent: options.transparent,
      width: options.width,
      height: options.height,
      seed: options.seed,
    });
    return {
      type: "image",
      url: result.url,
      meta: {
        aspect_ratio: options.aspect_ratio ?? null,
        transparent: options.transparent ?? false,
        width: options.width ?? null,
        height: options.height ?? null,
        seed: options.seed ?? null,
      },
    };
  } finally {
    removeLoading("image");
  }
}

async function generateTTS(parsed) {
  const { prompt, options = {} } = parsed;
  const result = await websim.textToSpeech({
    text: prompt,
    voice: options.voice || `${options.language || "en"}-male`,
  });
  return {
    type: "tts",
    url: result.url,
    meta: {
      voice: options.voice || null,
      language: options.language || "en",
    },
  };
}

// UI loading badge
function addLoading(tag) {
  const badge = document.createElement("div");
  badge.className = "badge loading";
  badge.dataset.tag = tag;
  badge.textContent = `Generating ${tag}...`;
  $(".status").appendChild(badge);
}
function removeLoading(tag) {
  const el = document.querySelector(`.badge.loading[data-tag="${tag}"]`);
  if (el) el.remove();
}

