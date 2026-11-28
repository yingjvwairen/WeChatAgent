// Read-only UIA state for the verified Qt voice path. Only the known title
// labels and fixed recorder-button labels are read; never draft/message text.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Text;
using System.Windows.Automation;

internal static partial class WechatDraftProbe
{
    sealed class VoiceUiaFingerprint
    {
        internal string Hash, Header, Title;
        internal int Count;
    }
    sealed class VoiceUiaPlan
    {
        internal VoiceUiaFingerprint Conversation;
        internal string Root, Input, Page, Recorder;
        internal int[] InputPath, HeaderPath, PagePath;
        internal int Reads, ConversationChecks;
        internal string StartInputMethod, AfterStartState, LastObservedState;
        internal bool CaptureCandidateObserved;
        internal Point StartExpectedPoint, StartActualPoint;
        internal bool StartPointObserved, StartPointMatched, StartPressConsumed;
        internal string BeforeUpState, FailureFrame;
        internal bool? CaptureWhileDown;
        internal int FailureFrameWidth, FailureFrameHeight;
    }
    sealed class VoiceUiaNode
    {
        internal AutomationElement Element;
        internal int Parent;
        internal int[] Path;
        internal string Class, Type, Id, Runtime, Label;
        internal bool Enabled, Offscreen, HasRect;
        internal Rect Rect;
    }
    sealed class VoiceUiaState
    {
        internal string Kind, Recorder;
        internal VoiceUiaNode Start, Cancel, Submit;
    }
    static VoiceUiaPlan VoiceUiaDiagnostic;
    static object VoiceUiaReport()
    {
        var state = VoiceUiaDiagnostic;
        if (state == null)
            return null;
        var result =
            Data("version", 1, "requested", true, "bound", state.Recorder != null && VoiceCaptureVerified,
                 "stateChecks", state.Reads, "conversationVerified", state.ConversationChecks > 0, "pixelsRead", false);
        if (state.StartInputMethod != null)
        {
            var start =
                Data("inputMethod", state.StartInputMethod, "afterInputState", state.AfterStartState ?? "unavailable",
                     "finalState", state.LastObservedState ?? "unavailable", "captureCandidateObserved",
                     state.CaptureCandidateObserved);
            if (state.StartInputMethod == "send-input")
                start["pointer"] = Data(
                    "expected", new[] { state.StartExpectedPoint.X, state.StartExpectedPoint.Y }, "actual",
                    state.StartPointObserved ? (object) new[] { state.StartActualPoint.X, state.StartActualPoint.Y }
                                             : null,
                    "matched", state.StartPointMatched, "pressConsumed", state.StartPressConsumed);
            if (state.BeforeUpState != null)
            {
                start["beforeUpState"] = state.BeforeUpState;
                start["captureWhileDown"] = state.CaptureWhileDown;
            }
            if (state.FailureFrame != null)
                start["failureFrame"] =
                    Data("file", state.FailureFrame, "width", state.FailureFrameWidth, "height",
                         state.FailureFrameHeight, "scope", "input-toolbar", "pixelsRead", true, "inputSent", false);
            result["startObservation"] = start;
        }
        return result;
    }
    static string VoiceUiaDiagnosticState(VoiceRequest request)
    {
        try
        {
            return request.Uia.LastObservedState = VoiceUiaReadState(request).Kind;
        }
        catch (Fault error)
        {
            if (!error.Message.StartsWith("VOICE_UIA_", StringComparison.Ordinal))
                throw;
        }
        catch (ElementNotAvailableException)
        {
        }
        catch (System.Runtime.InteropServices.COMException)
        {
        }
        return request.Uia.LastObservedState = "unavailable";
    }
    static string VoiceUiaHash(string value)
    {
        return PixelHash(Encoding.UTF8.GetBytes(value));
    }
    static void VoiceUiaWarm()
    {
        Need(TreeWalker.RawViewWalker != null && AutomationElement.ClassNameProperty != null, "VOICE_UIA_UNAVAILABLE");
    }
    static VoiceUiaFingerprint ParseVoiceUiaFingerprint(object value)
    {
        var proof = Map(value);
        Need(proof != null && proof.Count == 7 && Number(Get(proof, "version")) == 1 &&
                 Text(proof, "scope") == "chat-title-text-v1" && Hex(Text(proof, "sha256"), 64) &&
                 Hex(Text(proof, "headerRuntimeIdSha256"), 64) && Hex(Text(proof, "titleRuntimeIdSha256"), 64) &&
                 Number(Get(proof, "textNodeCount")) >= 1 && Number(Get(proof, "textNodeCount")) <= 4 &&
                 Object.Equals(Get(proof, "targetVerified"), false),
             "VOICE_UIA_CONVERSATION_INVALID");
        return new VoiceUiaFingerprint { Hash = Text(proof, "sha256"), Header = Text(proof, "headerRuntimeIdSha256"),
                                         Title = Text(proof, "titleRuntimeIdSha256"),
                                         Count = (int)Number(Get(proof, "textNodeCount")) };
    }
    static bool SameVoiceUiaFingerprint(VoiceUiaFingerprint a, VoiceUiaFingerprint b)
    {
        return a != null && b != null && a.Hash == b.Hash && a.Header == b.Header && a.Title == b.Title &&
               a.Count == b.Count;
    }
    static VoiceUiaPlan ParseVoiceUia(object value)
    {
        var map = Map(value);
        Need(map != null && map.Count == 3 && Number(Get(map, "version")) == 1 &&
                 Text(map, "executableVersion") == "4.2.0.53",
             "VOICE_UIA_PLAN_INVALID");
        return new VoiceUiaPlan { Conversation = ParseVoiceUiaFingerprint(Get(map, "conversationFingerprint")) };
    }
    static string VoiceUiaRuntime(AutomationElement element)
    {
        return VoiceUiaHash(String.Join(",", element.GetRuntimeId()));
    }
    static CacheRequest VoiceUiaCache()
    {
        var cache = new CacheRequest();
        cache.TreeScope = TreeScope.Element;
        foreach (var property in new[] { AutomationElement.ProcessIdProperty, AutomationElement.ClassNameProperty,
                                         AutomationElement.ControlTypeProperty, AutomationElement.AutomationIdProperty,
                                         AutomationElement.IsEnabledProperty, AutomationElement.IsOffscreenProperty,
                                         AutomationElement.BoundingRectangleProperty })
            cache.Add(property);
        return cache;
    }
    static VoiceUiaNode VoiceUiaDescribe(AutomationElement element, uint pid, int parent, int[] path)
    {
        var info = element.Cached;
        Need(info.ProcessId == (int)pid, "VOICE_UIA_PROCESS_CHANGED");
        var box = info.BoundingRectangle;
        return new VoiceUiaNode { Element = element,
                                  Parent = parent,
                                  Path = path,
                                  Class = info.ClassName,
                                  Type = info.ControlType.ProgrammaticName,
                                  Id = info.AutomationId,
                                  Runtime = VoiceUiaRuntime(element),
                                  Enabled = info.IsEnabled,
                                  Offscreen = info.IsOffscreen,
                                  HasRect = !box.IsEmpty && box.Width >= 2 && box.Height >= 2,
                                  Rect = box.IsEmpty
                                             ? new Rect()
                                             : new Rect((int)Math.Ceiling(box.Left), (int)Math.Ceiling(box.Top),
                                                        (int)Math.Floor(box.Right), (int)Math.Floor(box.Bottom)) };
    }
    static bool VoiceUiaVisible(VoiceUiaNode node)
    {
        return node != null && !node.Offscreen && node.HasRect && node.Rect.Width >= 2 && node.Rect.Height >= 2;
    }
    static bool VoiceUiaSkipRootBranch(string cls)
    {
        return cls == "mmui::ChatInputField" || cls == "mmui::ChatInputView" || cls == "mmui::ChatTitleBarMasterView" ||
               cls == "mmui::ChatTextItemView" || cls == "mmui::ChatImageItemView";
    }
    static List<VoiceUiaNode> VoiceUiaWalk(AutomationElement root, uint pid, int maximum, int depthLimit,
                                           bool rootsOnly, Stopwatch timer)
    {
        // Every caller supplies a root freshly obtained by FromHandle/Replay
        // with VoiceUiaCache in this operation. Do not refresh that root twice.
        var nodes = new List<VoiceUiaNode>();
        var cache = VoiceUiaCache();
        VoiceUiaVisit(root, pid, -1, new int[0], nodes, maximum, depthLimit, rootsOnly, timer, cache);
        return nodes;
    }
    static void VoiceUiaVisit(AutomationElement element, uint pid, int parent, int[] path, List<VoiceUiaNode> nodes,
                              int maximum, int depthLimit, bool rootsOnly, Stopwatch timer, CacheRequest cache)
    {
        Need(nodes.Count < maximum && path.Length <= depthLimit && timer.ElapsedMilliseconds <= 1000,
             "VOICE_UIA_SCAN_LIMIT");
        var node = VoiceUiaDescribe(element, pid, parent, path);
        int index = nodes.Count;
        nodes.Add(node);
        // Message/session lists cannot contain the input/title roles. Prune
        // their children without reading labels or letting chat history size
        // inflate the foreground acquisition scan.
        if (rootsOnly && (VoiceUiaSkipRootBranch(node.Class) || node.Type == "ControlType.List") ||
            node.Class == "mmui::ChatInputField")
            return;
        var walker = TreeWalker.RawViewWalker;
        var child = walker.GetFirstChild(element, cache);
        int position = 0;
        while (child != null)
        {
            var childPath = new int[path.Length + 1];
            Array.Copy(path, childPath, path.Length);
            childPath[path.Length] = position++;
            VoiceUiaVisit(child, pid, index, childPath, nodes, maximum, depthLimit, rootsOnly, timer, cache);
            child = walker.GetNextSibling(child, cache);
        }
    }
    static int VoiceUiaUnique(IList<VoiceUiaNode> nodes, Func<int, bool> predicate)
    {
        int found = -1;
        for (int i = 0; i < nodes.Count; i++)
            if (VoiceUiaVisible(nodes[i]) && predicate(i))
            {
                Need(found < 0, "VOICE_UIA_ROLE_AMBIGUOUS");
                found = i;
            }
        return found;
    }
    static int VoiceUiaAncestor(IList<VoiceUiaNode> nodes, int index, string cls)
    {
        for (int depth = 0; index >= 0 && depth < 128; depth++)
        {
            index = nodes[index].Parent;
            if (index >= 0 && nodes[index].Class == cls)
                return index;
        }
        return -1;
    }
    static bool VoiceUiaWithin(IList<VoiceUiaNode> nodes, int index, int ancestor)
    {
        for (int depth = 0; index >= 0 && depth < 128; depth++)
        {
            if (index == ancestor)
                return true;
            index = nodes[index].Parent;
        }
        return false;
    }
    static AutomationElement VoiceUiaReplay(AutomationElement root, int[] path, Stopwatch timer)
    {
        var walker = TreeWalker.RawViewWalker;
        var cache = VoiceUiaCache();
        var node = root;
        int visited = 0;
        foreach (int position in path)
        {
            Need(position >= 0 && position < 512 && timer.ElapsedMilliseconds <= 1000, "VOICE_UIA_LOCATOR_CHANGED");
            node = walker.GetFirstChild(node, cache);
            for (int i = 0; i < position && node != null; i++)
            {
                Need(++visited <= 512 && timer.ElapsedMilliseconds <= 1000, "VOICE_UIA_SCAN_LIMIT");
                node = walker.GetNextSibling(node, cache);
            }
            Need(node != null, "VOICE_UIA_LOCATOR_CHANGED");
        }
        return node;
    }
    static AutomationElement VoiceUiaRoot(VoiceRequest request, Stopwatch timer)
    {
        VoiceBoundWindowGuard(request);
        Need(FileVersionInfo.GetVersionInfo(request.Binding.Executable).FileVersion == "4.2.0.53",
             "VOICE_UIA_VERSION_CHANGED");
        AutomationElement root;
        using (VoiceUiaCache().Activate()) root = AutomationElement.FromHandle(request.Binding.Window);
        Need(root != null && root.Cached.ProcessId == (int)request.Binding.Pid &&
                 root.Cached.ClassName == "mmui::MainWindow",
             "VOICE_UIA_ROOT_CHANGED");
        string rootId = VoiceUiaRuntime(root);
        var plan = request.Uia;
        if (plan.Root == null)
        {
            var nodes = VoiceUiaWalk(root, request.Binding.Pid, 512, 96, true, timer);
            int input = VoiceUiaUnique(nodes, delegate(int i) {
                return nodes[i].Class == "mmui::ChatInputView" && nodes[i].Type == "ControlType.Group";
            }), header = VoiceUiaUnique(nodes, delegate(int i) {
                    return nodes[i].Class == "mmui::ChatTitleBarMasterView" &&
                           nodes[i].Runtime == plan.Conversation.Header;
                });
            Need(input >= 0 && header >= 0, "VOICE_UIA_SCOPE_UNAVAILABLE");
            int page = VoiceUiaAncestor(nodes, input, "mmui::ChatMessagePage");
            Need(page >= 0 && page == VoiceUiaAncestor(nodes, header, "mmui::ChatMessagePage") &&
                     nodes[page].Id == "chat_message_page" && nodes[page].Enabled && VoiceUiaVisible(nodes[page]),
                 "VOICE_UIA_PAGE_CHANGED");
            plan.Root = rootId;
            plan.Input = nodes[input].Runtime;
            plan.Page = nodes[page].Runtime;
            plan.InputPath = nodes[input].Path;
            plan.HeaderPath = nodes[header].Path;
            plan.PagePath = nodes[page].Path;
        }
        else
            Need(plan.Root == rootId, "VOICE_UIA_ROOT_CHANGED");
        var pageElement = VoiceUiaReplay(root, plan.PagePath, timer);
        var pageInfo = pageElement.Cached;
        Need(pageInfo.ProcessId == (int)request.Binding.Pid && pageInfo.ClassName == "mmui::ChatMessagePage" &&
                 pageInfo.AutomationId == "chat_message_page" && pageInfo.IsEnabled && !pageInfo.IsOffscreen &&
                 VoiceUiaRuntime(pageElement) == plan.Page,
             "VOICE_UIA_PAGE_CHANGED");
        return root;
    }
    static string VoiceUiaTitleDigest(IList<string> texts)
    {
        Need(texts.Count >= 1 && texts.Count <= 4, "VOICE_UIA_TITLE_UNAVAILABLE");
        var framed = new StringBuilder("chat-title-text-v1\n");
        int total = 0;
        foreach (string value in texts)
        {
            Need(value != null && value.Length > 0 && value.Length <= 256 && value.IndexOf('\0') < 0 &&
                     (total += value.Length) <= 512,
                 "VOICE_UIA_TITLE_UNAVAILABLE");
            framed.Append(value.Length.ToString(CultureInfo.InvariantCulture)).Append(':').Append(value).Append('\n');
        }
        return VoiceUiaHash(framed.ToString());
    }
    static void VoiceUiaConversation(VoiceRequest request)
    {
        var timer = Stopwatch.StartNew();
        VoiceUiaConversationCurrent(request, timer, VoiceUiaRoot(request, timer));
    }
    static void VoiceUiaConversationCurrent(VoiceRequest request, Stopwatch timer, AutomationElement root)
    {
        var header = VoiceUiaReplay(root, request.Uia.HeaderPath, timer);
        Need(VoiceUiaRuntime(header) == request.Uia.Conversation.Header, "VOICE_UIA_TITLE_CHANGED");
        var nodes = VoiceUiaWalk(header, request.Binding.Pid, 64, 24, false, timer);
        int title = VoiceUiaUnique(nodes, delegate(int i) {
            return nodes[i].Class == "mmui::XHBoxView" && nodes[i].Type == "ControlType.Text" &&
                   (VoiceUiaAncestor(nodes, i, "mmui::ChatTitleBarChatSingleView") >= 0 ||
                    VoiceUiaAncestor(nodes, i, "mmui::ChatTitleBarChatRoomView") >= 0);
        });
        Need(title >= 0 && nodes[title].Runtime == request.Uia.Conversation.Title, "VOICE_UIA_TITLE_CHANGED");
        var selected = new List<int>();
        var texts = new List<string>();
        for (int i = title + 1; i < nodes.Count; i++)
            if (nodes[i].Parent == title && VoiceUiaVisible(nodes[i]) && nodes[i].Class == "mmui::XTextView" &&
                nodes[i].Type == "ControlType.Text")
            {
                selected.Add(i);
                texts.Add(nodes[i].Element.Current.Name);
            }
        Need(selected.Count == request.Uia.Conversation.Count &&
                 VoiceUiaTitleDigest(texts) == request.Uia.Conversation.Hash,
             "VOICE_UIA_TITLE_CHANGED");
        var again = new List<string>();
        foreach (int index in selected)
        {
            var node = nodes[index];
            var textCache = VoiceUiaCache();
            textCache.Add(AutomationElement.NameProperty);
            var element = VoiceUiaReplay(header, node.Path, timer).GetUpdatedCache(textCache);
            var info = element.Cached;
            Need(info.ProcessId == (int)request.Binding.Pid && !info.IsOffscreen && info.ClassName == node.Class &&
                     info.ControlType.ProgrammaticName == node.Type && info.AutomationId == node.Id &&
                     VoiceUiaRuntime(element) == node.Runtime,
                 "VOICE_UIA_TITLE_CHANGED");
            again.Add(info.Name);
        }
        Need(VoiceUiaTitleDigest(again) == request.Uia.Conversation.Hash &&
                 VoiceUiaRuntime(VoiceUiaReplay(root, request.Uia.HeaderPath, timer)) ==
                     request.Uia.Conversation.Header,
             "VOICE_UIA_TITLE_CHANGED");
        VoiceBoundWindowGuard(request);
        request.Uia.ConversationChecks++;
    }
    static string VoiceUiaKnownLabel(string value)
    {
        if (value == "发语音 ( 按住右 Alt )" || value == "语音消息" || value == "发送语音消息" ||
            value == "录制语音消息" || value == "Voice message" || value == "Send voice message" ||
            value == "Record voice message")
            return "start";
        if (value == "取消" || value == "Cancel")
            return "cancel";
        return null;
    }
    static string VoiceUiaReadButtonLabel(AutomationElement element)
    {
        var cache = new CacheRequest();
        cache.TreeScope = TreeScope.Element;
        cache.Add(AutomationElement.NameProperty);
        cache.Add(AutomationElement.HelpTextProperty);
        var info = element.GetUpdatedCache(cache).Cached;
        return VoiceUiaKnownLabel(info.Name) ?? VoiceUiaKnownLabel(info.HelpText);
    }
    static VoiceUiaState VoiceUiaResolveState(IList<VoiceUiaNode> nodes)
    {
        Need(nodes.Count > 0 && nodes[0].Class == "mmui::ChatInputView" && nodes[0].Type == "ControlType.Group" &&
                 VoiceUiaVisible(nodes[0]) && nodes[0].Enabled,
             "VOICE_UIA_SCOPE_UNAVAILABLE");
        int right = VoiceUiaUnique(nodes, delegate(int i) {
            return nodes[i].Class == "mmui::ChatInputToolbarRightView" && nodes[i].Type == "ControlType.Group" &&
                   nodes[i].Id == "tool_bar_accessible.chatinput_toolbar_right_view" && nodes[i].Enabled;
        });
        Need(right >= 0, "VOICE_UIA_TOOLBAR_UNAVAILABLE");
        int recorder = VoiceUiaUnique(nodes, delegate(int i) {
            return nodes[i].Class == "mmui::ChatVoiceRecordView" && nodes[i].Type == "ControlType.Group" &&
                   nodes[i].Enabled && VoiceUiaWithin(nodes, i, right);
        });
        int start = VoiceUiaUnique(nodes, delegate(int i) {
            return nodes[i].Class == "mmui::XButton" && nodes[i].Type == "ControlType.Button" && nodes[i].Enabled &&
                   nodes[i].Label == "start" && VoiceUiaWithin(nodes, i, right) &&
                   VoiceUiaAncestor(nodes, i, "mmui::ChatVoiceRecordView") < 0;
        });
        if (recorder < 0)
            return new VoiceUiaState { Kind = start >= 0 ? "idle" : "transition",
                                       Start = start >= 0 ? nodes[start] : null };
        Need(start < 0, "VOICE_UIA_STATE_AMBIGUOUS");
        int cancel = VoiceUiaUnique(nodes, delegate(int i) {
            return nodes[i].Class == "mmui::XButton" && nodes[i].Type == "ControlType.Button" && nodes[i].Enabled &&
                   nodes[i].Label == "cancel" && VoiceUiaWithin(nodes, i, recorder);
        });
        int sendRoot = VoiceUiaUnique(nodes, delegate(int i) {
            return nodes[i].Class == "mmui::XHBoxView" && nodes[i].Type == "ControlType.Group" &&
                   nodes[i].Id == "send_icon_root_view_" && nodes[i].Enabled && VoiceUiaWithin(nodes, i, recorder);
        });
        int submit = sendRoot < 0 ? -1
                                  : VoiceUiaUnique(nodes,
                                                   delegate(int i) {
                                                       return nodes[i].Parent == sendRoot &&
                                                              nodes[i].Class == "mmui::XMouseEventView" &&
                                                              nodes[i].Type == "ControlType.Button" && nodes[i].Enabled;
                                                   });
        if (cancel < 0 || submit < 0)
            return new VoiceUiaState { Kind = "transition", Recorder = nodes[recorder].Runtime };
        Need(!Intersects(nodes[cancel].Rect, nodes[submit].Rect) &&
                 Contains(nodes[recorder].Rect, nodes[cancel].Rect) &&
                 Contains(nodes[recorder].Rect, nodes[submit].Rect),
             "VOICE_UIA_STATE_AMBIGUOUS");
        return new VoiceUiaState { Kind = "recording", Recorder = nodes[recorder].Runtime, Cancel = nodes[cancel],
                                   Submit = nodes[submit] };
    }
    static VoiceUiaState VoiceUiaReadState(VoiceRequest request)
    {
        var timer = Stopwatch.StartNew();
        return VoiceUiaReadStateCurrent(request, timer, VoiceUiaRoot(request, timer));
    }
    static VoiceUiaState VoiceUiaReadStateCurrent(VoiceRequest request, Stopwatch timer, AutomationElement root)
    {
        var input = VoiceUiaReplay(root, request.Uia.InputPath, timer);
        Need(VoiceUiaRuntime(input) == request.Uia.Input, "VOICE_UIA_SCOPE_CHANGED");
        var nodes = VoiceUiaWalk(input, request.Binding.Pid, 128, 32, false, timer);
        for (int i = 0; i < nodes.Count; i++)
            if (VoiceUiaVisible(nodes[i]) && nodes[i].Type == "ControlType.Button" &&
                nodes[i].Class == "mmui::XButton" && VoiceUiaAncestor(nodes, i, "mmui::ChatInputToolbarRightView") >= 0)
            {
                nodes[i].Label = VoiceUiaReadButtonLabel(nodes[i].Element);
            }
        var state = VoiceUiaResolveState(nodes);
        foreach (var node in new[] { state.Start, state.Cancel, state.Submit })
            if (node != null)
            {
                var live = VoiceUiaReplay(input, node.Path, timer);
                var current = VoiceUiaDescribe(live, request.Binding.Pid, node.Parent, node.Path);
                Need(current.Enabled && VoiceUiaVisible(current) && current.Runtime == node.Runtime &&
                         current.Class == node.Class && current.Type == node.Type && current.Id == node.Id &&
                         Same(current.Rect, node.Rect),
                     "VOICE_UIA_CONTROL_CHANGED");
                Need(Contains(request.Binding.Capture, current.Rect), "VOICE_UIA_CONTROL_CHANGED");
                if (node.Label != null)
                {
                    Need(VoiceUiaReadButtonLabel(live) == node.Label, "VOICE_UIA_CONTROL_CHANGED");
                }
            }
        if (state.Kind == "recording" && request.Uia.Recorder != null)
            Need(state.Recorder == request.Uia.Recorder, "VOICE_UIA_RECORDER_CHANGED");
        VoiceBoundWindowGuard(request);
        request.Uia.Reads++;
        request.Uia.LastObservedState = state.Kind;
        return state;
    }
    static Rect VoiceUiaClientRect(VoiceRequest request, Rect screen)
    {
        var c = request.Binding.Capture;
        return new Rect(screen.Left - c.Left, screen.Top - c.Top, screen.Right - c.Left, screen.Bottom - c.Top);
    }
    static bool VoiceUiaApplyRecordingState(VoiceRequest request, VoiceUiaState state)
    {
        if (state == null || state.Kind != "recording")
            return false;
        Rect cancel = VoiceUiaClientRect(request, state.Cancel.Rect),
             submit = VoiceUiaClientRect(request, state.Submit.Rect);
        if (request.MouseParkProvided)
            Need(!Intersects(cancel, request.MousePark) && !Intersects(submit, request.MousePark),
                 "VOICE_MOUSE_PARK_INVALID");
        request.Cancel = new VoiceTemplate { Rect = cancel };
        request.Submit = new VoiceTemplate { Rect = submit };
        return true;
    }
    static bool VoiceUiaRecording(VoiceRequest request)
    {
        return VoiceUiaApplyRecordingState(request, VoiceUiaReadState(request));
    }
    static bool VoiceUiaIdle(VoiceRequest request)
    {
        var state = VoiceUiaReadState(request);
        return state.Kind == "idle" && Same(VoiceUiaClientRect(request, state.Start.Rect), request.RecordStart);
    }
    static void VoiceUiaCommitRecorder(VoiceRequest request, VoiceUiaState state)
    {
        Need(VoiceUiaApplyRecordingState(request, state), "VOICE_CAPTURE_NOT_READY");
        request.Uia.Recorder = state.Recorder;
        VoiceUiaConversation(request);
    }
    static void VoiceUiaClickGuard(VoiceRequest request, Rect area, int phase)
    {
        VoiceUiaClickStateGuard(request, area, phase, VoiceUiaReadState(request));
    }
    // Explicit single-operation scope: callers cannot retain this root across
    // input. Title and recorder roles still get independent fresh observations.
    static void VoiceUiaCombinedObservation<T>(Func<T> root, Action<T> conversation, Action<T> state)
    {
        var current = root();
        conversation(current);
        state(current);
    }
    static void VoiceUiaConversationAndClickGuard(VoiceRequest request, Rect area, int phase)
    {
        var timer = Stopwatch.StartNew();
        VoiceUiaCombinedObservation<AutomationElement>(
            delegate { return VoiceUiaRoot(request, timer); },
            delegate(AutomationElement root) { VoiceUiaConversationCurrent(request, timer, root); },
            delegate(AutomationElement root) {
                VoiceUiaClickStateGuard(request, area, phase, VoiceUiaReadStateCurrent(request, timer, root));
            });
    }
    static void VoiceUiaClickStateGuard(VoiceRequest request, Rect area, int phase, VoiceUiaState state)
    {
        Need(phase == 0 ? state.Kind == "idle" && Same(area, request.RecordStart) &&
                              Same(area, VoiceUiaClientRect(request, state.Start.Rect))
                        : phase == 1 && state.Kind == "recording" && request.Uia.Recorder != null &&
                              Same(area, VoiceUiaClientRect(request, state.Submit.Rect)),
             "VOICE_UIA_CLICK_ROLE_CHANGED");
    }
    static VoiceUiaNode VoiceUiaFixture(int parent, string cls, string type, string id, Rect rect, string label = null)
    {
        return new VoiceUiaNode { Parent = parent,
                                  Class = cls,
                                  Type = type,
                                  Id = id,
                                  Rect = rect,
                                  HasRect = true,
                                  Enabled = true,
                                  Label = label,
                                  Runtime = VoiceUiaHash(cls + parent.ToString(CultureInfo.InvariantCulture)) };
    }
    static int VoiceUiaSelfTest()
    {
        int n = 0;
        Need(!VoiceDirectedPointer(true, 0, true) && VoiceDirectedPointer(true, 0, false) &&
                 VoiceDirectedPointer(true, 1, true) && !VoiceDirectedPointer(false, 0, true),
             "TEST_VOICE_VISIBLE_START_USES_MARKED_MOUSE_WITHOUT_RETRY");
        n++;
        int roots = 0, titles = 0, states = 0;
        object previous = null;
        Func<object> newRoot = delegate
        {
            roots++;
            return new object();
        };
        Action<object> titleCheck = delegate(object root)
        {
            titles++;
            Need(!Object.ReferenceEquals(previous, root), "TEST_VOICE_UIA_COMBINED_NEW_OPERATION_FRESH");
            previous = root;
        };
        Action<object> stateCheck = delegate(object root)
        {
            states++;
            Need(Object.ReferenceEquals(previous, root), "TEST_VOICE_UIA_COMBINED_SAME_OPERATION_ROOT");
        };
        VoiceUiaCombinedObservation(newRoot, titleCheck, stateCheck);
        Need(roots == 1 && titles == 1 && states == 1, "TEST_VOICE_UIA_COMBINED_ONE_ROOT_BOTH_CHECKS");
        n++;
        VoiceUiaCombinedObservation(newRoot, titleCheck, stateCheck);
        Need(roots == 2 && titles == 2 && states == 2, "TEST_VOICE_UIA_COMBINED_NO_CROSS_OPERATION_REUSE");
        n++;
        Expect(delegate {
            VoiceUiaCombinedObservation(newRoot, delegate(object root) { throw new Fault("VOICE_UIA_TITLE_CHANGED"); },
                                        stateCheck);
        }, "VOICE_UIA_TITLE_CHANGED");
        Need(states == 2, "TEST_VOICE_UIA_COMBINED_TITLE_FAILURE_NO_ROLE_ACTION");
        n++;
        var proof = Data("version", 1, "scope", "chat-title-text-v1", "sha256", new string('a', 64),
                         "headerRuntimeIdSha256", new string('b', 64), "titleRuntimeIdSha256", new string('c', 64),
                         "textNodeCount", 2, "targetVerified", false);
        var fingerprint = ParseVoiceUiaFingerprint(proof);
        Need(fingerprint.Count == 2 && SameVoiceUiaFingerprint(fingerprint, ParseVoiceUiaFingerprint(proof)),
             "TEST_VOICE_UIA_FINGERPRINT");
        n++;
        foreach (string field in new[] { "sha256", "headerRuntimeIdSha256", "titleRuntimeIdSha256", "scope",
                                         "targetVerified", "textNodeCount", "version" })
        {
            var changed = new Dictionary<string, object>(proof);
            changed[field] = field == "targetVerified"                        ? (object) true
                             : field == "version" || field == "textNodeCount" ? (object)9
                                                                              : (object) "bad";
            Expect(delegate { ParseVoiceUiaFingerprint(changed); }, "VOICE_UIA_CONVERSATION_INVALID");
            n++;
        }
        var extra = new Dictionary<string, object>(proof);
        extra["title"] = "must never be transported";
        Expect(delegate { ParseVoiceUiaFingerprint(extra); }, "VOICE_UIA_CONVERSATION_INVALID");
        n++;
        var plan = Data("version", 1, "executableVersion", "4.2.0.53", "conversationFingerprint", proof);
        Need(SameVoiceUiaFingerprint(ParseVoiceUia(plan).Conversation, fingerprint), "TEST_VOICE_UIA_PLAN");
        n++;
        foreach (var invalid in new[] { Data("version", 1, "executableVersion", "4.2.0.53"),
                                        Data("version", 1, "executableVersion", "4.1.15.57", "conversationFingerprint",
                                             proof),
                                        Data("version", 1, "executableVersion", "4.2.0.53", "conversationFingerprint",
                                             proof, "toolbarRect", new Rect(0, 0, 1, 1).Report()) })
        {
            Expect(delegate { ParseVoiceUia(invalid); }, "VOICE_UIA_PLAN_INVALID");
            n++;
        }
        Need(VoiceUiaTitleDigest(new[] { "room", "(2)" }) != VoiceUiaTitleDigest(new[] { "room", "(3)" }) &&
                 VoiceUiaTitleDigest(new[] { "a", "bc" }) != VoiceUiaTitleDigest(new[] { "ab", "c" }),
             "TEST_VOICE_UIA_TITLE_SAME_FRAMED_CONTENT");
        n++;
        Need(VoiceUiaKnownLabel("取消") == "cancel" && VoiceUiaKnownLabel("发语音 ( 按住右 Alt )") == "start" &&
                 VoiceUiaKnownLabel("发送") == null && VoiceUiaKnownLabel("取消给某人") == null,
             "TEST_VOICE_UIA_STATIC_LABELS_ONLY");
        n++;
        var nodes = new List<VoiceUiaNode> {
            VoiceUiaFixture(-1, "mmui::ChatInputView", "ControlType.Group", null, new Rect(0, 400, 800, 600)),
            VoiceUiaFixture(0, "mmui::ChatInputToolbarRightView", "ControlType.Group",
                            "tool_bar_accessible.chatinput_toolbar_right_view", new Rect(400, 530, 790, 590)),
            VoiceUiaFixture(1, "mmui::XButton", "ControlType.Button", null, new Rect(710, 540, 750, 580), "start")
        };
        Need(VoiceUiaResolveState(nodes).Kind == "idle" && VoiceUiaResolveState(nodes).Start == nodes[2],
             "TEST_VOICE_UIA_IDLE_START_ROLE");
        n++;
        nodes[2].Enabled = false;
        Need(VoiceUiaResolveState(nodes).Kind == "transition", "TEST_VOICE_UIA_DISABLED_START_NOT_READY");
        n++;
        nodes.RemoveAt(2);
        nodes.Add(
            VoiceUiaFixture(1, "mmui::ChatVoiceRecordView", "ControlType.Group", null, new Rect(450, 530, 790, 590)));
        nodes.Add(
            VoiceUiaFixture(2, "mmui::XButton", "ControlType.Button", null, new Rect(460, 540, 500, 580), "cancel"));
        nodes.Add(VoiceUiaFixture(2, "mmui::XHBoxView", "ControlType.Group", "send_icon_root_view_",
                                  new Rect(510, 530, 790, 590)));
        nodes.Add(
            VoiceUiaFixture(4, "mmui::XMouseEventView", "ControlType.Button", null, new Rect(740, 540, 780, 580)));
        nodes.Add(
            VoiceUiaFixture(2, "mmui::XMouseEventView", "ControlType.Button", null, new Rect(510, 530, 790, 590)));
        var state = VoiceUiaResolveState(nodes);
        Need(state.Kind == "recording" && state.Submit == nodes[5] && state.Cancel == nodes[3] &&
                 state.Recorder == nodes[2].Runtime,
             "TEST_VOICE_UIA_RECORDING_ACTUAL_INNER_SEND_NOT_WIDE_DRAG_AREA");
        n++;
        var noPark =
            new VoiceRequest { Binding = new Request { Capture = new Rect(0, 0, 800, 600) }, Uia = new VoiceUiaPlan() };
        Need(VoiceUiaApplyRecordingState(noPark, state) && Same(noPark.Cancel.Rect, state.Cancel.Rect) &&
                 Same(noPark.Submit.Rect, state.Submit.Rect),
             "TEST_VOICE_UIA_RECORDING_WITHOUT_UNUSED_PARK");
        n++;
        noPark.MouseParkProvided = true;
        noPark.MousePark = state.Cancel.Rect;
        Expect(delegate { VoiceUiaApplyRecordingState(noPark, state); }, "VOICE_MOUSE_PARK_INVALID");
        n++;
        foreach (string invalid in new[] { "wrong", "send_icon_root_view_.extra", "SEND_ICON_ROOT_VIEW_", null })
        {
            nodes[4].Id = invalid;
            Need(VoiceUiaResolveState(nodes).Kind == "transition", "TEST_VOICE_UIA_SEND_STATIC_PARENT_REQUIRED");
            n++;
        }
        nodes[4].Id = "send_icon_root_view_";
        nodes[5].Parent = 2;
        Need(VoiceUiaResolveState(nodes).Kind == "transition", "TEST_VOICE_UIA_SEND_DIRECT_CHILD_REQUIRED");
        n++;
        nodes[5].Parent = 4;
        nodes[5].Class = "mmui::XOutlineButton";
        Need(VoiceUiaResolveState(nodes).Kind == "transition", "TEST_VOICE_UIA_NORMAL_SEND_NOT_RECORDER_SUBMIT");
        n++;
        nodes[5].Class = "mmui::XMouseEventView";
        nodes[3].Offscreen = true;
        Need(VoiceUiaResolveState(nodes).Kind == "transition", "TEST_VOICE_UIA_CANCEL_VISIBLE_REQUIRED");
        n++;
        nodes[3].Offscreen = false;
        nodes[5].Enabled = false;
        Need(VoiceUiaResolveState(nodes).Kind == "transition", "TEST_VOICE_UIA_SUBMIT_ENABLED_REQUIRED");
        n++;
        nodes[5].Enabled = true;
        nodes.Add(
            VoiceUiaFixture(4, "mmui::XMouseEventView", "ControlType.Button", null, new Rect(690, 540, 730, 580)));
        Expect(delegate { VoiceUiaResolveState(nodes); }, "VOICE_UIA_ROLE_AMBIGUOUS");
        n++;
        nodes.RemoveAt(nodes.Count - 1);
        nodes.Add(
            VoiceUiaFixture(1, "mmui::XButton", "ControlType.Button", null, new Rect(700, 540, 740, 580), "start"));
        Expect(delegate { VoiceUiaResolveState(nodes); }, "VOICE_UIA_STATE_AMBIGUOUS");
        n++;
        nodes.RemoveAt(nodes.Count - 1);
        nodes[5].Rect = nodes[3].Rect;
        Expect(delegate { VoiceUiaResolveState(nodes); }, "VOICE_UIA_STATE_AMBIGUOUS");
        n++;
        Expect(delegate { TemplateMatches(new VoiceRequest { Uia = new VoiceUiaPlan() }, new VoiceTemplate()); },
               "VOICE_UIA_PIXEL_PATH_FORBIDDEN");
        n++;
        long at = 0;
        int idleReads = 0, inactiveReads = 0, guards = 0;
        bool ended = VoiceObserveUiaEnd(delegate { guards++; },
                                        delegate {
                                            inactiveReads++;
                                            return true;
                                        },
                                        delegate {
                                            idleReads++;
                                            return true;
                                        },
                                        delegate { return at; }, delegate(int ms) { at += ms; });
        Need(ended && at == 40 && idleReads == 1 && inactiveReads == 3 && guards >= 3,
             "TEST_VOICE_UIA_END_ONE_SEMANTIC_READ_AFTER_STABLE_AUDIO");
        n++;
        at = 0;
        idleReads = 0;
        ended = VoiceObserveUiaEnd(delegate {}, delegate { return false; },
                                   delegate {
                                       idleReads++;
                                       return true;
                                   },
                                   delegate { return at; }, delegate(int ms) { at += ms; });
        Need(!ended && idleReads == 0 && at == 1000, "TEST_VOICE_UIA_END_ACTIVE_AUDIO_NEVER_SCANS_IDLE");
        n++;
        at = 0;
        idleReads = 0;
        inactiveReads = 0;
        ended = VoiceObserveUiaEnd(delegate {}, delegate { return ++inactiveReads != 3; },
                                   delegate {
                                       idleReads++;
                                       return true;
                                   },
                                   delegate { return at; }, delegate(int ms) { at += ms; });
        Need(ended && idleReads == 2 && at >= 120, "TEST_VOICE_UIA_END_CAPTURE_REACTIVATION_REQUIRES_NEW_STABILITY");
        n++;
        at = 0;
        ended = VoiceObserveUiaEnd(delegate {}, delegate { return true; }, delegate { return false; },
                                   delegate { return at; }, delegate(int ms) { at += ms; });
        Need(!ended && at == 1000, "TEST_VOICE_UIA_END_IDLE_REQUIRED");
        n++;
        Expect(delegate {
            VoiceObserveUiaEnd(delegate { throw new Fault("DRAFT_HUMAN_ACTIVITY_CHANGED"); }, delegate { return true; },
                               delegate { return true; }, delegate { return 0; }, delegate(int ms) {});
        }, "DRAFT_HUMAN_ACTIVITY_CHANGED");
        n++;
        return n;
    }
}
