// Background UIA inventory; an explicitly enabled search-only diagnostic can
// temporarily write and restore an empty search field. Never sends a message,
// changes focus, uses the clipboard, or sends keyboard/mouse events.
// Run under an external process timeout: a foreign UIA provider can hang in a
// single COM call, which a traversal deadline alone cannot interrupt.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;

internal static partial class WechatBackgroundControls
{
    static readonly JavaScriptSerializer Json =
        new JavaScriptSerializer { MaxJsonLength = 2097152, RecursionLimit = 32 };
    static readonly HashSet<string> StaticIds = new HashSet<string>(StringComparer.Ordinal) {
        "chat_input_field", "search",    "search_input", "search_field",      "search_edit",       "search_edit_field",
        "session_list",     "chat_list", "message_list", "chat_message_list", "main_search_input", "chat_send_button"
    };
    static bool UiAccessed, ControlWriteAttempted, SearchValueRead, TitleTextRead;
    static readonly Dictionary<AutomationProperty, string> PatternProperties = KnownPatternProperties();
    sealed class Fault : Exception
    {
        internal Fault(string code) : base(code)
        {
        }
    }
    sealed class Binding
    {
        internal IntPtr Window;
        internal uint Pid;
        internal long Created;
        internal string Executable;
        internal int MaxNodes = 512, MaxDepth = 96;
    }
    sealed class WalkResult
    {
        internal List<object> Nodes = new List<object>();
        internal bool Complete = true;
        internal string Reason;
    }
    sealed class ValueProbeResult
    {
        internal bool OriginalEmpty, WriteAttempted, ReadbackVerified, ClearAttempted, Restored, RestoreSkipped;
        internal string Error, RestoreError;
    }
    sealed class Fixture
    {
        internal string Name;
        internal List<Fixture> Children = new List<Fixture>();
        internal Fixture Next;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct FileTime
    {
        internal uint Low, High;
        internal long Ticks
        {
            get {
                return ((long)High << 32) | Low;
            }
        }
    }
    [StructLayout(LayoutKind.Sequential)]
    struct Point
    {
        internal int X, Y;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct LastInput
    {
        internal uint Size, Time;
    }
    static void Need(bool value, string code)
    {
        if (!value)
            throw new Fault(code);
    }
    static Dictionary<string, object> Data(params object[] pairs)
    {
        var result = new Dictionary<string, object>();
        for (int i = 0; i < pairs.Length; i += 2)
            result.Add((string)pairs[i], pairs[i + 1]);
        return result;
    }
    static object Get(Dictionary<string, object> map, string key)
    {
        object value;
        return map != null && map.TryGetValue(key, out value) ? value : null;
    }
    static long Number(object value)
    {
        Need(value != null && !(value is string) && !(value is bool), "UI_CONTROLS_NUMBER_INVALID");
        try
        {
            decimal n = Convert.ToDecimal(value, CultureInfo.InvariantCulture);
            Need(n >= 0 && n <= 9007199254740991M && Decimal.Truncate(n) == n, "UI_CONTROLS_NUMBER_INVALID");
            return (long)n;
        }
        catch (Fault)
        {
            throw;
        }
        catch
        {
            throw new Fault("UI_CONTROLS_NUMBER_INVALID");
        }
    }
    static long DecimalId(object value)
    {
        string text = value as string;
        long result;
        Need(text != null && text.Length <= 19 &&
                 Int64.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out result) && result > 0,
             "UI_CONTROLS_ID_INVALID");
        return Int64.Parse(text, CultureInfo.InvariantCulture);
    }
    static string Id(long value)
    {
        return value.ToString(CultureInfo.InvariantCulture);
    }
    static string Hash(string value)
    {
        using (var sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(Encoding.UTF8.GetBytes(value)))
            .Replace("-", "")
            .ToLowerInvariant();
    }
    static Binding Parse(Dictionary<string, object> request)
    {
        Need(request != null, "UI_CONTROLS_REQUEST_INVALID");
        foreach (string key in request.Keys)
            Need(key == "version" || key == "hwnd" || key == "pid" || key == "processCreatedFileTimeUtc" ||
                     key == "executable" || key == "maxNodes" || key == "maxDepth",
                 "UI_CONTROLS_REQUEST_INVALID");
        Need(Number(Get(request, "version")) == 1, "UI_CONTROLS_VERSION_INVALID");
        long pid = Number(Get(request, "pid"));
        Need(pid > 0 && pid <= Int32.MaxValue, "UI_CONTROLS_PID_INVALID");
        string exe = Get(request, "executable") as string;
        Need(!String.IsNullOrEmpty(exe) && exe.Length <= 32767 && exe.IndexOfAny(new[] { '\0', '\r', '\n' }) < 0 &&
                 Path.IsPathRooted(exe),
             "UI_CONTROLS_EXECUTABLE_INVALID");
        exe = Path.GetFullPath(exe);
        Need(String.Equals(Path.GetFileName(exe), "Weixin.exe", StringComparison.OrdinalIgnoreCase),
             "UI_CONTROLS_EXECUTABLE_INVALID");
        var b = new Binding { Window = new IntPtr(DecimalId(Get(request, "hwnd"))), Pid = (uint)pid,
                              Created = DecimalId(Get(request, "processCreatedFileTimeUtc")), Executable = exe };
        if (request.ContainsKey("maxNodes"))
        {
            long n = Number(Get(request, "maxNodes"));
            Need(n >= 1 && n <= 2048, "UI_CONTROLS_LIMIT_INVALID");
            b.MaxNodes = (int)n;
        }
        if (request.ContainsKey("maxDepth"))
        {
            long n = Number(Get(request, "maxDepth"));
            Need(n >= 1 && n <= 128, "UI_CONTROLS_LIMIT_INVALID");
            b.MaxDepth = (int)n;
        }
        return b;
    }
    static Dictionary<string, object> ReadRequest(string path)
    {
        Need(Path.IsPathRooted(path), "UI_CONTROLS_REQUEST_PATH_INVALID");
        var file = new FileInfo(path);
        Need(file.Exists && file.Length > 0 && file.Length <= 32768, "UI_CONTROLS_REQUEST_INVALID");
        return Json.DeserializeObject(File.ReadAllText(path, Encoding.UTF8)) as Dictionary<string, object>;
    }
    static void SameProcess(Binding b, IntPtr process)
    {
        Need(WaitForSingleObject(process, 0) == 258, "UI_CONTROLS_PROCESS_EXITED");
        FileTime start, exit, kernel, user;
        Need(GetProcessTimes(process, out start, out exit, out kernel, out user), "UI_CONTROLS_PROCESS_UNAVAILABLE");
        Need(start.Ticks == b.Created, "UI_CONTROLS_PROCESS_CHANGED");
        var path = new StringBuilder(32768);
        uint length = (uint)path.Capacity;
        Need(QueryFullProcessImageName(process, 0, path, ref length), "UI_CONTROLS_PROCESS_UNAVAILABLE");
        Need(String.Equals(Path.GetFullPath(path.ToString()), b.Executable, StringComparison.OrdinalIgnoreCase),
             "UI_CONTROLS_EXECUTABLE_CHANGED");
        uint session;
        Need(ProcessIdToSessionId(b.Pid, out session) && session == (uint)Process.GetCurrentProcess().SessionId,
             "UI_CONTROLS_SESSION_CHANGED");
    }
    static Dictionary<string, object> Observe(Binding b, IntPtr process)
    {
        SameProcess(b, process);
        Need(IsWindow(b.Window) && GetAncestor(b.Window, 2) == b.Window, "UI_CONTROLS_WINDOW_UNAVAILABLE");
        uint pid;
        uint thread = GetWindowThreadProcessId(b.Window, out pid);
        Need(thread != 0 && pid == b.Pid, "UI_CONTROLS_WINDOW_CHANGED");
        var className = new StringBuilder(256);
        Need(GetClassName(b.Window, className, className.Capacity) > 0, "UI_CONTROLS_WINDOW_UNAVAILABLE");
        Need(className.ToString() == "Qt51514QWindowIcon" || className.ToString() == "mmui::MainWindow" ||
                 className.ToString() == "mmui::ChatSingleWindow" ||
                 className.ToString() == "mmui::SearchMsgUniqueChatWindow",
             "UI_CONTROLS_WINDOW_CLASS_INVALID");
        Point cursor;
        Need(GetCursorPos(out cursor), "UI_CONTROLS_OBSERVATION_FAILED");
        var input = new LastInput { Size = (uint)Marshal.SizeOf(typeof(LastInput)) };
        Need(GetLastInputInfo(ref input), "UI_CONTROLS_OBSERVATION_FAILED");
        return Data("hwnd", Id(b.Window.ToInt64()), "pid", b.Pid, "processCreatedFileTimeUtc", Id(b.Created),
                    "threadId", thread, "nativeClassName", className.ToString(), "visible", IsWindowVisible(b.Window),
                    "minimized", IsIconic(b.Window), "foregroundHwnd", Id(GetForegroundWindow().ToInt64()), "cursorX",
                    cursor.X, "cursorY", cursor.Y, "lastInputTick", input.Time);
    }
    static bool Same(Dictionary<string, object> a, Dictionary<string, object> b, string key)
    {
        return Object.Equals(Get(a, key), Get(b, key));
    }
    static Dictionary<string, object> AutomationIdReport(string value)
    {
        Need(value != null && value.Length <= 4096, "UI_CONTROLS_METADATA_INVALID");
        return Data("automationIdPresent", value.Length != 0, "automationId", StaticIds.Contains(value) ? value : null,
                    "automationIdSha256", value.Length == 0 ? null : Hash(value));
    }
    static string TextMetadata(string value)
    {
        Need(value != null && value.Length <= 512 && value.IndexOf('\0') < 0, "UI_CONTROLS_METADATA_INVALID");
        return value;
    }
    static Dictionary<AutomationProperty, string> KnownPatternProperties()
    {
        var result = new Dictionary<AutomationProperty, string>();
        foreach (var field in typeof(AutomationElement)
                     .GetFields(System.Reflection.BindingFlags.Public | System.Reflection.BindingFlags.Static))
        {
            string name = field.Name;
            if (name.StartsWith("Is", StringComparison.Ordinal) &&
                name.EndsWith("PatternAvailableProperty", StringComparison.Ordinal) &&
                field.FieldType == typeof(AutomationProperty))
                result.Add((AutomationProperty)field.GetValue(null),
                           name.Substring(2, name.Length - 2 - "AvailableProperty".Length) + "Identifiers.Pattern");
        }
        return result;
    }
    static CacheRequest MetadataCache()
    {
        var cache = new CacheRequest();
        cache.TreeScope = TreeScope.Element;
        foreach (var property in new[] { AutomationElement.ProcessIdProperty, AutomationElement.ClassNameProperty,
                                         AutomationElement.ControlTypeProperty, AutomationElement.FrameworkIdProperty,
                                         AutomationElement.AutomationIdProperty,
                                         AutomationElement.NativeWindowHandleProperty,
                                         AutomationElement.IsEnabledProperty, AutomationElement.IsOffscreenProperty,
                                         AutomationElement.IsKeyboardFocusableProperty,
                                         AutomationElement.HasKeyboardFocusProperty,
                                         AutomationElement.BoundingRectangleProperty })
            cache.Add(property);
        foreach (var property in PatternProperties.Keys)
            cache.Add(property);
        return cache;
    }
    static Dictionary<string, object> Describe(AutomationElement element, uint pid)
    {
        var state = element.Cached;
        Need(state.ProcessId == (int)pid, "UI_CONTROLS_NODE_PROCESS_CHANGED");
        var rect = state.BoundingRectangle;
        var patterns = new List<string>();
        foreach (var pattern in PatternProperties)
        {
            object available = element.GetCachedPropertyValue(pattern.Key, true);
            if (available is bool && (bool)available)
                patterns.Add(pattern.Value);
        }
        patterns.Sort(StringComparer.Ordinal);
        var report = AutomationIdReport(state.AutomationId);
        report.Add("className", TextMetadata(state.ClassName));
        report.Add("controlType", TextMetadata(state.ControlType.ProgrammaticName));
        report.Add("frameworkId", TextMetadata(state.FrameworkId));
        report.Add("nativeHwnd", Id(state.NativeWindowHandle));
        report.Add("enabled", state.IsEnabled);
        report.Add("offscreen", state.IsOffscreen);
        report.Add("focusable", state.IsKeyboardFocusable);
        report.Add("focused", state.HasKeyboardFocus);
        report.Add("patterns", patterns);
        report.Add("rect", rect.IsEmpty
                               ? null
                               : Data("left", rect.Left, "top", rect.Top, "right", rect.Right, "bottom", rect.Bottom));
        report.Add("valuePattern", patterns.Contains("ValuePatternIdentifiers.Pattern"));
        report.Add("invokePattern", patterns.Contains("InvokePatternIdentifiers.Pattern"));
        report.Add("legacyAccessiblePattern", patterns.Contains("LegacyIAccessiblePatternIdentifiers.Pattern"));
        report.Add("legacyAccessiblePatternKnown", false);
        return report;
    }
    static WalkResult Walk<T>(T root, Func<T, T> child, Func<T, T> sibling,
                              Func<T, Dictionary<string, object>> describe, int maxNodes, int maxDepth,
                              Func<bool> expired)
        where T : class
    {
        var result = new WalkResult();
        Visit(root, -1, 0, child, sibling, describe, maxNodes, maxDepth, expired, result);
        return result;
    }
    static void Visit<T>(T node, int parent, int depth, Func<T, T> child, Func<T, T> sibling,
                         Func<T, Dictionary<string, object>> describe, int maxNodes, int maxDepth, Func<bool> expired,
                         WalkResult result)
        where T : class
    {
        if (node == null || !result.Complete)
            return;
        if (expired())
        {
            result.Complete = false;
            result.Reason = "UI_CONTROLS_DEADLINE";
            return;
        }
        if (result.Nodes.Count >= maxNodes)
        {
            result.Complete = false;
            result.Reason = "UI_CONTROLS_NODE_LIMIT";
            return;
        }
        var metadata = describe(node);
        int index = result.Nodes.Count;
        metadata.Add("index", index);
        metadata.Add("parent", parent);
        metadata.Add("depth", depth);
        result.Nodes.Add(metadata);
        var next = child(node);
        if (next != null && depth >= maxDepth)
        {
            result.Complete = false;
            result.Reason = "UI_CONTROLS_DEPTH_LIMIT";
            return;
        }
        while (next != null && result.Complete)
        {
            Visit(next, index, depth + 1, child, sibling, describe, maxNodes, maxDepth, expired, result);
            if (result.Complete)
                next = sibling(next);
        }
    }
    static object Inspect(Binding b)
    {
        // UIA initialization can change the effective DPI awareness. Observe
        // both cursor samples in PMv2 so coordinate virtualization is never
        // mistaken for user input, including on the first provider access.
        IntPtr dpiContext = SetThreadDpiAwarenessContext(new IntPtr(-4));
        Need(dpiContext != IntPtr.Zero, "UI_CONTROLS_DPI_CONTEXT_UNAVAILABLE");
        IntPtr process = IntPtr.Zero;
        try
        {
            process = OpenProcess(0x1000 | 0x100000, false, b.Pid);
            Need(process != IntPtr.Zero, "UI_CONTROLS_PROCESS_UNAVAILABLE");
            var before = Observe(b, process);
            UiAccessed = true;
            var timer = Stopwatch.StartNew();
            AutomationElement root = AutomationElement.FromHandle(b.Window);
            Need(root != null, "UI_CONTROLS_ROOT_UNAVAILABLE");
            int[] rootId = root.GetRuntimeId();
            var cache = MetadataCache();
            root = root.GetUpdatedCache(cache);
            var walker = TreeWalker.RawViewWalker;
            var result = Walk(root, delegate(AutomationElement el) { return walker.GetFirstChild(el, cache); },
                              delegate(AutomationElement el) { return walker.GetNextSibling(el, cache); },
                              delegate(AutomationElement el) { return Describe(el, b.Pid); }, b.MaxNodes, b.MaxDepth,
                              delegate { return timer.ElapsedMilliseconds > 10000; });
            var after = Observe(b, process);
            Need(Same(before, after, "threadId") && Same(before, after, "nativeClassName"),
                 "UI_CONTROLS_WINDOW_CHANGED");
            AutomationElement finalRoot = AutomationElement.FromHandle(b.Window);
            Need(finalRoot != null && Automation.Compare(rootId, finalRoot.GetRuntimeId()), "UI_CONTROLS_ROOT_CHANGED");
            int mmui = 0, values = 0, invokes = 0, legacy = 0;
            foreach (Dictionary<string, object> node in result.Nodes)
            {
                if (((string)node["className"]).StartsWith("mmui::", StringComparison.Ordinal))
                    mmui++;
                if ((bool)node["valuePattern"])
                    values++;
                if ((bool)node["invokePattern"])
                    invokes++;
                if ((bool)node["legacyAccessiblePattern"])
                    legacy++;
            }
            return Data("ok", true, "schemaVersion", 1, "backend", "background-controls", "diagnosticOnly", true,
                        "readOnly", true, "inputSent", false, "namesAndValuesRead", false, "eligibleForAutomation",
                        false, "bindingStable", true, "foregroundUnchanged", Same(before, after, "foregroundHwnd"),
                        "cursorUnchanged", Same(before, after, "cursorX") && Same(before, after, "cursorY"),
                        "inputTickUnchanged", Same(before, after, "lastInputTick"), "before", before, "after", after,
                        "complete", result.Complete, "reason", result.Reason, "nodeCount", result.Nodes.Count,
                        "mmuiControlCount", mmui, "valuePatternCount", values, "invokePatternCount", invokes,
                        "legacyAccessiblePatternCount", legacy, "nodes", result.Nodes, "elapsedMs",
                        timer.ElapsedMilliseconds);
        }
        finally
        {
            if (process != IntPtr.Zero)
                CloseHandle(process);
            SetThreadDpiAwarenessContext(dpiContext);
        }
    }
    static string ErrorCode(Exception error)
    {
        return error is Fault                          ? error.Message
               : error is ElementNotAvailableException ? "UI_CONTROLS_ELEMENT_UNAVAILABLE"
               : error is COMException                 ? "UI_CONTROLS_PROVIDER_FAILED"
                                                       : "UI_CONTROLS_FAILED";
    }
    static object ErrorReport(Exception error)
    {
        return Data("ok", false, "schemaVersion", 1, "error", ErrorCode(error), "readOnly", !ControlWriteAttempted,
                    "diagnosticOnly", true, "uiAccessed", UiAccessed, "inputSent", ControlWriteAttempted,
                    "messageSendAttempted", false, "namesAndValuesRead", SearchValueRead || TitleTextRead,
                    "titleTextRead", TitleTextRead, "searchValueIncluded", false, "eligibleForAutomation", false);
    }
    static bool SearchSelector(string className, string controlType, IList<string> parents)
    {
        return className == "mmui::XValidatorTextEdit" && controlType == "ControlType.Edit" && parents.Count >= 2 &&
               parents[0] == "mmui::XSearchField" && parents.Contains("mmui::ChatMasterView");
    }
    static AutomationElement SearchEditor(AutomationElement root, uint pid)
    {
        var matches = root.FindAll(
            TreeScope.Descendants,
            new AndCondition(new PropertyCondition(AutomationElement.ClassNameProperty, "mmui::XValidatorTextEdit"),
                             new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Edit)));
        Need(matches.Count <= 64, "UI_CONTROLS_SEARCH_AMBIGUOUS");
        AutomationElement chosen = null;
        var walker = TreeWalker.RawViewWalker;
        foreach (AutomationElement candidate in matches)
        {
            Need(candidate.Current.ProcessId == (int)pid, "UI_CONTROLS_NODE_PROCESS_CHANGED");
            var parents = new List<string>();
            var ancestor = walker.GetParent(candidate);
            bool reached = false;
            for (int depth = 0; ancestor != null && depth < 128; depth++)
            {
                Need(ancestor.Current.ProcessId == (int)pid, "UI_CONTROLS_NODE_PROCESS_CHANGED");
                if (Automation.Compare(root, ancestor))
                {
                    reached = true;
                    break;
                }
                parents.Add(ancestor.Current.ClassName);
                ancestor = walker.GetParent(ancestor);
            }
            Need(reached, "UI_CONTROLS_SEARCH_ANCESTRY_CHANGED");
            if (SearchSelector(candidate.Current.ClassName, candidate.Current.ControlType.ProgrammaticName, parents))
            {
                Need(chosen == null, "UI_CONTROLS_SEARCH_AMBIGUOUS");
                chosen = candidate;
            }
        }
        Need(chosen != null, "UI_CONTROLS_SEARCH_UNAVAILABLE");
        return chosen;
    }
    static void BackgroundOnly(uint pid)
    {
        uint current;
        IntPtr foreground = GetForegroundWindow();
        Need(foreground != IntPtr.Zero && GetWindowThreadProcessId(foreground, out current) != 0 && current != pid,
             "UI_CONTROLS_WECHAT_FOREGROUND");
    }
    static bool ProbeUserState(Dictionary<string, object> before, Dictionary<string, object> current,
                               bool allowProviderActivation)
    {
        return (allowProviderActivation || Same(before, current, "foregroundHwnd")) &&
               Same(before, current, "lastInputTick");
    }
    static Dictionary<string, object> ProbeBinding(Binding b, IntPtr process, Dictionary<string, object> before,
                                                   int[] rootId, AutomationElement editor, int[] editorId,
                                                   bool activity, bool allowProviderActivation = false)
    {
        var current = Observe(b, process);
        Need(Same(before, current, "threadId") && Same(before, current, "nativeClassName"),
             "UI_CONTROLS_WINDOW_CHANGED");
        if (!allowProviderActivation)
            BackgroundOnly(b.Pid);
        var root = AutomationElement.FromHandle(b.Window);
        Need(root != null && Automation.Compare(rootId, root.GetRuntimeId()), "UI_CONTROLS_ROOT_CHANGED");
        Need(editor.Current.ProcessId == (int)b.Pid && Automation.Compare(editorId, editor.GetRuntimeId()),
             "UI_CONTROLS_SEARCH_CHANGED");
        if (activity)
            Need(ProbeUserState(before, current, allowProviderActivation), "UI_CONTROLS_USER_ACTIVITY_CHANGED");
        // UIA COM calls may block. Recheck native identity and input state after
        // them so the returned observation does not predate a slow provider.
        var final = Observe(b, process);
        if (!allowProviderActivation)
            BackgroundOnly(b.Pid);
        Need(Same(before, final, "threadId") && Same(before, final, "nativeClassName"), "UI_CONTROLS_WINDOW_CHANGED");
        if (activity)
            Need(ProbeUserState(before, final, allowProviderActivation), "UI_CONTROLS_USER_ACTIVITY_CHANGED");
        return final;
    }
    static ValueProbeResult ProbeValue(Func<string> read, Action<string> write, Action guard, Action cleanupGuard,
                                       string marker)
    {
        var result = new ValueProbeResult();
        try
        {
            guard();
            result.OriginalEmpty = read() == "";
            Need(result.OriginalEmpty, "UI_CONTROLS_SEARCH_NOT_EMPTY");
            guard();
            Need(read() == "", "UI_CONTROLS_SEARCH_NOT_EMPTY");
            result.WriteAttempted = true;
            write(marker);
            result.ReadbackVerified = read() == marker;
            Need(result.ReadbackVerified, "UI_CONTROLS_SEARCH_READBACK_MISMATCH");
            guard();
        }
        catch (Exception error)
        {
            result.Error = ErrorCode(error);
        }
        finally
        {
            if (result.WriteAttempted)
            {
                try
                {
                    cleanupGuard();
                    string current = read();
                    if (current == marker)
                    {
                        cleanupGuard();
                        Need(read() == marker, "UI_CONTROLS_SEARCH_CHANGED");
                        result.ClearAttempted = true;
                        write("");
                        result.Restored = read() == "";
                        Need(result.Restored, "UI_CONTROLS_SEARCH_RESTORE_UNCONFIRMED");
                    }
                    else if (current == "")
                        result.Restored = true;
                    else
                    {
                        result.RestoreSkipped = true;
                        result.RestoreError = "UI_CONTROLS_SEARCH_CHANGED";
                    }
                }
                catch (Exception error)
                {
                    result.RestoreSkipped = !result.ClearAttempted;
                    result.RestoreError = ErrorCode(error);
                }
            }
        }
        return result;
    }
    static object ProbeSearch(Binding b)
    {
        using (var gate = new Mutex(false, "Local\\WeChatAgent.UiInput.v1"))
        {
            bool held = false;
            IntPtr process = IntPtr.Zero;
            try
            {
                try
                {
                    held = gate.WaitOne(0);
                }
                catch (AbandonedMutexException)
                {
                    held = true;
                    throw new Fault("UI_CONTROLS_INPUT_LOCK_ABANDONED");
                }
                Need(held, "UI_CONTROLS_INPUT_ALREADY_OWNED");
                process = OpenProcess(0x1000 | 0x100000, false, b.Pid);
                Need(process != IntPtr.Zero, "UI_CONTROLS_PROCESS_UNAVAILABLE");
                var before = Observe(b, process);
                BackgroundOnly(b.Pid);
                UiAccessed = true;
                var timer = Stopwatch.StartNew();
                var root = AutomationElement.FromHandle(b.Window);
                Need(root != null && root.Current.ClassName == "mmui::MainWindow", "UI_CONTROLS_ROOT_UNAVAILABLE");
                int[] rootId = root.GetRuntimeId();
                var editor = SearchEditor(root, b.Pid);
                int[] editorId = editor.GetRuntimeId();
                object pattern;
                Need(editor.TryGetCurrentPattern(ValuePattern.Pattern, out pattern),
                     "UI_CONTROLS_SEARCH_VALUE_UNAVAILABLE");
                var value = (ValuePattern)pattern;
                Need(!value.Current.IsReadOnly, "UI_CONTROLS_SEARCH_READ_ONLY");
                string marker = "WeChatAgent_probe_" + Guid.NewGuid().ToString("N");
                Action guard = delegate
                {
                    ProbeBinding(b, process, before, rootId, editor, editorId, true);
                };
                Action cleanupGuard = delegate
                {
                    ProbeBinding(b, process, before, rootId, editor, editorId, true, true);
                };
                var result = ProbeValue(
                    delegate {
                        SearchValueRead = true;
                        return value.Current.Value;
                    },
                    delegate(string text) {
                        ControlWriteAttempted = true;
                        value.SetValue(text);
                    },
                    guard, cleanupGuard, marker);
                Dictionary<string, object> after = null;
                bool stable = false;
                string finalError = null;
                try
                {
                    after = ProbeBinding(b, process, before, rootId, editor, editorId, true);
                    stable = true;
                }
                catch (Exception error)
                {
                    finalError = ErrorCode(error);
                    try
                    {
                        after = Observe(b, process);
                    }
                    catch
                    {
                    }
                }
                bool ok = result.Error == null && result.RestoreError == null && finalError == null &&
                          result.ReadbackVerified && result.Restored;
                uint foregroundPid = 0;
                if (after != null)
                    GetWindowThreadProcessId(
                        new IntPtr(Int64.Parse((string)after["foregroundHwnd"], CultureInfo.InvariantCulture)),
                        out foregroundPid);
                bool activated = result.WriteAttempted && after != null && !Same(before, after, "foregroundHwnd") &&
                                 foregroundPid == b.Pid;
                return Data("ok", ok, "schemaVersion", 1, "backend", "background-controls", "operation", "probe-search",
                            "diagnosticOnly", true, "eligibleForAutomation", false, "readOnly", false, "inputSent",
                            result.WriteAttempted, "messageSendAttempted", false, "namesAndValuesRead", SearchValueRead,
                            "searchValueRead", SearchValueRead, "searchValueIncluded", false, "originalEmpty",
                            result.OriginalEmpty, "writeAttempted", result.WriteAttempted, "readbackVerified",
                            result.ReadbackVerified, "clearAttempted", result.ClearAttempted, "restored",
                            result.Restored, "restoreSkipped", result.RestoreSkipped, "error",
                            result.Error ?? finalError ?? result.RestoreError, "restoreError", result.RestoreError,
                            "bindingStable", stable, "wechatBecameForeground", activated, "providerActivationVerified",
                            false, "foregroundUnchanged", after != null && Same(before, after, "foregroundHwnd"),
                            "inputTickUnchanged", after != null && Same(before, after, "lastInputTick"),
                            "cursorUnchanged",
                            after != null && Same(before, after, "cursorX") && Same(before, after, "cursorY"), "before",
                            before, "after", after, "elapsedMs", timer.ElapsedMilliseconds);
            }
            finally
            {
                if (process != IntPtr.Zero)
                    CloseHandle(process);
                if (held)
                    gate.ReleaseMutex();
            }
        }
    }
    static bool IsProbeMarker(string value)
    {
        return value != null &&
               System.Text.RegularExpressions.Regex.IsMatch(value, "\\AWeChatAgent_probe_[a-f0-9]{32}\\z");
    }
    static object CleanupSearch(Binding b)
    {
        using (var gate = new Mutex(false, "Local\\WeChatAgent.UiInput.v1"))
        {
            bool held = false;
            IntPtr process = IntPtr.Zero;
            try
            {
                try
                {
                    held = gate.WaitOne(0);
                }
                catch (AbandonedMutexException)
                {
                    held = true;
                    throw new Fault("UI_CONTROLS_INPUT_LOCK_ABANDONED");
                }
                Need(held, "UI_CONTROLS_INPUT_ALREADY_OWNED");
                process = OpenProcess(0x1000 | 0x100000, false, b.Pid);
                Need(process != IntPtr.Zero, "UI_CONTROLS_PROCESS_UNAVAILABLE");
                var before = Observe(b, process);
                UiAccessed = true;
                var root = AutomationElement.FromHandle(b.Window);
                Need(root != null && root.Current.ClassName == "mmui::MainWindow", "UI_CONTROLS_ROOT_UNAVAILABLE");
                int[] rootId = root.GetRuntimeId();
                var editor = SearchEditor(root, b.Pid);
                int[] editorId = editor.GetRuntimeId();
                object pattern;
                Need(editor.TryGetCurrentPattern(ValuePattern.Pattern, out pattern),
                     "UI_CONTROLS_SEARCH_VALUE_UNAVAILABLE");
                var value = (ValuePattern)pattern;
                Need(!value.Current.IsReadOnly, "UI_CONTROLS_SEARCH_READ_ONLY");
                SearchValueRead = true;
                string marker = value.Current.Value;
                Need(IsProbeMarker(marker), "UI_CONTROLS_SEARCH_PROBE_MARKER_MISSING");
                ProbeBinding(b, process, before, rootId, editor, editorId, true, true);
                Need(value.Current.Value == marker, "UI_CONTROLS_SEARCH_CHANGED");
                ControlWriteAttempted = true;
                value.SetValue("");
                bool restored = value.Current.Value == "";
                Need(restored, "UI_CONTROLS_SEARCH_RESTORE_UNCONFIRMED");
                var after = ProbeBinding(b, process, before, rootId, editor, editorId, true, true);
                return Data("ok", true, "schemaVersion", 1, "backend", "background-controls", "operation",
                            "cleanup-search-probe", "diagnosticOnly", true, "eligibleForAutomation", false, "readOnly",
                            false, "inputSent", true, "messageSendAttempted", false, "namesAndValuesRead", true,
                            "searchValueIncluded", false, "clearAttempted", true, "restored", restored, "bindingStable",
                            true, "foregroundUnchanged", Same(before, after, "foregroundHwnd"), "inputTickUnchanged",
                            Same(before, after, "lastInputTick"), "before", before, "after", after);
            }
            finally
            {
                if (process != IntPtr.Zero)
                    CloseHandle(process);
                if (held)
                    gate.ReleaseMutex();
            }
        }
    }
    static bool ParseArguments(string[] args)
    {
        bool probe = args.Length == 4 && (args[0] == "--probe-search" || args[0] == "--cleanup-search-probe") &&
                     args[3] == "--allow-control-write";
        Need((probe || args.Length == 3 && (args[0] == "--inspect" || args[0] == "--snapshot" ||
                                            args[0] == "--layout" || args[0] == "--verify-layout")) &&
                 args[1] == "--request",
             "UI_CONTROLS_ARGUMENTS_INVALID");
        return probe;
    }
    static void Reject(Action action, string code)
    {
        try
        {
            action();
        }
        catch (Fault error)
        {
            Need(error.Message == code, "UI_CONTROLS_TEST_WRONG_FAULT");
            return;
        }
        throw new Fault("UI_CONTROLS_TEST_ACCEPTED");
    }
    static int SelfTest()
    {
        int n = 0;
        var request = Data("version", 1, "hwnd", "42", "pid", 123, "processCreatedFileTimeUtc", "134374923857440392",
                           "executable", @"D:\Weixin\Weixin.exe");
        var binding = Parse(request);
        Need(binding.Pid == 123 && binding.Window.ToInt64() == 42 && binding.Created == 134374923857440392,
             "UI_CONTROLS_TEST_BINDING");
        n++;
        foreach (object pid in new object[] { 0, -1, 2147483648L })
        {
            request["pid"] = pid;
            Reject(delegate { Parse(request); },
                   Convert.ToInt64(pid) < 0 ? "UI_CONTROLS_NUMBER_INVALID" : "UI_CONTROLS_PID_INVALID");
            n++;
        }
        request["pid"] = "123";
        Reject(delegate { Parse(request); }, "UI_CONTROLS_NUMBER_INVALID");
        n++;
        request["pid"] = 123;
        foreach (string key in new[] { "hwnd", "processCreatedFileTimeUtc" })
        {
            var original = request[key];
            foreach (object invalid in new object[] { 42, "0", "-1", "+42", " 42", "9223372036854775808" })
            {
                request[key] = invalid;
                Reject(delegate { Parse(request); }, "UI_CONTROLS_ID_INVALID");
                n++;
            }
            request[key] = original;
        }
        request["executable"] = @"D:\other.exe";
        Reject(delegate { Parse(request); }, "UI_CONTROLS_EXECUTABLE_INVALID");
        n++;
        request["executable"] = @"D:\Weixin\Weixin.exe";
        request["maxNodes"] = 2049;
        Reject(delegate { Parse(request); }, "UI_CONTROLS_LIMIT_INVALID");
        n++;
        request.Remove("maxNodes");
        request["maxDepth"] = 0;
        Reject(delegate { Parse(request); }, "UI_CONTROLS_LIMIT_INVALID");
        n++;
        request.Remove("maxDepth");
        request["allowInput"] = true;
        Reject(delegate { Parse(request); }, "UI_CONTROLS_REQUEST_INVALID");
        n++;
        var staticId = AutomationIdReport("chat_input_field");
        var privateId = AutomationIdReport("wxid_private-fixture");
        var emptyId = AutomationIdReport("");
        Need((string)staticId["automationId"] == "chat_input_field" && privateId["automationId"] == null &&
                 (string)privateId["automationIdSha256"] == Hash("wxid_private-fixture") &&
                 !(bool)emptyId["automationIdPresent"],
             "UI_CONTROLS_TEST_PRIVACY");
        n++;
        Need(
            PatternProperties[AutomationElement.IsValuePatternAvailableProperty] == "ValuePatternIdentifiers.Pattern" &&
                PatternProperties[AutomationElement.IsInvokePatternAvailableProperty] ==
                    "InvokePatternIdentifiers.Pattern" &&
                PatternProperties[AutomationElement.IsTextPatternAvailableProperty] == "TextPatternIdentifiers.Pattern",
            "UI_CONTROLS_TEST_PATTERN_CLASSIFICATION");
        n++;
        var root = new Fixture { Name = "root" };
        var first = new Fixture { Name = "one" };
        var second = new Fixture { Name = "two" };
        root.Children.Add(first);
        root.Children.Add(second);
        first.Next = second;
        first.Children.Add(new Fixture { Name = "leaf" });
        Func<Fixture, Fixture> child = delegate(Fixture f)
        {
            return f.Children.Count == 0 ? null : f.Children[0];
        };
        Func<Fixture, Fixture> sibling = delegate(Fixture f)
        {
            return f.Next;
        };
        Func<Fixture, Dictionary<string, object>> describe = delegate(Fixture f)
        {
            return Data("fixture", f.Name);
        };
        var walked = Walk(root, child, sibling, describe, 4, 4, delegate { return false; });
        Need(walked.Complete && walked.Nodes.Count == 4 &&
                 (int)((Dictionary<string, object>)walked.Nodes[2])["parent"] == 1,
             "UI_CONTROLS_TEST_TREE");
        n++;
        walked = Walk(root, child, sibling, describe, 3, 4, delegate { return false; });
        Need(!walked.Complete && walked.Nodes.Count == 3 && walked.Reason == "UI_CONTROLS_NODE_LIMIT",
             "UI_CONTROLS_TEST_NODE_LIMIT");
        n++;
        walked = Walk(root, child, sibling, describe, 4, 1, delegate { return false; });
        Need(!walked.Complete && walked.Nodes.Count == 2 && walked.Reason == "UI_CONTROLS_DEPTH_LIMIT",
             "UI_CONTROLS_TEST_DEPTH_LIMIT");
        n++;
        walked = Walk(root, child, sibling, describe, 4, 4, delegate { return true; });
        Need(!walked.Complete && walked.Nodes.Count == 0 && walked.Reason == "UI_CONTROLS_DEADLINE",
             "UI_CONTROLS_TEST_DEADLINE");
        n++;
        Need(SearchSelector("mmui::XValidatorTextEdit", "ControlType.Edit",
                            new[] { "mmui::XSearchField", "mmui::ChatMasterView" }),
             "UI_CONTROLS_TEST_SEARCH_SELECTOR");
        n++;
        foreach (var parents in new[] { new[] { "mmui::XSearchField" }, new[] { "mmui::Other", "mmui::ChatMasterView" },
                                        new[] { "mmui::ChatMasterView", "mmui::XSearchField" } })
        {
            Need(!SearchSelector("mmui::XValidatorTextEdit", "ControlType.Edit", parents),
                 "UI_CONTROLS_TEST_SEARCH_SELECTOR_BROAD");
            n++;
        }
        Need(!SearchSelector("mmui::ChatInputField", "ControlType.Edit",
                             new[] { "mmui::XSearchField", "mmui::ChatMasterView" }) &&
                 !SearchSelector("mmui::XValidatorTextEdit", "ControlType.Button",
                                 new[] { "mmui::XSearchField", "mmui::ChatMasterView" }),
             "UI_CONTROLS_TEST_SEARCH_EXCLUDES_EDITOR");
        n++;
        foreach (var args in new[] { new[] { "--probe-search", "--request", "fixture.json" },
                                     new[] { "--inspect", "--request", "fixture.json", "--allow-control-write" },
                                     new[] { "--probe-search", "--request", "fixture.json", "--enable-input" },
                                     new string[0] })
        {
            Reject(delegate { ParseArguments(args); }, "UI_CONTROLS_ARGUMENTS_INVALID");
            n++;
        }
        Need(ParseArguments(new[] { "--probe-search", "--request", "fixture.json", "--allow-control-write" }) &&
                 !ParseArguments(new[] { "--inspect", "--request", "fixture.json" }),
             "UI_CONTROLS_TEST_WRITE_OPT_IN");
        n++;
        string stored = "";
        var writes = new List<string>();
        Action<string> write = delegate(string text)
        {
            writes.Add(text);
            stored = text;
        };
        Func<string> read = delegate
        {
            return stored;
        };
        Action pass = delegate {};
        var probe = ProbeValue(read, write, pass, pass, "marker");
        Need(probe.ReadbackVerified && probe.Restored && probe.ClearAttempted && writes.Count == 2 &&
                 writes[0] == "marker" && writes[1] == "" && probe.Error == null,
             "UI_CONTROLS_TEST_PROBE_RESTORES");
        n++;
        writes.Clear();
        stored = "user search";
        probe = ProbeValue(read, write, pass, pass, "marker");
        Need(!probe.WriteAttempted && writes.Count == 0 && stored == "user search" &&
                 probe.Error == "UI_CONTROLS_SEARCH_NOT_EMPTY",
             "UI_CONTROLS_TEST_PROBE_PRESERVES_SEARCH");
        n++;
        writes.Clear();
        stored = "";
        probe =
            ProbeValue(read, write, delegate { throw new Fault("UI_CONTROLS_USER_ACTIVITY_CHANGED"); }, pass, "marker");
        Need(!probe.WriteAttempted && writes.Count == 0, "UI_CONTROLS_TEST_PROBE_GUARD");
        n++;
        writes.Clear();
        stored = "";
        int guardCalls = 0;
        probe = ProbeValue(read, write, delegate {
            if (++guardCalls == 2)
                stored = "new query";
        }, pass, "marker");
        Need(!probe.WriteAttempted && writes.Count == 0 && stored == "new query" &&
                 probe.Error == "UI_CONTROLS_SEARCH_NOT_EMPTY",
             "UI_CONTROLS_TEST_PROBE_RECHECK_EMPTY");
        n++;
        writes.Clear();
        stored = "";
        probe = ProbeValue(read, delegate(string text) {
            write(text);
            if (text == "marker")
                throw new Fault("UI_CONTROLS_PROVIDER_FAILED");
        }, pass, pass, "marker");
        Need(probe.WriteAttempted && probe.Restored && probe.ClearAttempted && writes.Count == 2 &&
                 probe.Error == "UI_CONTROLS_PROVIDER_FAILED",
             "UI_CONTROLS_TEST_PROBE_EXCEPTION_CLEANUP");
        n++;
        writes.Clear();
        stored = "";
        probe = ProbeValue(read, write, pass, delegate { stored = "new user search"; }, "marker");
        Need(probe.RestoreSkipped && !probe.ClearAttempted && stored == "new user search" && writes.Count == 1,
             "UI_CONTROLS_TEST_PROBE_NO_OVERWRITE");
        n++;
        writes.Clear();
        stored = "";
        int cleanupCalls = 0;
        probe = ProbeValue(read, write, pass, delegate {
            if (++cleanupCalls == 2)
                stored = "later user search";
        }, "marker");
        Need(probe.RestoreSkipped && !probe.ClearAttempted && stored == "later user search" && writes.Count == 1,
             "UI_CONTROLS_TEST_PROBE_RECHECK_CLEANUP");
        n++;
        writes.Clear();
        stored = "";
        probe = ProbeValue(read, write, pass, delegate { throw new Fault("UI_CONTROLS_WINDOW_CHANGED"); }, "marker");
        Need(probe.RestoreSkipped && !probe.Restored && writes.Count == 1 &&
                 probe.RestoreError == "UI_CONTROLS_WINDOW_CHANGED",
             "UI_CONTROLS_TEST_PROBE_NO_REUSED_WINDOW");
        n++;
        writes.Clear();
        stored = "";
        probe = ProbeValue(read, delegate(string text) {
            if (text == "marker")
                write("different");
            else
                write(text);
        }, pass, pass, "marker");
        Need(!probe.ReadbackVerified && probe.Error == "UI_CONTROLS_SEARCH_READBACK_MISMATCH" && probe.RestoreSkipped &&
                 writes.Count == 1,
             "UI_CONTROLS_TEST_PROBE_READBACK");
        n++;
        writes.Clear();
        stored = "";
        guardCalls = 0;
        probe = ProbeValue(read, write, delegate {
            if (++guardCalls == 3)
                throw new Fault("UI_CONTROLS_WECHAT_FOREGROUND");
        }, pass, "marker");
        Need(probe.ReadbackVerified && probe.Restored && probe.ClearAttempted && stored == "" &&
                 probe.Error == "UI_CONTROLS_WECHAT_FOREGROUND",
             "UI_CONTROLS_TEST_FOREGROUND_CHANGE_CLEANUP");
        n++;
        var oldState = Data("foregroundHwnd", "100", "lastInputTick", 123);
        var activatedState = Data("foregroundHwnd", "200", "lastInputTick", 123);
        Need(!ProbeUserState(oldState, activatedState, false) && ProbeUserState(oldState, activatedState, true),
             "UI_CONTROLS_TEST_FOREGROUND_CHANGE_GUARD");
        n++;
        activatedState["lastInputTick"] = 124;
        Need(!ProbeUserState(oldState, activatedState, true), "UI_CONTROLS_TEST_CLEANUP_HUMAN_ACTIVITY");
        n++;
        Need(IsProbeMarker("WeChatAgent_probe_" + new string('a', 32)), "UI_CONTROLS_TEST_MARKER");
        n++;
        foreach (string invalid in new[] { "", "user query", "WeChatAgent_probe_" + new string('A', 32),
                                           "WeChatAgent_probe_" + new string('a', 31),
                                           "WeChatAgent_probe_" + new string('a', 32) + "\n",
                                           "prefixWeChatAgent_probe_" + new string('a', 32) })
        {
            Need(!IsProbeMarker(invalid), "UI_CONTROLS_TEST_MARKER_BROAD");
            n++;
        }
        Need(ParseArguments(new[] { "--cleanup-search-probe", "--request", "fixture.json", "--allow-control-write" }),
             "UI_CONTROLS_TEST_CLEANUP_OPT_IN");
        n++;
        Reject(delegate { ParseArguments(new[] { "--cleanup-search-probe", "--request", "fixture.json" }); },
               "UI_CONTROLS_ARGUMENTS_INVALID");
        n++;
        n += LayoutSelfTest() + VerifyLayoutSelfTest();
        Console.WriteLine(
            Json.Serialize(Data("ok", true, "checks", n, "uiAccessed", false, "inputSent", false, "readOnly", true)));
        return 0;
    }
    [MTAThread]
    static int Main(string[] args)
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        try
        {
            if (args.Length == 1 && args[0] == "--serve-layout")
                return ServeVerifier();
            if (args.Length == 1 && args[0] == "--self-test")
                return SelfTest();
            bool probe = ParseArguments(args);
            var request = ReadRequest(args[2]);
            object resultObject;
            if (args[0] == "--verify-layout")
                resultObject = VerifierRequest(request);
            else
            {
                var binding = Parse(request);
                resultObject = args[0] == "--layout"                 ? InspectLayout(binding)
                               : args[0] == "--cleanup-search-probe" ? CleanupSearch(binding)
                               : probe                               ? ProbeSearch(binding)
                                                                     : Inspect(binding);
            }
            var result = (Dictionary<string, object>)resultObject;
            Console.WriteLine(Json.Serialize(result));
            return (bool)result["ok"] ? 0 : 1;
        }
        catch (Exception error)
        {
            Console.WriteLine(Json.Serialize(ErrorReport(error)));
            return 1;
        }
    }
    [DllImport("user32.dll")]
    static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")]
    static extern bool IsWindowVisible(IntPtr h);
    [DllImport("user32.dll")]
    static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")]
    static extern IntPtr GetAncestor(IntPtr h, uint flags);
    [DllImport("user32.dll")]
    static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int GetClassName(IntPtr h, StringBuilder text, int count);
    [DllImport("user32.dll")]
    static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll")]
    static extern bool GetLastInputInfo(ref LastInput input);
    [DllImport("kernel32.dll")]
    static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")]
    static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll")]
    static extern bool GetProcessTimes(IntPtr h, out FileTime start, out FileTime exit, out FileTime kernel,
                                       out FileTime user);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern bool QueryFullProcessImageName(IntPtr h, uint flags, StringBuilder name, ref uint size);
    [DllImport("kernel32.dll")]
    static extern bool ProcessIdToSessionId(uint pid, out uint session);
}
