using System;
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
using System.Windows.Forms;
using System.Xml;

internal static partial class WechatDraftProbe
{
    sealed class QtFocusLease
    {
        internal WindowIdentity Return, Wechat;
        internal long Revision, ForegroundStarted;
        internal long RequiredIdle = 1000;
        internal long? TransferredInputTick;
        internal long TransferredIssuedAt;
        internal bool IncludesContactNavigation, AllowOverlappedReturn, UiaMode, InPlace;
        internal string SessionId;
        internal FocusActivation Activation;
        internal QtUiaCaption UiaCaption;
        internal QtReturnCaption ReturnCaption;
        internal bool ReturnCaptionAttempted, TargetRaiseAttempted, ReturnRaiseAttempted;
        internal Point OriginalPointer, LastPointer;
        internal bool PointerSaved, PointerCertain, PointerMoved;
        internal void MarkPointerUncertain()
        {
            PointerMoved = true;
            PointerCertain = false;
        }

        internal object Handoff()
        {
            QtRequireTransferableLease(this);
            var value = Data("version", 1, "returnWindow", Return.Report());
            if (Activation != null)
                value.Add("activation", Activation.Report());
            if (ForegroundStarted > 0)
                value.Add("foregroundLease", Data("version", 1, "startedAtTickMs", ForegroundStarted,
                                                  "includesContactNavigation", IncludesContactNavigation));
            return value;
        }
    }
    // A helper owns at most one active or parked session. A parked lease and
    // the binding/time used to resume it are published and discarded together.
    sealed partial class QtFocusSession
    {
        readonly Func<long> now;
        internal QtFocusSession(Func<long> now)
        {
            this.now = now;
        }

        internal sealed class ParkedSession
        {
            internal readonly QtFocusLease Lease;
            internal readonly Binding Binding;
            internal readonly long At;

            internal ParkedSession(QtFocusLease lease, Binding binding, long at)
            {
                Lease = lease;
                Binding = binding;
                At = at;
            }
        }

        internal QtFocusLease Active { get; private set; }
        internal QtFocusLease Inspected { get; private set; }
        internal ParkedSession Parked { get; private set; }

        internal void RememberInspection(QtFocusLease lease)
        {
            Inspected = lease;
        }
        internal QtFocusLease TakeInspection()
        {
            var lease = Inspected;
            Inspected = null;
            return lease;
        }

        internal void Acquire(QtFocusLease lease)
        {
            Need(lease != null && Active == null && Parked == null, "QT_FOCUS_LEASE_UNAVAILABLE");
            Active = lease;
        }

        internal QtFocusLease TakeActive()
        {
            var lease = Active;
            Active = null;
            return lease;
        }

        internal void ParkAfterRestore(QtFocusLease lease, Binding binding)
        {
            Need(lease != null && binding != null && Active == null && Parked == null, "QT_FOCUS_PARK_UNAVAILABLE");
            Parked = new ParkedSession(lease, binding, now());
        }

        internal void DiscardParked()
        {
            Parked = null;
        }
    }

    static readonly QtFocusSession QtFocus = new QtFocusSession(Now);

    static object QtReleaseFocusHandoff()
    {
        QtEmptyPhaseProof = null;
        QtFocus.DiscardParked();
        var lease = QtFocus.TakeActive();
        return QtRestoreFocus(lease, lease != null && lease.Revision == Interlocked.Read(ref Revision));
    }

    static WindowIdentity QtFocusWindow(IntPtr window, string executable = null, bool allowOwnedPopup = false)
    {
        Desktop();
        Need(window != IntPtr.Zero && IsWindow(window) && IsWindowVisible(window) && !IsIconic(window) &&
                 GetAncestor(window, 2) == window && (allowOwnedPopup || GetLastActivePopup(window) == window),
             "QT_FOCUS_WINDOW_UNAVAILABLE");
        int cloaked;
        Need(DwmGetWindowAttribute(window, 14, out cloaked, 4) >= 0 && cloaked == 0, "QT_FOCUS_WINDOW_UNAVAILABLE");
        uint pid;
        Need(GetWindowThreadProcessId(window, out pid) != 0, "QT_FOCUS_WINDOW_UNAVAILABLE");
        uint session, own;
        Need(ProcessIdToSessionId(pid, out session) && ProcessIdToSessionId(GetCurrentProcessId(), out own) &&
                 session == own,
             "QT_FOCUS_WINDOW_UNAVAILABLE");
        IntPtr process = OpenProcess(0x1000, false, pid);
        Need(process != IntPtr.Zero, "QT_FOCUS_WINDOW_UNAVAILABLE");
        try
        {
            FileTime start, exit, kernel, user;
            Need(GetProcessTimes(process, out start, out exit, out kernel, out user), "QT_FOCUS_WINDOW_UNAVAILABLE");
            if (executable != null)
            {
                var file = new StringBuilder(32768);
                int length = file.Capacity;
                Need(QueryFullProcessImageName(process, 0, file, ref length) &&
                         String.Equals(Path.GetFullPath(file.ToString()), executable,
                                       StringComparison.OrdinalIgnoreCase),
                     "DRAFT_EXECUTABLE_MISMATCH");
            }
            return new WindowIdentity(window, pid, start.Value);
        }
        finally
        {
            CloseHandle(process);
        }
    }
    static void QtCheckFocusPair(QtFocusLease inspected, WindowIdentity source, WindowIdentity target)
    {
        if (inspected != null)
            Need(WindowIdentity.Same(inspected.Return, source) && WindowIdentity.Same(inspected.Wechat, target),
                 "QT_FOCUS_TARGET_CHANGED");
        if (source.Window == target.Window)
            throw new Fault("QT_FOCUS_RETURN_WINDOW_REQUIRED");
        Need(source.Pid != target.Pid, "QT_FOCUS_WECHAT_AUXILIARY_ACTIVE");
    }
    static WindowIdentity QtParseFocus(object value)
    {
        var map = Map(value);
        Need(map != null && map.Count == 3, "QT_FOCUS_LEASE_INVALID");
        long pid = Number(Get(map, "pid"));
        Need(pid > 0 && pid <= UInt32.MaxValue, "QT_FOCUS_LEASE_INVALID");
        return new WindowIdentity(new IntPtr(DecimalString(Get(map, "hwnd"))), (uint)pid,
                                  DecimalString(Get(map, "processCreatedFileTimeUtc")));
    }
    static uint QtInputTick()
    {
        var input = new LastInput { Size = (uint)Marshal.SizeOf(typeof(LastInput)) };
        Need(GetLastInputInfo(ref input), "DRAFT_ACTIVITY_MONITOR_UNAVAILABLE");
        return input.Time;
    }
    static bool QtCanRestore(bool owned, bool identity, bool activity, bool keys)
    {
        return owned && identity && activity && keys;
    }
    static bool QtKeysReleased()
    {
        for (int key = 1; key < 256; key++)
            if ((GetAsyncKeyState(key) & 0x8000) != 0)
                return false;
        return true;
    }
    static bool QtSamePoint(Point a, Point b)
    {
        return a.X == b.X && a.Y == b.Y;
    }
    static bool QtNearPoint(Point a, Point b)
    {
        return Math.Abs((long)a.X - b.X) <= 1 && Math.Abs((long)a.Y - b.Y) <= 1;
    }
    static Rect QtDesktopRect()
    {
        return new Rect(GetSystemMetrics(76), GetSystemMetrics(77), GetSystemMetrics(76) + GetSystemMetrics(78),
                        GetSystemMetrics(77) + GetSystemMetrics(79));
    }
    static Input[] QtPointerEvents(Point point, Rect desktop)
    {
        return new[] { ClickEvents(point.X, point.Y, desktop)[0] };
    }
    static bool QtCanParkPointer(string surface, Rect rect, int width, bool anchored)
    {
        return surface == "main" && FocusActivationGeometry(rect, width) && anchored;
    }
    static bool QtCanRestorePointer(bool saved, bool moved, bool certain, bool activity, bool keys, bool identity,
                                    bool foreground, bool desktop, Point actual, Point last)
    {
        return saved && moved && certain && activity && keys && identity && foreground && desktop &&
               QtSamePoint(actual, last);
    }
    // Record only the observed destination of our own marked mouse input. A
    // later physical move invalidates this lease even if it returns to the spot.
    static void QtRememberPointer(Point expected, long revision)
    {
        QtFocusLease lease = QtFocus.Active;
        if (lease != null)
        {
            lease.MarkPointerUncertain();
        }
        long end = Now() + 100;
        for (;;)
        {
            Need(revision == Interlocked.Read(ref Revision), "QT_HUMAN_ACTIVITY_CHANGED");
            Point actual;
            if (FocusGetCursorPos(out actual) && QtNearPoint(actual, expected))
            {
                if (lease != null)
                {
                    lease.LastPointer = actual;
                    lease.PointerCertain = true;
                }
                return;
            }
            Need(Now() < end, "QT_POINTER_UNCONFIRMED");
            Thread.Sleep(5);
        }
    }
    static bool QtRestorePointer(QtFocusLease lease, IntPtr foreground)
    {
        if (lease != null && lease.InPlace)
            return false;
        if (lease == null || !lease.PointerSaved || !lease.PointerMoved || !lease.PointerCertain)
            return false;
        Point actual;
        Rect desktop = QtDesktopRect();
        Point original = lease.OriginalPointer;
        if (!FocusGetCursorPos(out actual) ||
            !QtCanRestorePointer(
                lease.PointerSaved, lease.PointerMoved, lease.PointerCertain,
                lease.Revision == Interlocked.Read(ref Revision), QtKeysReleased(),
                WindowIdentity.Same(lease.Return, QtFocusWindow(lease.Return.Window)) &&
                    WindowIdentity.Same(lease.Wechat, QtFocusWindow(lease.Wechat.Window, QtExecutable, true)),
                GetForegroundWindow() == foreground,
                original.X >= desktop.Left && original.X < desktop.Right && original.Y >= desktop.Top &&
                    original.Y < desktop.Bottom,
                actual, lease.LastPointer))
            return false;
        Desktop();
        NoKeysHeld();
        if (lease.Revision != Interlocked.Read(ref Revision) || GetForegroundWindow() != foreground ||
            !FocusGetCursorPos(out actual) || !QtSamePoint(actual, lease.LastPointer))
            return false;
        Input[] inputs = QtPointerEvents(original, desktop);
        lease.PointerCertain = false;
        InputAttempted = true;
        Need(SendInput(1, inputs, Marshal.SizeOf(typeof(Input))) == 1, "QT_POINTER_RESTORE_UNCONFIRMED");
        long end = Now() + 100;
        for (;;)
        {
            if (lease.Revision != Interlocked.Read(ref Revision) || !QtKeysReleased())
                return false;
            if (FocusGetCursorPos(out actual) && QtNearPoint(actual, original))
            {
                lease.PointerMoved = false;
                return true;
            }
            Need(Now() < end, "QT_POINTER_RESTORE_UNCONFIRMED");
            Thread.Sleep(5);
        }
    }
    static WindowIdentity QtHandoffTarget(int width, int height, int dpi)
    {
        Need(width >= 600 && width <= 4096 && height >= 400 && height <= 4096 && dpi >= 48 && dpi <= 768,
             "QT_FOCUS_GEOMETRY_INVALID");
        IntPtr pinned = QtRoot.Window != IntPtr.Zero ? QtRoot.Window : QtWindow;
        if (pinned != IntPtr.Zero)
        {
            WindowIdentity selected = QtFocusWindow(pinned, QtExecutable);
            Rect client;
            Need(GetWindow(pinned, 4) == IntPtr.Zero &&
                     (QtRoot.Window == IntPtr.Zero ||
                      selected.Pid == QtRoot.Pid && selected.Created == QtRoot.Created) &&
                     GetClientRect(selected.Window, out client) && client.Width == width && client.Height == height &&
                     GetDpiForWindow(selected.Window) == dpi,
                 "QT_FOCUS_TARGET_CHANGED");
            return selected;
        }
        var candidates = new List<WindowIdentity>();
        EnumWindows(delegate(IntPtr window, IntPtr unused) {
            try
            {
                Rect client;
                if (GetWindow(window, 4) != IntPtr.Zero)
                    return true;
                WindowIdentity found = QtFocusWindow(window, QtExecutable);
                if (GetClientRect(window, out client) && client.Width == width && client.Height == height &&
                    GetDpiForWindow(window) == dpi)
                    candidates.Add(found);
            }
            catch
            {
            }
            return true;
        }, IntPtr.Zero);
        Need(candidates.Count == 1, "QT_FOCUS_TARGET_AMBIGUOUS");
        return candidates[0];
    }
    static object QtInspectLayout()
    {
        Need(!Stopping, "QT_STOPPING");
        Desktop();
        var candidates = new List<WindowIdentity>();
        IntPtr pinned = QtRoot.Window != IntPtr.Zero ? QtRoot.Window : QtWindow;
        EnumWindows(delegate(IntPtr window, IntPtr unused) {
            try
            {
                if (pinned != IntPtr.Zero && pinned != window || GetWindow(window, 4) != IntPtr.Zero)
                    return true;
                Rect clientRect;
                var found = QtFocusWindow(window, QtExecutable);
                if ((QtRoot.Window == IntPtr.Zero || found.Pid == QtRoot.Pid && found.Created == QtRoot.Created) &&
                    GetClientRect(window, out clientRect) && clientRect.Width >= 600 && clientRect.Width <= 4096 &&
                    clientRect.Height >= 400 && clientRect.Height <= 4096)
                    candidates.Add(found);
            }
            catch
            {
            }
            return true;
        }, IntPtr.Zero);
        Need(candidates.Count == 1, "QT_FOCUS_TARGET_AMBIGUOUS");
        var target = candidates[0];
        Rect client;
        Point origin = new Point(0, 0);
        Need(GetClientRect(target.Window, out client) && ClientToScreen(target.Window, ref origin),
             "DRAFT_GEOMETRY_UNAVAILABLE");
        uint dpi = GetDpiForWindow(target.Window);
        string version = FileVersionInfo.GetVersionInfo(QtExecutable).FileVersion, sha;
        using (var file = File.OpenRead(QtExecutable)) using (var digest = SHA256.Create()) sha =
            BitConverter.ToString(digest.ComputeHash(file)).Replace("-", "").ToLowerInvariant();
        Rect after;
        Point at = new Point(0, 0);
        Need(WindowIdentity.Same(target, QtFocusWindow(target.Window, QtExecutable)) &&
                 GetClientRect(target.Window, out after) && ClientToScreen(target.Window, ref at) &&
                 Same(client, after) && at.X == origin.X && at.Y == origin.Y && GetDpiForWindow(target.Window) == dpi,
             "QT_BINDING_CHANGED");
        return Data("version", 1, "readOnly", true, "inputSent", false, "focusChanged", false, "clipboardAccessed",
                    false, "executableVersion", version, "executableSha256", sha, "binding",
                    Data("hwnd", target.Window.ToInt64().ToString(CultureInfo.InvariantCulture), "pid", target.Pid,
                         "processCreatedFileTimeUtc", target.Created.ToString(CultureInfo.InvariantCulture), "dpi", dpi,
                         "clientRect", client.Report(), "captureRect",
                         new Rect(origin.X, origin.Y, origin.X + client.Width, origin.Y + client.Height).Report(),
                         "foreground", GetForegroundWindow() == target.Window));
    }
    static Binding QtLayoutBound()
    {
        var inspection = Map(QtInspectLayout());
        var raw = Map(Get(inspection, "binding"));
        IntPtr window = new IntPtr(DecimalString(Get(raw, "hwnd")));
        var identity = QtFocusWindow(window, QtExecutable);
        Rect client;
        Point origin = new Point(0, 0);
        Need(GetClientRect(window, out client) && ClientToScreen(window, ref origin), "DRAFT_GEOMETRY_UNAVAILABLE");
        uint pid;
        uint thread = GetWindowThreadProcessId(window, out pid);
        var gui = new GuiInfo { Size = (uint)Marshal.SizeOf(typeof(GuiInfo)) };
        Need(GetGUIThreadInfo(thread, ref gui) && (gui.Flags & 0x1e) == 0, "QT_FOCUS_UNAVAILABLE");
        var result =
            new Binding { Window = window,
                          Pid = identity.Pid,
                          Thread = thread,
                          Created = identity.Created,
                          Dpi = GetDpiForWindow(window),
                          Client = client,
                          Capture = new Rect(origin.X, origin.Y, origin.X + client.Width, origin.Y + client.Height),
                          Focus = gui.Focus,
                          FocusOwned = Owned(gui.Focus, window, identity.Pid),
                          InputTick = QtInputTick(),
                          GuiFlags = gui.Flags };
        QtNoOverlap(result);
        return result;
    }
    // Evidence for a layout candidate only. No token is issued, so these
    // background pixels can never authorize a click or substitute for QtGuard.
    static object QtCaptureLayout(Dictionary<string, object> request)
    {
        Need(!Stopping, "QT_STOPPING");
        var before = QtLayoutBound();
        var anchors = QtLayoutAnchors(Get(request, "regions"), Get(request, "image"), before.Client);
        var regions = new List<object>();
        foreach (var anchor in anchors)
        {
            anchor.Hash = QtHash(QtPixels(before, anchor.Rect));
            regions.Add(Data("rect", anchor.Rect.Report(), "rgbaSha256", anchor.Hash));
        }
        string file = null, sha = null;
        if (Object.Equals(Get(request, "image"), true))
        {
            file = Path.Combine(QtFrames, "qt-" + Guid.NewGuid().ToString("N") + ".png");
            using (var bitmap = new Bitmap(before.Client.Width, before.Client.Height, PixelFormat.Format32bppArgb))
            {
                using (var graphics = Graphics.FromImage(bitmap))
                    graphics.CopyFromScreen(before.Capture.Left, before.Capture.Top, 0, 0,
                                            new Size(bitmap.Width, bitmap.Height), CopyPixelOperation.SourceCopy);
                using (var memory = new MemoryStream())
                {
                    bitmap.Save(memory, ImageFormat.Png);
                    var bytes = memory.ToArray();
                    sha = QtHash(bytes);
                    using (var output = new FileStream(file, FileMode.CreateNew, FileAccess.Write, FileShare.None))
                        output.Write(bytes, 0, bytes.Length);
                }
            }
        }
        var after = QtLayoutBound();
        Need(QtSameBinding(before, after), "QT_BINDING_CHANGED");
        for (int index = 0; index < anchors.Count; index++)
            QtNeedAnchorPixels(anchors[index].Hash, QtHash(QtPixels(after, anchors[index].Rect)), "capture", index);
        var binding = Map(after.Report());
        binding["foreground"] = GetForegroundWindow() == after.Window;
        return Data("readOnly", true, "inputSent", false, "focusChanged", false, "authorizationGranted", false,
                    "binding", binding, "executableVersion", FileVersionInfo.GetVersionInfo(QtExecutable).FileVersion,
                    "pixelFormat", "rgba-row-major-opaque-v1", "regions", regions, "image",
                    file == null ? null : Data("file", file, "sha256", sha));
    }
    static bool QtLayoutExpectedMatches(Dictionary<string, object> expected, Dictionary<string, object> actual)
    {
        if (expected == null || actual == null || expected.Count != 6)
            return false;
        foreach (string key in new[] { "hwnd", "pid", "processCreatedFileTimeUtc", "dpi", "clientRect", "captureRect" })
            if (!expected.ContainsKey(key) || !actual.ContainsKey(key))
                return false;
        return Text(expected, "hwnd") == Text(actual, "hwnd") &&
               Number(Get(expected, "pid")) == Number(Get(actual, "pid")) &&
               Text(expected, "processCreatedFileTimeUtc") == Text(actual, "processCreatedFileTimeUtc") &&
               Number(Get(expected, "dpi")) == Number(Get(actual, "dpi")) &&
               Same(ParseRect(Get(expected, "clientRect")), ParseRect(Get(actual, "clientRect"))) &&
               Same(ParseRect(Get(expected, "captureRect")), ParseRect(Get(actual, "captureRect")));
    }
    // Capture only while the exact current target owns foreground. Restore is
    // attempted exactly once even after acquisition/capture fails. No result
    // escapes until cleanup confirms its original return/activity contract.
    static T[] QtLayoutPairTransaction<T>(Action acquire, Action guard, Func<T> capture, Action restore,
                                          Action<T> discard)
    {
        var samples = new List<T>();
        bool complete = false;
        try
        {
            try
            {
                acquire();
                guard();
                samples.Add(capture());
                guard();
                samples.Add(capture());
                guard();
            }
            finally
            {
                restore();
            }
            complete = true;
            return samples.ToArray();
        }
        finally
        {
            if (!complete)
                foreach (T sample in samples)
                    discard(sample);
        }
    }
    static object QtCaptureLayoutHandoff(Dictionary<string, object> request)
    {
        Need(QtEnableInput && !Stopping && QtFocus.Active == null && QtFocus.Parked == null && QtSurface == "main" &&
                 QtPopup == null && QtPendingPopup == null && QtPendingEnter == null,
             "QT_FOCUS_LEASE_UNAVAILABLE");
        var expected = Map(Get(request, "expectedBinding"));
        var inspected = Map(QtInspectLayout());
        Need(QtLayoutExpectedMatches(expected, Map(Get(inspected, "binding"))), "QT_BINDING_CHANGED");
        // QtBeginFocus below owns the bounded startup/idle wait. Rejecting a
        // just-started layout helper here would restart that wait forever.
        long idle = Number(Get(request, "idleMs"));
        Need(idle >= 0 && idle <= 300000, "QT_IDLE_INVALID");
        NoKeysHeld();
        long revision = Interlocked.Read(ref Revision);
        Rect client = ParseRect(Get(expected, "clientRect"));
        var expectedTarget = new WindowIdentity(new IntPtr(DecimalString(Get(expected, "hwnd"))),
                                                checked((uint)Number(Get(expected, "pid"))),
                                                DecimalString(Get(expected, "processCreatedFileTimeUtc")));
        var expectedFocus = new QtFocusLease { Return = QtFocusWindow(GetForegroundWindow()), Wechat = expectedTarget,
                                               Revision = revision };
        var begin = Data("idleMs", idle, "width", client.Width, "height", client.Height, "dpi",
                         Number(Get(expected, "dpi")), "includesContactNavigation", false);
        QtFocusLease lease = null;
        Binding bound = null;
        Dictionary<string, object> restored = null;
        var files = new List<string>();
        Bitmap[] samples = QtLayoutPairTransaction<Bitmap>(
            delegate {
                // No activation rectangle is supplied: unknown geometry must never
                // borrow stale coordinates or issue a guessed click into WeChat.
                QtBeginFocus(begin, revision, true, expectedFocus);
                lease = QtFocus.Active;
                bound = Snapshot(lease.Wechat.Window, QtExecutable);
                Need(QtLayoutExpectedMatches(expected, Map(bound.Report())), "QT_BINDING_CHANGED");
            },
            delegate {
                Need(lease != null && QtFocus.Active == lease, "QT_FOCUS_LEASE_UNAVAILABLE");
                QtFocusTransitionGuard(lease, revision, false);
                Need(GetForegroundWindow() == lease.Wechat.Window, "QT_FOCUS_TARGET_CHANGED");
                var actual = Snapshot(lease.Wechat.Window, QtExecutable);
                Need(QtSameBinding(bound, actual) && QtLayoutExpectedMatches(expected, Map(actual.Report())),
                     "QT_BINDING_CHANGED");
                QtNoOverlap(actual);
            },
            delegate {
                var bitmap = new Bitmap(bound.Client.Width, bound.Client.Height, PixelFormat.Format32bppArgb);
                try
                {
                    using (var graphics = Graphics.FromImage(bitmap))
                        graphics.CopyFromScreen(bound.Capture.Left, bound.Capture.Top, 0, 0,
                                                new Size(bitmap.Width, bitmap.Height), CopyPixelOperation.SourceCopy);
                    return bitmap;
                }
                catch
                {
                    bitmap.Dispose();
                    throw;
                }
            },
            delegate {
                // QtBeginFocus already cleans its failed acquisition. Only a
                // successful lease is ours to return, including during stop.
                if (lease == null)
                    return;
                QtFocus.TakeActive();
                restored = Map(QtRestoreFocus(lease, revision == Interlocked.Read(ref Revision)));
                if (revision != Interlocked.Read(ref Revision))
                {
                    var interrupted = new Fault("QT_HUMAN_ACTIVITY_CHANGED");
                    interrupted.Data["QtFocusRestoreOutcome"] = Get(restored, "focusRestoreOutcome");
                    QtMarkFocusTimingFailure(interrupted, lease);
                    throw interrupted;
                }
                QtNeedParkRestored(restored, revision == Interlocked.Read(ref Revision));
                Need(GetForegroundWindow() == lease.Return.Window, "QT_FOCUS_RETURN_UNCONFIRMED");
            },
            delegate(Bitmap sample) { sample.Dispose(); });
        try
        {
            var frames = new List<object>();
            var binding = Map(bound.Report());
            binding["foreground"] = true;
            // Encoding and filesystem writes run only after focus is returned.
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
                frames.Add(Data("readOnly", true, "inputSent", false, "focusChanged", true, "authorizationGranted",
                                false, "binding", binding, "executableVersion", Text(inspected, "executableVersion"),
                                "pixelFormat", "rgba-row-major-opaque-v1", "regions", new object[0], "image",
                                Data("file", file, "sha256", sha)));
            }
            return Data("version", 1, "mode", "focus-handoff-layout-pair-v1", "focusChanged", true, "inputSent",
                        InputAttempted, "chatInputSent", false, "clipboardAccessed", false, "authorizationGranted",
                        false, "restored", true, "activityUnchanged", true, "focusRestoreOutcome",
                        Get(restored, "focusRestoreOutcome"), "foregroundInterval", Get(restored, "foregroundInterval"),
                        "frames", frames);
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
    static int QtLayoutHandoffSelfTest()
    {
        int count = 0;
        var expected = Data("hwnd", "100", "pid", 2, "processCreatedFileTimeUtc", "123", "dpi", 120, "clientRect",
                            new Rect(0, 0, 1100, 900).Report(), "captureRect", new Rect(-1100, 0, 0, 900).Report());
        var actual = new Dictionary<string, object>(expected);
        actual.Add("foreground", true);
        Need(QtLayoutExpectedMatches(expected, actual), "QT_TEST_LAYOUT_CURRENT_GEOMETRY_ACCEPTED");
        count++;
        foreach (string key in new[] { "hwnd", "pid", "processCreatedFileTimeUtc", "dpi", "clientRect", "captureRect" })
        {
            var changed = new Dictionary<string, object>(actual);
            changed[key] = key == "hwnd" || key == "processCreatedFileTimeUtc" ? (object) "999"
                           : key == "clientRect" || key == "captureRect"       ? new Rect(0, 0, 800, 600).Report()
                                                                               : (object)999;
            Need(!QtLayoutExpectedMatches(expected, changed), "QT_TEST_LAYOUT_STALE_BINDING_REFUSED");
            count++;
        }
        var calls = new List<string>();
        int captures = 0;
        var pair = QtLayoutPairTransaction<string>(delegate { calls.Add("acquire"); }, delegate { calls.Add("guard"); },
                                                   delegate {
                                                       calls.Add("capture");
                                                       return (++captures).ToString();
                                                   },
                                                   delegate { calls.Add("restore"); },
                                                   delegate(string sample) { calls.Add("discard"); });
        Need(pair.Length == 2 && captures == 2 &&
                 String.Join(",", calls.ToArray()) == "acquire,guard,capture,guard,capture,guard,restore",
             "QT_TEST_LAYOUT_TWO_SAMPLES_THEN_ONE_RETURN");
        count++;
        foreach (string failure in new[] { "acquire", "guard", "capture", "restore" })
        {
            int discarded = 0, returns = 0, guards = 0, taken = 0;
            Expect(delegate {
                QtLayoutPairTransaction<string>(
                    delegate {
                        if (failure == "acquire")
                            throw new Fault("QT_HUMAN_ACTIVITY_CHANGED");
                    },
                    delegate {
                        if (++guards == 2 && failure == "guard")
                            throw new Fault("QT_HUMAN_ACTIVITY_CHANGED");
                    },
                    delegate {
                        if (++taken == 2 && failure == "capture")
                            throw new Fault("QT_HUMAN_ACTIVITY_CHANGED");
                        return "sample";
                    },
                    delegate {
                        returns++;
                        if (failure == "restore")
                            throw new Fault("QT_HUMAN_ACTIVITY_CHANGED");
                    },
                    delegate(string sample) { discarded++; });
            }, "QT_HUMAN_ACTIVITY_CHANGED");
            Need(returns == 1 && discarded == (failure == "acquire"   ? 0
                                               : failure == "restore" ? 2
                                                                      : 1),
                 "QT_TEST_LAYOUT_INTERRUPT_RETURNS_ONCE_DISCARDS_IMAGES");
            count++;
        }
        return count;
    }
    const long QtMonitorWarmupMs = 1000;
    static string QtIdleReason(long now, long lastActivity, long started, long revision, long minimum)
    {
        // Monitor startup history is separate from the configured user idle delay.
        if (revision == 0 && now - started < QtMonitorWarmupMs)
            return "QT_ACTIVITY_WARMUP";
        return now - lastActivity >= minimum ? null : "QT_USER_ACTIVE";
    }
    static void QtRequireIdle(long minimum)
    {
        string reason =
            QtIdleReason(Now(), Interlocked.Read(ref LastActivity), Interlocked.Read(ref ActivityMonitorStarted),
                         Interlocked.Read(ref Revision), minimum);
        Need(reason == null, reason);
    }
    static object QtInspectFocus(Dictionary<string, object> request)
    {
        long idle = Number(Get(request, "idleMs"));
        Need(idle >= 0 && idle <= 300000, "QT_IDLE_INVALID");
        int width = checked((int)Number(Get(request, "width"))), height = checked((int)Number(Get(request, "height"))),
            dpi = checked((int)Number(Get(request, "dpi")));
        QtFocus.TakeInspection();
        try
        {
            Need(!Stopping && QtFocus.Active == null, "QT_FOCUS_LEASE_UNAVAILABLE");
            Desktop();
            long revision = Interlocked.Read(ref Revision);
            QtRequireIdle(idle);
            NoKeysHeld();
            WindowIdentity prior = QtFocusWindow(GetForegroundWindow()), target = QtHandoffTarget(width, height, dpi);
            Need(GetForegroundWindow() == prior.Window && revision == Interlocked.Read(ref Revision),
                 "QT_HUMAN_ACTIVITY_CHANGED");
            QtFocus.RememberInspection(new QtFocusLease { Return = prior, Wechat = target, Revision = revision });
            QtCheckFocusPair(null, prior, target);
            return QtFocusInspectionResult(true, null, true);
        }
        catch (Fault error)
        {
            return QtFocusInspectionResult(false, error.Message, true);
        }
    }
    static object QtForegroundDiagnostic()
    {
        try
        {
            Desktop();
            IntPtr window = GetForegroundWindow();
            uint pid = 0;
            Need(window != IntPtr.Zero && GetWindowThreadProcessId(window, out pid) != 0, "QT_FOREGROUND_UNAVAILABLE");
            var name = new StringBuilder(257);
            Need(GetClassName(window, name, name.Capacity) > 0, "QT_FOREGROUND_UNAVAILABLE");
            string processName;
            using (var process = Process.GetProcessById(checked((int)pid))) processName = process.ProcessName;
            return Data("available", true, "pid", pid, "processName", processName, "className", name.ToString(),
                        "windowTitlesIncluded", false);
        }
        catch
        {
            return Data("available", false, "windowTitlesIncluded", false);
        }
    }
    static object QtFocusInspectionResult(bool ready, string reason, bool includeForeground = false)
    {
        long now = Now();
        var report =
            Data("ready", ready, "reason", reason, "inputSent", false, "clipboardAccessed", false, "focusChanged",
                 false, "idleMsObserved", Math.Max(0, now - Interlocked.Read(ref LastActivity)), "activityRevision",
                 Interlocked.Read(ref Revision), "monitorUptimeMs",
                 Math.Max(0, now - Interlocked.Read(ref ActivityMonitorStarted)), "inputActivityCounts",
                 ActivityObserved.Report());
        if (includeForeground)
            report.Add("foreground", QtForegroundDiagnostic());
        return report;
    }
    static object QtInspectFocusActivation(Dictionary<string, object> request)
    {
        Need(!Stopping && QtFocus.Active == null, "QT_FOCUS_LEASE_UNAVAILABLE");
        long idle = Number(Get(request, "idleMs"));
        Need(idle >= 0 && idle <= 300000, "QT_IDLE_INVALID");
        QtRequireIdle(idle);
        NoKeysHeld();
        Desktop();
        long revision = Interlocked.Read(ref Revision);
        int width = checked((int)Number(Get(request, "width"))), height = checked((int)Number(Get(request, "height"))),
            dpi = checked((int)Number(Get(request, "dpi")));
        Rect rect = ParseRect(Get(request, "rect"));
        Need(FocusActivationGeometry(rect, width), "DRAFT_FOCUS_CALIBRATION_INVALID");
        WindowIdentity target = QtHandoffTarget(width, height, dpi), source = QtFocusWindow(GetForegroundWindow());
        Need(source.Pid != target.Pid, "QT_FOCUS_INACTIVE_WINDOW_REQUIRED");
        Point origin = new Point(0, 0);
        Need(ClientToScreen(target.Window, ref origin), "DRAFT_GEOMETRY_UNAVAILABLE");
        Rect area = new Rect(origin.X + rect.Left, origin.Y + rect.Top, origin.X + rect.Right, origin.Y + rect.Bottom),
             client = new Rect(0, 0, width, height);
        Rect desktop = new Rect(GetSystemMetrics(76), GetSystemMetrics(77), GetSystemMetrics(76) + GetSystemMetrics(78),
                                GetSystemMetrics(77) + GetSystemMetrics(79));
        Need(Contains(desktop, area), "DRAFT_SCREEN_CHANGED");
        Action stable = delegate
        {
            Need(!Stopping && revision == Interlocked.Read(ref Revision), "QT_HUMAN_ACTIVITY_CHANGED");
            Desktop();
            NoKeysHeld();
            Need(GetForegroundWindow() == source.Window && WindowIdentity.Same(source, QtFocusWindow(source.Window)) &&
                     WindowIdentity.Same(target, QtHandoffTarget(width, height, dpi)),
                 "QT_FOCUS_TARGET_CHANGED");
            Point at = new Point(0, 0);
            Need(ClientToScreen(target.Window, ref at) && at.X == origin.X && at.Y == origin.Y,
                 "DRAFT_FOCUS_GEOMETRY_CHANGED");
            Need(FocusAreaOwned(area, target.Window, target.Pid), "DRAFT_FOCUS_REGION_OBSCURED");
        };
        stable();
        string hash = FocusPixels(area);
        Thread.Sleep(35);
        stable();
        Need(FocusPixels(area) == hash, "QT_PIXELS_CHANGED");
        stable();
        return Data("rect", rect.Report(), "rgbaSha256", hash, "stableObservations", 2, "readOnly", true, "inputSent",
                    false, "focusChanged", false, "clipboardAccessed", false, "binding",
                    Data("hwnd", target.Window.ToInt64().ToString(CultureInfo.InvariantCulture), "pid", target.Pid,
                         "processCreatedFileTimeUtc", target.Created.ToString(CultureInfo.InvariantCulture), "dpi", dpi,
                         "clientRect", client.Report(), "captureRect",
                         new Rect(origin.X, origin.Y, origin.X + width, origin.Y + height).Report(), "foreground",
                         false));
    }
    static object QtForegroundInterval(QtFocusLease lease, bool complete)
    {
        return lease != null && lease.ForegroundStarted > 0
                   ? Data("phase", lease.IncludesContactNavigation ? "contact-navigation" : "preparation", "durationMs",
                          Math.Max(0, Now() - lease.ForegroundStarted), "includesContactNavigation",
                          lease.IncludesContactNavigation, "complete", complete)
                   : null;
    }
    static object QtFocusRestoreReport(Dictionary<string, object> report, QtFocusLease lease, bool complete)
    {
        object interval = QtForegroundInterval(lease, complete);
        if (interval != null)
            report.Add("foregroundInterval", interval);
        return report;
    }
    static void QtMarkFocusTimingFailure(Exception error, QtFocusLease lease)
    {
        object interval = QtForegroundInterval(lease, false);
        if (interval != null)
            error.Data["QtForegroundInterval"] = interval;
    }
    static object QtFocusTimingFailure(Exception error)
    {
        return error.Data.Contains("QtForegroundInterval") ? error.Data["QtForegroundInterval"] : null;
    }
    static object QtFocusRestoreFailure(Exception error)
    {
        return error.Data.Contains("QtFocusRestoreOutcome") ? error.Data["QtFocusRestoreOutcome"] : null;
    }
    // Observe the existing return checks once, in their original order. Null
    // means a check was not completed, never a guessed false/true result.
    static Dictionary<string, object> QtRestoreOutcome(string reason, bool? restored, bool? skipped, bool? foreground,
                                                       bool? identities, bool? activity, bool? keys,
                                                       bool? parkRevision = null)
    {
        return Data("version", 1, "reason", reason, "restored", restored, "skipped", skipped, "foregroundOwnedByWechat",
                    foreground, "identitiesUnchanged", identities, "activityUnchanged", activity, "keysReleased", keys,
                    "parkRevisionUnchanged", parkRevision);
    }
    static string QtRestoreSkipReason(bool foreground, bool identities, bool activity, bool keys)
    {
        return !foreground   ? "foreground-not-wechat"
               : !identities ? "identity-changed"
               : !activity   ? "activity-changed"
               : !keys       ? "keys-held"
                             : "conditions-satisfied";
    }
    static long QtReturnActivityRevision(QtFocusLease lease, long current)
    {
        Need(lease != null && lease.Revision == current, "QT_HUMAN_ACTIVITY_CHANGED");
        return lease.Revision;
    }
    static long QtBeginActivityRevision(long? required, long current)
    {
        Need(!required.HasValue || required.Value == current, "QT_HUMAN_ACTIVITY_CHANGED");
        return required.HasValue ? required.Value : current;
    }
    static bool QtTransferredUnchanged(long expectedTick, uint currentTick, long baseline, long current)
    {
        return expectedTick == currentTick && baseline == current;
    }
    static bool QtTransferredFresh(long issued, long now)
    {
        return issued > 0 && now >= issued && now - issued <= 30000;
    }
    static void QtTransferredGuard(QtFocusLease lease)
    {
        if (!lease.TransferredInputTick.HasValue)
            return;
        Need(QtTransferredFresh(lease.TransferredIssuedAt, UtcMs()), "QT_FOCUS_LEASE_EXPIRED");
        // Until our single caption click is committed, the transfer token must
        // still match Windows' input tick, including the old/new-helper gap.
        // Afterwards its own marked mouse events may advance that tick; the
        // continuously running physical-input epoch remains mandatory.
        if (!lease.ReturnCaptionAttempted)
            Need(QtTransferredUnchanged(lease.TransferredInputTick.Value, QtInputTick(), lease.Revision,
                                        Interlocked.Read(ref Revision)),
                 "QT_HUMAN_ACTIVITY_CHANGED");
    }
    static void QtNeedParkRestored(Dictionary<string, object> report, bool? revisionUnchanged)
    {
        if (Object.Equals(Get(report, "restored"), true) && revisionUnchanged == true)
            return;
        var error = new Fault("QT_FOCUS_RETURN_UNCONFIRMED");
        var origin = Map(Get(report, "focusRestoreOutcome"));
        if (origin != null)
        {
            var outcome = new Dictionary<string, object>(origin);
            outcome["parkRevisionUnchanged"] = revisionUnchanged;
            if (Object.Equals(Get(report, "restored"), true))
                outcome["reason"] = "park-activity-changed";
            error.Data["QtFocusRestoreOutcome"] = outcome;
        }
        var interval = Map(Get(report, "foregroundInterval"));
        if (interval != null)
        {
            var incomplete = new Dictionary<string, object>(interval);
            incomplete["complete"] = false;
            error.Data["QtForegroundInterval"] = incomplete;
        }
        throw error;
    }
    static object QtRestoreFocus(QtFocusLease lease, bool unchanged)
    {
        if (lease == null)
            return Data("restored", false, "skipped", true, "focusRestoreOutcome",
                        QtRestoreOutcome("lease-absent", false, true, null, null, null, null));
        if (lease.InPlace)
            return QtReleaseForegroundSession(lease, unchanged);
        bool? foreground = null, identities = null, keys = null, restored = null;
        string stage = "foreground-check-failed";
        try
        {
            foreground = QtOwnedPopup(GetForegroundWindow(), lease.Wechat.Window);
            uint currentPid;
            if (!foreground.Value &&
                (GetWindowThreadProcessId(lease.Wechat.Window, out currentPid) == 0 || currentPid != lease.Wechat.Pid))
                return QtFocusRestoreReport(
                    Data("restored", false, "skipped", true, "focusRestoreOutcome",
                         QtRestoreOutcome("foreground-not-wechat", false, true, false, false, unchanged, null)),
                    lease, false);
            stage = "identity-check-failed";
            identities = WindowIdentity.Same(lease.Return, QtFocusWindow(lease.Return.Window)) &&
                         WindowIdentity.Same(lease.Wechat, QtFocusWindow(lease.Wechat.Window, QtExecutable, true));
            stage = "keys-check-failed";
            keys = QtKeysReleased();
            if (!QtCanRestore(foreground.Value, identities.Value, unchanged, keys.Value))
                return QtFocusRestoreReport(
                    Data(
                        "restored", false, "skipped", true, "focusRestoreOutcome",
                        QtRestoreOutcome(QtRestoreSkipReason(foreground.Value, identities.Value, unchanged, keys.Value),
                                         false, true, foreground, identities, unchanged, keys)),
                    lease, false);
            stage = "restore-confirmation-failed";
            Need(!lease.ReturnCaptionAttempted, "QT_RETURN_CAPTION_ALREADY_ATTEMPTED");
            long revision = QtReturnActivityRevision(lease, Interlocked.Read(ref Revision));
            IntPtr source = GetForegroundWindow();
            Need(QtOwnedPopup(source, lease.Wechat.Window), "QT_FOCUS_RETURN_UNCONFIRMED");
            long returnDeadline = Now() + 400;
            var result = ConfirmFocusOnce(
                source, lease.Return.Window,
                delegate { return QtActivateReturnOnce(lease, source, revision, returnDeadline); },
                delegate { QtFocusTransitionGuard(lease, revision, true); }, GetForegroundWindow, Now, Thread.Sleep);
            NeedFocusConfirmed(result, "QT_FOCUS_RETURN_UNCONFIRMED");
            restored = true;
            stage = "pointer-restore-failed";
            bool pointerRestored = QtRestorePointer(lease, lease.Return.Window);
            var report = Data("restored", true, "skipped", false, "pointerRestored", pointerRestored,
                              "focusConfirmation", result.Report(), "focusRestoreOutcome",
                              QtRestoreOutcome("restored", true, false, foreground, identities, unchanged, keys));
            return QtFocusRestoreReport(report, lease, true);
        }
        catch (Exception error)
        {
            error.Data["QtFocusRestoreOutcome"] =
                QtRestoreOutcome(stage, restored, false, foreground, identities, unchanged, keys);
            QtMarkFocusTimingFailure(error, lease);
            throw;
        }
        finally
        {
            QtCurrent = null;
        }
    }
    static void QtFocusTransitionGuard(QtFocusLease lease, long revision, bool restoring)
    {
        if (!restoring)
            Need(!Stopping, "QT_STOPPING");
        QtTransferredGuard(lease);
        Need(Interlocked.Read(ref Revision) == revision, "QT_HUMAN_ACTIVITY_CHANGED");
        NoKeysHeld();
        if (lease.InPlace)
        {
            Need(QtForegroundSessionMatches(lease, QtFocusWindow(lease.Wechat.Window, QtExecutable),
                                            GetForegroundWindow(), revision),
                 "QT_FOCUS_TARGET_CHANGED");
            return;
        }
        Need(WindowIdentity.Same(lease.Return, QtFocusWindow(lease.Return.Window)) &&
                 WindowIdentity.Same(lease.Wechat, QtFocusWindow(lease.Wechat.Window, QtExecutable, restoring)),
             "QT_FOCUS_TARGET_CHANGED");
        // Caption geometry is checked only if its mouse fallback is used.
        QtTransferredGuard(lease);
        Need(Interlocked.Read(ref Revision) == revision, "QT_HUMAN_ACTIVITY_CHANGED");
        NoKeysHeld();
    }

    static object QtFocusVisibilityFailure(Exception error)
    {
        return error.Data.Contains("QtFocusVisibility") ? error.Data["QtFocusVisibility"] : null;
    }
    static FocusVisibilityObservation QtConfirmVisibilityOnce(Action guard, Func<int> blocking, Func<bool> raise,
                                                              Func<long> clock, Action<int> wait,
                                                              bool priorRaise = false, bool? priorAccepted = null)
    {
        return FocusConfirmVisibilityOnce(guard, blocking, raise, clock, wait, priorRaise, priorAccepted,
                                          "QtFocusVisibility");
    }
    static bool QtRaiseGuiClear(uint flags, IntPtr capture)
    {
        return (flags & 0x1e) == 0 && capture == IntPtr.Zero;
    }
    static bool QtRaiseBindingMatches(Binding before, Binding actual, uint originalThread, Rect window,
                                      Rect currentWindow)
    {
        return originalThread != 0 && actual.Thread == originalThread && before.Thread == actual.Thread &&
               QtSameBinding(before, actual) && Same(window, currentWindow);
    }
    static void QtMarkTargetRaise(QtFocusLease lease)
    {
        Need(lease != null && !lease.TargetRaiseAttempted, "QT_FOCUS_RAISE_ALREADY_ATTEMPTED");
        lease.TargetRaiseAttempted = true;
    }
    static object QtAfterActivationReady(bool uia, Action controlGuard, Func<object> visibility)
    {
        // A UIA operation does not need every pixel of the window exposed.
        // Null means visibility was not sampled, never a fabricated zero count.
        if (uia)
        {
            controlGuard();
            return null;
        }
        return visibility();
    }
    static bool QtUiaActivatedBinding(Binding expected, Binding actual)
    {
        return expected != null && actual != null && actual.Thread == expected.Thread &&
               QtSameBinding(expected, actual) && actual.FocusOwned && (actual.GuiFlags & 0x1e) == 0;
    }
    static void QtEnsureUiaTargetFocus(QtFocusLease lease, Binding bound)
    {
        Need(lease != null && lease.UiaMode && Object.ReferenceEquals(QtFocus.Active, lease) && QtEnableInput &&
                 QtSurface == "main" && QtPopup == null && QtPendingPopup == null,
             "QT_FOCUS_TARGET_CHANGED");
        QtFocusTransitionGuard(lease, lease.Revision, false);
        var actual = Snapshot(lease.Wechat.Window, QtExecutable);
        Need(QtUiaActivatedBinding(bound, actual), "QT_FOCUS_UNAVAILABLE");
        QtFocusTransitionGuard(lease, lease.Revision, false);
        Need(GetForegroundWindow() == lease.Wechat.Window, "QT_FOCUS_TARGET_CHANGED");
    }
    static object QtEnsureTargetVisible(QtFocusLease lease, Binding bound, FocusConfirmation confirmation)
    {
        long revision = lease.Revision;
        Rect desktop = QtDesktopRect(), window = new Rect();
        Need(GetWindowRect(lease.Wechat.Window, out window), "QT_FOCUS_TARGET_CHANGED");
        uint expectedReturnPid;
        uint expectedReturnThread = GetWindowThreadProcessId(lease.Return.Window, out expectedReturnPid);
        Need(expectedReturnThread != 0 && expectedReturnPid == lease.Return.Pid, "QT_FOCUS_TARGET_CHANGED");
        var activation = Map(confirmation.Activation);
        bool priorRaise = Object.Equals(Get(activation, "calibratedRaiseAttempted"), true);
        bool? priorAccepted =
            priorRaise ? (bool?)Object.Equals(Get(activation, "calibratedRaiseAccepted"), true) : null;
        if (priorRaise)
            QtMarkTargetRaise(lease);
        Action guard = delegate
        {
            Need(QtFocus.Active == lease && QtEnableInput && QtSurface == "main" && QtPopup == null &&
                     QtPendingPopup == null,
                 "QT_FOCUS_TARGET_CHANGED");
            QtFocusTransitionGuard(lease, revision, false);
            Need(GetForegroundWindow() == lease.Wechat.Window && GetWindow(lease.Wechat.Window, 4) == IntPtr.Zero &&
                     GetAncestor(lease.Wechat.Window, 3) == lease.Wechat.Window &&
                     (GetWindowLongPtr(lease.Wechat.Window, -20).ToInt64() & 8) == 0,
                 "QT_FOCUS_TARGET_CHANGED");
            Binding actual = Snapshot(lease.Wechat.Window, QtExecutable);
            Rect currentWindow;
            Need(GetWindowRect(lease.Wechat.Window, out currentWindow) &&
                     QtRaiseBindingMatches(bound, actual, bound.Thread, window, currentWindow) && actual.FocusOwned &&
                     Same(desktop, QtDesktopRect()),
                 "QT_BINDING_CHANGED");
            var displays = new List<Rect>();
            foreach (Screen screen in Screen.AllScreens)
            {
                Rectangle area = screen.Bounds;
                displays.Add(new Rect(area.Left, area.Top, area.Right, area.Bottom));
            }
            Need(QtCoveredByDisplays(actual.Capture, displays), "QT_WINDOW_OUTSIDE_DISPLAY");
            uint returnPid;
            uint returnThread = GetWindowThreadProcessId(lease.Return.Window, out returnPid);
            Need(returnThread == expectedReturnThread && returnPid == lease.Return.Pid, "QT_FOCUS_TARGET_CHANGED");
            foreach (uint thread in new[] { actual.Thread, returnThread })
            {
                FocusThreadReady(thread);
                var gui = new GuiInfo { Size = (uint)Marshal.SizeOf(typeof(GuiInfo)) };
                Need(GetGUIThreadInfo(thread, ref gui) && QtRaiseGuiClear(gui.Flags, gui.Capture),
                     "QT_FOCUS_UNAVAILABLE");
            }
            QtFocusTransitionGuard(lease, revision, false);
            Need(GetForegroundWindow() == lease.Wechat.Window, "QT_FOCUS_TARGET_CHANGED");
        };
        var result = QtConfirmVisibilityOnce(
            guard, delegate { return checked((int)Number(Get(QtOverlapReport(bound), "blockingCount"))); },
            delegate {
                QtMarkTargetRaise(lease);
                return FocusSetWindowPos(lease.Wechat.Window, IntPtr.Zero, 0, 0, 0, 0, 0x4213);
            },
            Now, Thread.Sleep, priorRaise, priorAccepted);
        if (!result.Confirmed)
        {
            var error = new Fault("QT_WINDOW_OBSCURED");
            error.Data["QtFocusVisibility"] = result.Report();
            throw error;
        }
        return result.Report();
    }
    static int QtFocusVisibilitySelfTest()
    {
        int count = 0, raises = 0, samples = 0, guards = 0;
        long clock = 0;
        Action guard = delegate
        {
            guards++;
        };
        Action<int> wait = delegate(int ms)
        {
            clock += ms;
        };
        Func<bool> raise = delegate
        {
            raises++;
            return true;
        };
        var source = new WindowIdentity(new IntPtr(1), 10, 100);
        var main = new WindowIdentity(new IntPtr(2), 20, 200);
        var other = new WindowIdentity(new IntPtr(3), 30, 300);
        var auxiliary = new WindowIdentity(new IntPtr(4), 20, 200);
        var expected = new QtFocusLease { Return = source, Wechat = main };
        QtCheckFocusPair(expected, source, main);
        Expect(delegate { QtCheckFocusPair(expected, other, main); }, "QT_FOCUS_TARGET_CHANGED");
        Expect(delegate { QtCheckFocusPair(expected, source, new WindowIdentity(main.Window, main.Pid, 999)); },
               "QT_FOCUS_TARGET_CHANGED");
        Expect(delegate { QtCheckFocusPair(null, main, main); }, "QT_FOCUS_RETURN_WINDOW_REQUIRED");
        Expect(delegate { QtCheckFocusPair(null, auxiliary, main); }, "QT_FOCUS_WECHAT_AUXILIARY_ACTIVE");
        count += 5;
        Func<IntPtr, uint> pid = delegate(IntPtr w)
        {
            return w == other.Window ? other.Pid : main.Pid;
        };
        Need(QtOwnedPopupChain(auxiliary.Window, main.Window, main.Pid, pid, delegate { return main.Window; }) &&
                 !QtOwnedPopupChain(other.Window, main.Window, main.Pid, pid, delegate { return main.Window; }) &&
                 !QtOwnedPopupChain(auxiliary.Window, main.Window, main.Pid, pid,
                                    delegate(IntPtr w) { return w == auxiliary.Window ? other.Window : main.Window; }),
             "QT_TEST_RETURN_ONLY_FROM_OWN_PROCESS_POPUP_CHAIN");
        count++;
        var result = QtConfirmVisibilityOnce(guard,
                                             delegate {
                                                 samples++;
                                                 return 0;
                                             },
                                             raise, delegate { return clock; }, wait);
        Need(result.Confirmed && !result.RaiseAttempted && raises == 0 && samples == 1 && guards == 2 &&
                 result.Reason == "already-visible",
             "QT_TEST_VISIBLE_TARGET_NEVER_RAISED");
        count++;
        raises = samples = guards = 0;
        clock = 0;
        result = QtConfirmVisibilityOnce(guard, delegate { return ++samples < 3 ? 2 : 0; }, raise,
                                         delegate { return clock; }, wait);
        Need(result.Confirmed && result.RaiseAttempted && result.RequestAccepted == true && raises == 1 &&
                 samples == 3 && clock == 10,
             "QT_TEST_RAISE_ONCE_THEN_FULL_OVERLAP_RECHECK");
        count++;
        raises = samples = guards = 0;
        clock = 0;
        result = QtConfirmVisibilityOnce(guard, delegate { return ++samples == 1 ? 1 : 0; },
                                         delegate {
                                             raises++;
                                             return false;
                                         },
                                         delegate { return clock; }, wait);
        Need(result.Confirmed && result.RequestAccepted == false && raises == 1 && result.LastBlockingCount == 0,
             "QT_TEST_FALSE_RAISE_REQUIRES_ACTUAL_VISIBLE_STATE");
        count++;
        raises = samples = guards = 0;
        clock = 0;
        result = QtConfirmVisibilityOnce(guard,
                                         delegate {
                                             samples++;
                                             return 2;
                                         },
                                         delegate {
                                             raises++;
                                             return false;
                                         },
                                         delegate { return clock; }, wait);
        Need(!result.Confirmed && raises == 1 && clock == 250 && result.Reason == "timeout" &&
                 result.LastBlockingCount == 2,
             "QT_TEST_BLOCKED_RAISE_STOPS_WITHOUT_RETRY");
        count++;
        raises = guards = 0;
        clock = 0;
        Expect(delegate {
            QtConfirmVisibilityOnce(
                delegate {
                    if (++guards == 3)
                        throw new Fault("QT_HUMAN_ACTIVITY_CHANGED");
                },
                delegate { return 1; }, raise, delegate { return clock; }, wait);
        }, "QT_HUMAN_ACTIVITY_CHANGED");
        Need(raises == 0, "QT_TEST_ACTIVITY_BEFORE_RAISE_PREVENTS_REQUEST");
        count++;
        raises = guards = 0;
        clock = 0;
        Expect(delegate {
            QtConfirmVisibilityOnce(
                delegate {
                    if (++guards == 4)
                        throw new Fault("QT_HUMAN_ACTIVITY_CHANGED");
                },
                delegate { return 1; }, raise, delegate { return clock; }, wait);
        }, "QT_HUMAN_ACTIVITY_CHANGED");
        Need(raises == 1, "QT_TEST_ACTIVITY_AFTER_RAISE_STOPS_READINESS_WITHOUT_RETRY");
        count++;
        raises = samples = guards = 0;
        clock = 0;
        result = QtConfirmVisibilityOnce(
            delegate {
                if (++guards == 5)
                    clock = 251;
            },
            delegate { return ++samples == 1 ? 1 : 0; }, raise, delegate { return clock; }, wait);
        Need(!result.Confirmed && raises == 1 && result.Reason == "timeout",
             "QT_TEST_SLOW_FINAL_GUARD_CANNOT_CONFIRM_LATE_VISIBILITY");
        count++;
        raises = samples = guards = 0;
        clock = 0;
        result = QtConfirmVisibilityOnce(guard, delegate { return ++samples < 3 ? 1 : 0; }, raise,
                                         delegate { return clock; }, wait, true, true);
        Need(result.Confirmed && result.RaiseAttempted && result.RequestAccepted == true && raises == 0 && samples == 3,
             "QT_TEST_COMMON_CALIBRATED_RAISE_IS_NOT_REPEATED_BY_QT");
        count++;
        var lease = new QtFocusLease();
        QtMarkTargetRaise(lease);
        Expect(delegate { QtMarkTargetRaise(lease); }, "QT_FOCUS_RAISE_ALREADY_ATTEMPTED");
        Need(lease.TargetRaiseAttempted, "QT_TEST_TARGET_RAISE_LATCH");
        count++;
        Need(QtRaiseGuiClear(0, IntPtr.Zero) && !QtRaiseGuiClear(4, IntPtr.Zero) && !QtRaiseGuiClear(0, new IntPtr(1)),
             "QT_TEST_RAISE_REFUSES_MODAL_OR_MOUSE_CAPTURE");
        count++;
        var original = new Binding { Window = new IntPtr(1),
                                     Pid = 2,
                                     Created = 3,
                                     Thread = 4,
                                     Dpi = 120,
                                     Client = new Rect(0, 0, 800, 600),
                                     Capture = new Rect(100, 100, 900, 700) };
        var current = new Binding {
            Window = original.Window, Pid = original.Pid,        Created = original.Created, Thread = 4, Dpi = 120,
            Client = original.Client, Capture = original.Capture
        };
        Rect window = new Rect(90, 90, 910, 710);
        Need(QtRaiseBindingMatches(original, current, 4, window, window) &&
                 !QtRaiseBindingMatches(original, current, 5, window, window) &&
                 !QtRaiseBindingMatches(original, current, 4, window, new Rect(89, 90, 910, 710)),
             "QT_TEST_RAISE_ORIGINAL_THREAD_AND_OUTER_GEOMETRY_FROZEN");
        count++;
        int controlGuards = 0, visibilityCalls = 0;
        object observation = new object();
        Need(QtAfterActivationReady(true, delegate { controlGuards++; },
                                    delegate {
                                        visibilityCalls++;
                                        return observation;
                                    }) == null &&
                 controlGuards == 1 && visibilityCalls == 0,
             "QT_TEST_UIA_ACTIVATION_NO_VISIBILITY_QUERY_OR_CLAIM");
        count++;
        Need(Object.ReferenceEquals(QtAfterActivationReady(false, delegate { controlGuards++; },
                                                           delegate {
                                                               visibilityCalls++;
                                                               return observation;
                                                           }),
                                    observation) &&
                 controlGuards == 1 && visibilityCalls == 1,
             "QT_TEST_PIXEL_ACTIVATION_KEEPS_VISIBILITY_PATH");
        count++;
        Expect(delegate {
            QtAfterActivationReady(true, delegate { throw new Fault("QT_HUMAN_ACTIVITY_CHANGED"); },
                                   delegate {
                                       visibilityCalls++;
                                       return observation;
                                   });
        }, "QT_HUMAN_ACTIVITY_CHANGED");
        Need(visibilityCalls == 1, "QT_TEST_UIA_ACTIVATION_GUARD_FAILURE_NO_FALLBACK");
        count++;
        original.FocusOwned = true;
        current.FocusOwned = true;
        Need(QtUiaActivatedBinding(original, current), "QT_TEST_UIA_ACTIVATION_BOUND_FOCUS");
        count++;
        current.FocusOwned = false;
        Need(!QtUiaActivatedBinding(original, current), "QT_TEST_UIA_ACTIVATION_OWNED_FOCUS_REQUIRED");
        current.FocusOwned = true;
        current.GuiFlags = 4;
        Need(!QtUiaActivatedBinding(original, current), "QT_TEST_UIA_ACTIVATION_MODAL_REFUSED");
        current.GuiFlags = 0;
        current.Thread++;
        Need(!QtUiaActivatedBinding(original, current), "QT_TEST_UIA_ACTIVATION_THREAD_BOUND");
        count += 3;
        return count;
    }
    static object QtBeginFocus(Dictionary<string, object> request, long? requiredRevision = null,
                               bool allowOverlappedReturn = false, QtFocusLease expected = null)
    {
        bool uiaCaption = QtUiaCaptionRequested(request);
        Need(QtEnableInput && !Stopping && QtFocus.Active == null && QtFocus.Parked == null,
             "QT_FOCUS_LEASE_UNAVAILABLE");
        long idle = Number(Get(request, "idleMs"));
        Need(idle >= 0 && idle <= 300000, "QT_IDLE_INVALID");
        long revision = QtBeginActivityRevision(requiredRevision, Interlocked.Read(ref Revision)),
             end = Now() + Math.Max(idle, QtMonitorWarmupMs);
        while (QtIdleReason(Now(), Interlocked.Read(ref LastActivity), Interlocked.Read(ref ActivityMonitorStarted),
                            Interlocked.Read(ref Revision), idle) != null)
        {
            Need(!Stopping && revision == Interlocked.Read(ref Revision), "QT_USER_ACTIVE");
            Need(Now() <= end, "QT_USER_ACTIVE");
            Thread.Sleep(10);
        }
        NoKeysHeld();
        WindowIdentity prior = QtFocusWindow(GetForegroundWindow());
        int width = checked((int)Number(Get(request, "width"))), height = checked((int)Number(Get(request, "height"))),
            dpi = checked((int)Number(Get(request, "dpi")));
        WindowIdentity target = QtHandoffTarget(width, height, dpi);
        QtCheckFocusPair(expected, prior, target);
        Need(GetForegroundWindow() == prior.Window && revision == Interlocked.Read(ref Revision),
             "QT_HUMAN_ACTIVITY_CHANGED");
        NoKeysHeld();
        Point originalPointer;
        Need(FocusGetCursorPos(out originalPointer), "QT_POINTER_UNAVAILABLE");
        Need(GetForegroundWindow() == prior.Window && revision == Interlocked.Read(ref Revision),
             "QT_HUMAN_ACTIVITY_CHANGED");
        NoKeysHeld();
        if (request.ContainsKey("includesContactNavigation"))
            Need(Get(request, "includesContactNavigation") is bool, "QT_FOCUS_LEASE_INVALID");
        var candidateLease =
            new QtFocusLease { Return = prior,
                               Wechat = target,
                               Revision = revision,
                               RequiredIdle = idle,
                               UiaMode = uiaCaption,
                               Activation = ParseFocusActivation(Get(request, "focusActivation"), width),
                               OriginalPointer = originalPointer,
                               PointerSaved = true,
                               IncludesContactNavigation =
                                   Object.Equals(Get(request, "includesContactNavigation"), true),
                               AllowOverlappedReturn = allowOverlappedReturn };
        // Win32 restoration is bound to the source HWND/PID/creation time.
        // A measurable caption is an optional fallback, never a prerequisite.
        string returnCaptionRefusal = null;
        candidateLease.ReturnCaption =
            QtOptionalReturnCaption(delegate { return QtCaptureReturnCaption(candidateLease, revision); },
                                    delegate {
                                        QtFocusTransitionGuard(candidateLease, revision, false);
                                        Need(GetForegroundWindow() == prior.Window, "QT_FOCUS_TARGET_CHANGED");
                                    },
                                    delegate(string reason) { returnCaptionRefusal = reason; });
        candidateLease.ForegroundStarted = Now();
        QtFocus.Acquire(candidateLease);
        try
        {
            Action finishExposure = null;
            var confirmation = ConfirmFocusOnce(
                prior.Window, target.Window,
                delegate {
                    if (uiaCaption)
                        return QtActivateUiaCaptionOnce(QtFocus.Active, action => finishExposure = action);
                    bool accepted = ActivateForegroundOnce(prior.Window, target.Window, delegate {
                        QtFocusTransitionGuard(QtFocus.Active, revision, false);
                    }, QtFocus.Active.Activation);
                    return accepted ||
                           allowOverlappedReturn && GetForegroundWindow() == prior.Window &&
                               ActivateBoundWechatForegroundOnce(prior.Window, target.Window, QtExecutable, delegate {
                                   QtFocusTransitionGuard(QtFocus.Active, revision, false);
                               });
                },
                delegate { QtFocusTransitionGuard(QtFocus.Active, revision, false); }, GetForegroundWindow, Now,
                Thread.Sleep,
                delegate {
                    if (finishExposure != null)
                        finishExposure();
                });
            NeedFocusConfirmed(confirmation, "QT_FOCUS_ACQUIRE_UNCONFIRMED");
            Need(revision == Interlocked.Read(ref Revision), "QT_HUMAN_ACTIVITY_CHANGED");
            Binding bound = Snapshot(target.Window, QtExecutable);
            Need(bound.Pid == target.Pid && bound.Created == target.Created && bound.Client.Width == width &&
                     bound.Client.Height == height && bound.Dpi == dpi,
                 "QT_FOCUS_TARGET_CHANGED");
            object visibility =
                QtAfterActivationReady(uiaCaption, delegate { QtEnsureUiaTargetFocus(QtFocus.Active, bound); },
                                       delegate { return QtEnsureTargetVisible(QtFocus.Active, bound, confirmation); });
            QtWindow = target.Window;
            QtRoot = target;
            QtCurrent = null;
            return Data("focusHandoff", QtFocus.Active.Handoff(), "activated", true, "focusConfirmation",
                        confirmation.Report(), "focusVisibility", visibility, "returnCaptionFallback",
                        Data("optional", true, "available", QtFocus.Active.ReturnCaption != null, "reason",
                             returnCaptionRefusal));
        }
        catch (Exception error)
        {
            QtFocusLease lease = QtFocus.TakeActive();
            try
            {
                var restored = Map(QtRestoreFocus(lease, revision == Interlocked.Read(ref Revision)));
                if (Get(restored, "focusRestoreOutcome") != null)
                    error.Data["QtFocusRestoreOutcome"] = Get(restored, "focusRestoreOutcome");
            }
            catch (Exception cleanupError)
            {
                var outcome = QtFocusRestoreFailure(cleanupError);
                if (outcome != null)
                    error.Data["QtFocusRestoreOutcome"] = outcome;
            }
            QtMarkFocusTimingFailure(error, lease);
            throw;
        }
    }
    static object QtParkFocus()
    {
        QtRequireTransferableLease(QtFocus.Active);
        Need(QtEnableInput && !Stopping && QtFocus.Active != null && QtFocus.Parked == null && QtSurface == "main" &&
                 QtPopup == null && QtPendingPopup == null,
             "QT_FOCUS_PARK_UNAVAILABLE");
        var lease = QtFocus.Active;
        QtFocusTransitionGuard(lease, lease.Revision, false);
        Need(GetForegroundWindow() == lease.Wechat.Window, "QT_FOCUS_TARGET_CHANGED");
        var binding = Snapshot(lease.Wechat.Window, QtExecutable);
        var report = Map(QtRestoreFocus(lease, lease.Revision == Interlocked.Read(ref Revision)));
        QtFocus.TakeActive();
        bool? parkRevision = Object.Equals(Get(report, "restored"), true)
                                 ? (bool?)(lease.Revision == Interlocked.Read(ref Revision))
                                 : null;
        QtNeedParkRestored(report, parkRevision);
        QtFocus.ParkAfterRestore(lease, binding);
        report.Add("parked", true);
        return report;
    }
    static object QtResumeFocus(Dictionary<string, object> request)
    {
        Need(QtEnableInput && !Stopping && QtFocus.Active == null && QtFocus.Parked != null,
             "QT_FOCUS_PARK_UNAVAILABLE");
        var parked = QtFocus.Parked;
        var previous = parked.Lease;
        var binding = parked.Binding;
        Need(Now() - parked.At <= 30000 && previous.Revision == Interlocked.Read(ref Revision),
             "QT_HUMAN_ACTIVITY_CHANGED");
        QtFocusTransitionGuard(previous, previous.Revision, false);
        Need(GetForegroundWindow() == previous.Return.Window, "QT_FOCUS_TARGET_CHANGED");
        Rect client;
        Point origin = new Point(0, 0);
        Need(GetClientRect(previous.Wechat.Window, out client) && ClientToScreen(previous.Wechat.Window, ref origin) &&
                 Same(client, binding.Client) && origin.X == binding.Capture.Left && origin.Y == binding.Capture.Top &&
                 GetDpiForWindow(previous.Wechat.Window) == binding.Dpi,
             "QT_BINDING_CHANGED");
        var begin = Data("idleMs", previous.RequiredIdle, "width", binding.Client.Width, "height",
                         binding.Client.Height, "dpi", binding.Dpi, "includesContactNavigation",
                         Object.Equals(Get(request, "includesContactNavigation"), true));
        if (previous.UiaMode)
            begin.Add("uiaCaptionActivation", true);
        else if (previous.Activation != null)
            begin.Add("focusActivation", previous.Activation.Report());
        QtFocus.DiscardParked();
        var result = Map(QtBeginFocus(begin, previous.Revision, false, previous));
        result.Add("resumed", true);
        return result;
    }
    static object QtTransferFocus()
    {
        QtRequireTransferableLease(QtFocus.Active);
        QtEmptyPhaseProof = null;
        Need(QtFocus.Active != null && QtEnableInput && !Stopping, "QT_FOCUS_LEASE_UNAVAILABLE");
        QtFocusLease lease = QtFocus.Active;
        Need(GetForegroundWindow() == lease.Wechat.Window && lease.Revision == Interlocked.Read(ref Revision),
             "QT_HUMAN_ACTIVITY_CHANGED");
        NoKeysHeld();
        Need(WindowIdentity.Same(lease.Return, QtFocusWindow(lease.Return.Window)) &&
                 WindowIdentity.Same(lease.Wechat, QtFocusWindow(lease.Wechat.Window, QtExecutable)),
             "QT_FOCUS_TARGET_CHANGED");
        // Finish Qt's mouse ownership before passing the existing window-only
        // lease to another process; no cursor state is trusted across helpers.
        bool pointerRestored = QtRestorePointer(lease, lease.Wechat.Window);
        QtFocusTransitionGuard(lease, lease.Revision, false);
        Need(GetForegroundWindow() == lease.Wechat.Window, "QT_FOCUS_TARGET_CHANGED");
        uint finalInputTick = QtInputTick();
        QtFocusTransitionGuard(lease, lease.Revision, false);
        Need(GetForegroundWindow() == lease.Wechat.Window, "QT_FOCUS_TARGET_CHANGED");
        object cleanup = Data("version", 1, "returnWindow", lease.Return.Report(), "wechatWindow",
                              lease.Wechat.Report(), "lastInputTick", finalInputTick, "issuedAtMs", UtcMs());
        QtFocus.TakeActive();
        return Data("focusHandoff", lease.Handoff(), "cleanup", cleanup, "transferred", true, "pointerRestored",
                    pointerRestored, "revision", lease.Revision);
    }
    static object QtRestoreTransferred(Dictionary<string, object> request)
    {
        long revision = Interlocked.Read(ref Revision);
        Need(QtEnableInput && QtFocus.Active == null, "QT_FOCUS_LEASE_UNAVAILABLE");
        var token = Map(Get(request, "cleanup"));
        Need(token != null && token.Count == 5 && Number(Get(token, "version")) == 1, "QT_FOCUS_LEASE_INVALID");
        long issued = Number(Get(token, "issuedAtMs"));
        Need(QtTransferredFresh(issued, UtcMs()), "QT_FOCUS_LEASE_EXPIRED");
        var lease = new QtFocusLease { Return = QtParseFocus(Get(token, "returnWindow")),
                                       Wechat = QtParseFocus(Get(token, "wechatWindow")), Revision = revision,
                                       TransferredInputTick = Number(Get(token, "lastInputTick")),
                                       TransferredIssuedAt = issued };
        Need(lease.Return.Pid != lease.Wechat.Pid, "QT_FOCUS_LEASE_INVALID");
        // A replacement helper has no click history or caption capability.
        // Observe one full double-click interval without input before allowing
        // a freshly measured, visible return caption as the denied-API fallback.
        // The ordinary SetForegroundWindow attempt comes first. Caption
        // history is warmed only if that request was refused.
        return QtRestoreFocus(lease, QtTransferredUnchanged(Number(Get(token, "lastInputTick")), QtInputTick(),
                                                            revision, Interlocked.Read(ref Revision)));
    }
}
