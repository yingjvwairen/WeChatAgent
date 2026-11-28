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

internal static partial class WechatDraftProbe
{
    static int VoiceWarmPhase;
    static bool VoiceWarmCollect(bool own)
    {
        if (Interlocked.CompareExchange(ref VoiceWarmPhase, 0, 0) != 1)
            return false;
        if (!own)
            Human();
        return true;
    }
    static string ParseVoiceWarmInit(object value)
    {
        var data = Map(value);
        Need(data != null && data.Count == 3 && Text(data, "action") == "warmVoiceMonitor" &&
                 Number(Get(data, "version")) == 1 && Hex(Text(data, "nonce"), 64),
             "VOICE_WARMUP_REQUEST_INVALID");
        return Text(data, "nonce");
    }
    static Dictionary<string, object> ParseVoiceWarmExecution(object value, string nonce, string monitorId,
                                                              out bool production)
    {
        var data = Map(value);
        Need(data != null && data.Count == 6 && Text(data, "action") == "executeWarmVoice" &&
                 Number(Get(data, "version")) == 1 && Text(data, "nonce") == nonce &&
                 Text(data, "monitorId") == monitorId,
             "VOICE_WARMUP_BINDING_INVALID");
        string mode = Text(data, "mode");
        Need(mode == "private-send" || mode == "private-once", "VOICE_WARMUP_MODE_INVALID");
        production = mode == "private-send";
        var request = Map(Get(data, "request"));
        Need(request != null && Text(request, "action") == (production ? "timedVoiceSend" : "timedVoicePreview"),
             "VOICE_WARMUP_MODE_INVALID");
        return request;
    }
    static int VoiceWarmMain()
    {
        using (var hard = new System.Threading.Timer(delegate {
            StopVoice(Interlocked.CompareExchange(ref VoiceWarmPhase, 0, 0) == 1 ? "VOICE_WARMUP_TIMEOUT"
                                                                                 : "VOICE_HARD_TIMEOUT");
            Environment.Exit(124);
        }, null, 60000, Timeout.Infinite))
        {
            try
            {
                string nonce = ParseVoiceWarmInit(Json.DeserializeObject(ReadLine())),
                       monitorId = Guid.NewGuid().ToString("N");
                SetProcessDpiAwarenessContext(new IntPtr(-4));
                VoiceUiaWarm();
                LastActivity = ActivityMonitorStarted = Now();
                VoiceStartCaptionMonitor();
                Interlocked.Exchange(ref VoiceWarmPhase, 1);
                // Monitoring owns no input or audio mutex, and no window or
                // audio device is accessed before the one-time execution packet.
                using (var process = Process.GetCurrentProcess())
                {
                    IntPtr module = GetModuleHandle(process.MainModule.ModuleName);
                    KeyboardHook = SetWindowsHookEx(13, VoiceKeyboardCallback, module, 0);
                    MouseHook = SetWindowsHookEx(14, VoiceMouseCallback, module, 0);
                }
                Need(KeyboardHook != IntPtr.Zero && MouseHook != IntPtr.Zero, "VOICE_ACTIVITY_MONITOR_UNAVAILABLE");
                Dispatcher = new Control();
                var owner = Dispatcher.Handle;
                bool executionStarted = false;
                var worker = new Thread(delegate() {
                    Mutex inputGate = null;
                    try
                    {
                        // This is the only execution read. Any additional input or
                        // EOF after commit is handled solely as cancellation.
                        string line = ReadLine();
                        long revision = Interlocked.Read(ref Revision);
                        var packet = Json.DeserializeObject(line);
                        bool production;
                        var value = ParseVoiceWarmExecution(packet, nonce, monitorId, out production);
                        VoiceProduction = production;
                        VoiceRequest request = production ? ParseVoiceSend(value) : ParseVoice(value);
                        Need(request.FocusHandoff != null, "VOICE_WARMUP_SHARED_REQUIRED");
                        Need(Interlocked.CompareExchange(ref VoiceWarmPhase, 2, 1) == 1,
                             "VOICE_WARMUP_ALREADY_COMMITTED");
                        hard.Change(18000, Timeout.Infinite);
                        Need(Interlocked.Read(ref Revision) == revision, "DRAFT_HUMAN_ACTIVITY_CHANGED");
                        VoiceActive();
                        NoKeysHeld();
                        inputGate = Acquire("Local\\WeChatAgent.UiInput.v1");
                        using (var audioGate = Acquire("Local\\WeChatAgent.AudioProbe.v1"))
                        {
                            try
                            {
                                Need(Interlocked.Read(ref Revision) == revision, "DRAFT_HUMAN_ACTIVITY_CHANGED");
                                VoiceActive();
                                // RunVoice retains the complete idle threshold,
                                // snapshot input-tick, account/chat and audio guards.
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
                                executionStarted = true;
                                Write(RunVoiceWithFocusHandoff(request));
                            }
                            finally
                            {
                                audioGate.ReleaseMutex();
                            }
                        }
                    }
                    catch (Exception error)
                    {
                        ExitCode = 1;
                        Write(executionStarted
                                  ? VoiceFailure(error)
                                  : Data("ok", false, "phase", "rejected", "protocol", "voice-warm-v1", "nonce", nonce,
                                         "monitorId", monitorId, "reason", VoiceSafeReason(error), "executionStarted",
                                         false, "inputSent", false, "recordingStarted", false,
                                         "focusOwnershipTransferred", false));
                    }
                    finally
                    {
                        Interlocked.Exchange(ref VoiceWarmPhase, 3);
                        Stopping = true;
                        if (inputGate != null)
                        {
                            try
                            {
                                inputGate.ReleaseMutex();
                            }
                            finally
                            {
                                inputGate.Dispose();
                            }
                        }
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
                // Announce readiness only from the running message pump, after
                // both hooks are installed. The monitor remains continuous.
                Dispatcher.BeginInvoke((Action)delegate {
                    LastActivity = ActivityMonitorStarted = Now();
                    Write(Data("ok", true, "phase", "ready", "protocol", "voice-warm-v1", "nonce", nonce, "monitorId",
                               monitorId, "readOnly", true, "inputSent", false, "mutexHeld", false, "maximumWarmupMs",
                               60000));
                    worker.Start();
                });
                Application.Run();
                return ExitCode;
            }
            catch (Exception error)
            {
                Write(VoiceFailure(error));
                return 1;
            }
            finally
            {
                Interlocked.Exchange(ref VoiceWarmPhase, 3);
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
}
