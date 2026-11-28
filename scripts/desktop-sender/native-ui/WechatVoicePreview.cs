// Bounded native recording. Preview and verified Qt private-chat protocols are
// distinct. No microphone capture, default changes or automatic retry.
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

internal static class WechatVoicePreview
{
    [STAThread]
    static int Main(string[] args)
    {
        return WechatDraftProbe.VoiceMain(args);
    }
}

internal static partial class WechatDraftProbe
{
    static int VoiceCancelled, VoiceExternalStop;
    static string VoiceStopReason;
    static RecordingAttempt Recording = new RecordingAttempt();
    static bool CancelAttempted, CancelInputApplied;
    static string VoiceCancellationStage, VoiceCancellationFailure;
    static bool VoiceAudioStarted, VoiceAudioComplete, VoiceCaptureVerified;
    static long VoiceCaptureMs, VoicePlayMs, VoiceDrainMs;
    static double VoiceDurationMs;
    static object VoicePumpDiagnostic;
    static object VoiceAdaptiveDiagnostic;
    static object VoiceButtonHitDiagnostic, VoiceBeforeCaptionDpi;
    [DllImport("user32.dll", EntryPoint = "GetClassNameW", CharSet = CharSet.Unicode)]
    static extern int VoiceGetClassName(IntPtr window, StringBuilder name, int maximum);
    [DllImport("user32.dll", EntryPoint = "GetThreadDpiAwarenessContext")]
    static extern IntPtr VoiceGetThreadDpiContext();
    [DllImport("user32.dll", EntryPoint = "GetAwarenessFromDpiAwarenessContext")]
    static extern int VoiceGetDpiAwareness(IntPtr context);
    [DllImport("user32.dll", EntryPoint = "AreDpiAwarenessContextsEqual")]
    static extern bool VoiceDpiContextsEqual(IntPtr left, IntPtr right);
    static object VoiceThreadDpiReport()
    {
        try
        {
            IntPtr context = VoiceGetThreadDpiContext();
            return Data("context", context.ToInt64().ToString(CultureInfo.InvariantCulture), "awareness",
                        VoiceGetDpiAwareness(context), "perMonitorV2", VoiceDpiContextsEqual(context, new IntPtr(-4)));
        }
        catch
        {
            return null;
        }
    }
    static string VoiceWindowClass(IntPtr window)
    {
        var name = new StringBuilder(256);
        return VoiceGetClassName(window, name, name.Capacity) > 0 ? name.ToString() : "";
    }
    static object VoiceHitWindowReport(IntPtr window)
    {
        uint pid = 0, rootPid = 0;
        uint thread = GetWindowThreadProcessId(window, out pid);
        IntPtr root = GetAncestor(window, 2);
        GetWindowThreadProcessId(root, out rootPid);
        Rect area;
        return Data("hwnd", window.ToInt64().ToString(CultureInfo.InvariantCulture), "pid", pid, "threadId", thread,
                    "className", VoiceWindowClass(window), "rootHwnd",
                    root.ToInt64().ToString(CultureInfo.InvariantCulture), "rootPid", rootPid, "rootClassName",
                    VoiceWindowClass(root), "rootRect", FocusGetWindowRect(root, out area) ? area.Report() : null);
    }
    static void VoiceRequireButtonHit(VoiceRequest request, Point point, int phase)
    {
        IntPtr hit = WindowFromPoint(point);
        if (Owned(hit, request.Binding.Window, request.Binding.Pid))
            return;
        // Read only, failure only: no title/text, pixels, input or DPI mutation.
        try
        {
            VoiceButtonHitDiagnostic =
                Data("version", 1, "readOnly", true, "phase", phase, "point", new[] { point.X, point.Y },
                     "expectedHwnd", request.Binding.Window.ToInt64().ToString(CultureInfo.InvariantCulture),
                     "expectedPid", request.Binding.Pid, "expectedDpi", request.Binding.Dpi, "captureRect",
                     request.Binding.Capture.Report(), "hit", VoiceHitWindowReport(hit), "foreground",
                     VoiceHitWindowReport(GetForegroundWindow()), "threadId", GetCurrentThreadId(), "threadDpi",
                     VoiceThreadDpiReport(), "beforeCaptionDpi", VoiceBeforeCaptionDpi);
        }
        catch
        {
        }
        throw new Fault("VOICE_BUTTON_OBSCURED");
    }
    static AudioRouteProbe.NativeVoiceAudio VoiceAudio;
    static string VoiceCaptureInstance;
    static bool VoiceMouseDiagnostic, VoiceProduction, MouseMoveAttempted, MouseMoveInputApplied;
    static int VoiceOwnMouseObserved;
    static int VoiceMouseParkMovesApplied;
    sealed class VoiceActivityDiagnostic
    {
        internal string Kind;
        internal bool Injected, OwnMarker, Lower32Matches, MarkerIsZero;
        internal uint Message;
        internal long? TimeAfterRecordStartMs;
        internal object Report()
        {
            return Data("kind", Kind, "injected", Injected, "ownMarker", OwnMarker, "lower32Matches", Lower32Matches,
                        "markerIsZero", MarkerIsZero, "message", Message, "timeAfterRecordStartMs",
                        TimeAfterRecordStartMs);
        }
    }
    static VoiceActivityDiagnostic VoiceHumanActivity;
    static readonly HookProc VoiceKeyboardCallback = OnVoiceKeyboard, VoiceMouseCallback = OnVoiceMouse;
    // 0 legacy startup; 1 read-only monitor; 2 one committed execution; 3 done.
    internal static int VoiceMain(string[] args)
    {
        if (args.Length > 0 && args[0] == "--adaptive-layout-check")
            return VoiceAdaptiveImageCheck(args);
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        if (args.Length == 1 && args[0] == "--self-test")
            return VoiceSelfTest();
        if (args.Length == 1 && args[0] == "--private-warm")
            return VoiceWarmMain();
        VoiceMouseDiagnostic = args.Length == 1 && args[0] == "--private-mouse-diagnostic";
        VoiceProduction = args.Length == 1 && args[0] == "--private-send";
        using (var hard = new System.Threading.Timer(delegate {
            StopVoice("VOICE_HARD_TIMEOUT");
            Environment.Exit(124);
        }, null, VoiceMouseDiagnostic ? 5000 : 18000, Timeout.Infinite))
        {
            try
            {
                Need(VoiceMouseDiagnostic || VoiceProduction || (args.Length == 1 && args[0] == "--private-once"),
                     "VOICE_ARGUMENTS_INVALID");
                var value = Map(Json.DeserializeObject(ReadLine()));
                VoiceRequest request = VoiceMouseDiagnostic ? ParseMouseDiagnostic(value)
                                       : VoiceProduction    ? ParseVoiceSend(value)
                                                            : ParseVoice(value);
                if (request.FocusHandoff != null)
                    VoiceHandoff = new VoiceHandoffState { InitialReturn = request.FocusHandoff,
                                                           WechatWindow = request.Binding.Window,
                                                           WechatPid = request.Binding.Pid };
                SetProcessDpiAwarenessContext(new IntPtr(-4));
                Gate = Acquire("Local\\WeChatAgent.UiInput.v1");
                using (var audioGate = Acquire("Local\\WeChatAgent.AudioProbe.v1"))
                {
                    try
                    {
                        LastActivity = ActivityMonitorStarted = Now();
                        VoiceStartCaptionMonitor();
                        using (var process = Process.GetCurrentProcess())
                        {
                            IntPtr module = GetModuleHandle(process.MainModule.ModuleName);
                            KeyboardHook = SetWindowsHookEx(13, VoiceKeyboardCallback, module, 0);
                            MouseHook = SetWindowsHookEx(14, VoiceMouseCallback, module, 0);
                        }
                        Need(KeyboardHook != IntPtr.Zero && MouseHook != IntPtr.Zero,
                             "VOICE_ACTIVITY_MONITOR_UNAVAILABLE");
                        Dispatcher = new Control();
                        var owner = Dispatcher.Handle;
                        var controls = new Thread(delegate() {
                            try
                            {
                                Console.In.Read();
                            }
                            catch
                            {
                            }
                            StopVoice("VOICE_PARENT_CLOSED");
                        });
                        controls.IsBackground = true;
                        controls.Start();
                        var worker = new Thread(delegate() {
                            try
                            {
                                Write(VoiceMouseDiagnostic ? RunMouseDiagnostic(request)
                                                           : RunVoiceWithFocusHandoff(request));
                            }
                            catch (Exception error)
                            {
                                ExitCode = 1;
                                Write(VoiceFailure(error));
                            }
                            finally
                            {
                                Stopping = true;
                                try
                                {
                                    Dispatcher.BeginInvoke((Action)delegate { Application.ExitThread(); });
                                }
                                catch
                                {
                                }
                            }
                        });
                        worker.IsBackground = true;
                        worker.SetApartmentState(ApartmentState.MTA);
                        worker.Start();
                        Application.Run();
                        return ExitCode;
                    }
                    finally
                    {
                        audioGate.ReleaseMutex();
                    }
                }
            }
            catch (Exception error)
            {
                Write(VoiceFailure(error));
                return 1;
            }
            finally
            {
                Stopping = true;
                MouseObservationObserver = null;
                if (KeyboardHook != IntPtr.Zero)
                    UnhookWindowsHookEx(KeyboardHook);
                if (MouseHook != IntPtr.Zero)
                    UnhookWindowsHookEx(MouseHook);
                if (Dispatcher != null)
                    Dispatcher.Dispose();
                if (Gate != null)
                {
                    try
                    {
                        Gate.ReleaseMutex();
                    }
                    finally
                    {
                        Gate.Dispose();
                    }
                }
            }
        }
    }
    static void StopVoice(string code)
    {
        if (code != "DRAFT_HUMAN_ACTIVITY_CHANGED" && code != "VOICE_RECORDING_DEADLINE")
            Interlocked.Exchange(ref VoiceExternalStop, 1);
        Interlocked.CompareExchange(ref VoiceStopReason, code, null);
        Interlocked.Exchange(ref VoiceCancelled, 1);
        var audio = VoiceAudio;
        if (audio != null)
            audio.Cancel();
    }
    // Only the first event that already fails Own is retained. Never retain a key,
    // pointer position, marker value, title, or text; diagnostics do not relax Own.
    static bool ObserveVoiceInput(string kind, uint flags, uint injectedMask, UIntPtr marker, uint message,
                                  long observedAt)
    {
        if (Own(flags, injectedMask, marker))
        {
            if (kind == "mouse")
                Interlocked.Exchange(ref VoiceOwnMouseObserved, 1);
            return false;
        }
        long started = Recording.StartedAt;
        var diagnostic = new VoiceActivityDiagnostic {
            Kind = kind,
            Injected = (flags & injectedMask) != 0,
            OwnMarker = marker.Equals(Marker),
            Lower32Matches = unchecked((uint)marker.ToUInt64()) == unchecked((uint)Marker.ToUInt64()),
            MarkerIsZero = marker.Equals(UIntPtr.Zero),
            Message = message,
            TimeAfterRecordStartMs = started > 0 ? (long?)Math.Max(0, observedAt - started) : null
        };
        Interlocked.CompareExchange(ref VoiceHumanActivity, diagnostic, null);
        return true;
    }
    static object VoiceActivityReport()
    {
        var diagnostic = Interlocked.CompareExchange(ref VoiceHumanActivity, null, null);
        return diagnostic == null ? null : diagnostic.Report();
    }
    static IntPtr OnVoiceKeyboard(int code, IntPtr message, IntPtr data)
    {
        if (code >= 0)
        {
            var input = (KeyboardHookData)Marshal.PtrToStructure(data, typeof(KeyboardHookData));
            bool own = Own(input.Flags, 0x10, input.Extra);
            VoiceNotePointerActivity(own);
            if (!VoiceWarmCollect(own) &&
                !VoiceAllowOtherAppInput("keyboard", input.Flags, 0x10, input.Extra, unchecked((uint)message.ToInt64()),
                                         new Point(0, 0)) &&
                ObserveVoiceInput("keyboard", input.Flags, 0x10, input.Extra, unchecked((uint)message.ToInt64()),
                                  Now()))
            {
                Human();
                StopVoice("DRAFT_HUMAN_ACTIVITY_CHANGED");
            }
        }
        return CallNextHookEx(KeyboardHook, code, message, data);
    }
    static IntPtr OnVoiceMouse(int code, IntPtr message, IntPtr data)
    {
        if (code >= 0)
        {
            var input = (MouseHookData)Marshal.PtrToStructure(data, typeof(MouseHookData));
            bool own = Own(input.Flags, 1, input.Extra);
            VoiceNotePointerActivity(own);
            if (!VoiceWarmCollect(own) &&
                !VoiceAllowOtherAppInput("mouse", input.Flags, 1, input.Extra, unchecked((uint)message.ToInt64()),
                                         input.Point) &&
                ObserveVoiceInput("mouse", input.Flags, 1, input.Extra, unchecked((uint)message.ToInt64()), Now()))
            {
                Human();
                StopVoice("DRAFT_HUMAN_ACTIVITY_CHANGED");
            }
            var observer = MouseObservationObserver;
            if (observer != null)
                try
                {
                    observer(unchecked((uint)message.ToInt64()), input.Point);
                }
                catch
                {
                    MouseObservationObserver = null;
                }
        }
        return CallNextHookEx(MouseHook, code, message, data);
    }
    static void VoiceActive()
    {
        Need(Interlocked.CompareExchange(ref VoiceCancelled, 0, 0) == 0, VoiceStopReason ?? "VOICE_CANCELLED");
    }
    static bool MayCancel(bool possible, bool submitted, bool allowed, long originalRevision, long currentRevision)
    {
        return possible && !submitted && allowed && originalRevision == currentRevision;
    }
    static bool VoiceMayCancelInterrupted(string reason, bool possible, bool submitted, bool allowed, bool captureBound,
                                          bool cancelAttempted, bool externalStop)
    {
        return (reason == "DRAFT_HUMAN_ACTIVITY_CHANGED" || reason == "VOICE_BACKGROUND_WECHAT_ACTIVATED") &&
               possible && !submitted && allowed && captureBound && !cancelAttempted && !externalStop;
    }
    static string VoiceInterruptedFailureCode(string reason, string stopReason)
    {
        return reason == "AUDIO_PLAYBACK_CANCELLED" && stopReason == "DRAFT_HUMAN_ACTIVITY_CHANGED" ? stopReason
                                                                                                    : reason;
    }
    static void VoiceWaitCancellationQuiet(long deadline, int quietMs, Func<long> clock, Func<long> lastInput,
                                           Func<bool> keysReleased, Action guard, Action<int> sleep)
    {
        for (;;)
        {
            guard();
            long now = clock();
            Need(now < deadline, "VOICE_INTERRUPTION_CLEANUP_TIMEOUT");
            if (keysReleased() && now - lastInput() >= quietMs)
            {
                guard();
                return;
            }
            sleep((int)Math.Min(10, deadline - now));
        }
    }
    static void VoiceCancelInterrupted(VoiceRequest request, AudioRouteProbe.NativeVoiceAudio audio)
    {
        try
        {
            // Keep the process's original bounded lifetime. This only waits
            // for ordinary inactivity; it never keeps an old clip for sending.
            long deadline = Math.Min(Recording.StartedAt + 13000, Now() + 4000);
            int quiet =
                Math.Max(request.Binding.Idle, VoiceHandoff == null ? 250 : VoiceSafeGapMs(FocusDoubleClickTime()));
            VoiceCancellationStage = "quiet";
            VoiceWaitCancellationQuiet(
                deadline, quiet, Now, delegate { return Interlocked.Read(ref LastActivity); }, VoiceKeysReleased,
                delegate {
                    Need(!Stopping && Interlocked.CompareExchange(ref VoiceExternalStop, 0, 0) == 0 &&
                             !Recording.SubmitAttempted,
                         "VOICE_INTERRUPTION_CLEANUP_UNAVAILABLE");
                    ValidateTime(request.Binding, UtcMs());
                    VoiceBoundWindowGuard(request);
                    audio.CheckDefaults();
                    Need(VoiceCaptureInstance != null &&
                             audio.ActiveSession(request.Binding.Pid) == VoiceCaptureInstance,
                         "VOICE_CAPTURE_CHANGED");
                },
                Thread.Sleep);
            VoiceCancellationStage = "focus";
            long revision = VoiceAcquireCancellationFocus(request, audio);
            VoiceCancellationStage = "esc";
            VoiceCancelEsc(request, revision, audio);
            VoiceCancellationStage = "end";
            Recording.ObserveEnd(CancelledCaptureEnded(request, revision, audio), Now());
            Need(Recording.Ended, "VOICE_RECORDING_END_UNCONFIRMED");
            VoiceCancellationStage = "ended";
        }
        catch (Exception error)
        {
            VoiceCancellationFailure = VoiceSafeReason(error);
        }
        finally
        {
            VoiceFinishCancellationFocus(request);
        }
    }
    static string VoiceSafeReason(Exception error)
    {
        string code = error.Message;
        return code != null && System.Text.RegularExpressions.Regex.IsMatch(code, "^(VOICE|DRAFT|AUDIO)_[A-Z_]{1,80}$")
                   ? code
                   : "VOICE_PREVIEW_FAILED";
    }
    static object VoiceFailure(Exception error)
    {
        string code = VoiceSafeReason(error);
        return VoiceMouseDiagnostic ? MouseDiagnosticReport(false, code) : VoiceReport(false, code);
    }
    static object MouseDiagnosticReport(bool ok, string reason)
    {
        return Data("ok", ok, "mode", "mouseMarkerDiagnostic", "reason", reason, "mouseMoveAttempted",
                    MouseMoveAttempted, "mouseMoveInputApplied", MouseMoveInputApplied, "ownMouseObserved",
                    Interlocked.CompareExchange(ref VoiceOwnMouseObserved, 0, 0) != 0, "humanActivity",
                    VoiceActivityReport(), "recordingAttempted", false, "audioStarted", false, "submitAttempted", false,
                    "messageSent", false, "systemSettingsChanged", false);
    }
    static object VoiceReport(bool ok, string reason)
    {
        var report = Data(
            "ok", ok, "mode", VoiceProduction ? "timedVoiceSend" : "timedVoicePreview", "targetGuarded",
            VoiceProduction, "reason", reason, "recordingAttempted", Recording.Started, "recordingPossible",
            Recording.PossiblyActive, "captureVerified", VoiceCaptureVerified, "captureSessionBound",
            VoiceCaptureInstance != null, "audioStarted", VoiceAudioStarted, "playbackComplete", VoiceAudioComplete,
            "submitAttempted", Recording.SubmitAttempted, "submitInputApplied", Recording.SubmitApplied,
            "cancelAttempted", CancelAttempted, "cancelInputApplied", CancelInputApplied, "recordingEndedObserved",
            Recording.Ended, "deliveryConfirmed", false, "unattendedReady", false, "systemSettingsChanged", false,
            "microphoneOpened", false, "queuedAudioLimitMs", 20, "deviceLatencyBounded", false, "mouseParkMovesApplied",
            VoiceMouseParkMovesApplied, "uiaPointerMessagesPosted", VoiceUiaPointerMessages, "humanActivity",
            VoiceActivityReport(), "audioPump", VoicePumpDiagnostic, "adaptiveRecordingUi", VoiceAdaptiveDiagnostic,
            "sourceDurationMs", VoiceDurationMs, "playbackElapsedMs",
            VoiceDrainMs > 0 && VoicePlayMs > 0 ? VoiceDrainMs - VoicePlayMs : 0, "recordingElapsedMs",
            Recording.StartedAt > 0 ? (Recording.EndedAt > 0 ? Recording.EndedAt : Now()) - Recording.StartedAt : 0,
            "timelineMs",
            Data("recordStart", Recording.StartedAt, "captureReady", VoiceCaptureMs, "playStart", VoicePlayMs,
                 "playDrained", VoiceDrainMs, "submit", Recording.SubmittedAt, "recordEnded", Recording.EndedAt));
        if (VoiceHandoff != null)
            report["focusHandoff"] = VoiceFocusHandoffReport();
        if (VoiceUiaDiagnostic != null)
            report["uiaRecordingUi"] = VoiceUiaReport();
        if (VoiceCancellationStage != null)
            report["cancellationCleanup"] =
                Data("version", 1, "stage", VoiceCancellationStage, "reason", VoiceCancellationFailure);
        if (VoiceButtonHitDiagnostic != null)
            report["buttonHit"] = VoiceButtonHitDiagnostic;
        return report;
    }
    static VoiceTemplate ParseTemplate(object value, Rect client)
    {
        var map = Map(value);
        Need(map != null && map.Count == 2 && Hex(Text(map, "rgbaSha256"), 64), "VOICE_TEMPLATE_INVALID");
        Rect rect = ParseRect(Get(map, "rect"));
        Need(Contains(client, rect) && rect.Width >= 4 && rect.Height >= 4 && rect.Width <= 128 && rect.Height <= 128,
             "VOICE_TEMPLATE_INVALID");
        return new VoiceTemplate { Rect = rect, Hash = Text(map, "rgbaSha256") };
    }
    static VoiceRequest ParseMouseDiagnostic(Dictionary<string, object> value)
    {
        Need(value != null && Text(value, "action") == "probeMouseMarker", "VOICE_REQUEST_INVALID");
        Need(Object.Equals(Get(Map(Get(value, "permission")), "mouseMoveDiagnostic"), true),
             "VOICE_PERMISSION_REQUIRED");
        Request binding =
            Parse(Data("action", "verifyDraft", "permission",
                       Data("selectionCopy", true, "caretToEnd", true, "clipboardRestore", true), "expectedDraft",
                       "mouse calibration only", "idleMs", Get(value, "idleMs"), "session", Get(value, "session")));
        Need(binding.OperatorCalibrated && binding.Idle <= 1500 && binding.Expires - UtcMs() >= 4000,
             "VOICE_MOUSE_SESSION_INVALID");
        Rect target = ParseRect(Get(value, "mouseTargetRect"));
        Need(Contains(binding.Client, target) && target.Width >= 2 && target.Height >= 2 && target.Width <= 128 &&
                 target.Height <= 128,
             "VOICE_MOUSE_TARGET_INVALID");
        return new VoiceRequest { Binding = binding, RecordStart = target };
    }
    static object RunMouseDiagnostic(VoiceRequest request)
    {
        long revision = Interlocked.Read(ref Revision);
        VoiceGuard(request, revision, 0);
        Need(Snapshot(request.Binding.Window, request.Binding.Executable).InputTick == request.Binding.InputTick,
             "DRAFT_CALIBRATION_ACTIVITY_CHANGED");
        NoKeysHeld();
        while (Now() - Interlocked.Read(ref LastActivity) < request.Binding.Idle)
        {
            Thread.Sleep(10);
            VoiceGuard(request, revision, 0);
        }
        Need(Snapshot(request.Binding.Window, request.Binding.Executable).InputTick == request.Binding.InputTick,
             "DRAFT_CALIBRATION_ACTIVITY_CHANGED");
        Point center =
            new Point(request.Binding.Capture.Left + request.RecordStart.Left + request.RecordStart.Width / 2,
                      request.Binding.Capture.Top + request.RecordStart.Top + request.RecordStart.Height / 2);
        int left = GetSystemMetrics(76), top = GetSystemMetrics(77);
        Input move = ClickEvents(center.X, center.Y,
                                 new Rect(left, top, left + GetSystemMetrics(78), top + GetSystemMetrics(79)))[0];
        VoiceGuard(request, revision, 0);
        NoKeysHeld();
        Need(Owned(WindowFromPoint(center), request.Binding.Window, request.Binding.Pid), "VOICE_BUTTON_OBSCURED");
        VoiceGuard(request, revision, 0);
        MouseMoveAttempted = true;
        VoiceActive();
        Need(Interlocked.Read(ref Revision) == revision && GetForegroundWindow() == request.Binding.Window,
             "DRAFT_HUMAN_ACTIVITY_CHANGED");
        uint accepted = SendInput(1, new[] { move }, Marshal.SizeOf(typeof(Input)));
        MouseMoveInputApplied = accepted == 1;
        Need(MouseMoveInputApplied, "VOICE_MOUSE_INPUT_UNCERTAIN");
        VoiceWait(request, revision, 200, 0);
        VoiceGuard(request, revision, 0);
        Need(Interlocked.CompareExchange(ref VoiceOwnMouseObserved, 0, 0) != 0, "VOICE_MOUSE_HOOK_UNCONFIRMED");
        return MouseDiagnosticReport(true, null);
    }
    static Binding VoiceGuard(VoiceRequest request, long revision, int phase, bool allowStopped = false)
    {
        if (!allowStopped)
            VoiceActive();
        Need(!Stopping, "VOICE_STOPPING");
        if (VoiceCancellation != null && VoiceCancellation.Active)
            Need(Interlocked.CompareExchange(ref VoiceExternalStop, 0, 0) == 0,
                 "VOICE_INTERRUPTION_CLEANUP_UNAVAILABLE");
        ValidateTime(request.Binding, UtcMs());
        Need(Interlocked.Read(ref Revision) == revision, "DRAFT_HUMAN_ACTIVITY_CHANGED");
        Binding actual = Snapshot(request.Binding.Window, request.Binding.Executable);
        Need(actual.Pid == request.Binding.Pid && actual.Created == request.Binding.Created &&
                 actual.Dpi == request.Binding.Dpi && Same(actual.Client, request.Binding.Client) &&
                 Same(actual.Capture, request.Binding.Capture),
             "VOICE_WINDOW_BINDING_CHANGED");
        Need(actual.FocusOwned &&
                 (phase == 2 || (actual.Focus == (phase == 1 ? request.RecordingFocus : request.Binding.Focus))),
             "VOICE_FOCUS_CHANGED");
        Need((actual.GuiFlags & 0x1e) == 0, "VOICE_MENU_ACTIVE");
        if (request.Uia == null)
            VoiceRequireFullVisibility(request);
        if (request.TitleAnchor != null)
            Need(TemplateMatches(request, request.TitleAnchor), "VOICE_TARGET_ANCHOR_CHANGED");
        Need(Interlocked.Read(ref Revision) == revision, "DRAFT_HUMAN_ACTIVITY_CHANGED");
        return actual;
    }
    static string PixelHash(byte[] rgba)
    {
        using (var hash = SHA256.Create()) return BitConverter.ToString(hash.ComputeHash(rgba))
            .Replace("-", "")
            .ToLowerInvariant();
    }
    static void VoiceRgbaRow(byte[] bgra, byte[] rgba, int destination)
    {
        for (int source = 0; source < bgra.Length; source += 4)
        {
            rgba[destination++] = bgra[source + 2];
            rgba[destination++] = bgra[source + 1];
            rgba[destination++] = bgra[source];
            rgba[destination++] = 255;
        }
    }
    static string CaptureTemplateHash(VoiceRequest request, Rect rect)
    {
        Rect screen = request.Binding.Capture;
        using (var image = new Bitmap(rect.Width, rect.Height, PixelFormat.Format32bppRgb))
        {
            using (var graphics = Graphics.FromImage(image))
                graphics.CopyFromScreen(screen.Left + rect.Left, screen.Top + rect.Top, 0, 0,
                                        new Size(rect.Width, rect.Height), CopyPixelOperation.SourceCopy);
            byte[] rgba = new byte[rect.Width * rect.Height * 4], row = new byte[rect.Width * 4];
            BitmapData pixels = image.LockBits(new Rectangle(0, 0, rect.Width, rect.Height), ImageLockMode.ReadOnly,
                                               PixelFormat.Format32bppRgb);
            try
            {
                for (int y = 0; y < rect.Height; y++)
                {
                    Marshal.Copy(IntPtr.Add(pixels.Scan0, y * pixels.Stride), row, 0, row.Length);
                    VoiceRgbaRow(row, rgba, y * row.Length);
                }
            }
            finally
            {
                image.UnlockBits(pixels);
            }
            return PixelHash(rgba);
        }
    }
    static bool TemplateMatches(VoiceRequest request, VoiceTemplate template)
    {
        Need(request == null || request.Uia == null, "VOICE_UIA_PIXEL_PATH_FORBIDDEN");
        return template != null && CaptureTemplateHash(request, template.Rect) == template.Hash;
    }
    static bool RecordingUi(VoiceRequest request)
    {
        return request.Uia != null
                   ? VoiceUiaRecording(request)
                   : TemplateMatches(request, request.Cancel) && TemplateMatches(request, request.Submit);
    }
    static uint VoiceDispatchClick(Action finalGuard, Action mark, Func<uint> insert)
    {
        finalGuard();
        mark();
        return insert();
    }
    static Input[] VoiceCancelEvents()
    {
        return new[] { Key(0x1b, 0), Key(0x1b, 2) };
    }
    static void VoiceCancelWindowGuard(VoiceRequest request, long revision)
    {
        Need(!Stopping, "VOICE_STOPPING");
        if (VoiceCancellation != null && VoiceCancellation.Active)
            Need(Interlocked.CompareExchange(ref VoiceExternalStop, 0, 0) == 0,
                 "VOICE_INTERRUPTION_CLEANUP_UNAVAILABLE");
        Need(!Recording.SubmitAttempted, "VOICE_INTERRUPTION_CLEANUP_UNAVAILABLE");
        ValidateTime(request.Binding, UtcMs());
        Need(Interlocked.Read(ref Revision) == revision, "DRAFT_HUMAN_ACTIVITY_CHANGED");
        NoKeysHeld();
        VoiceBoundWindowGuard(request);
        Need(GetForegroundWindow() == request.Binding.Window && Interlocked.Read(ref Revision) == revision,
             "DRAFT_HUMAN_ACTIVITY_CHANGED");
    }
    static void VoiceCancelEsc(VoiceRequest request, long revision, AudioRouteProbe.NativeVoiceAudio audio)
    {
        VoiceCancelWindowGuard(request, revision);
        audio.CheckDefaults();
        Need(VoiceCaptureVerified && VoiceCaptureInstance != null &&
                 audio.ActiveSession(request.Binding.Pid) == VoiceCaptureInstance,
             "VOICE_CAPTURE_CHANGED");
        Input[] inputs = VoiceCancelEvents();
        uint applied = VoiceDispatchClick(
            delegate { VoiceCancelWindowGuard(request, revision); },
            delegate {
                CancelAttempted = true;
                InputAttempted = true;
            },
            delegate { return SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(Input))); });
        if (applied != inputs.Length)
        {
            Input[] release = Releases(inputs, applied);
            if (release.Length > 0)
                SendInput((uint)release.Length, release, Marshal.SizeOf(typeof(Input)));
            throw new Fault("VOICE_CANCEL_INPUT_UNCERTAIN");
        }
        CancelInputApplied = true;
    }
    static bool VoiceObserveCancelledCapture(Action guard, Func<bool> inactive, Func<long> clock, Action<int> wait)
    {
        long end = clock() + 1000;
        int samples = 0;
        while (clock() < end)
        {
            guard();
            bool ended = inactive();
            guard();
            if (ended)
            {
                if (++samples >= 2)
                    return true;
            }
            else
                samples = 0;
            wait(40);
        }
        return false;
    }
    static bool CancelledCaptureEnded(VoiceRequest request, long revision, AudioRouteProbe.NativeVoiceAudio audio)
    {
        // Esc targets the already-bound recorder, not a pixel location. Its
        // completion is the original capture becoming inactive; no button,
        // editor-focus, caret or idle-toolbar template is read again.
        return VoiceObserveCancelledCapture(delegate {
            VoiceCancelWindowGuard(request, revision);
            audio.CheckDefaults();
        }, audio.BoundCaptureInactive, Now, Thread.Sleep);
    }
    static bool VoiceDirectedPointer(bool uia, int phase, bool onDesktop)
    {
        return uia && (phase != 0 || !onDesktop);
    }
    static Input[] VoiceStartEvents(Point point, Rect desktop)
    {
        Need(desktop.Width >= 2 && desktop.Height >= 2 && VoicePointerIn(desktop, point), "DRAFT_SCREEN_CHANGED");
        int x = (int)Math.Min(65535, Math.Round(((double)point.X - desktop.Left + 0.5) * 65536 / desktop.Width));
        int y = (int)Math.Min(65535, Math.Round(((double)point.Y - desktop.Top + 0.5) * 65536 / desktop.Height));
        return new[] { Mouse(x, y, 0xc001), Mouse(0, 0, 2), Mouse(0, 0, 4) };
    }
    static uint VoiceStartGesture(Action<bool> guard, Action mark, Func<int, uint> send, Func<bool> arrived,
                                  Func<bool> captured, Action<bool, bool> observe, Action beforeUp, Func<long> clock,
                                  Action<int> wait)
    {
        guard(false);
        uint count = send(0);
        if (count != 1)
            return count;
        long deadline = clock() + 100;
        while (!arrived())
        {
            guard(false);
            Need(clock() < deadline, "VOICE_START_POINTER_UNCONFIRMED");
            wait(2);
        }
        observe(true, false);
        guard(false);
        mark();
        uint down = send(1);
        if (down != 1)
            return count + down;
        count += down;
        bool consumed = false;
        try
        {
            deadline = clock() + 120;
            while (!(consumed = captured()) && clock() < deadline)
            {
                guard(true);
                wait(2);
            }
            guard(true);
            observe(true, consumed);
            beforeUp();
            guard(true);
        }
        finally
        {
            uint up = send(2);
            if (up != 1)
                up = send(2);
            Need(up == 1, "VOICE_START_RELEASE_UNCONFIRMED");
            count += up;
        }
        return count;
    }
    static bool VoiceStartKeysReleased(bool ownDown, Func<int, bool> pressed)
    {
        for (int key = 1; key < 256; key++)
            if ((!ownDown || key != 1) && pressed(key))
                return false;
        return true;
    }
    static bool VoiceFailureFrameRequested(string value)
    {
        return value == "1";
    }
    static void VoiceCaptureFailureFrame(VoiceRequest request, long revision)
    {
        if (request.Uia == null || request.Uia.AfterStartState != "idle" || request.Uia.LastObservedState != "idle" ||
            !VoiceFailureFrameRequested(Environment.GetEnvironmentVariable("WECHATAGENT_VOICE_ACCEPTANCE_DIAGNOSTICS")))
            return;
        try
        {
            VoiceGuard(request, revision, 2, true);
            NoKeysHeld();
            Need(GetForegroundWindow() == request.Binding.Window, "VOICE_FOCUS_CHANGED");
            var area = new Rect(request.Binding.Editor.Left,
                                Math.Max(request.Binding.Client.Top, request.RecordStart.Top - 60),
                                request.Binding.Client.Right, request.Binding.Client.Bottom);
            Need(Contains(request.Binding.Client, area) && area.Width > 0 && area.Width <= 4096 && area.Height > 0 &&
                     area.Height <= 512,
                 "VOICE_DIAGNOSTIC_BOUNDS_INVALID");
            var screen = new Rect(request.Binding.Capture.Left + area.Left, request.Binding.Capture.Top + area.Top,
                                  request.Binding.Capture.Left + area.Right, request.Binding.Capture.Top + area.Bottom);
            Need(FocusBlockingWindows(request.Binding.Window, screen, "VOICE_DIAGNOSTIC_OBSCURED") == 0,
                 "VOICE_DIAGNOSTIC_OBSCURED");
            string host = Path.GetDirectoryName(System.Reflection.Assembly.GetExecutingAssembly().Location),
                   state = Path.GetDirectoryName(host);
            Need(String.Equals(Path.GetFileName(host), "ui-host", StringComparison.OrdinalIgnoreCase) &&
                     String.Equals(Path.GetFileName(state), "state", StringComparison.OrdinalIgnoreCase),
                 "VOICE_DIAGNOSTIC_PATH_INVALID");
            string directory = Path.Combine(state, "voice-failure-frames");
            for (string current = directory; !String.IsNullOrEmpty(current); current = Path.GetDirectoryName(current))
            {
                if (Directory.Exists(current))
                    Need((File.GetAttributes(current) & FileAttributes.ReparsePoint) == 0,
                         "VOICE_DIAGNOSTIC_PATH_INVALID");
            }
            Directory.CreateDirectory(directory);
            string name = "voice-start-" + Guid.NewGuid().ToString("N") + ".png";
            using (var image = new Bitmap(area.Width, area.Height, PixelFormat.Format32bppRgb))
            {
                using (var graphics = Graphics.FromImage(image)) graphics.CopyFromScreen(
                    screen.Left, screen.Top, 0, 0, new Size(area.Width, area.Height), CopyPixelOperation.SourceCopy);
                VoiceGuard(request, revision, 2, true);
                Need(GetForegroundWindow() == request.Binding.Window, "VOICE_FOCUS_CHANGED");
                using (var output = new FileStream(Path.Combine(directory, name), FileMode.CreateNew, FileAccess.Write,
                                                   FileShare.None)) image.Save(output, ImageFormat.Png);
            }
            request.Uia.FailureFrame = name;
            request.Uia.FailureFrameWidth = area.Width;
            request.Uia.FailureFrameHeight = area.Height;
        }
        catch
        { /* Optional read-only evidence must not replace the recording failure or its cleanup. */
        }
    }
    static uint VoiceStartClick(VoiceRequest request, long revision, Point center, Rect desktop, Action mark)
    {
        Input[] events = VoiceStartEvents(center, desktop);
        uint pid, thread = GetWindowThreadProcessId(request.Binding.Window, out pid);
        Need(pid == request.Binding.Pid && thread != 0, "VOICE_WINDOW_BINDING_CHANGED");
        if (request.Uia != null)
            request.Uia.StartExpectedPoint = center;
        var before = new GuiInfo { Size = (uint)Marshal.SizeOf(typeof(GuiInfo)) };
        bool captureBaseline = GetGUIThreadInfo(thread, ref before);
        Action<bool> guard = delegate(bool down)
        {
            VoiceGuard(request, revision, 2);
            Need(GetForegroundWindow() == request.Binding.Window, "VOICE_FOCUS_CHANGED");
            Need(VoiceStartKeysReleased(down, delegate(int key) { return (GetAsyncKeyState(key) & 0x8000) != 0; }),
                 "DRAFT_KEYS_HELD");
        };
        Func<bool> arrived = delegate
        {
            Point actual;
            bool seen = FocusGetCursorPos(out actual);
            if (request.Uia != null && seen)
            {
                request.Uia.StartActualPoint = actual;
                request.Uia.StartPointObserved = true;
            }
            return seen && VoicePointerNear(actual, center);
        };
        Func<bool> consumed = delegate
        {
            var info = new GuiInfo { Size = (uint)Marshal.SizeOf(typeof(GuiInfo)) };
            return captureBaseline && GetGUIThreadInfo(thread, ref info) && info.Capture != IntPtr.Zero &&
                   info.Capture != before.Capture && Owned(info.Capture, request.Binding.Window, request.Binding.Pid);
        };
        bool pointTracked = false;
        return VoiceStartGesture(
            guard,
            delegate {
                ObserveMouseIntent(0x201, center);
                mark();
            },
            delegate(int index) { return SendInput(1, new[] { events[index] }, Marshal.SizeOf(typeof(Input))); },
            arrived, consumed,
            delegate(bool matched, bool consumedDown) {
                if (request.Uia != null)
                {
                    request.Uia.StartPointMatched = matched;
                    request.Uia.StartPressConsumed = consumedDown;
                }
                if (matched && !pointTracked)
                {
                    VoiceTrackOwnPointer(request, revision, center);
                    pointTracked = true;
                }
            },
            delegate {
                if (request.Uia != null)
                {
                    request.Uia.BeforeUpState = VoiceUiaDiagnosticState(request);
                    try
                    {
                        request.Uia.CaptureWhileDown =
                            VoiceAudio != null && VoiceAudio.ActiveSession(request.Binding.Pid) != null;
                    }
                    catch
                    {
                        request.Uia.CaptureWhileDown = null;
                    }
                }
            },
            Now, Thread.Sleep);
    }
    static void VoiceClick(VoiceRequest request, long revision, Rect rect, int phase, Action mark,
                           bool allowStopped = false)
    {
        VoiceGuard(request, revision, phase, allowStopped);
        NoKeysHeld();
        Point center = new Point(request.Binding.Capture.Left + rect.Left + rect.Width / 2,
                                 request.Binding.Capture.Top + rect.Top + rect.Height / 2);
        int left = GetSystemMetrics(76), top = GetSystemMetrics(77);
        var desktop = new Rect(left, top, left + GetSystemMetrics(78), top + GetSystemMetrics(79));
        bool directed = VoiceDirectedPointer(request.Uia != null, phase,
                                             center.X >= desktop.Left && center.X < desktop.Right &&
                                                 center.Y >= desktop.Top && center.Y < desktop.Bottom);
        if (request.Uia != null && phase == 0)
        {
            request.Uia.StartInputMethod = directed ? "window-message" : "send-input";
            request.Uia.StartExpectedPoint = center;
        }
        if (directed)
        {
            VoiceUiaPointerClick(request, revision, rect, phase, mark, allowStopped);
            return;
        }
        if (phase == 0)
            VoiceEnsureStartVisible(request, revision, center);
        VoiceRequireButtonHit(request, center, phase);
        Input[] events = ClickEvents(center.X, center.Y, desktop);
        if (request.Uia != null)
            VoiceUiaConversationAndClickGuard(request, rect, phase);
        else if (phase == 1)
            Need(RecordingUi(request), "VOICE_RECORDING_CONTEXT_CHANGED");
        VoiceGuard(request, revision, phase, allowStopped);
        NoKeysHeld();
        Need(Owned(WindowFromPoint(center), request.Binding.Window, request.Binding.Pid) &&
                 Interlocked.Read(ref Revision) == revision,
             "VOICE_BUTTON_CHANGED");
        if (!allowStopped)
            VoiceActive();
        uint count =
            phase == 0
                ? VoiceStartClick(request, revision, center, desktop, mark)
                : VoiceDispatchClick(
                      delegate {
                          Need(Interlocked.Read(ref Revision) == revision &&
                                   GetForegroundWindow() == request.Binding.Window,
                               "DRAFT_HUMAN_ACTIVITY_CHANGED");
                          if (!allowStopped)
                              VoiceActive();
                      },
                      delegate {
                          ObserveMouseIntent(0x201, center);
                          mark();
                      },
                      delegate { return SendInput((uint)events.Length, events, Marshal.SizeOf(typeof(Input))); });
        if (count != events.Length)
        {
            Input[] releases = ClickReleases(count);
            if (releases.Length > 0)
                SendInput((uint)releases.Length, releases, Marshal.SizeOf(typeof(Input)));
            throw new Fault("VOICE_CLICK_UNCERTAIN");
        }
        VoiceTrackOwnPointer(request, revision, center);
    }
    static void VoiceWait(VoiceRequest request, long revision, int milliseconds, int phase, bool allowStopped = false)
    {
        long end = Now() + milliseconds;
        for (;;)
        {
            long remaining = end - Now();
            if (remaining <= 0)
                return;
            Thread.Sleep((int)Math.Min(10, remaining));
            VoiceGuard(request, revision, phase, allowStopped);
        }
    }
    static void VoicePark(VoiceRequest request, long revision, int phase, bool allowStopped = false)
    {
        // UIA controls do not need hover-sensitive pixel parking. Any physical
        // start click uses the existing guarded handoff to restore the pointer.
        if (request.Uia != null)
        {
            VoiceGuard(request, revision, phase, allowStopped);
            NoKeysHeld();
            return;
        }
        VoiceGuard(request, revision, phase, allowStopped);
        NoKeysHeld();
        Point center = new Point(request.Binding.Capture.Left + request.MousePark.Left + request.MousePark.Width / 2,
                                 request.Binding.Capture.Top + request.MousePark.Top + request.MousePark.Height / 2);
        int left = GetSystemMetrics(76), top = GetSystemMetrics(77);
        Input move = ClickEvents(center.X, center.Y,
                                 new Rect(left, top, left + GetSystemMetrics(78), top + GetSystemMetrics(79)))[0];
        VoiceGuard(request, revision, phase, allowStopped);
        NoKeysHeld();
        Need(Owned(WindowFromPoint(center), request.Binding.Window, request.Binding.Pid), "VOICE_MOUSE_PARK_OBSCURED");
        Need(Interlocked.Read(ref Revision) == revision && GetForegroundWindow() == request.Binding.Window,
             "DRAFT_HUMAN_ACTIVITY_CHANGED");
        if (!allowStopped)
            VoiceActive();
        Need(SendInput(1, new[] { move }, Marshal.SizeOf(typeof(Input))) == 1, "VOICE_MOUSE_PARK_UNCERTAIN");
        VoiceMouseParkMovesApplied++;
        VoiceTrackOwnPointer(request, revision, center);
        // Shared mode continues directly into the existing recorder-ready or
        // recorder-ended observations. Dedicated mode keeps its old delay.
        if (VoiceHandoff == null)
            VoiceWait(request, revision, 200, phase, allowStopped);
        VoiceGuard(request, revision, phase, allowStopped);
    }
    static string VoiceWaitParkedIdle(Action guard, Func<string> capture, Func<long> clock, Action<int> wait)
    {
        long end = clock() + 200;
        string previous = null;
        for (;;)
        {
            guard();
            string current = capture();
            guard();
            Need(clock() <= end, "VOICE_IDLE_CONTEXT_UNSTABLE");
            if (previous != null && current == previous)
                return current;
            previous = current;
            Need(clock() + 20 <= end, "VOICE_IDLE_CONTEXT_UNSTABLE");
            wait(20);
        }
    }
    static bool VoiceMayWaitAdaptive(bool shared, bool unbound, string reason)
    {
        return shared && unbound &&
               (reason == "VOICE_ADAPTIVE_CONTROL_UNCERTAIN" || reason == "VOICE_ADAPTIVE_ROLES_UNCERTAIN" ||
                reason == "VOICE_ADAPTIVE_CHANGED");
    }
    static bool EndEvidence(bool boundInactive, bool idleMatches, bool cancelMatches, bool submitMatches)
    {
        return boundInactive && idleMatches && !cancelMatches && !submitMatches;
    }
    static bool VoiceObserveUiaEnd(Action guard, Func<bool> inactive, Func<bool> idle, Func<long> clock,
                                   Action<int> wait)
    {
        long end = clock() + 1000;
        int samples = 0;
        while (clock() < end)
        {
            guard();
            if (inactive())
                samples++;
            else
                samples = 0;
            // Audio cessation is the cheap transition predicate. Once stable,
            // read the current semantic idle state exactly at this boundary.
            if (samples >= 2)
            {
                if (idle() && inactive())
                {
                    guard();
                    return true;
                }
                samples = 0;
            }
            guard();
            wait(40);
        }
        return false;
    }
    static bool EndObserved(VoiceRequest request, long revision, AudioRouteProbe.NativeVoiceAudio audio,
                            bool allowStopped)
    {
        if (request.Uia != null)
            return VoiceObserveUiaEnd(delegate { VoiceGuard(request, revision, 2, allowStopped); },
                                      audio.BoundCaptureInactive,
                                      delegate {
                                          VoiceUiaConversation(request);
                                          return VoiceUiaIdle(request);
                                      },
                                      Now, Thread.Sleep);
        long end = Now() + 1000;
        int samples = 0;
        while (Now() < end)
        {
            VoiceGuard(request, revision, 2, allowStopped);
            bool ended = EndEvidence(
                audio.BoundCaptureInactive(), request.Idle != null && TemplateMatches(request, request.Idle),
                TemplateMatches(request, request.Cancel), TemplateMatches(request, request.Submit));
            VoiceGuard(request, revision, 2, allowStopped);
            if (ended)
            {
                if (++samples >= 2)
                    return true;
            }
            else
                samples = 0;
            Thread.Sleep(40);
        }
        return false;
    }
    static bool VoiceMayObserveSubmittedEnd(bool uia, bool submitted, bool captureBound, bool recorderBound,
                                            bool returned)
    {
        return uia && submitted && captureBound && recorderBound && returned;
    }
    static bool VoiceSubmittedEndObserved(VoiceRequest request, AudioRouteProbe.NativeVoiceAudio audio,
                                          bool backgroundSubmit = false)
    {
        string capture = VoiceCaptureInstance, recorder = request.Uia == null ? null : request.Uia.Recorder;
        Need(VoiceHandoff != null && request.Uia != null && Recording.SubmitApplied && VoiceCaptureVerified &&
                 capture != null && recorder != null,
             "VOICE_RECORDING_END_UNCONFIRMED");
        // A foreground lease is returned before observation. Background submit
        // instead allows its bound Qt window to activate until recorder teardown
        // completes, then returns once. Queueing never confirms delivery.
        var background = backgroundSubmit ? VoiceHandoff.BackgroundSubmit : null;
        if (backgroundSubmit)
            Need(background != null && background.Attempted && background.Applied &&
                     VoiceHandoff.InitialReturnConfirmed &&
                     Interlocked.CompareExchange(ref VoiceHandoff.Phase, 0, 0) == 7,
                 "VOICE_BACKGROUND_SUBMIT_UNAVAILABLE");
        else
        {
            VoiceFinishFocusHandoff(request, true);
            Need(VoiceMayObserveSubmittedEnd(request.Uia != null, Recording.SubmitApplied, capture != null,
                                             recorder != null, VoiceHandoff.FinalReturnConfirmed) &&
                     Interlocked.CompareExchange(ref VoiceHandoff.Phase, 0, 0) == 6,
                 "VOICE_FOCUS_RETURN_UNCONFIRMED");
        }
        Action guard = delegate
        {
            if (background != null)
                VoiceObserveSubmittedForeground(request);
            if (background != null && GetForegroundWindow() != background.ForegroundBefore)
                background.ForegroundUnchanged = false;
            VoiceActive();
            Need(!Stopping, "VOICE_STOPPING");
            ValidateTime(request.Binding, UtcMs());
            VoiceBoundWindowGuard(request);
            if (background == null)
                Need(!VoiceWindowProcess(GetForegroundWindow(), request.Binding.Pid),
                     "VOICE_BACKGROUND_WECHAT_ACTIVATED");
            Need(VoiceCaptureInstance == capture && request.Uia.Recorder == recorder, "VOICE_CAPTURE_CHANGED");
            audio.CheckDefaults();
            string active = audio.ActiveSession(request.Binding.Pid);
            Need(active == null || active == capture, "VOICE_CAPTURE_CHANGED");
            VoiceActive();
        };
        Func<bool> observeEnd = delegate
        {
            return VoiceObserveUiaEnd(guard, audio.BoundCaptureInactive, delegate {
                VoiceUiaConversation(request);
                return VoiceUiaIdle(request);
            }, Now, Thread.Sleep);
        };
        try
        {
            if (background == null)
                return observeEnd();
            return VoiceCompleteBackgroundSubmission(observeEnd,
                                                     delegate {
                                                         background.Confirmed = true;
                                                         Recording.ObserveEnd(true, Now());
                                                     },
                                                     delegate {
                                                         VoiceWaitSubmittedPointerRelease(guard, delegate {
                                                             return VoiceSourceThreadState(request);
                                                         }, Now, Thread.Sleep);
                                                     },
                                                     delegate { VoiceReturnSubmittedForeground(request); });
        }
        finally
        {
            if (background != null)
                background.ForegroundUnchanged = background.ForegroundUnchanged &&
                                                 GetForegroundWindow() == background.ForegroundBefore &&
                                                 !VoiceWindowProcess(GetForegroundWindow(), request.Binding.Pid);
        }
    }
    static object RunVoice(VoiceRequest request)
    {
        Recording = new RecordingAttempt();
        long revision = Interlocked.Read(ref Revision);
        System.Threading.Timer recordingDeadline = null;
        Exception failure = null;
        VoiceGuard(request, revision, 0);
        Need(Snapshot(request.Binding.Window, request.Binding.Executable).InputTick == request.Binding.InputTick,
             "DRAFT_CALIBRATION_ACTIVITY_CHANGED");
        NoKeysHeld();
        using (var audio = new AudioRouteProbe.NativeVoiceAudio(request.RenderId, request.CaptureId, request.WaveFile,
                                                                request.WaveHash))
        {
            VoiceAudio = audio;
            VoiceDurationMs = audio.DurationMs;
            try
            {
                VoiceGuard(request, revision, 0);
                Need(audio.DurationMs > 0 && audio.DurationMs <= 8000, "VOICE_WAV_DURATION_LIMIT");
                if (request.Adaptive != null)
                {
                    Need(FileVersionInfo.GetVersionInfo(request.Binding.Executable).FileVersion ==
                             request.Adaptive.Version,
                         "VOICE_ADAPTIVE_EXECUTABLE_VERSION_MISMATCH");
                    LoadVoiceShapes();
                }
                while (Now() - Interlocked.Read(ref LastActivity) < request.Binding.Idle)
                {
                    Thread.Sleep(10);
                    VoiceGuard(request, revision, 0);
                }
                Need(Snapshot(request.Binding.Window, request.Binding.Executable).InputTick ==
                         request.Binding.InputTick,
                     "DRAFT_CALIBRATION_ACTIVITY_CHANGED");
                Need((request.Uia != null || !RecordingUi(request)) && audio.ActiveSession(request.Binding.Pid) == null,
                     "VOICE_RECORDER_ALREADY_ACTIVE");
                audio.CheckDefaults();
                // Baseline and end evidence use the same parked-pointer condition.
                // The original calibration input tick was checked before our first move.
                VoicePark(request, revision, 0);
                if (request.Uia == null)
                    request.Idle = new VoiceTemplate {
                        Rect = request.RecordStart,
                        Hash = VoiceHandoff == null
                                   ? CaptureTemplateHash(request, request.RecordStart)
                                   : VoiceWaitParkedIdle(
                                         delegate { VoiceGuard(request, revision, 0); },
                                         delegate { return CaptureTemplateHash(request, request.RecordStart); }, Now,
                                         delegate(int ms) { VoiceWait(request, revision, ms, 0); })
                    };
                if (VoiceHandoff != null)
                    VoiceValidateInitialCaptionBeforeRecording(request, revision);
                VoiceClick(request, revision, request.RecordStart, 0, delegate {
                    Recording.Begin(Now());
                    recordingDeadline = new System.Threading.Timer(delegate { StopVoice("VOICE_RECORDING_DEADLINE"); },
                                                                   null, 12000, Timeout.Infinite);
                });
                if (request.Uia != null)
                {
                    request.Uia.AfterStartState = VoiceUiaDiagnosticState(request);
                    VoiceGuard(request, revision, 2);
                }
                long readyDeadline = Now() + 1200;
                string candidate = null;
                VoiceUiaState readyState = null;
                while (Now() < readyDeadline)
                {
                    VoiceGuard(request, revision, 2);
                    candidate = audio.ActiveSession(request.Binding.Pid);
                    if (candidate != null && request.Uia != null)
                        request.Uia.CaptureCandidateObserved = true;
                    if (candidate != null && request.Adaptive != null && !request.AdaptiveBound)
                    {
                        try
                        {
                            BindVoiceAdaptive(request, revision);
                        }
                        catch (Fault error)
                        {
                            // Capture can become active before Qt finishes drawing
                            // both buttons. Only an uncommitted transient match is
                            // read again; ambiguity/activity/ownership still fail.
                            if (!VoiceMayWaitAdaptive(VoiceHandoff != null,
                                                      !request.AdaptiveBound && request.Cancel == null &&
                                                          request.Submit == null,
                                                      error.Message))
                                throw;
                            candidate = null;
                        }
                    }
                    if (candidate != null && request.Uia != null)
                    {
                        readyState = VoiceUiaReadState(request);
                        if (readyState.Kind == "recording")
                        {
                            VoiceGuard(request, revision, 1);
                            if (audio.ActiveSession(request.Binding.Pid) == candidate)
                                break;
                        }
                        candidate = null;
                        readyState = null;
                    }
                    else if (candidate != null && RecordingUi(request))
                    {
                        VoiceGuard(request, revision, 1);
                        VoiceWait(request, revision, 40, 1);
                        if (audio.ActiveSession(request.Binding.Pid) == candidate && RecordingUi(request))
                            break;
                        candidate = null;
                    }
                    VoiceWait(request, revision, 20, 2);
                }
                if (candidate == null && request.Uia != null)
                {
                    VoiceUiaDiagnosticState(request);
                    VoiceGuard(request, revision, 2);
                }
                Need(candidate != null &&
                         (request.Uia != null ? readyState != null && readyState.Kind == "recording"
                                              : RecordingUi(request) && !TemplateMatches(request, request.Idle)),
                     "VOICE_CAPTURE_NOT_READY");
                if (request.Uia != null)
                    VoiceUiaCommitRecorder(request, readyState);
                audio.BindCapture(request.Binding.Pid, candidate);
                VoiceCaptureInstance = candidate;
                VoiceCaptureVerified = true;
                VoiceCaptureMs = Now();
                VoicePark(request, revision, 2);
                VoiceGuard(request, revision, 1);
                audio.CheckDefaults();
                Need(audio.ActiveSession(request.Binding.Pid) == VoiceCaptureInstance, "VOICE_CAPTURE_CHANGED");
                if (VoiceHandoff != null)
                    VoiceReleaseInitialFocus(request, revision);
                audio.Start();
                VoicePlayMs = audio.StartedAtMs;
                VoiceAudioStarted = true;
                long nextCheck = Now();
                for (;;)
                {
                    VoiceActive();
                    if (VoiceHandoff == null)
                        Need(Interlocked.Read(ref Revision) == revision, "DRAFT_HUMAN_ACTIVITY_CHANGED");
                    if (audio.Pump())
                        break;
                    if (Now() >= nextCheck)
                    {
                        if (VoiceHandoff != null)
                            VoiceBackgroundGuard(request, audio);
                        else
                        {
                            VoiceGuard(request, revision, 1);
                            audio.CheckDefaults();
                            Need(audio.ActiveSession(request.Binding.Pid) == VoiceCaptureInstance &&
                                     RecordingUi(request),
                                 "VOICE_RECORDING_CONTEXT_CHANGED");
                        }
                        nextCheck = Now() + 100;
                    }
                    Thread.Sleep(5);
                }
                audio.StopOutput();
                VoiceDrainMs = audio.DrainedAtMs;
                VoiceAudioComplete = true;
                if (VoiceHandoff != null && request.Uia != null)
                {
                    VoiceBackgroundWait(request, audio, 200);
                    VoiceUiaSubmitInBackground(request, audio);
                    Recording.ObserveEnd(VoiceSubmittedEndObserved(request, audio, true), Now());
                }
                else
                {
                    if (VoiceHandoff != null)
                    {
                        VoiceBackgroundWait(request, audio, 200);
                        revision = VoiceAcquireSubmitFocus(request, audio);
                    }
                    else
                    {
                        VoiceGuard(request, revision, 1);
                        VoiceWait(request, revision, 200, 1);
                    }
                    audio.CheckDefaults();
                    Need(audio.ActiveSession(request.Binding.Pid) == VoiceCaptureInstance &&
                             (request.Uia != null || RecordingUi(request)),
                         "VOICE_RECORDING_CONTEXT_CHANGED");
                    Need(Now() - Recording.StartedAt < 11000, "VOICE_RECORDING_DEADLINE");
                    VoiceClick(request, revision, request.Submit.Rect, 1, delegate { Recording.BeginSubmit(Now()); });
                    Recording.ConfirmSubmitInput();
                    VoicePark(request, revision, 2);
                    Recording.ObserveEnd(EndObserved(request, revision, audio, false), Now());
                }
                Need(Recording.Ended, "VOICE_RECORDING_END_UNCONFIRMED");
            }
            catch (Exception error)
            {
                string failureCode = VoiceInterruptedFailureCode(VoiceSafeReason(error), VoiceStopReason);
                failure = failureCode == VoiceSafeReason(error) ? error : new Fault(failureCode);
                if (failureCode == "VOICE_CAPTURE_NOT_READY")
                    VoiceCaptureFailureFrame(request, revision);
                audio.Cancel();
                try
                {
                    audio.StopOutput();
                }
                catch
                {
                }
                // A definite pre-submit interruption may acquire a new lease
                // solely to cancel the same bound recorder. An uncertain send
                // never enters this path and can only be resolved by receipts.
                if (VoiceMayCancelInterrupted(failureCode, Recording.PossiblyActive, Recording.SubmitAttempted,
                                              request.AllowCancel, VoiceCaptureVerified && VoiceCaptureInstance != null,
                                              CancelAttempted,
                                              Interlocked.CompareExchange(ref VoiceExternalStop, 0, 0) != 0))
                    VoiceCancelInterrupted(request, audio);
                else if (MayCancel(Recording.PossiblyActive, Recording.SubmitAttempted, request.AllowCancel, revision,
                                   Interlocked.Read(ref Revision)))
                {
                    try
                    {
                        VoiceCancellationStage = "esc";
                        VoiceCancelEsc(request, revision, audio);
                        VoiceCancellationStage = "end";
                        Recording.ObserveEnd(CancelledCaptureEnded(request, revision, audio), Now());
                        Need(Recording.Ended, "VOICE_RECORDING_END_UNCONFIRMED");
                        VoiceCancellationStage = "ended";
                    }
                    catch (Exception cleanupError)
                    {
                        VoiceCancellationFailure = VoiceSafeReason(cleanupError);
                    }
                }
            }
            finally
            {
                if (recordingDeadline != null)
                    recordingDeadline.Dispose();
                audio.StopOutput();
                VoicePlayMs = audio.StartedAtMs;
                VoiceDrainMs = audio.DrainedAtMs;
                VoiceAudioStarted = VoicePlayMs > 0;
                VoiceAudioComplete = audio.PlaybackCompleted;
                VoicePumpDiagnostic = audio.PumpReport();
                VoiceAudio = null;
            }
        }
        if (failure != null)
            throw failure;
        return VoiceReport(true, null);
    }
}
