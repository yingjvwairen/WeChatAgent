using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Forms;

internal static partial class WechatDraftProbe
{
    sealed class QtPopupCalibration
    {
        internal string Kind, ClassName, OwnerRelation;
        internal Rect RelativeWindow;
        internal int ClientWidth, ClientHeight, OwnerDepth, MinHeight, MaxHeight;
        internal long Style, ExtendedStyle;
        internal HashSet<int> HeightVariants = new HashSet<int>();
    }
    sealed class QtPopupLease
    {
        internal string Id;
        internal QtPopupCalibration Calibration;
        internal Binding Root;
        internal long Revision, Issued;
        internal HashSet<IntPtr> PreviouslyVisible;
        internal IntPtr Window;
        internal bool Observed, UiaSearch;
        internal Rect ObservedBounds, ObservedClient, ObservedClientScreen;
        internal QtQueryClickProof QueryClick;
    }
    sealed class QtQueryClickProof
    {
        internal QtPopupLease Popup;
        internal QtFrame Frame;
        internal string Epoch;
        internal bool Consumed;
    }
    sealed class QtSearchPasteCompletion
    {
        internal QtPopupLease Popup;
        internal QtQueryClickProof QueryClick;
    }
    static QtPopupLease QtPendingPopup, QtPopup;
    // Error-only observation context. It never supplies a token or changes a guard.
    static string QtSurface = "main";
    delegate bool QtEnumWindow(IntPtr hwnd, IntPtr value);
    [DllImport("user32.dll")]
    static extern bool EnumWindows(QtEnumWindow callback, IntPtr value);
    [DllImport("user32.dll")]
    static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
    [DllImport("user32.dll")]
    static extern IntPtr GetWindow(IntPtr hwnd, uint command);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int GetClassName(IntPtr hwnd, StringBuilder name, int maximum);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
    static extern IntPtr GetWindowLongPtr(IntPtr hwnd, int index);
    [DllImport("user32.dll")]
    static extern bool GetLayeredWindowAttributes(IntPtr hwnd, out uint colorKey, out byte alpha, out uint flags);
    static bool QtOwnedPopupChain(IntPtr window, IntPtr root, uint pid, Func<IntPtr, uint> process,
                                  Func<IntPtr, IntPtr> owner)
    {
        for (int depth = 0; window != IntPtr.Zero && depth < 16; depth++)
        {
            if (pid == 0 || process(window) != pid)
                return false;
            if (window == root)
                return true;
            window = owner(window);
        }
        return false;
    }
    static bool QtOwnedPopup(IntPtr window, IntPtr root)
    {
        uint pid;
        GetWindowThreadProcessId(root, out pid);
        return QtOwnedPopupChain(window, root, pid,
                                 delegate(IntPtr w) {
                                     uint p;
                                     GetWindowThreadProcessId(w, out p);
                                     return p;
                                 },
                                 delegate(IntPtr w) { return GetWindow(w, 4); });
    }
    static QtPopupCalibration QtParsePopupCalibration(object value, bool observed = false)
    {
        var data = Map(value);
        Need(data != null &&
                 data.Count == (observed                                                                ? 7
                                : data.ContainsKey("heightVariants") || data.ContainsKey("heightRange") ? 11
                                                                                                        : 10) &&
                 Number(Get(data, "version")) == 1,
             "QT_POPUP_CALIBRATION_INVALID");
        string kind = Text(data, "kind"), name = Text(data, "className"), relation = Text(data, "ownerRelation");
        Need((kind == "profile" || kind == "search") && !String.IsNullOrEmpty(name) && name.Length <= 256 &&
                 name.IndexOf('\0') < 0 && name.IndexOf('\r') < 0 && name.IndexOf('\n') < 0,
             "QT_POPUP_CALIBRATION_INVALID");
        long depth = Number(Get(data, "ownerDepth")), style = Number(Get(data, "style")),
             extended = Number(Get(data, "extendedStyle"));
        Need((relation == "root-owned" && depth >= 1 && depth <= 16 ||
              relation == "same-thread-unowned" && depth == 0) &&
                 style >= Int32.MinValue && style <= UInt32.MaxValue && extended >= Int32.MinValue &&
                 extended <= UInt32.MaxValue,
             "QT_POPUP_CALIBRATION_INVALID");
        if (observed)
            return new QtPopupCalibration {
                Kind = kind,   ClassName = name,        OwnerRelation = relation, OwnerDepth = (int)depth,
                Style = style, ExtendedStyle = extended
            };
        long width = Number(Get(data, "clientWidth")), height = Number(Get(data, "clientHeight"));
        Need(width >= 20 && width <= 4096 && height >= 20 && height <= 4096, "QT_POPUP_CALIBRATION_INVALID");
        Rect region = ParseRect(Get(data, "windowRect"));
        Need(region.Width <= 4096 && region.Height <= 4096, "QT_POPUP_CALIBRATION_INVALID");
        var result = new QtPopupCalibration { Kind = kind,
                                              ClassName = name,
                                              OwnerRelation = relation,
                                              OwnerDepth = (int)depth,
                                              RelativeWindow = region,
                                              ClientWidth = (int)width,
                                              ClientHeight = (int)height,
                                              Style = style,
                                              ExtendedStyle = extended };
        if (data.ContainsKey("heightVariants"))
        {
            var values = Get(data, "heightVariants") as object[];
            Need(kind == "search" && region.Height == height && values != null && values.Length >= 1 &&
                     values.Length <= 4,
                 "QT_POPUP_CALIBRATION_INVALID");
            foreach (var item in values)
            {
                long h = Number(item);
                Need(h >= 20 && h <= 4096 && result.HeightVariants.Add((int)h), "QT_POPUP_CALIBRATION_INVALID");
            }
        }
        if (data.ContainsKey("heightRange"))
        {
            var range = Map(Get(data, "heightRange"));
            Need(kind == "search" && region.Height == height && range != null && range.Count == 2,
                 "QT_POPUP_CALIBRATION_INVALID");
            long min = Number(Get(range, "min")), max = Number(Get(range, "max"));
            Need(min >= 20 && max <= 4096 && min <= height && max >= height, "QT_POPUP_CALIBRATION_INVALID");
            result.MinHeight = (int)min;
            result.MaxHeight = (int)max;
        }
        return result;
    }
    // A virtual desktop rectangle includes gaps between monitors. Subtract
    // actual monitor coverage rather than accepting a clipped popup in a gap.
    static bool QtCoveredByDisplays(Rect area, List<Rect> displays)
    {
        return FocusCoveredByDisplays(area, displays);
    }
    // The UIA search surface is read as metadata and receives guarded keyboard
    // input. It does not need monitor pixels. This capability is minted only by
    // the native UIA navigation frame; caller-supplied geometry cannot enable it.
    static bool QtPopupUsesUiaSearch(QtFrame frame, QtFocusLease lease, bool observed, string id,
                                     QtPopupCalibration calibration)
    {
        return observed && id == "search" && calibration != null && calibration.Kind == "search" && frame != null &&
               frame.MetadataOnly && frame.NavigationOnly && lease != null && lease.UiaMode &&
               QtNavigationLeaseMatches(frame, lease);
    }
    static bool QtPopupMetadataSearch(QtPopupLease lease)
    {
        return lease != null && lease.UiaSearch && lease.Observed && lease.Id == "search" &&
               lease.Calibration != null && lease.Calibration.Kind == "search";
    }
    static bool QtPopupDisplayAllowed(QtPopupLease lease, Rect bounds, List<Rect> displays)
    {
        return QtPopupMetadataSearch(lease) || QtCoveredByDisplays(bounds, displays);
    }
    static void QtPopupObservationPause(QtPopupLease lease, Action<int> wait)
    {
        if (!QtPopupMetadataSearch(lease))
            wait(35);
    }
    static List<Rect> QtPopupDisplays()
    {
        var displays = new List<Rect>();
        foreach (Screen screen in Screen.AllScreens)
        {
            Rectangle b = screen.Bounds;
            displays.Add(new Rect(b.Left, b.Top, b.Right, b.Bottom));
        }
        return displays;
    }
    static bool QtPopupOutsideDisplays(Rect root, List<Rect> displays)
    {
        if (displays.Count == 0)
            return false;
        foreach (Rect display in displays)
            if (Intersects(root, display))
                return false;
        return true;
    }
    static bool QtPopupOffscreenScope(QtPopupLease lease, bool rootOutside, bool popupOutside)
    {
        return QtPopupMetadataSearch(lease) && rootOutside && popupOutside &&
               lease.Calibration.ClassName == "Qt51514QWindowToolSaveBits" &&
               lease.Calibration.OwnerRelation == "root-owned" && lease.Calibration.OwnerDepth == 1;
    }
    static bool QtPopupOffscreenSearch(QtPopupLease lease, Rect bounds)
    {
        var displays = QtPopupDisplays();
        return QtPopupOffscreenScope(lease, QtPopupOutsideDisplays(lease.Root.Capture, displays),
                                     QtPopupOutsideDisplays(bounds, displays));
    }
    static bool QtPopupShapeAllowed(Rect bounds, Rect client, Rect clientScreen)
    {
        return client.Left == 0 && client.Top == 0 && client.Width >= 20 && client.Height >= 20 &&
               client.Width <= 4096 && client.Height <= 4096 && (long)client.Width * client.Height <= 12000000 &&
               bounds.Width >= client.Width && bounds.Height >= client.Height && bounds.Width <= 4096 &&
               bounds.Height <= 4096 && Contains(bounds, clientScreen);
    }
    static bool QtPopupGeometryAllowed(Rect bounds, Rect client, Rect clientScreen, QtPopupLease lease,
                                       bool offscreenSearch = false)
    {
        if (!QtPopupShapeAllowed(bounds, client, clientScreen))
            return false;
        // An offscreen result list may follow Qt's own positioning outside its
        // parent's client. No pointer or pixel operation uses that rectangle:
        // the UIA query field remains inside the unchanged main window.
        if (offscreenSearch)
        {
            if (!QtPopupMetadataSearch(lease) || bounds.Width > lease.Root.Client.Width ||
                bounds.Height > lease.Root.Client.Height)
                return false;
        }
        else if (lease.Calibration.Kind == "search" && !Contains(lease.Root.Capture, bounds))
            return false;
        if (lease.Window == IntPtr.Zero)
            return true;
        if (lease.Calibration.Kind == "profile")
            return Same(bounds, lease.ObservedBounds) && Same(client, lease.ObservedClient) &&
                   Same(clientScreen, lease.ObservedClientScreen);
        if (offscreenSearch)
            return bounds.Width == lease.ObservedBounds.Width && client.Width == lease.ObservedClient.Width &&
                   clientScreen.Left - bounds.Left == lease.ObservedClientScreen.Left - lease.ObservedBounds.Left &&
                   clientScreen.Top - bounds.Top == lease.ObservedClientScreen.Top - lease.ObservedBounds.Top &&
                   bounds.Right - clientScreen.Right == lease.ObservedBounds.Right - lease.ObservedClientScreen.Right &&
                   bounds.Bottom - clientScreen.Bottom ==
                       lease.ObservedBounds.Bottom - lease.ObservedClientScreen.Bottom;
        // Search result height may change as the query resolves. Position,
        // width, client origin and non-client margins remain the same.
        return bounds.Left == lease.ObservedBounds.Left && bounds.Top == lease.ObservedBounds.Top &&
               bounds.Right == lease.ObservedBounds.Right && client.Width == lease.ObservedClient.Width &&
               clientScreen.Left == lease.ObservedClientScreen.Left &&
               clientScreen.Top == lease.ObservedClientScreen.Top &&
               bounds.Bottom - clientScreen.Bottom == lease.ObservedBounds.Bottom - lease.ObservedClientScreen.Bottom;
    }
    static Rect QtPopupClientInRoot(QtPopupLease lease)
    {
        Rect client;
        Point origin = new Point(0, 0);
        Need(GetClientRect(lease.Window, out client) && ClientToScreen(lease.Window, ref origin),
             "QT_POPUP_GEOMETRY_UNAVAILABLE");
        return new Rect(origin.X - lease.Root.Capture.Left, origin.Y - lease.Root.Capture.Top,
                        origin.X - lease.Root.Capture.Left + client.Width,
                        origin.Y - lease.Root.Capture.Top + client.Height);
    }
    static bool QtPopupSurface(string surface)
    {
        return surface == "calibrated-profile" || surface == "calibrated-search" || surface == "observed-profile" ||
               surface == "observed-search";
    }
    static bool QtSearchSurface(string surface)
    {
        return surface == "calibrated-search" || surface == "observed-search";
    }
    static bool QtPopupCausalEligible(bool sameProcess, bool sameThread, bool relation, bool exactGeometry,
                                      bool exactClass, bool exactStyle, bool visibleBefore, bool stable)
    {
        return sameProcess && sameThread && relation && exactGeometry && exactClass && exactStyle && !visibleBefore &&
               stable;
    }
    static bool QtPopupOwnerMatches(IntPtr candidate, QtPopupLease lease)
    {
        if (lease.Calibration.OwnerRelation == "same-thread-unowned")
            return GetWindow(candidate, 4) == IntPtr.Zero && GetAncestor(candidate, 3) == candidate;
        IntPtr current = candidate;
        int depth = 0;
        var visited = new HashSet<IntPtr>();
        while (current != IntPtr.Zero && current != lease.Root.Window && depth <= 16 && visited.Add(current))
        {
            uint pid;
            Need(GetWindowThreadProcessId(current, out pid) == lease.Root.Thread && pid == lease.Root.Pid,
                 "QT_POPUP_OWNER_CHANGED");
            current = GetWindow(current, 4);
            depth++;
        }
        return current == lease.Root.Window && depth == lease.Calibration.OwnerDepth;
    }
    static void QtPopupRootStable(QtPopupLease lease)
    {
        Need(lease != null && !Stopping && lease.Revision == Interlocked.Read(ref Revision),
             "QT_HUMAN_ACTIVITY_CHANGED");
        var identity = QtFocusWindow(lease.Root.Window, QtExecutable, true);
        Need(identity.Pid == lease.Root.Pid && identity.Created == lease.Root.Created, "QT_POPUP_PROCESS_CHANGED");
        Rect client;
        Point origin = new Point(0, 0);
        uint pid;
        Need(GetClientRect(lease.Root.Window, out client) && ClientToScreen(lease.Root.Window, ref origin) &&
                 Same(client, lease.Root.Client) && origin.X == lease.Root.Capture.Left &&
                 origin.Y == lease.Root.Capture.Top && GetDpiForWindow(lease.Root.Window) == lease.Root.Dpi &&
                 GetWindowThreadProcessId(lease.Root.Window, out pid) == lease.Root.Thread && pid == lease.Root.Pid,
             "QT_POPUP_ROOT_CHANGED");
    }
    static bool QtPopupWindowMatches(IntPtr candidate, QtPopupLease lease)
    {
        if (candidate == IntPtr.Zero || candidate == lease.Root.Window)
            return false;
        try
        {
            var identity = QtFocusWindow(candidate, QtExecutable, true);
            uint pid;
            uint thread = GetWindowThreadProcessId(candidate, out pid);
            Rect bounds, client;
            Point origin = new Point(0, 0);
            if (!GetWindowRect(candidate, out bounds) || !GetClientRect(candidate, out client) ||
                !ClientToScreen(candidate, ref origin))
                return false;
            var name = new StringBuilder(257);
            GetClassName(candidate, name, name.Capacity);
            QtPopupCalibration c = lease.Calibration;
            // A search result list changes height when the query resolves. Only
            // Only calibrated heights or the bounded search-height range may vary; HWND, width,
            // position, owner, thread and all remaining identity stay fixed.
            bool heightMatches = client.Height == c.ClientHeight ||
                                 c.Kind == "search" &&
                                     (c.HeightVariants.Contains(client.Height) ||
                                      c.MinHeight > 0 && client.Height >= c.MinHeight && client.Height <= c.MaxHeight &&
                                          c.RelativeWindow.Top + c.MaxHeight <= lease.Root.Client.Height);
            int bottom = c.RelativeWindow.Bottom + (client.Height - c.ClientHeight);
            Rect expected =
                new Rect(lease.Root.Capture.Left + c.RelativeWindow.Left, lease.Root.Capture.Top + c.RelativeWindow.Top,
                         lease.Root.Capture.Left + c.RelativeWindow.Right, lease.Root.Capture.Top + bottom);
            bool geometry = Same(bounds, expected) && client.Width == c.ClientWidth && heightMatches;
            if (lease.Observed)
            {
                Rect clientScreen = new Rect(origin.X, origin.Y, origin.X + client.Width, origin.Y + client.Height);
                var displays = QtPopupDisplays();
                bool offscreen = QtPopupOffscreenScope(lease, QtPopupOutsideDisplays(lease.Root.Capture, displays),
                                                       QtPopupOutsideDisplays(bounds, displays));
                geometry = QtPopupGeometryAllowed(bounds, client, clientScreen, lease, offscreen) &&
                           QtPopupDisplayAllowed(lease, bounds, displays);
            }
            return identity.Pid == lease.Root.Pid && identity.Created == lease.Root.Created &&
                   thread == lease.Root.Thread && QtPopupOwnerMatches(candidate, lease) && geometry &&
                   GetDpiForWindow(candidate) == lease.Root.Dpi && name.ToString() == c.ClassName &&
                   GetWindowLongPtr(candidate, -16).ToInt64() == c.Style &&
                   GetWindowLongPtr(candidate, -20).ToInt64() == c.ExtendedStyle;
        }
        catch
        {
            return false;
        }
    }
    static object QtPopupRelativeRect(Rect value, Rect root)
    {
        return new Rect(value.Left - root.Left, value.Top - root.Top, value.Right - root.Left, value.Bottom - root.Top)
            .Report();
    }
    static object QtPopupFailureWindow(IntPtr window, QtPopupLease lease)
    {
        var raw = Map(QtWindowDiagnostic(window, lease.Root.Identity));
        var result =
            Data("available", Get(raw, "available"), "sameBoundWindow", window == lease.Window, "previouslyVisible",
                 lease.PreviouslyVisible != null && lease.PreviouslyVisible.Contains(window));
        if (!Object.Equals(Get(raw, "available"), true))
            return result;
        foreach (string key in new[] { "visible", "minimized", "identityReadable" })
            result.Add(key, Get(raw, key));
        result.Add("processMatches", Get(raw, "sameRootProcess"));
        result.Add("threadMatches", Number(Get(raw, "threadId")) == lease.Root.Thread);
        result.Add("classMatches", Text(raw, "className") == lease.Calibration.ClassName);
        result.Add("styleMatches", Number(Get(raw, "style")) == lease.Calibration.Style);
        result.Add("extendedStyleMatches", Number(Get(raw, "extendedStyle")) == lease.Calibration.ExtendedStyle);
        result.Add("dpiMatches", Number(Get(raw, "dpi")) == lease.Root.Dpi);
        result.Add("dpi", Get(raw, "dpi"));
        bool? owner = null;
        try
        {
            owner = QtPopupOwnerMatches(window, lease);
        }
        catch
        {
        }
        result.Add("ownerMatches", owner);
        if (Get(raw, "rect") != null && Get(raw, "clientRect") != null && Get(raw, "clientScreenRect") != null)
        {
            Rect bounds = ParseRect(Get(raw, "rect")), client = ParseRect(Get(raw, "clientRect")),
                 screen = ParseRect(Get(raw, "clientScreenRect"));
            result.Add("windowRectInRoot", QtPopupRelativeRect(bounds, lease.Root.Capture));
            result.Add("clientRect", client.Report());
            result.Add("clientRectInRoot", QtPopupRelativeRect(screen, lease.Root.Capture));
            result.Add("boundsInsideRoot", Contains(lease.Root.Capture, bounds));
            result.Add("observedGeometryAllowed",
                       lease.Observed ? (object)QtPopupGeometryAllowed(bounds, client, screen, lease) : null);
        }
        return result;
    }
    static Fault QtPopupBindingChanged(QtPopupLease lease, string stage, QtFrame failedFrame = null)
    {
        var error = new Fault("QT_POPUP_BINDING_CHANGED");
        // Preserve the original refusal. Observations follow that refusal and
        // can be incomplete/racy; they never authorize input or a replacement HWND.
        try
        {
            long started = Now(), deadline = started + 80;
            var report = Data("version", 1, "stage", stage, "pasteStage", "none", "inputAttempted", InputAttempted,
                              "readOnly", true, "authorizationGranted", false, "observationAfterFailure", true);
            report.Add("observed", lease.Observed);
            report.Add("kind", lease.Calibration.Kind);
            report.Add("revisionUnchangedBefore", lease.Revision == Interlocked.Read(ref Revision));
            report.Add("foregroundIsRoot", GetForegroundWindow() == lease.Root.Window);
            report.Add("foregroundIsPopup", GetForegroundWindow() == lease.Window);
            report.Add("boundWindowRectInRoot", QtPopupRelativeRect(lease.ObservedBounds, lease.Root.Capture));
            report.Add("boundClientRect", lease.ObservedClient.Report());
            report.Add("boundClientRectInRoot", QtPopupRelativeRect(lease.ObservedClientScreen, lease.Root.Capture));
            var frame = failedFrame;
            if (frame != null && frame.PopupBounds.HasValue && frame.PopupClient.HasValue)
            {
                report.Add("frameWindowRectInRoot", QtPopupRelativeRect(frame.PopupBounds.Value, lease.Root.Capture));
                report.Add("frameClientRect", frame.PopupClient.Value.Report());
            }
            try
            {
                report.Add("boundNow", QtPopupFailureWindow(lease.Window, lease));
            }
            catch
            {
                report.Add("boundNow", Data("available", false, "sameBoundWindow", true, "previouslyVisible", false));
            }
            var windows = new List<IntPtr>();
            int visited = 0;
            bool complete = true;
            if (!EnumWindows(delegate(IntPtr window, IntPtr unused) {
                    if (++visited > 128 || Now() > deadline)
                    {
                        complete = false;
                        return false;
                    }
                    uint pid;
                    GetWindowThreadProcessId(window, out pid);
                    if (window != lease.Root.Window && pid == lease.Root.Pid && IsWindowVisible(window))
                    {
                        if (windows.Count >= 8)
                        {
                            complete = false;
                            return false;
                        }
                        windows.Add(window);
                    }
                    return true;
                }, IntPtr.Zero))
                complete = false;
            var candidates = new List<object>();
            foreach (IntPtr window in windows)
            {
                if (Now() > deadline)
                {
                    complete = false;
                    break;
                }
                try
                {
                    candidates.Add(window == lease.Window ? Get(report, "boundNow")
                                                          : QtPopupFailureWindow(window, lease));
                }
                catch
                {
                    complete = false;
                }
            }
            report.Add("visibleCandidates", candidates);
            report.Add("enumerationComplete", complete && Now() <= deadline);
            report.Add("revisionUnchangedAfter", lease.Revision == Interlocked.Read(ref Revision));
            report.Add("elapsedMs", Math.Max(0, Now() - started));
            error.Data["QtPopupBindingMismatch"] = report;
            if (failedFrame == null)
                error.Data["QtPopupUsePasteFrame"] = true;
        }
        catch
        {
        }
        return error;
    }
    static void QtNeedPopupBinding(QtPopupLease lease, string stage)
    {
        if (!QtPopupWindowMatches(lease.Window, lease))
            throw QtPopupBindingChanged(lease, stage);
    }
    static bool QtPopupTriggerMatches(string id, string kind, string action, string key, bool anchoredClick)
    {
        return id == "search" && kind == "search" && action == "chord" && key == "Control+F" ||
               ((id == "self" || id == "profile") && kind == "profile" && action == "click" && anchoredClick);
    }
    static QtPopupLease QtPreparePopupTransition(object value, QtFrame frame, string action, string key,
                                                 object clickRect)
    {
        if (value == null)
            return null;
        var data = Map(value);
        bool observed = data != null && Text(data, "geometryMode") == "observed-v1";
        Need(data != null && data.Count == (observed ? 3 : 2), "QT_POPUP_TRANSITION_INVALID");
        string id = Text(data, "id");
        var calibration = QtParsePopupCalibration(Get(data, "calibration"), observed);
        bool anchored = false;
        if (action == "click")
        {
            Rect clicked = ParseRect(clickRect);
            foreach (var anchor in frame.Anchors)
                if (Contains(anchor.Rect, clicked))
                    anchored = true;
        }
        Need(QtPopupTriggerMatches(id, calibration.Kind, action, key, anchored) && QtSurface == "main" &&
                 frame.Binding.Window == QtRoot.Window,
             "QT_POPUP_TRANSITION_INVALID");
        var visible = new HashSet<IntPtr>();
        int count = 0;
        EnumWindows(delegate(IntPtr window, IntPtr unused) {
            if (IsWindowVisible(window))
                visible.Add(window);
            return ++count < 4096;
        }, IntPtr.Zero);
        Need(count < 4096, "QT_POPUP_ENUMERATION_LIMIT");
        return new QtPopupLease { Id = id,
                                  Calibration = calibration,
                                  Root = frame.Binding,
                                  Revision = frame.Revision,
                                  Issued = UtcMs(),
                                  PreviouslyVisible = visible,
                                  Observed = observed,
                                  UiaSearch = QtPopupUsesUiaSearch(frame, QtFocus.Active, observed, id, calibration) };
    }
    static IntPtr QtUniquePopupCandidate(QtPopupLease lease)
    {
        var candidates = new List<IntPtr>();
        int count = 0;
        EnumWindows(delegate(IntPtr window, IntPtr unused) {
            if (!lease.PreviouslyVisible.Contains(window) && QtPopupWindowMatches(window, lease))
                candidates.Add(window);
            return ++count < 4096;
        }, IntPtr.Zero);
        Need(count < 4096 && candidates.Count == 1, "QT_POPUP_CANDIDATE_NOT_UNIQUE");
        return candidates[0];
    }
    static void QtBindCalibratedPopup(string surface, string id)
    {
        QtPopupLease lease = QtPopup ?? QtPendingPopup;
        Need(lease != null && lease.Id == id &&
                 lease.Observed == surface.StartsWith("observed-", StringComparison.Ordinal) &&
                 (surface.EndsWith("profile", StringComparison.Ordinal) && lease.Calibration.Kind == "profile" ||
                  surface.EndsWith("search", StringComparison.Ordinal) && lease.Calibration.Kind == "search"),
             "QT_POPUP_TRANSITION_REQUIRED");
        QtPopupRootStable(lease);
        if (lease.Window == IntPtr.Zero)
        {
            Need(UtcMs() - lease.Issued >= 0 && UtcMs() - lease.Issued <= 10000, "QT_POPUP_TRANSITION_EXPIRED");
            IntPtr candidate = QtUniquePopupCandidate(lease);
            Rect firstBounds = new Rect(), firstClient = new Rect();
            Point firstOrigin = new Point(0, 0);
            Need(GetWindowRect(candidate, out firstBounds) && GetClientRect(candidate, out firstClient) &&
                     ClientToScreen(candidate, ref firstOrigin),
                 "QT_POPUP_GEOMETRY_UNAVAILABLE");
            QtPopupObservationPause(lease, Thread.Sleep);
            QtPopupRootStable(lease);
            Need(QtPopupCausalEligible(true, true, true, true, true, true, lease.PreviouslyVisible.Contains(candidate),
                                       QtUniquePopupCandidate(lease) == candidate),
                 "QT_POPUP_UNSTABLE");
            Rect secondBounds, secondClient;
            Point secondOrigin = new Point(0, 0);
            Need(GetWindowRect(candidate, out secondBounds) && GetClientRect(candidate, out secondClient) &&
                     ClientToScreen(candidate, ref secondOrigin) && Same(firstBounds, secondBounds) &&
                     Same(firstClient, secondClient) && firstOrigin.X == secondOrigin.X &&
                     firstOrigin.Y == secondOrigin.Y,
                 "QT_POPUP_UNSTABLE");
            lease.ObservedBounds = firstBounds;
            lease.ObservedClient = firstClient;
            lease.ObservedClientScreen = new Rect(firstOrigin.X, firstOrigin.Y, firstOrigin.X + firstClient.Width,
                                                  firstOrigin.Y + firstClient.Height);
            lease.Window = candidate;
            QtPopup = lease;
            QtPendingPopup = null;
        }
        QtNeedPopupBinding(lease, "bind");
        Need(GetForegroundWindow() == (lease.Calibration.Kind == "profile" ? lease.Window : lease.Root.Window),
             "QT_POPUP_FOCUS_CHANGED");
        QtWindow = lease.Calibration.Kind == "profile" ? lease.Window : lease.Root.Window;
        QtSurface = surface;
    }
    static void QtValidateActivePopup()
    {
        if (QtPopupSurface(QtSurface))
        {
            QtPopupRootStable(QtPopup);
            QtNeedPopupBinding(QtPopup, "active");
            Need(GetForegroundWindow() == QtWindow, "QT_POPUP_FOCUS_CHANGED");
        }
    }
    // Diagnostics never promote a same-process window into an owned surface.
    // A captured main binding is required; inspection does not bind or activate.
    static string QtHandle(IntPtr window)
    {
        return window.ToInt64().ToString(CultureInfo.InvariantCulture);
    }
    static List<IntPtr> QtDiagnosticOwners(IntPtr start, Func<IntPtr, IntPtr> next)
    {
        var result = new List<IntPtr>();
        while (start != IntPtr.Zero && result.Count < 16 && !result.Contains(start))
        {
            result.Add(start);
            start = next(start);
        }
        return result;
    }
    static List<Rect> QtDiagnosticHitRects(object value, Rect client)
    {
        var result = new List<Rect>();
        if (value == null)
            return result;
        object[] values = value as object[];
        Need(values != null && values.Length <= 4, "QT_DIAGNOSTIC_REGIONS_INVALID");
        foreach (object item in values)
        {
            Rect region = ParseRect(item);
            Need(Contains(client, region), "QT_DIAGNOSTIC_REGIONS_INVALID");
            result.Add(region);
        }
        return result;
    }
    static object QtWindowDiagnostic(IntPtr window, WindowIdentity root)
    {
        var report = Data("hwnd", QtHandle(window), "available", false);
        uint pid;
        uint thread = GetWindowThreadProcessId(window, out pid);
        if (window == IntPtr.Zero || thread == 0 || !IsWindow(window))
            return report;
        var name = new StringBuilder(257);
        GetClassName(window, name, name.Capacity);
        Rect bounds;
        bool hasBounds = GetWindowRect(window, out bounds);
        long created = 0;
        bool executableMatches = false;
        IntPtr process = OpenProcess(0x1000, false, pid);
        if (process != IntPtr.Zero)
            try
            {
                FileTime start, exit, kernel, user;
                if (GetProcessTimes(process, out start, out exit, out kernel, out user))
                    created = start.Value;
                var file = new StringBuilder(32768);
                int length = file.Capacity;
                if (QueryFullProcessImageName(process, 0, file, ref length))
                    executableMatches = String.Equals(Path.GetFullPath(file.ToString()), QtExecutable,
                                                      StringComparison.OrdinalIgnoreCase);
            }
            finally
            {
                CloseHandle(process);
            }
        uint afterPid;
        bool stable = GetWindowThreadProcessId(window, out afterPid) == thread && afterPid == pid;
        report["available"] = true;
        report.Add("pid", pid);
        report.Add("threadId", thread);
        report.Add("processCreatedFileTimeUtc",
                   created > 0 ? (object)created.ToString(CultureInfo.InvariantCulture) : null);
        report.Add("identityReadable", stable && created > 0);
        report.Add("sameRootProcess", stable && pid == root.Pid && created == root.Created && executableMatches);
        report.Add("executableMatches", executableMatches);
        report.Add("className", name.ToString());
        report.Add("visible", IsWindowVisible(window));
        report.Add("minimized", IsIconic(window));
        report.Add("rect", hasBounds ? bounds.Report() : null);
        Rect client;
        Point origin = new Point(0, 0);
        bool hasClient = GetClientRect(window, out client) && ClientToScreen(window, ref origin);
        report.Add("clientRect", hasClient ? client.Report() : null);
        report.Add("clientScreenRect",
                   hasClient ? new Rect(origin.X, origin.Y, origin.X + client.Width, origin.Y + client.Height).Report()
                             : null);
        report.Add("dpi", GetDpiForWindow(window));
        report.Add("style", GetWindowLongPtr(window, -16).ToInt64());
        report.Add("extendedStyle", GetWindowLongPtr(window, -20).ToInt64());
        report.Add("ownerHwnd", QtHandle(GetWindow(window, 4)));
        report.Add("parentHwnd", QtHandle(GetAncestor(window, 1)));
        report.Add("rootHwnd", QtHandle(GetAncestor(window, 2)));
        report.Add("rootOwnerHwnd", QtHandle(GetAncestor(window, 3)));
        report.Add("lastActivePopupHwnd", QtHandle(GetLastActivePopup(window)));
        report.Add("ownerChainReachesMain", QtOwnedPopup(window, root.Window));
        return report;
    }
    static object QtThreadDiagnostic(uint thread, WindowIdentity root)
    {
        var gui = new GuiInfo { Size = (uint)Marshal.SizeOf(typeof(GuiInfo)) };
        if (thread == 0 || !GetGUIThreadInfo(thread, ref gui))
            return Data("available", false, "threadId", thread);
        return Data("available", true, "threadId", thread, "flags", gui.Flags, "active",
                    QtWindowDiagnostic(gui.Active, root), "focus", QtWindowDiagnostic(gui.Focus, root), "captureHwnd",
                    QtHandle(gui.Capture), "menuOwnerHwnd", QtHandle(gui.MenuOwner));
    }
    static object QtInspectPopup(Dictionary<string, object> request)
    {
        Desktop();
        Need(QtRoot.Window != IntPtr.Zero, "QT_POPUP_ROOT_REQUIRED");
        var expected = QtRoot;
        var root = QtFocusWindow(QtRoot.Window, QtExecutable, true);
        Need(WindowIdentity.Same(root, expected), "QT_POPUP_PROCESS_CHANGED");
        Rect client;
        Need(GetClientRect(root.Window, out client), "DRAFT_GEOMETRY_UNAVAILABLE");
        var regions = QtDiagnosticHitRects(Get(request, "hitRects"), client);
        Point origin = new Point(0, 0);
        Need(ClientToScreen(root.Window, ref origin), "DRAFT_GEOMETRY_UNAVAILABLE");
        long revision = Interlocked.Read(ref Revision);
        IntPtr foreground = GetForegroundWindow();
        uint ignored;
        uint foregroundThread = GetWindowThreadProcessId(foreground, out ignored),
             rootThread = GetWindowThreadProcessId(root.Window, out ignored);
        var owners = new List<object>();
        foreach (IntPtr window in QtDiagnosticOwners(foreground,
                                                     delegate(IntPtr value) { return GetWindow(value, 4); }))
            owners.Add(QtWindowDiagnostic(window, root));
        var candidates = new List<object>();
        int total = 0;
        EnumWindows(delegate(IntPtr window, IntPtr unused) {
            uint pid;
            if (IsWindowVisible(window) && GetWindowThreadProcessId(window, out pid) != 0 && pid == root.Pid)
            {
                total++;
                if (candidates.Count < 16)
                    candidates.Add(QtWindowDiagnostic(window, root));
            }
            return true;
        }, IntPtr.Zero);
        var hits = new List<object>();
        foreach (Rect region in regions)
        {
            Point point =
                new Point(origin.X + region.Left + region.Width / 2, origin.Y + region.Top + region.Height / 2);
            hits.Add(Data("region", region.Report(), "hit", QtWindowDiagnostic(WindowFromPoint(point), root)));
        }
        object rootReport = QtWindowDiagnostic(root.Window, root),
               foregroundReport = QtWindowDiagnostic(foreground, root),
               foregroundGui = QtThreadDiagnostic(foregroundThread, root),
               rootGui = QtThreadDiagnostic(rootThread, root);
        bool rootStable;
        try
        {
            rootStable = WindowIdentity.Same(root, QtFocusWindow(root.Window, QtExecutable, true));
        }
        catch
        {
            rootStable = false;
        }
        IntPtr foregroundAfter = GetForegroundWindow();
        return Data("readOnly", true, "inputSent", false, "clipboardAccessed", false, "focusChanged", false,
                    "authorizationGranted", false, "windowTitlesIncluded", false, "textIncluded", false, "observedAtMs",
                    UtcMs(), "activityRevision", revision, "stableObservation",
                    rootStable && foreground == foregroundAfter && revision == Interlocked.Read(ref Revision),
                    "foregroundAfterHwnd", QtHandle(foregroundAfter), "root", rootReport, "foreground",
                    foregroundReport, "foregroundOwnerChain", owners, "mainThread", rootGui, "foregroundThread",
                    foregroundGui, "samePidVisibleWindows", candidates, "samePidWindowsTruncated",
                    total > candidates.Count, "hitTests", hits);
    }
    static void QtSelectSurface(string surface, string surfaceId = null)
    {
        if (QtRoot.Window == IntPtr.Zero)
        {
            var expected = QtFocus.Inspected == null ? null : QtFocus.Inspected.Wechat;
            IntPtr candidate = expected != null          ? expected.Window
                               : QtWindow == IntPtr.Zero ? GetForegroundWindow()
                                                         : QtWindow;
            Need(GetWindow(candidate, 4) == IntPtr.Zero, "QT_FOCUS_TARGET_CHANGED");
            Binding root = Snapshot(candidate, QtExecutable);
            Need(expected == null || root.Pid == expected.Pid && root.Created == expected.Created,
                 "QT_FOCUS_TARGET_CHANGED");
            QtRoot = root.Identity;
            QtWindow = candidate;
        }
        if (surface == null || surface == "main")
        {
            QtWindow = QtRoot.Window;
            QtSurface = "main";
            QtPopup = null;
            QtPendingPopup = null;
        }
        else if (QtPopupSurface(surface))
            QtBindCalibratedPopup(surface, surfaceId);
        else
        {
            Need(surface == "owned-profile", "QT_SURFACE_INVALID");
            QtPopup = null;
            QtPendingPopup = null;
            QtSurface = surface;
            IntPtr current = GetForegroundWindow();
            Need(QtOwnedPopup(current, QtRoot.Window), "QT_POPUP_NOT_OWNED");
            Binding actual = Snapshot(current, QtExecutable);
            Need(actual.Pid == QtRoot.Pid && actual.Created == QtRoot.Created, "QT_POPUP_PROCESS_CHANGED");
            QtWindow = current;
        }
    }
}
