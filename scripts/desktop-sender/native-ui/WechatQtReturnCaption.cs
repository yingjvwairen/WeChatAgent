// A fresh, in-memory return-window caption proof for one Qt focus lease.
// No persistent calibration, arbitrary coordinate fallback, input-queue
// attachment or synthetic keys. Transferred-focus cleanup may remeasure a
// visible caption after a full guarded click-history warmup; no coordinates
// cross helpers. Layout capture alone may raise its already-proven caption.
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;
using System.Drawing;
using System.Windows.Forms;

internal static partial class WechatDraftProbe
{
    sealed class QtReturnCaption
    {
        internal WindowIdentity Identity;
        internal uint Thread, Dpi, SourceThread;
        internal Rect Window, Client, SourceBounds;
        internal Point ClientOrigin, Center;
        internal Point[] Points;
        internal long Issued;
        internal bool AllowSourceOverlap;
    }
    sealed class QtCaptionClickHistory : FocusClickHistory
    {
    }
    static QtCaptionClickHistory QtCaptionClicks = new QtCaptionClickHistory();
    static readonly Action<uint, Point> QtCaptionObserver = delegate(uint message, Point point)
    {
        QtCaptionClicks.Observe(message, point, Now());
    };
    static bool QtCaptionClickSafe(bool seen, long last, Point previous, Point next, long now, long started,
                                   long humanAt, uint interval, int width, int height)
    {
        return FocusCaptionClickSafe(seen, last, previous, next, now, started, humanAt, interval, width, height);
    }
    static bool QtCaptionHistorySafe(Point point, uint dpi)
    {
        double scale = Math.Max(1, dpi / 96.0);
        return MouseObservationObserver == QtCaptionObserver &&
               QtCaptionClicks.Safe(point, Now(), Interlocked.Read(ref ActivityMonitorStarted),
                                    Interlocked.Read(ref LastActivity), QtGetDoubleClickTime(),
                                    (int)Math.Ceiling(GetSystemMetrics(36) * scale),
                                    (int)Math.Ceiling(GetSystemMetrics(37) * scale));
    }
    static IntPtr QtCaptionCoordinates(Point point)
    {
        return FocusCaptionCoordinates(point, "QT_RETURN_CAPTION_COORDINATES_INVALID");
    }
    static QtReturnCaption QtCaptionSnapshot(WindowIdentity expected)
    {
        Need(WindowIdentity.Same(expected, QtFocusWindow(expected.Window)), "QT_FOCUS_TARGET_CHANGED");
        Need(GetWindow(expected.Window, 4) == IntPtr.Zero, "QT_RETURN_CAPTION_UNAVAILABLE");
        uint pid;
        uint thread = GetWindowThreadProcessId(expected.Window, out pid);
        Need(thread != 0 && thread != GetCurrentThreadId() && pid == expected.Pid, "QT_FOCUS_TARGET_CHANGED");
        Need(ObjectName(GetThreadDesktop(thread)) == "Default", "DRAFT_DESKTOP_UNAVAILABLE");
        var gui = new GuiInfo { Size = (uint)Marshal.SizeOf(typeof(GuiInfo)) };
        Need(GetGUIThreadInfo(thread, ref gui) && (gui.Flags & 0x1e) == 0 && gui.Capture == IntPtr.Zero,
             "QT_RETURN_CAPTION_CAPTURE_ACTIVE");
        Rect window = new Rect(), client = new Rect();
        Point origin = new Point(0, 0);
        Need(GetWindowRect(expected.Window, out window) && GetClientRect(expected.Window, out client) &&
                 ClientToScreen(expected.Window, ref origin),
             "QT_FOCUS_TARGET_CHANGED");
        uint dpi = GetDpiForWindow(expected.Window);
        Need(window.Width >= 400 && window.Width <= 8192 && window.Height >= 200 && window.Height <= 8192 &&
                 client.Width > 0 && client.Height > 0 && dpi >= 96 && dpi <= 240,
             "QT_RETURN_CAPTION_UNAVAILABLE");
        return new QtReturnCaption { Identity = expected, Thread = thread,       Dpi = dpi,     Window = window,
                                     Client = client,     ClientOrigin = origin, Issued = Now() };
    }
    static bool QtSameCaption(QtReturnCaption a, QtReturnCaption b)
    {
        return a != null && b != null && WindowIdentity.Same(a.Identity, b.Identity) && a.Thread == b.Thread &&
               a.Dpi == b.Dpi && Same(a.Window, b.Window) && Same(a.Client, b.Client) &&
               QtSamePoint(a.ClientOrigin, b.ClientOrigin);
    }
    static List<Point> QtCaptionCandidates(Rect window, uint dpi)
    {
        return FocusCaptionCandidates(window, dpi);
    }
    static Point[] QtCaptionPoints(Point center, uint dpi)
    {
        return FocusCaptionPoints(center, dpi);
    }
    static bool QtCaptionOutsideSource(Rect area, Rect source)
    {
        return area.Width > 0 && area.Height > 0 && source.Width > 0 && source.Height > 0 && !Intersects(area, source);
    }
    static bool QtCaptionOverlapAllowed(bool layoutCaptureOnly, Rect area, Rect source)
    {
        return QtCaptionOutsideSource(area, source) ||
               layoutCaptureOnly && area.Width > 0 && area.Height > 0 && source.Width > 0 && source.Height > 0;
    }
    static bool QtCaptionSourceBoundsStable(Rect expected, Rect actual)
    {
        return expected.Width > 0 && expected.Height > 0 && Same(expected, actual);
    }
    static bool QtCaptionPointsOwned(QtReturnCaption proof)
    {
        if (proof == null || proof.Points == null || proof.Points.Length != 5)
            return false;
        var area = new Rect(proof.Points[1].X, proof.Points[1].Y, proof.Points[4].X + 1, proof.Points[4].Y + 1);
        var displays = new List<Rect>();
        foreach (Screen screen in Screen.AllScreens)
        {
            Rectangle bounds = screen.Bounds;
            displays.Add(new Rect(bounds.Left, bounds.Top, bounds.Right, bounds.Bottom));
        }
        if (!QtCoveredByDisplays(area, displays))
            return false;
        // Ordinary sending requires the five-point neighborhood to survive
        // the target's raise. A layout-only lease instead retains the proved
        // caption and may restore its visibility once before a return click.
        if (!QtCaptionOverlapAllowed(proof.AllowSourceOverlap, area, proof.SourceBounds))
            return false;
        foreach (Point point in proof.Points)
            if (QtCaptionMonitorFromPoint(point, 0) == IntPtr.Zero ||
                !Owned(WindowFromPoint(point), proof.Identity.Window, proof.Identity.Pid))
                return false;
        return true;
    }
    static bool QtCaptionSourceStateValid(uint thread, uint pid, uint expectedThread, uint expectedPid, uint flags,
                                          IntPtr capture)
    {
        return thread != 0 && thread == expectedThread && pid == expectedPid && (flags & 0x1e) == 0 &&
               capture == IntPtr.Zero;
    }
    static void QtCaptionSourceReady(QtFocusLease lease, QtReturnCaption proof)
    {
        uint pid;
        uint thread = GetWindowThreadProcessId(lease.Wechat.Window, out pid);
        var gui = new GuiInfo { Size = (uint)Marshal.SizeOf(typeof(GuiInfo)) };
        Need(GetGUIThreadInfo(thread, ref gui) &&
                 QtCaptionSourceStateValid(thread, pid, proof.SourceThread, lease.Wechat.Pid, gui.Flags, gui.Capture),
             "QT_RETURN_CAPTION_SOURCE_CAPTURE_OR_THREAD_CHANGED");
        Rect source;
        Need(GetWindowRect(lease.Wechat.Window, out source) && QtCaptionSourceBoundsStable(proof.SourceBounds, source),
             "QT_RETURN_CAPTION_SOURCE_GEOMETRY_CHANGED");
    }
    static bool QtCaptionHit(QtReturnCaption proof, Point point, long deadline)
    {
        long remaining = deadline - Now();
        Need(remaining > 0, "QT_RETURN_CAPTION_PROBE_TIMEOUT");
        UIntPtr value;
        IntPtr status =
            QtCaptionSendMessageTimeout(proof.Identity.Window, 0x84, UIntPtr.Zero, QtCaptionCoordinates(point), 0x23,
                                        (uint)Math.Min(20, remaining), out value);
        Need(status != IntPtr.Zero && Now() <= deadline, "QT_RETURN_CAPTION_PROBE_TIMEOUT");
        return unchecked((long)value.ToUInt64()) == 2;
    }
    static void QtWaitReturnCaptionHistory(Action guard, Func<bool> ready, Func<long> clock, Action<int> wait,
                                           long maximumWait)
    {
        Need(maximumWait > 0 && maximumWait <= 5100, "QT_RETURN_CAPTION_WARMUP");
        long deadline = clock() + maximumWait;
        for (;;)
        {
            guard();
            Need(clock() <= deadline, "QT_RETURN_CAPTION_WARMUP");
            if (ready())
            {
                guard();
                Need(clock() <= deadline, "QT_RETURN_CAPTION_WARMUP");
                return;
            }
            long remaining = deadline - clock();
            Need(remaining > 0, "QT_RETURN_CAPTION_WARMUP");
            wait((int)Math.Min(10, remaining));
        }
    }
    static void QtWarmTransferredCaption(QtFocusLease lease, long revision)
    {
        uint interval = QtGetDoubleClickTime();
        Need(interval > 0 && interval <= 5000 && MouseObservationObserver == QtCaptionObserver,
             "QT_RETURN_CAPTION_WARMUP");
        QtWaitReturnCaptionHistory(
            delegate {
                QtFocusTransitionGuard(lease, revision, true);
                Need(GetForegroundWindow() == lease.Wechat.Window, "QT_FOCUS_TARGET_CHANGED");
            },
            delegate {
                return MouseObservationObserver == QtCaptionObserver &&
                       Now() - Interlocked.Read(ref ActivityMonitorStarted) > interval &&
                       Now() - Interlocked.Read(ref LastActivity) > interval;
            },
            Now, Thread.Sleep, interval + 100);
    }
    static QtReturnCaption QtCaptureReturnCaption(QtFocusLease lease, long revision)
    {
        return QtCaptureReturnCaption(lease, revision, lease.Return.Window, Now() + 600, false);
    }
    static bool QtOptionalCaptionRefusal(string code)
    {
        return code == "QT_RETURN_CAPTION_UNAVAILABLE" || code == "QT_RETURN_CAPTION_WARMUP" ||
               code == "QT_RETURN_CAPTION_PROBE_TIMEOUT" || code == "QT_RETURN_CAPTION_CHANGED" ||
               code == "QT_RETURN_CAPTION_CAPTURE_ACTIVE" || code == "QT_RETURN_CAPTION_COORDINATES_INVALID";
    }
    static QtReturnCaption QtOptionalReturnCaption(Func<QtReturnCaption> probe, Action guard, Action<string> refused)
    {
        guard();
        QtReturnCaption result = null;
        try
        {
            result = probe();
        }
        catch (Fault error)
        {
            if (!QtOptionalCaptionRefusal(error.Message))
                throw;
            if (refused != null)
                refused(error.Message);
        }
        // A missing caption is only a missing mouse fallback. Process/window
        // identity and actual user activity still gate the normal Win32 path.
        guard();
        return result;
    }
    static QtReturnCaption QtCaptureReturnCaption(QtFocusLease lease, long revision, IntPtr foreground, long deadline,
                                                  bool transferred)
    {
        Need(!transferred || lease.TransferredInputTick.HasValue && foreground == lease.Wechat.Window &&
                                 !lease.AllowOverlappedReturn,
             "QT_FOCUS_LEASE_INVALID");
        Action guard = delegate
        {
            QtFocusTransitionGuard(lease, revision, transferred);
            Need(GetForegroundWindow() == foreground, "QT_FOCUS_TARGET_CHANGED");
        };
        guard();
        var proof = QtCaptionSnapshot(lease.Return);
        proof.AllowSourceOverlap = !transferred && lease.AllowOverlappedReturn;
        uint sourcePid;
        proof.SourceThread = GetWindowThreadProcessId(lease.Wechat.Window, out sourcePid);
        Need(proof.SourceThread != 0 && sourcePid == lease.Wechat.Pid, "QT_FOCUS_TARGET_CHANGED");
        Need(GetWindowRect(lease.Wechat.Window, out proof.SourceBounds) && proof.SourceBounds.Width > 0 &&
                 proof.SourceBounds.Height > 0,
             "QT_FOCUS_TARGET_CHANGED");
        QtCaptionSourceReady(lease, proof);
        Need(MouseObservationObserver == QtCaptionObserver &&
                 Now() - Interlocked.Read(ref ActivityMonitorStarted) > QtGetDoubleClickTime(),
             "QT_RETURN_CAPTION_WARMUP");
        foreach (Point center in QtCaptionCandidates(proof.Window, proof.Dpi))
        {
            guard();
            QtCaptionSourceReady(lease, proof);
            Need(QtSameCaption(proof, QtCaptionSnapshot(lease.Return)), "QT_FOCUS_TARGET_CHANGED");
            Need(Now() < deadline, "QT_RETURN_CAPTION_PROBE_TIMEOUT");
            if (!QtCaptionHistorySafe(center, proof.Dpi))
                continue;
            proof.Center = center;
            proof.Points = QtCaptionPoints(center, proof.Dpi);
            if (!QtCaptionPointsOwned(proof))
                continue;
            bool caption = true;
            foreach (Point point in proof.Points)
                if (!QtCaptionHit(proof, point, deadline))
                {
                    caption = false;
                    break;
                }
            if (!caption)
                continue;
            guard();
            QtCaptionSourceReady(lease, proof);
            Need(QtSameCaption(proof, QtCaptionSnapshot(lease.Return)) && QtCaptionPointsOwned(proof) &&
                     QtCaptionHistorySafe(center, proof.Dpi),
                 "QT_RETURN_CAPTION_CHANGED");
            guard();
            Need(Now() <= deadline, "QT_RETURN_CAPTION_PROBE_TIMEOUT");
            return proof;
        }
        throw new Fault("QT_RETURN_CAPTION_UNAVAILABLE");
    }
    static bool QtReturnCaptionCanClick(bool attempted, bool source, bool proof, bool revision, bool keys, bool history,
                                        bool geometry, bool caption, bool owned)
    {
        return !attempted && source && proof && revision && keys && history && geometry && caption && owned;
    }
    static string QtReturnCaptionDecision(bool accepted, IntPtr current, IntPtr source, IntPtr target)
    {
        return accepted            ? "accepted"
               : current == target ? "already-target"
               : current == source ? "caption"
                                   : "foreground-changed";
    }
    static FocusVisibilityObservation QtReturnCaptionRaiseOnce(bool allowed, Action guard, Func<bool> owned,
                                                               Func<bool> raise, Func<long> clock, Action<int> wait)
    {
        Need(allowed, "QT_RETURN_CAPTION_CHANGED");
        return FocusConfirmVisibilityOnce(guard, delegate { return owned() ? 0 : 1; }, raise, clock, wait, false, null,
                                          "QtReturnCaptionVisibility");
    }
    static bool QtActivateReturnOnce(QtFocusLease lease, IntPtr source, long revision, long deadline)
    {
        Action guard = delegate
        {
            QtFocusTransitionGuard(lease, revision, true);
        };
        bool accepted = ActivateForegroundOnce(source, lease.Return.Window, guard);
        var diagnostic = FocusActivationDiagnostic;
        if (diagnostic != null)
        {
            diagnostic["returnCaptionConsidered"] = !accepted;
            diagnostic["returnCaptionAttempted"] = false;
            diagnostic["returnCaptionApplied"] = false;
            diagnostic["returnCaptionVerified"] = false;
        }
        if (accepted)
            return true;
        guard();
        IntPtr foreground = GetForegroundWindow();
        string decision = QtReturnCaptionDecision(false, foreground, source, lease.Return.Window);
        if (decision == "already-target")
            return true;
        Need(decision == "caption" && source == lease.Wechat.Window, "QT_FOCUS_TARGET_CHANGED");
        // A normal API denial does not require a title bar or a synthetic key.
        // The existing short-lived helper binds both windows, connects only to
        // the current foreground queue and fully exits before confirmation.
        if (ActivateBoundReturnForegroundOnce(source, lease.Return.Window, QtExecutable, guard))
            return true;
        if (lease.ReturnCaption == null && lease.TransferredInputTick.HasValue)
        {
            // Only a rejected foreground request from the original WeChat
            // root can reach this path. Do not raise covered windows or trust
            // serialized coordinates; prove the current five-point caption.
            Point original;
            guard();
            Need(FocusGetCursorPos(out original), "QT_POINTER_UNAVAILABLE");
            var fresh = QtCaptureReturnCaption(lease, revision, source, Math.Min(deadline - 150, Now() + 200), true);
            guard();
            Point current;
            Need(FocusGetCursorPos(out current) && QtSamePoint(current, original), "QT_HUMAN_ACTIVITY_CHANGED");
            lease.OriginalPointer = original;
            lease.PointerSaved = true;
            lease.ReturnCaption = fresh;
            if (diagnostic != null)
                diagnostic["returnCaptionReacquired"] = true;
        }
        if (lease.ReturnCaption == null)
            return false;
        Need(!lease.ReturnCaptionAttempted, "QT_RETURN_CAPTION_ALREADY_ATTEMPTED");
        var proof = lease.ReturnCaption;
        Need(Now() - proof.Issued >= 0 && Now() - proof.Issued <= 30000, "QT_RETURN_CAPTION_EXPIRED");
        Action captionGuard = delegate
        {
            guard();
            QtCaptionSourceReady(lease, proof);
        };
        if (lease.AllowOverlappedReturn && proof.AllowSourceOverlap && !QtCaptionPointsOwned(proof))
        {
            // This capability was measured on the actual foreground caption
            // before borrowing focus. A maximized target can cover it later.
            // Restore its visibility once, without activating or moving it;
            // the existing exact HTCAPTION/ownership checks still precede any
            // click. A human or third-party focus change ends this operation.
            Rect returnDesktop = QtDesktopRect();
            Action raiseGuard = delegate
            {
                captionGuard();
                Need(Now() < deadline && GetForegroundWindow() == source && source == lease.Wechat.Window &&
                         Same(returnDesktop, QtDesktopRect()) && QtSameCaption(proof, QtCaptionSnapshot(lease.Return)),
                     "QT_RETURN_CAPTION_CHANGED");
            };
            var visible = QtReturnCaptionRaiseOnce(
                !lease.ReturnRaiseAttempted, raiseGuard, delegate { return QtCaptionPointsOwned(proof); },
                delegate {
                    raiseGuard();
                    Need(!lease.ReturnRaiseAttempted, "QT_RETURN_CAPTION_ALREADY_ATTEMPTED");
                    lease.ReturnRaiseAttempted = true;
                    return FocusSetWindowPos(lease.Return.Window, IntPtr.Zero, 0, 0, 0, 0, 0x4213);
                },
                Now, Thread.Sleep);
            if (diagnostic != null)
            {
                diagnostic["returnRaiseAttempted"] = visible.RaiseAttempted;
                diagnostic["returnRaiseAccepted"] = visible.RequestAccepted;
                diagnostic["returnRaiseConfirmed"] = visible.Confirmed;
            }
            Need(visible.Confirmed, "QT_RETURN_CAPTION_CHANGED");
        }
        long verifyDeadline = Math.Min(deadline, Now() + 150);
        captionGuard();
        Need(QtSameCaption(proof, QtCaptionSnapshot(lease.Return)) && QtCaptionPointsOwned(proof),
             "QT_RETURN_CAPTION_CHANGED");
        Need(QtCaptionHistorySafe(proof.Center, proof.Dpi), "QT_RETURN_CAPTION_DOUBLE_CLICK_UNCERTAIN");
        foreach (Point point in proof.Points)
        {
            captionGuard();
            Need(GetForegroundWindow() == source, "QT_FOCUS_TARGET_CHANGED");
            Need(QtCaptionHit(proof, point, verifyDeadline), "QT_RETURN_CAPTION_CHANGED");
        }
        captionGuard();
        Need(Now() < verifyDeadline && QtSameCaption(proof, QtCaptionSnapshot(lease.Return)) &&
                 QtCaptionPointsOwned(proof),
             "QT_RETURN_CAPTION_CHANGED");
        Need(QtReturnCaptionCanClick(lease.ReturnCaptionAttempted, GetForegroundWindow() == source,
                                     lease.ReturnCaption == proof, lease.Revision == Interlocked.Read(ref Revision),
                                     QtKeysReleased(), QtCaptionHistorySafe(proof.Center, proof.Dpi), true, true, true),
             "QT_RETURN_CAPTION_CHANGED");
        Rect desktop = QtDesktopRect();
        Input[] inputs = ClickEvents(proof.Center.X, proof.Center.Y, desktop);
        captionGuard();
        Need(QtCaptionHit(proof, proof.Center, verifyDeadline), "QT_RETURN_CAPTION_CHANGED");
        captionGuard();
        Need(GetForegroundWindow() == source && QtSameCaption(proof, QtCaptionSnapshot(lease.Return)) &&
                 Same(desktop, QtDesktopRect()) && QtCaptionPointsOwned(proof) &&
                 QtCaptionHistorySafe(proof.Center, proof.Dpi) && Now() < verifyDeadline,
             "QT_RETURN_CAPTION_CHANGED");
        // Durable for the lease before any mouse event: a later cleanup may
        // not retry this uncertain return attempt, even if zero events apply.
        lease.ReturnCaptionAttempted = true;
        lease.PointerMoved = true;
        lease.PointerCertain = false;
        InputAttempted = true;
        QtCaptionClicks.Observe(0x201, proof.Center, Now());
        if (diagnostic != null)
        {
            diagnostic["returnCaptionVerified"] = true;
            diagnostic["returnCaptionAttempted"] = true;
        }
        uint inserted = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(Input)));
        bool applied = inserted == inputs.Length;
        if (diagnostic != null)
            diagnostic["returnCaptionApplied"] = applied;
        if (!applied)
        {
            Input[] release = ClickReleases(inserted);
            if (release.Length > 0)
                SendInput((uint)release.Length, release, Marshal.SizeOf(typeof(Input)));
            throw new Fault("QT_RETURN_CAPTION_INPUT_UNCERTAIN");
        }
        long pointerDeadline = Math.Min(deadline, Now() + 100);
        for (;;)
        {
            guard();
            Point actual;
            if (FocusGetCursorPos(out actual) && QtNearPoint(actual, proof.Center))
            {
                lease.LastPointer = actual;
                lease.PointerCertain = true;
                break;
            }
            Need(Now() < pointerDeadline, "QT_RETURN_CAPTION_POINTER_UNCONFIRMED");
            Thread.Sleep(5);
        }
        return true;
    }
    static int QtReturnCaptionSelfTest()
    {
        int checks = 0;
        {
            int guarded = 0, refused = 0;
            Action guard = delegate
            {
                guarded++;
            };
            var optional = QtOptionalReturnCaption(delegate { throw new Fault("QT_RETURN_CAPTION_UNAVAILABLE"); },
                                                   guard, delegate(string code) { refused++; });
            Need(optional == null && guarded == 2 && refused == 1,
                 "QT_TEST_NO_CAPTION_DOES_NOT_BLOCK_BOUND_WIN32_FOCUS");
            checks++;
            foreach (string reason in new[] { "QT_RETURN_CAPTION_WARMUP", "QT_RETURN_CAPTION_PROBE_TIMEOUT",
                                              "QT_RETURN_CAPTION_CAPTURE_ACTIVE" })
            {
                Need(QtOptionalReturnCaption(delegate { throw new Fault(reason); }, delegate {}, null) == null,
                     "QT_TEST_UNSUPPORTED_CAPTION_IS_OPTIONAL");
                checks++;
            }
            foreach (string reason in new[] { "QT_HUMAN_ACTIVITY_CHANGED", "QT_FOCUS_TARGET_CHANGED",
                                              "DRAFT_DESKTOP_UNAVAILABLE" })
            {
                Expect(delegate { QtOptionalReturnCaption(delegate { throw new Fault(reason); }, delegate {}, null); },
                       reason);
                checks++;
            }
            guarded = 0;
            Expect(delegate {
                QtOptionalReturnCaption(delegate { throw new Fault("QT_RETURN_CAPTION_UNAVAILABLE"); },
                                        delegate {
                                            if (++guarded == 2)
                                                throw new Fault("QT_HUMAN_ACTIVITY_CHANGED");
                                        },
                                        null);
            }, "QT_HUMAN_ACTIVITY_CHANGED");
            checks++;
        }
        {
            long clock = 0;
            int guards = 0, waits = 0;
            Action guard = delegate
            {
                guards++;
            };
            Action<int> wait = delegate(int ms)
            {
                waits++;
                clock += ms;
            };
            Func<long> time = delegate
            {
                return clock;
            };
            QtWaitReturnCaptionHistory(guard, delegate { return clock > 500; }, time, wait, 600);
            Need(clock == 510 && waits == 51 && guards == 53,
                 "QT_TEST_TRANSFERRED_CAPTION_WARMS_FULL_DOUBLE_CLICK_INTERVAL_WITHOUT_INPUT");
            checks++;
            clock = 0;
            waits = 0;
            guards = 0;
            QtWaitReturnCaptionHistory(guard, delegate { return true; }, time, wait, 600);
            Need(waits == 0 && guards == 2, "QT_TEST_TRANSFERRED_CAPTION_ALREADY_WARM_RECHECKS_WITHOUT_WAIT");
            checks++;
            clock = 0;
            waits = 0;
            Expect(delegate { QtWaitReturnCaptionHistory(guard, delegate { return false; }, time, wait, 600); },
                   "QT_RETURN_CAPTION_WARMUP");
            Need(clock == 600 && waits == 60, "QT_TEST_TRANSFERRED_CAPTION_HISTORY_WAIT_IS_BOUNDED");
            checks++;
            clock = 0;
            guards = 0;
            Expect(delegate {
                QtWaitReturnCaptionHistory(
                    delegate {
                        if (clock >= 20)
                            throw new Fault("QT_HUMAN_ACTIVITY_CHANGED");
                    },
                    delegate { return clock > 500; }, time, wait, 600);
            }, "QT_HUMAN_ACTIVITY_CHANGED");
            Need(clock == 20, "QT_TEST_TRANSFERRED_CAPTION_ACTIVITY_ABORTS_WARMUP");
            checks++;
            guards = 0;
            Expect(delegate {
                QtWaitReturnCaptionHistory(
                    delegate {
                        if (++guards == 2)
                            throw new Fault("QT_FOCUS_TARGET_CHANGED");
                    },
                    delegate { return true; }, time, wait, 600);
            }, "QT_FOCUS_TARGET_CHANGED");
            Need(guards == 2, "QT_TEST_TRANSFERRED_CAPTION_FINAL_IDENTITY_GUARD_REQUIRED");
            checks++;
            clock = 0;
            Expect(delegate {
                QtWaitReturnCaptionHistory(delegate { clock += 601; }, delegate { return true; }, time, wait, 600);
            }, "QT_RETURN_CAPTION_WARMUP");
            Need(clock == 601, "QT_TEST_TRANSFERRED_CAPTION_SLOW_GUARD_CANNOT_CONFIRM_LATE");
            checks++;
        }
        foreach (Point point in new[] { new Point(-1, -1), new Point(-2500, 22), new Point(32767, -32768),
                                        new Point(-32768, 32767) })
        {
            long packed = QtCaptionCoordinates(point).ToInt64();
            Need(unchecked((short)packed) == point.X && unchecked((short)(packed >> 16)) == point.Y,
                 "QT_TEST_CAPTION_SIGNED_COORDINATES");
            checks++;
        }
        Expect(delegate { QtCaptionCoordinates(new Point(32768, 1)); }, "QT_RETURN_CAPTION_COORDINATES_INVALID");
        checks++;
        Point previous = new Point(-500, 20), same = new Point(-500, 20), apart = new Point(-490, 20);
        Need(!QtCaptionClickSafe(false, 0, previous, same, 1000, 501, 0, 500, 4, 4) &&
                 !QtCaptionClickSafe(false, 0, previous, same, 1000, 0, 501, 500, 4, 4),
             "QT_TEST_CAPTION_UNKNOWN_HISTORY_WARMUP");
        checks++;
        Need(QtCaptionClickSafe(false, 0, previous, same, 1000, 0, 0, 500, 4, 4) &&
                 !QtCaptionClickSafe(true, 900, previous, same, 1000, 0, 0, 500, 4, 4) &&
                 QtCaptionClickSafe(true, 900, previous, apart, 1000, 0, 0, 500, 4, 4) &&
                 !QtCaptionClickSafe(true, 500, previous, same, 1000, 0, 0, 500, 4, 4) &&
                 QtCaptionClickSafe(true, 500, previous, same, 1001, 0, 0, 500, 4, 4),
             "QT_TEST_CAPTION_DOUBLE_CLICK_TIME_AND_RECT");
        checks++;
        var history = new QtCaptionClickHistory();
        history.Observe(0x201, previous, 900);
        Need(!history.Safe(same, 1000, 0, 0, 500, 4, 4), "QT_TEST_CAPTION_OWN_LEFT_CLICK_RECORDED");
        history.Observe(0x200, apart, 999);
        Need(!history.Safe(same, 1000, 0, 0, 500, 4, 4), "QT_TEST_CAPTION_POINTER_MOVE_DOES_NOT_ERASE_CLICK");
        checks++;
        history.Observe(0x201, apart, 950);
        Need(!history.Safe(same, 1000, 0, 0, 500, 4, 4),
             "QT_TEST_INTERLEAVED_OTHER_WINDOW_CLICK_DOES_NOT_ERASE_CAPTION_HISTORY");
        checks++;
        var queued = new QtCaptionClickHistory();
        queued.Observe(0x201, same, 1000);
        Need(!queued.Safe(same, 1001, 0, 0, 500, 4, 4), "QT_TEST_CAPTION_SYNCHRONOUS_INTENT_BLOCKS_BEFORE_CALLBACK");
        queued.Observe(0x201, apart, 1100);
        Need(!queued.Safe(same, 1101, 0, 0, 500, 4, 4) && !queued.Safe(apart, 1101, 0, 0, 500, 4, 4),
             "QT_TEST_DELAYED_OLD_CALLBACK_CANNOT_ERASE_NEW_INTENT");
        checks++;
        for (int i = 0; i < 65; i++)
            history.Observe(0x201, apart, 1000);
        Need(!history.Safe(new Point(500, 20), 1001, 0, 0, 500, 4, 4) &&
                 !history.Safe(new Point(500, 20), 1500, 0, 0, 500, 4, 4) &&
                 history.Safe(new Point(500, 20), 1501, 0, 0, 500, 4, 4),
             "QT_TEST_CAPTION_HISTORY_OVERFLOW_FAILS_CLOSED_UNTIL_COOLDOWN");
        checks++;
        history.Observe(0x201, apart, 7001);
        Need(history.Safe(new Point(500, 20), 7002, 0, 0, 500, 4, 4),
             "QT_TEST_EXPIRED_HISTORY_DOES_NOT_FORCE_PERMANENT_OVERFLOW");
        checks++;
        Need(QtCaptionSourceStateValid(4, 2, 4, 2, 0, IntPtr.Zero) &&
                 !QtCaptionSourceStateValid(4, 2, 4, 2, 0, new IntPtr(77)) &&
                 !QtCaptionSourceStateValid(5, 2, 4, 2, 0, IntPtr.Zero) &&
                 !QtCaptionSourceStateValid(4, 2, 4, 2, 4, IntPtr.Zero),
             "QT_TEST_SOURCE_CAPTURE_AND_THREAD_MUST_ALLOW_MOUSE_ROUTING");
        checks++;
        Rect sourceBounds = new Rect(400, 10, 1200, 750), safeArea = new Rect(1210, 18, 1219, 27);
        Need(QtCaptionOutsideSource(safeArea, sourceBounds) &&
                 !QtCaptionOutsideSource(new Rect(500, 18, 509, 27), sourceBounds) &&
                 !QtCaptionOutsideSource(new Rect(1198, 18, 1207, 27), sourceBounds),
             "QT_TEST_CAPTION_NEIGHBORHOOD_MUST_SURVIVE_SOURCE_RAISE");
        checks++;
        Need(QtCaptionOutsideSource(new Rect(1200, 18, 1209, 27), sourceBounds) &&
                 QtCaptionOutsideSource(new Rect(-50, 18, -41, 27), sourceBounds) &&
                 !QtCaptionOutsideSource(safeArea, new Rect()) && !QtCaptionOutsideSource(new Rect(), sourceBounds),
             "QT_TEST_CAPTION_HALF_OPEN_NEGATIVE_AND_INVALID_BOUNDS");
        checks++;
        Need(QtCaptionOverlapAllowed(true, new Rect(500, 18, 509, 27), sourceBounds) &&
                 !QtCaptionOverlapAllowed(false, new Rect(500, 18, 509, 27), sourceBounds) &&
                 !QtCaptionOverlapAllowed(true, new Rect(), sourceBounds) &&
                 !QtCaptionOverlapAllowed(true, safeArea, new Rect()),
             "QT_TEST_LAYOUT_ONLY_VALID_CAPTION_MAY_OVERLAP");
        checks++;
        {
            long clock = 0;
            int raised = 0, sampled = 0;
            Action noop = delegate {};
            Func<bool> raise = delegate
            {
                raised++;
                return true;
            };
            Func<long> time = delegate
            {
                return clock;
            };
            Action<int> wait = delegate(int ms)
            {
                clock += ms;
            };
            Expect(delegate { QtReturnCaptionRaiseOnce(false, noop, delegate { return false; }, raise, time, wait); },
                   "QT_RETURN_CAPTION_CHANGED");
            Need(raised == 0, "QT_TEST_NON_LAYOUT_RETURN_NEVER_RAISES");
            checks++;
            var visible = QtReturnCaptionRaiseOnce(true, noop, delegate { return true; }, raise, time, wait);
            Need(visible.Confirmed && !visible.RaiseAttempted && raised == 0, "QT_TEST_VISIBLE_RETURN_NEVER_RAISES");
            checks++;
            visible = QtReturnCaptionRaiseOnce(true, noop, delegate { return ++sampled >= 3; }, raise, time, wait);
            Need(visible.Confirmed && raised == 1 && sampled == 3, "QT_TEST_LAYOUT_RETURN_SINGLE_ASYNC_RAISE");
            checks++;
            clock = 0;
            raised = 0;
            visible = QtReturnCaptionRaiseOnce(true, noop, delegate { return false; }, raise, time, wait);
            Need(!visible.Confirmed && raised == 1 && clock == 250, "QT_TEST_LAYOUT_RETURN_TIMEOUT_NO_REPEATED_RAISE");
            checks++;
            int guards = 0;
            raised = 0;
            Expect(delegate {
                QtReturnCaptionRaiseOnce(true,
                                         delegate {
                                             if (++guards == 1)
                                                 throw new Fault("QT_HUMAN_ACTIVITY_CHANGED");
                                         },
                                         delegate { return false; }, raise, time, wait);
            }, "QT_HUMAN_ACTIVITY_CHANGED");
            Need(raised == 0, "QT_TEST_LAYOUT_RETURN_HUMAN_BEFORE_RAISE");
            checks++;
            guards = 0;
            raised = 0;
            clock = 0;
            Expect(delegate {
                QtReturnCaptionRaiseOnce(true,
                                         delegate {
                                             if (raised > 0)
                                                 throw new Fault("QT_HUMAN_ACTIVITY_CHANGED");
                                         },
                                         delegate { return false; }, raise, time, wait);
            }, "QT_HUMAN_ACTIVITY_CHANGED");
            Need(raised == 1, "QT_TEST_LAYOUT_RETURN_HUMAN_AFTER_RAISE_NO_RETRY");
            checks++;
        }
        Need(QtCaptionSourceBoundsStable(sourceBounds, sourceBounds) &&
                 !QtCaptionSourceBoundsStable(sourceBounds, new Rect(401, 10, 1201, 750)) &&
                 !QtCaptionSourceBoundsStable(sourceBounds, new Rect(400, 10, 1201, 750)) &&
                 !QtCaptionSourceBoundsStable(new Rect(), new Rect()),
             "QT_TEST_CAPTION_SOURCE_MOVE_RESIZE_REJECTED");
        checks++;
        int safeCandidates = 0, blockedCandidates = 0;
        foreach (Point center in QtCaptionCandidates(new Rect(0, 0, 1600, 1000), 120))
        {
            Point[] points = QtCaptionPoints(center, 120);
            Rect area = new Rect(points[1].X, points[1].Y, points[4].X + 1, points[4].Y + 1);
            if (QtCaptionOutsideSource(area, new Rect(400, 10, 1100, 750)))
                safeCandidates++;
            else
                blockedCandidates++;
            Need(!QtCaptionOutsideSource(area, new Rect(-100, -100, 2000, 1200)),
                 "QT_TEST_SOURCE_COVERING_ALL_CAPTIONS_HAS_NO_FALLBACK");
        }
        Need(safeCandidates > 0 && blockedCandidates > 0, "QT_TEST_CAPTION_ENUMERATION_SKIPS_UNSAFE_BEFORE_BORROW");
        checks++;
        Need(!QtCoveredByDisplays(new Rect(105, 20, 115, 30),
                                  new List<Rect> { new Rect(0, 0, 100, 100), new Rect(100, 50, 200, 150) }) &&
                 QtCoveredByDisplays(new Rect(95, 55, 105, 65),
                                     new List<Rect> { new Rect(0, 0, 100, 100), new Rect(100, 50, 200, 150) }),
             "QT_TEST_CAPTION_DISPLAY_HOLE_REFUSED_AND_CONTIGUOUS_COVERAGE_ALLOWED");
        checks++;
        IntPtr source = new IntPtr(1), target = new IntPtr(2), otherWindow = new IntPtr(3);
        Need(QtReturnCaptionDecision(true, source, source, target) == "accepted" &&
                 QtReturnCaptionDecision(false, target, source, target) == "already-target" &&
                 QtReturnCaptionDecision(false, source, source, target) == "caption" &&
                 QtReturnCaptionDecision(false, otherWindow, source, target) == "foreground-changed",
             "QT_TEST_CAPTION_ONLY_REJECTED_SOURCE_CAN_CLICK");
        checks++;
        for (int flags = 0; flags < 512; flags++)
            Need(QtReturnCaptionCanClick((flags & 1) != 0, (flags & 2) != 0, (flags & 4) != 0, (flags & 8) != 0,
                                         (flags & 16) != 0, (flags & 32) != 0, (flags & 64) != 0, (flags & 128) != 0,
                                         (flags & 256) != 0) == (flags == 510),
                 "QT_TEST_CAPTION_ALL_GUARDS_REQUIRED");
        checks++;
        var identity = new WindowIdentity(new IntPtr(1), 2, 3);
        var proof = new QtReturnCaption { Identity = identity,
                                          Thread = 4,
                                          Dpi = 120,
                                          Window = new Rect(0, 0, 1600, 1000),
                                          Client = new Rect(0, 0, 1580, 980),
                                          ClientOrigin = new Point(10, 0) };
        Need(QtSameCaption(proof, proof) && QtCaptionCandidates(proof.Window, 120).Count == 16 &&
                 QtCaptionPoints(new Point(486, 22), 120).Length == 5,
             "QT_TEST_CAPTION_BOUNDED_GEOMETRY");
        checks++;
        foreach (int change in new[] { 0, 1, 2, 3, 4, 5 })
        {
            var other = new QtReturnCaption { Identity = identity,
                                              Thread = 4,
                                              Dpi = 120,
                                              Window = proof.Window,
                                              Client = proof.Client,
                                              ClientOrigin = proof.ClientOrigin };
            if (change == 0)
                other.Thread++;
            if (change == 1)
                other.Dpi++;
            if (change == 2)
                other.Window.Right++;
            if (change == 3)
                other.Client.Bottom++;
            if (change == 4)
                other.ClientOrigin.X++;
            if (change == 5)
                other.Identity = new WindowIdentity(identity.Window, identity.Pid, 4);
            Need(!QtSameCaption(proof, other), "QT_TEST_CAPTION_IDENTITY_AND_GEOMETRY_FROZEN");
            checks++;
        }
        return checks;
    }
    [DllImport("user32.dll", EntryPoint = "GetDoubleClickTime")]
    static extern uint QtGetDoubleClickTime();
    [DllImport("user32.dll", EntryPoint = "MonitorFromPoint")]
    static extern IntPtr QtCaptionMonitorFromPoint(Point point, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "SendMessageTimeoutW", SetLastError = true)]
    static extern IntPtr QtCaptionSendMessageTimeout(IntPtr window, uint message, UIntPtr wparam, IntPtr lparam,
                                                     uint flags, uint timeout, out UIntPtr result);
}
