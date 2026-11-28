// Navigation only: standard UIA and messages to this bound process's windows.
// The main sender remains responsible for source selection, quote tokens and receipts.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows.Automation;

internal static partial class WechatQuoteHistory
{
    [DllImport("user32.dll")]
    static extern bool EnumWindows(EnumWindow callback, IntPtr parameter);
    delegate bool EnumWindow(IntPtr window, IntPtr parameter);
    [DllImport("user32.dll")]
    static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")]
    static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")]
    static extern IntPtr GetWindow(IntPtr window, uint command);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int GetClassName(IntPtr window, StringBuilder value, int capacity);
    [DllImport("user32.dll")]
    static extern bool PostMessage(IntPtr window, uint message, IntPtr first, IntPtr second);
    [DllImport("user32.dll")]
    static extern IntPtr WindowFromPoint(POINT point);
    [DllImport("user32.dll")]
    static extern IntPtr GetAncestor(IntPtr window, uint flags);
    [DllImport("user32.dll")]
    static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")]
    static extern bool AttachThreadInput(uint first, uint second, bool attach);
    [DllImport("kernel32.dll")]
    static extern uint GetCurrentThreadId();
    static volatile bool NavigationCancelled;
    static void StartCancellationWatch()
    {
        new Thread(delegate() {
            try
            {
                Console.OpenStandardInput().ReadByte();
            }
            catch
            {
            }
            NavigationCancelled = true;
        }) { IsBackground = true }
            .Start();
    }
    static string WindowClass(IntPtr window)
    {
        var name = new StringBuilder(256);
        Need(GetClassName(window, name, name.Capacity) > 0, "QUOTE_UIA_WINDOW_CHANGED");
        return name.ToString();
    }
    static Dictionary<string, object> Map(object value)
    {
        return value as Dictionary<string, object>;
    }
    static System.Windows.Rect Area(object value)
    {
        var row = Map(value);
        Need(row != null, "QUOTE_UIA_BOUNDS_INVALID");
        double l = Convert.ToDouble(row["left"]), t = Convert.ToDouble(row["top"]), r = Convert.ToDouble(row["right"]),
               b = Convert.ToDouble(row["bottom"]);
        Need(!Double.IsNaN(l + t + r + b) && !Double.IsInfinity(l + t + r + b) && r > l && b > t && r - l <= 4096 &&
                 b - t <= 4096,
             "QUOTE_UIA_BOUNDS_INVALID");
        return new System.Windows.Rect(l, t, r - l, b - t);
    }
    static string FileHash(string file)
    {
        using (var sha = SHA256.Create()) using (var stream = File.OpenRead(file)) return BitConverter
            .ToString(sha.ComputeHash(stream))
            .Replace("-", "")
            .ToLowerInvariant();
    }
    static bool SearchQueryValid(string value)
    {
        return !String.IsNullOrWhiteSpace(value) && value.Length <= 4000 && value.IndexOf('\0') < 0 &&
               value.IndexOf('\r') < 0 && value.IndexOf('\n') < 0;
    }
    static bool SameWindow(Binding value)
    {
        uint pid;
        return value != null && IsWindow(value.Window) && GetWindowThreadProcessId(value.Window, out pid) != 0 &&
               pid == value.Pid && Created(pid) == value.ProcessCreated &&
               Runtime(AutomationElement.FromHandle(value.Window)) == value.RootId;
    }
    static void QueueMouseClick(Action guard, Func<uint, bool> post, uint down, uint up, bool hover, ref bool attempted)
    {
        if (hover)
        {
            guard();
            attempted = true;
            Need(post(0x200), "QUOTE_UIA_NAVIGATION_UNKNOWN");
        }
        guard();
        attempted = true;
        bool pressed = false;
        try
        {
            pressed = post(down);
            Need(pressed, "QUOTE_UIA_NAVIGATION_UNKNOWN");
        }
        finally
        {
            // Once Down is queued, only release that same button. This is not
            // a new selection attempt and must also run after cancellation.
            if (pressed)
                Need(post(up), "QUOTE_UIA_NAVIGATION_UNKNOWN");
        }
    }

    sealed class HistoryNavigation
    {
        internal Binding Main, History;
        internal uint ThreadId;
        internal bool Attempted, CreatedHistory, CleanupConfirmed = true, Found;
        internal string Phase = "entry", Query, PointMethod;
        internal string VisualProbe, TemporaryDirectory;
        internal HashSet<IntPtr> Before;
        internal long Deadline;
        internal int ResultCount;
        internal Dictionary<string, object> Request(Binding window)
        {
            return D("hwnd", window.Window.ToInt64().ToString(), "pid", window.Pid, "created", window.ProcessCreated,
                     "lastInputTick", Main.Tick, "text", Query);
        }
        internal void Activity()
        {
            Need(!NavigationCancelled, "QUOTE_UIA_CANCELLED");
            Need(InputTick() == Main.Tick, "QUOTE_UIA_INPUT_CHANGED");
            Need(SameWindow(Main), "QUOTE_UIA_WINDOW_CHANGED");
            RECT r;
            Need(GetWindowRect(Main.Window, out r) && Same(r, Main.WindowRect), "QUOTE_UIA_WINDOW_CHANGED");
            Need(Stopwatch.GetTimestamp() < Deadline, "QUOTE_UIA_HISTORY_TIMEOUT");
        }
        internal void Active(Binding window)
        {
            Activity();
            Need(SameWindow(window) && GetForegroundWindow() == window.Window, "QUOTE_UIA_FOREGROUND_CHANGED");
            Need(!NavigationCancelled && InputTick() == Main.Tick, "QUOTE_UIA_INPUT_CHANGED");
        }
        internal void MenuActive(Binding menu)
        {
            Activity();
            Need(SameWindow(History) && SameWindow(menu) && GetWindow(menu.Window, 4) == History.Window,
                 "QUOTE_UIA_HISTORY_CHANGED");
            IntPtr foreground = GetForegroundWindow();
            Need(foreground == History.Window || foreground == menu.Window, "QUOTE_UIA_FOREGROUND_CHANGED");
            Need(!NavigationCancelled && InputTick() == Main.Tick, "QUOTE_UIA_INPUT_CHANGED");
        }
        internal List<IntPtr> Windows(bool menu)
        {
            var result = new List<IntPtr>();
            EnumWindows(delegate(IntPtr window, IntPtr unused) {
                uint pid;
                uint thread = GetWindowThreadProcessId(window, out pid);
                if (window == Main.Window || !IsWindowVisible(window) || pid != Main.Pid || thread != ThreadId)
                    return true;
                try
                {
                    if (menu)
                    {
                        if (History != null && GetWindow(window, 4) == History.Window &&
                            WindowClass(window) == "Qt51514QWindowToolSaveBits")
                            result.Add(window);
                    }
                    else
                    {
                        var element = AutomationElement.FromHandle(window);
                        if (element != null && element.Current.ClassName == "mmui::SearchMsgUniqueChatWindow")
                            result.Add(window);
                    }
                }
                catch
                {
                }
                return true;
            }, IntPtr.Zero);
            return result;
        }
        internal T Wait<T>(Func<T> observe, Func<T, bool> accepted, int milliseconds, string code)
        {
            long until = Stopwatch.GetTimestamp() + milliseconds * Stopwatch.Frequency / 1000;
            for (;;)
            {
                Activity();
                T value = observe();
                Activity();
                if (accepted(value))
                    return value;
                Need(Stopwatch.GetTimestamp() < until, code);
                Thread.Sleep(15);
            }
        }
        internal void Click(Binding window, System.Windows.Rect rectangle, bool right)
        {
            Active(window);
            var point = new POINT { X = (int)Math.Round(rectangle.Left + rectangle.Width / 2),
                                    Y = (int)Math.Round(rectangle.Top + rectangle.Height / 2) };
            IntPtr hit = GetAncestor(WindowFromPoint(point), 2);
            Need(hit == window.Window, "QUOTE_UIA_SOURCE_OBSCURED");
            POINT origin = new POINT();
            RECT client = new RECT();
            Need(ClientToScreen(window.Window, ref origin) && GetClientRect(window.Window, out client),
                 "QUOTE_UIA_WINDOW_CHANGED");
            int x = point.X - origin.X, y = point.Y - origin.Y;
            Need(x >= 0 && y >= 0 && x < client.Right && y < client.Bottom, "QUOTE_UIA_BOUNDS_INVALID");
            var packed = new IntPtr((y << 16) | (x & 65535));
            uint down = right ? 0x204U : 0x201U, up = right ? 0x205U : 0x202U;
            QueueMouseClick(
                delegate {
                    Active(window);
                    Need(GetAncestor(WindowFromPoint(point), 2) == window.Window, "QUOTE_UIA_SOURCE_OBSCURED");
                },
                delegate(uint message) {
                    return PostMessage(window.Window, message,
                                       message == down ? new IntPtr(right ? 2 : 1) : IntPtr.Zero, packed);
                },
                down, up, true, ref Attempted);
        }
        internal bool Open()
        {
            Active(Main);
            var entry = Map(HistoryEntry(Request(Main)));
            if (entry["entry"] == null)
                return false;
            var area = Area(Map(entry["entry"])["rect"]);
            Before = new HashSet<IntPtr>(Windows(false));
            Click(Main, area, false);
            IntPtr window = Wait(
                delegate {
                    var foreground = GetForegroundWindow();
                    return Windows(false).Contains(foreground) ? foreground : IntPtr.Zero;
                },
                delegate(IntPtr value) { return value != IntPtr.Zero; }, 1200, "QUOTE_UIA_HISTORY_NOT_READY");
            History = new Binding(D("hwnd", window.ToInt64().ToString(), "pid", Main.Pid), false);
            CreatedHistory = !Before.Contains(window);
            Active(History);
            return true;
        }
        internal System.Windows.Rect ResultText(Dictionary<string, object> result)
        {
            var bounds = Area(result["rect"]);
            object textRect;
            if (result.TryGetValue("textRect", out textRect) && textRect != null)
            {
                var glyph = Area(textRect);
                Need(bounds.Contains(glyph), "QUOTE_UIA_HISTORY_RESULT_TEXT_UNAVAILABLE");
                PointMethod = "text-pattern";
                return glyph;
            }
            PointMethod = "row-ocr";
            Active(History);
            int left = (int)Math.Floor(bounds.Left), top = (int)Math.Floor(bounds.Top),
                width = (int)Math.Ceiling(bounds.Right) - left, height = (int)Math.Ceiling(bounds.Bottom) - top;
            Need(width > 0 && height > 0 && width <= 4096 && height <= 2048, "QUOTE_UIA_BOUNDS_INVALID");
            var filename = Path.Combine(TemporaryDirectory, "history-" + Guid.NewGuid().ToString("N") + ".png");
            try
            {
                using (var bitmap = new Bitmap(width, height, PixelFormat.Format32bppArgb))
                {
                    using (var graphics = Graphics.FromImage(bitmap))
                        graphics.CopyFromScreen(left, top, 0, 0, new Size(width, height));
                    bitmap.Save(filename, ImageFormat.Png);
                }
                Active(History);
                var info = new ProcessStartInfo { FileName = VisualProbe,
                                                  Arguments = "--image \"" + filename + "\" --language " +
                                                              (IsAscii(Query) ? "en-US" : "zh-Hans-CN"),
                                                  UseShellExecute = false,
                                                  CreateNoWindow = true,
                                                  RedirectStandardOutput = true,
                                                  RedirectStandardError = true };
                string output;
                using (var child = Process.Start(info))
                {
                    var pending = child.StandardOutput.ReadToEndAsync();
                    var errors = child.StandardError.ReadToEndAsync();
                    long until = Stopwatch.GetTimestamp() + 5000 * Stopwatch.Frequency / 1000;
                    try
                    {
                        while (!child.WaitForExit(25))
                        {
                            Activity();
                            Need(Stopwatch.GetTimestamp() < until, "QUOTE_UIA_HISTORY_OCR_TIMEOUT");
                        }
                        output = pending.GetAwaiter().GetResult();
                        Need(child.ExitCode == 0 && output.Length <= 1024 * 1024 &&
                                 errors.GetAwaiter().GetResult().Length <= 65536,
                             "QUOTE_UIA_HISTORY_OCR_FAILED");
                    }
                    catch
                    {
                        try
                        {
                            if (!child.HasExited)
                                child.Kill();
                            child.WaitForExit(1000);
                        }
                        catch
                        {
                        }
                        throw;
                    }
                }
                Active(History);
                var reply = Json.Deserialize<Dictionary<string, object>>(output);
                Need(Object.Equals(reply["ok"], true) && Object.Equals(reply["readOnly"], true) &&
                         Object.Equals(reply["inputSent"], false) && Text(reply, "imageSha256") == FileHash(filename),
                     "QUOTE_UIA_HISTORY_OCR_FAILED");
                var words = reply["words"] as IList;
                Need(words != null && words.Count <= 4096, "QUOTE_UIA_HISTORY_OCR_FAILED");
                var lines = new Dictionary<int, List<Dictionary<string, object>>>();
                foreach (var value in words)
                {
                    var word = Map(value);
                    int line = Convert.ToInt32(word["line"]);
                    if (!lines.ContainsKey(line))
                        lines[line] = new List<Dictionary<string, object>>();
                    lines[line].Add(word);
                }
                System.Windows.Rect found = System.Windows.Rect.Empty;
                int matches = 0;
                foreach (var line in lines.Values)
                {
                    line.Sort(delegate(Dictionary<string, object> a, Dictionary<string, object> b) {
                        return Convert.ToDouble(a["x"]).CompareTo(Convert.ToDouble(b["x"]));
                    });
                    var joined = new StringBuilder();
                    var spaced = new StringBuilder();
                    System.Windows.Rect box = System.Windows.Rect.Empty;
                    foreach (var word in line)
                    {
                        joined.Append(Text(word, "text"));
                        if (spaced.Length > 0)
                            spaced.Append(' ');
                        spaced.Append(Text(word, "text"));
                        var area =
                            new System.Windows.Rect(Convert.ToDouble(word["x"]), Convert.ToDouble(word["y"]),
                                                    Convert.ToDouble(word["width"]), Convert.ToDouble(word["height"]));
                        box.Union(area);
                    }
                    if (joined.ToString() != Query && spaced.ToString() != Query)
                        continue;
                    Need(box.Left >= 0 && box.Top >= 0 && box.Right <= width && box.Bottom <= height,
                         "QUOTE_UIA_HISTORY_OCR_FAILED");
                    matches++;
                    found = new System.Windows.Rect(left + box.Left, top + box.Top, box.Width, box.Height);
                }
                Need(matches == 1, "QUOTE_UIA_HISTORY_RESULT_TEXT_UNAVAILABLE");
                return found;
            }
            finally
            {
                try
                {
                    File.Delete(filename);
                }
                catch
                {
                }
            }
        }
        internal void Search()
        {
            Phase = "query";
            var layout = Map(HistoryLayout(Request(History)));
            var request = Request(History);
            request["searchRuntime"] = Map(layout["search"])["runtimeSha256"];
            var accepted = Map(SearchHistory(request));
            Attempted = Attempted || Object.Equals(accepted["navigationAttempted"], true);
            Need(Object.Equals(accepted["ok"], true) && Object.Equals(accepted["queryAccepted"], true),
                 "QUOTE_UIA_HISTORY_QUERY_UNCONFIRMED");
            Phase = "results";
            Dictionary<string, object> item = Wait(
                delegate {
                    Active(History);
                    var result = Map(HistoryResults(Request(History)));
                    var matches = result["matches"] as List<object>;
                    Need(matches != null, "QUOTE_UIA_HISTORY_RESULT_INVALID");
                    ResultCount = matches.Count;
                    Need(matches.Count <= 1, "QUOTE_UIA_HISTORY_RESULTS_AMBIGUOUS");
                    return Object.Equals(result["queryMatches"], true) && matches.Count == 1 ? Map(matches[0]) : null;
                },
                delegate(Dictionary<string, object> value) { return value != null; }, 2000,
                "QUOTE_UIA_HISTORY_NO_RESULT");
            var text = ResultText(item);
            Active(History);
            var fresh = Map(HistoryResults(Request(History)));
            var freshRows = fresh["matches"] as List<object>;
            Need(Object.Equals(fresh["queryMatches"], true) && freshRows != null && freshRows.Count == 1 &&
                     Text(Map(freshRows[0]), "runtimeSha256") == Text(item, "runtimeSha256") &&
                     Area(Map(freshRows[0])["rect"]).Contains(text),
                 "QUOTE_UIA_HISTORY_CHANGED");
            Phase = "result-menu";
            Click(History, text, true);
            IntPtr popup = Wait(
                delegate {
                    var windows = Windows(true);
                    Need(windows.Count <= 1, "QUOTE_UIA_HISTORY_MENU_AMBIGUOUS");
                    return windows.Count == 1 ? windows[0] : IntPtr.Zero;
                },
                delegate(IntPtr value) { return value != IntPtr.Zero; }, 800, "QUOTE_UIA_HISTORY_MENU_UNAVAILABLE");
            var menu = new Binding(D("hwnd", popup.ToInt64().ToString(), "pid", Main.Pid), false);
            AutomationElement entry = null;
            foreach (var node in Walk(menu.Root, 96, 400).Nodes)
            {
                var value = node.Current;
                if (value.ProcessId == Main.Pid && !value.IsOffscreen && value.IsEnabled &&
                    value.ControlType == ControlType.MenuItem &&
                    (value.Name == "定位到聊天位置" || value.Name == "Locate in Chat" ||
                     value.Name == "Locate in chat"))
                {
                    Need(entry == null, "QUOTE_UIA_HISTORY_MENU_AMBIGUOUS");
                    entry = node;
                }
            }
            Need(entry != null, "QUOTE_UIA_HISTORY_LOCATE_UNAVAILABLE");
            Phase = "locate";
            // Qt's menu may leave foreground on the history owner. The menu is
            // nevertheless the exact same-thread popup of this history window.
            Activity();
            Need(GetForegroundWindow() == History.Window || GetForegroundWindow() == menu.Window,
                 "QUOTE_UIA_FOREGROUND_CHANGED");
            Need(GetWindow(menu.Window, 4) == History.Window && SameWindow(menu), "QUOTE_UIA_HISTORY_CHANGED");
            var area = entry.Current.BoundingRectangle;
            POINT origin = new POINT();
            Need(ClientToScreen(menu.Window, ref origin) && !area.IsEmpty, "QUOTE_UIA_BOUNDS_INVALID");
            int x = (int)(area.Left + area.Width / 2) - origin.X, y = (int)(area.Top + area.Height / 2) - origin.Y;
            RECT client;
            Need(GetClientRect(menu.Window, out client) && x >= 0 && y >= 0 && x < client.Right && y < client.Bottom,
                 "QUOTE_UIA_BOUNDS_INVALID");
            var point = new POINT { X = x + origin.X, Y = y + origin.Y };
            var packed = new IntPtr((y << 16) | (x & 65535));
            QueueMouseClick(
                delegate {
                    MenuActive(menu);
                    Need(GetAncestor(WindowFromPoint(point), 2) == menu.Window, "QUOTE_UIA_SOURCE_OBSCURED");
                },
                delegate(uint message) {
                    return PostMessage(menu.Window, message, message == 0x201 ? new IntPtr(1) : IntPtr.Zero, packed);
                },
                0x201, 0x202, false, ref Attempted);
            Wait(delegate { return GetForegroundWindow() == Main.Window; }, delegate(bool value) { return value; },
                 1200, "QUOTE_UIA_HISTORY_MAIN_NOT_RETURNED");
            Active(Main);
            Found = true;
        }
        internal void Cleanup()
        {
            // Never use an unbound Escape: on Qt it can hide the main window.
            if (History == null && !Attempted)
                return;
            Need(InputTick() == Main.Tick && SameWindow(Main), "QUOTE_UIA_HISTORY_CLEANUP_UNCONFIRMED");
            if (History == null)
            {
                // Opening can succeed even when the foreground wait fails.
                // Reconcile the owned window before claiming cleanup success.
                var created = new List<IntPtr>();
                foreach (var window in Windows(false))
                    if (Before != null && !Before.Contains(window))
                        created.Add(window);
                Need(created.Count <= 1, "QUOTE_UIA_HISTORY_CLEANUP_UNCONFIRMED");
                if (created.Count == 1)
                {
                    History = new Binding(D("hwnd", created[0].ToInt64().ToString(), "pid", Main.Pid), false);
                    CreatedHistory = true;
                }
                else
                {
                    Need(GetForegroundWindow() == Main.Window, "QUOTE_UIA_HISTORY_CLEANUP_UNCONFIRMED");
                    return;
                }
            }
            if (CreatedHistory && IsWindow(History.Window) && IsWindowVisible(History.Window))
            {
                Need(SameWindow(History) && History.Root.Current.ClassName == "mmui::SearchMsgUniqueChatWindow",
                     "QUOTE_UIA_HISTORY_CLEANUP_UNCONFIRMED");
                Need(SameWindow(Main) &&
                         (GetForegroundWindow() == Main.Window || GetForegroundWindow() == History.Window) &&
                         InputTick() == Main.Tick,
                     "QUOTE_UIA_HISTORY_CLEANUP_UNCONFIRMED");
                Need(PostMessage(History.Window, 0x10, IntPtr.Zero, IntPtr.Zero),
                     "QUOTE_UIA_HISTORY_CLEANUP_UNCONFIRMED");
                long until = Stopwatch.GetTimestamp() + 1000 * Stopwatch.Frequency / 1000;
                while (IsWindowVisible(History.Window) && Stopwatch.GetTimestamp() < until)
                    Thread.Sleep(15);
                Need(!IsWindowVisible(History.Window), "QUOTE_UIA_HISTORY_CLEANUP_UNCONFIRMED");
            }
            if (GetForegroundWindow() == History.Window)
            {
                bool attached = false;
                uint own = GetCurrentThreadId();
                try
                {
                    if (!SetForegroundWindow(Main.Window) && own != ThreadId)
                    {
                        attached = AttachThreadInput(own, ThreadId, true);
                        Need(attached && InputTick() == Main.Tick && GetForegroundWindow() == History.Window,
                             "QUOTE_UIA_HISTORY_CLEANUP_UNCONFIRMED");
                        SetForegroundWindow(Main.Window);
                    }
                }
                finally
                {
                    if (attached)
                        Need(AttachThreadInput(own, ThreadId, false), "QUOTE_UIA_HISTORY_CLEANUP_UNCONFIRMED");
                }
                long until = Stopwatch.GetTimestamp() + 500 * Stopwatch.Frequency / 1000;
                while (GetForegroundWindow() != Main.Window && Stopwatch.GetTimestamp() < until)
                    Thread.Sleep(10);
            }
            Need(GetForegroundWindow() == Main.Window && IsWindowVisible(Main.Window),
                 "QUOTE_UIA_HISTORY_CLEANUP_UNCONFIRMED");
        }
    }
    static bool IsAscii(string value)
    {
        foreach (char c in value)
            if (c > 127)
                return false;
        return true;
    }
    static object NavigateHistory(Dictionary<string, object> request)
    {
        HistoryNavigation navigation = null;
        string error = null;
        try
        {
            Need(SearchQueryValid(Text(request, "text")), "QUOTE_UIA_QUERY_UNAVAILABLE");
            string executable = Text(request, "executable"), expected = Text(request, "executableSha256");
            Need(Path.IsPathRooted(executable) && File.Exists(executable) &&
                     FileVersionInfo.GetVersionInfo(executable).FileVersion == "4.2.0.53" &&
                     FileHash(executable) == expected,
                 "QUOTE_UIA_EXECUTABLE_CHANGED");
            var main = new Binding(request, true);
            uint pid;
            uint thread = GetWindowThreadProcessId(main.Window, out pid);
            Need(thread == (uint)Number(request, "threadId"), "QUOTE_UIA_WINDOW_CHANGED");
            using (var process = Process.GetProcessById((int)pid))
                Need(String.Equals(Path.GetFullPath(process.MainModule.FileName), Path.GetFullPath(executable),
                                   StringComparison.OrdinalIgnoreCase),
                     "QUOTE_UIA_EXECUTABLE_CHANGED");
            string directory = Path.GetDirectoryName(typeof(WechatQuoteHistory).Assembly.Location),
                   probe = Path.Combine(directory, "WechatVisualProbe.exe");
            Need(File.Exists(probe), "QUOTE_UIA_OCR_COMPONENT_MISSING");
            string temp = Path.Combine(directory, "history-frames");
            Directory.CreateDirectory(temp);
            navigation =
                new HistoryNavigation { Main = main,
                                        ThreadId = thread,
                                        Query = Text(request, "text"),
                                        VisualProbe = probe,
                                        TemporaryDirectory = temp,
                                        Deadline = Stopwatch.GetTimestamp() + 12000 * Stopwatch.Frequency / 1000 };
            if (navigation.Open())
                navigation.Search();
        }
        catch (Exception failure)
        {
            error = failure.Message;
            if (error == null || !error.StartsWith("QUOTE_UIA_", StringComparison.Ordinal) || error.Length > 90)
                error = "QUOTE_UIA_HISTORY_UNAVAILABLE";
        }
        finally
        {
            if (navigation != null)
                try
                {
                    navigation.Cleanup();
                }
                catch
                {
                    navigation.CleanupConfirmed = false;
                    error = "QUOTE_UIA_HISTORY_CLEANUP_UNCONFIRMED";
                }
        }
        return D("ok", error == null, "mode", "navigate-history", "found",
                 navigation != null && navigation.Found && error == null, "error", error, "phase",
                 navigation == null ? "preflight" : navigation.Phase, "navigationAttempted",
                 navigation != null && navigation.Attempted, "messageInputSent", false, "messageSubmitted", false,
                 "clipboardAccessed", false, "originalMessageIdVerified", false, "historyCreated",
                 navigation != null && navigation.CreatedHistory, "historyPreserved",
                 navigation != null && navigation.History != null && !navigation.CreatedHistory, "cleanupConfirmed",
                 navigation == null || navigation.CleanupConfirmed, "resultCount",
                 navigation == null ? 0 : navigation.ResultCount, "pointMethod",
                 navigation == null ? null : navigation.PointMethod);
    }
    static int NavigationSelfTest()
    {
        int checks = 0;
        foreach (var value in new[] { "fixture", "短句", "文件名称.pdf" })
        {
            Need(SearchQueryValid(value), "QUOTE_UIA_SELFTEST");
            checks++;
        }
        foreach (var value in new[] { "", " ", "bad\ntext", "bad\0text", new String('a', 4001) })
        {
            Need(!SearchQueryValid(value), "QUOTE_UIA_SELFTEST");
            checks++;
        }
        Need(IsAscii("file") && !IsAscii("文字"), "QUOTE_UIA_SELFTEST");
        checks++;
        bool attempted = false;
        int guards = 0;
        var messages = new List<uint>();
        try
        {
            QueueMouseClick(
                delegate {
                    if (++guards == 2)
                        throw new InvalidOperationException("changed");
                },
                delegate(uint message) {
                    messages.Add(message);
                    return true;
                },
                0x201, 0x202, true, ref attempted);
        }
        catch (InvalidOperationException)
        {
        }
        Need(attempted && guards == 2 && messages.Count == 1 && messages[0] == 0x200, "QUOTE_UIA_SELFTEST");
        checks++;
        attempted = false;
        guards = 0;
        messages.Clear();
        bool changed = false;
        QueueMouseClick(
            delegate {
                guards++;
                Need(!changed, "QUOTE_UIA_SELFTEST");
            },
            delegate(uint message) {
                messages.Add(message);
                if (message == 0x201)
                    changed = true;
                return true;
            },
            0x201, 0x202, false, ref attempted);
        Need(attempted && guards == 1 && messages.Count == 2 && messages[0] == 0x201 && messages[1] == 0x202,
             "QUOTE_UIA_SELFTEST");
        checks++;
        attempted = false;
        messages.Clear();
        try
        {
            QueueMouseClick(delegate {}, delegate(uint message) {
                messages.Add(message);
                return false;
            }, 0x201, 0x202, false, ref attempted);
        }
        catch (InvalidOperationException)
        {
        }
        Need(attempted && messages.Count == 1 && messages[0] == 0x201, "QUOTE_UIA_SELFTEST");
        checks++;
        attempted = false;
        messages.Clear();
        try
        {
            QueueMouseClick(delegate { throw new InvalidOperationException("changed"); },
                            delegate(uint message) {
                                messages.Add(message);
                                return true;
                            },
                            0x201, 0x202, false, ref attempted);
        }
        catch (InvalidOperationException)
        {
        }
        Need(!attempted && messages.Count == 0, "QUOTE_UIA_SELFTEST");
        checks++;
        Console.WriteLine(Json.Serialize(
            D("ok", true, "navigationSelfTest", true, "checks", checks, "uiAccessed", false, "inputSent", false)));
        return 0;
    }
}
