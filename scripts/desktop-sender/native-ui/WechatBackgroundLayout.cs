// UIA supplies geometry; existing sender identity, input ownership and receipt
// checks still decide whether an action can run. Only fixed toolbar labels are
// read. Contact names, title text, message text and editor values are not read.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Windows.Automation;

internal static partial class WechatBackgroundControls
{
    [StructLayout(LayoutKind.Sequential)]
    struct NativeRect
    {
        internal int Left, Top, Right, Bottom;
    }
    sealed class LayoutGeometry
    {
        internal int X, Y, Width, Height, Dpi;
        internal Dictionary<string, object> Client()
        {
            return Data("left", 0, "top", 0, "right", Width, "bottom", Height);
        }
        internal Dictionary<string, object> Screen()
        {
            return Data("left", X, "top", Y, "right", X + Width, "bottom", Y + Height);
        }
    }
    sealed class LabelMatch
    {
        internal string Role, Text, Source;
    }
    static readonly Dictionary<string, string> StaticToolbarLabels =
        new Dictionary<string, string>(StringComparer.Ordinal) { { "发送", "send" },
                                                                 { "发送(S)", "send" },
                                                                 { "发送(s)", "send" },
                                                                 { "Send", "send" },
                                                                 { "Send(S)", "send" },
                                                                 { "Send (S)", "send" },
                                                                 { "语音消息", "recordStart" },
                                                                 { "发送语音", "recordStart" },
                                                                 { "发送语音消息", "recordStart" },
                                                                 { "录制语音消息", "recordStart" },
                                                                 { "发语音 ( 按住右 Alt )", "recordStart" },
                                                                 { "Voice message", "recordStart" },
                                                                 { "Send voice message", "recordStart" },
                                                                 { "Record voice message", "recordStart" },
                                                                 { "文件", "file" },
                                                                 { "发送文件", "file" },
                                                                 { "文件和图片", "file" },
                                                                 { "Files", "file" },
                                                                 { "Send file", "file" },
                                                                 { "Send files", "file" },
                                                                 { "图片", "image" },
                                                                 { "发送图片", "image" },
                                                                 { "相册", "image" },
                                                                 { "Image", "image" },
                                                                 { "Photo", "image" },
                                                                 { "Photos", "image" },
                                                                 { "Send image", "image" },
                                                                 { "语音输入", "voiceInput" },
                                                                 { "Voice input", "voiceInput" },
                                                                 { "表情", "emoji" },
                                                                 { "Emoji", "emoji" } };
    static LayoutGeometry Geometry(Binding b)
    {
        NativeRect client;
        Point origin = new Point();
        Need(GetClientRect(b.Window, out client) && ClientToScreen(b.Window, ref origin),
             "UI_CONTROLS_GEOMETRY_UNAVAILABLE");
        uint dpi = GetDpiForWindow(b.Window);
        Need(client.Left == 0 && client.Top == 0 && client.Right >= 600 && client.Right <= 4096 &&
                 client.Bottom >= 400 && client.Bottom <= 4096 && dpi >= 48 && dpi <= 768,
             "UI_CONTROLS_GEOMETRY_INVALID");
        return new LayoutGeometry { X = origin.X, Y = origin.Y, Width = client.Right, Height = client.Bottom,
                                    Dpi = (int)dpi };
    }
    static bool SameGeometry(LayoutGeometry a, LayoutGeometry b)
    {
        return a.X == b.X && a.Y == b.Y && a.Width == b.Width && a.Height == b.Height && a.Dpi == b.Dpi;
    }
    static Dictionary<string, object> Node(IList<object> nodes, int index)
    {
        return (Dictionary<string, object>)nodes[index];
    }
    static string Class(IList<object> nodes, int index)
    {
        return (string)Get(Node(nodes, index), "className");
    }
    static string Type(IList<object> nodes, int index)
    {
        return (string)Get(Node(nodes, index), "controlType");
    }
    static int Parent(IList<object> nodes, int index)
    {
        return (int)Node(nodes, index)["parent"];
    }
    static bool VisibleNode(IList<object> nodes, int index)
    {
        var node = Node(nodes, index);
        return Get(node, "rect") != null && Object.Equals(Get(node, "offscreen"), false);
    }
    static int Ancestor(IList<object> nodes, int index, string className)
    {
        int parent = Parent(nodes, index);
        for (int depth = 0; parent >= 0 && depth < 129; depth++)
        {
            Need(parent < index && parent < nodes.Count, "UI_CONTROLS_ANCESTRY_INVALID");
            if (Class(nodes, parent) == className)
                return parent;
            index = parent;
            parent = Parent(nodes, parent);
        }
        return -1;
    }
    static bool DescendsFrom(IList<object> nodes, int index, int ancestor)
    {
        int parent = Parent(nodes, index);
        for (int depth = 0; parent >= 0 && depth < 129; depth++)
        {
            Need(parent < index && parent < nodes.Count, "UI_CONTROLS_ANCESTRY_INVALID");
            if (parent == ancestor)
                return true;
            index = parent;
            parent = Parent(nodes, parent);
        }
        return false;
    }
    static int UniqueRole(IList<object> nodes, Func<int, bool> matches, string role, Dictionary<string, object> errors)
    {
        int chosen = -1;
        for (int i = 0; i < nodes.Count; i++)
            if (VisibleNode(nodes, i) && matches(i))
            {
                if (chosen >= 0)
                {
                    errors[role] = "UI_CONTROLS_LAYOUT_AMBIGUOUS";
                    return -1;
                }
                chosen = i;
            }
        if (chosen < 0)
            errors[role] = "UI_CONTROLS_LAYOUT_MISSING";
        return chosen;
    }
    static LabelMatch KnownToolbarLabel(string text, string source)
    {
        string role;
        if (text == null || !StaticToolbarLabels.TryGetValue(text, out role))
            return null;
        return new LabelMatch { Role = role, Text = text, Source = source };
    }
    static bool SameToolbarLabel(LabelMatch a, LabelMatch b)
    {
        return a != null && b != null && a.Role == b.Role && a.Text == b.Text;
    }
    static bool ToolbarButton(IList<object> nodes, int index)
    {
        return Type(nodes, index) == "ControlType.Button" &&
               (Class(nodes, index) == "mmui::XButton" || Class(nodes, index) == "mmui::XOutlineButton") &&
               Ancestor(nodes, index, "mmui::ChatInputView") >= 0 &&
               (Ancestor(nodes, index, "mmui::ChatInputToolbarRightView") >= 0 ||
                Ancestor(nodes, index, "mmui::ChatInputToolbarLeftView") >= 0);
    }
    static CacheRequest LayoutControlCache()
    {
        var cache = new CacheRequest();
        cache.TreeScope = TreeScope.Element;
        foreach (var property in new[] { AutomationElement.ProcessIdProperty, AutomationElement.ClassNameProperty,
                                         AutomationElement.ControlTypeProperty, AutomationElement.AutomationIdProperty,
                                         AutomationElement.IsEnabledProperty, AutomationElement.IsOffscreenProperty,
                                         AutomationElement.IsKeyboardFocusableProperty,
                                         AutomationElement.BoundingRectangleProperty })
            cache.Add(property);
        return cache;
    }
    // Layout does not consume the generic diagnostic probe's complete pattern
    // inventory. Fetch just the metadata used to resolve and verify its roles.
    static Dictionary<string, object> DescribeLayoutControl(AutomationElement element, uint pid)
    {
        var state = element.Cached;
        Need(state.ProcessId == (int)pid, "UI_CONTROLS_NODE_PROCESS_CHANGED");
        var rect = state.BoundingRectangle;
        var report = AutomationIdReport(state.AutomationId);
        report.Add("className", TextMetadata(state.ClassName));
        report.Add("controlType", TextMetadata(state.ControlType.ProgrammaticName));
        report.Add("enabled", state.IsEnabled);
        report.Add("offscreen", state.IsOffscreen);
        report.Add("rect", rect.IsEmpty
                               ? null
                               : Data("left", rect.Left, "top", rect.Top, "right", rect.Right, "bottom", rect.Bottom));
        return report;
    }
    static bool LayoutSkipChildren(string cls, ControlType type)
    {
        return type == ControlType.List || type == ControlType.ListItem || type == ControlType.Edit ||
               type == ControlType.Button || cls == "mmui::ChatMessageView" || cls == "mmui::ChatMessageListView";
    }
    static LabelMatch ReadToolbarLabel(AutomationElement button)
    {
        var cache = new CacheRequest();
        cache.TreeScope = TreeScope.Element;
        cache.Add(AutomationElement.NameProperty);
        cache.Add(AutomationElement.HelpTextProperty);
        var label = button.GetUpdatedCache(cache).Cached;
        var result = KnownToolbarLabel(label.Name, "Name");
        if (result != null)
            return result;
        result = KnownToolbarLabel(label.HelpText, "HelpText");
        if (result != null)
            return result;
        using (cache.Activate())
        {
            var children = button.FindAll(
                TreeScope.Children,
                new AndCondition(new PropertyCondition(AutomationElement.ClassNameProperty, "mmui::XTextView"),
                                 new PropertyCondition(AutomationElement.ControlTypeProperty, ControlType.Text)));
            if (children.Count == 1)
                return KnownToolbarLabel(children[0].Cached.Name, "child-Name");
            return null;
        }
    }
    static Dictionary<string, int> ResolveLayoutRoles(IList<object> nodes, Dictionary<int, LabelMatch> labels,
                                                      Dictionary<string, object> errors)
    {
        var roles = new Dictionary<string, int>();
        int input = UniqueRole(nodes, delegate(int i) { return Class(nodes, i) == "mmui::ChatInputView"; },
                               "inputContainer", errors);
        int page = input < 0 ? -1 : Ancestor(nodes, input, "mmui::ChatMessagePage");
        int search = UniqueRole(nodes, delegate(int i) {
            return Class(nodes, i) == "mmui::XValidatorTextEdit" && Type(nodes, i) == "ControlType.Edit" &&
                   Parent(nodes, i) >= 0 && Class(nodes, Parent(nodes, i)) == "mmui::XSearchField" &&
                   Ancestor(nodes, i, "mmui::ChatMasterView") >= 0;
        }, "search", errors);
        if (search >= 0)
            roles["search"] = search;
        if (input >= 0 && page >= 0)
        {
            int editor = UniqueRole(nodes, delegate(int i) {
                return Class(nodes, i) == "mmui::ChatInputField" && Type(nodes, i) == "ControlType.Edit" &&
                       (string)Get(Node(nodes, i), "automationId") == "chat_input_field" &&
                       DescendsFrom(nodes, i, input);
            }, "editor", errors);
            if (editor >= 0)
                roles["editor"] = editor;
            int toolbar = UniqueRole(nodes, delegate(int i) {
                return Type(nodes, i) == "ControlType.ToolBar" && Class(nodes, i) == "mmui::XHBoxView" &&
                       DescendsFrom(nodes, i, input);
            }, "toolbar", errors);
            if (toolbar >= 0)
                roles["toolbar"] = toolbar;
            int header = UniqueRole(nodes, delegate(int i) {
                return Class(nodes, i) == "mmui::ChatTitleBarMasterView" && DescendsFrom(nodes, i, page);
            }, "header", errors);
            if (header >= 0)
            {
                roles["header"] = header;
                int profile = UniqueRole(nodes, delegate(int i) {
                    return Class(nodes, i) == "mmui::XHBoxView" && Type(nodes, i) == "ControlType.Text" &&
                           DescendsFrom(nodes, i, header) &&
                           (Ancestor(nodes, i, "mmui::ChatTitleBarChatSingleView") >= 0 ||
                            Ancestor(nodes, i, "mmui::ChatTitleBarChatRoomView") >= 0);
                }, "profileOpen", errors);
                if (profile >= 0)
                    roles["profileOpen"] = profile;
            }
            foreach (string role in new[] { "send", "recordStart", "file", "image" })
            {
                int index = UniqueRole(nodes, delegate(int i) {
                    LabelMatch label;
                    if (!labels.TryGetValue(i, out label) || label.Role != role || !DescendsFrom(nodes, i, input))
                        return false;
                    return Ancestor(nodes, i,
                                    role == "send" || role == "recordStart" ? "mmui::ChatInputToolbarRightView"
                                                                            : "mmui::ChatInputToolbarLeftView") >= 0;
                }, role, errors);
                if (index >= 0)
                    roles[role] = index;
            }
        }
        else
        {
            foreach (string role in new[] { "editor", "toolbar", "header", "profileOpen", "send", "recordStart" })
                errors[role] = "UI_CONTROLS_LAYOUT_CHAT_UNAVAILABLE";
        }
        return roles;
    }
    static Dictionary<string, object> ClientRegion(object screenRect, LayoutGeometry geometry)
    {
        var screen = screenRect as Dictionary<string, object>;
        Need(screen != null, "UI_CONTROLS_LAYOUT_RECT_INVALID");
        double left = Convert.ToDouble(screen["left"], CultureInfo.InvariantCulture),
               top = Convert.ToDouble(screen["top"], CultureInfo.InvariantCulture),
               right = Convert.ToDouble(screen["right"], CultureInfo.InvariantCulture),
               bottom = Convert.ToDouble(screen["bottom"], CultureInfo.InvariantCulture);
        Need(!Double.IsNaN(left) && !Double.IsInfinity(left) && !Double.IsNaN(top) && !Double.IsInfinity(top) &&
                 !Double.IsNaN(right) && !Double.IsInfinity(right) && !Double.IsNaN(bottom) &&
                 !Double.IsInfinity(bottom),
             "UI_CONTROLS_LAYOUT_RECT_INVALID");
        double l = Math.Ceiling(left) - geometry.X, t = Math.Ceiling(top) - geometry.Y,
               r = Math.Floor(right) - geometry.X, b = Math.Floor(bottom) - geometry.Y;
        Need(l >= 0 && t >= 0 && r <= geometry.Width && b <= geometry.Height && r - l >= 2 && b - t >= 2,
             "UI_CONTROLS_LAYOUT_RECT_INVALID");
        return Data("left", (int)l, "top", (int)t, "right", (int)r, "bottom", (int)b);
    }
    static object InspectLayout(Binding binding)
    {
        IntPtr dpiContext = SetThreadDpiAwarenessContext(new IntPtr(-4));
        Need(dpiContext != IntPtr.Zero, "UI_CONTROLS_DPI_CONTEXT_UNAVAILABLE");
        IntPtr process = IntPtr.Zero;
        try
        {
            process = OpenProcess(0x1000 | 0x100000, false, binding.Pid);
            Need(process != IntPtr.Zero, "UI_CONTROLS_PROCESS_UNAVAILABLE");
            var before = Observe(binding, process);
            Need((bool)before["visible"] && !(bool)before["minimized"], "UI_CONTROLS_LAYOUT_WINDOW_UNAVAILABLE");
            var geometry = Geometry(binding);
            string version = FileVersionInfo.GetVersionInfo(binding.Executable).FileVersion;
            Need(version == "4.2.0.53", "UI_CONTROLS_LAYOUT_VERSION_UNSUPPORTED");
            UiAccessed = true;
            var timer = Stopwatch.StartNew();
            var cache = LayoutControlCache();
            AutomationElement root;
            using (cache.Activate()) root = AutomationElement.FromHandle(binding.Window);
            Need(root != null && root.Cached.ClassName == "mmui::MainWindow", "UI_CONTROLS_ROOT_UNAVAILABLE");
            int[] rootId = root.GetRuntimeId();
            var walker = TreeWalker.RawViewWalker;
            var elements = new List<AutomationElement>();
            var runtimeIds = new List<int[]>();
            var tree = Walk(root,
                            delegate(AutomationElement el) {
                                var metadata = el.Cached;
                                return LayoutSkipChildren(metadata.ClassName, metadata.ControlType)
                                           ? null
                                           : walker.GetFirstChild(el, cache);
                            },
                            delegate(AutomationElement el) { return walker.GetNextSibling(el, cache); },
                            delegate(AutomationElement el) {
                                elements.Add(el);
                                runtimeIds.Add(el.GetRuntimeId());
                                return DescribeLayoutControl(el, binding.Pid);
                            },
                            binding.MaxNodes, binding.MaxDepth, delegate { return timer.ElapsedMilliseconds > 10000; });
            Need(tree.Complete, tree.Reason ?? "UI_CONTROLS_LAYOUT_INCOMPLETE");
            var labels = new Dictionary<int, LabelMatch>();
            int unknownLabels = 0;
            for (int i = 0; i < elements.Count; i++)
                if (VisibleNode(tree.Nodes, i) && ToolbarButton(tree.Nodes, i))
                {
                    var label = ReadToolbarLabel(elements[i]);
                    if (label != null)
                        labels.Add(i, label);
                    else
                        unknownLabels++;
                }
            var errors = new Dictionary<string, object>();
            var roles = ResolveLayoutRoles(tree.Nodes, labels, errors);
            var controls = new Dictionary<string, object>();
            var layout = Data("width", geometry.Width, "height", geometry.Height, "dpi", geometry.Dpi);
            var voice = new Dictionary<string, object>();
            foreach (var role in roles)
            {
                var node = Node(tree.Nodes, role.Value);
                Dictionary<string, object> rect;
                try
                {
                    rect = ClientRegion(node["rect"], geometry);
                }
                catch (Fault error)
                {
                    errors[role.Key] = error.Message;
                    continue;
                }
                LabelMatch label;
                labels.TryGetValue(role.Value, out label);
                var refreshedElement = elements[role.Value].GetUpdatedCache(cache);
                var current = refreshedElement.Cached;
                Need(current.ProcessId == (int)binding.Pid, "UI_CONTROLS_NODE_PROCESS_CHANGED");
                var refreshed = current.BoundingRectangle;
                Need(!refreshed.IsEmpty &&
                         ExactRect(rect, ClientRegion(Data("left", refreshed.Left, "top", refreshed.Top, "right",
                                                           refreshed.Right, "bottom", refreshed.Bottom),
                                                      geometry)),
                     "UI_CONTROLS_LAYOUT_MOVED");
                Need(!current.IsOffscreen && current.ClassName == (string)node["className"] &&
                         current.ControlType.ProgrammaticName == (string)node["controlType"] &&
                         (node["automationId"] == null || current.AutomationId == (string)node["automationId"]) &&
                         Automation.Compare(runtimeIds[role.Value], refreshedElement.GetRuntimeId()),
                     "UI_CONTROLS_LAYOUT_CONTROL_CHANGED");
                if (label != null)
                    Need(SameToolbarLabel(label, ReadToolbarLabel(elements[role.Value])),
                         "UI_CONTROLS_LAYOUT_LABEL_CHANGED");
                controls[role.Key] =
                    Data("rect", rect, "className", node["className"], "controlType", node["controlType"],
                         "automationId", node["automationId"], "runtimeIdSha256",
                         Hash(String.Join(",", runtimeIds[role.Value])), "path", NodePath(tree.Nodes, role.Value),
                         "enabled", current.IsEnabled, "offscreen", current.IsOffscreen, "staticLabel",
                         label == null ? null : label.Text, "labelSource", label == null ? null : label.Source);
                if (role.Key == "toolbar")
                    voice["toolbarRect"] = rect;
                else if (role.Key == "recordStart")
                    voice["recordStartRect"] = rect;
                else if (role.Key == "search" || role.Key == "editor" || role.Key == "send" || role.Key == "header" ||
                         role.Key == "profileOpen")
                    layout[role.Key] = rect;
            }
            var finalRoot = AutomationElement.FromHandle(binding.Window);
            Need(finalRoot != null && Automation.Compare(rootId, finalRoot.GetRuntimeId()), "UI_CONTROLS_ROOT_CHANGED");
            var after = Observe(binding, process);
            Need(Same(before, after, "threadId") && Same(before, after, "nativeClassName") &&
                     SameGeometry(geometry, Geometry(binding)),
                 "UI_CONTROLS_LAYOUT_BINDING_CHANGED");
            Need((bool)after["visible"] && !(bool)after["minimized"], "UI_CONTROLS_LAYOUT_WINDOW_UNAVAILABLE");
            bool available = layout.ContainsKey("search") && layout.ContainsKey("editor") &&
                             layout.ContainsKey("send") && layout.ContainsKey("header");
            var identity = Data("hwnd", Id(binding.Window.ToInt64()), "pid", binding.Pid, "threadId",
                                before["threadId"], "processCreatedFileTimeUtc", Id(binding.Created), "dpi",
                                geometry.Dpi, "clientRect", geometry.Client(), "captureRect", geometry.Screen(),
                                "rootRuntimeIdSha256", Hash(String.Join(",", rootId)), "executableVersion", version);
            var missing = new List<string>();
            var ambiguous = new List<string>();
            foreach (var error in errors)
            {
                if ((string)error.Value == "UI_CONTROLS_LAYOUT_AMBIGUOUS")
                    ambiguous.Add(error.Key);
                else
                    missing.Add(error.Key);
            }
            missing.Sort(StringComparer.Ordinal);
            ambiguous.Sort(StringComparer.Ordinal);
            return Data("ok", true, "schemaVersion", 1, "version", 1, "backend", "uia-layout", "operation", "layout",
                        "readOnly", true, "inputSent", false, "staticLabelsRead", true, "chatTextRead", false,
                        "draftValueRead", false, "accountVerified", false, "targetVerified", false,
                        "emptyDraftAuthorized", false, "authorizationGranted", false, "bindingStable", true, "complete",
                        true, "layoutAvailable", available, "voiceAvailable",
                        available && voice.ContainsKey("recordStartRect") && voice.ContainsKey("toolbarRect"),
                        "imageAvailable", available, "binding", identity, "layout", layout, "voice", voice, "controls",
                        controls, "verification", VerificationProof(rootId, geometry, controls), "missing", missing,
                        "ambiguous", ambiguous, "roleErrors", errors, "unknownToolbarLabelCount", unknownLabels,
                        "nodeCount", tree.Nodes.Count, "foregroundUnchanged", Same(before, after, "foregroundHwnd"),
                        "inputTickUnchanged", Same(before, after, "lastInputTick"), "before", before, "after", after,
                        "elapsedMs", timer.ElapsedMilliseconds);
        }
        finally
        {
            if (process != IntPtr.Zero)
                CloseHandle(process);
            SetThreadDpiAwarenessContext(dpiContext);
        }
    }
    static object LayoutFixtureNode(int parent, string cls, string type, string aid = null)
    {
        return Data("parent", parent, "className", cls, "controlType", type, "automationId", aid, "offscreen", false,
                    "rect", Data());
    }
    static int LayoutSelfTest()
    {
        int n = 0;
        Need(KnownToolbarLabel("发送", "Name").Role == "send" &&
                 KnownToolbarLabel("发送语音消息", "HelpText").Role == "recordStart" &&
                 KnownToolbarLabel("发语音 ( 按住右 Alt )", "Name").Role == "recordStart" &&
                 KnownToolbarLabel("语音输入", "Name").Role == "voiceInput",
             "UI_CONTROLS_TEST_LAYOUT_LABELS");
        n++;
        foreach (string text in new[] { "private chat text", "发送给某人", "发送语音消息\n", "Send later" })
        {
            Need(KnownToolbarLabel(text, "Name") == null, "UI_CONTROLS_TEST_LAYOUT_LABEL_PRIVACY");
            n++;
        }
        Need(LayoutSkipChildren("mmui::ChatMessageView", ControlType.Group) &&
                 LayoutSkipChildren("other", ControlType.List) && LayoutSkipChildren("other", ControlType.Edit) &&
                 LayoutSkipChildren("other", ControlType.Button) &&
                 !LayoutSkipChildren("mmui::ChatTitleBarMasterView", ControlType.Group) &&
                 !LayoutSkipChildren("mmui::XHBoxView", ControlType.Text),
             "UI_CONTROLS_TEST_LAYOUT_PRUNE_CONTENT_KEEP_TITLE");
        n++;
        var scanRoot = new Fixture { Name = "root" };
        var content = new Fixture { Name = "mmui::ChatMessageView" };
        var control = new Fixture { Name = "control" };
        scanRoot.Children.Add(content);
        scanRoot.Children.Add(control);
        content.Next = control;
        content.Children.Add(new Fixture { Name = "must-not-visit" });
        int contentChildReads = 0;
        var pruned =
            Walk(scanRoot,
                 delegate(Fixture node) {
                     if (LayoutSkipChildren(node.Name, ControlType.Group))
                         return null;
                     if (node == content)
                         contentChildReads++;
                     return node.Children.Count == 0 ? null : node.Children[0];
                 },
                 delegate(Fixture node) { return node.Next; },
                 delegate(Fixture node) { return Data("className", node.Name); }, 10, 10, delegate { return false; });
        Need(pruned.Complete && pruned.Nodes.Count == 3 && contentChildReads == 0 &&
                 String.Join(",", NodePath(pruned.Nodes, 2)) == "1",
             "UI_CONTROLS_TEST_LAYOUT_PRUNE_PRESERVES_LOCATOR_POSITIONS");
        n++;
        var geometry = new LayoutGeometry { X = -1920, Y = -300, Width = 900, Height = 1540, Dpi = 120 };
        var rect = ClientRegion(Data("left", -1800.2, "top", -240.8, "right", -1700.1, "bottom", -210.1), geometry);
        Need((int)rect["left"] == 120 && (int)rect["top"] == 60 && (int)rect["right"] == 219 &&
                 (int)rect["bottom"] == 89,
             "UI_CONTROLS_TEST_LAYOUT_COORDINATES");
        n++;
        Reject(delegate { ClientRegion(Data("left", -1921, "top", -300, "right", -1900, "bottom", -280), geometry); },
               "UI_CONTROLS_LAYOUT_RECT_INVALID");
        n++;
        var changed = new LayoutGeometry { X = -1920, Y = -300, Width = 900, Height = 1540, Dpi = 96 };
        Need(!SameGeometry(geometry, changed), "UI_CONTROLS_TEST_LAYOUT_DPI_CHANGE");
        n++;
        changed.Dpi = 120;
        changed.X++;
        Need(!SameGeometry(geometry, changed), "UI_CONTROLS_TEST_LAYOUT_MOVE");
        n++;
        Need(!ParseArguments(new[] { "--layout", "--request", "fixture.json" }), "UI_CONTROLS_TEST_LAYOUT_READONLY");
        n++;
        Reject(delegate { ParseArguments(new[] { "--layout", "--request", "fixture.json", "--allow-control-write" }); },
               "UI_CONTROLS_ARGUMENTS_INVALID");
        n++;
        var nodes = new List<object> { LayoutFixtureNode(-1, "mmui::MainWindow", "ControlType.Window"),
                                       LayoutFixtureNode(0, "mmui::ChatMasterView", "ControlType.Group"),
                                       LayoutFixtureNode(1, "mmui::XSearchField", "ControlType.Group"),
                                       LayoutFixtureNode(2, "mmui::XValidatorTextEdit", "ControlType.Edit") };
        var errors = new Dictionary<string, object>();
        var roles = ResolveLayoutRoles(nodes, new Dictionary<int, LabelMatch>(), errors);
        Need(roles["search"] == 3 && !roles.ContainsKey("editor"), "UI_CONTROLS_TEST_LAYOUT_SEARCH_SCOPE");
        n++;
        nodes.Add(LayoutFixtureNode(2, "mmui::XValidatorTextEdit", "ControlType.Edit"));
        errors.Clear();
        roles = ResolveLayoutRoles(nodes, new Dictionary<int, LabelMatch>(), errors);
        Need(!roles.ContainsKey("search") && (string)errors["search"] == "UI_CONTROLS_LAYOUT_AMBIGUOUS",
             "UI_CONTROLS_TEST_LAYOUT_AMBIGUOUS");
        n++;
        nodes = new List<object> { LayoutFixtureNode(-1, "mmui::MainWindow", "ControlType.Window"),
                                   LayoutFixtureNode(0, "mmui::ChatMessagePage", "ControlType.Group"),
                                   LayoutFixtureNode(1, "mmui::ChatTitleBarMasterView", "ControlType.Group"),
                                   LayoutFixtureNode(2, "mmui::ChatTitleBarChatSingleView", "ControlType.Group"),
                                   LayoutFixtureNode(3, "mmui::XHBoxView", "ControlType.Text"),
                                   LayoutFixtureNode(1, "mmui::ChatInputView", "ControlType.Group"),
                                   LayoutFixtureNode(5, "mmui::XHBoxView", "ControlType.ToolBar"),
                                   LayoutFixtureNode(6, "mmui::ChatInputToolbarLeftView", "ControlType.Group"),
                                   LayoutFixtureNode(7, "mmui::XButton", "ControlType.Button"),
                                   LayoutFixtureNode(6, "mmui::ChatInputToolbarRightView", "ControlType.Group"),
                                   LayoutFixtureNode(9, "mmui::XButton", "ControlType.Button"),
                                   LayoutFixtureNode(9, "mmui::XOutlineButton", "ControlType.Button"),
                                   LayoutFixtureNode(5, "mmui::ChatInputField", "ControlType.Edit", "chat_input_field"),
                                   LayoutFixtureNode(0, "mmui::ChatMasterView", "ControlType.Group"),
                                   LayoutFixtureNode(13, "mmui::XSearchField", "ControlType.Group"),
                                   LayoutFixtureNode(14, "mmui::XValidatorTextEdit", "ControlType.Edit") };
        var labels = new Dictionary<int, LabelMatch> { { 8, KnownToolbarLabel("语音输入", "Name") },
                                                       { 10, KnownToolbarLabel("发语音 ( 按住右 Alt )", "Name") },
                                                       { 11, KnownToolbarLabel("发送", "Name") } };
        errors.Clear();
        roles = ResolveLayoutRoles(nodes, labels, errors);
        Need(roles["editor"] == 12 && roles["search"] == 15 && roles["header"] == 2 && roles["profileOpen"] == 4 &&
                 roles["toolbar"] == 6 && roles["recordStart"] == 10 && roles["send"] == 11,
             "UI_CONTROLS_TEST_LAYOUT_COMPLETE");
        n++;
        labels[8] = KnownToolbarLabel("语音消息", "Name");
        labels.Remove(10);
        errors.Clear();
        roles = ResolveLayoutRoles(nodes, labels, errors);
        Need(!roles.ContainsKey("recordStart") && (string)errors["recordStart"] == "UI_CONTROLS_LAYOUT_MISSING",
             "UI_CONTROLS_TEST_LAYOUT_VOICE_SIDE");
        n++;
        labels[10] = KnownToolbarLabel("语音输入", "Name");
        errors.Clear();
        roles = ResolveLayoutRoles(nodes, labels, errors);
        Need(!roles.ContainsKey("recordStart"), "UI_CONTROLS_TEST_LAYOUT_DICTATION_EXCLUDED");
        n++;
        Node(nodes, 12)["automationId"] = "other_field";
        errors.Clear();
        roles = ResolveLayoutRoles(nodes, labels, errors);
        Need(!roles.ContainsKey("editor"), "UI_CONTROLS_TEST_LAYOUT_EDITOR_ID");
        n++;
        Node(nodes, 12)["automationId"] = "chat_input_field";
        Node(nodes, 12)["offscreen"] = true;
        errors.Clear();
        roles = ResolveLayoutRoles(nodes, labels, errors);
        Need(!roles.ContainsKey("editor"), "UI_CONTROLS_TEST_LAYOUT_OFFSCREEN");
        n++;
        Need(ToolbarButton(nodes, 10) && !ToolbarButton(nodes, 12), "UI_CONTROLS_TEST_LAYOUT_LABEL_READ_SCOPE");
        n++;
        Need(SameToolbarLabel(KnownToolbarLabel("发送", "Name"), KnownToolbarLabel("发送", "HelpText")) &&
                 !SameToolbarLabel(KnownToolbarLabel("发送", "Name"), KnownToolbarLabel("发送文件", "Name")) &&
                 !SameToolbarLabel(KnownToolbarLabel("发送", "Name"), null),
             "UI_CONTROLS_TEST_LAYOUT_LABEL_RECHECK");
        n++;
        Need(Automation.Compare(new[] { 42, 1, 2 }, new[] { 42, 1, 2 }) &&
                 !Automation.Compare(new[] { 42, 1, 2 }, new[] { 42, 1, 3 }),
             "UI_CONTROLS_TEST_LAYOUT_RUNTIME_RECHECK");
        n++;
        return n;
    }
    [DllImport("user32.dll")]
    static extern bool GetClientRect(IntPtr window, out NativeRect rect);
    [DllImport("user32.dll")]
    static extern bool ClientToScreen(IntPtr window, ref Point point);
    [DllImport("user32.dll")]
    static extern uint GetDpiForWindow(IntPtr window);
    [DllImport("user32.dll")]
    static extern IntPtr SetThreadDpiAwarenessContext(IntPtr value);
}
