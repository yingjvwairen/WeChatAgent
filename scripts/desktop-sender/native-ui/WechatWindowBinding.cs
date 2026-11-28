using System;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

// A window is bound to the process instance that created it, even if Windows reuses its handle.
internal sealed class WindowIdentity
{
    internal readonly IntPtr Window;
    internal readonly uint Pid;
    internal readonly long Created;

    internal WindowIdentity(IntPtr window, uint pid, long created)
    {
        Window = window;
        Pid = pid;
        Created = created;
    }

    internal static bool Same(WindowIdentity a, WindowIdentity b)
    {
        return a != null && b != null && a.Window == b.Window && a.Pid == b.Pid && a.Created == b.Created;
    }
    internal object Report()
    {
        return new System.Collections.Generic.Dictionary<string, object> {
            { "hwnd", Window.ToInt64().ToString(CultureInfo.InvariantCulture) },
            { "pid", Pid },
            { "processCreatedFileTimeUtc", Created.ToString(CultureInfo.InvariantCulture) }
        };
    }
}

internal static partial class WechatDraftProbe
{
    [StructLayout(LayoutKind.Sequential)]
    struct Point
    {
        internal int X, Y;
        internal Point(int x, int y)
        {
            X = x;
            Y = y;
        }
    }
    [StructLayout(LayoutKind.Sequential)]
    struct Rect
    {
        internal int Left, Top, Right, Bottom;
        internal Rect(int left, int top, int right, int bottom)
        {
            Left = left;
            Top = top;
            Right = right;
            Bottom = bottom;
        }
        internal int Width
        {
            get {
                return Right - Left;
            }
        }
        internal int Height
        {
            get {
                return Bottom - Top;
            }
        }
        internal object Report()
        {
            return Data("left", Left, "top", Top, "right", Right, "bottom", Bottom);
        }
    }
    [StructLayout(LayoutKind.Sequential)]
    struct GuiInfo
    {
        internal uint Size, Flags;
        internal IntPtr Active, Focus, Capture, MenuOwner, MoveSize, Caret;
        internal Rect CaretRect;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct FileTime
    {
        internal uint Low, High;
        internal long Value
        {
            get {
                return ((long)High << 32) | Low;
            }
        }
    }
    [StructLayout(LayoutKind.Sequential)]
    struct LastInput
    {
        internal uint Size, Time;
    }
    sealed class Binding
    {
        internal IntPtr Window, Focus, Caret;
        internal uint Pid, Thread, Dpi, InputTick, GuiFlags;
        internal long Created;
        internal Rect Client, Capture, CaretInClient;
        internal bool FocusOwned, CaretOwned;
        internal WindowIdentity Identity
        {
            get {
                return new WindowIdentity(Window, Pid, Created);
            }
        }
        internal object Report()
        {
            return Data("hwnd", Window.ToInt64().ToString(CultureInfo.InvariantCulture), "pid", Pid, "threadId", Thread,
                        "processCreatedFileTimeUtc", Created.ToString(CultureInfo.InvariantCulture), "dpi", Dpi,
                        "clientRect", Client.Report(), "captureRect", Capture.Report(), "foreground", true, "focusHwnd",
                        Focus.ToInt64().ToString(CultureInfo.InvariantCulture), "focusBelongsToWindow", FocusOwned,
                        "caretHwnd", Caret.ToInt64().ToString(CultureInfo.InvariantCulture), "caretBelongsToWindow",
                        CaretOwned, "caretRectInClient", CaretInClient.Report(), "lastInputTick", InputTick, "guiFlags",
                        GuiFlags, "observedAtMs", UtcMs());
        }
    }
    static bool Same(Rect a, Rect b)
    {
        return a.Left == b.Left && a.Top == b.Top && a.Right == b.Right && a.Bottom == b.Bottom;
    }
    static bool Contains(Rect outer, Rect inner)
    {
        return inner.Left >= outer.Left && inner.Top >= outer.Top && inner.Right <= outer.Right &&
               inner.Bottom <= outer.Bottom;
    }
    static string ObjectName(IntPtr handle)
    {
        uint required;
        var text = new StringBuilder(128);
        Need(handle != IntPtr.Zero && GetUserObjectInformation(handle, 2, text, 256, out required),
             "DRAFT_DESKTOP_UNAVAILABLE");
        return text.ToString();
    }
    static void Desktop()
    {
        Need(String.Equals(ObjectName(GetProcessWindowStation()), "WinSta0", StringComparison.OrdinalIgnoreCase),
             "DRAFT_DESKTOP_UNAVAILABLE");
        IntPtr input = OpenInputDesktop(0, false, 1);
        Need(input != IntPtr.Zero, "DRAFT_DESKTOP_UNAVAILABLE");
        try
        {
            string name = ObjectName(input);
            Need(String.Equals(name, "Default", StringComparison.OrdinalIgnoreCase) &&
                     String.Equals(name, ObjectName(GetThreadDesktop(GetCurrentThreadId())),
                                   StringComparison.OrdinalIgnoreCase),
                 "DRAFT_DESKTOP_UNAVAILABLE");
        }
        finally
        {
            CloseDesktop(input);
        }
    }
    static bool Owned(IntPtr child, IntPtr root, uint pid)
    {
        uint actual;
        return child != IntPtr.Zero && GetWindowThreadProcessId(child, out actual) != 0 && actual == pid &&
               GetAncestor(child, 2) == root;
    }
    static Binding Snapshot(IntPtr window, string executable)
    {
        Desktop();
        Need(IsWindow(window) && IsWindowVisible(window) && !IsIconic(window) && GetAncestor(window, 2) == window &&
                 GetForegroundWindow() == window,
             "DRAFT_WINDOW_NOT_FOREGROUND");
        int cloaked;
        Need(DwmGetWindowAttribute(window, 14, out cloaked, 4) >= 0 && cloaked == 0, "DRAFT_WINDOW_NOT_VISIBLE");
        Need(GetLastActivePopup(window) == window, "DRAFT_WINDOW_POPUP_ACTIVE");
        uint pid;
        uint thread = GetWindowThreadProcessId(window, out pid);
        Need(thread != 0, "DRAFT_PROCESS_UNAVAILABLE");
        uint session, ownSession;
        Need(ProcessIdToSessionId(pid, out session) && ProcessIdToSessionId(GetCurrentProcessId(), out ownSession) &&
                 session == ownSession,
             "DRAFT_SESSION_MISMATCH");
        IntPtr process = OpenProcess(0x1000, false, pid);
        Need(process != IntPtr.Zero, "DRAFT_PROCESS_UNAVAILABLE");
        long created;
        try
        {
            var file = new StringBuilder(32768);
            int length = file.Capacity;
            FileTime start = new FileTime(), exit, kernel, user;
            Need(QueryFullProcessImageName(process, 0, file, ref length) &&
                     GetProcessTimes(process, out start, out exit, out kernel, out user),
                 "DRAFT_PROCESS_UNAVAILABLE");
            Need(String.Equals(Path.GetFullPath(file.ToString()), executable, StringComparison.OrdinalIgnoreCase),
                 "DRAFT_EXECUTABLE_MISMATCH");
            created = start.Value;
        }
        finally
        {
            CloseHandle(process);
        }
        Rect client;
        Need(GetClientRect(window, out client) && client.Width > 0 && client.Height > 0, "DRAFT_GEOMETRY_UNAVAILABLE");
        Point origin = new Point(0, 0);
        Need(ClientToScreen(window, ref origin), "DRAFT_GEOMETRY_UNAVAILABLE");
        var gui = new GuiInfo { Size = (uint)Marshal.SizeOf(typeof(GuiInfo)) };
        Need(GetGUIThreadInfo(thread, ref gui), "DRAFT_FOCUS_UNAVAILABLE");
        bool caretOwned = Owned(gui.Caret, window, pid);
        Rect caret = gui.CaretRect;
        if (caretOwned)
        {
            Point p = new Point(caret.Left, caret.Top);
            Need(ClientToScreen(gui.Caret, ref p), "DRAFT_CARET_UNAVAILABLE");
            caret =
                new Rect(p.X - origin.X, p.Y - origin.Y, p.X - origin.X + caret.Width, p.Y - origin.Y + caret.Height);
        }
        var last = new LastInput { Size = (uint)Marshal.SizeOf(typeof(LastInput)) };
        Need(GetLastInputInfo(ref last), "DRAFT_ACTIVITY_MONITOR_UNAVAILABLE");
        Need(GetForegroundWindow() == window, "DRAFT_WINDOW_NOT_FOREGROUND");
        return new Binding { Window = window,
                             Pid = pid,
                             Thread = thread,
                             Created = created,
                             Dpi = GetDpiForWindow(window),
                             Client = client,
                             Capture = new Rect(origin.X, origin.Y, origin.X + client.Width, origin.Y + client.Height),
                             Focus = gui.Focus,
                             FocusOwned = Owned(gui.Focus, window, pid),
                             Caret = gui.Caret,
                             CaretOwned = caretOwned,
                             CaretInClient = caret,
                             InputTick = last.Time,
                             GuiFlags = gui.Flags };
    }
}
