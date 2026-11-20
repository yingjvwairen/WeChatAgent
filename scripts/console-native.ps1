param([ValidateSet('exe','folder','workspace','protect','unprotect')][string]$Kind)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
if ($Kind -eq 'protect' -or $Kind -eq 'unprotect') {
    Add-Type -AssemblyName System.Security
    $secret = [Console]::In.ReadToEnd()
    if ($Kind -eq 'unprotect') {
        if (-not $secret.StartsWith('userdpapi:')) { throw 'Invalid protected credential' }
        $bytes = [Convert]::FromBase64String($secret.Substring(10))
        $clear = [Security.Cryptography.ProtectedData]::Unprotect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
        [Console]::Write([Text.Encoding]::UTF8.GetString($clear))
        exit 0
    }
    $bytes = [Text.Encoding]::UTF8.GetBytes($secret)
    $protected = [Security.Cryptography.ProtectedData]::Protect($bytes, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)
    [Console]::Write('userdpapi:' + [Convert]::ToBase64String($protected))
    exit 0
}
Add-Type -AssemblyName System.Windows.Forms
Add-Type -ReferencedAssemblies System.Windows.Forms,System.Drawing -TypeDefinition @'
using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public sealed class ConsolePickerOwner : Form {
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    delegate bool WindowCallback(IntPtr window, IntPtr parameter);
    [DllImport("user32.dll")] static extern bool EnumThreadWindows(uint thread, WindowCallback callback, IntPtr parameter);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr window, uint relationship);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
    sealed class WindowOwner : IWin32Window {
        readonly IntPtr handle;
        public WindowOwner(IntPtr value) { handle = value; }
        public IntPtr Handle { get { return handle; } }
    }
    readonly IntPtr caller;
    readonly Timer firstShow;
    int checks;
    public ConsolePickerOwner() {
        caller = GetForegroundWindow();
        ShowInTaskbar = false;
        FormBorderStyle = FormBorderStyle.None;
        StartPosition = FormStartPosition.Manual;
        Opacity = 0;
        Size = new Size(1, 1);
        Rectangle area = Screen.FromHandle(caller).WorkingArea;
        Location = new Point(area.Left + area.Width / 2, area.Top + area.Height / 2);
        // A browser request starts a hidden helper with no active WinForms
        // window. Give its native modal a visible owner and one initial raise.
        // Drop topmost as soon as the modal pumps messages; never keep stealing
        // focus after the operator switches to another application.
        TopMost = true;
        firstShow = new Timer { Interval = 50 };
        firstShow.Tick += delegate {
            // Shell folder trees can initialize after the first timer tick.
            // Observe only this helper thread's directly owned modal window.
            IntPtr popup = IntPtr.Zero;
            EnumThreadWindows(GetCurrentThreadId(), delegate(IntPtr window, IntPtr unused) {
                if (IsWindowVisible(window) && GetWindow(window, 4) == Handle) popup = window;
                return true;
            }, IntPtr.Zero);
            IntPtr foreground = GetForegroundWindow();
            bool switchedAway = foreground != caller && foreground != Handle && foreground != popup;
            if (popup == IntPtr.Zero && !switchedAway && ++checks < 40) return;
            firstShow.Stop();
            TopMost = false;
            if (!switchedAway && popup != IntPtr.Zero && IsWindow(popup))
                SetForegroundWindow(popup);
        };
    }
    public void ShowForPicker() {
        if (caller != IntPtr.Zero && IsWindow(caller)) Show(new WindowOwner(caller));
        else Show();
        Activate();
        firstShow.Start();
    }
    protected override void Dispose(bool disposing) {
        if (disposing) firstShow.Dispose();
        base.Dispose(disposing);
    }
}
'@
$owner = [ConsolePickerOwner]::new()
if ($Kind -in @('folder','workspace')) {
    $dialog = [Windows.Forms.FolderBrowserDialog]::new()
    $dialog.Description = if ($Kind -eq 'workspace') { '选择工作区目录' } else { '选择文件夹' }
    $dialog.ShowNewFolderButton = $false
} else {
    $dialog = [Windows.Forms.OpenFileDialog]::new()
    $dialog.Title = '选择程序'
    $dialog.Filter = 'Programs (*.exe)|*.exe|All files (*.*)|*.*'
    $dialog.CheckFileExists = $true
}
try {
    $owner.ShowForPicker()
    if ($dialog.ShowDialog($owner) -eq [Windows.Forms.DialogResult]::OK) {
        [Console]::Write($(if ($Kind -in @('folder','workspace')) { $dialog.SelectedPath } else { $dialog.FileName }))
    }
} finally {
    $dialog.Dispose()
    $owner.Dispose()
}
