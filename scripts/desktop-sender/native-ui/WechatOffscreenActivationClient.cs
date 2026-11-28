// Used by Qt and voice UIA only after their ordinary foreground request fails.
// Thread-input attachment lives in a short-lived child, never the input host.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;

internal static partial class WechatDraftProbe
{
    [DllImport("user32.dll", EntryPoint = "SetThreadDpiAwarenessContext")]
    static extern IntPtr OffscreenFocusDpi(IntPtr value);
    static bool OffscreenFocusOutside(Rect rect, List<Rect> displays)
    {
        if (rect.Width <= 0 || rect.Height <= 0 || displays == null || displays.Count == 0)
            return false;
        foreach (Rect display in displays)
            if (rect.Left < display.Right && display.Left < rect.Right && rect.Top < display.Bottom &&
                display.Top < rect.Bottom)
                return false;
        return true;
    }
    static bool IsOffscreenFocusWindow(IntPtr target)
    {
        Rect bounds;
        Need(FocusGetWindowRect(target, out bounds), "DRAFT_OFFSCREEN_FOCUS_WINDOW_CHANGED");
        return OffscreenFocusOutside(bounds, FocusDisplayRects());
    }
    static bool OffscreenWaitForExit(Func<int, bool> wait, Action kill)
    {
        if (wait(300))
            return false;
        kill();
        Need(wait(200), "DRAFT_OFFSCREEN_FOCUS_HELPER_STOP_UNCONFIRMED");
        return true;
    }
    static bool BoundForegroundRequestAccepted(Dictionary<string, object> result, string nonce)
    {
        return result != null && Object.Equals(Get(result, "version"), 1) && Text(result, "nonce") == nonce &&
               Object.Equals(Get(result, "attempted"), true) && Object.Equals(Get(result, "accepted"), true) &&
               Object.Equals(Get(result, "inputSent"), false) && Object.Equals(Get(result, "clipboardAccessed"), false);
    }
    static Dictionary<string, object> OffscreenFocusIdentity(IntPtr window)
    {
        uint pid;
        uint thread = GetWindowThreadProcessId(window, out pid);
        Need(thread != 0, "DRAFT_OFFSCREEN_FOCUS_WINDOW_CHANGED");
        IntPtr process = OpenProcess(0x1000, false, pid);
        Need(process != IntPtr.Zero, "DRAFT_OFFSCREEN_FOCUS_PROCESS_CHANGED");
        try
        {
            FileTime start, exit, kernel, user;
            Need(GetProcessTimes(process, out start, out exit, out kernel, out user),
                 "DRAFT_OFFSCREEN_FOCUS_PROCESS_CHANGED");
            return Data("hwnd", window.ToInt64().ToString(CultureInfo.InvariantCulture), "pid", pid, "threadId", thread,
                        "processCreatedFileTimeUtc", start.Value.ToString(CultureInfo.InvariantCulture));
        }
        finally
        {
            CloseHandle(process);
        }
    }
    static bool ActivateOffscreenForegroundOnce(IntPtr source, IntPtr target, string executable, Action guard)
    {
        return ActivateBoundForegroundChild(source, target, executable, guard, false);
    }
    static bool ActivateBoundReturnForegroundOnce(IntPtr source, IntPtr target, string executable, Action guard)
    {
        return ActivateBoundForegroundChild(source, target, executable, guard, true);
    }
    static bool ActivateBoundWechatForegroundOnce(IntPtr source, IntPtr target, string executable, Action guard)
    {
        return ActivateBoundForegroundChild(source, target, executable, guard, false, true);
    }
    static bool ActivateBoundForegroundChild(IntPtr source, IntPtr target, string executable, Action guard,
                                             bool restoring, bool boundWechat = false)
    {
        guard();
        Need(GetForegroundWindow() == source, "DRAFT_FOCUS_SOURCE_CHANGED");
        if (!restoring && !boundWechat && !IsOffscreenFocusWindow(target))
            return false;
        IntPtr priorDpi = OffscreenFocusDpi(new IntPtr(-4));
        Need(priorDpi != IntPtr.Zero, "DRAFT_OFFSCREEN_FOCUS_DPI_UNAVAILABLE");
        try
        {
            string file = Path.Combine(Path.GetDirectoryName(Assembly.GetExecutingAssembly().Location),
                                       "WechatOffscreenFocus.exe");
            Need(File.Exists(file) && (File.GetAttributes(file) & FileAttributes.ReparsePoint) == 0,
                 "DRAFT_OFFSCREEN_FOCUS_HELPER_REQUIRED");
            var sourceId = OffscreenFocusIdentity(source);
            var targetId = OffscreenFocusIdentity(target);
            Point pointer;
            Rect bounds = new Rect();
            Need(FocusGetCursorPos(out pointer) && FocusGetWindowRect(target, out bounds),
                 "DRAFT_OFFSCREEN_FOCUS_WINDOW_CHANGED");
            var last = new LastInput { Size = (uint)Marshal.SizeOf(typeof(LastInput)) };
            Need(GetLastInputInfo(ref last), "DRAFT_ACTIVITY_MONITOR_UNAVAILABLE");
            uint tick = last.Time;
            NoKeysHeld();
            guard();
            Need(GetForegroundWindow() == source, "DRAFT_FOCUS_SOURCE_CHANGED");
            long created;
            using (var own = Process.GetCurrentProcess()) created = own.StartTime.ToUniversalTime().ToFileTimeUtc();
            string nonce = Guid.NewGuid().ToString("N");
            var request = Data("version", 1, "nonce", nonce, "source", sourceId, "target", targetId, "executable",
                               executable, "parent",
                               Data("pid", GetCurrentProcessId(), "processCreatedFileTimeUtc",
                                    created.ToString(CultureInfo.InvariantCulture)),
                               "inputTick", tick, "cursor", Data("x", pointer.X, "y", pointer.Y), "targetRect",
                               bounds.Report(), "deadlineTickMs", Now() + 350);
            if (restoring)
                request.Add("purpose", "restore-bound-window");
            else if (boundWechat)
                request.Add("purpose", "activate-bound-wechat");
            var diagnostic = FocusActivationDiagnostic;
            if (diagnostic != null)
            {
                diagnostic["offscreenHelperAttempted"] = true;
                diagnostic["offscreenHelperTimedOut"] = false;
            }
            using (var child = new Process())
            {
                child.StartInfo = new ProcessStartInfo(file, "--once") { UseShellExecute = false,
                                                                         CreateNoWindow = true,
                                                                         WindowStyle = ProcessWindowStyle.Hidden,
                                                                         RedirectStandardInput = true,
                                                                         RedirectStandardOutput = true,
                                                                         RedirectStandardError = true };
                bool started = false;
                try
                {
                    guard();
                    Need(GetForegroundWindow() == source, "DRAFT_FOCUS_SOURCE_CHANGED");
                    started = child.Start();
                    Need(started, "DRAFT_OFFSCREEN_FOCUS_HELPER_FAILED");
                    child.StandardInput.WriteLine(Json.Serialize(request));
                    child.StandardInput.Close();
                    bool timedOut = OffscreenWaitForExit(child.WaitForExit, child.Kill);
                    if (diagnostic != null)
                        diagnostic["offscreenHelperTimedOut"] = timedOut;
                    Need(child.HasExited, "DRAFT_OFFSCREEN_FOCUS_HELPER_STOP_UNCONFIRMED");
                    string output = child.StandardOutput.ReadToEnd();
                    Need(output.Length <= 16384, "DRAFT_OFFSCREEN_FOCUS_HELPER_INVALID");
                    Dictionary<string, object> result = null;
                    try
                    {
                        result = Map(Json.DeserializeObject(output));
                    }
                    catch
                    {
                    }
                    bool queued = child.ExitCode == 0 && BoundForegroundRequestAccepted(result, nonce);
                    if (diagnostic != null)
                    {
                        diagnostic["offscreenHelperExited"] = true;
                        diagnostic["offscreenHelperExitCode"] = child.ExitCode;
                        diagnostic["offscreenHelperRequestAttempted"] = Object.Equals(Get(result, "attempted"), true);
                        diagnostic["offscreenHelperRequestAccepted"] = queued;
                        diagnostic["offscreenHelperReportedActivated"] = Object.Equals(Get(result, "activated"), true);
                        string reason = Text(result, "error");
                        if (reason != null && reason.StartsWith("OFFSCREEN_FOCUS_", StringComparison.Ordinal) &&
                            reason.Length < 100)
                            diagnostic["offscreenHelperReason"] = reason;
                    }
                    // The child has fully exited before inspecting foreground;
                    // even a timed-out child can no longer activate it later.
                    guard();
                    Point at;
                    Rect current;
                    var observed = new LastInput { Size = (uint)Marshal.SizeOf(typeof(LastInput)) };
                    Need(GetLastInputInfo(ref observed) && observed.Time == tick && FocusGetCursorPos(out at) &&
                             at.X == pointer.X && at.Y == pointer.Y,
                         "DRAFT_HUMAN_ACTIVITY_CHANGED");
                    Need(FocusGetWindowRect(target, out current) && Same(current, bounds),
                         "DRAFT_OFFSCREEN_FOCUS_WINDOW_CHANGED");
                    NoKeysHeld();
                    bool targetFocused = GetForegroundWindow() == target;
                    Need(targetFocused || GetForegroundWindow() == source, "DRAFT_FOCUS_SOURCE_CHANGED");
                    if (diagnostic != null)
                        diagnostic["offscreenHelperActivated"] = targetFocused;
                    // Acceptance may precede activation on the destination's
                    // thread. The caller's ConfirmFocusOnce still must observe
                    // the exact target; acceptance alone never confirms focus.
                    return targetFocused || (restoring || boundWechat) && queued;
                }
                finally
                {
                    if (started && !child.HasExited)
                    {
                        try
                        {
                            child.Kill();
                        }
                        catch
                        {
                        }
                        Need(child.WaitForExit(200), "DRAFT_OFFSCREEN_FOCUS_HELPER_STOP_UNCONFIRMED");
                    }
                }
            }
        }
        finally
        {
            OffscreenFocusDpi(priorDpi);
        }
    }
    static int OffscreenActivationSelfTest()
    {
        int n = 0, kills = 0, waits = 0;
        Need(!OffscreenWaitForExit(
                 delegate(int ms) {
                     waits++;
                     Need(ms == 300, "TEST_OFFSCREEN_INITIAL_BOUND");
                     return true;
                 },
                 delegate { kills++; }) &&
                 kills == 0 && waits == 1,
             "TEST_OFFSCREEN_ALREADY_EXITED");
        n++;
        var response = Data("version", 1, "nonce", "fixture", "attempted", true, "accepted", true, "inputSent", false,
                            "clipboardAccessed", false);
        Need(BoundForegroundRequestAccepted(response, "fixture") &&
                 !BoundForegroundRequestAccepted(response, "other") && !BoundForegroundRequestAccepted(null, "fixture"),
             "TEST_BOUND_FOCUS_ACCEPTANCE_BINDS_ONE_REQUEST");
        n++;
        response["accepted"] = false;
        Need(!BoundForegroundRequestAccepted(response, "fixture"), "TEST_BOUND_FOCUS_REJECTION_IS_NOT_ACCEPTANCE");
        n++;
        waits = 0;
        Need(OffscreenWaitForExit(
                 delegate(int ms) {
                     waits++;
                     Need(ms == (waits == 1 ? 300 : 200), "TEST_OFFSCREEN_KILL_BOUND");
                     return waits == 2;
                 },
                 delegate { kills++; }) &&
                 kills == 1 && waits == 2,
             "TEST_OFFSCREEN_KILL_THEN_CONFIRM_EXIT");
        n++;
        kills = 0;
        Expect(delegate { OffscreenWaitForExit(delegate(int ms) { return false; }, delegate { kills++; }); },
               "DRAFT_OFFSCREEN_FOCUS_HELPER_STOP_UNCONFIRMED");
        Need(kills == 1, "TEST_OFFSCREEN_NO_SUCCESS_WHILE_HELPER_ALIVE");
        n++;
        Need(!OffscreenFocusOutside(new Rect(-1900, 0, -1000, 600), new List<Rect> { new Rect(-1920, 0, 0, 1080) }) &&
                 OffscreenFocusOutside(new Rect(2000, 0, 2800, 600), new List<Rect> { new Rect(0, 0, 1920, 1080) }),
             "TEST_OFFSCREEN_ALL_DISPLAYS");
        return n + 1;
    }
}
