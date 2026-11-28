// A UIA input owner for a WeChat window that was already foreground. There is
// no return-window capability, focus activation, parking or transfer token.
using System;
using System.Collections.Generic;
using System.Threading;

internal static partial class WechatDraftProbe
{
    static bool QtForegroundSessionMatches(QtFocusLease lease, WindowIdentity actual, IntPtr foreground, long revision)
    {
        return lease != null && lease.InPlace && lease.UiaMode && lease.Return == null && lease.SessionId != null &&
               WindowIdentity.Same(lease.Wechat, actual) && foreground == lease.Wechat.Window &&
               revision == lease.Revision;
    }
    static void QtRequireTransferableLease(QtFocusLease lease)
    {
        Need(lease == null || !lease.InPlace, "QT_IN_PLACE_HANDOFF_UNAVAILABLE");
    }
    static object QtBeginForegroundSession(Dictionary<string, object> request, QtFocusLease inspected)
    {
        Need(QtEnableInput && !QtLayoutOnly && !Stopping && QtFocus.Active == null && QtFocus.Parked == null &&
                 Object.Equals(Get(request, "uiaMode"), true),
             "QT_FOREGROUND_SESSION_UNAVAILABLE");
        Need(QtSurface == "main" && QtPopup == null && QtPendingPopup == null, "QT_FOREGROUND_SESSION_UNAVAILABLE");
        Need(inspected != null && WindowIdentity.Same(inspected.Return, inspected.Wechat),
             "QT_FOREGROUND_PREFLIGHT_REQUIRED");
        long idle = Number(Get(request, "idleMs"));
        Need(idle >= 0 && idle <= 300000, "QT_IDLE_INVALID");
        QtRequireIdle(idle);
        NoKeysHeld();
        int width = checked((int)Number(Get(request, "width"))), height = checked((int)Number(Get(request, "height"))),
            dpi = checked((int)Number(Get(request, "dpi")));
        var target = QtHandoffTarget(width, height, dpi);
        long revision = Interlocked.Read(ref Revision);
        Need(revision == inspected.Revision && WindowIdentity.Same(target, inspected.Wechat) &&
                 GetForegroundWindow() == target.Window,
             "QT_FOCUS_TARGET_CHANGED");
        var lease = new QtFocusLease { InPlace = true, UiaMode = true, SessionId = Guid.NewGuid().ToString("N"),
                                       Wechat = target, Revision = revision };
        Binding binding = Snapshot(target.Window, QtExecutable);
        Need(binding.FocusOwned && (binding.GuiFlags & 0x1e) == 0 && binding.Client.Width == width &&
                 binding.Client.Height == height && binding.Dpi == dpi,
             "QT_FOCUS_UNAVAILABLE");
        Need(QtForegroundSessionMatches(lease, QtFocusWindow(target.Window, QtExecutable), GetForegroundWindow(),
                                        Interlocked.Read(ref Revision)),
             "QT_FOCUS_TARGET_CHANGED");
        NoKeysHeld();
        QtFocus.Acquire(lease);
        QtWindow = target.Window;
        QtRoot = target;
        QtCurrent = null;
        return Data("version", 1, "inPlace", true, "sessionId", lease.SessionId, "window", target.Report(), "revision",
                    revision, "activated", false, "inputSent", false, "focusChanged", false, "clipboardAccessed",
                    false);
    }
    static object QtForegroundSessionReleaseReport(QtFocusLease lease, bool identity, bool foreground, bool activity)
    {
        Need(lease != null && lease.InPlace && lease.Return == null, "QT_FOREGROUND_SESSION_INVALID");
        return Data("version", 1, "inPlace", true, "sessionId", lease.SessionId, "released", true, "restored", false,
                    "skipped", true, "inputSent", false, "focusChanged", false, "clipboardAccessed", false,
                    "identitiesUnchanged", identity, "foregroundOwnedByWechat", foreground, "activityUnchanged",
                    activity);
    }
    static object QtReleaseForegroundSession(QtFocusLease lease, bool unchanged)
    {
        bool identity = false, foreground = false;
        try
        {
            identity = WindowIdentity.Same(lease.Wechat, QtFocusWindow(lease.Wechat.Window, QtExecutable, true));
            foreground = QtOwnedPopup(GetForegroundWindow(), lease.Wechat.Window);
        }
        catch
        { /* Releasing local ownership never takes foreground back from the user. */
        }
        finally
        {
            QtCurrent = null;
        }
        return QtForegroundSessionReleaseReport(lease, identity, foreground,
                                                unchanged && lease.Revision == Interlocked.Read(ref Revision));
    }
    static int QtForegroundSessionSelfTest()
    {
        int count = 0;
        var target = new WindowIdentity(new IntPtr(42), 7, 123);
        var lease = new QtFocusLease { InPlace = true, UiaMode = true, SessionId = new string('a', 32), Wechat = target,
                                       Revision = 5 };
        Need(QtForegroundSessionMatches(lease, target, target.Window, 5),
             "QT_TEST_FOREGROUND_SESSION_EXACT_WINDOW_AND_ACTIVITY");
        count++;
        Need(!QtForegroundSessionMatches(lease, target, new IntPtr(43), 5) &&
                 !QtForegroundSessionMatches(lease, target, target.Window, 6),
             "QT_TEST_FOREGROUND_SESSION_LOST_FOCUS_OR_ACTIVITY_REFUSED");
        count++;
        Need(!QtForegroundSessionMatches(lease, new WindowIdentity(target.Window, 8, 123), target.Window, 5) &&
                 !QtForegroundSessionMatches(lease, new WindowIdentity(target.Window, 7, 124), target.Window, 5),
             "QT_TEST_FOREGROUND_SESSION_PID_REUSE_REFUSED");
        count++;
        Expect(delegate { QtRequireTransferableLease(lease); }, "QT_IN_PLACE_HANDOFF_UNAVAILABLE");
        Expect(delegate { lease.Handoff(); }, "QT_IN_PLACE_HANDOFF_UNAVAILABLE");
        count += 2;
        {
            using (var focus = new QtFocusSession.Fixture(QtFocus))
            {
                focus.Arrange(lease);
                Expect(delegate { QtParkFocus(); }, "QT_IN_PLACE_HANDOFF_UNAVAILABLE");
                Expect(delegate { QtTransferFocus(); }, "QT_IN_PLACE_HANDOFF_UNAVAILABLE");
                Need(Object.ReferenceEquals(QtFocus.Active, lease),
                     "QT_TEST_IN_PLACE_REFUSED_PARK_TRANSFER_RETAIN_SESSION");
                count += 3;
            }
        }
        lease.Return = target;
        Need(!QtForegroundSessionMatches(lease, target, target.Window, 5),
             "QT_TEST_FOREGROUND_SESSION_CANNOT_HAVE_FAKE_RETURN");
        lease.Return = null;
        lease.UiaMode = false;
        Need(!QtForegroundSessionMatches(lease, target, target.Window, 5), "QT_TEST_FOREGROUND_SESSION_ONLY_UIA");
        lease.UiaMode = true;
        count += 2;
        var released = Map(QtForegroundSessionReleaseReport(lease, true, true, true));
        Need(Object.Equals(Get(released, "released"), true) && Object.Equals(Get(released, "restored"), false) &&
                 Object.Equals(Get(released, "focusChanged"), false) &&
                 Object.Equals(Get(released, "inputSent"), false) && !released.ContainsKey("returnWindow") &&
                 !released.ContainsKey("foregroundInterval"),
             "QT_TEST_FOREGROUND_RELEASE_NEVER_MINTS_RETURN_OR_OCCUPATION");
        count++;
        released = Map(QtForegroundSessionReleaseReport(lease, true, false, false));
        Need(Object.Equals(Get(released, "released"), true) &&
                 Object.Equals(Get(released, "activityUnchanged"), false) &&
                 Object.Equals(Get(released, "foregroundOwnedByWechat"), false),
             "QT_TEST_FOREGROUND_RELEASE_YIELDS_TO_USER");
        count++;
        return count;
    }
}
