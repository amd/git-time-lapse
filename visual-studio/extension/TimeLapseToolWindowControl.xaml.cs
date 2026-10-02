// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT
using System;
using System.IO;
using System.Reflection;
using System.Windows.Controls;
using Microsoft.VisualStudio.Shell;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;

namespace GitTimeLapse
{
    public partial class TimeLapseToolWindowControl : UserControl
    {
        private const string VirtualHost = "gittimelapse.local";

        private readonly GitRunner _runner = new GitRunner();
        private bool _initStarted;
        private bool _webviewReady;
        private string _pendingFile;
        private int _pendingLine;

        public event Action CloseRequested;
        public event Action<string> TitleChanged;

        public TimeLapseToolWindowControl()
        {
            GitTimeLapsePackage.Log("TimeLapseToolWindowControl constructor - before InitializeComponent");
            InitializeComponent();
            GitTimeLapsePackage.Log("TimeLapseToolWindowControl constructor - after InitializeComponent");
            _runner.CloseRequested += () => Dispatcher.Invoke(() => CloseRequested?.Invoke());
            _runner.TitleChanged += (t) => Dispatcher.Invoke(() => TitleChanged?.Invoke(t));
        }

        public void OpenFile(string filePath, int focusLine = 0)
        {
            GitTimeLapsePackage.Log($"TimeLapseToolWindowControl.OpenFile: {filePath}, line={focusLine}, initStarted={_initStarted}, webviewReady={_webviewReady}");
            _pendingFile = filePath;
            // Always overwrite, never conditionally: a later no-line open must not
            // inherit the previous open's line.
            _pendingLine = focusLine;

            if (!_initStarted)
            {
                _initStarted = true;
                StartWebView2Init();
                return;
            }

            if (_webviewReady)
            {
                PushPendingFile();
            }
        }

        private void StartWebView2Init()
        {
            try
            {
                string userDataFolder = Path.Combine(
                    Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
                    "GitTimeLapse", "WebView2");
                Directory.CreateDirectory(userDataFolder);
                GitTimeLapsePackage.Log($"WebView2 user data folder: {userDataFolder}");

                WebView.CoreWebView2InitializationCompleted += OnCoreWebView2Initialized;
                WebView.CreationProperties = new CoreWebView2CreationProperties
                {
                    UserDataFolder = userDataFolder
                };
                GitTimeLapsePackage.Log("Calling EnsureCoreWebView2Async (fire-and-forget)...");
                WebView.EnsureCoreWebView2Async();
                GitTimeLapsePackage.Log("EnsureCoreWebView2Async called");
            }
            catch (Exception ex)
            {
                GitTimeLapsePackage.Log($"StartWebView2Init FAILED: {ex}");
            }
        }

        private void OnCoreWebView2Initialized(object sender, CoreWebView2InitializationCompletedEventArgs e)
        {
            GitTimeLapsePackage.Log($"CoreWebView2InitializationCompleted: IsSuccess={e.IsSuccess}");
            if (!e.IsSuccess)
            {
                GitTimeLapsePackage.Log($"WebView2 init error: {e.InitializationException}");
                return;
            }

            try
            {
                var core = WebView.CoreWebView2;

                string webviewDir = Path.Combine(ExtensionDir(), "Resources", "webview");
                GitTimeLapsePackage.Log($"Webview dir: {webviewDir}, exists: {Directory.Exists(webviewDir)}");
                core.SetVirtualHostNameToFolderMapping(
                    VirtualHost, webviewDir, CoreWebView2HostResourceAccessKind.Allow);

                core.Settings.AreDefaultContextMenusEnabled = false;
                core.Settings.IsStatusBarEnabled = false;
                core.Settings.AreDevToolsEnabled = false;
                core.Settings.IsZoomControlEnabled = false;

                core.WebMessageReceived += OnWebMessageReceived;

                string html = BuildHtml();
                GitTimeLapsePackage.Log("Navigating to HTML...");
                core.NavigateToString(html);
                GitTimeLapsePackage.Log("Navigation started");
            }
            catch (Exception ex)
            {
                GitTimeLapsePackage.Log($"OnCoreWebView2Initialized setup FAILED: {ex}");
                try
                {
                    WebView.CoreWebView2?.NavigateToString(
                        "<html><body style='font-family:sans-serif;padding:1em'>" +
                        "<h3>Git Time-Lapse failed to start</h3><pre>" +
                        System.Net.WebUtility.HtmlEncode(ex.ToString()) +
                        "</pre></body></html>");
                }
                catch { }
            }
        }

        private static string ExtensionDir()
        {
            string codeBase = Assembly.GetExecutingAssembly().Location;
            return Path.GetDirectoryName(codeBase) ?? string.Empty;
        }

        private static string BuildHtml()
        {
            return
                "<!doctype html>\n" +
                "<html lang=\"en\">\n" +
                "  <head>\n" +
                "    <meta charset=\"UTF-8\" />\n" +
                "    <meta name=\"viewport\" content=\"width=device-width, initial-scale=1.0\" />\n" +
                "    <title>Git Time-Lapse View</title>\n" +
                "  </head>\n" +
                "  <body>\n" +
                "    <div id=\"app\"></div>\n" +
                "    <script src=\"https://" + VirtualHost + "/webview.js\"></script>\n" +
                "  </body>\n" +
                "</html>";
        }

#pragma warning disable VSTHRD100
        private async void OnWebMessageReceived(object sender, CoreWebView2WebMessageReceivedEventArgs e)
#pragma warning restore VSTHRD100
        {
            try
            {
                string json;
                try { json = e.WebMessageAsJson; }
                catch { return; }

                var kind = GitRunner.PeekType(json);
                if (kind == "ready")
                {
                    GitTimeLapsePackage.Log("Webview sent 'ready'");
                    _webviewReady = true;
                    PushPendingFile();
                    return;
                }

                string response = await _runner.HandleAsync(json);
                if (response != null)
                {
                    WebView.CoreWebView2.PostWebMessageAsJson(response);
                }
            }
            catch (Exception ex)
            {
                GitTimeLapsePackage.Log($"OnWebMessageReceived error: {ex.Message}");
            }
        }

        private void PushPendingFile()
        {
            if (string.IsNullOrEmpty(_pendingFile) || !_webviewReady)
                return;

            GitTimeLapsePackage.Log($"Pushing file to webview: {_pendingFile}, line: {_pendingLine}");
            string payload = GitRunner.BuildOpenFileMessage(_pendingFile, _pendingLine);
            WebView.CoreWebView2.PostWebMessageAsJson(payload);
            _pendingFile = null;
            _pendingLine = 0;
        }
    }
}
