# MyAgent

A simple back-and-forth chatbot powered by the OpenAI API.

## Setup

1. Install dependencies:

   ```powershell
   npm install
   ```

2. Configure your API key in a `.env` file in the project root:

   ```
   OPENAI_API_KEY=sk-...
   # Optional: override model (defaults to gpt-4o-mini)
   # OPENAI_MODEL=gpt-4o
   ```

   The `.env` file is git-ignored, so your key stays local. The app loads
   it automatically via `dotenv`. Environment variables set in the shell
   still take precedence over `.env`.

## Run

CLI chat:

```powershell
npm start
```

Web UI (open http://localhost:3000):

```powershell
npm run web
```

The web UI is wired to a local **weather MCP server** (`mcp-weather-server.js`) that
exposes `get_current_weather` and `get_forecast` tools. The chatbot automatically
calls these tools for any weather-related query, using the free
[Open-Meteo](https://open-meteo.com/) API (no API key required).

## Native Windows app (WPF + WebView2)

A native Windows shell that embeds the web UI lives in `MyAgent.Desktop\`. It
spawns the Node backend on a free port and hosts it in an Edge WebView2 control;
a Windows Job Object guarantees the backend is torn down on exit (or crash).

```powershell
cd MyAgent.Desktop
dotnet run -c Release
```

See `MyAgent.Desktop\README.md` for details.

## Commands during CLI chat

- `reset` — clear conversation history
- `exit`, `quit`, or `bye` — end the chat
