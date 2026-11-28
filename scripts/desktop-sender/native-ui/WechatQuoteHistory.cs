// History lookup uses standard UI Automation, adapted from QtQuoteRow/List and FindQuoteHistory/Point.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;

internal static partial class WechatQuoteHistory
{
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 65536 };
    static readonly HashSet<string> Labels =
        new HashSet<string>(new[] { "消息", "訊息", "Messages", "搜索", "查找", "查找聊天记录", "聊天记录", "引用",
                                    "Quote", "Search", "Search Chat History", "取消", "Cancel" },
                            StringComparer.Ordinal);
    static readonly AutomationPattern[] Patterns = { ItemContainerPattern.Pattern, VirtualizedItemPattern.Pattern,
                                                     ScrollItemPattern.Pattern,    ScrollPattern.Pattern,
                                                     TextPattern.Pattern,          ValuePattern.Pattern,
                                                     InvokePattern.Pattern,        SelectionItemPattern.Pattern };
    static readonly string[] PatternNames = { "ItemContainer", "VirtualizedItem", "ScrollItem", "Scroll",
                                              "Text",          "Value",           "Invoke",     "SelectionItem" };
    [StructLayout(LayoutKind.Sequential)]
    struct RECT
    {
        public int Left, Top, Right, Bottom;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct POINT
    {
        public int X, Y;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct LASTINPUTINFO
    {
        public uint Size, Time;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct FT
    {
        public uint Low, High;
    }
    [DllImport("user32.dll")]
    static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll")]
    static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    static extern bool GetWindowRect(IntPtr window, out RECT rect);
    [DllImport("user32.dll")]
    static extern bool GetClientRect(IntPtr window, out RECT rect);
    [DllImport("user32.dll")]
    static extern bool ClientToScreen(IntPtr window, ref POINT point);
    [DllImport("user32.dll")]
    static extern bool GetLastInputInfo(ref LASTINPUTINFO info);
    [DllImport("kernel32.dll")]
    static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")]
    static extern bool GetProcessTimes(IntPtr process, out FT created, out FT exited, out FT kernel, out FT user);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);
    [DllImport("user32.dll")]
    static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    static Dictionary<string, object> D(params object[] pairs)
    {
        var d = new Dictionary<string, object>();
        for (int i = 0; i < pairs.Length; i += 2)
            d[(string)pairs[i]] = pairs[i + 1];
        return d;
    }
    static void Need(bool value, string code)
    {
        if (!value)
            throw new InvalidOperationException(code);
    }
    static string Text(Dictionary<string, object> request, string key)
    {
        object value;
        return request.TryGetValue(key, out value) ? value as string : null;
    }
    static long Number(Dictionary<string, object> request, string key)
    {
        object value;
        Need(request.TryGetValue(key, out value) && value != null && !(value is bool), "QUOTE_UIA_REQUEST_INVALID");
        return Convert.ToInt64(value);
    }
    static string Hash(string text)
    {
        using (var sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(text)))
            .Replace("-", "")
            .ToLowerInvariant();
    }
    static string Runtime(AutomationElement node)
    {
        return String.Join(",", node.GetRuntimeId());
    }
    static string Created(uint pid)
    {
        IntPtr handle = OpenProcess(0x1000, false, pid);
        Need(handle != IntPtr.Zero, "QUOTE_UIA_WINDOW_CHANGED");
        try
        {
            FT c, e, k, u;
            Need(GetProcessTimes(handle, out c, out e, out k, out u), "QUOTE_UIA_WINDOW_CHANGED");
            return (((ulong)c.High << 32) | c.Low).ToString();
        }
        finally
        {
            CloseHandle(handle);
        }
    }
    static uint InputTick()
    {
        var info = new LASTINPUTINFO { Size = (uint)Marshal.SizeOf(typeof(LASTINPUTINFO)) };
        Need(GetLastInputInfo(ref info), "QUOTE_UIA_INPUT_UNAVAILABLE");
        return info.Time;
    }
    static bool Same(RECT a, RECT b)
    {
        return a.Left == b.Left && a.Top == b.Top && a.Right == b.Right && a.Bottom == b.Bottom;
    }
    static object Bounds(System.Windows.Rect r)
    {
        return r.IsEmpty || Double.IsInfinity(r.X) || Double.IsInfinity(r.Y) || Double.IsNaN(r.X) || Double.IsNaN(r.Y)
                   ? null
                   : D("left", r.Left, "top", r.Top, "right", r.Right, "bottom", r.Bottom);
    }
    static string[] Supported(AutomationElement node)
    {
        var actual = new HashSet<int>();
        foreach (var pattern in node.GetSupportedPatterns())
            actual.Add(pattern.Id);
        var names = new List<string>();
        for (int i = 0; i < Patterns.Length; i++)
            if (actual.Contains(Patterns[i].Id))
                names.Add(PatternNames[i]);
        return names.ToArray();
    }
    sealed class Binding
    {
        internal IntPtr Window;
        internal uint Pid, Tick;
        internal RECT WindowRect;
        internal string ProcessCreated, RootId;
        internal AutomationElement Root;
        internal Binding(Dictionary<string, object> request, bool write)
        {
            long raw;
            Need(Int64.TryParse(Text(request, "hwnd"), out raw) && raw > 0, "QUOTE_UIA_REQUEST_INVALID");
            Window = new IntPtr(raw);
            long pid = Number(request, "pid");
            Need(pid > 0 && pid <= Int32.MaxValue, "QUOTE_UIA_REQUEST_INVALID");
            Pid = (uint)pid;
            uint actual;
            Need(GetWindowThreadProcessId(Window, out actual) != 0 && actual == Pid &&
                     GetWindowRect(Window, out WindowRect),
                 "QUOTE_UIA_WINDOW_CHANGED");
            ProcessCreated = Created(Pid);
            Root = AutomationElement.FromHandle(Window);
            Need(Root != null && Root.Current.ProcessId == Pid, "QUOTE_UIA_ROOT_UNAVAILABLE");
            RootId = Runtime(Root);
            Tick = InputTick();
            if (write)
            {
                Need(Text(request, "created") == ProcessCreated && Number(request, "lastInputTick") == Tick,
                     "QUOTE_UIA_INPUT_CHANGED");
                Check();
            }
        }
        internal void Check()
        {
            uint pid;
            RECT rect;
            Need(GetWindowThreadProcessId(Window, out pid) != 0 && pid == Pid && Created(Pid) == ProcessCreated &&
                     GetWindowRect(Window, out rect) && Same(rect, WindowRect) && Runtime(Root) == RootId,
                 "QUOTE_UIA_WINDOW_CHANGED");
            Need(GetForegroundWindow() == Window, "QUOTE_UIA_FOREGROUND_CHANGED");
            Need(InputTick() == Tick, "QUOTE_UIA_INPUT_CHANGED");
        }
        internal object Report()
        {
            return D("hwnd", Window.ToInt64().ToString(), "pid", Pid, "created", ProcessCreated, "rootRuntimeSha256",
                     Hash(RootId), "lastInputTick", Tick);
        }
    }
    sealed class Scan
    {
        internal List<AutomationElement> Nodes = new List<AutomationElement>();
        internal bool Truncated;
    }
    static Scan Walk(AutomationElement root, int limit, int milliseconds)
    {
        var result = new Scan();
        var timer = Stopwatch.StartNew();
        var queue = new Queue<AutomationElement>();
        queue.Enqueue(root);
        while (queue.Count > 0)
        {
            if (result.Nodes.Count >= limit || timer.ElapsedMilliseconds >= milliseconds)
            {
                result.Truncated = true;
                break;
            }
            var node = queue.Dequeue();
            result.Nodes.Add(node);
            for (var child = TreeWalker.RawViewWalker.GetFirstChild(node); child != null;
                 child = TreeWalker.RawViewWalker.GetNextSibling(child))
            {
                if (queue.Count + result.Nodes.Count >= limit || timer.ElapsedMilliseconds >= milliseconds)
                {
                    result.Truncated = true;
                    break;
                }
                queue.Enqueue(child);
            }
        }
        return result;
    }
    static bool MessageList(AutomationElement node)
    {
        var info = node.Current;
        return info.ControlType == ControlType.List &&
               (info.Name == "消息" || info.Name == "訊息" || info.Name == "Messages");
    }
    static bool Within(AutomationElement node, AutomationElement ancestor)
    {
        string id = Runtime(ancestor);
        for (int i = 0; node != null && i < 48; i++, node = TreeWalker.RawViewWalker.GetParent(node))
            if (Runtime(node) == id)
                return true;
        return false;
    }
    static bool NamedRow(AutomationElement node, string query)
    {
        var info = node.Current;
        return info.IsEnabled &&
               (info.ControlType == ControlType.ListItem || info.ClassName == "mmui::ChatTextItemView") &&
               info.Name == query;
    }
    static void Navigate(Action guard, Action operation, ref bool attempted)
    {
        guard();
        attempted = true;
        operation();
    }
    sealed class HistoryControls
    {
        internal AutomationElement Search, List;
    }
    static HistoryControls History(Binding b)
    {
        Need(b.Root.Current.ClassName == "mmui::SearchMsgUniqueChatWindow", "QUOTE_UIA_HISTORY_WINDOW_REQUIRED");
        var result = new HistoryControls();
        foreach (var node in Walk(b.Root, 192, 600).Nodes)
        {
            var i = node.Current;
            if (i.ProcessId != b.Pid || i.IsOffscreen || !i.IsEnabled)
                continue;
            if (i.ControlType == ControlType.Edit && i.ClassName == "mmui::XValidatorTextEdit")
            {
                Need(result.Search == null, "QUOTE_UIA_HISTORY_AMBIGUOUS");
                result.Search = node;
            }
            if (i.ControlType == ControlType.List && i.ClassName == "mmui::RecyclerListView" &&
                (i.Name == "聊天记录" || i.Name == "Chat History"))
            {
                Need(result.List == null, "QUOTE_UIA_HISTORY_AMBIGUOUS");
                result.List = node;
            }
        }
        Need(result.Search != null && result.List != null, "QUOTE_UIA_HISTORY_UNAVAILABLE");
        return result;
    }
    static object Control(AutomationElement node)
    {
        var i = node.Current;
        return D("runtimeSha256", Hash(Runtime(node)), "role", i.ControlType.ProgrammaticName, "className", i.ClassName,
                 "rect", Bounds(i.BoundingRectangle), "patterns", Supported(node));
    }
    static object HistoryLayout(Dictionary<string, object> request)
    {
        var b = new Binding(request, false);
        var layout = History(b);
        return D("ok", true, "mode", "history-layout", "readOnly", true, "inputSent", false, "navigationAttempted",
                 false, "binding", b.Report(), "search", Control(layout.Search), "list", Control(layout.List));
    }
    static object HistoryEntry(Dictionary<string, object> request)
    {
        var b = new Binding(request, false);
        AutomationElement entry = null;
        foreach (var node in Walk(b.Root, 192, 600).Nodes)
        {
            var i = node.Current;
            if (i.ProcessId == b.Pid && i.IsEnabled && !i.IsOffscreen && i.ControlType == ControlType.Button &&
                i.ClassName == "mmui::XButton" && (i.Name == "聊天记录" || i.Name == "Chat History"))
            {
                Need(entry == null, "QUOTE_UIA_HISTORY_AMBIGUOUS");
                entry = node;
            }
        }
        return D("ok", true, "mode", "history-entry", "readOnly", true, "inputSent", false, "navigationAttempted",
                 false, "binding", b.Report(), "entry", entry == null ? null : Control(entry));
    }
    static bool QueryMatches(AutomationElement search, string query)
    {
        object value;
        return search.TryGetCurrentPattern(ValuePattern.Pattern, out value) &&
               ((ValuePattern)value).Current.Value == query;
    }
    static object SearchHistory(Dictionary<string, object> request)
    {
        string query = Text(request, "text");
        Need(!String.IsNullOrEmpty(query) && query.Length <= 4096, "QUOTE_UIA_REQUEST_INVALID");
        var b = new Binding(request, true);
        bool attempted = false;
        try
        {
            var controls = History(b);
            Need(Text(request, "searchRuntime") == Hash(Runtime(controls.Search)), "QUOTE_UIA_HISTORY_CHANGED");
            object capability;
            if (!controls.Search.TryGetCurrentPattern(ValuePattern.Pattern, out capability) ||
                ((ValuePattern)capability).Current.IsReadOnly)
                return D("ok", true, "mode", "search-history", "queryAccepted", false, "unsupported", true,
                         "navigationAttempted", false, "inputSent", false, "binding", b.Report(), "search",
                         Control(controls.Search));
            var value = (ValuePattern)capability;
            Navigate(b.Check, delegate { value.SetValue(query); }, ref attempted);
            b.Check();
            return D("ok", true, "mode", "search-history", "queryAccepted", QueryMatches(controls.Search, query),
                     "unsupported", false, "navigationAttempted", true, "inputSent", true, "binding", b.Report());
        }
        catch (Exception error)
        {
            return Error(error, attempted);
        }
    }
    static object HistoryResults(Dictionary<string, object> request)
    {
        string query = Text(request, "text");
        Need(!String.IsNullOrEmpty(query) && query.Length <= 4096, "QUOTE_UIA_REQUEST_INVALID");
        var b = new Binding(request, false);
        var controls = History(b);
        var matches = new List<object>();
        bool queryMatches = QueryMatches(controls.Search, query);
        var scan = Walk(controls.List, 192, 600);
        if (queryMatches)
            foreach (var row in scan.Nodes)
            {
                var i = row.Current;
                if (i.ProcessId != b.Pid || i.IsOffscreen || !i.IsEnabled || i.ControlType != ControlType.ListItem ||
                    !(i.ClassName == "mmui::ChatTextItemView" || i.ClassName == "mmui::ChatFileItemView" ||
                      i.ClassName == "mmui::ChatBubbleItemView"))
                    continue;
                string name = i.Name ?? "";
                if (name.IndexOf(query, StringComparison.Ordinal) < 0)
                    continue;
                var bounds = i.BoundingRectangle;
                bounds.Intersect(controls.List.Current.BoundingRectangle);
                if (bounds.IsEmpty || bounds.Width < 2 || bounds.Height < 2)
                    continue;
                object textRect = null, provider;
                if (row.TryGetCurrentPattern(TextPattern.Pattern, out provider))
                {
                    var range = ((TextPattern)provider).DocumentRange.FindText(query, false, false);
                    if (range != null)
                    {
                        var glyphs = range.GetBoundingRectangles();
                        if (glyphs.Length > 0 && glyphs[0].Width > 1 && bounds.Contains(glyphs[0]))
                            textRect = Bounds(glyphs[0]);
                    }
                }
                matches.Add(D("runtimeSha256", Hash(Runtime(row)), "role", i.ControlType.ProgrammaticName, "className",
                              i.ClassName, "rect", Bounds(bounds), "textRect", textRect, "patterns", Supported(row),
                              "matchKind", name == query ? "exact" : "contains", "matchedText", query));
            }
        queryMatches = queryMatches && QueryMatches(controls.Search, query);
        if (!queryMatches)
            matches.Clear();
        return D("ok", true, "mode", "history-results", "readOnly", true, "inputSent", false, "navigationAttempted",
                 false, "binding", b.Report(), "queryMatches", queryMatches, "matches", matches, "visited",
                 scan.Nodes.Count, "truncated", scan.Truncated, "originalMessageIdVerified", false);
    }
    static object Inspect(Dictionary<string, object> request)
    {
        var b = new Binding(request, false);
        string query = Text(request, "text");
        Need(query == null || query.Length <= 4096, "QUOTE_UIA_REQUEST_INVALID");
        var scan = Walk(b.Root, 192, 600);
        var nodes = new List<object>();
        int lists = 0, matches = 0;
        foreach (var node in scan.Nodes)
        {
            var info = node.Current;
            if (info.ProcessId != b.Pid)
                continue;
            string name = info.Name ?? "";
            bool match = !String.IsNullOrEmpty(query) && name.IndexOf(query, StringComparison.Ordinal) >= 0;
            if (match)
                matches++;
            if (MessageList(node))
                lists++;
            var report = D("role", info.ControlType.ProgrammaticName, "className", info.ClassName, "enabled",
                           info.IsEnabled, "offscreen", info.IsOffscreen, "rect", Bounds(info.BoundingRectangle),
                           "patterns", Supported(node), "runtimeSha256", Hash(Runtime(node)), "matched", match);
            if (Labels.Contains(name))
                report["label"] = name;
            if (match)
            {
                report["matchKind"] = name == query ? "exact" : "contains";
                report["matchedText"] = query;
            }
            nodes.Add(report);
        }
        return D("ok", true, "mode", "inspect", "readOnly", true, "inputSent", false, "navigationAttempted", false,
                 "binding", b.Report(), "visited", scan.Nodes.Count, "truncated", scan.Truncated, "messageLists", lists,
                 "matches", matches, "nodes", nodes);
    }
    static AutomationElement VisibleRow(AutomationElement list, string query, uint pid)
    {
        var scan = Walk(list, 256, 350);
        foreach (var node in scan.Nodes)
        {
            var i = node.Current;
            if (i.ProcessId == pid && !i.IsOffscreen && NamedRow(node, query))
                return node;
        }
        return null;
    }
    static object Found(Binding b, AutomationElement row, string strategy, bool attempted, bool self, string query)
    {
        b.Check();
        Need(row.Current.ProcessId == b.Pid && !row.Current.IsOffscreen, "QUOTE_UIA_SOURCE_UNAVAILABLE");
        var bounds = row.Current.BoundingRectangle;
        object value;
        bool glyph = false;
        if (row.TryGetCurrentPattern(TextPattern.Pattern, out value))
        {
            var range = ((TextPattern)value).DocumentRange.FindText(query, false, false);
            if (range != null)
            {
                var glyphs = range.GetBoundingRectangles();
                if (glyphs.Length > 0 && glyphs[0].Width > 1 && bounds.Contains(glyphs[0]))
                {
                    bounds = glyphs[0];
                    glyph = true;
                }
            }
        }
        RECT client;
        POINT origin = new POINT();
        Need(GetClientRect(b.Window, out client) && ClientToScreen(b.Window, ref origin), "QUOTE_UIA_WINDOW_CHANGED");
        var area = new System.Windows.Rect(origin.X, origin.Y, client.Right - client.Left, client.Bottom - client.Top);
        bounds.Intersect(area);
        for (var parent = TreeWalker.RawViewWalker.GetParent(row); parent != null;
             parent = TreeWalker.RawViewWalker.GetParent(parent))
        {
            if (parent.Current.ControlType == ControlType.List)
            {
                bounds.Intersect(parent.Current.BoundingRectangle);
                break;
            }
            if (Runtime(parent) == b.RootId)
                break;
        }
        Need(!bounds.IsEmpty && bounds.Width > 1 && bounds.Height > 1, "QUOTE_UIA_SOURCE_UNAVAILABLE");
        object point = null;
        if (glyph)
        {
            var p = new System.Windows.Point(bounds.Left + bounds.Width / 2, bounds.Top + bounds.Height / 2);
            var hit = AutomationElement.FromPoint(p);
            Need(hit != null && Within(hit, row), "QUOTE_UIA_SOURCE_OBSCURED");
            point = D("x", p.X, "y", p.Y);
        }
        b.Check();
        return D("ok", true, "mode", "find", "found", true, "strategy", strategy, "readOnly", !attempted, "inputSent",
                 false, "navigationAttempted", attempted, "binding", b.Report(), "rect", Bounds(bounds), "point", point,
                 "pointMethod", glyph ? "text-pattern" : "row-ocr", "runtimeSha256", Hash(Runtime(row)),
                 "originalMessageIdVerified", false);
    }
    static object Find(Dictionary<string, object> request)
    {
        string query = Text(request, "text");
        Need(!String.IsNullOrEmpty(query) && query.Length <= 4096 && request.ContainsKey("fromSelf") &&
                 request["fromSelf"] is bool,
             "QUOTE_UIA_REQUEST_INVALID");
        bool self = (bool)request["fromSelf"];
        var b = new Binding(request, true);
        bool moved = false;
        string strategy = "visible-uia";
        try
        {
            var scan = Walk(b.Root, 192, 400);
            AutomationElement list = null;
            foreach (var node in scan.Nodes)
                if (node.Current.ProcessId == b.Pid && MessageList(node))
                {
                    if (list != null)
                        return D("ok", true, "mode", "find", "found", false, "unsupported", true, "reason",
                                 "QUOTE_UIA_LIST_AMBIGUOUS", "navigationAttempted", false);
                    list = node;
                }
            if (list == null)
                return D("ok", true, "mode", "find", "found", false, "unsupported", true, "reason",
                         "QUOTE_UIA_MESSAGE_LIST_UNAVAILABLE", "navigationAttempted", false);
            var row = VisibleRow(list, query, b.Pid);
            if (row != null)
                return Found(b, row, strategy, false, self, query);
            AutomationElement hidden = null;
            foreach (var node in Walk(list, 256, 350).Nodes)
                if (node.Current.ProcessId == b.Pid && NamedRow(node, query))
                {
                    hidden = node;
                    break;
                }
            object capability;
            if (hidden == null && list.TryGetCurrentPattern(ItemContainerPattern.Pattern, out capability))
            {
                b.Check();
                try
                {
                    hidden = ((ItemContainerPattern)capability)
                                 .FindItemByProperty(null, AutomationElement.NameProperty, query);
                    strategy = "itemcontainer";
                }
                catch (ArgumentException)
                {
                }
                catch (InvalidOperationException)
                {
                }
            }
            if (hidden == null)
                return D("ok", true, "mode", "find", "found", false, "unsupported", false, "reason",
                         "QUOTE_UIA_SOURCE_NOT_EXPOSED", "navigationAttempted", false);
            // ItemContainer may return a virtual placeholder whose Current
            // properties are unavailable until Realize. Its provider is the
            // already-bound message list; validate PID/ancestry after realization.
            if (hidden.TryGetCurrentPattern(VirtualizedItemPattern.Pattern, out capability))
            {
                strategy = "realize";
                var virtualized = (VirtualizedItemPattern)capability;
                Navigate(b.Check, virtualized.Realize, ref moved);
            }
            Need(hidden.Current.ProcessId == b.Pid && Within(hidden, list), "QUOTE_UIA_SOURCE_UNAVAILABLE");
            if (hidden.TryGetCurrentPattern(ScrollItemPattern.Pattern, out capability))
            {
                strategy = "scrollitem";
                var item = (ScrollItemPattern)capability;
                Navigate(b.Check, item.ScrollIntoView, ref moved);
            }
            for (int i = 0; i < (moved ? 6 : 1); i++)
            {
                b.Check();
                row = VisibleRow(list, query, b.Pid);
                if (row != null)
                    return Found(b, row, strategy, moved, self, query);
                if (moved)
                    Thread.Sleep(10);
            }
            return D("ok", true, "mode", "find", "found", false, "unsupported", false, "reason",
                     "QUOTE_UIA_SOURCE_NOT_VISIBLE", "navigationAttempted", moved);
        }
        catch (Exception error)
        {
            return Error(error, moved);
        }
    }
    static object Error(Exception error, bool attempted)
    {
        string code = error.Message;
        if (code == null || !code.StartsWith("QUOTE_UIA_", StringComparison.Ordinal) || code.Length > 90)
            code = "QUOTE_UIA_UNAVAILABLE";
        return D("ok", false, "error", code, "navigationAttempted", attempted, "inputSent", false);
    }
    static object Execute(Dictionary<string, object> request)
    {
        switch (Text(request, "mode"))
        {
        case "inspect":
            return Inspect(request);
        case "find":
            return Find(request);
        case "history-layout":
            return HistoryLayout(request);
        case "history-entry":
            return HistoryEntry(request);
        case "search-history":
            return SearchHistory(request);
        case "history-results":
            return HistoryResults(request);
        default:
            throw new InvalidOperationException("QUOTE_UIA_REQUEST_INVALID");
        }
    }
    static int SelfTest()
    {
        Need(Hash("one").Length == 64 && Hash("one") != Hash("two"), "QUOTE_UIA_SELFTEST");
        Need(Labels.Contains("引用") && !Labels.Contains("private source text"), "QUOTE_UIA_SELFTEST");
        Need(Patterns.Length == PatternNames.Length, "QUOTE_UIA_SELFTEST");
        bool moved = false;
        int calls = 0;
        Navigate(delegate {}, delegate { calls++; }, ref moved);
        Need(moved && calls == 1, "QUOTE_UIA_SELFTEST");
        moved = false;
        calls = 0;
        try
        {
            Navigate(delegate { throw new InvalidOperationException("guard"); }, delegate { calls++; }, ref moved);
        }
        catch (InvalidOperationException)
        {
        }
        Need(!moved && calls == 0, "QUOTE_UIA_SELFTEST");
        moved = false;
        calls = 0;
        try
        {
            Navigate(delegate {}, delegate {
                calls++;
                throw new InvalidOperationException("provider");
            }, ref moved);
        }
        catch (InvalidOperationException)
        {
        }
        Need(moved && calls == 1, "QUOTE_UIA_SELFTEST");
        var failed =
            (Dictionary<string, object>)Error(new InvalidOperationException("private provider response"), true);
        Need((string)failed["error"] == "QUOTE_UIA_UNAVAILABLE" && (bool)failed["navigationAttempted"],
             "QUOTE_UIA_SELFTEST");
        Console.WriteLine(
            Json.Serialize(D("ok", true, "selfTest", true, "checks", 7, "uiAccessed", false, "inputSent", false)));
        return 0;
    }
    static int Main(string[] args)
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        try
        {
            if (args.Length == 1 && args[0] == "--self-test")
            {
                SelfTest();
                return NavigationSelfTest();
            }
            Need(SetThreadDpiAwarenessContext(new IntPtr(-4)) != IntPtr.Zero, "QUOTE_UIA_DPI_UNAVAILABLE");
            if ((args.Length == 3 || args.Length == 4) && args[0] == "--inspect")
            {
                Console.WriteLine(
                    Json.Serialize(Inspect(D("mode", "inspect", "hwnd", args[1], "pid", Int32.Parse(args[2]), "text",
                                             args.Length == 4 ? args[3] : null))));
                return 0;
            }
            if (args.Length == 3 && args[0] == "--navigate" && args[1] == "--request")
            {
                var file = new FileInfo(args[2]);
                Need(file.Exists && file.Length <= 32768, "QUOTE_UIA_REQUEST_INVALID");
                var request =
                    Json.Deserialize<Dictionary<string, object>>(File.ReadAllText(file.FullName, Encoding.UTF8));
                StartCancellationWatch();
                Console.WriteLine(Json.Serialize(NavigateHistory(request)));
                return 0;
            }
            Need(args.Length == 1 && args[0] == "--serve", "QUOTE_UIA_REQUEST_INVALID");
            string line;
            while ((line = Console.ReadLine()) != null)
            {
                Need(line.Length <= 32768, "QUOTE_UIA_REQUEST_INVALID");
                Dictionary<string, object> request = null;
                object result;
                try
                {
                    request = Json.Deserialize<Dictionary<string, object>>(line);
                    result = Execute(request);
                }
                catch (Exception error)
                {
                    result = Error(error, false);
                }
                Console.WriteLine(Json.Serialize(
                    D("id", request != null && request.ContainsKey("id") ? request["id"] : null, "result", result)));
            }
            return 0;
        }
        catch (Exception error)
        {
            Console.WriteLine(Json.Serialize(Error(error, false)));
            return 1;
        }
    }
}
