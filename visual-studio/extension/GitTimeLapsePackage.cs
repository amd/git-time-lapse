// Copyright Advanced Micro Devices, Inc.
// SPDX-License-Identifier: MIT
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;
using Microsoft.VisualStudio.Shell;
using Microsoft.VisualStudio.Shell.Interop;
using Task = System.Threading.Tasks.Task;

namespace GitTimeLapse
{
    [PackageRegistration(UseManagedResourcesOnly = true, AllowsBackgroundLoading = true)]
    [Guid(PackageGuidString)]
    [ProvideMenuResource("Menus.ctmenu", 1)]
    [ProvideToolWindow(typeof(TimeLapseToolWindow), Style = VsDockStyle.Tabbed, MultiInstances = true)]
    [ProvideAutoLoad(UIContextGuids80.SolutionExists, PackageAutoLoadFlags.BackgroundLoad)]
    [ProvideAutoLoad(UIContextGuids80.NoSolution, PackageAutoLoadFlags.BackgroundLoad)]
    [ProvideBindingPath]
    public sealed class GitTimeLapsePackage : AsyncPackage
    {
        public const string PackageGuidString = "7C6E5D4B-3A2F-1E0D-9C8B-7A6F5E4D3C2B";

        private static readonly string LogFile = Path.Combine(
            Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
            "GitTimeLapse", "extension.log");

        internal static void Log(string message)
        {
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(LogFile));
                File.AppendAllText(LogFile, $"[{DateTime.Now:yyyy-MM-dd HH:mm:ss.fff}] {message}\n");
            }
            catch { }
        }

        protected override async Task InitializeAsync(
            CancellationToken cancellationToken,
            IProgress<ServiceProgressData> progress)
        {
            Log("InitializeAsync started");
            try
            {
                await base.InitializeAsync(cancellationToken, progress);
                Log("base.InitializeAsync completed");
                await OpenTimeLapseCommand.InitializeAsync(this);
                Log("OpenTimeLapseCommand.InitializeAsync completed");
            }
            catch (Exception ex)
            {
                Log($"InitializeAsync FAILED: {ex}");
                throw;
            }
        }
    }
}
