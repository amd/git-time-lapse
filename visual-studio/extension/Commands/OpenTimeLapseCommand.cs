// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT
using System;
using System.ComponentModel.Design;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.VisualStudio;
using Microsoft.VisualStudio.Shell;
using Microsoft.VisualStudio.Shell.Interop;
using Task = System.Threading.Tasks.Task;

namespace GitTimeLapse
{
    /// <summary>
    /// Handles the "Git Time-Lapse View" command in its three placements, each
    /// with its own command ID so the invoking surface is unambiguous:
    ///   - Tools menu        -> blank viewer (no file)
    ///   - Solution Explorer  -> the selected file
    ///   - editor context     -> the active document
    /// Execute branches on the command ID, resolves the file (or null), opens the
    /// tool window, and hands the file (if any) to its WebView2 host.
    /// </summary>
    internal sealed class OpenTimeLapseCommand
    {
        /// <summary>Command set GUID (matches guidGitTimeLapseCmdSet in the .vsct).</summary>
        public static readonly Guid CommandSet = new Guid("2D3E4F5A-6B7C-8D9E-0A1B-2C3D4E5F6A7B");

        // One command ID per placement (must match the .vsct). All three route to
        // the same Execute, which branches on the invoking command's ID:
        //   Tools menu       -> blank viewer
        //   Solution Explorer -> the selected file
        //   editor context    -> the active document

        /// <summary>Tools-menu command ID (opens a blank viewer).</summary>
        public const int OpenTimeLapseCommandId = 0x0100;

        /// <summary>Solution Explorer command ID (opens the selected file).</summary>
        public const int OpenTimeLapseSolutionCommandId = 0x0101;

        /// <summary>Editor context command ID (opens the active document).</summary>
        public const int OpenTimeLapseEditorCommandId = 0x0102;

        private readonly AsyncPackage _package;

        private OpenTimeLapseCommand(AsyncPackage package, OleMenuCommandService commandService)
        {
            _package = package ?? throw new ArgumentNullException(nameof(package));
            foreach (int commandId in new[]
            {
                OpenTimeLapseCommandId,
                OpenTimeLapseSolutionCommandId,
                OpenTimeLapseEditorCommandId,
            })
            {
                var id = new CommandID(CommandSet, commandId);
                var command = new OleMenuCommand(Execute, id);
                command.BeforeQueryStatus += OnBeforeQueryStatus;
                commandService.AddCommand(command);
            }
        }

        public static async Task InitializeAsync(AsyncPackage package)
        {
            GitTimeLapsePackage.Log("Command InitializeAsync started");
            await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync(package.DisposalToken);
            GitTimeLapsePackage.Log("Switched to main thread");
            var commandService =
                await package.GetServiceAsync(typeof(IMenuCommandService)) as OleMenuCommandService;
            GitTimeLapsePackage.Log($"CommandService: {(commandService != null ? "OK" : "NULL")}");
            if (commandService != null)
            {
                _ = new OpenTimeLapseCommand(package, commandService);
                GitTimeLapsePackage.Log("Command registered");
            }
        }

        private void OnBeforeQueryStatus(object sender, EventArgs e)
        {
            GitTimeLapsePackage.Log("OnBeforeQueryStatus called");
            if (sender is OleMenuCommand command)
            {
                command.Visible = true;
                command.Enabled = true;
            }
        }

        private void Execute(object sender, EventArgs e)
        {
            GitTimeLapsePackage.Log("Execute called");
            try
            {
                ThreadHelper.ThrowIfNotOnUIThread();

                // Each placement has its own command ID so the source is
                // unambiguous: the Tools menu always opens a blank viewer; the
                // Solution Explorer item opens the selected file; the editor
                // context menu opens the active document. A context-menu resolver
                // returning null (e.g. selection isn't a real file) falls through
                // to a blank viewer rather than picking up an unrelated file.
                int commandId = (sender as OleMenuCommand)?.CommandID?.ID ?? OpenTimeLapseCommandId;
                string filePath;
                int focusLine = 0;
                switch (commandId)
                {
                    case OpenTimeLapseSolutionCommandId:
                        filePath = ResolveSelectedFile();
                        break;
                    case OpenTimeLapseEditorCommandId:
                        filePath = ResolveActiveDocument(out focusLine);
                        break;
                    default:
                        filePath = null; // Tools menu -> blank viewer
                        break;
                }
                GitTimeLapsePackage.Log($"Command {commandId:X}, resolved file: {filePath ?? "(none)"}, line: {focusLine}");

                OpenViewer(filePath, focusLine);
            }
            catch (Exception ex)
            {
                GitTimeLapsePackage.Log($"Execute FAILED: {ex}");
                System.Windows.MessageBox.Show(
                    $"Git Time-Lapse failed:\n\n{ex.Message}\n\nSee %LocalAppData%\\GitTimeLapse\\extension.log for details.",
                    "Git Time-Lapse Error",
                    System.Windows.MessageBoxButton.OK,
                    System.Windows.MessageBoxImage.Error);
            }
        }

        private static int _nextWindowId = 0;

        /// <summary>
        /// Open the tool window. With a file path it opens File mode; with null
        /// (Tools menu, no selection) it shows a blank viewer. focusLine is
        /// 1-based; 0 means "no line focus".
        /// </summary>
        private void OpenViewer(string filePath, int focusLine = 0)
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            CreateToolWindow().OpenFile(filePath, focusLine);
        }

        /// <summary>Create and show a fresh (multi-instance) tool window.</summary>
        private TimeLapseToolWindow CreateToolWindow()
        {
            ThreadHelper.ThrowIfNotOnUIThread();
            int id = _nextWindowId++;
            GitTimeLapsePackage.Log($"CreateToolWindow: creating tool window id={id}...");

            var window = _package.FindToolWindow(typeof(TimeLapseToolWindow), id, true) as TimeLapseToolWindow;
            GitTimeLapsePackage.Log($"CreateToolWindow: window={window != null}, frame={window?.Frame != null}");
            if (window?.Frame == null)
            {
                throw new NotSupportedException("Cannot create the Git Time-Lapse tool window.");
            }

            var frame = (IVsWindowFrame)window.Frame;
            ErrorHandler.ThrowOnFailure(frame.Show());
            return window;
        }

        /// <summary>The file selected in Solution Explorer, if it is a real file.</summary>
        private string ResolveSelectedFile()
        {
            ThreadHelper.ThrowIfNotOnUIThread();

            string canonicalName = ResolveSelectedCanonicalName();
            if (!string.IsNullOrEmpty(canonicalName) && File.Exists(canonicalName))
            {
                return canonicalName;
            }
            return null;
        }

        /// <summary>
        /// The canonical name (path) of the current Solution Explorer selection,
        /// or null if there is no single-item selection. May name a file or a
        /// directory; callers check File.Exists / Directory.Exists as needed.
        /// </summary>
        private string ResolveSelectedCanonicalName()
        {
            ThreadHelper.ThrowIfNotOnUIThread();

            if (Package.GetGlobalService(typeof(SVsShellMonitorSelection)) is IVsMonitorSelection monitor)
            {
                IntPtr hierarchyPtr = IntPtr.Zero;
                IntPtr containerPtr = IntPtr.Zero;
                try
                {
                    int hr = monitor.GetCurrentSelection(
                        out hierarchyPtr, out uint itemId, out IVsMultiItemSelect _, out containerPtr);
                    if (hr != VSConstants.S_OK || hierarchyPtr == IntPtr.Zero)
                    {
                        return null;
                    }
                    if (itemId == VSConstants.VSITEMID_SELECTION ||
                        itemId == VSConstants.VSITEMID_NIL)
                    {
                        return null;
                    }
                    if (Marshal.GetObjectForIUnknown(hierarchyPtr) is IVsHierarchy hierarchy)
                    {
                        hierarchy.GetCanonicalName(itemId, out string canonicalName);
                        return canonicalName;
                    }
                    return null;
                }
                catch
                {
                    return null;
                }
                finally
                {
                    if (hierarchyPtr != IntPtr.Zero) Marshal.Release(hierarchyPtr);
                    if (containerPtr != IntPtr.Zero) Marshal.Release(containerPtr);
                }
            }
            return null;
        }

        /// <summary>
        /// The path of the active editor document, if any, along with the caret's
        /// line. EnvDTE's TextSelection.CurrentLine is already 1-based, matching
        /// the viewer's gutter numbering; focusLine is 0 when the document has no
        /// text selection (designer or other non-text document).
        /// </summary>
        private string ResolveActiveDocument(out int focusLine)
        {
            ThreadHelper.ThrowIfNotOnUIThread();

            focusLine = 0;
            if (Package.GetGlobalService(typeof(SDTE)) is EnvDTE.DTE dte)
            {
                try
                {
                    EnvDTE.Document doc = dte.ActiveDocument;
                    string path = doc?.FullName;
                    if (!string.IsNullOrEmpty(path) && File.Exists(path))
                    {
                        if (doc.Selection is EnvDTE.TextSelection selection)
                        {
                            int line = selection.CurrentLine;
                            if (line > 0)
                            {
                                focusLine = line;
                            }
                        }
                        return path;
                    }
                }
                catch
                {
                    // ActiveDocument throws when no document window has focus.
                    focusLine = 0;
                }
            }
            return null;
        }
    }
}
