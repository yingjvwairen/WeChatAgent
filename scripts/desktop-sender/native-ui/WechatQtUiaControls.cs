// Native UIA observations are metadata, never substitute or fabricated RGBA.
// Tokens retain their native lease/activity ownership; callers cannot mint them.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;

internal static partial class WechatDraftProbe
{
    sealed class QtUiaNode
    {
        internal AutomationElement Element;
        internal QtUiaNode Parent;
        internal string Class, Id, Runtime;
        internal ControlType Type;
        internal Rect Rect;
        internal bool Offscreen, Enabled;
        internal int Pid, NativeWindowHandle;
    }
    sealed class QtUiaRole
    {
        internal string Role, Hash;
        internal QtUiaNode Node;
    }
    static Exception QtUiaRectChanged(string purpose, string role, Rect expected, Rect observed)
    {
        var error = new Fault("QT_UIA_CONTROL_RECT_CHANGED");
        error.Data["QtUiaControlRect"] =
            Data("version", 1, "phase", purpose, "role", role, "expected", expected.Report(), "observed",
                 observed.Report(), "inputAttempted", InputAttempted);
        return error;
    }
    static Dictionary<string, QtUiaRole> QtUiaCachedRoles;
    static Binding QtUiaCachedBinding;
    [DllImport("user32.dll", EntryPoint = "SetThreadDpiAwarenessContext")]
    static extern IntPtr QtUiaSetThreadDpiAwarenessContext(IntPtr value);
    // A locator has no focus/input authority. Reusing its address across a
    // foreground transition still requires fresh root, ancestry and leaf reads.
    // Do not use this weaker comparator for frames, leases or input guards.
    static bool QtUiaLocatorBindingMatches(Binding a, Binding b)
    {
        return a != null && b != null && a.Window == b.Window && a.Pid == b.Pid && a.Created == b.Created &&
               a.Thread == b.Thread && a.Dpi == b.Dpi && Same(a.Client, b.Client) && Same(a.Capture, b.Capture);
    }
    static void QtUiaClearLocators()
    {
        QtUiaCachedRoles = null;
        QtUiaCachedBinding = null;
    }
    static Dictionary<string, object> QtUiaWarmExpected(object value)
    {
        var expected = Map(value);
        Need(expected != null && expected.Count == 6, "QT_UIA_WARM_REQUEST_INVALID");
        foreach (string key in new[] { "hwnd", "pid", "processCreatedFileTimeUtc", "dpi", "clientRect", "captureRect" })
            Need(expected.ContainsKey(key), "QT_UIA_WARM_REQUEST_INVALID");
        Need(DecimalString(Get(expected, "hwnd")) > 0 && Number(Get(expected, "pid")) > 0 &&
                 Number(Get(expected, "pid")) <= Int32.MaxValue &&
                 DecimalString(Get(expected, "processCreatedFileTimeUtc")) > 0 && Number(Get(expected, "dpi")) >= 48 &&
                 Number(Get(expected, "dpi")) <= 768,
             "QT_UIA_WARM_REQUEST_INVALID");
        Rect client = ParseRect(Get(expected, "clientRect")), capture = ParseRect(Get(expected, "captureRect"));
        Need(client.Left == 0 && client.Top == 0 && client.Width >= 600 && client.Width <= 4096 &&
                 client.Height >= 400 && client.Height <= 4096 && client.Width == capture.Width &&
                 client.Height == capture.Height,
             "QT_UIA_WARM_REQUEST_INVALID");
        return expected;
    }
    static Binding QtUiaWarmBinding(Dictionary<string, object> expected)
    {
        IntPtr window = new IntPtr(DecimalString(Get(expected, "hwnd")));
        Need(QtWindow == IntPtr.Zero || QtWindow == window, "QT_BINDING_CHANGED");
        var identity = QtFocusWindow(window, QtExecutable);
        Need(GetWindow(window, 4) == IntPtr.Zero, "QT_BINDING_CHANGED");
        uint pid;
        uint thread = GetWindowThreadProcessId(window, out pid);
        Rect client = new Rect();
        Point origin = new Point(0, 0);
        Need(thread != 0 && pid == identity.Pid && GetClientRect(window, out client) &&
                 ClientToScreen(window, ref origin),
             "QT_BINDING_CHANGED");
        var result =
            new Binding { Window = window,
                          Pid = pid,
                          Created = identity.Created,
                          Thread = thread,
                          Dpi = GetDpiForWindow(window),
                          Client = client,
                          Capture = new Rect(origin.X, origin.Y, origin.X + client.Width, origin.Y + client.Height) };
        Need(QtLayoutExpectedMatches(expected, Map(result.Report())), "QT_BINDING_CHANGED");
        return result;
    }
    static void QtUiaWarmLocatorTransaction(Action guard, Action warm, Action discard)
    {
        bool complete = false;
        try
        {
            guard();
            warm();
            guard();
            complete = true;
        }
        finally
        {
            if (!complete)
                discard();
        }
    }
    static object QtUiaWarmReport(Binding binding, IntPtr foreground)
    {
        return Data("version", 1, "warmed", true, "readOnly", true, "inputSent", false, "focusChanged", false,
                    "clipboardAccessed", false, "authorizationGranted", false, "foregroundUnchanged", true,
                    "inputTickUnchanged", true, "cursorUnchanged", true, "binding",
                    Data("hwnd", binding.Window.ToInt64().ToString(System.Globalization.CultureInfo.InvariantCulture),
                         "pid", binding.Pid, "processCreatedFileTimeUtc",
                         binding.Created.ToString(System.Globalization.CultureInfo.InvariantCulture), "dpi",
                         binding.Dpi, "clientRect", binding.Client.Report(), "captureRect", binding.Capture.Report(),
                         "foreground", foreground == binding.Window),
                    "roles", new[] { "header", "editor", "send" });
    }
    static object QtWarmUiaLocators(Dictionary<string, object> request)
    {
        IntPtr previousDpi = IntPtr.Zero;
        try
        {
            foreach (string key in request.Keys)
                Need(key == "id" || key == "action" || key == "expectedBinding", "QT_UIA_WARM_REQUEST_INVALID");
            var expected = QtUiaWarmExpected(Get(request, "expectedBinding"));
            Need(!Stopping && QtFocus.Active == null && QtFocus.Parked == null && QtPopup == null &&
                     QtPendingPopup == null && QtSurface == "main",
                 "QT_UIA_WARM_UNAVAILABLE");
            previousDpi = QtUiaSetThreadDpiAwarenessContext(new IntPtr(-4));
            Need(previousDpi != IntPtr.Zero, "QT_UIA_WARM_DPI_UNAVAILABLE");
            long revision = Interlocked.Read(ref Revision);
            uint tick = QtInputTick();
            IntPtr foreground = GetForegroundWindow();
            Point pointer;
            Need(FocusGetCursorPos(out pointer), "QT_POINTER_UNAVAILABLE");
            Binding binding = QtUiaWarmBinding(expected);
            Action guard = delegate
            {
                Need(!Stopping && QtFocus.Active == null && QtFocus.Parked == null && QtPopup == null &&
                         QtPendingPopup == null && QtSurface == "main",
                     "QT_UIA_WARM_UNAVAILABLE");
                Need(QtUiaLocatorBindingMatches(binding, QtUiaWarmBinding(expected)), "QT_BINDING_CHANGED");
                Point at;
                Need(revision == Interlocked.Read(ref Revision) && tick == QtInputTick() &&
                         foreground == GetForegroundWindow() && FocusGetCursorPos(out at) && QtSamePoint(pointer, at),
                     "QT_HUMAN_ACTIVITY_CHANGED");
            };
            QtUiaWarmLocatorTransaction(guard, delegate {
                QtUiaResolveRoles(binding, new[] { "header", "editor", "send" });
            }, QtUiaClearLocators);
            // Only COM locators survive. No frame, token, focus lease or input
            // readiness is issued; the later foreground capture refreshes them.
            return QtUiaWarmReport(binding, foreground);
        }
        catch
        {
            QtUiaClearLocators();
            throw;
        }
        finally
        {
            if (previousDpi != IntPtr.Zero)
                QtUiaSetThreadDpiAwarenessContext(previousDpi);
        }
    }
    static CacheRequest QtUiaControlCache()
    {
        var cache =
            new CacheRequest { TreeScope = TreeScope.Element, AutomationElementMode = AutomationElementMode.Full };
        foreach (var property in new[] { AutomationElement.ClassNameProperty, AutomationElement.AutomationIdProperty,
                                         AutomationElement.ControlTypeProperty,
                                         AutomationElement.BoundingRectangleProperty,
                                         AutomationElement.ProcessIdProperty,
                                         AutomationElement.NativeWindowHandleProperty,
                                         AutomationElement.IsOffscreenProperty, AutomationElement.IsEnabledProperty })
            cache.Add(property);
        return cache;
    }
    // The caller obtains this element with QtUiaControlCache. TreeWalker already
    // populates that cache; updating it here used to issue a second provider read
    // for every visited node. Never pass a prior operation's cache as fresh.
    static QtUiaNode QtUiaReadControl(AutomationElement element, QtUiaNode parent, Binding binding)
    {
        var info = element.Cached;
        var area = info.BoundingRectangle;
        var rect = new Rect();
        if (!area.IsEmpty)
        {
            Need(!Double.IsNaN(area.Left) && !Double.IsInfinity(area.Left) && !Double.IsNaN(area.Top) &&
                     !Double.IsInfinity(area.Top) && !Double.IsNaN(area.Right) && !Double.IsInfinity(area.Right) &&
                     !Double.IsNaN(area.Bottom) && !Double.IsInfinity(area.Bottom),
                 "QT_UIA_CONTROL_RECT_INVALID");
            rect = new Rect(checked((int)Math.Ceiling(area.Left)) - binding.Capture.Left,
                            checked((int)Math.Ceiling(area.Top)) - binding.Capture.Top,
                            checked((int)Math.Floor(area.Right)) - binding.Capture.Left,
                            checked((int)Math.Floor(area.Bottom)) - binding.Capture.Top);
        }
        int[] runtime = element.GetRuntimeId();
        Need(runtime != null && runtime.Length > 0 && runtime.Length <= 64, "QT_UIA_CONTROL_RUNTIME_INVALID");
        return new QtUiaNode { Element = element,
                               Parent = parent,
                               Class = info.ClassName,
                               Id = info.AutomationId,
                               Type = info.ControlType,
                               Rect = rect,
                               Pid = info.ProcessId,
                               NativeWindowHandle = info.NativeWindowHandle,
                               Offscreen = info.IsOffscreen,
                               Enabled = info.IsEnabled,
                               Runtime = String.Join(",", Array.ConvertAll(runtime, delegate(int n) {
                                   return n.ToString(System.Globalization.CultureInfo.InvariantCulture);
                               })) };
    }
    static QtUiaNode QtUiaAncestor(QtUiaNode node, string cls)
    {
        for (var parent = node.Parent; parent != null; parent = parent.Parent)
            if (parent.Class == cls)
                return parent;
        return null;
    }
    static string QtUiaControlRole(QtUiaNode node)
    {
        if (node.Class == "mmui::XValidatorTextEdit" && node.Type == ControlType.Edit && node.Parent != null &&
            node.Parent.Class == "mmui::XSearchField" && QtUiaAncestor(node, "mmui::ChatMasterView") != null)
            return "search";
        var page = QtUiaAncestor(node, "mmui::ChatMessagePage");
        if (page == null)
            return null;
        if (node.Class == "mmui::ChatTitleBarMasterView")
            return "header";
        if (QtUiaAncestor(node, "mmui::ChatInputView") == null)
            return null;
        if (node.Class == "mmui::ChatInputField" && node.Type == ControlType.Edit && node.Id == "chat_input_field")
            return "editor";
        if ((node.Class == "mmui::XButton" || node.Class == "mmui::XOutlineButton") &&
            node.Type == ControlType.Button && QtUiaAncestor(node, "mmui::ChatInputToolbarRightView") != null)
            return "send-candidate";
        return null;
    }
    static bool QtUiaSendText(string value)
    {
        return value == "发送" || value == "Send";
    }
    static bool QtUiaSendLabel(AutomationElement element)
    {
        // Label reads are restricted to an identified toolbar button. Generic
        // node caches must never request names from message/editor subtrees.
        var cache = new CacheRequest();
        cache.TreeScope = TreeScope.Element;
        cache.Add(AutomationElement.NameProperty);
        cache.Add(AutomationElement.HelpTextProperty);
        var label = element.GetUpdatedCache(cache).Cached;
        if (QtUiaSendText(label.Name) || QtUiaSendText(label.HelpText))
            return true;
        using (cache.Activate())
        {
            var children = element.FindAll(
                TreeScope.Children,
                new AndCondition(new PropertyCondition(AutomationElement.ClassNameProperty, "mmui::XTextView"),
                                 new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Text)));
            return children.Count == 1 && QtUiaSendText(children[0].Cached.Name);
        }
    }
    static string QtUiaRoleHash(QtUiaNode node, string role, bool includeGeometry = true)
    {
        var values = new StringBuilder(role);
        for (var item = node; item != null; item = item.Parent)
        {
            values.Append('|')
                .Append(item.Runtime)
                .Append('|')
                .Append(item.Class)
                .Append('|')
                .Append(item.Type.ProgrammaticName);
            if (includeGeometry && Object.ReferenceEquals(item, node))
                values.Append('|')
                    .Append(item.Rect.Left)
                    .Append(',')
                    .Append(item.Rect.Top)
                    .Append(',')
                    .Append(item.Rect.Right)
                    .Append(',')
                    .Append(item.Rect.Bottom);
            if (item.Id == "chat_input_field")
                values.Append("|chat_input_field");
        }
        return QtHash(Encoding.UTF8.GetBytes(values.ToString()));
    }
    static bool QtUiaRoleObservationMatches(QtUiaRole expected, QtUiaNode current, bool preserveGeometry)
    {
        return preserveGeometry
                   ? Same(current.Rect, expected.Node.Rect) && QtUiaRoleHash(current, expected.Role) == expected.Hash
                   : QtUiaRoleHash(current, expected.Role, false) == QtUiaRoleHash(expected.Node, expected.Role, false);
    }
    static bool QtUiaSkipContent(QtUiaNode node)
    {
        return node.Type == ControlType.List || node.Type == ControlType.ListItem ||
               node.Class == "mmui::ChatMessageView" || node.Class == "mmui::ChatMessageListView" ||
               node.Class == "mmui::ChatTitleBarMasterView" || node.Type == ControlType.Edit ||
               node.Type == ControlType.Button;
    }
    // FromHandle identifies the real root HWND. Qt can leave a moved container's
    // UIA rectangle stale; that rectangle is never an input coordinate. Native
    // Win32 client geometry and each selected leaf's live bounds remain strict.
    static bool QtUiaRootMatches(QtUiaNode node, Binding binding)
    {
        return node != null && binding != null && node.Parent == null && node.Class == "mmui::MainWindow" &&
               node.Type == ControlType.Window && !node.Offscreen && node.Pid == binding.Pid &&
               !String.IsNullOrEmpty(node.Runtime) &&
               new IntPtr(unchecked((long)(uint)node.NativeWindowHandle)) == binding.Window;
    }
    static Dictionary<string, QtUiaRole> QtUiaResolveRoles(Binding binding, string[] roles)
    {
        if (QtUiaCachedRoles != null && QtUiaLocatorBindingMatches(binding, QtUiaCachedBinding))
        {
            bool available = true;
            var selected = new List<QtUiaRole>();
            foreach (string role in roles)
            {
                QtUiaRole item;
                if (!QtUiaCachedRoles.TryGetValue(role, out item))
                {
                    available = false;
                    break;
                }
                selected.Add(item);
            }
            // Stored elements are locators, never a cached authorization. A
            // search field resize needs fresh geometry, not a whole tree scan.
            // Capture still checks requested body/submit geometry exactly.
            if (available)
            {
                try
                {
                    var refreshed = QtUiaRefreshRoles(binding, selected, false);
                    foreach (var item in refreshed)
                        QtUiaCachedRoles[item.Role] = item;
                    QtUiaCachedBinding = binding;
                    return QtUiaCachedRoles;
                }
                catch (Fault)
                {
                    QtUiaClearLocators();
                }
                catch (ElementNotAvailableException)
                {
                    QtUiaClearLocators();
                }
            }
        }
        Need(FileVersionInfo.GetVersionInfo(QtExecutable).FileVersion == "4.2.0.53", "QT_UIA_VERSION_UNSUPPORTED");
        var cache = QtUiaControlCache();
        AutomationElement rootElement;
        using (cache.Activate()) rootElement = AutomationElement.FromHandle(binding.Window);
        var root = QtUiaReadControl(rootElement, null, binding);
        Need(QtUiaRootMatches(root, binding), "QT_UIA_CONTROL_ROOT_INVALID");
        var requested = new HashSet<string>(roles);
        var found = new Dictionary<string, QtUiaRole>();
        var duplicate = new HashSet<string>();
        var walker = TreeWalker.RawViewWalker;
        int visited = 0;
        long deadline = Now() + 1200;
        Action<QtUiaNode, int> walk = null;
        walk = delegate(QtUiaNode node, int depth)
        {
            Need(++visited <= 2048 && depth <= 96 && Now() <= deadline, "QT_UIA_CONTROL_SCAN_LIMIT");
            if (node.Offscreen)
                return;
            Need(node.Pid == binding.Pid, "QT_UIA_CONTROL_PROCESS_CHANGED");
            string role = QtUiaControlRole(node);
            if (role == "send-candidate")
                role = requested.Contains("send") && QtUiaSendLabel(node.Element) ? "send" : null;
            if (role != null)
            {
                if (found.ContainsKey(role))
                    duplicate.Add(role);
                else if (node.Rect.Width >= 2 && node.Rect.Height >= 2 && Contains(binding.Client, node.Rect))
                    found.Add(role, new QtUiaRole { Role = role, Node = node, Hash = QtUiaRoleHash(node, role) });
            }
            if (QtUiaSkipContent(node))
                return;
            for (var child = walker.GetFirstChild(node.Element, cache); child != null;
                 child = walker.GetNextSibling(child, cache))
                walk(QtUiaReadControl(child, node, binding), depth + 1);
        };
        walk(root, 0);
        foreach (string role in duplicate)
            found.Remove(role);
        foreach (string role in roles)
        {
            Need(!duplicate.Contains(role), "QT_UIA_CONTROL_AMBIGUOUS");
            Need(found.ContainsKey(role), "QT_UIA_CONTROL_UNAVAILABLE");
            if (role == "editor" || role == "search")
                Need(found[role].Node.Enabled, "QT_UIA_CONTROL_DISABLED");
        }
        if (found.ContainsKey("header") && found.ContainsKey("editor"))
            Need(QtUiaAncestor(found["header"].Node, "mmui::ChatMessagePage").Runtime ==
                     QtUiaAncestor(found["editor"].Node, "mmui::ChatMessagePage").Runtime,
                 "QT_UIA_CONTROL_PAGE_CHANGED");
        var verified = new List<QtUiaRole>();
        foreach (string role in roles)
            verified.Add(found[role]);
        foreach (var role in QtUiaRefreshRoles(binding, verified))
            found[role.Role] = role;
        QtUiaCachedRoles = found;
        QtUiaCachedBinding = binding;
        return found;
    }
    static bool QtUiaSameControl(QtUiaNode expected, QtUiaNode actual, uint pid)
    {
        return actual != null && actual.Pid == pid && !actual.Offscreen && actual.Runtime == expected.Runtime &&
               actual.Class == expected.Class && actual.Type == expected.Type &&
               actual.NativeWindowHandle == expected.NativeWindowHandle &&
               (expected.Id != "chat_input_field" || actual.Id == expected.Id);
    }
    // One refresh owns one local map. A refreshed child yields its actual parent
    // and that parent's metadata in the same provider call. Shared ancestors are
    // checked once, but every branch still proves its current parent identity.
    static List<QtUiaRole> QtUiaRefreshRoles(Binding binding, IList<QtUiaRole> roles, bool preserveGeometry = true)
    {
        var cache = QtUiaControlCache();
        var refreshed = new Dictionary<string, QtUiaNode>(StringComparer.Ordinal);
        var walker = TreeWalker.RawViewWalker;
        AutomationElement actualRoot;
        using (cache.Activate()) actualRoot = AutomationElement.FromHandle(binding.Window);
        Need(actualRoot != null, "QT_UIA_CONTROL_ROOT_CHANGED");
        var root = QtUiaReadControl(actualRoot, null, binding);
        Need(QtUiaRootMatches(root, binding), "QT_UIA_CONTROL_ROOT_CHANGED");
        Func<QtUiaNode, AutomationElement, QtUiaNode> read = null;
        read = delegate(QtUiaNode expected, AutomationElement current)
        {
            var observed = QtUiaReadControl(current, null, binding);
            Need(QtUiaSameControl(expected, observed, binding.Pid), "QT_UIA_CONTROL_CHANGED");
            QtUiaNode known;
            if (refreshed.TryGetValue(expected.Runtime, out known))
            {
                Need(QtUiaSameControl(known, observed, binding.Pid), "QT_UIA_CONTROL_CHANGED");
                return known;
            }
            if (expected.Parent == null)
            {
                Need(QtUiaSameControl(expected, root, binding.Pid) && root.Runtime == observed.Runtime,
                     "QT_UIA_CONTROL_ROOT_CHANGED");
                observed = root;
            }
            else
            {
                var parent = walker.GetParent(current, cache);
                Need(parent != null, "QT_UIA_CONTROL_ANCESTRY_CHANGED");
                Need(String.Join(",", parent.GetRuntimeId()) == expected.Parent.Runtime,
                     "QT_UIA_CONTROL_ANCESTRY_CHANGED");
                observed.Parent = read(expected.Parent, parent);
            }
            refreshed.Add(expected.Runtime, observed);
            return observed;
        };
        var result = new List<QtUiaRole>();
        foreach (var role in roles)
        {
            QtUiaNode node;
            if (!refreshed.TryGetValue(role.Node.Runtime, out node))
                node = read(role.Node, role.Node.Element.GetUpdatedCache(cache));
            Need(QtUiaSameControl(role.Node, node, binding.Pid) &&
                     QtUiaRoleObservationMatches(role, node, preserveGeometry),
                 "QT_UIA_CONTROL_CHANGED");
            Need(node.Rect.Width >= 2 && node.Rect.Height >= 2 && Contains(binding.Client, node.Rect),
                 "QT_UIA_CONTROL_RECT_INVALID");
            if (role.Role == "search" || role.Role == "editor")
                Need(node.Enabled, "QT_UIA_CONTROL_DISABLED");
            if (role.Role == "send")
                Need(QtUiaSendLabel(node.Element), "QT_UIA_CONTROL_CHANGED");
            result.Add(new QtUiaRole { Role = role.Role, Node = node, Hash = QtUiaRoleHash(node, role.Role) });
        }
        return result;
    }
    static void QtCheckUiaFrame(QtFrame frame)
    {
        if (frame == null || !frame.MetadataOnly)
            return;
        Need(frame.MetadataLease != null && Object.ReferenceEquals(frame.MetadataLease, QtFocus.Active) &&
                 QtFocus.Parked == null,
             "QT_UIA_CONTROL_FRAME_INVALID");
        Need(frame.UiaRoles != null && frame.UiaRoles.Count == frame.Anchors.Count, "QT_UIA_CONTROL_FRAME_INVALID");
        QtUiaRefreshRoles(frame.Binding, frame.UiaRoles);
    }
    static string[] QtUiaPurposeRoles(string purpose)
    {
        if (purpose == "navigation")
            return new[] { "header" };
        if (purpose == "search")
            return new[] { "search" };
        if (purpose == "control")
            return new[] { "header", "editor" };
        if (purpose == "image")
            return new[] { "header", "editor", "send" };
        throw new Fault("QT_UIA_CONTROL_PURPOSE_INVALID");
    }
    static Dictionary<string, object> QtCaptureUiaControls(Dictionary<string, object> request,
                                                           string purpose = "control")
    {
        QtRejectFrameAuthority(request);
        Need(QtEnableInput && QtFocus.Active != null && QtFocus.Parked == null && !Stopping, "QT_FOCUS_LEASE_REQUIRED");
        Need(!Object.Equals(Get(request, "image"), true), "QT_UIA_CONTROL_REQUEST_INVALID");
        QtCurrent = null;
        QtSelectSurface(Text(request, "surface"), Text(request, "surfaceId"));
        long revision = Interlocked.Read(ref Revision);
        Need(revision == QtFocus.Active.Revision, "QT_HUMAN_ACTIVITY_CHANGED");
        Binding before = QtBound(false);
        bool search = purpose == "search";
        Need(search ? QtSearchSurface(QtSurface) && QtPopup != null && QtPopup.Id == "search"
                    : QtSurface == "main" && QtPopup == null && QtPendingPopup == null,
             "QT_UIA_CONTROL_SURFACE_INVALID");
        var popup = search ? QtReadPopupCaptureSnapshot(QtPopup) : null;
        var names = QtUiaPurposeRoles(purpose);
        var anchors = QtParseAnchors(Get(request, "regions"), before.Client);
        Need(anchors.Count == names.Length, "QT_UIA_CONTROL_REQUEST_INVALID");
        var found = QtUiaResolveRoles(before, names);
        var selected = new List<QtUiaRole>();
        var regions = new List<object>();
        for (int i = 0; i < names.Length; i++)
        {
            var role = found[names[i]];
            // Ctrl+F changes the search field's geometry (for example when its
            // cancel control appears). The native popup lease and actual UIA
            // role identify this field; its former rectangle is only a hint.
            // All body/submit regions retain exact transaction geometry.
            if (!search && !Same(role.Node.Rect, anchors[i].Rect))
                throw QtUiaRectChanged(purpose, role.Role, anchors[i].Rect, role.Node.Rect);
            anchors[i].Rect = role.Node.Rect;
            anchors[i].Hash = role.Hash;
            selected.Add(role);
            regions.Add(Data("role", role.Role, "rect", role.Node.Rect.Report(), "controlSha256", role.Hash));
        }
        var after = QtBound(false);
        Need(QtSameBinding(before, after) && revision == Interlocked.Read(ref Revision), "QT_OBSERVATION_CHANGED");
        if (popup != null)
            QtNeedSamePopupCaptureSnapshot(popup, QtReadPopupCaptureSnapshot(QtPopup));
        // ResolveRoles already returned fresh, ancestry-verified roles in this
        // call. Later token/input checks still perform their own fresh refresh.
        var frame = new QtFrame { Binding = after,
                                  Token = Guid.NewGuid().ToString("N"),
                                  Revision = revision,
                                  Issued = UtcMs(),
                                  Anchors = anchors,
                                  MetadataOnly = true,
                                  MetadataLease = QtFocus.Active,
                                  UiaRoles = selected,
                                  PopupBounds = popup == null ? (Rect?)null : popup.Bounds,
                                  PopupClient = popup == null ? (Rect?)null : popup.Client };
        QtCurrent = frame;
        var result = Data("binding", after.Report(), "executableVersion",
                          FileVersionInfo.GetVersionInfo(QtExecutable).FileVersion, "observationKind",
                          "uia-metadata-v1", "pixelsRead", false, "token", frame.Token, "epoch", QtEpoch, "revision",
                          revision, "idleMs", Math.Max(0, Now() - Interlocked.Read(ref LastActivity)), "regions",
                          regions, "image", null, "inputSent", false, "popup", popup == null ? null : popup.Report());
        if (popup != null && QtPopupOffscreenSearch(popup.Lease, popup.Bounds))
            Map(result["popup"]).Add("offscreenSearch", true);
        if (purpose == "control" || purpose == "image")
            QtMarkUiaControlFrame(frame, QtFocus.Active, result);
        return result;
    }
    // Read only the field just written by this transaction. Its value is never
    // returned or logged. A missing ValuePattern is an uncertain paste, not a
    // permission to repeat it or to assume a scheduling delay consumed it.
    static void QtUiaAwaitOwnPaste(QtFrame frame, string scope, string expected, uint sequence, uint ownerPid)
    {
        Need(frame.MetadataOnly, "QT_UIA_CONTROL_FRAME_INVALID");
        QtUiaRole selected = null;
        foreach (var role in frame.UiaRoles)
            if (role.Role == (scope == "search" ? "search" : "editor"))
                selected = role;
        Need(selected != null, "QT_UIA_PASTE_CONTROL_UNAVAILABLE");
        long deadline = Now() + 650;
        // Ctrl+V can legitimately resize the query controls. This loop only
        // checks consumption of our own value; the post-paste metadata frame
        // is rebuilt before any later input, with no second paste attempt.
        for (;;)
        {
            QtInputStable(frame, false);
            Need(GetClipboardSequenceNumber() == sequence && ClipboardOwnerPid() == ownerPid,
                 "DRAFT_CLIPBOARD_CHANGED");
            object pattern;
            Need(selected.Node.Element.TryGetCurrentPattern(ValuePattern.Pattern, out pattern) &&
                     pattern is ValuePattern,
                 "QT_UIA_PASTE_VALUE_UNAVAILABLE");
            var value = (ValuePattern)pattern;
            Need(!value.Current.IsReadOnly, "QT_UIA_PASTE_VALUE_UNAVAILABLE");
            bool equal = QtNormalizeText(value.Current.Value) == expected;
            QtInputStable(frame, false);
            if (equal)
                return;
            Need(Now() < deadline, "QT_UIA_PASTE_CONSUMPTION_UNCONFIRMED");
            Thread.Sleep(5);
        }
    }
    static int QtUiaControlsSelfTest()
    {
        int count = 0;
        Need(QtUiaPurposeRoles("image").Length == 3 && QtUiaPurposeRoles("search")[0] == "search",
             "QT_TEST_UIA_PURPOSE");
        count++;
        Expect(delegate { QtUiaPurposeRoles("pixels"); }, "QT_UIA_CONTROL_PURPOSE_INVALID");
        count++;
        var warmBinding = new Binding { Window = new IntPtr(10),
                                        Pid = 20,
                                        Created = 30,
                                        Thread = 40,
                                        Dpi = 120,
                                        Client = new Rect(0, 0, 800, 600),
                                        Capture = new Rect(100, 200, 900, 800),
                                        Focus = IntPtr.Zero };
        var focusedBinding =
            new Binding { Window = warmBinding.Window,   Pid = warmBinding.Pid,     Created = warmBinding.Created,
                          Thread = warmBinding.Thread,   Dpi = warmBinding.Dpi,     Client = warmBinding.Client,
                          Capture = warmBinding.Capture, Focus = warmBinding.Window };
        Need(QtUiaLocatorBindingMatches(warmBinding, focusedBinding) && !QtSameBinding(warmBinding, focusedBinding),
             "QT_TEST_UIA_LOCATOR_FOCUS_CHANGE_NEVER_WEAKENS_INPUT_BINDING");
        count++;
        foreach (int change in new[] { 0, 1, 2, 3, 4, 5, 6 })
        {
            IntPtr window = focusedBinding.Window;
            uint pid = focusedBinding.Pid, thread = focusedBinding.Thread, dpi = focusedBinding.Dpi;
            long created = focusedBinding.Created;
            Rect client = focusedBinding.Client, capture = focusedBinding.Capture;
            if (change == 0)
                focusedBinding.Window = new IntPtr(11);
            if (change == 1)
                focusedBinding.Pid++;
            if (change == 2)
                focusedBinding.Created++;
            if (change == 3)
                focusedBinding.Thread++;
            if (change == 4)
                focusedBinding.Dpi++;
            if (change == 5)
                focusedBinding.Client.Right++;
            if (change == 6)
                focusedBinding.Capture.Left++;
            Need(!QtUiaLocatorBindingMatches(warmBinding, focusedBinding),
                 "QT_TEST_UIA_LOCATOR_IDENTITY_AND_GEOMETRY_BOUND");
            count++;
            focusedBinding.Window = window;
            focusedBinding.Pid = pid;
            focusedBinding.Thread = thread;
            focusedBinding.Dpi = dpi;
            focusedBinding.Created = created;
            focusedBinding.Client = client;
            focusedBinding.Capture = capture;
        }
        int warmGuards = 0, warmCalls = 0, discards = 0;
        QtUiaWarmLocatorTransaction(delegate { warmGuards++; }, delegate { warmCalls++; }, delegate { discards++; });
        Need(warmGuards == 2 && warmCalls == 1 && discards == 0, "QT_TEST_UIA_WARM_HAS_FRESH_BEFORE_AND_AFTER_GUARDS");
        count++;
        for (int failure = 1; failure <= 2; failure++)
        {
            int fail = failure;
            warmGuards = warmCalls = discards = 0;
            Expect(delegate {
                QtUiaWarmLocatorTransaction(
                    delegate {
                        if (++warmGuards == fail)
                            throw new Fault("QT_HUMAN_ACTIVITY_CHANGED");
                    },
                    delegate { warmCalls++; }, delegate { discards++; });
            }, "QT_HUMAN_ACTIVITY_CHANGED");
            Need(discards == 1 && warmCalls == failure - 1, "QT_TEST_UIA_CHANGED_WARMUP_DISCARDS_LOCATORS");
            count++;
        }
        discards = 0;
        Expect(delegate {
            QtUiaWarmLocatorTransaction(delegate {}, delegate { throw new Fault("QT_UIA_CONTROL_CHANGED"); },
                                        delegate { discards++; });
        }, "QT_UIA_CONTROL_CHANGED");
        Need(discards == 1, "QT_TEST_UIA_PROVIDER_FAILURE_DISCARDS_LOCATORS");
        count++;
        var warmReport = Map(QtUiaWarmReport(warmBinding, new IntPtr(99)));
        var warmIdentity = Map(Get(warmReport, "binding"));
        Need(Object.Equals(Get(warmReport, "warmed"), true) && Object.Equals(Get(warmReport, "readOnly"), true) &&
                 Object.Equals(Get(warmReport, "authorizationGranted"), false) &&
                 Object.Equals(Get(warmReport, "inputSent"), false) &&
                 Object.Equals(Get(warmIdentity, "foreground"), false) && warmIdentity.Count == 7 &&
                 !warmReport.ContainsKey("token") && !warmReport.ContainsKey("frame") &&
                 !warmReport.ContainsKey("lease"),
             "QT_TEST_UIA_WARM_REPORT_GRANTS_NO_INPUT_AUTHORITY");
        count++;
        var warmExpected = new Dictionary<string, object>(warmIdentity);
        warmExpected.Remove("foreground");
        Need(Object.ReferenceEquals(QtUiaWarmExpected(warmExpected), warmExpected),
             "QT_TEST_UIA_WARM_EXPECTED_SIX_FIELDS");
        count++;
        warmExpected.Add("foreground", false);
        Expect(delegate { QtUiaWarmExpected(warmExpected); }, "QT_UIA_WARM_REQUEST_INVALID");
        warmExpected.Remove("foreground");
        warmExpected.Remove("pid");
        Expect(delegate { QtUiaWarmExpected(warmExpected); }, "QT_UIA_WARM_REQUEST_INVALID");
        count += 2;
        var rootBinding = new Binding { Window = new IntPtr(1234), Pid = 42, Client = new Rect(0, 0, 1075, 687) };
        var movedRoot = new QtUiaNode { NativeWindowHandle = 1234,  Pid = 42,
                                        Class = "mmui::MainWindow", Type = ControlType.Window,
                                        Runtime = "42,1234",        Rect = new Rect(-768, 123, 307, 810) };
        Need(QtUiaRootMatches(movedRoot, rootBinding), "QT_TEST_UIA_ROOT_CONTAINER_RECT_NOT_INPUT");
        count++;
        foreach (int change in new[] { 0, 1, 2, 3, 4, 5 })
        {
            int pid = movedRoot.Pid, hwnd = movedRoot.NativeWindowHandle;
            string cls = movedRoot.Class, runtime = movedRoot.Runtime;
            var type = movedRoot.Type;
            if (change == 0)
                movedRoot.Pid++;
            if (change == 1)
                movedRoot.NativeWindowHandle++;
            if (change == 2)
                movedRoot.Class = "other";
            if (change == 3)
                movedRoot.Type = ControlType.Group;
            if (change == 4)
                movedRoot.Runtime = "";
            if (change == 5)
                movedRoot.Offscreen = true;
            Need(!QtUiaRootMatches(movedRoot, rootBinding), "QT_TEST_UIA_ROOT_IDENTITY_STILL_REQUIRED");
            count++;
            movedRoot.Pid = pid;
            movedRoot.NativeWindowHandle = hwnd;
            movedRoot.Class = cls;
            movedRoot.Runtime = runtime;
            movedRoot.Type = type;
            movedRoot.Offscreen = false;
        }
        var root = new QtUiaNode { Class = "mmui::MainWindow", Type = ControlType.Window, Runtime = "1" };
        var page =
            new QtUiaNode { Parent = root, Class = "mmui::ChatMessagePage", Type = ControlType.Group, Runtime = "2" };
        var input =
            new QtUiaNode { Parent = page, Class = "mmui::ChatInputView", Type = ControlType.Group, Runtime = "3" };
        var edit = new QtUiaNode { Parent = input, Class = "mmui::ChatInputField", Type = ControlType.Edit,
                                   Id = "chat_input_field", Runtime = "4" };
        Need(QtUiaControlRole(edit) == "editor", "QT_TEST_UIA_EDITOR_SCOPE");
        count++;
        edit.Id = "private_other";
        Need(QtUiaControlRole(edit) == null, "QT_TEST_UIA_EDITOR_ID");
        count++;
        edit.Id = "chat_input_field";
        string hash = QtUiaRoleHash(edit, "editor");
        edit.Runtime = "5";
        Need(hash != QtUiaRoleHash(edit, "editor"), "QT_TEST_UIA_RUNTIME_CHANGE");
        count++;
        edit.Runtime = "4";
        input.Rect = new Rect(10, 20, 100, 200);
        Need(hash == QtUiaRoleHash(edit, "editor"), "QT_TEST_UIA_ANCESTOR_GEOMETRY_NOT_INPUT");
        count++;
        edit.Rect = new Rect(12, 22, 98, 198);
        Need(hash != QtUiaRoleHash(edit, "editor"), "QT_TEST_UIA_ACTUAL_ROLE_GEOMETRY_BOUND");
        count++;
        edit.Rect = new Rect();
        input.Runtime = "changed-parent";
        Need(hash != QtUiaRoleHash(edit, "editor"), "QT_TEST_UIA_PARENT_IDENTITY_BOUND");
        count++;
        var observedRoot =
            new QtUiaNode { Class = "mmui::MainWindow", Type = ControlType.Window, Runtime = "root", Pid = 123 };
        var observedPage = new QtUiaNode { Parent = observedRoot, Class = "mmui::ChatMessagePage",
                                           Type = ControlType.Group, Runtime = "page", Pid = 123 };
        var original = new QtUiaNode { Parent = observedPage,   Class = "mmui::ChatInputField",
                                       Type = ControlType.Edit, Id = "chat_input_field",
                                       Runtime = "editor",      Pid = 123,
                                       Enabled = true,          Rect = new Rect(10, 20, 100, 80) };
        var role = new QtUiaRole { Role = "editor", Node = original, Hash = QtUiaRoleHash(original, "editor") };
        var actual = new QtUiaNode { Parent = observedPage, Class = original.Class,     Type = original.Type,
                                     Id = original.Id,      Runtime = original.Runtime, Pid = 123,
                                     Enabled = true,        Rect = original.Rect };
        Need(QtUiaSameControl(original, actual, 123) && QtUiaRoleObservationMatches(role, actual, true),
             "QT_TEST_UIA_FRESH_ROLE_IDENTITY");
        count++;
        actual.Rect = new Rect(12, 20, 110, 80);
        Need(!QtUiaRoleObservationMatches(role, actual, true) && QtUiaRoleObservationMatches(role, actual, false) &&
                 QtUiaRoleHash(actual, "editor") != role.Hash,
             "QT_TEST_UIA_LOCATOR_GEOMETRY_REFRESH_NOT_FRAME_REUSE");
        count++;
        actual.Parent = new QtUiaNode { Parent = observedRoot, Class = observedPage.Class, Type = observedPage.Type,
                                        Runtime = "different-page", Pid = 123 };
        Need(!QtUiaRoleObservationMatches(role, actual, false), "QT_TEST_UIA_GEOMETRY_REFRESH_REJECTS_REPARENT");
        count++;
        actual.Parent = observedPage;
        foreach (int change in new[] { 0, 1, 2, 3, 4, 5 })
        {
            int pid = actual.Pid;
            string cls = actual.Class, id = actual.Id, runtime = actual.Runtime;
            var type = actual.Type;
            if (change == 0)
                actual.Pid = 999;
            if (change == 1)
                actual.Class = "other";
            if (change == 2)
                actual.Id = "other";
            if (change == 3)
                actual.Runtime = "replaced";
            if (change == 4)
                actual.Type = ControlType.Text;
            if (change == 5)
                actual.Offscreen = true;
            Need(!QtUiaSameControl(original, actual, 123), "QT_TEST_UIA_REFRESH_REJECTS_IDENTITY_CHANGE");
            count++;
            actual.Pid = pid;
            actual.Class = cls;
            actual.Id = id;
            actual.Runtime = runtime;
            actual.Type = type;
            actual.Offscreen = false;
        }
        Need(QtUiaSendText("发送") && QtUiaSendText("Send") && !QtUiaSendText("Send later") && !QtUiaSendText(null),
             "QT_TEST_UIA_SEND_LABEL_EXACT");
        count++;
        Need(QtUiaSkipContent(new QtUiaNode { Class = "chat", Type = ControlType.ListItem }),
             "QT_TEST_UIA_SKIP_MESSAGES");
        count++;
        return count;
    }
}
