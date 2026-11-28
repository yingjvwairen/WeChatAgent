// UIA navigation helpers use current native geometry. No saved screen pixels
// or caller-supplied frame flags grant caption/input authority.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Automation;

internal static partial class WechatDraftProbe
{
    sealed class QtUiaCaption
    {
        internal QtReturnCaption Snapshot;
        internal Rect ClientRect, ScreenRect;
        internal Point[] Points;
        internal QtUiaTitleGeometry Title;
    }
    static QtUiaTitleGeometry QtReadUiaTitleGeometry(QtReturnCaption snapshot, Action guard, long deadline)
    {
        Rect capture =
            new Rect(snapshot.ClientOrigin.X, snapshot.ClientOrigin.Y, snapshot.ClientOrigin.X + snapshot.Client.Width,
                     snapshot.ClientOrigin.Y + snapshot.Client.Height);
        return QtReadUiaTitleGeometry(snapshot.Identity.Window, snapshot.Identity.Pid, capture, delegate {
            guard();
            Need(QtSameCaption(snapshot, QtCaptionSnapshot(snapshot.Identity)), "QT_UIA_CAPTION_CHANGED");
        }, deadline);
    }
    static QtUiaCaption QtFindClientUiaCaption(QtReturnCaption snapshot, Action guard, long deadline)
    {
        var title = QtReadUiaTitleGeometry(snapshot, guard, deadline);
        int dx = Math.Max(10, (int)Math.Ceiling(8 * snapshot.Dpi / 96.0)),
            dy = Math.Max(4, (int)Math.Ceiling(3 * snapshot.Dpi / 96.0));
        int left = snapshot.ClientOrigin.X + 160 + dx,
            right = Math.Min(title.Toolbar.Left - 16, snapshot.ClientOrigin.X + snapshot.Client.Width - 160) - dx;
        Need(right > left && title.Band.Height > dy * 2, "QT_UIA_CAPTION_UNAVAILABLE");
        QtUiaCaption occluded = null;
        foreach (int y in CaptionGeometry.SampleRows(title.Band, dy))
            foreach (double fraction in new[] { .5, .3, .7, .1, .9 })
            {
                Point center = new Point(left + (int)Math.Round((right - left) * fraction), y);
                Rect client = QtUiaCaptionRect(center, snapshot),
                     screen = new Rect(center.X - dx, center.Y - dy, center.X + dx + 1, center.Y + dy + 1);
                if (!FocusActivationGeometry(client, snapshot.Client.Width) || !Contains(title.Band, screen) ||
                    !CaptionGeometry.Avoids(screen, title.Excluded) ||
                    !FocusCoveredByDisplays(screen, FocusDisplayRects()))
                    continue;
                var proof = new QtUiaCaption { Snapshot = snapshot, Title = title, ClientRect = client,
                                               ScreenRect = screen, Points = QtUiaCaptionPoints(screen) };
                guard();
                if (!QtUiaCaptionPointsMatch(proof, deadline))
                    continue;
                if (FocusAreaOwned(screen, snapshot.Identity.Window, snapshot.Identity.Pid))
                {
                    QtUiaCaptionStable(proof, guard, true, deadline);
                    return proof;
                }
                if (occluded == null)
                    occluded = proof;
            }
        if (occluded != null)
        {
            QtUiaCaptionStable(occluded, guard, false, deadline);
            return occluded;
        }
        throw new Fault("QT_UIA_CAPTION_UNAVAILABLE");
    }
    sealed class QtUiaSearchGeneration
    {
        internal string Id;
        internal QtFocusLease Lease;
        internal Binding Binding;
        internal QtPopupLease Popup;
        internal long Revision, Issued;
    }
    static QtUiaSearchGeneration QtUiaSearchReady;
    static Dictionary<string, object> QtUiaBindingFields(object value)
    {
        var map = Map(value);
        Need(map != null, "QT_BINDING_CHANGED");
        var result = new Dictionary<string, object>();
        foreach (string key in new[] { "hwnd", "pid", "processCreatedFileTimeUtc", "dpi", "clientRect", "captureRect" })
        {
            Need(map.ContainsKey(key), "QT_BINDING_CHANGED");
            result.Add(key, map[key]);
        }
        return result;
    }
    static bool QtUiaExpectedBinding(object value, Binding actual)
    {
        return QtLayoutExpectedMatches(QtUiaBindingFields(value), Map(actual.Report()));
    }
    static Rect QtUiaCaptionRect(Point center, QtReturnCaption snapshot)
    {
        int x = Math.Max(10, (int)Math.Ceiling(8 * snapshot.Dpi / 96.0)),
            y = Math.Max(4, (int)Math.Ceiling(3 * snapshot.Dpi / 96.0));
        return new Rect(center.X - snapshot.ClientOrigin.X - x, center.Y - snapshot.ClientOrigin.Y - y,
                        center.X - snapshot.ClientOrigin.X + x + 1, center.Y - snapshot.ClientOrigin.Y + y + 1);
    }
    static Point[] QtUiaCaptionPoints(Rect screen)
    {
        return new[] { new Point(screen.Left + screen.Width / 2, screen.Top + screen.Height / 2),
                       new Point(screen.Left, screen.Top), new Point(screen.Right - 1, screen.Top),
                       new Point(screen.Left, screen.Bottom - 1), new Point(screen.Right - 1, screen.Bottom - 1) };
    }
    static bool QtUiaAllCaptionPoints(Point[] points, Func<Point, bool> hit)
    {
        if (points == null || points.Length != 5)
            return false;
        foreach (Point point in points)
            if (!hit(point))
                return false;
        return true;
    }
    static bool QtUiaCaptionPointsMatch(QtUiaCaption proof, long deadline)
    {
        return QtUiaAllCaptionPoints(proof.Points, delegate(Point point) {
            if (proof.Title == null)
                return QtCaptionHit(proof.Snapshot, point, deadline);
            long remaining = deadline - Now();
            Need(remaining > 0, "QT_UIA_CAPTION_PROBE_TIMEOUT");
            UIntPtr value;
            IntPtr status = QtCaptionSendMessageTimeout(proof.Snapshot.Identity.Window, 0x84, UIntPtr.Zero,
                                                        QtCaptionCoordinates(point), 0x23,
                                                        (uint)Math.Min(20, remaining), out value);
            Need(status != IntPtr.Zero && Now() <= deadline, "QT_UIA_CAPTION_PROBE_TIMEOUT");
            return value.ToUInt64() == 1;
        });
    }
    static void QtUiaCaptionHits(QtUiaCaption proof, long deadline)
    {
        Need(QtUiaCaptionPointsMatch(proof, deadline), "QT_UIA_CAPTION_CHANGED");
    }
    static void QtUiaCaptionStable(QtUiaCaption proof, Action guard, bool owned, long deadline)
    {
        guard();
        Need(QtSameCaption(proof.Snapshot, QtCaptionSnapshot(proof.Snapshot.Identity)), "QT_UIA_CAPTION_CHANGED");
        if (proof.Title != null)
        {
            var current = QtReadUiaTitleGeometry(proof.Snapshot, guard, deadline);
            Need(current.Metadata == proof.Title.Metadata && Contains(current.Band, proof.ScreenRect) &&
                     CaptionGeometry.Avoids(proof.ScreenRect, current.Excluded),
                 "QT_UIA_CAPTION_CHANGED");
        }
        if (owned)
            Need(FocusAreaOwned(proof.ScreenRect, proof.Snapshot.Identity.Window, proof.Snapshot.Identity.Pid),
                 "QT_UIA_CAPTION_OBSCURED");
        QtUiaCaptionHits(proof, deadline);
        guard();
        Need(QtSameCaption(proof.Snapshot, QtCaptionSnapshot(proof.Snapshot.Identity)) &&
                 (!owned ||
                  FocusAreaOwned(proof.ScreenRect, proof.Snapshot.Identity.Window, proof.Snapshot.Identity.Pid)) &&
                 Now() <= deadline,
             "QT_UIA_CAPTION_CHANGED");
    }
    static QtUiaCaption QtFindUiaCaption(WindowIdentity target, Action guard, long deadline)
    {
        guard();
        var snapshot = QtCaptionSnapshot(target);
        QtUiaCaption occluded = null;
        foreach (Point center in QtCaptionCandidates(snapshot.Window, snapshot.Dpi))
        {
            guard();
            Need(Now() < deadline, "QT_UIA_CAPTION_PROBE_TIMEOUT");
            Rect rect = QtUiaCaptionRect(center, snapshot);
            if (!FocusActivationGeometry(rect, snapshot.Client.Width) || !Contains(snapshot.Client, rect))
                continue;
            Rect screen = new Rect(rect.Left + snapshot.ClientOrigin.X, rect.Top + snapshot.ClientOrigin.Y,
                                   rect.Right + snapshot.ClientOrigin.X, rect.Bottom + snapshot.ClientOrigin.Y);
            if (!FocusCoveredByDisplays(screen, FocusDisplayRects()))
                continue;
            var proof = new QtUiaCaption { Snapshot = snapshot, ClientRect = rect, ScreenRect = screen,
                                           Points = QtUiaCaptionPoints(screen) };
            bool caption = QtUiaAllCaptionPoints(proof.Points, delegate(Point point) {
                guard();
                return QtCaptionHit(snapshot, point, deadline);
            });
            if (!caption)
                continue;
            if (FocusAreaOwned(screen, target.Window, target.Pid))
            {
                QtUiaCaptionStable(proof, guard, true, deadline);
                return proof;
            }
            if (occluded == null)
                occluded = proof;
        }
        if (occluded != null)
        {
            QtUiaCaptionStable(occluded, guard, false, deadline);
            return occluded;
        }
        return QtFindClientUiaCaption(snapshot, guard, Now() + 1500);
    }
    static object QtInspectUiaFocusGeometry(Dictionary<string, object> request)
    {
        foreach (string key in request.Keys)
            Need(key == "id" || key == "action" || key == "expectedBinding", "QT_UIA_CAPTION_REQUEST_INVALID");
        var expected = QtUiaBindingFields(Get(request, "expectedBinding"));
        long revision = Interlocked.Read(ref Revision);
        uint tick = QtInputTick();
        IntPtr foreground = GetForegroundWindow();
        Point pointer;
        Need(FocusGetCursorPos(out pointer), "QT_POINTER_UNAVAILABLE");
        var inspected = Map(QtInspectLayout());
        Need(QtLayoutExpectedMatches(expected, Map(Get(inspected, "binding"))), "QT_BINDING_CHANGED");
        var identity = QtFocusWindow(new IntPtr(DecimalString(Get(expected, "hwnd"))), QtExecutable);
        Action guard = delegate
        {
            Need(!Stopping && revision == Interlocked.Read(ref Revision) && tick == QtInputTick() &&
                     foreground == GetForegroundWindow(),
                 "QT_HUMAN_ACTIVITY_CHANGED");
            Point at;
            Need(FocusGetCursorPos(out at) && QtSamePoint(at, pointer), "QT_HUMAN_ACTIVITY_CHANGED");
            Need(WindowIdentity.Same(identity, QtFocusWindow(identity.Window, QtExecutable)), "QT_BINDING_CHANGED");
        };
        var proof = QtFindUiaCaption(identity, guard, Now() + 500);
        guard();
        var actual = Data("hwnd", QtHandle(identity.Window), "pid", identity.Pid, "processCreatedFileTimeUtc",
                          identity.Created.ToString(System.Globalization.CultureInfo.InvariantCulture), "dpi",
                          proof.Snapshot.Dpi, "clientRect", proof.Snapshot.Client.Report(), "captureRect",
                          new Rect(proof.Snapshot.ClientOrigin.X, proof.Snapshot.ClientOrigin.Y,
                                   proof.Snapshot.ClientOrigin.X + proof.Snapshot.Client.Width,
                                   proof.Snapshot.ClientOrigin.Y + proof.Snapshot.Client.Height)
                              .Report(),
                          "foreground", foreground == identity.Window);
        Need(QtLayoutExpectedMatches(expected, actual), "QT_BINDING_CHANGED");
        guard();
        return Data(
            "version", 1, "readOnly", true, "inputSent", false, "focusChanged", false, "clipboardAccessed", false,
            "binding", actual, "focusActivationMode", "uia-caption-v1", "mouseParkRect", proof.ClientRect.Report(),
            "focusActivationRect", proof.ClientRect.Report(), "captionProof",
            Data("version", 1, "hitTest", proof.Title == null ? "HTCAPTION" : "UIA_TITLEBAR_CLIENT", "pointCount", 5),
            "foregroundUnchanged", true, "inputTickUnchanged", true, "authorizationGranted", false);
    }
    static bool QtUiaCaptionRequested(Dictionary<string, object> request)
    {
        if (!request.ContainsKey("uiaCaptionActivation"))
            return false;
        Need(Object.Equals(Get(request, "uiaCaptionActivation"), true) && !request.ContainsKey("focusActivation"),
             "QT_UIA_CAPTION_REQUEST_INVALID");
        return true;
    }
    static bool QtUiaCaptionFallbackReady(Func<bool> alreadyTarget, Action freshCaption)
    {
        if (alreadyTarget())
            return true;
        freshCaption();
        return false;
    }
    static bool QtUiaPreparePhysicalFallback(Func<bool> activate, Func<bool> alreadyTarget, Action prepare)
    {
        return activate() || QtUiaCaptionFallbackReady(alreadyTarget, prepare);
    }
    static bool QtActivateUiaCaptionOnce(QtFocusLease lease)
    {
        Need(lease != null && lease.UiaMode && Object.ReferenceEquals(lease, QtFocus.Active),
             "QT_UIA_CAPTION_UNAVAILABLE");
        QtUiaCaption proof = null;
        long revision = lease.Revision;
        Dictionary<string, object> diagnostic = null;
        bool offscreenActivated = false;
        Action guard = delegate
        {
            Need(Object.ReferenceEquals(lease, QtFocus.Active), "QT_FOCUS_TARGET_CHANGED");
            QtFocusTransitionGuard(lease, revision, false);
            if (proof != null)
                Need(QtSameCaption(proof.Snapshot, QtCaptionSnapshot(lease.Wechat)), "QT_UIA_CAPTION_CHANGED");
        };
        // The normal API path neither reads nor relies on caption coordinates.
        // Only a denied request with the original foreground still owned may
        // acquire a fresh, strict capability for the physical fallback.
        if (QtUiaPreparePhysicalFallback(
                delegate { return ActivateForegroundOnce(lease.Return.Window, lease.Wechat.Window, guard, null); },
                delegate {
                    diagnostic = FocusActivationDiagnostic;
                    Need(diagnostic != null, "QT_UIA_CAPTION_UNAVAILABLE");
                    return FocusTargetBeforeClick(lease.Return.Window, lease.Wechat.Window, guard, GetForegroundWindow,
                                                  diagnostic);
                },
                delegate {
                    // The process/window-bound helper needs no title-bar tree. Its
                    // single attachment edge ends with the helper; both external
                    // application queues remain independent.
                    offscreenActivated = ActivateBoundWechatForegroundOnce(lease.Return.Window, lease.Wechat.Window,
                                                                           QtExecutable, guard);
                    if (offscreenActivated)
                        return;
                    if (IsOffscreenFocusWindow(lease.Wechat.Window))
                    {
                        offscreenActivated = ActivateOffscreenForegroundOnce(lease.Return.Window, lease.Wechat.Window,
                                                                             QtExecutable, guard);
                        Need(offscreenActivated, "QT_OFFSCREEN_FOCUS_UNCONFIRMED");
                        return;
                    }
                    proof = QtFindUiaCaption(lease.Wechat, delegate {
                        guard();
                        Need(GetForegroundWindow() == lease.Return.Window, "QT_FOCUS_TARGET_CHANGED");
                    }, Now() + 500);
                    lease.UiaCaption = proof;
                    lease.Activation = new FocusActivation { Rect = proof.ClientRect, UiaCaption = true };
                }) ||
            offscreenActivated)
            return true;
        diagnostic["uiaCaptionActivation"] = true;
        IntPtr source = lease.Return.Window, target = lease.Wechat.Window;
        bool above = FocusWindowAbove(source, target), raised = false, clicked = false, applied = false;
        FocusOrderAnchor predecessor = null;
        Rect desktop = QtDesktopRect();
        Point center = proof.Points[0], saved = lease.OriginalPointer;
        Rect sourceClient;
        Point sourceOrigin = new Point(0, 0);
        Need(GetClientRect(source, out sourceClient) && ClientToScreen(source, ref sourceOrigin),
             "QT_FOCUS_TARGET_CHANGED");
        Action cleanupGuard = delegate
        {
            guard();
            Rect current;
            Point origin = new Point(0, 0);
            Need(GetForegroundWindow() == source && GetClientRect(source, out current) && Same(current, sourceClient) &&
                     ClientToScreen(source, ref origin) && QtSamePoint(origin, sourceOrigin),
                 "QT_FOCUS_TARGET_CHANGED");
        };
        try
        {
            // Only the physical fallback needs a current caption tree. A
            // successful foreground API request never consumes caption points.
            if (QtUiaCaptionFallbackReady(
                    delegate { return FocusTargetBeforeClick(source, target, guard, GetForegroundWindow, diagnostic); },
                    delegate { QtUiaCaptionStable(proof, guard, false, Now() + (proof.Title == null ? 150 : 700)); }))
                return true;
            Need((FocusGetWindowLongPtr(target, -20).ToInt64() & 8) == 0, "DRAFT_FOCUS_TOPMOST_REFUSED");
            if (!FocusAreaOwned(proof.ScreenRect, target, lease.Wechat.Pid))
            {
                predecessor = FocusCapturePredecessor(target);
                if (FocusTargetBeforeClick(source, target, guard, GetForegroundWindow, diagnostic))
                    return true;
                raised = true;
                diagnostic["calibratedRaiseAttempted"] = true;
                bool accepted = FocusSetWindowPos(target, IntPtr.Zero, 0, 0, 0, 0, 0x4213);
                diagnostic["calibratedRaiseAccepted"] = accepted;
                Need(accepted, "DRAFT_FOCUS_RAISE_FAILED");
            }
            long deadline = Now() + (proof.Title == null ? 200 : 700);
            while (!FocusAreaOwned(proof.ScreenRect, target, lease.Wechat.Pid))
            {
                if (FocusTargetBeforeClick(source, target, guard, GetForegroundWindow, diagnostic))
                    return true;
                Need(Now() < deadline, "QT_UIA_CAPTION_OBSCURED");
                Thread.Sleep(5);
            }
            if (FocusTargetBeforeClick(source, target, guard, GetForegroundWindow, diagnostic))
                return true;
            QtUiaCaptionStable(proof, guard, true, deadline);
            Need(QtCaptionHistorySafe(center, proof.Snapshot.Dpi), "QT_RETURN_CAPTION_DOUBLE_CLICK_UNCERTAIN");
            Input[] inputs = ClickEvents(center.X, center.Y, desktop);
            guard();
            Need(GetForegroundWindow() == source && Same(desktop, QtDesktopRect()) &&
                     QtCaptionHistorySafe(center, proof.Snapshot.Dpi),
                 "QT_UIA_CAPTION_CHANGED");
            QtUiaCaptionStable(proof, guard, true, deadline);
            guard();
            Need(GetForegroundWindow() == source && FocusAreaOwned(proof.ScreenRect, target, lease.Wechat.Pid) &&
                     Now() <= deadline,
                 "QT_UIA_CAPTION_CHANGED");
            clicked = true;
            InputAttempted = true;
            lease.PointerMoved = true;
            lease.PointerCertain = false;
            diagnostic["calibratedClickAttempted"] = true;
            ObserveMouseIntent(0x201, center);
            uint inserted = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(Input)));
            applied = inserted == inputs.Length;
            diagnostic["calibratedClickApplied"] = applied;
            if (!applied)
            {
                var releases = ClickReleases(inserted);
                if (releases.Length > 0)
                    SendInput((uint)releases.Length, releases, Marshal.SizeOf(typeof(Input)));
                throw new Fault("DRAFT_FOCUS_CLICK_UNCERTAIN");
            }
            return true;
        }
        catch
        {
            diagnostic["raiseCleanup"] =
                FocusUndoCaptionRaise(target, source, predecessor, raised, clicked, above, cleanupGuard);
            throw;
        }
        finally
        {
            if (clicked)
            {
                bool restored = FocusRestoreClickPointer(
                    applied,
                    delegate {
                        guard();
                        Need(GetForegroundWindow() == source || GetForegroundWindow() == target,
                             "QT_FOCUS_TARGET_CHANGED");
                    },
                    delegate {
                        Point cursor;
                        return FocusGetCursorPos(out cursor) && QtNearPoint(cursor, center);
                    },
                    delegate {
                        var move = QtPointerEvents(saved, desktop);
                        return SendInput(1, move, Marshal.SizeOf(typeof(Input))) == 1;
                    },
                    delegate {
                        Point cursor;
                        return FocusGetCursorPos(out cursor) && QtNearPoint(cursor, saved);
                    },
                    Now, Thread.Sleep);
                diagnostic["pointerRestored"] = restored;
                if (restored)
                    lease.PointerMoved = false;
                else if (applied)
                {
                    Point actual;
                    if (FocusGetCursorPos(out actual) && QtNearPoint(actual, center))
                    {
                        lease.LastPointer = actual;
                        lease.PointerCertain = true;
                    }
                }
            }
        }
    }
    static void QtRevokeUiaSearch()
    {
        QtUiaSearchReady = null;
    }
    static bool QtUiaSearchReadOnlyAction(string action)
    {
        return action == "inspectLayout" || action == "inspectUiaFocusGeometry" || action == "inspectPopup" ||
               action == "inspectOcclusion" || action == "inspectTargetOcclusion" || action == "capture" ||
               action == "captureUiaNavigation";
    }
    static string QtMintUiaSearch(QtFrame source, QtPopupLease popup)
    {
        if (QtFocus.Active == null || QtFocus.Parked != null || source == null || popup == null ||
            source.Revision != QtFocus.Active.Revision || source.Binding.Window != QtFocus.Active.Wechat.Window ||
            source.Binding.Pid != QtFocus.Active.Wechat.Pid || source.Binding.Created != QtFocus.Active.Wechat.Created)
            return null;
        QtUiaSearchReady = new QtUiaSearchGeneration { Id = Guid.NewGuid().ToString("N"), Lease = QtFocus.Active,
                                                       Binding = source.Binding,          Popup = popup,
                                                       Revision = source.Revision,        Issued = UtcMs() };
        return QtUiaSearchReady.Id;
    }
    static bool QtUiaSearchMatches(QtUiaSearchGeneration proof, string id, QtFocusLease lease, long revision, long now)
    {
        return proof != null && proof.Id == id && proof.Lease != null && Object.ReferenceEquals(proof.Lease, lease) &&
               lease.Wechat != null && proof.Binding != null && proof.Binding.Window == lease.Wechat.Window &&
               proof.Binding.Pid == lease.Wechat.Pid && proof.Binding.Created == lease.Wechat.Created &&
               proof.Revision == revision && lease.Revision == revision && now >= proof.Issued &&
               now - proof.Issued <= 30000;
    }
    static object QtFocusUiaReadyEditor(Dictionary<string, object> request)
    {
        foreach (string key in request.Keys)
            Need(key == "id" || key == "action" || key == "searchGeneration" || key == "headerRect" ||
                     key == "editorRect" || key == "idleMs" || key == "uiaReady",
                 "QT_UIA_READY_REQUEST_INVALID");
        var proof = QtUiaSearchReady;
        Need(QtEnableInput && !Stopping && QtFocus.Parked == null &&
                 QtUiaSearchMatches(proof, Text(request, "searchGeneration"), QtFocus.Active,
                                    Interlocked.Read(ref Revision), UtcMs()),
             "QT_UIA_SEARCH_GENERATION_INVALID");
        QtRevokeUiaSearch();
        var ready = Map(Get(request, "uiaReady"));
        Need(ready != null && ready.Count == 3 && Number(Get(ready, "version")) == 1 &&
                 Text(ready, "proof") == "uia-controls-v1",
             "QT_UIA_READY_REQUEST_INVALID");
        Need(proof.Popup != null && proof.Popup.Window != IntPtr.Zero &&
                 (!IsWindow(proof.Popup.Window) || !IsWindowVisible(proof.Popup.Window)),
             "QT_UIA_SEARCH_TRANSITION_PENDING");
        QtSelectSurface("main");
        QtUiaNavigationContext();
        Binding bound = QtBound(false);
        Need(bound.Thread == proof.Binding.Thread && QtSameBinding(proof.Binding, bound) &&
                 QtUiaExpectedBinding(Get(ready, "binding"), bound),
             "QT_BINDING_CHANGED");
        Rect header = ParseRect(Get(request, "headerRect")), editor = ParseRect(Get(request, "editorRect"));
        Need(Contains(bound.Client, header) && header.Height >= 12 && QtUiaEditorRegion(editor, header, bound.Client),
             "QT_UIA_EDITOR_REGION_INVALID");
        var frame = Map(QtCaptureUiaNavigation(
            Data("surface", "main", "regions", new object[] { header.Report() }, "image", false)));
        Need(QtUiaSearchMatches(proof, Text(request, "searchGeneration"), QtFocus.Active,
                                Interlocked.Read(ref Revision), UtcMs()) &&
                 QtCurrent.Binding.Thread == proof.Binding.Thread &&
                 QtUiaExpectedBinding(Get(ready, "binding"), QtCurrent.Binding),
             "QT_UIA_SEARCH_GENERATION_INVALID");
        return QtFocusUiaEditor(Data("token", frame["token"], "epoch", frame["epoch"], "revision", frame["revision"],
                                     "idleMs", Get(request, "idleMs"), "editorRect", editor.Report()));
    }
    static int QtUiaGeometrySelfTest()
    {
        int n = OffscreenActivationSelfTest();
        n += UiaCaptionSharedSelfTest();
        int activations = 0, foregroundChecks = 0, preparations = 0;
        Need(QtUiaPreparePhysicalFallback(
                 delegate {
                     activations++;
                     return true;
                 },
                 delegate {
                     foregroundChecks++;
                     throw new Fault("QT_TEST_SHOULD_NOT_INSPECT_CAPTION");
                 },
                 delegate { preparations++; }) &&
                 activations == 1 && foregroundChecks == 0 && preparations == 0,
             "QT_TEST_UIA_API_SUCCESS_NO_CAPTION_CAPABILITY");
        n++;
        Need(QtUiaPreparePhysicalFallback(
                 delegate {
                     activations++;
                     return false;
                 },
                 delegate {
                     foregroundChecks++;
                     return true;
                 },
                 delegate { preparations++; }) &&
                 activations == 2 && foregroundChecks == 1 && preparations == 0,
             "QT_TEST_UIA_LATE_ACTIVATION_NO_CAPTION_CAPABILITY");
        n++;
        Need(!QtUiaPreparePhysicalFallback(
                 delegate {
                     activations++;
                     return false;
                 },
                 delegate {
                     foregroundChecks++;
                     return false;
                 },
                 delegate { preparations++; }) &&
                 activations == 3 && foregroundChecks == 2 && preparations == 1,
             "QT_TEST_UIA_API_DENIED_REQUIRES_FRESH_CAPTION");
        n++;
        Expect(delegate {
            QtUiaPreparePhysicalFallback(delegate { return false; },
                                         delegate { throw new Fault("QT_HUMAN_ACTIVITY_CHANGED"); },
                                         delegate { preparations++; });
        }, "QT_HUMAN_ACTIVITY_CHANGED");
        Need(preparations == 1, "QT_TEST_UIA_CHANGED_FOREGROUND_NEVER_PROBES_OR_CLICKS");
        n++;
        Expect(delegate {
            QtUiaPreparePhysicalFallback(delegate { return false; }, delegate { return false; },
                                         delegate { throw new Fault("QT_UIA_CAPTION_ROOT_INVALID"); });
        }, "QT_UIA_CAPTION_ROOT_INVALID");
        n++;
        int captionReads = 0;
        Need(QtUiaCaptionFallbackReady(delegate { return true; }, delegate { captionReads++; }) && captionReads == 0,
             "QT_TEST_UIA_DIRECT_ACTIVATION_SKIPS_CAPTION_READ");
        n++;
        Need(!QtUiaCaptionFallbackReady(delegate { return false; }, delegate { captionReads++; }) && captionReads == 1,
             "QT_TEST_UIA_PHYSICAL_FALLBACK_REQUIRES_FRESH_CAPTION");
        n++;
        Expect(delegate {
            QtUiaCaptionFallbackReady(delegate { return false; },
                                      delegate { throw new Fault("QT_UIA_CAPTION_CHANGED"); });
        }, "QT_UIA_CAPTION_CHANGED");
        n++;
        Rect physicalClient = new Rect(2645, 767, 3721, 1454), roundedClient = new Rect(2645, 766, 3720, 1453);
        Need(CaptionGeometry.SameClient(physicalClient, physicalClient) &&
                 CaptionGeometry.SameClient(roundedClient, physicalClient),
             "QT_TEST_UIA_CAPTION_RESTORED_PROVIDER_ONE_PIXEL_ROUNDING");
        n++;
        Need(CaptionGeometry.SameClient(new Rect(0, 213, 1022, 985), new Rect(0, 214, 1023, 987)),
             "QT_TEST_UIA_CAPTION_42053_OBSERVED_TWO_PIXEL_CONTAINER_EDGE");
        n++;
        foreach (Rect changed in new[] { new Rect(2642, 767, 3721, 1454), new Rect(2645, 764, 3721, 1454),
                                         new Rect(2645, 767, 3718, 1454), new Rect(2645, 767, 3721, 1451),
                                         new Rect(2645, 767, 3640, 1454), new Rect() })
        {
            Need(!CaptionGeometry.SameClient(changed, physicalClient),
                 "QT_TEST_UIA_CAPTION_LARGER_DRIFT_OR_DISPLAY_CLIP_REFUSED");
            n++;
        }
        Need(CaptionGeometry.InsideClient(new Rect(3445, 766, 3721, 814), physicalClient) &&
                 !CaptionGeometry.InsideClient(new Rect(3445, 765, 3721, 814), physicalClient),
             "QT_TEST_UIA_CAPTION_TOOLBAR_ONE_PIXEL_EDGE_ONLY");
        n++;
        Need(!Contains(physicalClient, new Rect(3000, 766, 3025, 777)) &&
                 Contains(physicalClient, new Rect(3000, 773, 3025, 784)),
             "QT_TEST_UIA_CAPTION_CANDIDATES_STAY_INSIDE_EXACT_NATIVE_CLIENT");
        n++;
        var restoredBand = new Rect(2645, 767, 3721, 790);
        int[] restoredRows = CaptionGeometry.SampleRows(restoredBand, 5);
        Rect firstRow = new Rect(3105, restoredRows[0] - 5, 3130, restoredRows[0] + 6),
             lowerRow = new Rect(3105, restoredRows[1] - 5, 3130, restoredRows[1] + 6);
        Need(Contains(restoredBand, firstRow) && Contains(restoredBand, lowerRow) &&
                 !QtUiaAllCaptionPoints(QtUiaCaptionPoints(firstRow),
                                        delegate(Point point) { return point.Y >= 778; }) &&
                 QtUiaAllCaptionPoints(QtUiaCaptionPoints(lowerRow), delegate(Point point) { return point.Y >= 778; }),
             "QT_TEST_UIA_CAPTION_RESTORED_RESIZE_EDGE_SKIPPED_WITH_ALL_POINTS_REQUIRED");
        n++;
        var container = new QtUiaCaptionNode { Class = "QWidget", Type = ControlType.Group, Focusable = false };
        Need(QtUiaCaptionContainer(container, false), "QT_TEST_UIA_CAPTION_KNOWN_LAYOUT_CONTAINER");
        n++;
        container.Focusable = true;
        Need(!QtUiaCaptionContainer(container, false), "QT_TEST_UIA_CAPTION_FOCUSABLE_CONTAINER_EXCLUDED");
        n++;
        container.Focusable = false;
        container.Type = ControlType.Edit;
        Need(!QtUiaCaptionContainer(container, false), "QT_TEST_UIA_CAPTION_CHANGED_CONTAINER_TYPE_EXCLUDED");
        n++;
        container.Type = ControlType.Group;
        container.Class = "unknown";
        Need(!QtUiaCaptionContainer(container, false), "QT_TEST_UIA_CAPTION_UNKNOWN_GROUP_EXCLUDED");
        n++;
        foreach (var control in new[] {
                     new QtUiaCaptionNode { Class = "mmui::MainTabBar", Type = ControlType.ToolBar },
                     new QtUiaCaptionNode { Class = "mmui::TitleBar", Type = ControlType.ToolBar },
                     new QtUiaCaptionNode { Class = "mmui::PinnedButton", Type = ControlType.Button },
                     new QtUiaCaptionNode { Class = "mmui::XButton", Type = ControlType.Button },
                     new QtUiaCaptionNode { Class = "mmui::ChatTextItemView", Type = ControlType.ListItem }
                 })
        {
            Need(!QtUiaCaptionContainer(control, false), "QT_TEST_UIA_CAPTION_INTERACTIVE_AND_CHAT_REGIONS_EXCLUDED");
            n++;
        }
        Rect band = new Rect(2560, 0, 3640, 24), candidate = new Rect(3022, 7, 3047, 18);
        var excluded = new List<Rect> { new Rect(2560, 0, 2650, 24), new Rect(3364, 0, 3640, 24) };
        Need(Contains(band, candidate) && CaptionGeometry.Avoids(candidate, excluded),
             "QT_TEST_UIA_CAPTION_CURRENT_BLANK_REGION_BETWEEN_CONTROLS");
        n++;
        excluded.Add(new Rect(3046, 0, 3050, 24));
        Need(!CaptionGeometry.Avoids(candidate, excluded), "QT_TEST_UIA_CAPTION_ONE_PIXEL_CONTROL_OVERLAP_REJECTED");
        n++;
        Need(CaptionGeometry.Intersection(band, new Rect(2945, 45, 3633, 129)).Height <= 0 &&
                 Same(CaptionGeometry.Intersection(band, new Rect(2560, 0, 2650, 1848)), new Rect(2560, 0, 2650, 24)),
             "QT_TEST_UIA_CAPTION_PARENT_CLIP_AND_UPPER_HALF_EXCLUDE_CHAT");
        n++;
        Need(!QtUiaCaptionRequested(Data()) && QtUiaCaptionRequested(Data("uiaCaptionActivation", true)),
             "QT_TEST_UIA_CAPTION_OPT_IN");
        n++;
        foreach (var request in new[] { Data("uiaCaptionActivation", false), Data("uiaCaptionActivation", 1),
                                        Data("uiaCaptionActivation", true, "focusActivation", Data()) })
        {
            Expect(delegate { QtUiaCaptionRequested(request); }, "QT_UIA_CAPTION_REQUEST_INVALID");
            n++;
        }
        var snapshot =
            new QtReturnCaption { Dpi = 144, Client = new Rect(0, 0, 1080, 687), ClientOrigin = new Point(-1080, 20) };
        Rect rect = QtUiaCaptionRect(new Point(-540, 38), snapshot);
        Need(FocusActivationGeometry(rect, 1080) && Contains(snapshot.Client, rect) && rect.Width >= 20 &&
                 rect.Height >= 8,
             "QT_TEST_UIA_CAPTION_CURRENT_CLIENT_COORDINATES");
        n++;
        var points = QtUiaCaptionPoints(new Rect(-552, 33, -527, 44));
        Need(points.Length == 5 && points[0].X == -540 && points[1].X == -552 && points[4].X == -528,
             "QT_TEST_UIA_CAPTION_FIVE_CURRENT_POINTS");
        n++;
        int hits = 0;
        Need(QtUiaAllCaptionPoints(points, delegate(Point point) {
                 hits++;
                 return true;
             }) && hits == 5, "QT_TEST_UIA_ALL_FIVE_HIT_TESTS_REQUIRED");
        n++;
        for (int rejected = 0; rejected < 5; rejected++)
        {
            int index = 0, at = rejected;
            Need(!QtUiaAllCaptionPoints(points, delegate(Point point) { return index++ != at; }),
                 "QT_TEST_UIA_ANY_NON_CAPTION_POINT_REFUSED");
            n++;
        }
        Need(!QtUiaAllCaptionPoints(new Point[4], delegate(Point point) {
            throw new Exception("invalid proof queried");
        }), "QT_TEST_UIA_INCOMPLETE_CAPTION_PROOF_REFUSED");
        n++;
        foreach (string action in new[] { "paste", "searchEnter", "submitTextEnter", "click", "movePointer", "chord",
                                          "type", "beginFocusHandoff", "parkFocusHandoff", "resumeFocusHandoff",
                                          "transferFocusHandoff", "releaseFocusHandoff", "stop" })
        {
            Need(!QtUiaSearchReadOnlyAction(action), "QT_TEST_UIA_INPUT_OR_LEASE_CHANGE_REVOKES_SEARCH");
            n++;
        }
        foreach (string action in new[] { "inspectLayout", "inspectPopup", "capture", "captureUiaNavigation",
                                          "inspectUiaFocusGeometry" })
        {
            Need(QtUiaSearchReadOnlyAction(action), "QT_TEST_UIA_READ_ONLY_OBSERVATION_KEEPS_SEARCH_SCOPE");
            n++;
        }
        var lease = new QtFocusLease { Wechat = new WindowIdentity(new IntPtr(42), 7, 123), Revision = 5 };
        var proof =
            new QtUiaSearchGeneration { Id = "generation", Lease = lease,
                                        Binding = new Binding { Window = new IntPtr(42), Pid = 7, Created = 123 },
                                        Revision = 5, Issued = 100 };
        Need(QtUiaSearchMatches(proof, "generation", lease, 5, 100) &&
                 QtUiaSearchMatches(proof, "generation", lease, 5, 30100),
             "QT_TEST_UIA_READY_EXACT_GENERATION");
        n++;
        Need(!QtUiaSearchMatches(proof, "other", lease, 5, 101) &&
                 !QtUiaSearchMatches(proof, "generation", new QtFocusLease { Wechat = lease.Wechat, Revision = 5 }, 5,
                                     101) &&
                 !QtUiaSearchMatches(proof, "generation", lease, 6, 101) &&
                 !QtUiaSearchMatches(proof, "generation", lease, 5, 99) &&
                 !QtUiaSearchMatches(proof, "generation", lease, 5, 30101),
             "QT_TEST_UIA_READY_REVOKED_GENERATION");
        n++;
        foreach (int changed in new[] { 0, 1, 2 })
        {
            var invalid =
                new QtUiaSearchGeneration { Id = proof.Id, Lease = lease,
                                            Binding = new Binding { Window = new IntPtr(changed == 0 ? 43 : 42),
                                                                    Pid = (uint)(changed == 1 ? 8 : 7),
                                                                    Created = changed == 2 ? 124 : 123 },
                                            Revision = 5, Issued = 100 };
            Need(!QtUiaSearchMatches(invalid, "generation", lease, 5, 101),
                 "QT_TEST_UIA_READY_CHANGED_NATIVE_IDENTITY");
            n++;
        }
        foreach (var request in new[] { Data("uiaControlFrame", true), Data("regions", new object[0]),
                                        Data("token", "ordinary-capture") })
        {
            Expect(delegate { QtFocusUiaReadyEditor(request); }, "QT_UIA_READY_REQUEST_INVALID");
            n++;
        }
        var saved = QtUiaSearchReady;
        try
        {
            QtUiaSearchReady = proof;
            QtRevokeUiaSearch();
            Need(QtUiaSearchReady == null && !QtUiaSearchMatches(QtUiaSearchReady, "generation", lease, 5, 101),
                 "QT_TEST_UIA_READY_SINGLE_USE");
            n++;
        }
        finally
        {
            QtUiaSearchReady = saved;
        }
        return n;
    }
}
