# MyAgent Desktop (WPF + WebView2)

A native Windows shell that hosts the MyAgent chatbot UI inside an embedded
Edge WebView2. On startup it spawns the existing Node.js backend
(`..\server.js`) on a free port, waits for it to come up, then navigates the
WebView to `http://localhost:<port>/`. On exit (or crash / Task Manager kill)
a Windows Job Object guarantees the Node backend and its MCP subprocess are
torn down — no orphans.

## Requirements

- Windows 10/11
- [.NET 8+ SDK](https://dotnet.microsoft.com/download) (built with .NET 10)
- [Node.js 18+](https://nodejs.org/) on `PATH` (used for the backend)
- WebView2 Runtime (pre-installed on Windows 10/11)
- Backend dependencies installed: from the parent `MyAgent` folder run `npm install`
- `OPENAI_API_KEY` in `..\.env`

## Build & run

From this folder:

```powershell
dotnet build -c Release
.\bin\Release\net10.0-windows\MyAgent.Desktop.exe
```

Or run in one step:

```powershell
dotnet run -c Release
```

## How it locates the backend

`MainWindow` walks up from `AppContext.BaseDirectory` looking for a folder
containing both `server.js` and `package.json` (or a sibling `MyAgent\` folder
containing `server.js`). This works for both `dotnet run` (running out of
`bin\Release\net10.0-windows\`) and side-by-side deployment of the .exe with
the Node project.

## Files

- `MainWindow.xaml(.cs)` — UI shell, loading screen, error panel, WebView2 host
- `ChildProcessJob.cs` — P/Invoke wrapper for a Windows Job Object configured
  with `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` so child Node processes die with the app
- `MyAgent.Desktop.csproj` — net10.0-windows, WPF, `Microsoft.Web.WebView2` package
