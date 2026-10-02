// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT
using System;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Threading.Tasks;
using Microsoft.VisualStudio.PlatformUI;
using Microsoft.VisualStudio.Shell;
using Microsoft.VisualStudio.Shell.Interop;
using Newtonsoft.Json;
using Newtonsoft.Json.Linq;

namespace GitTimeLapse
{
    /// <summary>
    /// Native side of the WebView2 bridge: receives the webview's postMessage RPC,
    /// runs git subprocesses and host services, and returns a JSON reply.
    ///
    /// Message shapes (see src/transport.ts):
    ///   - git:          { id, method:"git", args:[...], cwd }
    ///                   -> { id, ok:true, result:{ code, stdout(base64), stderr } }
    ///   - readConfig:   { id, method:"readConfig" }         -> result: string
    ///   - writeConfig:  { id, method:"writeConfig", contents } -> result: null
    ///   - openInEditor: { id, method:"openInEditor", defaultContents } -> null
    ///   - openDialog:   { id, method:"openDialog" }          -> result: path|null
    ///   - openDirectoryDialog: { id, method:"openDirectoryDialog" } -> result: path|null
    ///   - setTitle / showError / close: fire-and-forget notifications (id present,
    ///     replied to for symmetry).
    ///
    /// git NEVER throws on a non-zero exit here; the code is returned and the
    /// TypeScript transport decides (matching the Tauri/Rust contract).
    /// </summary>
    internal sealed class GitRunner
    {
        public event Action CloseRequested;
        public event Action<string> TitleChanged;

        /// <summary>Peek at a message's "type" (used to detect the "ready" signal).</summary>
        public static string PeekType(string json)
        {
            try
            {
                return JObject.Parse(json)["type"]?.ToString();
            }
            catch
            {
                return null;
            }
        }

        /// <summary>
        /// Build the { type:"openFile", filePath, focusLine } push message.
        /// focusLine is 1-based and serialized as null when there is no line to
        /// focus (the webview treats null, absent and 0 alike).
        /// </summary>
        public static string BuildOpenFileMessage(string filePath, int focusLine = 0)
        {
            int? line = focusLine > 0 ? (int?)focusLine : null;
            return JsonConvert.SerializeObject(new { type = "openFile", filePath, focusLine = line });
        }

        /// <summary>
        /// Handle one RPC message and return the JSON reply, or null if the message
        /// needs no reply.
        /// </summary>
        public async Task<string> HandleAsync(string json)
        {
            JObject msg;
            try
            {
                msg = JObject.Parse(json);
            }
            catch
            {
                return null;
            }

            string id = msg["id"]?.ToString();
            string method = msg["method"]?.ToString();
            if (id == null || method == null)
            {
                return null;
            }

            // NOTE: no ConfigureAwait(false) here. Several handlers dispatched
            // below (openDialog, showError, getIdeTheme, setTitle/close) require
            // the UI thread, so the continuation must stay on it. The git path
            // (the only hot, blocking path) offloads itself to the threadpool via
            // Task.Run inside RunGitAsync, so it never parks the UI thread even
            // though this await resumes there.
            try
            {
                object result = await DispatchAsync(method, msg);
                return JsonConvert.SerializeObject(new { id, ok = true, result });
            }
            catch (Exception ex)
            {
                return JsonConvert.SerializeObject(new { id, ok = false, error = ex.Message });
            }
        }

        private async Task<object> DispatchAsync(string method, JObject msg)
        {
            switch (method)
            {
                case "git":
                    return await RunGitAsync(msg);
                case "readConfig":
                    return ReadConfig();
                case "writeConfig":
                    WriteConfig(msg["contents"]?.ToString() ?? string.Empty);
                    return null;
                case "openInEditor":
                    OpenInEditor(msg["defaultContents"]?.ToString() ?? string.Empty);
                    return null;
                case "openDialog":
                    return OpenDialog(SolutionDirectory());
                case "openDirectoryDialog":
                    return OpenDirectoryDialog(SolutionDirectory());
                case "getIdeTheme":
                    return await GetIdeThemeAsync();
                case "setTitle":
                    string title = msg["title"]?.ToString();
                    if (!string.IsNullOrEmpty(title))
                        TitleChanged?.Invoke(title);
                    return null;
                case "close":
                    CloseRequested?.Invoke();
                    return null;
                case "showError":
                    string errorMsg = msg["message"]?.ToString() ?? "Unknown error";
                    GitTimeLapsePackage.Log($"showError: {errorMsg}");
                    System.Windows.MessageBox.Show(
                        errorMsg,
                        "Git Time-Lapse View",
                        System.Windows.MessageBoxButton.OK,
                        System.Windows.MessageBoxImage.Warning);
                    return null;
                case "getIdeVersion":
                    return GetIdeVersion();
                default:
                    throw new InvalidOperationException("Unknown method: " + method);
            }
        }

        // ------------------------------------------------------------------
        // git
        // ------------------------------------------------------------------

        private async Task<object> RunGitAsync(JObject msg)
        {
            var argsToken = msg["args"] as JArray ?? new JArray();
            string cwd = msg["cwd"]?.ToString() ?? Environment.CurrentDirectory;

            // The webview may send a relative cwd (e.g. a repo/file path opened
            // from the file browser tree). git resolves a relative WorkingDirectory
            // against this process's CWD (Visual Studio's install directory), not
            // the repo, which breaks rev-parse. Resolve to an absolute path first.
            try
            {
                if (!string.IsNullOrEmpty(cwd))
                {
                    cwd = Path.GetFullPath(cwd);
                }
            }
            catch
            {
                // Malformed path; fall back to the raw value and let git report it.
            }

            var psi = new ProcessStartInfo("git")
            {
                WorkingDirectory = cwd,
                RedirectStandardOutput = true,
                RedirectStandardError = true,
                UseShellExecute = false,
                CreateNoWindow = true,
                // stdout is read from the raw byte stream below, so its text
                // encoding is irrelevant; stderr is read as UTF-8 text.
                StandardErrorEncoding = Encoding.UTF8,
            };
            // net472's ProcessStartInfo has no ArgumentList; build a correctly
            // quoted argument string for the Windows CreateProcess convention.
            var sb = new StringBuilder();
            foreach (var a in argsToken)
            {
                if (sb.Length > 0) sb.Append(' ');
                sb.Append(QuoteArgument(a.ToString()));
            }
            psi.Arguments = sb.ToString();
            GitTimeLapsePackage.Log($"git {psi.Arguments} (cwd={cwd})");

            // Run the subprocess entirely on a threadpool thread. This handler is
            // reached from the WebView2 message callback on the UI thread; the
            // precache fires many concurrent git RPCs, so any synchronous wait here
            // (or a continuation marshaled back to the UI thread) would freeze VS.
            // Task.Run + ConfigureAwait(false) keeps the whole exec off the UI
            // thread; only the final PostWebMessageAsJson is marshaled back.
            return await Task.Run(async () =>
            {
                using (var proc = new Process { StartInfo = psi, EnableRaisingEvents = true })
                {
                    // Signal completion via the Exited event instead of the
                    // blocking WaitForExit(), so no thread is parked on the process.
                    var exited = new TaskCompletionSource<bool>();
                    proc.Exited += (s, ev) => exited.TrySetResult(true);

                    proc.Start();

                    // Read stdout as raw bytes (binary-accurate) and stderr as text.
                    Task<byte[]> stdoutTask = ReadAllBytesAsync(proc.StandardOutput.BaseStream);
                    Task<string> stderrTask = proc.StandardError.ReadToEndAsync();

                    byte[] stdout = await stdoutTask.ConfigureAwait(false);
                    string stderr = await stderrTask.ConfigureAwait(false);
                    // Both streams are drained; the process has finished writing.
                    // Await the exit signal to guarantee ExitCode is available.
                    await exited.Task.ConfigureAwait(false);

                    string stdoutB64 = Convert.ToBase64String(stdout);
                    if (psi.Arguments.Contains("rev-parse") || psi.Arguments.Contains("cat-file") || proc.ExitCode != 0)
                    {
                        string stdoutText = Encoding.UTF8.GetString(stdout).TrimEnd();
                        GitTimeLapsePackage.Log($"git exit={proc.ExitCode} stdout={stdoutText} stderr={stderr}");
                    }
                    return (object)new
                    {
                        code = proc.ExitCode,
                        stdout = stdoutB64,
                        stderr,
                    };
                }
            }).ConfigureAwait(false);
        }

        /// <summary>
        /// Quote a single argument per the Windows CommandLineToArgvW rules so
        /// paths with spaces, quotes, and trailing backslashes round-trip
        /// correctly into git's argv.
        /// </summary>
        private static string QuoteArgument(string arg)
        {
            if (arg.Length > 0 && arg.IndexOfAny(new[] { ' ', '\t', '\n', '\v', '"' }) < 0)
            {
                return arg;
            }

            var sb = new StringBuilder();
            sb.Append('"');
            for (int i = 0; i < arg.Length; i++)
            {
                int backslashes = 0;
                while (i < arg.Length && arg[i] == '\\')
                {
                    backslashes++;
                    i++;
                }

                if (i == arg.Length)
                {
                    // Escape all backslashes preceding the closing quote.
                    sb.Append('\\', backslashes * 2);
                    break;
                }

                if (arg[i] == '"')
                {
                    // Escape backslashes and the embedded quote.
                    sb.Append('\\', backslashes * 2 + 1);
                    sb.Append('"');
                }
                else
                {
                    sb.Append('\\', backslashes);
                    sb.Append(arg[i]);
                }
            }
            sb.Append('"');
            return sb.ToString();
        }

        private static async Task<byte[]> ReadAllBytesAsync(Stream stream)
        {
            using (var ms = new MemoryStream())
            {
                await stream.CopyToAsync(ms).ConfigureAwait(false);
                return ms.ToArray();
            }
        }

        // ------------------------------------------------------------------
        // config (~/.git_time_lapse.json, shared with Tauri / VS Code)
        // ------------------------------------------------------------------

        private static string ConfigPath()
        {
            string home = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            return Path.Combine(home, ".git_time_lapse.json");
        }

        private static string ReadConfig()
        {
            try
            {
                string path = ConfigPath();
                return File.Exists(path) ? File.ReadAllText(path, Encoding.UTF8) : string.Empty;
            }
            catch
            {
                return string.Empty;
            }
        }

        private static void WriteConfig(string contents)
        {
            try
            {
                File.WriteAllText(ConfigPath(), contents, new UTF8Encoding(false));
            }
            catch
            {
                // Non-fatal, matching the other backends.
            }
        }

        private static void OpenInEditor(string defaultContents)
        {
            string path = ConfigPath();
            if (!File.Exists(path))
            {
                try
                {
                    File.WriteAllText(path, defaultContents, new UTF8Encoding(false));
                }
                catch
                {
                    // ignore; still try to open below
                }
            }

            try
            {
                var psi = new ProcessStartInfo(path) { UseShellExecute = true };
                Process.Start(psi);
            }
            catch
            {
                // Editor launch failed; nothing further to do.
            }
        }

        // ------------------------------------------------------------------
        // IDE theme (for auto-matching the syntax highlighting theme)
        // ------------------------------------------------------------------

        /// <summary>
        /// Report whether Visual Studio is using a dark or light theme so the
        /// shared UI can auto-select a matching highlight.js theme on first run.
        /// Rather than parse the theme name from the registry (fragile across VS
        /// versions), sample the themed tool-window background color and classify
        /// it by luminance; this works for the built-in Dark, Light, and Blue
        /// themes and any third-party theme. Returns "dark" or "light", which the
        /// shared mapping turns into vs2015 / vs respectively.
        /// </summary>
        private static async Task<object> GetIdeThemeAsync()
        {
            await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
            try
            {
                var bg = VSColorTheme.GetThemedColor(
                    EnvironmentColors.ToolWindowBackgroundColorKey);
                // Perceived luminance (ITU-R BT.601). Below ~50% => dark theme.
                double luminance = (0.299 * bg.R + 0.587 * bg.G + 0.114 * bg.B) / 255.0;
                return luminance < 0.5 ? "dark" : "light";
            }
            catch (Exception ex)
            {
                GitTimeLapsePackage.Log($"GetIdeTheme failed: {ex.Message}");
                return null;
            }
        }

        // ------------------------------------------------------------------
        // file dialog
        // ------------------------------------------------------------------

        /// <summary>
        /// The directory containing the currently open solution, or null if no
        /// solution is loaded. Used to seed the file/folder pickers so browsing
        /// starts where the user is working. Must be called on the UI thread
        /// (DispatchAsync already runs there).
        /// </summary>
        private static string SolutionDirectory()
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            try
            {
                if (Package.GetGlobalService(typeof(SDTE)) is EnvDTE.DTE dte)
                {
                    string solPath = dte.Solution?.FullName;
                    if (!string.IsNullOrEmpty(solPath))
                    {
                        return Path.GetDirectoryName(solPath);
                    }
                }
            }
            catch
            {
                // No solution / DTE unavailable; fall back to the shell default.
            }
            return null;
        }

        private static string OpenDialog(string initialDir)
        {
            // Show the modal dialog directly on the VS UI thread. This handler is
            // reached from the WebView2 message callback, whose continuation stays
            // on the UI thread (HandleAsync awaits without ConfigureAwait(false)).
            // A modal dialog pumps its own messages, so it blocks only until the
            // user chooses. Spinning up a separate STA thread and Join()-ing it
            // here deadlocks VS: the Join parks the UI thread, but the dialog on
            // the other thread needs that same message pump to resolve its owner
            // window and stay responsive.
            ThreadHelper.ThrowIfNotOnUIThread();
            var dialog = new Microsoft.Win32.OpenFileDialog
            {
                Title = "Select a file for Git Time-Lapse View",
                CheckFileExists = true,
                Multiselect = false,
            };
            if (!string.IsNullOrEmpty(initialDir) && Directory.Exists(initialDir))
            {
                dialog.InitialDirectory = initialDir;
            }
            return dialog.ShowDialog() == true ? dialog.FileName : null;
        }

        private static string OpenDirectoryDialog(string initialDir)
        {
            // Run directly on the UI thread; see OpenDialog for why the previous
            // STA-thread + Join() approach deadlocked VS. FolderBrowserDialog is
            // the simplest folder picker on net472 (WPF has no folder dialog).
            ThreadHelper.ThrowIfNotOnUIThread();
            using (var dialog = new System.Windows.Forms.FolderBrowserDialog())
            {
                dialog.Description = "Select a git repository folder for Git Time-Lapse View";
                dialog.ShowNewFolderButton = false;
                if (!string.IsNullOrEmpty(initialDir) && Directory.Exists(initialDir))
                {
                    dialog.SelectedPath = initialDir;
                }
                return dialog.ShowDialog() == System.Windows.Forms.DialogResult.OK
                    ? dialog.SelectedPath
                    : null;
            }
        }

        // ------------------------------------------------------------------
        // IDE version
        // ------------------------------------------------------------------

        private static string GetIdeVersion()
        {
            try
            {
                string vsDir = Environment.GetEnvironmentVariable("VSAPPIDDIR") ?? "";
                string version = "Visual Studio";
                if (vsDir.Contains("2022")) version = "Visual Studio 2022";
                else if (vsDir.Contains("2026")) version = "Visual Studio 2026";
                else if (vsDir.Contains("2019")) version = "Visual Studio 2019";

                string vsVer = Environment.GetEnvironmentVariable("VSCMD_VER") ?? "";
                if (!string.IsNullOrEmpty(vsVer))
                    version += " " + vsVer;
                else
                {
                    string installDir = Environment.GetEnvironmentVariable("VSINSTALLDIR") ?? vsDir;
                    if (!string.IsNullOrEmpty(installDir))
                    {
                        if (installDir.Contains("17.")) version += " 17.x";
                        else if (installDir.Contains("18.")) version += " 18.x";
                    }
                }
                return version;
            }
            catch
            {
                return "Visual Studio";
            }
        }
    }
}
