// Capture-only visibility transaction. No keyboard focus request, input,
// clipboard access, process injection or coordinate click. A temporary topmost
// change is always compensated before returning, including after human activity.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

internal static partial class WechatDraftProbe
{
    [StructLayout(LayoutKind.Sequential)]
    struct QtLayoutPlacement
    {
        internal int Length, Flags, Show;
        internal Point Min, Max;
        internal Rect Normal;
    }
    [DllImport("user32.dll", EntryPoint = "GetWindowPlacement")]
    static extern bool QtLayoutGetPlacement(IntPtr window, ref QtLayoutPlacement placement);
    [DllImport("dwmapi.dll", EntryPoint = "DwmFlush")]
    static extern int QtLayoutFlush();
    sealed class QtLayoutWindowState
    {
        internal WindowIdentity Identity;
        internal Binding Binding;
        internal Rect Outer;
        internal long Style, ExtendedStyle;
        internal QtLayoutPlacement Placement;
    }
    static QtLayoutWindowState QtLayoutState(WindowIdentity expected, string executable = null)
    {
        WindowIdentity identity = QtFocusWindow(expected.Window, executable);
        Need(WindowIdentity.Same(identity, expected), "QT_BINDING_CHANGED");
        uint pid;
        uint thread = GetWindowThreadProcessId(identity.Window, out pid);
        var gui = new GuiInfo { Size = (uint)Marshal.SizeOf(typeof(GuiInfo)) };
        Need(GetGUIThreadInfo(thread, ref gui) && QtRaiseGuiClear(gui.Flags, gui.Capture), "QT_FOCUS_UNAVAILABLE");
        Rect client = new Rect(), outer = new Rect();
        Point origin = new Point(0, 0);
        Need(GetClientRect(identity.Window, out client) && GetWindowRect(identity.Window, out outer) &&
                 ClientToScreen(identity.Window, ref origin),
             "QT_BINDING_CHANGED");
        var placement = new QtLayoutPlacement { Length = Marshal.SizeOf(typeof(QtLayoutPlacement)) };
        Need(QtLayoutGetPlacement(identity.Window, ref placement), "QT_BINDING_CHANGED");
        var binding =
            new Binding { Window = identity.Window,
                          Pid = identity.Pid,
                          Thread = thread,
                          Created = identity.Created,
                          Dpi = GetDpiForWindow(identity.Window),
                          Client = client,
                          Capture = new Rect(origin.X, origin.Y, origin.X + client.Width, origin.Y + client.Height),
                          Focus = gui.Focus,
                          FocusOwned = Owned(gui.Focus, identity.Window, identity.Pid),
                          InputTick = QtInputTick(),
                          GuiFlags = gui.Flags };
        return new QtLayoutWindowState { Identity = identity,
                                         Binding = binding,
                                         Outer = outer,
                                         Style = GetWindowLongPtr(identity.Window, -16).ToInt64(),
                                         ExtendedStyle = GetWindowLongPtr(identity.Window, -20).ToInt64(),
                                         Placement = placement };
    }
    static bool QtSameLayoutState(QtLayoutWindowState before, QtLayoutWindowState after,
                                  bool allowTemporaryTopmost = false)
    {
        return before != null && after != null && WindowIdentity.Same(before.Identity, after.Identity) &&
               QtSameBinding(before.Binding, after.Binding) && before.Binding.Thread == after.Binding.Thread &&
               Same(before.Outer, after.Outer) && before.Style == after.Style &&
               (allowTemporaryTopmost ? (before.ExtendedStyle & ~8L) == (after.ExtendedStyle & ~8L)
                                      : before.ExtendedStyle == after.ExtendedStyle) &&
               before.Placement.Flags == after.Placement.Flags && before.Placement.Show == after.Placement.Show &&
               QtSamePoint(before.Placement.Min, after.Placement.Min) &&
               QtSamePoint(before.Placement.Max, after.Placement.Max) &&
               Same(before.Placement.Normal, after.Placement.Normal);
    }
    sealed class QtTemporaryTopmost
    {
        internal bool OriginalTopmost, Attempted, Applied, RollbackAttempted, RolledBack, RollbackConfirmed,
            TargetDestroyed;
        internal Dictionary<string, object> Report()
        {
            return Data("version", 1, "originalTargetTopmost", OriginalTopmost, "temporaryTopmostAttempted", Attempted,
                        "temporaryTopmostApplied", Applied, "temporaryTopmostRollbackAttempted", RollbackAttempted,
                        "temporaryTopmostRolledBack", RolledBack, "topmostRollbackConfirmed", RollbackConfirmed,
                        "targetDestroyed", TargetDestroyed);
        }
    }
    static Dictionary<string, object> QtLayoutVisibilityOutcome(bool restored, QtTemporaryTopmost topmost,
                                                                string originalFailure = null)
    {
        return Data("version", 1, "reason", restored ? "source-order-restored" : "restore-unconfirmed", "restored",
                    restored, "foregroundPreserved", restored, "identitiesUnchanged", restored, "activityUnchanged",
                    restored, "placementUnchanged", restored, "topmostUnchanged", restored, "temporaryTopmost",
                    topmost.Report(), "originalFailureCode", originalFailure);
    }
    static object QtRaisedVisibilityInterval(long started, bool complete)
    {
        return Data("version", 1, "phase", "layout-visibility", "durationMs", Math.Max(0, Now() - started), "complete",
                    complete, "keyboardFocusChanged", false);
    }
    static bool QtLayoutMakeVisible(Action guard, Func<bool> visible, Action raise, Func<long> clock, Action<int> wait)
    {
        long deadline = clock() + 250;
        guard();
        if (visible())
            return true;
        guard();
        raise();
        guard();
        for (;;)
        {
            guard();
            if (clock() > deadline)
                return false;
            bool shown = visible();
            guard();
            if (shown)
                return true;
            if (clock() >= deadline)
                return false;
            wait(10);
        }
    }
    // No Desktop(), foreground, visibility, geometry or activity requirement:
    // minimizing, opening a popup or changing focus must not prevent rollback.
    static int QtLayoutCleanupIdentity(QtLayoutWindowState expected)
    {
        if (!IsWindow(expected.Identity.Window))
            return 0;
        uint pid;
        uint thread = GetWindowThreadProcessId(expected.Identity.Window, out pid);
        if (pid != expected.Identity.Pid || thread != expected.Binding.Thread)
            return 0;
        IntPtr process = OpenProcess(0x1000, false, pid);
        Need(process != IntPtr.Zero, "QT_LAYOUT_ROLLBACK_IDENTITY_UNAVAILABLE");
        try
        {
            FileTime created, exit, kernel, user;
            Need(GetProcessTimes(process, out created, out exit, out kernel, out user),
                 "QT_LAYOUT_ROLLBACK_IDENTITY_UNAVAILABLE");
            if (created.Value != expected.Identity.Created)
                return 0;
            var file = new System.Text.StringBuilder(32768);
            int length = file.Capacity;
            Need(QueryFullProcessImageName(process, 0, file, ref length) &&
                     String.Equals(Path.GetFullPath(file.ToString()), QtExecutable, StringComparison.OrdinalIgnoreCase),
                 "QT_LAYOUT_ROLLBACK_IDENTITY_UNAVAILABLE");
            uint session, own;
            Need(ProcessIdToSessionId(pid, out session) && ProcessIdToSessionId(GetCurrentProcessId(), out own) &&
                     session == own,
                 "QT_LAYOUT_ROLLBACK_IDENTITY_UNAVAILABLE");
            return 1;
        }
        finally
        {
            CloseHandle(process);
        }
    }
    static bool QtDormantInputWindow(bool visible, Rect bounds, string windowClass)
    {
        return !visible && bounds.Width == 0 && bounds.Height == 0 &&
               (windowClass == "IME" || windowClass == "MSCTFIME UI");
    }
    static Dictionary<IntPtr, bool> QtLayoutOwnedTopmost(WindowIdentity target)
    {
        var windows = new Dictionary<IntPtr, bool>();
        Exception failure = null;
        bool enumerated = EnumWindows(delegate(IntPtr window, IntPtr unused) {
            try
            {
                IntPtr owner = GetWindow(window, 4);
                int depth = 0;
                var seen = new HashSet<IntPtr>();
                while (owner != IntPtr.Zero && owner != target.Window)
                {
                    Need(++depth <= 32 && seen.Add(owner), "QT_LAYOUT_WINDOW_FAMILY_UNCONFIRMED");
                    owner = GetWindow(owner, 4);
                }
                if (owner == target.Window)
                {
                    uint pid;
                    GetWindowThreadProcessId(window, out pid);
                    Need(pid == target.Pid && windows.Count < 128, "QT_LAYOUT_WINDOW_FAMILY_UNCONFIRMED");
                    // Focusing Qt can create invisible Windows IME helper windows
                    // with their own topmost flags. They occupy no screen area.
                    if (!IsWindowVisible(window))
                    {
                        Rect bounds;
                        var windowClass = new System.Text.StringBuilder(32);
                        if (GetWindowRect(window, out bounds) &&
                            GetClassName(window, windowClass, windowClass.Capacity) > 0 &&
                            QtDormantInputWindow(IsWindowVisible(window), bounds, windowClass.ToString()))
                            return true;
                    }
                    windows.Add(window, (GetWindowLongPtr(window, -20).ToInt64() & 8) != 0);
                }
            }
            catch (Exception error)
            {
                failure = error;
                return false;
            }
            return true;
        }, IntPtr.Zero);
        if (failure != null)
            throw failure;
        Need(enumerated, "QT_LAYOUT_WINDOW_FAMILY_UNCONFIRMED");
        return windows;
    }
    static bool QtLayoutFamilyMatches(Dictionary<IntPtr, bool> before, Dictionary<IntPtr, bool> after,
                                      bool allowTemporaryTopmost)
    {
        if (before.Count != after.Count)
            return false;
        foreach (var item in before)
        {
            bool value;
            if (!after.TryGetValue(item.Key, out value) || (!allowTemporaryTopmost && value != item.Value))
                return false;
        }
        return true;
    }
    static bool QtLayoutFamilyNotTopmost(Dictionary<IntPtr, bool> family)
    {
        foreach (bool value in family.Values)
            if (value)
                return false;
        return true;
    }
    static WindowIdentity QtLayoutVisiblePredecessor(WindowIdentity target, Dictionary<IntPtr, bool> owned)
    {
        IntPtr window = GetWindow(target.Window, 3);
        int count = 0;
        while (window != IntPtr.Zero)
        {
            Need(++count <= 4096, "QT_LAYOUT_SOURCE_ORDER_UNAVAILABLE");
            if (!owned.ContainsKey(window) && IsWindowVisible(window) && !IsIconic(window) &&
                (GetWindowLongPtr(window, -20).ToInt64() & 8) == 0)
            {
                int cloaked;
                if (DwmGetWindowAttribute(window, 14, out cloaked, 4) >= 0 && cloaked == 0)
                    return QtFocusWindow(window, null, true);
            }
            window = GetWindow(window, 3);
        }
        return null;
    }
    static void QtRollbackTemporaryTopmost(QtTemporaryTopmost lease, Func<int> identity, Func<bool> topmost,
                                           Action remove, Func<long> clock, Action<int> wait)
    {
        if (!lease.Attempted)
        {
            lease.RollbackConfirmed = true;
            return;
        }
        long deadline = clock() + 250;
        if (identity() == 0)
        {
            lease.TargetDestroyed = true;
            lease.RollbackConfirmed = true;
            return;
        }
        if (topmost())
            lease.Applied = true;
        // Compensate even if the async apply has not become visible yet. Seeing
        // a clear bit before that request ran is never proof of its rollback.
        lease.RollbackAttempted = true;
        remove();
        for (;;)
        {
            if (identity() == 0)
            {
                lease.TargetDestroyed = true;
                lease.RollbackConfirmed = true;
                return;
            }
            bool current = topmost();
            if (current)
                lease.Applied = true;
            if (!current && lease.Applied)
            {
                wait(10);
                if (identity() == 0)
                {
                    lease.TargetDestroyed = true;
                    lease.RollbackConfirmed = true;
                    return;
                }
                if (clock() <= deadline && !topmost())
                {
                    lease.RolledBack = true;
                    lease.RollbackConfirmed = true;
                    return;
                }
            }
            if (clock() >= deadline)
                return;
            wait(10);
        }
    }
    static bool QtLayoutIdle(long now, uint inputTick, long lastActivity, long revision, long minimum)
    {
        long? sessionIdle = FocusInputIdleMilliseconds(now, inputTick);
        return sessionIdle.HasValue && sessionIdle.Value >= minimum && (revision == 0 || now - lastActivity >= minimum);
    }
    static object QtCaptureLayoutRaised(Dictionary<string, object> request)
    {
        Need(QtEnableInput && !Stopping && QtFocus.Active == null && QtFocus.Parked == null && QtSurface == "main" &&
                 QtPopup == null && QtPendingPopup == null && QtPendingEnter == null,
             "QT_FOCUS_LEASE_UNAVAILABLE");
        var expected = Map(Get(request, "expectedBinding"));
        var inspection = Map(QtInspectLayout());
        Need(QtLayoutExpectedMatches(expected, Map(Get(inspection, "binding"))), "QT_BINDING_CHANGED");
        long idle = Number(Get(request, "idleMs"));
        Need(idle >= 0 && idle <= 300000, "QT_IDLE_INVALID");
        long revision = Interlocked.Read(ref Revision);
        uint inputTick = QtInputTick();
        // A capture-only helper starts with no hook history of its own. Use
        // the session's actual idle age and retain both activity guards.
        Need(QtLayoutIdle(Now(), inputTick, Interlocked.Read(ref LastActivity), revision, idle), "QT_USER_ACTIVE");
        NoKeysHeld();
        Need(revision == Interlocked.Read(ref Revision) && inputTick == QtInputTick(), "QT_HUMAN_ACTIVITY_CHANGED");
        var source = QtLayoutState(QtFocusWindow(GetForegroundWindow()));
        var target =
            QtLayoutState(QtFocusWindow(new IntPtr(DecimalString(Get(expected, "hwnd"))), QtExecutable), QtExecutable);
        Need(source.Identity.Window != target.Identity.Window && source.Identity.Pid != target.Identity.Pid &&
                 QtLayoutExpectedMatches(expected, Map(target.Binding.Report())),
             "QT_BINDING_CHANGED");
        bool originallyAbove = FocusWindowAbove(source.Identity.Window, target.Identity.Window);
        Need(originallyAbove, "QT_LAYOUT_SOURCE_ORDER_UNAVAILABLE");
        Rect desktop = QtDesktopRect();
        Need(QtCoveredByDisplays(target.Binding.Capture, FocusDisplayRects()), "QT_WINDOW_OUTSIDE_DISPLAY");
        var owned = QtLayoutOwnedTopmost(target.Identity);
        var predecessor = QtLayoutVisiblePredecessor(target.Identity, owned);
        var temporary = new QtTemporaryTopmost { OriginalTopmost = (target.ExtendedStyle & 8) != 0 };
        bool raised = false, restoreRaised = false, restored = false;
        long started = 0;
        object timing = null;
        Dictionary<string, object> restore = null;
        var files = new List<string>();
        Exception captureFailure = null;
        Action<Action> recordFailure = delegate(Action action)
        {
            try
            {
                action();
            }
            catch (Exception error)
            {
                if (captureFailure == null)
                    captureFailure = error;
                throw;
            }
        };
        // Input/geometry guards govern capture and relative Z-order only. The
        // mandatory removal of our temporary topmost uses identity alone.
        Action unchanged = delegate
        {
            Desktop();
            NoKeysHeld();
            Need(revision == Interlocked.Read(ref Revision) && inputTick == QtInputTick(), "QT_HUMAN_ACTIVITY_CHANGED");
            var actual = QtLayoutState(target.Identity, QtExecutable);
            if (temporary.Attempted && (actual.ExtendedStyle & 8) != 0)
                temporary.Applied = true;
            bool changing = temporary.Attempted && !temporary.RolledBack;
            Need(GetForegroundWindow() == source.Identity.Window && Same(desktop, QtDesktopRect()) &&
                     QtSameLayoutState(source, QtLayoutState(source.Identity)) &&
                     QtSameLayoutState(target, actual, changing) &&
                     QtLayoutFamilyMatches(owned, QtLayoutOwnedTopmost(target.Identity), changing),
                 "QT_BINDING_CHANGED");
        };
        Action active = delegate
        {
            Need(!Stopping, "QT_STOPPING");
            unchanged();
        };
        Bitmap[] samples;
        try
        {
            samples = QtLayoutPairTransaction<Bitmap>(
                delegate {
                    recordFailure(delegate {
                        active();
                        started = Now();
                        // Changing a root also changes its owned windows. Do not
                        // disturb any pre-existing topmost window in that family.
                        Need(!temporary.OriginalTopmost && QtLayoutFamilyNotTopmost(owned), "QT_WINDOW_OBSCURED");
                        bool visible = QtLayoutMakeVisible(
                            active,
                            delegate { return Number(Get(QtOverlapReport(target.Binding), "blockingCount")) == 0; },
                            delegate {
                                active();
                                Need(!raised, "QT_LAYOUT_RAISE_REPEATED");
                                raised = true;
                                temporary.Attempted = true;
                                FocusSetWindowPos(target.Identity.Window, new IntPtr(-1), 0, 0, 0, 0, 0x4213);
                            },
                            Now, Thread.Sleep);
                        Need(visible, "QT_WINDOW_OBSCURED");
                        Need(!temporary.Attempted || temporary.Applied, "QT_LAYOUT_TOPMOST_APPLY_UNCONFIRMED");
                    });
                },
                delegate {
                    recordFailure(delegate {
                        active();
                        QtNoOverlap(target.Binding);
                    });
                },
                delegate {
                    // Synchronize presentation without fixed sleep or a second
                    // raise. Source keeps its exact foreground/focus throughout.
                    Bitmap bitmap = null;
                    recordFailure(delegate {
                        Need(QtLayoutFlush() >= 0, "QT_LAYOUT_PRESENTATION_UNAVAILABLE");
                        active();
                        QtNoOverlap(target.Binding);
                        bitmap = new Bitmap(target.Binding.Client.Width, target.Binding.Client.Height,
                                            PixelFormat.Format32bppArgb);
                        try
                        {
                            using (var graphics = Graphics.FromImage(bitmap)) graphics.CopyFromScreen(
                                target.Binding.Capture.Left, target.Binding.Capture.Top, 0, 0,
                                new Size(bitmap.Width, bitmap.Height), CopyPixelOperation.SourceCopy);
                        }
                        catch
                        {
                            bitmap.Dispose();
                            throw;
                        }
                    });
                    return bitmap;
                },
                delegate {
                    Exception cleanupFailure = null;
                    try
                    {
                        QtRollbackTemporaryTopmost(
                            temporary, delegate { return QtLayoutCleanupIdentity(target); },
                            delegate { return (GetWindowLongPtr(target.Identity.Window, -20).ToInt64() & 8) != 0; },
                            delegate {
                                Need(QtLayoutCleanupIdentity(target) == 1, "QT_LAYOUT_ROLLBACK_IDENTITY_UNAVAILABLE");
                                FocusSetWindowPos(target.Identity.Window, new IntPtr(-2), 0, 0, 0, 0, 0x4213);
                            },
                            Now, Thread.Sleep);
                        if (temporary.Attempted && temporary.RollbackConfirmed && !temporary.TargetDestroyed)
                        {
                            Need(QtLayoutFlush() >= 0, "QT_LAYOUT_PRESENTATION_UNAVAILABLE");
                            if ((GetWindowLongPtr(target.Identity.Window, -20).ToInt64() & 8) != 0 ||
                                !QtLayoutFamilyNotTopmost(QtLayoutOwnedTopmost(target.Identity)))
                                temporary.RollbackConfirmed = false;
                        }
                    }
                    catch (Exception error)
                    {
                        temporary.RollbackConfirmed = false;
                        cleanupFailure = error;
                    }
                    if (temporary.RollbackConfirmed && !temporary.TargetDestroyed)
                    {
                        try
                        {
                            unchanged();
                            Action orderGuard = delegate
                            {
                                unchanged();
                                if (predecessor != null)
                                    Need(WindowIdentity.Same(predecessor,
                                                             QtFocusWindow(predecessor.Window, null, true)) &&
                                             (GetWindowLongPtr(predecessor.Window, -20).ToInt64() & 8) == 0,
                                         "QT_LAYOUT_PREDECESSOR_CHANGED");
                            };
                            if (raised)
                            {
                                var outcome = FocusRestoreUnclickedRaise(
                                    true, false, originallyAbove, orderGuard,
                                    delegate {
                                        return FocusWindowAbove(source.Identity.Window, target.Identity.Window) &&
                                               (predecessor == null ||
                                                FocusWindowAbove(predecessor.Window, target.Identity.Window));
                                    },
                                    delegate {
                                        orderGuard();
                                        Need(!restoreRaised, "QT_LAYOUT_RAISE_REPEATED");
                                        restoreRaised = true;
                                        return FocusSetWindowPos(target.Identity.Window,
                                                                 predecessor == null ? IntPtr.Zero : predecessor.Window,
                                                                 0, 0, 0, 0, 0x4213);
                                    },
                                    Now, Thread.Sleep);
                                Need(Object.Equals(Get(outcome, "confirmed"), true),
                                     "QT_LAYOUT_VISIBILITY_RESTORE_UNCONFIRMED");
                            }
                            Need(QtLayoutFlush() >= 0, "QT_LAYOUT_PRESENTATION_UNAVAILABLE");
                            unchanged();
                            restored = true;
                        }
                        catch (Exception error)
                        {
                            cleanupFailure = error;
                        }
                    }
                    restore = QtLayoutVisibilityOutcome(restored, temporary,
                                                        captureFailure is Fault ? captureFailure.Message : null);
                    timing = QtRaisedVisibilityInterval(started, restored);
                    if (!temporary.RollbackConfirmed)
                        throw new Fault("QT_LAYOUT_TOPMOST_ROLLBACK_UNCONFIRMED");
                    if (captureFailure == null && !restored)
                        throw cleanupFailure ?? new Fault("QT_LAYOUT_VISIBILITY_RESTORE_UNCONFIRMED");
                },
                delegate(Bitmap bitmap) { bitmap.Dispose(); });
        }
        catch (Exception error)
        {
            if (restore != null)
                error.Data["QtVisibilityRestoreOutcome"] = restore;
            if (started > 0)
                error.Data["QtRaisedVisibilityInterval"] = timing ?? QtRaisedVisibilityInterval(started, false);
            throw;
        }
        try
        {
            var frames = new List<object>();
            var binding = Map(target.Binding.Report());
            binding["foreground"] = false;
            foreach (Bitmap bitmap in samples)
            {
                string file = Path.Combine(QtFrames, "qt-" + Guid.NewGuid().ToString("N") + ".png");
                files.Add(file);
                string sha;
                using (var memory = new MemoryStream())
                {
                    bitmap.Save(memory, ImageFormat.Png);
                    var bytes = memory.ToArray();
                    sha = QtHash(bytes);
                    using (var output = new FileStream(file, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                        output.Write(bytes, 0, bytes.Length);
                }
                frames.Add(Data("readOnly", true, "inputSent", false, "focusChanged", false, "authorizationGranted",
                                false, "binding", binding, "executableVersion", Text(inspection, "executableVersion"),
                                "pixelFormat", "rgba-row-major-opaque-v1", "regions", new object[0], "image",
                                Data("file", file, "sha256", sha)));
            }
            return Data("version", 1, "mode", "visibility-topmost-layout-pair-v1", "focusChanged", false, "inputSent",
                        false, "chatInputSent", false, "clipboardAccessed", false, "authorizationGranted", false,
                        "restored", true, "activityUnchanged", true, "visibilityRestoreOutcome", restore,
                        "raisedVisibilityInterval", timing ?? QtRaisedVisibilityInterval(started, true),
                        "targetRaiseAttempted", raised, "sourceLowerAttempted", false, "restoreRaiseAttempted", false,
                        "relativeOrderRestoreAttempted", restoreRaised, "temporaryTopmostApplied", temporary.Applied,
                        "temporaryTopmostRolledBack", temporary.RolledBack, "frames", frames);
        }
        catch
        {
            foreach (string file in files)
                try
                {
                    File.Delete(file);
                }
                catch
                {
                }
            throw;
        }
        finally
        {
            foreach (Bitmap bitmap in samples)
                bitmap.Dispose();
        }
    }
    static int QtLayoutRaisedSelfTest()
    {
        var empty = new Rect(0, 0, 0, 0);
        Need(QtDormantInputWindow(false, empty, "IME") && QtDormantInputWindow(false, empty, "MSCTFIME UI") &&
                 !QtDormantInputWindow(true, empty, "IME") &&
                 !QtDormantInputWindow(false, new Rect(0, 0, 1, 1), "MSCTFIME UI") &&
                 !QtDormantInputWindow(false, empty, "Qt51514QWindowIcon"),
             "QT_TEST_LAYOUT_ONLY_IGNORES_DORMANT_SYSTEM_INPUT_WINDOWS");
        int count = 1;
        int raises = 0, samples = 0;
        long clock = 0;
        Action guard = delegate {};
        Action raise = delegate
        {
            raises++;
        };
        Func<long> time = delegate
        {
            return clock;
        };
        Action<int> wait = delegate(int ms)
        {
            clock += ms;
        };
        Need(QtLayoutMakeVisible(guard, delegate { return true; }, raise, time, wait) && raises == 0,
             "QT_TEST_LAYOUT_VISIBLE_NO_MUTATION");
        count++;
        Need(QtLayoutMakeVisible(guard, delegate { return ++samples > 1; }, raise, time, wait) && raises == 1,
             "QT_TEST_LAYOUT_TOPMOST_ONCE_NO_SOURCE_LOWER");
        count++;
        raises = 0;
        clock = 0;
        Need(!QtLayoutMakeVisible(guard, delegate { return false; }, raise, time, wait) && raises == 1 && clock == 250,
             "QT_TEST_LAYOUT_VISIBILITY_DEADLINE_NO_REPEAT");
        count++;
        foreach (string stage in new[] { "before", "after-raise" })
        {
            raises = 0;
            Expect(delegate {
                QtLayoutMakeVisible(
                    delegate {
                        if (stage == "before" || raises > 0)
                            throw new Fault("QT_HUMAN_ACTIVITY_CHANGED");
                    },
                    delegate { return false; }, raise, time, wait);
            }, "QT_HUMAN_ACTIVITY_CHANGED");
            Need(raises == (stage == "before" ? 0 : 1), "QT_TEST_LAYOUT_ACTIVITY_STOPS_FURTHER_RAISE");
            count++;
        }
        foreach (bool applied in new[] { false, true })
        {
            clock = 0;
            int removals = 0;
            bool bit = applied;
            var lease = new QtTemporaryTopmost { Attempted = true };
            QtRollbackTemporaryTopmost(lease, delegate { return 1; }, delegate { return bit; },
                                       delegate {
                                           removals++;
                                           bit = false;
                                       },
                                       time, wait);
            Need(removals == 1 && lease.RollbackAttempted && lease.Applied == applied &&
                     lease.RollbackConfirmed == applied && lease.RolledBack == applied,
                 "QT_TEST_LAYOUT_NO_APPLY_OBSERVATION_CANNOT_CONFIRM_ROLLBACK");
            count++;
        }
        {
            clock = 0;
            int removals = 0;
            var lease = new QtTemporaryTopmost { Attempted = true };
            QtRollbackTemporaryTopmost(lease, delegate { return 1; }, delegate { return clock >= 10 && clock < 30; },
                                       delegate { removals++; }, time, wait);
            Need(removals == 1 && lease.Applied && lease.RolledBack && lease.RollbackConfirmed,
                 "QT_TEST_LAYOUT_LATE_APPLY_REQUIRES_OBSERVED_CLEAR_AFTERWARDS");
            count++;
        }
        {
            clock = 0;
            int removals = 0;
            var lease = new QtTemporaryTopmost { Attempted = true, Applied = true };
            QtRollbackTemporaryTopmost(lease, delegate { return 1; }, delegate { return true; },
                                       delegate { removals++; }, time, wait);
            Need(removals == 1 && !lease.RollbackConfirmed && !lease.RolledBack && clock == 250,
                 "QT_TEST_LAYOUT_FAILED_ROLLBACK_IS_BOUNDED_AND_UNKNOWN");
            count++;
        }
        {
            clock = 0;
            bool bit = true;
            var lease = new QtTemporaryTopmost { Attempted = true, Applied = true };
            int removals = 0;
            Expect(delegate {
                QtLayoutPairTransaction<string>(delegate { throw new Fault("QT_TEST_CAPTURE_INTERRUPTED"); },
                                                delegate {}, delegate { return "unused"; },
                                                delegate {
                                                    QtRollbackTemporaryTopmost(lease, delegate { return 1; },
                                                                               delegate { return bit; },
                                                                               delegate {
                                                                                   removals++;
                                                                                   bit = false;
                                                                               },
                                                                               time, wait);
                                                },
                                                delegate(string sample) {});
            }, "QT_TEST_CAPTURE_INTERRUPTED");
            Need(removals == 1 && !bit && lease.RolledBack && lease.RollbackConfirmed,
                 "QT_TEST_LAYOUT_CAPTURE_INTERRUPTION_NEVER_SKIPS_OWN_TOPMOST_ROLLBACK");
            count++;
        }
        {
            clock = 0;
            bool sourceAbove = true, predecessorAbove = false;
            int targetMoves = 0;
            var order = FocusRestoreUnclickedRaise(true, false, true, delegate {},
                                                   delegate { return sourceAbove && predecessorAbove; },
                                                   delegate {
                                                       targetMoves++;
                                                       predecessorAbove = true;
                                                       return true;
                                                   },
                                                   time, wait);
            Need(targetMoves == 1 && Object.Equals(Get(order, "confirmed"), true),
                 "QT_TEST_LAYOUT_RESTORE_TARGET_BEHIND_PREDECESSOR_NOT_ONLY_SOURCE");
            count++;
        }
        {
            var lease = new QtTemporaryTopmost { Attempted = true };
            int removals = 0;
            QtRollbackTemporaryTopmost(lease, delegate { return 0; },
                                       delegate { throw new Fault("QT_TEST_NEW_WINDOW_NOT_READ"); },
                                       delegate { removals++; }, time, wait);
            Need(removals == 0 && lease.TargetDestroyed && lease.RollbackConfirmed && !lease.RolledBack,
                 "QT_TEST_LAYOUT_DESTROYED_TARGET_DOES_NOT_MUTATE_REPLACEMENT");
            count++;
        }
        {
            var lease = new QtTemporaryTopmost { Attempted = true };
            Expect(delegate {
                QtRollbackTemporaryTopmost(
                    lease, delegate { throw new Fault("QT_LAYOUT_ROLLBACK_IDENTITY_UNAVAILABLE"); },
                    delegate { return false; }, delegate { throw new Fault("QT_TEST_IDENTITY_UNKNOWN_NOT_MUTATED"); },
                    time, wait);
            }, "QT_LAYOUT_ROLLBACK_IDENTITY_UNAVAILABLE");
            Need(!lease.RollbackConfirmed, "QT_TEST_LAYOUT_IDENTITY_UNKNOWN_NOT_CONFIRMED");
            count++;
        }
        {
            var family = new Dictionary<IntPtr, bool> { { new IntPtr(1), false } };
            var changed = new Dictionary<IntPtr, bool> { { new IntPtr(1), true } };
            Need(QtLayoutFamilyNotTopmost(family) && !QtLayoutFamilyNotTopmost(changed) &&
                     QtLayoutFamilyMatches(family, changed, true) && !QtLayoutFamilyMatches(family, changed, false),
                 "QT_TEST_LAYOUT_OWNED_TOPMOST_ONLY_ALLOWED_DURING_TEMPORARY_CAPTURE");
            count++;
            changed.Add(new IntPtr(2), false);
            Need(!QtLayoutFamilyMatches(family, changed, true), "QT_TEST_LAYOUT_OWNED_FAMILY_CHANGE_REJECTED");
            count++;
        }
        var identity = new WindowIdentity(new IntPtr(1), 2, 3);
        var binding = new Binding { Window = identity.Window,
                                    Pid = 2,
                                    Created = 3,
                                    Thread = 4,
                                    Dpi = 120,
                                    Client = new Rect(0, 0, 800, 600),
                                    Capture = new Rect(10, 10, 810, 610),
                                    Focus = new IntPtr(2) };
        var state = new QtLayoutWindowState { Identity = identity, Binding = binding, Outer = new Rect(0, 0, 820, 620),
                                              Placement = new QtLayoutPlacement { Show = 1,
                                                                                  Normal = new Rect(0, 0, 820, 620) } };
        Need(QtSameLayoutState(state, state), "QT_TEST_LAYOUT_ORIGINAL_PLACEMENT_MATCHES");
        count++;
        var temporaryState = new QtLayoutWindowState { Identity = identity, Binding = binding, Outer = state.Outer,
                                                       Placement = state.Placement, ExtendedStyle = 8 };
        Need(QtSameLayoutState(state, temporaryState, true) && !QtSameLayoutState(state, temporaryState, false),
             "QT_TEST_LAYOUT_TEMPORARY_BIT_EXCEPTION_REVOKED_AFTER_ROLLBACK");
        count++;
        foreach (int change in new[] { 0, 1, 2, 3, 4, 5 })
        {
            var other = new QtLayoutWindowState { Identity = identity, Binding = binding, Outer = state.Outer,
                                                  Placement = state.Placement };
            if (change == 0)
                other.ExtendedStyle = 8;
            if (change == 1)
                other.Style = 1;
            if (change == 2)
                other.Outer.Left++;
            if (change == 3)
                other.Placement.Show = 3;
            if (change == 4)
                other.Placement.Normal.Right++;
            if (change == 5)
                other.Placement.Min.X++;
            Need(!QtSameLayoutState(state, other), "QT_TEST_LAYOUT_STYLE_TOPMOST_AND_PLACEMENT_FROZEN");
            count++;
        }
        return count;
    }
}
