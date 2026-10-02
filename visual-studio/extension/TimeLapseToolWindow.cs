// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT
using System;
using System.IO;
using System.Runtime.InteropServices;
using Microsoft.VisualStudio.Shell;

namespace GitTimeLapse
{
    /// <summary>
    /// Tool window that hosts the WebView2-backed Git Time-Lapse UI.
    ///
    /// The actual UI is the WPF <see cref="TimeLapseToolWindowControl"/>; this
    /// pane just owns it and forwards the file-to-open request.
    /// </summary>
    [Guid("A1B2C3D4-E5F6-4708-9A0B-1C2D3E4F5A6B")]
    public sealed class TimeLapseToolWindow : ToolWindowPane
    {
        private TimeLapseToolWindowControl _control;

        public TimeLapseToolWindow() : base(null)
        {
            GitTimeLapsePackage.Log("TimeLapseToolWindow constructor");
            Caption = "Git Time-Lapse View";
            _control = new TimeLapseToolWindowControl();
            _control.CloseRequested += () =>
            {
                GitTimeLapsePackage.Log("CloseRequested — hiding tool window");
                if (Frame is Microsoft.VisualStudio.Shell.Interop.IVsWindowFrame frame)
                {
                    frame.Hide();
                }
            };
            _control.TitleChanged += (title) =>
            {
                Caption = title;
            };
            Content = _control;
            GitTimeLapsePackage.Log("TimeLapseToolWindow constructor - control set as Content");
        }

        public void OpenFile(string filePath, int focusLine = 0)
        {
            GitTimeLapsePackage.Log($"TimeLapseToolWindow.OpenFile: {filePath ?? "(blank)"}, line: {focusLine}");
            Caption = string.IsNullOrEmpty(filePath)
                ? "Git Time-Lapse View"
                : "Time-Lapse: " + Path.GetFileName(filePath);
            try
            {
                _control.OpenFile(filePath, focusLine);
            }
            catch (Exception ex)
            {
                GitTimeLapsePackage.Log($"TimeLapseToolWindow.OpenFile FAILED: {ex}");
            }
        }
    }
}
