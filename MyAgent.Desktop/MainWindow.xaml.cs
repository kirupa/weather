using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Http;
using System.Net.Sockets;
using System.Runtime.InteropServices;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Interop;

namespace MyAgent.Desktop;

public partial class MainWindow : Window
{
    private void ResetButton_Click(object sender, RoutedEventArgs e)
    {
        // TODO: Implement reset logic if needed
    }

    private void ReloadButton_Click(object sender, RoutedEventArgs e)
    {
        if (WebView?.CoreWebView2 != null)
        {
            WebView.CoreWebView2.Reload();
        }
    }
    private const int DWMWA_BORDER_COLOR = 34;
    private const int DWMWA_CAPTION_COLOR = 35;
    private const int DWMWA_TEXT_COLOR = 36;
    private const int BLACK_COLORREF = 0x000000;
    private const int WHITE_COLORREF = 0xFFFFFF;

    private Process? _nodeProcess;
    private ChildProcessJob? _job;
    private int _port;

    public MainWindow()
    {
        InitializeComponent();
        SourceInitialized += OnSourceInitialized;
        Loaded += OnLoaded;
        Closing += OnClosing;
    }
    


    private void OnSourceInitialized(object? sender, EventArgs e)
    {
        TryApplyBlackTitleBar();
    }

    private void TryApplyBlackTitleBar()
    {
        var handle = new WindowInteropHelper(this).Handle;
        if (handle == IntPtr.Zero) return;

        var black = BLACK_COLORREF;
        var white = WHITE_COLORREF;
        _ = DwmSetWindowAttribute(handle, DWMWA_CAPTION_COLOR, ref black, sizeof(int));
        _ = DwmSetWindowAttribute(handle, DWMWA_BORDER_COLOR, ref black, sizeof(int));
        _ = DwmSetWindowAttribute(handle, DWMWA_TEXT_COLOR, ref white, sizeof(int));
    }

    [DllImport("dwmapi.dll")]
    private static extern int DwmSetWindowAttribute(IntPtr hwnd, int attr, ref int attrValue, int attrSize);

    private async void OnLoaded(object sender, RoutedEventArgs e)
    {
        try
        {
            await InitializeAsync();
        }
        catch (Exception ex)
        {
            ShowError(ex.Message);
        }
    }

    private async Task InitializeAsync()
    {
        var serverDir = FindServerDirectory()
            ?? throw new InvalidOperationException(
                "Could not locate server.js. Expected it next to MyAgent.Desktop, " +
                "MyAgent\\server.js, or a parent directory of the executable.");

        LoadingStatus.Text = $"Found backend at {serverDir}";

        _port = GetFreePort();

        await WebView.EnsureCoreWebView2Async();
        WebView.CoreWebView2.Settings.AreDefaultContextMenusEnabled = false;
        WebView.CoreWebView2.Settings.AreDevToolsEnabled = false;

        LoadingStatus.Text = $"Starting Node.js backend on port {_port}…";
        _job = new ChildProcessJob();
        _nodeProcess = StartNodeServer(serverDir, _port);
        _job.Assign(_nodeProcess);
        _nodeProcess.Exited += OnNodeExited;
        _nodeProcess.EnableRaisingEvents = true;

        LoadingStatus.Text = $"Waiting for backend on http://localhost:{_port}…";
        await WaitForServerReadyAsync(_port, TimeSpan.FromSeconds(30));

        WebView.CoreWebView2.Navigate($"http://localhost:{_port}/");
        WebView.Visibility = Visibility.Visible;
        Loading.Visibility = Visibility.Collapsed;
    }

    private static string? FindServerDirectory()
    {
        var start = new DirectoryInfo(AppContext.BaseDirectory);
        for (DirectoryInfo? dir = start; dir != null; dir = dir.Parent)
        {
            if (File.Exists(Path.Combine(dir.FullName, "server.js")) &&
                File.Exists(Path.Combine(dir.FullName, "package.json")))
            {
                return dir.FullName;
            }
            var sibling = Path.Combine(dir.FullName, "MyAgent");
            if (Directory.Exists(sibling) &&
                File.Exists(Path.Combine(sibling, "server.js")))
            {
                return sibling;
            }
        }
        return null;
    }

    private static int GetFreePort()
    {
        var listener = new TcpListener(IPAddress.Loopback, 0);
        listener.Start();
        try { return ((IPEndPoint)listener.LocalEndpoint).Port; }
        finally { listener.Stop(); }
    }

    private static Process StartNodeServer(string workingDir, int port)
    {
        var logPath = Path.Combine(
            Path.GetTempPath(),
            $"myagent-backend-{DateTime.Now:yyyyMMdd-HHmmss}.log");
        Debug.WriteLine($"[myagent] Backend log: {logPath}");

        var psi = new ProcessStartInfo
        {
            FileName = "node",
            Arguments = "server.js",
            WorkingDirectory = workingDir,
            UseShellExecute = false,
            CreateNoWindow = true,
            RedirectStandardOutput = true,
            RedirectStandardError = true,
        };
        psi.Environment["PORT"] = port.ToString();
        psi.Environment["MYAGENT_LOG_FILE"] = logPath;

        Process proc;
        try
        {
            proc = Process.Start(psi)
                ?? throw new InvalidOperationException("Process.Start returned null.");
        }
        catch (Win32Exception ex) when (ex.NativeErrorCode == 2)
        {
            throw new InvalidOperationException(
                "node.exe was not found on PATH. Install Node.js 18+ from https://nodejs.org/ " +
                "and reopen MyAgent.", ex);
        }

        var logWriter = new StreamWriter(logPath, append: false) { AutoFlush = true };
        logWriter.WriteLine($"--- MyAgent backend started at {DateTimeOffset.Now} ---");
        logWriter.WriteLine($"Working dir: {workingDir}");
        logWriter.WriteLine($"Command: node server.js   PORT={port}");
        logWriter.WriteLine();

        proc.OutputDataReceived += (_, e) =>
        {
            if (e.Data != null) { Debug.WriteLine("[node] " + e.Data); logWriter.WriteLine("[stdout] " + e.Data); }
        };
        proc.ErrorDataReceived += (_, e) =>
        {
            if (e.Data != null) { Debug.WriteLine("[node!] " + e.Data); logWriter.WriteLine("[stderr] " + e.Data); }
        };
        proc.Exited += (_, _) =>
        {
            logWriter.WriteLine($"--- Process exited at {DateTimeOffset.Now} (code {proc.ExitCode}) ---");
            logWriter.Dispose();
        };
        proc.BeginOutputReadLine();
        proc.BeginErrorReadLine();
        return proc;
    }

    private static async Task WaitForServerReadyAsync(int port, TimeSpan timeout)
    {
        using var http = new HttpClient { Timeout = TimeSpan.FromSeconds(2) };
        var deadline = DateTime.UtcNow + timeout;
        Exception? lastError = null;
        while (DateTime.UtcNow < deadline)
        {
            try
            {
                using var r = await http.GetAsync($"http://localhost:{port}/messages");
                if (r.IsSuccessStatusCode) return;
            }
            catch (Exception ex)
            {
                lastError = ex;
            }
            await Task.Delay(250);
        }
        throw new TimeoutException(
            $"Backend did not become ready on port {port} within {timeout.TotalSeconds}s. " +
            (lastError != null ? $"Last error: {lastError.Message}" : ""));
    }

    private void OnNodeExited(object? sender, EventArgs e)
    {
        Dispatcher.Invoke(() =>
        {
            int code = -1;
            try { code = _nodeProcess?.ExitCode ?? -1; } catch { /* not available */ }

            string message;
            if (Loading.Visibility == Visibility.Visible)
            {
                message =
                    $"The Node.js backend exited during startup (exit code {code}). " +
                    "Check that your .env file has a valid OPENAI_API_KEY and that `npm install` " +
                    "has been run in the MyAgent folder.";
            }
            else
            {
                message =
                    $"The Node.js backend crashed (exit code {code}). The chat is no longer functional. " +
                    "Close and reopen MyAgent to restart it. " +
                    "Backend log: " +
                    Environment.GetEnvironmentVariable("MYAGENT_LOG_FILE");
            }
            ShowError(message);
        });
    }

    private void ShowError(string message)
    {
        Loading.Visibility = Visibility.Collapsed;
        WebView.Visibility = Visibility.Collapsed;
        ErrorText.Text = message;
        ErrorPanel.Visibility = Visibility.Visible;
    }

    private void OnClosing(object? sender, CancelEventArgs e)
    {
        try
        {
            if (_nodeProcess != null && !_nodeProcess.HasExited)
            {
                _nodeProcess.Kill(entireProcessTree: true);
                _nodeProcess.WaitForExit(3000);
            }
        }
        catch
        {
            // best effort
        }
        finally
        {
            _job?.Dispose();
            _job = null;
        }
    }
}
