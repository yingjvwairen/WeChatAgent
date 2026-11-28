// Optional shared-desktop voice handoff. Foreground input keeps the original
// guards; only the already-bound recording/audio phase permits other-app input.
// Foreground activation uses one guarded request, optionally followed by one
// calibrated ordinary titlebar click. No linked queues or global shortcuts.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static partial class WechatDraftProbe
{
    sealed class VoiceReturnWindow
    {
        internal IntPtr Window;
        internal uint Pid;
        internal long Created, ForegroundStarted;
        internal bool IncludesContactNavigation;
        internal FocusActivation Activation;
    }
    sealed class VoicePointerLease
    {
        internal Point Origin, LastOwn;
        internal Rect Desktop;
        internal long Revision, PointerRevision;
        internal bool LastOwnKnown, Restored, Skipped;
    }
    sealed class VoiceBackgroundSubmission
    {
        internal bool Attempted, Applied, Confirmed, ForegroundUnchanged, AutoActivated, AutoReturnAttempted,
            AutoReturnConfirmed, AutoReturnActivityUnchanged;
        internal IntPtr ForegroundBefore;
        internal VoiceReturnWindow ReturnBefore;
        internal long Revision;
        internal object SourceObservation;
        internal object Report()
        {
            var report = Data("version", 1, "attempted", Attempted, "applied", Applied, "confirmed", Confirmed,
                              "foregroundUnchanged", ForegroundUnchanged);
            if (AutoActivated)
            {
                var returned = Data("observed", true, "attempted", AutoReturnAttempted, "confirmed",
                                    AutoReturnConfirmed, "activityUnchanged", AutoReturnActivityUnchanged);
                if (SourceObservation != null)
                    returned["sourceObservation"] = SourceObservation;
                report["activationReturn"] = returned;
            }
            return report;
        }
    }
    sealed class VoiceHandoffState
    {
        internal VoiceReturnWindow InitialReturn, SubmitReturn;
        internal IntPtr WechatWindow;
        internal uint WechatPid, WechatThread;
        internal Rect WechatBounds;
        internal VoiceCaption InitialCaption, SubmitCaption;
        internal bool SubmitRaiseAttempted;
        internal object SubmitVisibility;
        internal FocusOrderAnchor StartPredecessor;
        internal bool StartRaiseAttempted, StartSourceAbove, StartRestoreFinished;
        internal object StartVisibility, StartVisibilityRestore;
        // 0: initial foreground lease; 1: background recording; 2: acquiring
        // the second lease; 3: second foreground lease; 4: finished;
        // 5: returning a lease (other-app input is harmless); 6: submitted,
        // focus returned, observing the original recorder without more input;
        // 7: background submit/observation; client-triggered activation is
        // observed until recorder teardown, then returned once using the
        // pre-submit window/activity binding.
        internal int Phase, BackgroundActivity;
        internal VoiceBackgroundSubmission BackgroundSubmit;
        internal long LeaseRevision, InitialStarted, InitialEnded, BackgroundStarted, BackgroundEnded, SubmitStarted,
            SubmitEnded, ContinuousInitialStarted;
        internal bool OwnsInitialLease, InitialReturnAttempted, InitialReturnConfirmed, BackgroundEntered,
            SubmitActivationAttempted, SubmitActivationConfirmed, FinalReturnAttempted, FinalReturnConfirmed,
            ReturnSkippedForHumanInput;
        internal VoicePointerLease InitialPointer, SubmitPointer;
    }
    static VoiceHandoffState VoiceHandoff;
    // A cancelled clip has its own focus lease. It never resumes the old
    // submission lease or grants permission to submit the interrupted audio.
    sealed class VoiceCancellationLease
    {
        internal VoiceReturnWindow Return;
        internal VoicePointerLease Pointer;
        internal VoiceCaption Caption;
        internal long Revision, Started, Ended;
        internal bool Active, ActivationAttempted, Returned, Finished;
    }
    static VoiceCancellationLease VoiceCancellation;
    static long VoicePointerRevision;
    static void VoiceNotePointerActivity(bool own)
    {
        if (!own)
            Interlocked.Increment(ref VoicePointerRevision);
    }
    static Rect VoicePointerDesktop()
    {
        return new Rect(GetSystemMetrics(76), GetSystemMetrics(77), GetSystemMetrics(76) + GetSystemMetrics(78),
                        GetSystemMetrics(77) + GetSystemMetrics(79));
    }
    static bool VoicePointerIn(Rect desktop, Point point)
    {
        return point.X >= desktop.Left && point.X < desktop.Right && point.Y >= desktop.Top && point.Y < desktop.Bottom;
    }
    static bool VoicePointerNear(Point left, Point right)
    {
        return Math.Abs((long)left.X - right.X) <= 1 && Math.Abs((long)left.Y - right.Y) <= 1;
    }
    static bool VoiceMayRestorePointer(bool origin, bool lastOwn, bool identity, bool activity, bool keys,
                                       bool geometry)
    {
        return origin && lastOwn && identity && activity && keys && geometry;
    }
    static VoicePointerLease VoiceCapturePointer(long revision)
    {
        long pointerRevision = Interlocked.Read(ref VoicePointerRevision);
        Point origin;
        Rect desktop = VoicePointerDesktop();
        Need(FocusGetCursorPos(out origin) && VoicePointerIn(desktop, origin) &&
                 Interlocked.Read(ref Revision) == revision &&
                 Interlocked.Read(ref VoicePointerRevision) == pointerRevision,
             "VOICE_POINTER_CAPTURE_UNCONFIRMED");
        NoKeysHeld();
        return new VoicePointerLease { Origin = origin,
                                       LastOwn = origin,
                                       Desktop = desktop,
                                       Revision = revision,
                                       PointerRevision = pointerRevision,
                                       LastOwnKnown = true };
    }
    static VoicePointerLease VoiceCurrentPointer()
    {
        if (VoiceCancellation != null && VoiceCancellation.Active)
            return VoiceCancellation.Pointer;
        var state = VoiceHandoff;
        if (state == null)
            return null;
        return state.SubmitActivationAttempted ? state.SubmitPointer : state.InitialPointer;
    }
    static void VoiceTrackOwnPointer(VoiceRequest request, long revision, Point expected)
    {
        var pointer = VoiceCurrentPointer();
        if (pointer == null)
            return;
        pointer.LastOwnKnown = false;
        long end = Now() + 40;
        while (Now() <= end)
        {
            Point actual;
            if (Interlocked.Read(ref Revision) != revision ||
                Interlocked.Read(ref VoicePointerRevision) != pointer.PointerRevision ||
                GetForegroundWindow() != request.Binding.Window)
                return;
            if (VoiceKeysReleased() && FocusGetCursorPos(out actual) && VoicePointerNear(actual, expected))
            {
                pointer.LastOwn = actual;
                pointer.LastOwnKnown = true;
                return;
            }
            Thread.Sleep(2);
        }
    }
    static void VoiceRestorePointer(VoiceRequest request, VoicePointerLease pointer, VoiceReturnWindow target)
    {
        if (pointer == null)
            return;
        pointer.Skipped = true;
        try
        {
            Point actual = new Point(0, 0);
            bool samePosition = pointer.LastOwnKnown && FocusGetCursorPos(out actual) &&
                                actual.X == pointer.LastOwn.X && actual.Y == pointer.LastOwn.Y;
            bool activity = Interlocked.Read(ref Revision) == pointer.Revision &&
                            Interlocked.Read(ref VoicePointerRevision) == pointer.PointerRevision;
            bool identity =
                GetForegroundWindow() == target.Window && VoiceSameReturn(target, VoiceReadReturnWindow(target.Window));
            if (!VoiceMayRestorePointer(true, samePosition, identity, activity, VoiceKeysReleased(),
                                        Same(pointer.Desktop, VoicePointerDesktop()) &&
                                            VoicePointerIn(pointer.Desktop, pointer.Origin)))
                return;
            VoiceValidateReturn(target, request.Binding);
            NoKeysHeld();
            Need(Interlocked.Read(ref Revision) == pointer.Revision &&
                     Interlocked.Read(ref VoicePointerRevision) == pointer.PointerRevision &&
                     GetForegroundWindow() == target.Window && FocusGetCursorPos(out actual) &&
                     actual.X == pointer.LastOwn.X && actual.Y == pointer.LastOwn.Y,
                 "VOICE_POINTER_RETURN_CHANGED");
            if (VoicePointerNear(actual, pointer.Origin))
            {
                pointer.Restored = true;
                pointer.Skipped = false;
                return;
            }
            Input move = ClickEvents(pointer.Origin.X, pointer.Origin.Y, pointer.Desktop)[0];
            InputAttempted = true;
            if (SendInput(1, new[] { move }, Marshal.SizeOf(typeof(Input))) != 1)
                return;
            long end = Now() + 40;
            while (Now() <= end)
            {
                if (Interlocked.Read(ref Revision) != pointer.Revision ||
                    Interlocked.Read(ref VoicePointerRevision) != pointer.PointerRevision ||
                    GetForegroundWindow() != target.Window || !VoiceKeysReleased())
                    return;
                if (FocusGetCursorPos(out actual) && VoicePointerNear(actual, pointer.Origin))
                {
                    pointer.Restored = true;
                    pointer.Skipped = false;
                    return;
                }
                Thread.Sleep(2);
            }
        }
        catch
        {
        }
    }

    static VoiceReturnWindow ParseVoiceHandoff(object value, Request binding)
    {
        if (value == null)
            return null;
        var map = Map(value);
        var window = Map(Get(map, "returnWindow"));
        Need(map != null &&
                 map.Count ==
                     2 + (map.ContainsKey("activation") ? 1 : 0) + (map.ContainsKey("foregroundLease") ? 1 : 0) &&
                 Number(Get(map, "version")) == 1 && window != null && window.Count == 3,
             "VOICE_FOCUS_HANDOFF_INVALID");
        long pid = Number(Get(window, "pid"));
        Need(pid > 0 && pid <= UInt32.MaxValue, "VOICE_FOCUS_HANDOFF_INVALID");
        var result =
            new VoiceReturnWindow { Window = new IntPtr(DecimalString(Get(window, "hwnd"))), Pid = (uint)pid,
                                    Created = DecimalString(Get(window, "processCreatedFileTimeUtc")),
                                    Activation = ParseFocusActivation(Get(map, "activation"), binding.Client.Width) };
        if (map.ContainsKey("activation"))
            Need(result.Activation != null, "VOICE_FOCUS_HANDOFF_INVALID");
        if (map.ContainsKey("foregroundLease"))
        {
            var timing = Map(Get(map, "foregroundLease"));
            Need(timing != null && timing.Count == 3 && Number(Get(timing, "version")) == 1 &&
                     Number(Get(timing, "startedAtTickMs")) > 0 && Get(timing, "includesContactNavigation") is bool,
                 "VOICE_FOCUS_HANDOFF_INVALID");
            result.ForegroundStarted = Number(Get(timing, "startedAtTickMs"));
            result.IncludesContactNavigation = (bool)Get(timing, "includesContactNavigation");
        }
        Need(result.Window != IntPtr.Zero && result.Created > 0 && result.Window != binding.Window &&
                 result.Pid != binding.Pid,
             "VOICE_FOCUS_HANDOFF_INVALID");
        return result;
    }
    static bool VoiceSameReturn(VoiceReturnWindow left, VoiceReturnWindow right)
    {
        return left != null && right != null && left.Window == right.Window && left.Pid == right.Pid &&
               left.Created == right.Created;
    }
    static bool VoiceMayRestore(bool ownsForeground, bool unchangedIdentity, bool unchangedActivity, bool keysReleased)
    {
        return ownsForeground && unchangedIdentity && unchangedActivity && keysReleased;
    }
    static bool VoiceMayAllowBackgroundInput(int phase, bool foregroundWechat, bool mouseButtonOnWechat)
    {
        return (phase == 1 || phase == 6 || phase == 7) && !foregroundWechat && !mouseButtonOnWechat;
    }
    static bool VoiceMaySubmitInBackground(bool uia, bool initialReturned, bool backgroundEntered, int phase,
                                           bool captureBound, bool recorderBound, bool attempted)
    {
        return uia && initialReturned && backgroundEntered && phase == 1 && captureBound && recorderBound && !attempted;
    }
    static bool VoiceMouseButton(uint message)
    {
        return message >= 0x201 && message <= 0x20e;
    }
    static bool VoiceWindowProcess(IntPtr window, uint expected)
    {
        uint pid;
        return window != IntPtr.Zero && GetWindowThreadProcessId(window, out pid) != 0 && pid == expected;
    }
    static bool VoiceKeysReleased()
    {
        for (int key = 1; key < 256; key++)
            if ((GetAsyncKeyState(key) & 0x8000) != 0)
                return false;
        return true;
    }

    static VoiceReturnWindow VoiceReadReturnWindow(IntPtr window)
    {
        Desktop();
        Need(window != IntPtr.Zero && IsWindow(window) && IsWindowVisible(window) && !IsIconic(window) &&
                 GetAncestor(window, 2) == window && GetLastActivePopup(window) == window,
             "VOICE_FOCUS_RETURN_WINDOW_UNAVAILABLE");
        int cloaked;
        Need(DwmGetWindowAttribute(window, 14, out cloaked, 4) >= 0 && cloaked == 0,
             "VOICE_FOCUS_RETURN_WINDOW_UNAVAILABLE");
        uint pid;
        Need(GetWindowThreadProcessId(window, out pid) != 0, "VOICE_FOCUS_RETURN_WINDOW_UNAVAILABLE");
        uint session, ownSession;
        Need(ProcessIdToSessionId(pid, out session) && ProcessIdToSessionId(GetCurrentProcessId(), out ownSession) &&
                 session == ownSession,
             "VOICE_FOCUS_RETURN_WINDOW_UNAVAILABLE");
        IntPtr process = OpenProcess(0x1000, false, pid);
        Need(process != IntPtr.Zero, "VOICE_FOCUS_RETURN_WINDOW_UNAVAILABLE");
        try
        {
            FileTime start, exit, kernel, user;
            Need(GetProcessTimes(process, out start, out exit, out kernel, out user),
                 "VOICE_FOCUS_RETURN_WINDOW_UNAVAILABLE");
            return new VoiceReturnWindow { Window = window, Pid = pid, Created = start.Value };
        }
        finally
        {
            CloseHandle(process);
        }
    }
    static void VoiceValidateReturn(VoiceReturnWindow expected, Request binding)
    {
        Need(expected != null && expected.Window != binding.Window && expected.Pid != binding.Pid &&
                 VoiceSameReturn(expected, VoiceReadReturnWindow(expected.Window)),
             "VOICE_FOCUS_RETURN_WINDOW_CHANGED");
    }

    // Called only from the global input hooks. No key value, pointer coordinate,
    // title, or application identity is retained in diagnostics.
    static bool VoiceAllowOtherAppInput(string kind, uint flags, uint injectedMask, UIntPtr marker, uint message,
                                        Point point)
    {
        if (Own(flags, injectedMask, marker))
            return false;
        VoiceHandoffState state = VoiceHandoff;
        if (state == null)
            return false;
        int phase = Interlocked.CompareExchange(ref state.Phase, 0, 0);
        if (phase == 4)
            return true;
        bool foregroundWechat = VoiceWindowProcess(GetForegroundWindow(), state.WechatPid);
        bool onWechat =
            kind == "mouse" && VoiceMouseButton(message) && VoiceWindowProcess(WindowFromPoint(point), state.WechatPid);
        if (phase == 5 && !foregroundWechat && !onWechat)
            return true;
        if (!VoiceMayAllowBackgroundInput(phase, foregroundWechat, onWechat))
            return false;
        Human();
        Interlocked.Exchange(ref state.BackgroundActivity, 1);
        return true;
    }

    static void VoiceBoundWindowGuard(VoiceRequest request)
    {
        Desktop();
        Request expected = request.Binding;
        Need(IsWindow(expected.Window) && IsWindowVisible(expected.Window) && !IsIconic(expected.Window) &&
                 GetAncestor(expected.Window, 2) == expected.Window &&
                 GetLastActivePopup(expected.Window) == expected.Window,
             "VOICE_BACKGROUND_WINDOW_CHANGED");
        int cloaked;
        Need(DwmGetWindowAttribute(expected.Window, 14, out cloaked, 4) >= 0 && cloaked == 0,
             "VOICE_BACKGROUND_WINDOW_CHANGED");
        uint pid;
        uint thread = GetWindowThreadProcessId(expected.Window, out pid);
        Need(thread != 0 && pid == expected.Pid &&
                 (VoiceHandoff == null || VoiceHandoff.WechatThread == 0 || thread == VoiceHandoff.WechatThread),
             "VOICE_BACKGROUND_WINDOW_CHANGED");
        IntPtr process = OpenProcess(0x1000, false, pid);
        Need(process != IntPtr.Zero, "VOICE_BACKGROUND_WINDOW_CHANGED");
        try
        {
            FileTime start, exit, kernel, user;
            var file = new StringBuilder(32768);
            int length = file.Capacity;
            Need(GetProcessTimes(process, out start, out exit, out kernel, out user) &&
                     start.Value == expected.Created && QueryFullProcessImageName(process, 0, file, ref length) &&
                     String.Equals(System.IO.Path.GetFullPath(file.ToString()), expected.Executable,
                                   StringComparison.OrdinalIgnoreCase),
                 "VOICE_BACKGROUND_WINDOW_CHANGED");
        }
        finally
        {
            CloseHandle(process);
        }
        Rect client;
        Point origin = new Point(0, 0);
        Need(GetClientRect(expected.Window, out client) && ClientToScreen(expected.Window, ref origin) &&
                 Same(client, expected.Client) &&
                 Same(new Rect(origin.X, origin.Y, origin.X + client.Width, origin.Y + client.Height),
                      expected.Capture) &&
                 GetDpiForWindow(expected.Window) == expected.Dpi,
             "VOICE_BACKGROUND_WINDOW_CHANGED");
        var gui = new GuiInfo { Size = (uint)Marshal.SizeOf(typeof(GuiInfo)) };
        Need(GetGUIThreadInfo(thread, ref gui) && (gui.Flags & 0x1e) == 0, "VOICE_MENU_ACTIVE");
    }
    static void VoiceBackgroundGuard(VoiceRequest request, AudioRouteProbe.NativeVoiceAudio audio)
    {
        VoiceActive();
        Need(!Stopping, "VOICE_STOPPING");
        ValidateTime(request.Binding, UtcMs());
        VoiceBoundWindowGuard(request);
        Request expected = request.Binding;
        Need(!VoiceWindowProcess(GetForegroundWindow(), expected.Pid), "VOICE_BACKGROUND_WECHAT_ACTIVATED");
        audio.CheckDefaults();
        Need(audio.ActiveSession(expected.Pid) == VoiceCaptureInstance, "VOICE_CAPTURE_CHANGED");
        VoiceActive();
        Need(Now() - Recording.StartedAt < 11000, "VOICE_RECORDING_DEADLINE");
    }
    static void VoiceBackgroundWait(VoiceRequest request, AudioRouteProbe.NativeVoiceAudio audio, int milliseconds)
    {
        long end = Now() + milliseconds;
        do
        {
            VoiceBackgroundGuard(request, audio);
            long remaining = end - Now();
            if (remaining <= 0)
                return;
            Thread.Sleep((int)Math.Min(10, remaining));
        } while (true);
    }
    static void VoiceFocusTransitionGuard(VoiceRequest request, VoiceReturnWindow other, long revision, bool cleanup)
    {
        if (!cleanup)
        {
            VoiceActive();
            Need(!Stopping, "VOICE_STOPPING");
            ValidateTime(request.Binding, UtcMs());
            if (Recording.StartedAt > 0)
                Need(Now() - Recording.StartedAt < 11000, "VOICE_RECORDING_DEADLINE");
        }
        Need(Interlocked.Read(ref Revision) == revision, "DRAFT_HUMAN_ACTIVITY_CHANGED");
        NoKeysHeld();
        VoiceBoundWindowGuard(request);
        VoiceValidateReturn(other, request.Binding);
        Need(Interlocked.Read(ref Revision) == revision, "DRAFT_HUMAN_ACTIVITY_CHANGED");
        NoKeysHeld();
    }

    static void VoiceReleaseInitialFocus(VoiceRequest request, long revision)
    {
        VoiceHandoffState state = VoiceHandoff;
        if (state == null)
            return;
        Need(state.OwnsInitialLease, "VOICE_FOCUS_HANDOFF_INVALID");
        VoiceGuard(request, revision, 1);
        NoKeysHeld();
        VoiceValidateReturn(state.InitialReturn, request.Binding);
        Need(GetForegroundWindow() == request.Binding.Window && Interlocked.Read(ref Revision) == revision,
             "DRAFT_HUMAN_ACTIVITY_CHANGED");
        state.InitialReturnAttempted = true;
        Interlocked.Exchange(ref state.Phase, 5);
        VoiceActive();
        NoKeysHeld();
        Need(GetForegroundWindow() == request.Binding.Window && Interlocked.Read(ref Revision) == revision,
             "DRAFT_HUMAN_ACTIVITY_CHANGED");
        var confirmation =
            ConfirmFocusOnce(request.Binding.Window, state.InitialReturn.Window,
                             delegate {
                                 return VoiceActivateReturnOnce(request, state.InitialReturn, state.InitialCaption,
                                                                state.InitialPointer, revision, false);
                             },
                             delegate {
                                 VoiceFocusTransitionGuard(request, state.InitialReturn, revision, false);
                                 VoiceSourceThreadGuard(request);
                             },
                             GetForegroundWindow, Now, Thread.Sleep);
        NeedFocusConfirmed(confirmation, "VOICE_FOCUS_RETURN_UNCONFIRMED");
        VoiceValidateReturn(state.InitialReturn, request.Binding);
        state.InitialReturnConfirmed = true;
        VoiceRestorePointer(request, state.InitialPointer, state.InitialReturn);
        VoiceRestoreStartVisibility(request);
        state.InitialEnded = Now();
        state.BackgroundStarted = state.InitialEnded;
        state.BackgroundEntered = true;
        Interlocked.Exchange(ref state.Phase, 1);
    }
    static long VoiceAcquireSubmitFocus(VoiceRequest request, AudioRouteProbe.NativeVoiceAudio audio)
    {
        VoiceHandoffState state = VoiceHandoff;
        Need(state != null && state.BackgroundEntered, "VOICE_FOCUS_HANDOFF_INVALID");
        // The recording deadline bounds this wait: continuous activity must not
        // turn into an unbounded recording or a forced focus change.
        long end = Math.Min(Recording.StartedAt + 10750, Now() + 1500);
        int safeGap = VoiceSafeGapMs(FocusDoubleClickTime());
        for (;;)
        {
            VoiceBackgroundGuard(request, audio);
            if (VoiceKeysReleased() && Now() - Interlocked.Read(ref LastActivity) >= safeGap)
                break;
            Need(Now() < end, "VOICE_FOCUS_SAFE_GAP_UNAVAILABLE");
            Thread.Sleep(10);
        }
        long revision = Interlocked.Read(ref Revision);
        VoiceReturnWindow current = VoiceReadReturnWindow(GetForegroundWindow());
        VoiceValidateReturn(current, request.Binding);
        NoKeysHeld();
        VoiceBackgroundGuard(request, audio);
        Need(GetForegroundWindow() == current.Window && Interlocked.Read(ref Revision) == revision &&
                 Now() - Interlocked.Read(ref LastActivity) >= safeGap,
             "DRAFT_HUMAN_ACTIVITY_CHANGED");
        state.SubmitCaption = VoiceCaptureOptionalCaption(request, current, revision, current.Window,
                                                          delegate { VoiceBackgroundGuard(request, audio); });
        state.SubmitReturn = current;
        state.LeaseRevision = revision;
        state.SubmitPointer = VoiceCapturePointer(revision);
        state.BackgroundEnded = Now();
        state.SubmitStarted = state.BackgroundEnded;
        Interlocked.Exchange(ref state.Phase, 2);
        VoiceActive();
        NoKeysHeld();
        Need(GetForegroundWindow() == current.Window && Interlocked.Read(ref Revision) == revision,
             "DRAFT_HUMAN_ACTIVITY_CHANGED");
        state.SubmitActivationAttempted = true;
        var confirmation = ConfirmFocusOnce(
            current.Window, request.Binding.Window,
            delegate {
                return VoiceActivateWechatOnce(request, current.Window, revision, delegate {
                    VoiceFocusTransitionGuard(request, current, revision, false);
                    audio.CheckDefaults();
                    Need(audio.ActiveSession(request.Binding.Pid) == VoiceCaptureInstance, "VOICE_CAPTURE_CHANGED");
                }, state.InitialReturn.Activation);
            },
            delegate {
                VoiceFocusTransitionGuard(request, current, revision, false);
                audio.CheckDefaults();
                Need(audio.ActiveSession(request.Binding.Pid) == VoiceCaptureInstance, "VOICE_CAPTURE_CHANGED");
            },
            GetForegroundWindow, Now, Thread.Sleep);
        NeedFocusConfirmed(confirmation, "VOICE_FOCUS_ACQUIRE_UNCONFIRMED");
        if (request.Uia == null)
            VoiceEnsureSubmitVisible(request, audio, current, revision, confirmation);
        state.SubmitActivationConfirmed = true;
        VoiceTrackOwnPointer(request, revision, state.SubmitPointer.Origin);
        Interlocked.Exchange(ref state.Phase, 3);
        VoiceGuard(request, revision, 1);
        NoKeysHeld();
        Need(RecordingUi(request), "VOICE_RECORDING_CONTEXT_CHANGED");
        return revision;
    }

    static void VoiceCancellationGuard(VoiceRequest request, AudioRouteProbe.NativeVoiceAudio audio, long revision)
    {
        Need(!Stopping && Interlocked.CompareExchange(ref VoiceExternalStop, 0, 0) == 0 && !Recording.SubmitAttempted,
             "VOICE_INTERRUPTION_CLEANUP_UNAVAILABLE");
        ValidateTime(request.Binding, UtcMs());
        Need(Interlocked.Read(ref Revision) == revision, "DRAFT_HUMAN_ACTIVITY_CHANGED");
        NoKeysHeld();
        VoiceBoundWindowGuard(request);
        audio.CheckDefaults();
        Need(VoiceCaptureInstance != null && audio.ActiveSession(request.Binding.Pid) == VoiceCaptureInstance,
             "VOICE_CAPTURE_CHANGED");
        Need(Interlocked.Read(ref Revision) == revision, "DRAFT_HUMAN_ACTIVITY_CHANGED");
    }
    static long VoiceAcquireCancellationFocus(VoiceRequest request, AudioRouteProbe.NativeVoiceAudio audio)
    {
        long revision = Interlocked.Read(ref Revision);
        VoiceCancellationGuard(request, audio, revision);
        var lease = new VoiceCancellationLease { Revision = revision, Active = true };
        VoiceCancellation = lease;
        if (VoiceHandoff != null)
        {
            var state = VoiceHandoff;
            long now = Now();
            if (state.InitialEnded == 0)
                state.InitialEnded = now;
            if (state.BackgroundEntered && state.BackgroundEnded == 0)
                state.BackgroundEnded = now;
            if (state.SubmitStarted > 0 && state.SubmitEnded == 0)
                state.SubmitEnded = now;
            // Input during this separate cleanup lease again aborts input; a
            // revision observed during quiet waiting is not old send authority.
            Interlocked.Exchange(ref state.Phase, 2);
            lease.Pointer = VoiceCapturePointer(revision);
        }
        IntPtr foreground = GetForegroundWindow();
        if (foreground != request.Binding.Window)
        {
            Need(VoiceHandoff != null, "VOICE_FOCUS_HANDOFF_INVALID");
            lease.Return = VoiceReadReturnWindow(foreground);
            VoiceValidateReturn(lease.Return, request.Binding);
            lease.Caption = VoiceCaptureOptionalCaption(request, lease.Return, revision, foreground, delegate {
                VoiceCancellationGuard(request, audio, revision);
            }, true);
            Action guard = delegate
            {
                VoiceCancellationGuard(request, audio, revision);
                VoiceFocusTransitionGuard(request, lease.Return, revision, true);
                VoiceSourceThreadGuard(request);
            };
            guard();
            lease.Started = Now();
            lease.ActivationAttempted = true;
            var confirmation = ConfirmFocusOnce(foreground, request.Binding.Window, delegate {
                return VoiceActivateWechatOnce(request, foreground, revision, guard,
                                               VoiceHandoff.InitialReturn.Activation);
            }, guard, GetForegroundWindow, Now, Thread.Sleep);
            NeedFocusConfirmed(confirmation, "VOICE_FOCUS_ACQUIRE_UNCONFIRMED");
        }
        else
            lease.Started = Now();
        VoiceCancellationGuard(request, audio, revision);
        VoiceCancelWindowGuard(request, revision);
        return revision;
    }
    static bool VoiceMayReturnCancellation(bool activationAttempted, bool foregroundOwned, bool unchangedRevision,
                                           bool keysReleased)
    {
        return activationAttempted && foregroundOwned && unchangedRevision && keysReleased;
    }
    static void VoiceFinishCancellationFocus(VoiceRequest request)
    {
        var lease = VoiceCancellation;
        if (lease == null)
            return;
        try
        {
            if (lease.Return == null)
            {
                lease.Returned =
                    GetForegroundWindow() == request.Binding.Window && Interlocked.Read(ref Revision) == lease.Revision;
                return;
            }
            if (!VoiceMayReturnCancellation(lease.ActivationAttempted, GetForegroundWindow() == request.Binding.Window,
                                            Interlocked.Read(ref Revision) == lease.Revision, VoiceKeysReleased()))
                return;
            VoiceValidateReturn(lease.Return, request.Binding);
            if (VoiceHandoff != null)
                Interlocked.Exchange(ref VoiceHandoff.Phase, 5);
            var confirmation =
                ConfirmFocusOnce(request.Binding.Window, lease.Return.Window,
                                 delegate {
                                     return VoiceActivateReturnOnce(request, lease.Return, lease.Caption, lease.Pointer,
                                                                    lease.Revision, true);
                                 },
                                 delegate {
                                     VoiceFocusTransitionGuard(request, lease.Return, lease.Revision, true);
                                     VoiceSourceThreadGuard(request);
                                 },
                                 GetForegroundWindow, Now, Thread.Sleep);
            lease.Returned = confirmation.Confirmed;
            if (lease.Returned)
                VoiceRestorePointer(request, lease.Pointer, lease.Return);
        }
        catch
        {
        }
        finally
        {
            lease.Ended = Now();
            lease.Finished = true;
            lease.Active = false;
            if (VoiceHandoff != null)
                Interlocked.Exchange(ref VoiceHandoff.Phase, 4);
        }
    }

    static void VoiceFinishFocusHandoff(VoiceRequest request, bool observeSubmitted = false)
    {
        VoiceHandoffState state = VoiceHandoff;
        if (state == null)
            return;
        // The submit lease already ended before its read-only end observation.
        // Cleanup must neither reactivate a window nor extend that interval.
        int completedPhase = Interlocked.CompareExchange(ref state.Phase, 0, 0);
        if (completedPhase == 6 || completedPhase == 7)
        {
            if (state.BackgroundEntered && state.BackgroundEnded == 0)
                state.BackgroundEnded = Now();
            Interlocked.Exchange(ref state.Phase, 4);
            return;
        }
        if (VoiceCancellation != null && VoiceCancellation.Finished)
            return;
        if (!state.OwnsInitialLease)
        {
            if (state.InitialStarted > 0)
                state.InitialEnded = Now();
            Interlocked.Exchange(ref state.Phase, 4);
            return;
        }
        int phase = Interlocked.CompareExchange(ref state.Phase, 0, 0);
        long now = Now();
        if (state.BackgroundEntered && state.BackgroundEnded == 0)
            state.BackgroundEnded = now;
        // A background failure never reactivates WeChat to cancel blindly. An
        // uncertain recording retains its existing durable stop barrier.
        if (phase == 1 && state.InitialReturnConfirmed)
        {
            Interlocked.Exchange(ref state.Phase, 4);
            return;
        }
        bool submit = state.SubmitActivationAttempted;
        VoiceReturnWindow target = submit ? state.SubmitReturn : state.InitialReturn;
        try
        {
            bool owned = GetForegroundWindow() == request.Binding.Window,
                 unchanged = Interlocked.Read(ref Revision) == state.LeaseRevision;
            if (!owned || !unchanged)
            {
                state.ReturnSkippedForHumanInput = true;
                var pointer = submit ? state.SubmitPointer : state.InitialPointer;
                if (pointer != null)
                    pointer.Skipped = true;
                return;
            }
            VoiceValidateReturn(target, request.Binding);
            Need(VoiceMayRestore(GetForegroundWindow() == request.Binding.Window, true,
                                 Interlocked.Read(ref Revision) == state.LeaseRevision, VoiceKeysReleased()),
                 "VOICE_FOCUS_RETURN_UNCONFIRMED");
            if (submit)
                state.FinalReturnAttempted = true;
            else
                state.InitialReturnAttempted = true;
            // The returning phase still rejects input in WeChat, while resumed
            // typing in the user's window does not invalidate the sent message.
            Interlocked.Exchange(ref state.Phase, 5);
            var confirmation = ConfirmFocusOnce(
                request.Binding.Window, target.Window,
                delegate {
                    return VoiceActivateReturnOnce(request, target, submit ? state.SubmitCaption : state.InitialCaption,
                                                   submit ? state.SubmitPointer : state.InitialPointer,
                                                   state.LeaseRevision, true);
                },
                delegate {
                    VoiceFocusTransitionGuard(request, target, state.LeaseRevision, true);
                    VoiceSourceThreadGuard(request);
                },
                GetForegroundWindow, Now, Thread.Sleep);
            bool confirmed = confirmation.Confirmed;
            if (submit)
                state.FinalReturnConfirmed = confirmed;
            else
                state.InitialReturnConfirmed = confirmed;
            if (confirmed)
                VoiceRestorePointer(request, submit ? state.SubmitPointer : state.InitialPointer, target);
        }
        catch
        {
        }
        finally
        {
            if (submit)
                state.SubmitEnded = Now();
            else if (state.InitialEnded == 0)
                state.InitialEnded = Now();
            Interlocked.Exchange(ref state.Phase, observeSubmitted && submit && state.FinalReturnConfirmed ? 6 : 4);
        }
    }
    static long VoiceElapsed(long start, long end)
    {
        return start <= 0 ? 0 : Math.Max(0, (end > 0 ? end : Now()) - start);
    }
    static object VoiceFocusHandoffReport()
    {
        VoiceHandoffState state = VoiceHandoff;
        if (state == null)
            return null;
        var report = Data(
            "version", 1, "initialReturnAttempted", state.InitialReturnAttempted, "initialReturnConfirmed",
            state.InitialReturnConfirmed, "backgroundEntered", state.BackgroundEntered, "backgroundActivityObserved",
            Interlocked.CompareExchange(ref state.BackgroundActivity, 0, 0) != 0, "submitActivationAttempted",
            state.SubmitActivationAttempted, "submitActivationConfirmed", state.SubmitActivationConfirmed,
            "finalReturnAttempted", state.FinalReturnAttempted, "finalReturnConfirmed", state.FinalReturnConfirmed,
            "returnSkippedForHumanInput", state.ReturnSkippedForHumanInput, "initialPointerRestored",
            state.InitialPointer != null && state.InitialPointer.Restored, "finalPointerRestored",
            state.SubmitPointer != null && state.SubmitPointer.Restored, "pointerRestoreSkipped",
            state.InitialPointer != null && state.InitialPointer.Skipped ||
                state.SubmitPointer != null && state.SubmitPointer.Skipped,
            "initialForegroundElapsedMs", VoiceElapsed(state.InitialStarted, state.InitialEnded), "backgroundElapsedMs",
            VoiceElapsed(state.BackgroundStarted, state.BackgroundEnded), "submitForegroundElapsedMs",
            VoiceElapsed(state.SubmitStarted, state.SubmitEnded));
        var intervals = new List<object>();
        if (state.ContinuousInitialStarted > 0)
            intervals.Add(Data("phase", "record-start", "durationMs",
                               VoiceElapsed(state.ContinuousInitialStarted, state.InitialEnded),
                               "includesContactNavigation", state.InitialReturn.IncludesContactNavigation, "complete",
                               state.InitialReturnConfirmed && state.InitialEnded > 0));
        if (state.SubmitActivationAttempted && state.SubmitStarted > 0)
            intervals.Add(Data("phase", "record-submit", "durationMs",
                               VoiceElapsed(state.SubmitStarted, state.SubmitEnded), "includesContactNavigation", false,
                               "complete", state.FinalReturnConfirmed && state.SubmitEnded > 0));
        if (state.BackgroundSubmit != null && state.BackgroundSubmit.Attempted)
        {
            report.Add("backgroundSubmit", state.BackgroundSubmit.Report());
            intervals.Add(
                Data("phase", "record-submit", "durationMs",
                     state.BackgroundSubmit.AutoActivated ? VoiceElapsed(state.SubmitStarted, state.SubmitEnded) : 0,
                     "includesContactNavigation", false, "complete",
                     state.BackgroundSubmit.Confirmed &&
                         (state.BackgroundSubmit.AutoActivated
                              ? state.BackgroundSubmit.AutoReturnConfirmed && state.SubmitEnded > 0
                              : state.BackgroundSubmit.ForegroundUnchanged)));
        }
        if (VoiceCancellation != null && VoiceCancellation.Started > 0)
            intervals.Add(Data("phase", "record-cancel", "durationMs",
                               VoiceElapsed(VoiceCancellation.Started, VoiceCancellation.Ended),
                               "includesContactNavigation", false, "complete",
                               VoiceCancellation.Returned && VoiceCancellation.Ended > 0));
        if (intervals.Count > 0)
            report.Add("foregroundIntervals", intervals);
        if (state.InitialCaption != null)
            report.Add("initialCaption", VoiceCaptionReport(state.InitialCaption));
        if (state.SubmitCaption != null)
            report.Add("submitCaption", VoiceCaptionReport(state.SubmitCaption));
        if (state.SubmitVisibility != null)
            report.Add("submitVisibility", state.SubmitVisibility);
        if (state.StartVisibility != null)
            report.Add("startVisibility", state.StartVisibility);
        if (state.StartVisibilityRestore != null)
            report.Add("startVisibilityRestore", state.StartVisibilityRestore);
        return report;
    }
    static object RunVoiceWithFocusHandoff(VoiceRequest request)
    {
        if (request.FocusHandoff == null)
            return RunVoice(request);
        VoiceHandoff = new VoiceHandoffState { InitialReturn = request.FocusHandoff,
                                               WechatWindow = request.Binding.Window, WechatPid = request.Binding.Pid,
                                               LeaseRevision = Interlocked.Read(ref Revision), InitialStarted = Now() };
        Exception failure = null;
        // Shared GetTickCount64 origin spans the Qt/native process handoff.
        // Invalid/legacy diagnostic timestamps cannot authorize or block input.
        long inherited = request.FocusHandoff.ForegroundStarted;
        if (inherited > 0 && inherited <= VoiceHandoff.InitialStarted &&
            VoiceHandoff.InitialStarted - inherited <= 300000)
            VoiceHandoff.ContinuousInitialStarted = inherited;
        VoiceBeforeCaptionDpi = VoiceThreadDpiReport();
        try
        {
            VoiceGuard(request, VoiceHandoff.LeaseRevision, 0);
            Binding initial = Snapshot(request.Binding.Window, request.Binding.Executable);
            Need(initial.InputTick == request.Binding.InputTick, "DRAFT_CALIBRATION_ACTIVITY_CHANGED");
            VoiceHandoff.WechatThread = initial.Thread;
            Need(FocusGetWindowRect(request.Binding.Window, out VoiceHandoff.WechatBounds),
                 "VOICE_FOCUS_SOURCE_CHANGED");
            VoiceHandoff.OwnsInitialLease = true;
            VoiceHandoff.InitialPointer = VoiceCapturePointer(VoiceHandoff.LeaseRevision);
            VoiceValidateReturn(request.FocusHandoff, request.Binding);
            VoiceHandoff.InitialCaption = VoiceCaptureOptionalCaption(
                request, request.FocusHandoff, VoiceHandoff.LeaseRevision, request.Binding.Window, null);
            RunVoice(request);
        }
        catch (Exception error)
        {
            failure = error;
        }
        finally
        {
            VoiceRestoreStartVisibility(request);
            VoiceFinishFocusHandoff(request);
        }
        if (failure != null)
            throw failure;
        VoiceActive();
        var background = VoiceHandoff.BackgroundSubmit;
        bool submitComplete =
            background == null
                ? VoiceHandoff.SubmitActivationConfirmed && VoiceHandoff.FinalReturnConfirmed
                : request.Uia != null && background.Attempted && background.Applied && background.Confirmed &&
                      !VoiceHandoff.SubmitActivationAttempted && !VoiceHandoff.SubmitActivationConfirmed &&
                      (background.AutoActivated
                           ? background.AutoReturnConfirmed && VoiceHandoff.FinalReturnConfirmed
                           : !VoiceHandoff.FinalReturnAttempted && !VoiceHandoff.FinalReturnConfirmed);
        Need(VoiceHandoff.InitialReturnConfirmed && VoiceHandoff.BackgroundEntered && submitComplete,
             "VOICE_FOCUS_RETURN_UNCONFIRMED");
        return VoiceReport(true, null);
    }
    static int VoiceFocusHandoffSelfTest()
    {
        int checks = 0;
        Request binding = Parse(FixtureRequest());
        checks += FocusConfirmationSelfTest();
        Need(ParseVoiceHandoff(null, binding) == null, "TEST_HANDOFF_LEGACY");
        checks++;
        var value =
            Data("version", 1, "returnWindow", Data("hwnd", "200", "pid", 99, "processCreatedFileTimeUtc", "456"));
        VoiceReturnWindow window = ParseVoiceHandoff(value, binding);
        Need(window.Window == new IntPtr(200) && window.Pid == 99 && window.Created == 456, "TEST_HANDOFF_IDENTITY");
        checks++;
        value["activation"] = Data("rect", new Rect(350, 8, 450, 22).Report(), "rgbaSha256", new string('a', 64));
        Need(ParseVoiceHandoff(value, binding).Activation.Hash == new string('a', 64),
             "TEST_HANDOFF_CLICK_CALIBRATION");
        checks++;
        value["activation"] = null;
        Expect(delegate { ParseVoiceHandoff(value, binding); }, "VOICE_FOCUS_HANDOFF_INVALID");
        checks++;
        value.Remove("activation");
        Map(Get(value, "returnWindow"))["pid"] = 42;
        Expect(delegate { ParseVoiceHandoff(value, binding); }, "VOICE_FOCUS_HANDOFF_INVALID");
        Map(Get(value, "returnWindow"))["pid"] = 99;
        checks++;
        Map(Get(value, "returnWindow"))["pid"] = 0;
        Expect(delegate { ParseVoiceHandoff(value, binding); }, "VOICE_FOCUS_HANDOFF_INVALID");
        Map(Get(value, "returnWindow"))["pid"] = 99;
        checks++;
        Map(Get(value, "returnWindow"))["hwnd"] = "100";
        Expect(delegate { ParseVoiceHandoff(value, binding); }, "VOICE_FOCUS_HANDOFF_INVALID");
        Map(Get(value, "returnWindow"))["hwnd"] = "200";
        checks++;
        value["unexpected"] = true;
        Expect(delegate { ParseVoiceHandoff(value, binding); }, "VOICE_FOCUS_HANDOFF_INVALID");
        value.Remove("unexpected");
        checks++;
        Need(VoiceSameReturn(window, new VoiceReturnWindow { Window = window.Window, Pid = 99, Created = 456 }) &&
                 !VoiceSameReturn(window, new VoiceReturnWindow { Window = window.Window, Pid = 99, Created = 457 }) &&
                 !VoiceSameReturn(window, new VoiceReturnWindow { Window = window.Window, Pid = 98, Created = 456 }),
             "TEST_HANDOFF_HANDLE_REUSE");
        checks++;
        for (int flags = 0; flags < 16; flags++)
            Need(VoiceMayRestore((flags & 1) != 0, (flags & 2) != 0, (flags & 4) != 0, (flags & 8) != 0) ==
                     (flags == 15),
                 "TEST_HANDOFF_RESTORE_GUARDS");
        checks++;
        for (int flags = 0; flags < 16; flags++)
            Need(VoiceMayReturnCancellation((flags & 1) != 0, (flags & 2) != 0, (flags & 4) != 0, (flags & 8) != 0) ==
                     (flags == 15),
                 "TEST_CANCEL_RETURN_REQUIRES_THIS_LEASE_ACTIVATION_ATTEMPT");
        checks++;
        for (int flags = 0; flags < 64; flags++)
            Need(VoiceMayRestorePointer((flags & 1) != 0, (flags & 2) != 0, (flags & 4) != 0, (flags & 8) != 0,
                                        (flags & 16) != 0, (flags & 32) != 0) == (flags == 63),
                 "TEST_POINTER_RETURN_REQUIRES_ALL_GUARDS");
        checks++;
        Need(VoicePointerNear(new Point(-100, 200), new Point(-101, 201)) &&
                 !VoicePointerNear(new Point(-100, 200), new Point(-102, 200)) &&
                 VoicePointerIn(new Rect(-1920, 0, 1920, 1080), new Point(-800, 600)) &&
                 !VoicePointerIn(new Rect(-1920, 0, 1920, 1080), new Point(1920, 600)),
             "TEST_POINTER_ORIGIN_BOUNDS_AND_ROUNDING");
        checks++;
        long pointerRevision = Interlocked.Read(ref VoicePointerRevision),
             activityRevision = Interlocked.Read(ref Revision);
        VoiceNotePointerActivity(true);
        Need(Interlocked.Read(ref VoicePointerRevision) == pointerRevision, "TEST_POINTER_OWN_INPUT_IGNORED");
        VoiceNotePointerActivity(false);
        Need(Interlocked.Read(ref VoicePointerRevision) == pointerRevision + 1 &&
                 Interlocked.Read(ref Revision) == activityRevision,
             "TEST_POINTER_FOREIGN_INPUT_HAS_INDEPENDENT_REVISION");
        Interlocked.Exchange(ref VoicePointerRevision, pointerRevision);
        checks++;
        for (int phase = 0; phase <= 7; phase++)
            for (int flags = 0; flags < 4; flags++)
                Need(VoiceMayAllowBackgroundInput(phase, (flags & 1) != 0, (flags & 2) != 0) ==
                         ((phase == 1 || phase == 6 || phase == 7) && flags == 0),
                     "TEST_HANDOFF_ACTIVITY_PHASES");
        checks++;
        for (int flags = 0; flags < 64; flags++)
            for (int phase = 0; phase <= 7; phase++)
                Need(VoiceMaySubmitInBackground((flags & 1) != 0, (flags & 2) != 0, (flags & 4) != 0, phase,
                                                (flags & 8) != 0, (flags & 16) != 0,
                                                (flags & 32) != 0) == (flags == 31 && phase == 1),
                     "TEST_BACKGROUND_SUBMIT_REQUIRES_ORIGINAL_UIA_BOUND_RECORDING");
        checks++;
        Need(!VoiceMouseButton(0x200) && VoiceMouseButton(0x201) && VoiceMouseButton(0x20a) && VoiceMouseButton(0x20e),
             "TEST_HANDOFF_MOUSE_INTERACTION");
        checks++;
        VoiceHandoff = new VoiceHandoffState {
            InitialReturn = window,
            InitialStarted = 10,
            InitialEnded = 25,
            BackgroundStarted = 25,
            BackgroundEnded = 525,
            SubmitStarted = 525,
            SubmitEnded = 575,
            InitialPointer = new VoicePointerLease { Origin = new Point(7183, 9914), Restored = true },
            SubmitPointer = new VoicePointerLease { Origin = new Point(6231, 8841), Skipped = true }
        };
        try
        {
            Need(Object.ReferenceEquals(VoiceCurrentPointer(), VoiceHandoff.InitialPointer),
                 "TEST_POINTER_FIRST_LEASE");
            VoiceHandoff.SubmitActivationAttempted = true;
            Need(Object.ReferenceEquals(VoiceCurrentPointer(), VoiceHandoff.SubmitPointer),
                 "TEST_POINTER_SECOND_LEASE_HAS_SEPARATE_ORIGIN");
            checks++;
            var report = Map(VoiceFocusHandoffReport());
            Need(report.Count == 17 && Object.Equals(Get(report, "initialPointerRestored"), true) &&
                     Object.Equals(Get(report, "finalPointerRestored"), false) &&
                     Object.Equals(Get(report, "pointerRestoreSkipped"), true) &&
                     Number(Get(report, "initialForegroundElapsedMs")) == 15 &&
                     Number(Get(report, "backgroundElapsedMs")) == 500 &&
                     Number(Get(report, "submitForegroundElapsedMs")) == 50 &&
                     !Json.Serialize(report).Contains("hwnd") &&
                     !Json.Serialize(report).Contains("processCreatedFileTimeUtc") &&
                     !Json.Serialize(report).Contains("7183") && !Json.Serialize(report).Contains("9914"),
                 "TEST_HANDOFF_REPORT_TIMING_AND_PRIVACY");
            checks++;
            var intervals = (List<object>)Get(report, "foregroundIntervals");
            Need(intervals.Count == 1 && Text(Map(intervals[0]), "phase") == "record-submit" &&
                     !Object.Equals(Get(Map(intervals[0]), "complete"), true),
                 "TEST_LEGACY_START_NOT_FABRICATED");
            checks++;
            VoiceHandoff.ContinuousInitialStarted = 5;
            VoiceHandoff.InitialReturnConfirmed = true;
            VoiceHandoff.InitialReturn.IncludesContactNavigation = true;
            intervals = (List<object>)Get(Map(VoiceFocusHandoffReport()), "foregroundIntervals");
            Need(intervals.Count == 2 && Number(Get(Map(intervals[0]), "durationMs")) == 20 &&
                     Object.Equals(Get(Map(intervals[0]), "includesContactNavigation"), true) &&
                     Object.Equals(Get(Map(intervals[0]), "complete"), true),
                 "TEST_CONTINUOUS_INITIAL_INCLUDES_QT");
            checks++;
            VoiceHandoff.InitialReturnConfirmed = false;
            VoiceHandoff.FinalReturnConfirmed = true;
            intervals = (List<object>)Get(Map(VoiceFocusHandoffReport()), "foregroundIntervals");
            Need(!Object.Equals(Get(Map(intervals[0]), "complete"), true) &&
                     Object.Equals(Get(Map(intervals[1]), "complete"), true) &&
                     Number(Get(Map(intervals[1]), "durationMs")) == 50,
                 "TEST_CONTINUOUS_INTERVALS_INDEPENDENT_COMPLETION");
            checks++;
            VoiceHandoff.Phase = 6;
            long submittedReturnEnded = VoiceHandoff.SubmitEnded;
            VoiceFinishFocusHandoff(null);
            Need(VoiceHandoff.Phase == 4 && VoiceHandoff.SubmitEnded == submittedReturnEnded &&
                     VoiceHandoff.FinalReturnConfirmed,
                 "TEST_SUBMITTED_OBSERVATION_CLEANUP_PRESERVES_RETURN_TIME_WITHOUT_WINDOW_ACCESS");
            checks++;
            VoiceCancellation =
                new VoiceCancellationLease { Active = true, Started = 700, Ended = 1000, Returned = false,
                                             Pointer = new VoicePointerLease { Origin = new Point(100, 200) } };
            Need(Object.ReferenceEquals(VoiceCurrentPointer(), VoiceCancellation.Pointer),
                 "TEST_CANCEL_POINTER_IS_SEPARATE_FROM_OLD_SUBMIT_LEASE");
            checks++;
            intervals = (List<object>)Get(Map(VoiceFocusHandoffReport()), "foregroundIntervals");
            Need(intervals.Count == 3 && Text(Map(intervals[2]), "phase") == "record-cancel" &&
                     Number(Get(Map(intervals[2]), "durationMs")) == 300 &&
                     !Object.Equals(Get(Map(intervals[2]), "complete"), true),
                 "TEST_CANCEL_INTERVAL_RETAINED_WITHOUT_COMPLETION_CLAIM");
            checks++;
            VoiceCancellation.Returned = true;
            intervals = (List<object>)Get(Map(VoiceFocusHandoffReport()), "foregroundIntervals");
            Need(Object.Equals(Get(Map(intervals[2]), "complete"), true) &&
                     !Json.Serialize(intervals).Contains("Pointer"),
                 "TEST_CANCEL_INTERVAL_ONLY_ANONYMOUS_OBSERVED_RETURN");
            checks++;
            VoiceCancellation = null;
            VoiceHandoff = new VoiceHandoffState {
                Phase = 7,
                InitialReturn = new VoiceReturnWindow(),
                InitialReturnConfirmed = true,
                BackgroundEntered = true,
                BackgroundStarted = 10,
                BackgroundEnded = 50,
                BackgroundSubmit = new VoiceBackgroundSubmission { Attempted = true, Applied = true, Confirmed = true,
                                                                   ForegroundUnchanged = true }
            };
            VoiceFinishFocusHandoff(null);
            var backgroundReport = Map(VoiceFocusHandoffReport());
            var backgroundPacket = Map(Get(backgroundReport, "backgroundSubmit"));
            intervals = (List<object>)Get(backgroundReport, "foregroundIntervals");
            Need(VoiceHandoff.Phase == 4 && backgroundPacket.Count == 5 &&
                     Object.Equals(Get(backgroundPacket, "confirmed"), true) &&
                     !VoiceHandoff.SubmitActivationAttempted && !VoiceHandoff.SubmitActivationConfirmed &&
                     !VoiceHandoff.FinalReturnAttempted && !VoiceHandoff.FinalReturnConfirmed &&
                     Number(Get(backgroundReport, "submitForegroundElapsedMs")) == 0 && intervals.Count == 1 &&
                     Number(Get(Map(intervals[0]), "durationMs")) == 0 &&
                     Object.Equals(Get(Map(intervals[0]), "complete"), true),
                 "TEST_BACKGROUND_SUBMIT_REPORT_ZERO_HOLD_WITHOUT_FABRICATED_FOCUS_RETURN");
            checks++;
            VoiceHandoff.BackgroundSubmit.ForegroundUnchanged = false;
            intervals = (List<object>)Get(Map(VoiceFocusHandoffReport()), "foregroundIntervals");
            Need(VoiceHandoff.BackgroundSubmit.Confirmed && !Object.Equals(Get(Map(intervals[0]), "complete"), true),
                 "TEST_BACKGROUND_OTHER_APP_FOCUS_CHANGE_PRESERVES_CONFIRMED_SUBMIT_BUT_NOT_UNCHANGED_CLAIM");
            checks++;
            VoiceHandoff.BackgroundSubmit.AutoActivated = true;
            VoiceHandoff.BackgroundSubmit.AutoReturnAttempted = true;
            VoiceHandoff.BackgroundSubmit.AutoReturnConfirmed = true;
            VoiceHandoff.BackgroundSubmit.AutoReturnActivityUnchanged = true;
            VoiceHandoff.SubmitStarted = 800;
            VoiceHandoff.SubmitEnded = 925;
            VoiceHandoff.FinalReturnAttempted = true;
            VoiceHandoff.FinalReturnConfirmed = true;
            var autoReport = Map(VoiceFocusHandoffReport());
            var autoReturn = Map(Get(Map(Get(autoReport, "backgroundSubmit")), "activationReturn"));
            intervals = (List<object>)Get(autoReport, "foregroundIntervals");
            Need(!VoiceHandoff.SubmitActivationAttempted && !VoiceHandoff.SubmitActivationConfirmed &&
                     Number(Get(autoReport, "submitForegroundElapsedMs")) == 125 &&
                     Number(Get(Map(intervals[0]), "durationMs")) == 125 &&
                     Object.Equals(Get(Map(intervals[0]), "complete"), true) &&
                     Object.Equals(Get(autoReturn, "observed"), true) &&
                     Object.Equals(Get(autoReturn, "confirmed"), true),
                 "TEST_BACKGROUND_AUTO_ACTIVATION_RECORDS_REAL_RETURN_INTERVAL_WITHOUT_FABRICATED_ACQUIRE");
            checks++;
            VoiceHandoff.SubmitStarted = VoiceHandoff.SubmitEnded = 0;
            VoiceHandoff.FinalReturnAttempted = VoiceHandoff.FinalReturnConfirmed = false;
            VoiceHandoff.BackgroundSubmit = new VoiceBackgroundSubmission();
            VoiceCancellation =
                new VoiceCancellationLease { Started = 700, Ended = 750, Returned = true, Finished = true };
            var cancelledBeforeSubmit = Map(VoiceFocusHandoffReport());
            intervals = (List<object>)Get(cancelledBeforeSubmit, "foregroundIntervals");
            Need(!cancelledBeforeSubmit.ContainsKey("backgroundSubmit") && intervals.Count == 1 &&
                     Text(Map(intervals[0]), "phase") == "record-cancel" &&
                     Object.Equals(Get(Map(intervals[0]), "complete"), true),
                 "TEST_BACKGROUND_PREINPUT_REFUSAL_CANCEL_HAS_NO_SUBMIT_REPORT_OR_INTERVAL");
            checks++;
            VoiceCancellation = null;
            VoiceHandoff.BackgroundSubmit.Attempted = true;
            var partialBackground = Map(VoiceFocusHandoffReport());
            intervals = (List<object>)Get(partialBackground, "foregroundIntervals");
            Need(partialBackground.ContainsKey("backgroundSubmit") && intervals.Count == 1 &&
                     Text(Map(intervals[0]), "phase") == "record-submit" &&
                     !Object.Equals(Get(Map(intervals[0]), "complete"), true),
                 "TEST_BACKGROUND_PARTIAL_ATTEMPT_REMAINS_EXPLICIT_AND_UNCONFIRMED");
            checks++;
        }
        finally
        {
            VoiceHandoff = null;
            VoiceCancellation = null;
        }
        value["foregroundLease"] = Data("version", 1, "startedAtTickMs", 123, "includesContactNavigation", true);
        Need(ParseVoiceHandoff(value, binding).ForegroundStarted == 123 &&
                 ParseVoiceHandoff(value, binding).IncludesContactNavigation,
             "TEST_FOREGROUND_LEASE_PARSE");
        checks++;
        foreach (object invalid in new object[] {
                     Data("version", 2, "startedAtTickMs", 123, "includesContactNavigation", true),
                     Data("version", 1, "startedAtTickMs", 0, "includesContactNavigation", true),
                     Data("version", 1, "startedAtTickMs", 123, "includesContactNavigation", "true"),
                     Data("version", 1, "startedAtTickMs", 123, "includesContactNavigation", true, "private", "x")
                 })
        {
            value["foregroundLease"] = invalid;
            Expect(delegate { ParseVoiceHandoff(value, binding); }, "VOICE_FOCUS_HANDOFF_INVALID");
            checks++;
        }
        return checks;
    }
}
