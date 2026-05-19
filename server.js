import "dotenv/config";
import express from "express";
import OpenAI from "openai";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client as McpClient } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error("Error: OPENAI_API_KEY is not set (check your .env file).");
  process.exit(1);
}

const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
const port = Number(process.env.PORT) || 3000;
const MAX_TOOL_ITERATIONS = 5;

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const openai = new OpenAI({ apiKey });

const SYSTEM_PROMPT =
  "You are MyAgent, a friendly and concise assistant. Keep answers helpful and to the point. " +
  "When the user asks about current weather or a forecast for any location, use the available weather tools " +
  "instead of guessing. If a tool returns an error, briefly explain what went wrong and suggest a fix.";

let messages = [{ role: "system", content: SYSTEM_PROMPT }];

// Sidecar metadata: maps a final assistant message object -> [{name, ok}]
// describing tool calls made while producing that message. Kept off the
// `messages` array so we don't leak non-standard fields to the OpenAI API.
const assistantToolMeta = new WeakMap();

// ---------- MCP client setup ----------

const mcpTransport = new StdioClientTransport({
  command: process.execPath,
  args: [path.join(__dirname, "mcp-weather-server.js")],
  stderr: "inherit",
});
const mcp = new McpClient({ name: "myagent-chat", version: "1.0.0" });
await mcp.connect(mcpTransport);

const { tools: mcpTools } = await mcp.listTools();
const mcpToolNames = new Set(mcpTools.map((t) => t.name));

const openaiTools = mcpTools.map((t) => ({
  type: "function",
  function: {
    name: t.name,
    description: t.description,
    parameters: t.inputSchema,
  },
}));

console.log(
  `Connected to MCP server. Tools: ${mcpTools.map((t) => t.name).join(", ") || "(none)"}`,
);

async function callMcpTool(name, args) {
  const result = await mcp.callTool({ name, arguments: args });
  const text = (result.content || [])
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n");
  return { text: text || "(tool returned no text content)", isError: !!result.isError };
}

// ---------- Chat handling ----------

// Only show user-typed messages and final assistant replies in the UI; hide
// system, tool, and intermediate assistant tool-call-only messages.
function visibleMessages() {
  return messages
    .filter(
      (m) =>
        m.role === "user" ||
        (m.role === "assistant" &&
          typeof m.content === "string" &&
          m.content.trim().length > 0),
    )
    .map((m) => {
      const out = { role: m.role, content: m.content };
      if (m.role === "assistant") {
        const tools = assistantToolMeta.get(m);
        if (tools && tools.length) out.tools = tools;
      }
      return out;
    });
}

// Serialize /chat requests so concurrent calls don't interleave tool calls
// into the shared history.
let chatChain = Promise.resolve();
function runSerial(fn) {
  const next = chatChain.then(fn, fn);
  chatChain = next.catch(() => {});
  return next;
}

async function handleChat(userText) {
  const startLen = messages.length;
  messages.push({ role: "user", content: userText });

  const toolsUsedThisTurn = [];
  const desktopFileNotes = [];

  try {
    for (let i = 0; i < MAX_TOOL_ITERATIONS; i++) {
      const response = await openai.chat.completions.create({
        model,
        messages,
        tools: openaiTools.length ? openaiTools : undefined,
        tool_choice: openaiTools.length ? "auto" : undefined,
      });

      const msg = response.choices[0]?.message;
      if (!msg) throw new Error("No message returned from OpenAI.");

      const assistantMsg = {
        role: "assistant",
        content: msg.content ?? null,
        ...(msg.tool_calls ? { tool_calls: msg.tool_calls } : {}),
      };
      messages.push(assistantMsg);

      const toolCalls = msg.tool_calls || [];
      if (toolCalls.length === 0) {
        let finalContent = msg.content ?? "";
        if (desktopFileNotes.length) {
          const suffix = desktopFileNotes.join("\n");
          if (!finalContent.includes("Desktop file written:") && !finalContent.includes("Desktop file write failed:")) {
            finalContent = `${finalContent}${finalContent ? "\n\n" : ""}${suffix}`;
          }
        }
        assistantMsg.content = finalContent;
        if (toolsUsedThisTurn.length) {
          assistantToolMeta.set(assistantMsg, toolsUsedThisTurn);
        }
        return finalContent;
      }

      for (const tc of toolCalls) {
        const name = tc.function?.name;
        const rawArgs = tc.function?.arguments ?? "{}";

        let toolText;
        let ok = false;
        if (!name || !mcpToolNames.has(name)) {
          toolText = `Error: unknown tool "${name}".`;
        } else {
          let args;
          try {
            args = rawArgs ? JSON.parse(rawArgs) : {};
          } catch (err) {
            toolText = `Error: tool arguments were not valid JSON (${err.message}).`;
            args = null;
          }
          if (args !== null) {
            try {
              const result = await callMcpTool(name, args);
              toolText = result.isError ? `Tool error: ${result.text}` : result.text;
              ok = !result.isError;
            } catch (err) {
              toolText = `Error invoking tool "${name}": ${err.message}`;
            }
          }
        }

        toolsUsedThisTurn.push({ name: name || "(unknown)", ok });
        for (const line of String(toolText).split(/\r?\n/)) {
          if (line.startsWith("Desktop file written:") || line.startsWith("Desktop file write failed:")) {
            desktopFileNotes.push(line);
          }
        }
        messages.push({
          role: "tool",
          tool_call_id: tc.id,
          content: toolText,
        });
      }
    }

    const fallback =
      "I wasn't able to finish that request after several tool attempts. Please rephrase or try again.";
    const fallbackMsg = { role: "assistant", content: fallback };
    messages.push(fallbackMsg);
    if (toolsUsedThisTurn.length) {
      assistantToolMeta.set(fallbackMsg, toolsUsedThisTurn);
    }
    return fallback;
  } catch (err) {
    messages = messages.slice(0, startLen);
    throw err;
  }
}

// ---------- HTTP server ----------

const app = express();
app.use(express.json({ limit: "1mb" }));
app.use(express.static(path.join(__dirname, "public")));

app.get("/messages", (_req, res) => {
  res.json({ messages: visibleMessages() });
});

app.post("/chat", async (req, res) => {
  const text = typeof req.body?.message === "string" ? req.body.message.trim() : "";
  if (!text) return res.status(400).json({ error: "message is required" });

  try {
    const reply = await runSerial(() => handleChat(text));
    res.json({ reply, messages: visibleMessages() });
  } catch (err) {
    console.error("/chat error:", err.message);
    res.status(500).json({ error: err.message });
  }
});

app.post("/reset", (_req, res) => {
  runSerial(async () => {
    messages = [{ role: "system", content: SYSTEM_PROMPT }];
  })
    .then(() => res.json({ ok: true }))
    .catch((err) => res.status(500).json({ error: err.message }));
});

const httpServer = app.listen(port, () => {
  console.log(`MyAgent web UI running at http://localhost:${port} (model: ${model})`);
});

// ---------- Graceful shutdown ----------

let shuttingDown = false;
async function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`\nReceived ${signal}, shutting down...`);
  try {
    await mcp.close();
  } catch (err) {
    console.error("Error closing MCP client:", err.message);
  }
  httpServer.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 3000).unref();
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));
