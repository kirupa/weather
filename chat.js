import "dotenv/config";
import OpenAI from "openai";
import readline from "node:readline";

const apiKey = process.env.OPENAI_API_KEY;
if (!apiKey) {
  console.error("Error: OPENAI_API_KEY environment variable is not set.");
  console.error('Set it with: $env:OPENAI_API_KEY="sk-..."  (PowerShell)');
  process.exit(1);
}

const model = process.env.OPENAI_MODEL || "gpt-4o-mini";
const client = new OpenAI({ apiKey });

const messages = [
  {
    role: "system",
    content:
      "You are MyAgent, a friendly and concise assistant. Keep answers helpful and to the point.",
  },
];

const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

console.log(`MyAgent chatbot (model: ${model})`);
console.log('Type "reset" to clear history, or "exit" to quit.\n');

rl.setPrompt("You: ");
rl.prompt();

rl.on("line", async (input) => {
  const text = input.trim();

  if (!text) {
    rl.prompt();
    return;
  }

  if (["exit", "quit", "bye", ":q"].includes(text.toLowerCase())) {
    console.log("Bot: Goodbye!");
    rl.close();
    return;
  }

  if (text.toLowerCase() === "reset") {
    messages.splice(1);
    console.log("Bot: (conversation reset)\n");
    rl.prompt();
    return;
  }

  rl.pause();
  messages.push({ role: "user", content: text });

  try {
    const response = await client.chat.completions.create({
      model,
      messages,
    });

    const reply = response.choices[0]?.message?.content?.trim() ?? "";
    messages.push({ role: "assistant", content: reply });
    console.log(`Bot: ${reply}\n`);
  } catch (err) {
    console.error(`Bot: (error) ${err.message}\n`);
    messages.pop();
  }

  rl.resume();
  rl.prompt();
});

rl.on("close", () => process.exit(0));
