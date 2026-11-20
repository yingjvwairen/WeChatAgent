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

internal static class WechatVoicePreview {
    [STAThread] static int Main(string[] args) { return WechatDraftProbe.VoiceMain(args); }
}

internal static partial class WechatDraftProbe {
    sealed class VoiceTemplate { internal Rect Rect; internal string Hash; }
    sealed class VoiceRequest {
        internal Request Binding;
        internal string Id,WaveFile,WaveHash,RenderId,CaptureId;
        internal IntPtr RecordingFocus;
        internal Rect RecordStart,MousePark;
        internal bool MouseParkProvided;
        internal VoiceTemplate Cancel,Submit;
        internal VoiceTemplate Idle,TitleAnchor;
        internal VoiceAdaptivePlan Adaptive;
        internal VoiceUiaPlan Uia;
        internal bool AdaptiveBound;
        internal double AdaptiveCancelScore,AdaptiveSubmitScore;
        internal bool AllowCancel;
        internal VoiceReturnWindow FocusHandoff;
    }
    static int VoiceCancelled,VoiceExternalStop;
    static string VoiceStopReason;
    static bool RecordingAttempted,VoiceSubmitAttempted,VoiceSubmitApplied,CancelAttempted,CancelInputApplied,RecordingPossible;
    static string VoiceCancellationStage,VoiceCancellationFailure;
    static bool VoiceAudioStarted,VoiceAudioComplete,VoiceCaptureVerified,VoiceRecordingEnded;
    static long VoiceStartMs,VoiceCaptureMs,VoicePlayMs,VoiceDrainMs,VoiceSubmitMs,VoiceEndedMs;
    static double VoiceDurationMs;
    static object VoicePumpDiagnostic;
    static object VoiceAdaptiveDiagnostic;
    static AudioRouteProbe.NativeVoiceAudio VoiceAudio;
    static string VoiceCaptureInstance;
    static bool VoiceMouseDiagnostic,VoiceProduction,MouseMoveAttempted,MouseMoveInputApplied;
    static int VoiceOwnMouseObserved;
    static int VoiceMouseParkMovesApplied;
    sealed class VoiceActivityDiagnostic {
        internal string Kind;internal bool Injected,OwnMarker,Lower32Matches,MarkerIsZero;internal uint Message;internal long? TimeAfterRecordStartMs;
        internal object Report(){return Data("kind",Kind,"injected",Injected,"ownMarker",OwnMarker,"lower32Matches",Lower32Matches,"markerIsZero",MarkerIsZero,"message",Message,"timeAfterRecordStartMs",TimeAfterRecordStartMs);}
    }
    static VoiceActivityDiagnostic VoiceHumanActivity;
    static readonly HookProc VoiceKeyboardCallback=OnVoiceKeyboard,VoiceMouseCallback=OnVoiceMouse;
    // 0 legacy startup; 1 read-only monitor; 2 one committed execution; 3 done.
    static int VoiceWarmPhase;
    static bool VoiceWarmCollect(bool own){if(Interlocked.CompareExchange(ref VoiceWarmPhase,0,0)!=1)return false;if(!own)Human();return true;}
    static string ParseVoiceWarmInit(object value){var data=Map(value);Need(data!=null&&data.Count==3&&Text(data,"action")=="warmVoiceMonitor"&&Number(Get(data,"version"))==1&&Hex(Text(data,"nonce"),64),"VOICE_WARMUP_REQUEST_INVALID");return Text(data,"nonce");}
    static Dictionary<string,object> ParseVoiceWarmExecution(object value,string nonce,string monitorId,out bool production){
        var data=Map(value);Need(data!=null&&data.Count==6&&Text(data,"action")=="executeWarmVoice"&&Number(Get(data,"version"))==1&&Text(data,"nonce")==nonce&&Text(data,"monitorId")==monitorId,"VOICE_WARMUP_BINDING_INVALID");
        string mode=Text(data,"mode");Need(mode=="private-send"||mode=="private-once","VOICE_WARMUP_MODE_INVALID");production=mode=="private-send";var request=Map(Get(data,"request"));Need(request!=null&&Text(request,"action")== (production?"timedVoiceSend":"timedVoicePreview"),"VOICE_WARMUP_MODE_INVALID");return request;
    }
    static int VoiceWarmMain(){
        using(var hard=new System.Threading.Timer(delegate{StopVoice(Interlocked.CompareExchange(ref VoiceWarmPhase,0,0)==1?"VOICE_WARMUP_TIMEOUT":"VOICE_HARD_TIMEOUT");Environment.Exit(124);},null,60000,Timeout.Infinite)){
            try{
                string nonce=ParseVoiceWarmInit(Json.DeserializeObject(ReadLine())),monitorId=Guid.NewGuid().ToString("N");
                SetProcessDpiAwarenessContext(new IntPtr(-4));VoiceUiaWarm();LastActivity=ActivityMonitorStarted=Now();VoiceStartCaptionMonitor();Interlocked.Exchange(ref VoiceWarmPhase,1);
                // Monitoring owns no input or audio mutex, and no window or
                // audio device is accessed before the one-time execution packet.
                using(var process=Process.GetCurrentProcess()){IntPtr module=GetModuleHandle(process.MainModule.ModuleName);KeyboardHook=SetWindowsHookEx(13,VoiceKeyboardCallback,module,0);MouseHook=SetWindowsHookEx(14,VoiceMouseCallback,module,0);}
                Need(KeyboardHook!=IntPtr.Zero&&MouseHook!=IntPtr.Zero,"VOICE_ACTIVITY_MONITOR_UNAVAILABLE");Dispatcher=new Control();var owner=Dispatcher.Handle;
                bool executionStarted=false;var worker=new Thread(delegate(){Mutex inputGate=null;try{
                    // This is the only execution read. Any additional input or
                    // EOF after commit is handled solely as cancellation.
                    string line=ReadLine();long revision=Interlocked.Read(ref Revision);var packet=Json.DeserializeObject(line);bool production;var value=ParseVoiceWarmExecution(packet,nonce,monitorId,out production);
                    VoiceProduction=production;VoiceRequest request=production?ParseVoiceSend(value):ParseVoice(value);Need(request.FocusHandoff!=null,"VOICE_WARMUP_SHARED_REQUIRED");
                    Need(Interlocked.CompareExchange(ref VoiceWarmPhase,2,1)==1,"VOICE_WARMUP_ALREADY_COMMITTED");hard.Change(18000,Timeout.Infinite);
                    Need(Interlocked.Read(ref Revision)==revision,"DRAFT_HUMAN_ACTIVITY_CHANGED");VoiceActive();NoKeysHeld();
                    inputGate=Acquire("Local\\WeChatAgent.UiInput.v1");
                    using(var audioGate=Acquire("Local\\WeChatAgent.AudioProbe.v1")){
                        try{
                            Need(Interlocked.Read(ref Revision)==revision,"DRAFT_HUMAN_ACTIVITY_CHANGED");VoiceActive();
                            // RunVoice retains the complete idle threshold,
                            // snapshot input-tick, account/chat and audio guards.
                            var controls=new Thread(delegate(){try{Console.In.Read();}catch{}StopVoice("VOICE_PARENT_CLOSED");});controls.IsBackground=true;controls.Start();
                            executionStarted=true;Write(RunVoiceWithFocusHandoff(request));
                        }finally{audioGate.ReleaseMutex();}
                    }
                }catch(Exception error){ExitCode=1;Write(executionStarted?VoiceFailure(error):Data("ok",false,"phase","rejected","protocol","voice-warm-v1","nonce",nonce,"monitorId",monitorId,"reason",VoiceSafeReason(error),"executionStarted",false,"inputSent",false,"recordingStarted",false,"focusOwnershipTransferred",false));}
                finally{Interlocked.Exchange(ref VoiceWarmPhase,3);Stopping=true;if(inputGate!=null){try{inputGate.ReleaseMutex();}finally{inputGate.Dispose();}}try{Dispatcher.BeginInvoke((Action)delegate{Application.ExitThread();});}catch{}}});
                worker.IsBackground=true;worker.SetApartmentState(ApartmentState.MTA);
                // Announce readiness only from the running message pump, after
                // both hooks are installed. The monitor remains continuous.
                Dispatcher.BeginInvoke((Action)delegate{LastActivity=ActivityMonitorStarted=Now();Write(Data("ok",true,"phase","ready","protocol","voice-warm-v1","nonce",nonce,"monitorId",monitorId,"readOnly",true,"inputSent",false,"mutexHeld",false,"maximumWarmupMs",60000));worker.Start();});
                Application.Run();return ExitCode;
            }catch(Exception error){Write(VoiceFailure(error));return 1;}
            finally{Interlocked.Exchange(ref VoiceWarmPhase,3);Stopping=true;MouseObservationObserver=null;if(KeyboardHook!=IntPtr.Zero)UnhookWindowsHookEx(KeyboardHook);if(MouseHook!=IntPtr.Zero)UnhookWindowsHookEx(MouseHook);if(Dispatcher!=null)Dispatcher.Dispose();if(Gate!=null){try{Gate.ReleaseMutex();}finally{Gate.Dispose();}}}
        }
    }

    internal static int VoiceMain(string[] args) {
        if(args.Length>0&&args[0]=="--adaptive-layout-check")return VoiceAdaptiveImageCheck(args);
        Console.InputEncoding=new UTF8Encoding(false);Console.OutputEncoding=new UTF8Encoding(false);
        if(args.Length==1&&args[0]=="--self-test")return VoiceSelfTest();
        if(args.Length==1&&args[0]=="--private-warm")return VoiceWarmMain();
        VoiceMouseDiagnostic=args.Length==1&&args[0]=="--private-mouse-diagnostic";
        VoiceProduction=args.Length==1&&args[0]=="--private-send";
        using(var hard=new System.Threading.Timer(delegate{StopVoice("VOICE_HARD_TIMEOUT");Environment.Exit(124);},null,VoiceMouseDiagnostic?5000:18000,Timeout.Infinite)) {
            try {
                Need(VoiceMouseDiagnostic||VoiceProduction||(args.Length==1&&args[0]=="--private-once"),"VOICE_ARGUMENTS_INVALID");
                var value=Map(Json.DeserializeObject(ReadLine()));VoiceRequest request=VoiceMouseDiagnostic?ParseMouseDiagnostic(value):VoiceProduction?ParseVoiceSend(value):ParseVoice(value);
                if(request.FocusHandoff!=null)VoiceHandoff=new VoiceHandoffState{InitialReturn=request.FocusHandoff,WechatWindow=request.Binding.Window,WechatPid=request.Binding.Pid};
                SetProcessDpiAwarenessContext(new IntPtr(-4));
                Gate=Acquire("Local\\WeChatAgent.UiInput.v1");
                using(var audioGate=Acquire("Local\\WeChatAgent.AudioProbe.v1")) {
                    try {
                        LastActivity=ActivityMonitorStarted=Now();VoiceStartCaptionMonitor();
                        using(var process=Process.GetCurrentProcess()){IntPtr module=GetModuleHandle(process.MainModule.ModuleName);KeyboardHook=SetWindowsHookEx(13,VoiceKeyboardCallback,module,0);MouseHook=SetWindowsHookEx(14,VoiceMouseCallback,module,0);}
                        Need(KeyboardHook!=IntPtr.Zero&&MouseHook!=IntPtr.Zero,"VOICE_ACTIVITY_MONITOR_UNAVAILABLE");
                        Dispatcher=new Control();var owner=Dispatcher.Handle;
                        var controls=new Thread(delegate(){try{Console.In.Read();}catch{}StopVoice("VOICE_PARENT_CLOSED");});controls.IsBackground=true;controls.Start();
                        var worker=new Thread(delegate(){try{Write(VoiceMouseDiagnostic?RunMouseDiagnostic(request):RunVoiceWithFocusHandoff(request));}catch(Exception error){ExitCode=1;Write(VoiceFailure(error));}finally{Stopping=true;try{Dispatcher.BeginInvoke((Action)delegate{Application.ExitThread();});}catch{}}});
                        worker.IsBackground=true;worker.SetApartmentState(ApartmentState.MTA);worker.Start();Application.Run();return ExitCode;
                    } finally { audioGate.ReleaseMutex(); }
                }
            } catch(Exception error){Write(VoiceFailure(error));return 1;}
            finally {Stopping=true;MouseObservationObserver=null;if(KeyboardHook!=IntPtr.Zero)UnhookWindowsHookEx(KeyboardHook);if(MouseHook!=IntPtr.Zero)UnhookWindowsHookEx(MouseHook);if(Dispatcher!=null)Dispatcher.Dispose();if(Gate!=null){try{Gate.ReleaseMutex();}finally{Gate.Dispose();}}}
        }
    }
    static void StopVoice(string code){if(code!="DRAFT_HUMAN_ACTIVITY_CHANGED"&&code!="VOICE_RECORDING_DEADLINE")Interlocked.Exchange(ref VoiceExternalStop,1);Interlocked.CompareExchange(ref VoiceStopReason,code,null);Interlocked.Exchange(ref VoiceCancelled,1);var audio=VoiceAudio;if(audio!=null)audio.Cancel();}
    // Only the first event that already fails Own is retained. Never retain a key,
    // pointer position, marker value, title, or text; diagnostics do not relax Own.
    static bool ObserveVoiceInput(string kind,uint flags,uint injectedMask,UIntPtr marker,uint message,long observedAt){
        if(Own(flags,injectedMask,marker)){if(kind=="mouse")Interlocked.Exchange(ref VoiceOwnMouseObserved,1);return false;}
        long started=Interlocked.Read(ref VoiceStartMs);
        var diagnostic=new VoiceActivityDiagnostic{Kind=kind,Injected=(flags&injectedMask)!=0,OwnMarker=marker.Equals(Marker),Lower32Matches=unchecked((uint)marker.ToUInt64())==unchecked((uint)Marker.ToUInt64()),MarkerIsZero=marker.Equals(UIntPtr.Zero),Message=message,TimeAfterRecordStartMs=started>0?(long?)Math.Max(0,observedAt-started):null};
        Interlocked.CompareExchange(ref VoiceHumanActivity,diagnostic,null);return true;
    }
    static object VoiceActivityReport(){var diagnostic=Interlocked.CompareExchange(ref VoiceHumanActivity,null,null);return diagnostic==null?null:diagnostic.Report();}
    static IntPtr OnVoiceKeyboard(int code,IntPtr message,IntPtr data){if(code>=0){var input=(KeyboardHookData)Marshal.PtrToStructure(data,typeof(KeyboardHookData));bool own=Own(input.Flags,0x10,input.Extra);VoiceNotePointerActivity(own);if(!VoiceWarmCollect(own)&&!VoiceAllowOtherAppInput("keyboard",input.Flags,0x10,input.Extra,unchecked((uint)message.ToInt64()),new Point(0,0))&&ObserveVoiceInput("keyboard",input.Flags,0x10,input.Extra,unchecked((uint)message.ToInt64()),Now())){Human();StopVoice("DRAFT_HUMAN_ACTIVITY_CHANGED");}}return CallNextHookEx(KeyboardHook,code,message,data);}
    static IntPtr OnVoiceMouse(int code,IntPtr message,IntPtr data){if(code>=0){var input=(MouseHookData)Marshal.PtrToStructure(data,typeof(MouseHookData));bool own=Own(input.Flags,1,input.Extra);VoiceNotePointerActivity(own);if(!VoiceWarmCollect(own)&&!VoiceAllowOtherAppInput("mouse",input.Flags,1,input.Extra,unchecked((uint)message.ToInt64()),input.Point)&&ObserveVoiceInput("mouse",input.Flags,1,input.Extra,unchecked((uint)message.ToInt64()),Now())){Human();StopVoice("DRAFT_HUMAN_ACTIVITY_CHANGED");}var observer=MouseObservationObserver;if(observer!=null)try{observer(unchecked((uint)message.ToInt64()),input.Point);}catch{MouseObservationObserver=null;}}return CallNextHookEx(MouseHook,code,message,data);}
    static void VoiceActive(){Need(Interlocked.CompareExchange(ref VoiceCancelled,0,0)==0,VoiceStopReason??"VOICE_CANCELLED");}
    static bool MayCancel(bool possible,bool submitted,bool allowed,long originalRevision,long currentRevision){return possible&&!submitted&&allowed&&originalRevision==currentRevision;}
    static bool VoiceMayCancelInterrupted(string reason,bool possible,bool submitted,bool allowed,bool captureBound,bool cancelAttempted,bool externalStop){
        return (reason=="DRAFT_HUMAN_ACTIVITY_CHANGED"||reason=="VOICE_BACKGROUND_WECHAT_ACTIVATED")&&possible&&!submitted&&allowed&&captureBound&&!cancelAttempted&&!externalStop;
    }
    static string VoiceInterruptedFailureCode(string reason,string stopReason){return reason=="AUDIO_PLAYBACK_CANCELLED"&&stopReason=="DRAFT_HUMAN_ACTIVITY_CHANGED"?stopReason:reason;}
    static void VoiceWaitCancellationQuiet(long deadline,int quietMs,Func<long> clock,Func<long> lastInput,Func<bool> keysReleased,Action guard,Action<int> sleep){
        for(;;){guard();long now=clock();Need(now<deadline,"VOICE_INTERRUPTION_CLEANUP_TIMEOUT");
            if(keysReleased()&&now-lastInput()>=quietMs){guard();return;}sleep((int)Math.Min(10,deadline-now));}
    }
    static void VoiceCancelInterrupted(VoiceRequest request,AudioRouteProbe.NativeVoiceAudio audio){
        try{
            // Keep the process's original bounded lifetime. This only waits
            // for ordinary inactivity; it never keeps an old clip for sending.
            long deadline=Math.Min(VoiceStartMs+13000,Now()+4000);
            int quiet=Math.Max(request.Binding.Idle,VoiceHandoff==null?250:VoiceSafeGapMs(FocusDoubleClickTime()));
            VoiceCancellationStage="quiet";VoiceWaitCancellationQuiet(deadline,quiet,Now,delegate{return Interlocked.Read(ref LastActivity);},VoiceKeysReleased,delegate{
                Need(!Stopping&&Interlocked.CompareExchange(ref VoiceExternalStop,0,0)==0&&!VoiceSubmitAttempted,"VOICE_INTERRUPTION_CLEANUP_UNAVAILABLE");
                ValidateTime(request.Binding,UtcMs());VoiceBoundWindowGuard(request);audio.CheckDefaults();
                Need(VoiceCaptureInstance!=null&&audio.ActiveSession(request.Binding.Pid)==VoiceCaptureInstance,"VOICE_CAPTURE_CHANGED");
            },Thread.Sleep);
            VoiceCancellationStage="focus";long revision=VoiceAcquireCancellationFocus(request,audio);
            VoiceCancellationStage="esc";VoiceCancelEsc(request,revision,audio);
            VoiceCancellationStage="end";VoiceRecordingEnded=CancelledCaptureEnded(request,revision,audio);
            RecordingPossible=!VoiceRecordingEnded;if(VoiceRecordingEnded)VoiceEndedMs=Now();
            Need(VoiceRecordingEnded,"VOICE_RECORDING_END_UNCONFIRMED");VoiceCancellationStage="ended";
        }catch(Exception error){VoiceCancellationFailure=VoiceSafeReason(error);}
        finally{VoiceFinishCancellationFocus(request);}
    }
    static string VoiceSafeReason(Exception error){string code=error.Message;return code!=null&&System.Text.RegularExpressions.Regex.IsMatch(code,"^(VOICE|DRAFT|AUDIO)_[A-Z_]{1,80}$")?code:"VOICE_PREVIEW_FAILED";}
    static object VoiceFailure(Exception error){string code=VoiceSafeReason(error);return VoiceMouseDiagnostic?MouseDiagnosticReport(false,code):VoiceReport(false,code);}
    static object MouseDiagnosticReport(bool ok,string reason){return Data("ok",ok,"mode","mouseMarkerDiagnostic","reason",reason,"mouseMoveAttempted",MouseMoveAttempted,"mouseMoveInputApplied",MouseMoveInputApplied,"ownMouseObserved",Interlocked.CompareExchange(ref VoiceOwnMouseObserved,0,0)!=0,"humanActivity",VoiceActivityReport(),"recordingAttempted",false,"audioStarted",false,"submitAttempted",false,"messageSent",false,"systemSettingsChanged",false);}
    static object VoiceReport(bool ok,string reason){var report=Data("ok",ok,"mode",VoiceProduction?"timedVoiceSend":"timedVoicePreview","targetGuarded",VoiceProduction,"reason",reason,"recordingAttempted",RecordingAttempted,"recordingPossible",RecordingPossible,
        "captureVerified",VoiceCaptureVerified,"captureSessionBound",VoiceCaptureInstance!=null,"audioStarted",VoiceAudioStarted,"playbackComplete",VoiceAudioComplete,
        "submitAttempted",VoiceSubmitAttempted,"submitInputApplied",VoiceSubmitApplied,"cancelAttempted",CancelAttempted,"cancelInputApplied",CancelInputApplied,
        "recordingEndedObserved",VoiceRecordingEnded,"deliveryConfirmed",false,"unattendedReady",false,"systemSettingsChanged",false,"microphoneOpened",false,
        "queuedAudioLimitMs",20,"deviceLatencyBounded",false,
        "mouseParkMovesApplied",VoiceMouseParkMovesApplied,"uiaPointerMessagesPosted",VoiceUiaPointerMessages,
        "humanActivity",VoiceActivityReport(),
        "audioPump",VoicePumpDiagnostic,"adaptiveRecordingUi",VoiceAdaptiveDiagnostic,
        "sourceDurationMs",VoiceDurationMs,"playbackElapsedMs",VoiceDrainMs>0&&VoicePlayMs>0?VoiceDrainMs-VoicePlayMs:0,"recordingElapsedMs",VoiceStartMs>0?(VoiceEndedMs>0?VoiceEndedMs:Now())-VoiceStartMs:0,
        "timelineMs",Data("recordStart",VoiceStartMs,"captureReady",VoiceCaptureMs,"playStart",VoicePlayMs,"playDrained",VoiceDrainMs,"submit",VoiceSubmitMs,"recordEnded",VoiceEndedMs));if(VoiceHandoff!=null)report["focusHandoff"]=VoiceFocusHandoffReport();if(VoiceUiaDiagnostic!=null)report["uiaRecordingUi"]=VoiceUiaReport();if(VoiceCancellationStage!=null)report["cancellationCleanup"]=Data("version",1,"stage",VoiceCancellationStage,"reason",VoiceCancellationFailure);return report;}
    static VoiceTemplate ParseTemplate(object value,Rect client){var map=Map(value);Need(map!=null&&map.Count==2&&Hex(Text(map,"rgbaSha256"),64),"VOICE_TEMPLATE_INVALID");Rect rect=ParseRect(Get(map,"rect"));Need(Contains(client,rect)&&rect.Width>=4&&rect.Height>=4&&rect.Width<=128&&rect.Height<=128,"VOICE_TEMPLATE_INVALID");return new VoiceTemplate{Rect=rect,Hash=Text(map,"rgbaSha256")};}
    static VoiceRequest ParseMouseDiagnostic(Dictionary<string,object> value){Need(value!=null&&Text(value,"action")=="probeMouseMarker","VOICE_REQUEST_INVALID");Need(Object.Equals(Get(Map(Get(value,"permission")),"mouseMoveDiagnostic"),true),"VOICE_PERMISSION_REQUIRED");
        Request binding=Parse(Data("action","verifyDraft","permission",Data("selectionCopy",true,"caretToEnd",true,"clipboardRestore",true),"expectedDraft","mouse calibration only","idleMs",Get(value,"idleMs"),"session",Get(value,"session")));
        Need(binding.OperatorCalibrated&&binding.Idle<=1500&&binding.Expires-UtcMs()>=4000,"VOICE_MOUSE_SESSION_INVALID");Rect target=ParseRect(Get(value,"mouseTargetRect"));Need(Contains(binding.Client,target)&&target.Width>=2&&target.Height>=2&&target.Width<=128&&target.Height<=128,"VOICE_MOUSE_TARGET_INVALID");return new VoiceRequest{Binding=binding,RecordStart=target};}
    static object RunMouseDiagnostic(VoiceRequest request){long revision=Interlocked.Read(ref Revision);VoiceGuard(request,revision,0);Need(Snapshot(request.Binding.Window,request.Binding.Executable).InputTick==request.Binding.InputTick,"DRAFT_CALIBRATION_ACTIVITY_CHANGED");NoKeysHeld();
        while(Now()-Interlocked.Read(ref LastActivity)<request.Binding.Idle){Thread.Sleep(10);VoiceGuard(request,revision,0);}
        Need(Snapshot(request.Binding.Window,request.Binding.Executable).InputTick==request.Binding.InputTick,"DRAFT_CALIBRATION_ACTIVITY_CHANGED");
        Point center=new Point(request.Binding.Capture.Left+request.RecordStart.Left+request.RecordStart.Width/2,request.Binding.Capture.Top+request.RecordStart.Top+request.RecordStart.Height/2);int left=GetSystemMetrics(76),top=GetSystemMetrics(77);Input move=ClickEvents(center.X,center.Y,new Rect(left,top,left+GetSystemMetrics(78),top+GetSystemMetrics(79)))[0];
        VoiceGuard(request,revision,0);NoKeysHeld();Need(Owned(WindowFromPoint(center),request.Binding.Window,request.Binding.Pid),"VOICE_BUTTON_OBSCURED");VoiceGuard(request,revision,0);MouseMoveAttempted=true;VoiceActive();Need(Interlocked.Read(ref Revision)==revision&&GetForegroundWindow()==request.Binding.Window,"DRAFT_HUMAN_ACTIVITY_CHANGED");
        uint accepted=SendInput(1,new[]{move},Marshal.SizeOf(typeof(Input)));MouseMoveInputApplied=accepted==1;Need(MouseMoveInputApplied,"VOICE_MOUSE_INPUT_UNCERTAIN");VoiceWait(request,revision,200,0);VoiceGuard(request,revision,0);Need(Interlocked.CompareExchange(ref VoiceOwnMouseObserved,0,0)!=0,"VOICE_MOUSE_HOOK_UNCONFIRMED");return MouseDiagnosticReport(true,null);}
    static VoiceRequest ParseVoice(Dictionary<string,object> value){Need(value!=null&&Text(value,"action")=="timedVoicePreview"&&Hex(Text(value,"id"),64)&&Hex(Text(value,"audioSha256"),64),"VOICE_REQUEST_INVALID");
        var permit=Map(Get(value,"permission"));Need(Object.Equals(Get(permit,"recordPreview"),true)&&Object.Equals(Get(permit,"playAudio"),true)&&Object.Equals(Get(permit,"submitPreview"),true),"VOICE_PERMISSION_REQUIRED");
        var session=Map(Get(value,"session"));bool uncheckedDraft=session!=null&&Text(session,"draftPolicy")=="unchecked"&&Object.Equals(Get(session,"emptyDraftConfirmed"),false)&&Map(Get(value,"focusHandoff"))!=null;
        Need(session!=null&&(uncheckedDraft||!session.ContainsKey("draftPolicy")&&Object.Equals(Get(session,"emptyDraftConfirmed"),true)),"VOICE_EMPTY_DRAFT_CONFIRMATION_REQUIRED");
        // Reuse all process/window/short-session checks without claiming clipboard proof.
        var seed=Data("action","verifyDraft","permission",Data("selectionCopy",true,"caretToEnd",true,"clipboardRestore",true),"expectedDraft","voice calibration only","idleMs",Get(value,"idleMs"),"session",session);
        Request binding=Parse(seed);Need(binding.OperatorCalibrated,"VOICE_OPERATOR_CALIBRATION_REQUIRED");
        Need(binding.Expires-UtcMs()>=16000,"VOICE_SESSION_BUDGET_EXCEEDED");
        var ui=Map(Get(session,"recordingUi"));Need(ui!=null,"VOICE_TEMPLATE_INVALID");bool adaptive=ui.ContainsKey("adaptive"),uia=ui.ContainsKey("uia");Need(!(adaptive&&uia)&&ui.Count==(adaptive||uia?2:3)&&(!(adaptive||uia)||!ui.ContainsKey("cancel")&&!ui.ContainsKey("submit")),"VOICE_TEMPLATE_INVALID");
        var request=new VoiceRequest{Binding=binding,Id=Text(value,"id"),WaveFile=Text(value,"waveFile"),WaveHash=Text(value,"audioSha256"),RenderId=Text(value,"renderId"),CaptureId=Text(value,"captureId"),
            RecordingFocus=new IntPtr(DecimalString(Get(ui,"focusHwnd"))),RecordStart=ParseRect(Get(session,"recordStartRect")),MouseParkProvided=session.ContainsKey("mouseParkRect"),MousePark=uia&&!session.ContainsKey("mouseParkRect")?new Rect():ParseRect(Get(session,"mouseParkRect")),AllowCancel=Object.Equals(Get(permit,"cancelOwnedRecording"),true)};
        if(uia){request.Uia=ParseVoiceUia(Get(ui,"uia"));VoiceUiaDiagnostic=request.Uia;}else if(adaptive)request.Adaptive=ParseVoiceAdaptive(Get(ui,"adaptive"),binding,request.RecordStart,request.MousePark);else{request.Cancel=ParseTemplate(Get(ui,"cancel"),binding.Client);request.Submit=ParseTemplate(Get(ui,"submit"),binding.Client);Need(!Intersects(request.Cancel.Rect,request.Submit.Rect),"VOICE_TEMPLATE_INVALID");}
        Need(request.RecordingFocus!=IntPtr.Zero&&Contains(binding.Client,request.RecordStart)&&request.RecordStart.Width>=4&&request.RecordStart.Height>=4,"VOICE_TEMPLATE_INVALID");
        // UIA directed clicks never park the system pointer. Missing is legal
        // only for UIA; an explicitly supplied legacy rectangle is still checked.
        if(!uia||request.MouseParkProvided)Need(Contains(binding.Client,request.MousePark)&&request.MousePark.Width>=2&&request.MousePark.Height>=2&&request.MousePark.Width<=128&&request.MousePark.Height<=128&&!Intersects(request.MousePark,binding.Editor)&&!Intersects(request.MousePark,request.RecordStart)&&(adaptive||uia||!Intersects(request.MousePark,request.Cancel.Rect)&&!Intersects(request.MousePark,request.Submit.Rect)),"VOICE_MOUSE_PARK_INVALID");
        foreach(string endpoint in new[]{request.RenderId,request.CaptureId})Need(!String.IsNullOrEmpty(endpoint)&&endpoint.Length<=1024&&endpoint.IndexOfAny(new[]{'\0','\r','\n'})<0,"VOICE_ENDPOINT_INVALID");
        Need(request.RenderId!=request.CaptureId,"VOICE_ENDPOINT_INVALID");Need(!String.IsNullOrEmpty(request.WaveFile)&&Path.IsPathRooted(request.WaveFile),"VOICE_WAV_INVALID");if(value.ContainsKey("focusHandoff")){Need(Get(value,"focusHandoff")!=null,"VOICE_FOCUS_HANDOFF_INVALID");request.FocusHandoff=ParseVoiceHandoff(Get(value,"focusHandoff"),binding);}Need(!uia||request.FocusHandoff!=null,"VOICE_UIA_HANDOFF_REQUIRED");Need(request.FocusHandoff==null||request.FocusHandoff.Activation==null||request.FocusHandoff.Activation.UiaCaption==uia,"VOICE_UIA_FOCUS_MODE_REQUIRED");return request;
    }
    static VoiceRequest ParseVoiceSend(Dictionary<string,object> value){
        Need(value!=null&&Text(value,"action")=="timedVoiceSend","VOICE_REQUEST_INVALID");
        var session=Map(Get(value,"session"));var proof=Map(Get(session,"targetProof"));string target=Text(session,"target");
        bool group=target!=null&&target.EndsWith("@chatroom",StringComparison.Ordinal);
        Need(session!=null&&Number(Get(session,"version"))==2&&!String.IsNullOrEmpty(target)&&target.Length<=256&&target!="filehelper"&&!System.Text.RegularExpressions.Regex.IsMatch(target,"[\\x00-\\x20\\x7f]")&&proof!=null&&Text(proof,"kind")== (group?"verified-qt-group-chat-v1":"verified-qt-private-chat-v1")&&(!group||Hex(Text(proof,"querySha256"),64))&&Text(proof,"target")==target&&Hex(Text(proof,"accountRef"),64),"VOICE_TARGET_PROOF_INVALID");
        bool uia=Map(Get(Map(Get(session,"recordingUi")),"uia"))!=null;VoiceUiaFingerprint conversation=null;VoiceTemplate titleAnchor=null;
        if(uia){Need(!proof.ContainsKey("titleAnchor")&&proof.Count==(group?5:4),"VOICE_TARGET_PROOF_INVALID");conversation=ParseVoiceUiaFingerprint(Get(proof,"conversationFingerprint"));}
        else{Need(!proof.ContainsKey("conversationFingerprint"),"VOICE_TARGET_PROOF_INVALID");var anchor=Map(Get(proof,"titleAnchor"));Need(anchor!=null&&anchor.Count==2&&Hex(Text(anchor,"rgbaSha256"),64),"VOICE_TARGET_PROOF_INVALID");Rect title=ParseRect(Get(anchor,"rect")),client=ParseRect(Get(session,"clientRect")),editor=ParseRect(Get(session,"editorRect"));Need(Contains(client,title)&&title.Width<=1024&&title.Height<=256&&!Intersects(title,editor),"VOICE_TARGET_PROOF_INVALID");titleAnchor=new VoiceTemplate{Rect=title,Hash=Text(anchor,"rgbaSha256")};}
        var permit=Map(Get(value,"permission"));Need(Object.Equals(Get(permit,"recordNativeVoice"),true)&&Object.Equals(Get(permit,"playAudio"),true)&&Object.Equals(Get(permit,"submitNativeVoice"),true)&&Get(permit,"cancelOwnedRecording") is bool,"VOICE_PERMISSION_REQUIRED");
        // Reuse the common window/audio/layout parser only. The chat
        // identity is independently guarded by this production title anchor.
        var window=new Dictionary<string,object>(session);window["version"]=1;window["target"]="filehelper";
        window["editorFocusProof"]=Data("kind","operator-calibrated-edit-region","calibrationHash",Get(session,"calibrationHash"),"lastInputTick",Get(session,"lastInputTick"));
        var common=new Dictionary<string,object>(value);common["action"]="timedVoicePreview";common["session"]=window;
        common["permission"]=Data("recordPreview",true,"playAudio",true,"submitPreview",true,"cancelOwnedRecording",Get(permit,"cancelOwnedRecording"));
        VoiceRequest request=ParseVoice(common);if(uia)Need(SameVoiceUiaFingerprint(conversation,request.Uia.Conversation),"VOICE_TARGET_PROOF_INVALID");else request.TitleAnchor=titleAnchor;return request;
    }
    static Binding VoiceGuard(VoiceRequest request,long revision,int phase,bool allowStopped=false){if(!allowStopped)VoiceActive();Need(!Stopping,"VOICE_STOPPING");if(VoiceCancellation!=null&&VoiceCancellation.Active)Need(Interlocked.CompareExchange(ref VoiceExternalStop,0,0)==0,"VOICE_INTERRUPTION_CLEANUP_UNAVAILABLE");ValidateTime(request.Binding,UtcMs());Need(Interlocked.Read(ref Revision)==revision,"DRAFT_HUMAN_ACTIVITY_CHANGED");
        Binding actual=Snapshot(request.Binding.Window,request.Binding.Executable);
        Need(actual.Pid==request.Binding.Pid&&actual.Created==request.Binding.Created&&actual.Dpi==request.Binding.Dpi&&Same(actual.Client,request.Binding.Client)&&Same(actual.Capture,request.Binding.Capture),"VOICE_WINDOW_BINDING_CHANGED");
        Need(actual.FocusOwned&&(phase==2||(actual.Focus==(phase==1?request.RecordingFocus:request.Binding.Focus))),"VOICE_FOCUS_CHANGED");Need((actual.GuiFlags&0x1e)==0,"VOICE_MENU_ACTIVE");
        if(request.Uia==null)VoiceRequireFullVisibility(request);if(request.TitleAnchor!=null)Need(TemplateMatches(request,request.TitleAnchor),"VOICE_TARGET_ANCHOR_CHANGED");
        Need(Interlocked.Read(ref Revision)==revision,"DRAFT_HUMAN_ACTIVITY_CHANGED");return actual;
    }
    static string PixelHash(byte[] rgba){using(var hash=SHA256.Create())return BitConverter.ToString(hash.ComputeHash(rgba)).Replace("-","").ToLowerInvariant();}
    static void VoiceRgbaRow(byte[] bgra,byte[] rgba,int destination){for(int source=0;source<bgra.Length;source+=4){rgba[destination++]=bgra[source+2];rgba[destination++]=bgra[source+1];rgba[destination++]=bgra[source];rgba[destination++]=255;}}
    static string CaptureTemplateHash(VoiceRequest request,Rect rect){Rect screen=request.Binding.Capture;using(var image=new Bitmap(rect.Width,rect.Height,PixelFormat.Format32bppRgb)){using(var graphics=Graphics.FromImage(image))graphics.CopyFromScreen(screen.Left+rect.Left,screen.Top+rect.Top,0,0,new Size(rect.Width,rect.Height),CopyPixelOperation.SourceCopy);
            byte[] rgba=new byte[rect.Width*rect.Height*4],row=new byte[rect.Width*4];BitmapData pixels=image.LockBits(new Rectangle(0,0,rect.Width,rect.Height),ImageLockMode.ReadOnly,PixelFormat.Format32bppRgb);
            try{for(int y=0;y<rect.Height;y++){Marshal.Copy(IntPtr.Add(pixels.Scan0,y*pixels.Stride),row,0,row.Length);VoiceRgbaRow(row,rgba,y*row.Length);}}finally{image.UnlockBits(pixels);}return PixelHash(rgba);}}
    static bool TemplateMatches(VoiceRequest request,VoiceTemplate template){Need(request==null||request.Uia==null,"VOICE_UIA_PIXEL_PATH_FORBIDDEN");return template!=null&&CaptureTemplateHash(request,template.Rect)==template.Hash;}
    static bool RecordingUi(VoiceRequest request){return request.Uia!=null?VoiceUiaRecording(request):TemplateMatches(request,request.Cancel)&&TemplateMatches(request,request.Submit);}
    static uint VoiceDispatchClick(Action finalGuard,Action mark,Func<uint> insert){finalGuard();mark();return insert();}
    static Input[] VoiceCancelEvents(){return new[]{Key(0x1b,0),Key(0x1b,2)};}
    static void VoiceCancelWindowGuard(VoiceRequest request,long revision){
        Need(!Stopping,"VOICE_STOPPING");if(VoiceCancellation!=null&&VoiceCancellation.Active)Need(Interlocked.CompareExchange(ref VoiceExternalStop,0,0)==0,"VOICE_INTERRUPTION_CLEANUP_UNAVAILABLE");
        Need(!VoiceSubmitAttempted,"VOICE_INTERRUPTION_CLEANUP_UNAVAILABLE");ValidateTime(request.Binding,UtcMs());
        Need(Interlocked.Read(ref Revision)==revision,"DRAFT_HUMAN_ACTIVITY_CHANGED");NoKeysHeld();VoiceBoundWindowGuard(request);
        Need(GetForegroundWindow()==request.Binding.Window&&Interlocked.Read(ref Revision)==revision,"DRAFT_HUMAN_ACTIVITY_CHANGED");
    }
    static void VoiceCancelEsc(VoiceRequest request,long revision,AudioRouteProbe.NativeVoiceAudio audio){
        VoiceCancelWindowGuard(request,revision);audio.CheckDefaults();Need(VoiceCaptureVerified&&VoiceCaptureInstance!=null&&audio.ActiveSession(request.Binding.Pid)==VoiceCaptureInstance,"VOICE_CAPTURE_CHANGED");
        Input[] inputs=VoiceCancelEvents();uint applied=VoiceDispatchClick(delegate{
            VoiceCancelWindowGuard(request,revision);
        },delegate{CancelAttempted=true;InputAttempted=true;},delegate{return SendInput((uint)inputs.Length,inputs,Marshal.SizeOf(typeof(Input)));});
        if(applied!=inputs.Length){Input[] release=Releases(inputs,applied);if(release.Length>0)SendInput((uint)release.Length,release,Marshal.SizeOf(typeof(Input)));throw new Fault("VOICE_CANCEL_INPUT_UNCERTAIN");}
        CancelInputApplied=true;
    }
    static bool VoiceObserveCancelledCapture(Action guard,Func<bool> inactive,Func<long> clock,Action<int> wait){
        long end=clock()+1000;int samples=0;while(clock()<end){guard();bool ended=inactive();guard();if(ended){if(++samples>=2)return true;}else samples=0;wait(40);}return false;
    }
    static bool CancelledCaptureEnded(VoiceRequest request,long revision,AudioRouteProbe.NativeVoiceAudio audio){
        // Esc targets the already-bound recorder, not a pixel location. Its
        // completion is the original capture becoming inactive; no button,
        // editor-focus, caret or idle-toolbar template is read again.
        return VoiceObserveCancelledCapture(delegate{VoiceCancelWindowGuard(request,revision);audio.CheckDefaults();},audio.BoundCaptureInactive,Now,Thread.Sleep);
    }
    static void VoiceClick(VoiceRequest request,long revision,Rect rect,int phase,Action mark,bool allowStopped=false){VoiceGuard(request,revision,phase,allowStopped);NoKeysHeld();if(request.Uia!=null){VoiceUiaPointerClick(request,revision,rect,phase,mark,allowStopped);return;}Point center=new Point(request.Binding.Capture.Left+rect.Left+rect.Width/2,request.Binding.Capture.Top+rect.Top+rect.Height/2);
        Need(Owned(WindowFromPoint(center),request.Binding.Window,request.Binding.Pid),"VOICE_BUTTON_OBSCURED");int left=GetSystemMetrics(76),top=GetSystemMetrics(77);Input[] events=ClickEvents(center.X,center.Y,new Rect(left,top,left+GetSystemMetrics(78),top+GetSystemMetrics(79)));
        if(request.Uia!=null){VoiceUiaConversation(request);VoiceUiaClickGuard(request,rect,phase);}else if(phase==1)Need(RecordingUi(request),"VOICE_RECORDING_CONTEXT_CHANGED");VoiceGuard(request,revision,phase,allowStopped);NoKeysHeld();Need(Owned(WindowFromPoint(center),request.Binding.Window,request.Binding.Pid)&&Interlocked.Read(ref Revision)==revision,"VOICE_BUTTON_CHANGED");if(!allowStopped)VoiceActive();uint count=VoiceDispatchClick(delegate{Need(Interlocked.Read(ref Revision)==revision&&GetForegroundWindow()==request.Binding.Window,"DRAFT_HUMAN_ACTIVITY_CHANGED");if(!allowStopped)VoiceActive();},delegate{ObserveMouseIntent(0x201,center);mark();},delegate{return SendInput((uint)events.Length,events,Marshal.SizeOf(typeof(Input)));});if(count!=events.Length){Input[] releases=ClickReleases(count);if(releases.Length>0)SendInput((uint)releases.Length,releases,Marshal.SizeOf(typeof(Input)));throw new Fault("VOICE_CLICK_UNCERTAIN");}VoiceTrackOwnPointer(request,revision,center);}
    static void VoiceWait(VoiceRequest request,long revision,int milliseconds,int phase,bool allowStopped=false){long end=Now()+milliseconds;for(;;){long remaining=end-Now();if(remaining<=0)return;Thread.Sleep((int)Math.Min(10,remaining));VoiceGuard(request,revision,phase,allowStopped);}}
    static void VoicePark(VoiceRequest request,long revision,int phase,bool allowStopped=false){
        // UIA reads controls rather than hover-sensitive images. Its directed
        // clicks leave the system pointer untouched, so parking is unnecessary.
        if(request.Uia!=null){VoiceGuard(request,revision,phase,allowStopped);NoKeysHeld();return;}
        VoiceGuard(request,revision,phase,allowStopped);NoKeysHeld();Point center=new Point(request.Binding.Capture.Left+request.MousePark.Left+request.MousePark.Width/2,request.Binding.Capture.Top+request.MousePark.Top+request.MousePark.Height/2);
        int left=GetSystemMetrics(76),top=GetSystemMetrics(77);Input move=ClickEvents(center.X,center.Y,new Rect(left,top,left+GetSystemMetrics(78),top+GetSystemMetrics(79)))[0];
        VoiceGuard(request,revision,phase,allowStopped);NoKeysHeld();Need(Owned(WindowFromPoint(center),request.Binding.Window,request.Binding.Pid),"VOICE_MOUSE_PARK_OBSCURED");Need(Interlocked.Read(ref Revision)==revision&&GetForegroundWindow()==request.Binding.Window,"DRAFT_HUMAN_ACTIVITY_CHANGED");if(!allowStopped)VoiceActive();
        Need(SendInput(1,new[]{move},Marshal.SizeOf(typeof(Input)))==1,"VOICE_MOUSE_PARK_UNCERTAIN");VoiceMouseParkMovesApplied++;VoiceTrackOwnPointer(request,revision,center);
        // Shared mode continues directly into the existing recorder-ready or
        // recorder-ended observations. Dedicated mode keeps its old delay.
        if(VoiceHandoff==null)VoiceWait(request,revision,200,phase,allowStopped);VoiceGuard(request,revision,phase,allowStopped);
    }
    static string VoiceWaitParkedIdle(Action guard,Func<string> capture,Func<long> clock,Action<int> wait){
        long end=clock()+200;string previous=null;
        for(;;){guard();string current=capture();guard();Need(clock()<=end,"VOICE_IDLE_CONTEXT_UNSTABLE");
            if(previous!=null&&current==previous)return current;previous=current;
            Need(clock()+20<=end,"VOICE_IDLE_CONTEXT_UNSTABLE");wait(20);}
    }
    static bool VoiceMayWaitAdaptive(bool shared,bool unbound,string reason){return shared&&unbound&&(reason=="VOICE_ADAPTIVE_CONTROL_UNCERTAIN"||reason=="VOICE_ADAPTIVE_ROLES_UNCERTAIN"||reason=="VOICE_ADAPTIVE_CHANGED");}
    static bool EndEvidence(bool boundInactive,bool idleMatches,bool cancelMatches,bool submitMatches){return boundInactive&&idleMatches&&!cancelMatches&&!submitMatches;}
    static bool VoiceObserveUiaEnd(Action guard,Func<bool> inactive,Func<bool> idle,Func<long> clock,Action<int> wait){
        long end=clock()+1000;int samples=0;
        while(clock()<end){guard();if(inactive())samples++;else samples=0;
            // Audio cessation is the cheap transition predicate. Once stable,
            // read the current semantic idle state exactly at this boundary.
            if(samples>=2){if(idle()&&inactive()){guard();return true;}samples=0;}guard();wait(40);}
        return false;
    }
    static bool EndObserved(VoiceRequest request,long revision,AudioRouteProbe.NativeVoiceAudio audio,bool allowStopped){
        if(request.Uia!=null)return VoiceObserveUiaEnd(delegate{VoiceGuard(request,revision,2,allowStopped);},audio.BoundCaptureInactive,delegate{VoiceUiaConversation(request);return VoiceUiaIdle(request);},Now,Thread.Sleep);
        long end=Now()+1000;int samples=0;while(Now()<end){VoiceGuard(request,revision,2,allowStopped);bool ended=EndEvidence(audio.BoundCaptureInactive(),request.Idle!=null&&TemplateMatches(request,request.Idle),TemplateMatches(request,request.Cancel),TemplateMatches(request,request.Submit));VoiceGuard(request,revision,2,allowStopped);if(ended){if(++samples>=2)return true;}else samples=0;Thread.Sleep(40);}return false;
    }
    static bool VoiceMayObserveSubmittedEnd(bool uia,bool submitted,bool captureBound,bool recorderBound,bool returned){return uia&&submitted&&captureBound&&recorderBound&&returned;}
    static bool VoiceSubmittedEndObserved(VoiceRequest request,AudioRouteProbe.NativeVoiceAudio audio,bool backgroundSubmit=false){
        string capture=VoiceCaptureInstance,recorder=request.Uia==null?null:request.Uia.Recorder;
        Need(VoiceHandoff!=null&&request.Uia!=null&&VoiceSubmitApplied&&VoiceCaptureVerified&&capture!=null&&recorder!=null,"VOICE_RECORDING_END_UNCONFIRMED");
        // Complete the borrowed foreground interval before waiting for Qt and
        // the bound audio session to acknowledge the queued submit. Nothing in
        // this phase can grant another input or infer delivery from queueing.
        var background=backgroundSubmit?VoiceHandoff.BackgroundSubmit:null;
        if(backgroundSubmit)Need(background!=null&&background.Attempted&&background.Applied&&VoiceHandoff.InitialReturnConfirmed&&Interlocked.CompareExchange(ref VoiceHandoff.Phase,0,0)==7,"VOICE_BACKGROUND_SUBMIT_UNAVAILABLE");
        else{VoiceFinishFocusHandoff(request,true);
            Need(VoiceMayObserveSubmittedEnd(request.Uia!=null,VoiceSubmitApplied,capture!=null,recorder!=null,VoiceHandoff.FinalReturnConfirmed)&&Interlocked.CompareExchange(ref VoiceHandoff.Phase,0,0)==6,"VOICE_FOCUS_RETURN_UNCONFIRMED");}
        Action guard=delegate{
            if(background!=null&&GetForegroundWindow()!=background.ForegroundBefore)background.ForegroundUnchanged=false;
            VoiceActive();Need(!Stopping,"VOICE_STOPPING");ValidateTime(request.Binding,UtcMs());VoiceBoundWindowGuard(request);
            Need(!VoiceWindowProcess(GetForegroundWindow(),request.Binding.Pid),"VOICE_BACKGROUND_WECHAT_ACTIVATED");
            Need(VoiceCaptureInstance==capture&&request.Uia.Recorder==recorder,"VOICE_CAPTURE_CHANGED");audio.CheckDefaults();
            string active=audio.ActiveSession(request.Binding.Pid);Need(active==null||active==capture,"VOICE_CAPTURE_CHANGED");
            VoiceActive();
        };
        try{bool ended=VoiceObserveUiaEnd(guard,audio.BoundCaptureInactive,delegate{VoiceUiaConversation(request);return VoiceUiaIdle(request);},Now,Thread.Sleep);if(background!=null)background.Confirmed=ended;return ended;}
        finally{if(background!=null)background.ForegroundUnchanged=background.ForegroundUnchanged&&GetForegroundWindow()==background.ForegroundBefore&&!VoiceWindowProcess(GetForegroundWindow(),request.Binding.Pid);}
    }
    static object RunVoice(VoiceRequest request){long revision=Interlocked.Read(ref Revision);System.Threading.Timer recordingDeadline=null;Exception failure=null;
        VoiceGuard(request,revision,0);Need(Snapshot(request.Binding.Window,request.Binding.Executable).InputTick==request.Binding.InputTick,"DRAFT_CALIBRATION_ACTIVITY_CHANGED");NoKeysHeld();
        using(var audio=new AudioRouteProbe.NativeVoiceAudio(request.RenderId,request.CaptureId,request.WaveFile,request.WaveHash)) {
            VoiceAudio=audio;VoiceDurationMs=audio.DurationMs;
            try {
                VoiceGuard(request,revision,0);Need(audio.DurationMs>0&&audio.DurationMs<=8000,"VOICE_WAV_DURATION_LIMIT");
                if(request.Adaptive!=null){Need(FileVersionInfo.GetVersionInfo(request.Binding.Executable).FileVersion==request.Adaptive.Version,"VOICE_ADAPTIVE_EXECUTABLE_VERSION_MISMATCH");LoadVoiceShapes();}
                while(Now()-Interlocked.Read(ref LastActivity)<request.Binding.Idle){Thread.Sleep(10);VoiceGuard(request,revision,0);}
                Need(Snapshot(request.Binding.Window,request.Binding.Executable).InputTick==request.Binding.InputTick,"DRAFT_CALIBRATION_ACTIVITY_CHANGED");
                Need((request.Uia!=null||!RecordingUi(request))&&audio.ActiveSession(request.Binding.Pid)==null,"VOICE_RECORDER_ALREADY_ACTIVE");audio.CheckDefaults();
                // Baseline and end evidence use the same parked-pointer condition.
                // The original calibration input tick was checked before our first move.
                VoicePark(request,revision,0);
                if(request.Uia==null)request.Idle=new VoiceTemplate{Rect=request.RecordStart,Hash=VoiceHandoff==null?CaptureTemplateHash(request,request.RecordStart):VoiceWaitParkedIdle(delegate{VoiceGuard(request,revision,0);},delegate{return CaptureTemplateHash(request,request.RecordStart);},Now,delegate(int ms){VoiceWait(request,revision,ms,0);})};
                if(VoiceHandoff!=null)VoiceValidateInitialCaptionBeforeRecording(request,revision);
                VoiceClick(request,revision,request.RecordStart,0,delegate{RecordingAttempted=true;RecordingPossible=true;VoiceStartMs=Now();recordingDeadline=new System.Threading.Timer(delegate{StopVoice("VOICE_RECORDING_DEADLINE");},null,12000,Timeout.Infinite);});
                VoicePark(request,revision,2);
                long readyDeadline=Now()+1200;string candidate=null;VoiceUiaState readyState=null;
                while(Now()<readyDeadline){VoiceGuard(request,revision,2);candidate=audio.ActiveSession(request.Binding.Pid);
                    if(candidate!=null&&request.Adaptive!=null&&!request.AdaptiveBound){try{BindVoiceAdaptive(request,revision);}catch(Fault error){
                        // Capture can become active before Qt finishes drawing
                        // both buttons. Only an uncommitted transient match is
                        // read again; ambiguity/activity/ownership still fail.
                        if(!VoiceMayWaitAdaptive(VoiceHandoff!=null,!request.AdaptiveBound&&request.Cancel==null&&request.Submit==null,error.Message))throw;candidate=null;
                    }}
                    if(candidate!=null&&request.Uia!=null){readyState=VoiceUiaReadState(request);if(readyState.Kind=="recording"){VoiceGuard(request,revision,1);if(audio.ActiveSession(request.Binding.Pid)==candidate)break;}candidate=null;readyState=null;}
                    else if(candidate!=null&&RecordingUi(request)){VoiceGuard(request,revision,1);VoiceWait(request,revision,40,1);if(audio.ActiveSession(request.Binding.Pid)==candidate&&RecordingUi(request))break;candidate=null;}VoiceWait(request,revision,20,2);}
                Need(candidate!=null&&(request.Uia!=null?readyState!=null&&readyState.Kind=="recording":RecordingUi(request)&&!TemplateMatches(request,request.Idle)),"VOICE_CAPTURE_NOT_READY");if(request.Uia!=null)VoiceUiaCommitRecorder(request,readyState);audio.BindCapture(request.Binding.Pid,candidate);VoiceCaptureInstance=candidate;VoiceCaptureVerified=true;VoiceCaptureMs=Now();
                VoiceGuard(request,revision,1);audio.CheckDefaults();Need(audio.ActiveSession(request.Binding.Pid)==VoiceCaptureInstance,"VOICE_CAPTURE_CHANGED");
                if(VoiceHandoff!=null)VoiceReleaseInitialFocus(request,revision);
                audio.Start();VoicePlayMs=audio.StartedAtMs;VoiceAudioStarted=true;long nextCheck=Now();
                for(;;) {
                    VoiceActive();if(VoiceHandoff==null)Need(Interlocked.Read(ref Revision)==revision,"DRAFT_HUMAN_ACTIVITY_CHANGED");
                    if(audio.Pump())break;
                    if(Now()>=nextCheck){if(VoiceHandoff!=null)VoiceBackgroundGuard(request,audio);else{VoiceGuard(request,revision,1);audio.CheckDefaults();Need(audio.ActiveSession(request.Binding.Pid)==VoiceCaptureInstance&&RecordingUi(request),"VOICE_RECORDING_CONTEXT_CHANGED");}nextCheck=Now()+100;}
                    Thread.Sleep(5);
                }
                audio.StopOutput();VoiceDrainMs=audio.DrainedAtMs;VoiceAudioComplete=true;
                if(VoiceHandoff!=null&&request.Uia!=null){
                    VoiceBackgroundWait(request,audio,200);VoiceUiaSubmitInBackground(request,audio);VoiceRecordingEnded=VoiceSubmittedEndObserved(request,audio,true);
                }else{
                    if(VoiceHandoff!=null){VoiceBackgroundWait(request,audio,200);revision=VoiceAcquireSubmitFocus(request,audio);}else{VoiceGuard(request,revision,1);VoiceWait(request,revision,200,1);}
                    audio.CheckDefaults();Need(audio.ActiveSession(request.Binding.Pid)==VoiceCaptureInstance&&(request.Uia!=null||RecordingUi(request)),"VOICE_RECORDING_CONTEXT_CHANGED");Need(Now()-VoiceStartMs<11000,"VOICE_RECORDING_DEADLINE");
                    VoiceClick(request,revision,request.Submit.Rect,1,delegate{VoiceSubmitAttempted=true;VoiceSubmitMs=Now();});VoiceSubmitApplied=true;
                    VoicePark(request,revision,2);VoiceRecordingEnded=EndObserved(request,revision,audio,false);
                }
                RecordingPossible=!VoiceRecordingEnded;if(VoiceRecordingEnded)VoiceEndedMs=Now();
                Need(VoiceRecordingEnded,"VOICE_RECORDING_END_UNCONFIRMED");
            } catch(Exception error){string failureCode=VoiceInterruptedFailureCode(VoiceSafeReason(error),VoiceStopReason);failure=failureCode==VoiceSafeReason(error)?error:new Fault(failureCode);audio.Cancel();try{audio.StopOutput();}catch{}
                // A definite pre-submit interruption may acquire a new lease
                // solely to cancel the same bound recorder. An uncertain send
                // never enters this path and can only be resolved by receipts.
                if(VoiceMayCancelInterrupted(failureCode,RecordingPossible,VoiceSubmitAttempted,request.AllowCancel,VoiceCaptureVerified&&VoiceCaptureInstance!=null,CancelAttempted,Interlocked.CompareExchange(ref VoiceExternalStop,0,0)!=0))VoiceCancelInterrupted(request,audio);
                else if(MayCancel(RecordingPossible,VoiceSubmitAttempted,request.AllowCancel,revision,Interlocked.Read(ref Revision))) {
                    try{VoiceCancellationStage="esc";VoiceCancelEsc(request,revision,audio);
                        VoiceCancellationStage="end";VoiceRecordingEnded=CancelledCaptureEnded(request,revision,audio);RecordingPossible=!VoiceRecordingEnded;if(VoiceRecordingEnded)VoiceEndedMs=Now();
                        Need(VoiceRecordingEnded,"VOICE_RECORDING_END_UNCONFIRMED");VoiceCancellationStage="ended";
                    }catch(Exception cleanupError){VoiceCancellationFailure=VoiceSafeReason(cleanupError);}
                }
            }finally{if(recordingDeadline!=null)recordingDeadline.Dispose();audio.StopOutput();VoicePlayMs=audio.StartedAtMs;VoiceDrainMs=audio.DrainedAtMs;VoiceAudioStarted=VoicePlayMs>0;VoiceAudioComplete=audio.PlaybackCompleted;VoicePumpDiagnostic=audio.PumpReport();VoiceAudio=null;}
        }
        if(failure!=null)throw failure;return VoiceReport(true,null);
    }
    static int VoiceSelfTest(){int checks=0;try{
        for(int flags=0;flags<32;flags++)Need(VoiceMayObserveSubmittedEnd((flags&1)!=0,(flags&2)!=0,(flags&4)!=0,(flags&8)!=0,(flags&16)!=0)==(flags==31),"TEST_SUBMITTED_END_REQUIRES_UIA_APPLIED_BOUND_AND_RETURNED");checks++;
        var template=Data("rect",new Rect(10,10,40,40).Report(),"rgbaSha256",new string('a',64));Need(ParseTemplate(template,new Rect(0,0,100,100)).Rect.Width==30,"TEST_TEMPLATE");checks++;
        Expect(delegate{ParseTemplate(Data("rect",new Rect(0,0,129,20).Report(),"rgbaSha256",new string('a',64)),new Rect(0,0,200,200));},"VOICE_TEMPLATE_INVALID");checks++;
        Need(PixelHash(new byte[]{255,0,0,255})=="34aaa746c25a0f105c4316bbb1f009aa359f49582656ee97d73c58132d563423","TEST_PIXEL_HASH");checks++;
        byte[] rgbaRow=new byte[8];VoiceRgbaRow(new byte[]{3,2,1,0,6,5,4,0},rgbaRow,0);Need(PixelHash(rgbaRow)==PixelHash(new byte[]{1,2,3,255,4,5,6,255}),"TEST_BGRA_PIXEL_LAYOUT");checks++;
        Need(Own(1,1,Marker)&&!Own(1,1,UIntPtr.Zero),"TEST_MOUSE_MARKER");checks++;
        Need(IntPtr.Size==8&&Marshal.SizeOf(typeof(Input))==40&&Marshal.OffsetOf(typeof(Input),"Value").ToInt32()==8&&Marshal.SizeOf(typeof(MouseInput))==32&&Marshal.OffsetOf(typeof(MouseInput),"Extra").ToInt32()==24&&Marshal.SizeOf(typeof(MouseHookData))==32&&Marshal.OffsetOf(typeof(MouseHookData),"Extra").ToInt32()==24&&Marshal.SizeOf(typeof(KeyboardHookData))==24&&Marshal.OffsetOf(typeof(KeyboardHookData),"Extra").ToInt32()==16,"TEST_INPUT_X64_LAYOUT");checks++;
        Input[] click=ClickEvents(10,10,new Rect(0,0,100,100));Need(click.Length==3&&click[0].Value.Mouse.Flags==0xc001&&click[1].Value.Mouse.Flags==2&&click[2].Value.Mouse.Flags==4,"TEST_VOICE_CLICK_EVENTS");foreach(Input item in click)Need(item.Type==0&&item.Value.Mouse.Extra.Equals(Marker),"TEST_VOICE_CLICK_MARKER");checks++;
        Input[] cancelKeys=VoiceCancelEvents();Need(cancelKeys.Length==2&&cancelKeys[0].Type==1&&cancelKeys[1].Type==1&&cancelKeys[0].Value.Keyboard.Key==0x1b&&cancelKeys[1].Value.Keyboard.Key==0x1b&&cancelKeys[0].Value.Keyboard.Scan==0&&cancelKeys[1].Value.Keyboard.Scan==0&&cancelKeys[0].Value.Keyboard.Flags==0&&cancelKeys[1].Value.Keyboard.Flags==2&&cancelKeys[0].Value.Keyboard.Extra.Equals(Marker)&&cancelKeys[1].Value.Keyboard.Extra.Equals(Marker),"TEST_CANCEL_ONLY_ESC_DOWN_UP_WITH_OWN_MARKER");checks++;
        Need(Releases(cancelKeys,0).Length==0&&Releases(cancelKeys,1).Length==1&&Releases(cancelKeys,1)[0].Value.Keyboard.Key==0x1b&&Releases(cancelKeys,1)[0].Value.Keyboard.Flags==2&&Releases(cancelKeys,1)[0].Value.Keyboard.Extra.Equals(Marker),"TEST_CANCEL_PARTIAL_ESC_PREFIX_ONLY_RELEASES_INSERTED_DOWN");checks++;
        VoiceStartMs=1000;Need(!ObserveVoiceInput("mouse",1,1,Marker,0x200,1000)&&VoiceHumanActivity==null,"TEST_OWN_INPUT_DIAGNOSTIC_IGNORED");checks++;
        Need(ObserveVoiceInput("mouse",1,1,UIntPtr.Zero,0x200,1007)&&ObserveVoiceInput("keyboard",0,0x10,UIntPtr.Zero,0x100,1050),"TEST_EXTERNAL_INPUT_TRACKED");var activity=Map(VoiceActivityReport());Need(activity.Count==7&&Text(activity,"kind")=="mouse"&&Object.Equals(Get(activity,"injected"),true)&&Object.Equals(Get(activity,"ownMarker"),false)&&Object.Equals(Get(activity,"lower32Matches"),false)&&Object.Equals(Get(activity,"markerIsZero"),true)&&Number(Get(activity,"message"))==0x200&&Number(Get(activity,"timeAfterRecordStartMs"))==7,"TEST_FIRST_INPUT_ONLY");checks++;
        VoiceHumanActivity=null;VoiceStartMs=0;Need(ObserveVoiceInput("keyboard",0,0x10,Marker,0x100,1000),"TEST_MARKER_WITHOUT_INJECTED_IS_EXTERNAL");activity=Map(VoiceActivityReport());Need(Object.Equals(Get(activity,"ownMarker"),true)&&Object.Equals(Get(activity,"injected"),false)&&Get(activity,"timeAfterRecordStartMs")==null,"TEST_PRE_RECORD_DIAGNOSTIC");VoiceHumanActivity=null;checks++;
        Need(Marker.ToUInt64()>0&&Marker.ToUInt64()<=UInt32.MaxValue&&ObserveVoiceInput("mouse",1,1,new UIntPtr(0x100000000UL|Marker.ToUInt64()),0x200,1000),"TEST_FOREIGN_HIGH_BITS_NOT_OWN");activity=Map(VoiceActivityReport());Need(Object.Equals(Get(activity,"lower32Matches"),true)&&Object.Equals(Get(activity,"markerIsZero"),false)&&Object.Equals(Get(activity,"ownMarker"),false),"TEST_SAME_LOW_BITS_DIAGNOSTIC");VoiceHumanActivity=null;VoiceOwnMouseObserved=0;checks++;
        var mouse=Data("action","probeMouseMarker","permission",Data("mouseMoveDiagnostic",true),"idleMs",1000,"session",Get(FixtureRequest(),"session"),"mouseTargetRect",new Rect(20,20,30,30).Report());Need(ParseMouseDiagnostic(mouse).Binding.OperatorCalibrated,"TEST_MOUSE_DIAGNOSTIC_REQUEST");Map(Get(mouse,"permission"))["mouseMoveDiagnostic"]=false;Expect(delegate{ParseMouseDiagnostic(mouse);},"VOICE_PERMISSION_REQUIRED");checks++;
        RecordingAttempted=true;RecordingPossible=true;var failed=Map(VoiceFailure(new Fault("VOICE_CAPTURE_NOT_READY")));Need(Object.Equals(Get(failed,"recordingPossible"),true)&&Object.Equals(Get(failed,"deliveryConfirmed"),false),"TEST_UNCERTAIN_RECORDING");RecordingAttempted=false;RecordingPossible=false;checks++;
        Need(MayCancel(true,false,true,2,2)&&!MayCancel(true,false,true,2,3)&&!MayCancel(true,true,true,2,2)&&!MayCancel(true,false,false,2,2)&&!MayCancel(false,false,true,2,2),"TEST_CANCEL_OWNERSHIP");checks++;
        bool clickMarked=false,clickInserted=false;Expect(delegate{VoiceDispatchClick(delegate{throw new Fault("DRAFT_HUMAN_ACTIVITY_CHANGED");},delegate{clickMarked=true;},delegate{clickInserted=true;return 3;});},"DRAFT_HUMAN_ACTIVITY_CHANGED");Need(!clickMarked&&!clickInserted,"TEST_PRE_INPUT_INTERRUPTION_NOT_SUBMISSION_ATTEMPT");checks++;
        Expect(delegate{VoiceDispatchClick(delegate{},delegate{clickMarked=true;},delegate{clickInserted=true;throw new Fault("VOICE_CLICK_UNCERTAIN");});},"VOICE_CLICK_UNCERTAIN");Need(clickMarked&&clickInserted,"TEST_UNKNOWN_SEND_IS_MARKED_BEFORE_NATIVE_CALL");checks++;
        foreach(string code in new[]{"DRAFT_HUMAN_ACTIVITY_CHANGED","VOICE_BACKGROUND_WECHAT_ACTIVATED"}){
            for(int flags=0;flags<64;flags++)Need(VoiceMayCancelInterrupted(code,(flags&1)!=0,(flags&2)!=0,(flags&4)!=0,(flags&8)!=0,(flags&16)!=0,(flags&32)!=0)==(flags==13),"TEST_INTERRUPTION_CANCEL_COMPLETE_PRE_SEND_BOUND_OWNERSHIP");checks++;
        }
        foreach(string code in new[]{"VOICE_RECORDING_END_UNCONFIRMED","VOICE_CLICK_UNCERTAIN","VOICE_CAPTURE_CHANGED","VOICE_WINDOW_BINDING_CHANGED","VOICE_PARENT_CLOSED","VOICE_RECORDING_DEADLINE",null}){Need(!VoiceMayCancelInterrupted(code,true,false,true,true,false,false),"TEST_NON_ACTIVITY_FAILURE_NEVER_NEW_CANCEL_LEASE");checks++;}
        Need(VoiceInterruptedFailureCode("AUDIO_PLAYBACK_CANCELLED","DRAFT_HUMAN_ACTIVITY_CHANGED")=="DRAFT_HUMAN_ACTIVITY_CHANGED"&&VoiceInterruptedFailureCode("AUDIO_PLAYBACK_CANCELLED","VOICE_PARENT_CLOSED")=="AUDIO_PLAYBACK_CANCELLED"&&VoiceInterruptedFailureCode("VOICE_CAPTURE_CHANGED","DRAFT_HUMAN_ACTIVITY_CHANGED")=="VOICE_CAPTURE_CHANGED","TEST_PUMP_CANCEL_RACE_PRESERVES_ONLY_CONFIRMED_HUMAN_REASON");checks++;
        long cleanupClock=0,lastCleanupInput=0;bool cleanupKeys=false;int cleanupGuards=0;
        VoiceWaitCancellationQuiet(100,30,delegate{return cleanupClock;},delegate{return lastCleanupInput;},delegate{return cleanupKeys;},delegate{cleanupGuards++;},delegate(int ms){cleanupClock+=ms;if(cleanupClock==20){lastCleanupInput=20;cleanupKeys=true;}});
        Need(cleanupClock==50&&cleanupGuards==7,"TEST_CANCEL_WAIT_QUIET_AFTER_LATEST_ACTIVITY_AND_RELEASED_KEYS");checks++;
        cleanupClock=0;Expect(delegate{VoiceWaitCancellationQuiet(40,30,delegate{return cleanupClock;},delegate{return cleanupClock;},delegate{return true;},delegate{},delegate(int ms){cleanupClock+=ms;});},"VOICE_INTERRUPTION_CLEANUP_TIMEOUT");Need(cleanupClock==40,"TEST_CANCEL_QUIET_WAIT_BOUNDED");checks++;
        cleanupClock=100;int cleanupSleeps=0;Expect(delegate{VoiceWaitCancellationQuiet(200,30,delegate{return cleanupClock;},delegate{return 0;},delegate{return true;},delegate{throw new Fault("VOICE_CAPTURE_CHANGED");},delegate(int ms){cleanupSleeps++;});},"VOICE_CAPTURE_CHANGED");Need(cleanupSleeps==0,"TEST_CANCEL_WAIT_REVALIDATES_BOUND_CAPTURE_BEFORE_INPUT");checks++;
        cleanupClock=0;int endSamples=0,endGuards=0;bool ended=VoiceObserveCancelledCapture(delegate{endGuards++;},delegate{endSamples++;return true;},delegate{return cleanupClock;},delegate(int ms){cleanupClock+=ms;});
        Need(ended&&endSamples==2&&endGuards==4&&cleanupClock==40,"TEST_ESC_END_USES_TWO_BOUND_INACTIVE_SAMPLES_WITHOUT_BUTTON_READ_OR_POINTER_MOVE");checks++;
        cleanupClock=0;endSamples=0;ended=VoiceObserveCancelledCapture(delegate{},delegate{return ++endSamples!=2;},delegate{return cleanupClock;},delegate(int ms){cleanupClock+=ms;});
        Need(ended&&endSamples==4&&cleanupClock==120,"TEST_ESC_ACTIVE_SAMPLE_RESETS_INACTIVE_OBSERVATION");checks++;
        cleanupClock=0;ended=VoiceObserveCancelledCapture(delegate{},delegate{return false;},delegate{return cleanupClock;},delegate(int ms){cleanupClock+=ms;});Need(!ended&&cleanupClock==1000,"TEST_ESC_CANCEL_NOT_CONFIRMED_WHILE_BOUND_CAPTURE_ACTIVE");checks++;
        cleanupClock=0;endSamples=endGuards=0;Expect(delegate{VoiceObserveCancelledCapture(delegate{if(++endGuards==2)throw new Fault("DRAFT_HUMAN_ACTIVITY_CHANGED");},delegate{endSamples++;return true;},delegate{return cleanupClock;},delegate(int ms){cleanupClock+=ms;});},"DRAFT_HUMAN_ACTIVITY_CHANGED");Need(endSamples==1&&cleanupClock==0,"TEST_ESC_END_LOSES_OBSERVATION_ON_REAL_ACTIVITY_WITHOUT_RETRYING_INPUT");checks++;
        int previousCancelled=VoiceCancelled,previousExternal=VoiceExternalStop;string previousStop=VoiceStopReason;
        StopVoice("DRAFT_HUMAN_ACTIVITY_CHANGED");Need(VoiceExternalStop==previousExternal,"TEST_HUMAN_INTERRUPT_NOT_EXTERNAL_SHUTDOWN");StopVoice("VOICE_PARENT_CLOSED");Need(VoiceExternalStop==1,"TEST_PARENT_CLOSE_STOPS_NEW_CLEANUP_EVEN_AFTER_HUMAN");VoiceCancelled=previousCancelled;VoiceExternalStop=previousExternal;VoiceStopReason=previousStop;checks++;
        Need(EndEvidence(true,true,false,false)&&!EndEvidence(false,true,false,false)&&!EndEvidence(true,false,false,false)&&!EndEvidence(true,true,true,false)&&!EndEvidence(true,true,false,true),"TEST_POSITIVE_END_EVIDENCE");checks++;
        long parkClock=0;int parkSamples=0,parkGuards=0;
        string idleHash=VoiceWaitParkedIdle(delegate{parkGuards++;},delegate{parkSamples++;return "idle";},delegate{return parkClock;},delegate(int ms){parkClock+=ms;});
        Need(idleHash=="idle"&&parkSamples==2&&parkGuards==4&&parkClock==20,"TEST_SHARED_PARK_IDLE_READY_AFTER_TWO_REAL_SAMPLES_NOT_FIXED_200");checks++;
        parkClock=0;parkSamples=0;idleHash=VoiceWaitParkedIdle(delegate{},delegate{return ++parkSamples==1?"hover":"idle";},delegate{return parkClock;},delegate(int ms){parkClock+=ms;});
        Need(idleHash=="idle"&&parkSamples==3&&parkClock==40,"TEST_SHARED_PARK_TRANSIENT_HOVER_NOT_FROZEN_AS_IDLE");checks++;
        parkClock=0;parkSamples=0;Expect(delegate{VoiceWaitParkedIdle(delegate{},delegate{return (++parkSamples).ToString(CultureInfo.InvariantCulture);},delegate{return parkClock;},delegate(int ms){parkClock+=ms;});},"VOICE_IDLE_CONTEXT_UNSTABLE");
        Need(parkClock==200&&parkSamples==11,"TEST_SHARED_PARK_UNSTABLE_IDLE_BOUNDED_BY_ORIGINAL_200");checks++;
        parkClock=0;parkSamples=0;Expect(delegate{VoiceWaitParkedIdle(delegate{throw new Fault("DRAFT_HUMAN_ACTIVITY_CHANGED");},delegate{parkSamples++;return "idle";},delegate{return parkClock;},delegate(int ms){parkClock+=ms;});},"DRAFT_HUMAN_ACTIVITY_CHANGED");
        Need(parkClock==0&&parkSamples==0,"TEST_SHARED_PARK_REAL_ACTIVITY_STOPS_BEFORE_BASELINE_OR_RECORDING");checks++;
        foreach(string reason in new[]{"VOICE_ADAPTIVE_CONTROL_UNCERTAIN","VOICE_ADAPTIVE_ROLES_UNCERTAIN","VOICE_ADAPTIVE_CHANGED"}){
            Need(VoiceMayWaitAdaptive(true,true,reason)&&!VoiceMayWaitAdaptive(false,true,reason)&&!VoiceMayWaitAdaptive(true,false,reason),"TEST_SHARED_EARLY_ADAPTIVE_REOBSERVES_ONLY_UNCOMMITTED_TRANSIENT");
        }checks++;
        foreach(string reason in new[]{"VOICE_ADAPTIVE_CONTROL_AMBIGUOUS","VOICE_ADAPTIVE_OBSCURED","DRAFT_HUMAN_ACTIVITY_CHANGED","VOICE_WINDOW_BINDING_CHANGED","VOICE_CAPTURE_CHANGED",null})Need(!VoiceMayWaitAdaptive(true,true,reason),"TEST_SHARED_EARLY_ADAPTIVE_NEVER_SWALLOWS_AMBIGUITY_OR_OWNERSHIP_CHANGE");checks++;
        var session=Map(Get(FixtureRequest(),"session"));session["emptyDraftConfirmed"]=true;session["recordStartRect"]=new Rect(710,400,750,440).Report();session["mouseParkRect"]=new Rect(20,20,40,40).Report();session["recordingUi"]=Data("focusHwnd","100","cancel",Data("rect",new Rect(150,450,180,480).Report(),"rgbaSha256",new string('d',64)),"submit",Data("rect",new Rect(600,450,630,480).Report(),"rgbaSha256",new string('e',64)));
        var voice=Data("action","timedVoicePreview","id",new string('1',64),"audioSha256",new string('2',64),"waveFile","C:\\fixture\\input.wav","renderId","fixture-render","captureId","fixture-capture","idleMs",1000,"session",session,"permission",Data("recordPreview",true,"playAudio",true,"submitPreview",true,"cancelOwnedRecording",true));
        Need(ParseVoice(voice).AllowCancel,"TEST_VOICE_REQUEST");checks++;
        object oldUi=session["recordingUi"],oldStart=session["recordStartRect"];session["recordStartRect"]=new Rect(710,550,740,580).Report();session["recordingUi"]=Data("focusHwnd","100","adaptive",Data("version",1,"executableVersion",VoiceAdaptiveVersion,"toolbarRect",new Rect(120,535,780,590).Report()));
        var adaptiveRequest=ParseVoice(voice);Need(adaptiveRequest.Adaptive!=null&&adaptiveRequest.Cancel==null&&adaptiveRequest.Submit==null&&!adaptiveRequest.AdaptiveBound,"TEST_ADAPTIVE_REQUEST_NOT_PREVERIFIED");checks++;
        Map(session["recordingUi"])["cancel"]=Get(Map(oldUi),"cancel");Expect(delegate{ParseVoice(voice);},"VOICE_TEMPLATE_INVALID");checks++;
        session["recordingUi"]=oldUi;session["recordStartRect"]=oldStart;
        object legacyPark=session["mouseParkRect"];session.Remove("mouseParkRect");Expect(delegate{ParseVoice(voice);},"DRAFT_RECT_INVALID");checks++;
        var uiaFingerprint=Data("version",1,"scope","chat-title-text-v1","sha256",new string('a',64),"headerRuntimeIdSha256",new string('b',64),"titleRuntimeIdSha256",new string('c',64),"textNodeCount",1,"targetVerified",false);
        session["recordingUi"]=Data("focusHwnd","100","uia",Data("version",1,"executableVersion","4.1.15.56","conversationFingerprint",uiaFingerprint));voice["focusHandoff"]=Data("version",1,"returnWindow",Data("hwnd","200","pid",99,"processCreatedFileTimeUtc","456"));
        var noPark=ParseVoice(voice);Need(noPark.Uia!=null&&!noPark.MouseParkProvided&&noPark.MousePark.Width==0&&noPark.FocusHandoff.Activation==null,"TEST_VOICE_UIA_NO_PARK_OR_CAPTION_PLACEHOLDER");checks++;
        session["mouseParkRect"]=null;Expect(delegate{ParseVoice(voice);},"DRAFT_RECT_INVALID");checks++;
        session["mouseParkRect"]=legacyPark;Need(ParseVoice(voice).MouseParkProvided,"TEST_VOICE_UIA_LEGACY_PARK_REMAINS_VALIDATED");checks++;
        session["mouseParkRect"]=oldStart;Expect(delegate{ParseVoice(voice);},"VOICE_MOUSE_PARK_INVALID");checks++;
        session["recordingUi"]=oldUi;session["mouseParkRect"]=legacyPark;voice.Remove("focusHandoff");
        session["mouseParkRect"]=new Rect(150,450,180,480).Report();Expect(delegate{ParseVoice(voice);},"VOICE_MOUSE_PARK_INVALID");session["mouseParkRect"]=new Rect(20,20,40,40).Report();checks++;
        Map(Get(voice,"permission"))["submitPreview"]=false;Expect(delegate{ParseVoice(voice);},"VOICE_PERMISSION_REQUIRED");Map(Get(voice,"permission"))["submitPreview"]=true;checks++;
        session["emptyDraftConfirmed"]=false;Expect(delegate{ParseVoice(voice);},"VOICE_EMPTY_DRAFT_CONFIRMATION_REQUIRED");session["emptyDraftConfirmed"]=true;checks++;
        session["draftPolicy"]="unchecked";session["emptyDraftConfirmed"]=false;Expect(delegate{ParseVoice(voice);},"VOICE_EMPTY_DRAFT_CONFIRMATION_REQUIRED");checks++;
        voice["focusHandoff"]=Data("version",1,"returnWindow",Data("hwnd","200","pid",99,"processCreatedFileTimeUtc","456"));Need(ParseVoice(voice).FocusHandoff!=null,"TEST_SHARED_UNCHECKED_DRAFT_IS_EXPLICIT_AND_ACCEPTED");checks++;
        session["emptyDraftConfirmed"]=true;Expect(delegate{ParseVoice(voice);},"VOICE_EMPTY_DRAFT_CONFIRMATION_REQUIRED");checks++;
        session["emptyDraftConfirmed"]=false;session["draftPolicy"]="verified";Expect(delegate{ParseVoice(voice);},"VOICE_EMPTY_DRAFT_CONFIRMATION_REQUIRED");session.Remove("draftPolicy");voice.Remove("focusHandoff");session["emptyDraftConfirmed"]=true;checks++;
        session["expiresAtMs"]=UtcMs()+10000;Expect(delegate{ParseVoice(voice);},"VOICE_SESSION_BUDGET_EXCEEDED");checks++;
        session["expiresAtMs"]=UtcMs()+25000;session["version"]=2;session["target"]="fixture-friend";session.Remove("editorFocusProof");
        session["targetProof"]=Data("kind","verified-qt-private-chat-v1","target","fixture-friend","accountRef",new string('a',64),"titleAnchor",Data("rect",new Rect(100,10,400,50).Report(),"rgbaSha256",new string('b',64)));
        voice["action"]="timedVoiceSend";voice["permission"]=Data("recordNativeVoice",true,"playAudio",true,"submitNativeVoice",true,"cancelOwnedRecording",true);
        Need(ParseVoiceSend(voice).TitleAnchor.Rect.Width==300,"TEST_PRIVATE_TARGET_ANCHOR");checks++;
        voice["focusHandoff"]=Data("version",1,"returnWindow",Data("hwnd","200","pid",99,"processCreatedFileTimeUtc","456"));Need(ParseVoiceSend(voice).FocusHandoff.Pid==99,"TEST_PRIVATE_HANDOFF_RETAINED");checks++;
        session["draftPolicy"]="unchecked";session["emptyDraftConfirmed"]=false;Need(ParseVoiceSend(voice).TitleAnchor!=null&&ParseVoiceSend(voice).FocusHandoff!=null,"TEST_PRODUCTION_UNCHECKED_PRESERVES_TARGET_AND_HANDOFF");session.Remove("draftPolicy");session["emptyDraftConfirmed"]=true;voice.Remove("focusHandoff");checks++;
        session["target"]="filehelper";Expect(delegate{ParseVoiceSend(voice);},"VOICE_TARGET_PROOF_INVALID");session["target"]="fixture-friend";checks++;
        Map(Get(session,"targetProof"))["target"]="other";Expect(delegate{ParseVoiceSend(voice);},"VOICE_TARGET_PROOF_INVALID");Map(Get(session,"targetProof"))["target"]="fixture-friend";checks++;
        var groupProof=Map(Get(session,"targetProof"));session["target"]="fixture-room@chatroom";groupProof["target"]="fixture-room@chatroom";
        Expect(delegate{ParseVoiceSend(voice);},"VOICE_TARGET_PROOF_INVALID");checks++;
        groupProof["kind"]="verified-qt-group-chat-v1";Expect(delegate{ParseVoiceSend(voice);},"VOICE_TARGET_PROOF_INVALID");checks++;
        groupProof["querySha256"]=new string('c',64);Need(ParseVoiceSend(voice).TitleAnchor.Rect.Width==300,"TEST_GROUP_TARGET_AND_QUERY_PROOF");checks++;
        session["target"]="fixture-friend";groupProof["target"]="fixture-friend";Expect(delegate{ParseVoiceSend(voice);},"VOICE_TARGET_PROOF_INVALID");checks++;
        groupProof["kind"]="verified-qt-private-chat-v1";groupProof.Remove("querySha256");
        Expect(delegate{ParseVoice(voice);},"VOICE_REQUEST_INVALID");checks++;
        string warmNonce=new string('a',64),warmId=new string('b',32);var warmInit=Data("action","warmVoiceMonitor","version",1,"nonce",warmNonce);Need(ParseVoiceWarmInit(warmInit)==warmNonce,"TEST_WARM_INIT");checks++;
        warmInit["extra"]=true;Expect(delegate{ParseVoiceWarmInit(warmInit);},"VOICE_WARMUP_REQUEST_INVALID");warmInit.Remove("extra");warmInit["nonce"]="short";Expect(delegate{ParseVoiceWarmInit(warmInit);},"VOICE_WARMUP_REQUEST_INVALID");checks++;
        var warm=Data("action","executeWarmVoice","version",1,"nonce",warmNonce,"monitorId",warmId,"mode","private-send","request",voice);bool warmProduction=false;
        Need(Object.ReferenceEquals(ParseVoiceWarmExecution(warm,warmNonce,warmId,out warmProduction),voice)&&warmProduction,"TEST_WARM_EXECUTION_EXACT_PACKET");checks++;
        Expect(delegate{ParseVoiceWarmExecution(warm,new string('c',64),warmId,out warmProduction);},"VOICE_WARMUP_BINDING_INVALID");Expect(delegate{ParseVoiceWarmExecution(warm,warmNonce,new string('c',32),out warmProduction);},"VOICE_WARMUP_BINDING_INVALID");checks++;
        warm["mode"]="private-once";Expect(delegate{ParseVoiceWarmExecution(warm,warmNonce,warmId,out warmProduction);},"VOICE_WARMUP_MODE_INVALID");warm["mode"]="private-send";warm["extra"]=true;Expect(delegate{ParseVoiceWarmExecution(warm,warmNonce,warmId,out warmProduction);},"VOICE_WARMUP_BINDING_INVALID");checks++;
        long warmRevision=Interlocked.Read(ref Revision),warmActivity=Interlocked.Read(ref LastActivity);int warmCancelled=VoiceCancelled;VoiceWarmPhase=1;Need(VoiceWarmCollect(true)&&Interlocked.Read(ref Revision)==warmRevision,"TEST_WARM_OWN_INPUT_IGNORED");Need(VoiceWarmCollect(false)&&Interlocked.Read(ref Revision)==warmRevision+1&&VoiceCancelled==warmCancelled&&Gate==null,"TEST_WARM_HUMAN_OBSERVES_WITHOUT_INPUT_LEASE_OR_CANCEL");checks++;
        Need(Interlocked.CompareExchange(ref VoiceWarmPhase,2,1)==1&&Interlocked.CompareExchange(ref VoiceWarmPhase,2,1)==2&&!VoiceWarmCollect(false)&&Interlocked.Read(ref Revision)==warmRevision+1,"TEST_WARM_SINGLE_COMMIT_EXECUTION_NOT_COLLECT_ONLY");VoiceWarmPhase=0;Interlocked.Exchange(ref Revision,warmRevision);Interlocked.Exchange(ref LastActivity,warmActivity);checks++;
        checks+=VoiceFocusHandoffSelfTest();
        checks+=VoiceFocusSafetySelfTest();
        checks+=VoiceAdaptiveSelfTest();checks+=VoiceUiaSelfTest();checks+=WindowMessageInputSelfTest();checks+=VoiceUiaPointerSelfTest();
        checks+=AudioRouteProbe.NativeVoiceAudio.SyntheticTests();
        Write(Data("ok",true,"selfTest",true,"checks",checks,"uiAccessed",false,"devicesAccessed",false,"audioStarted",false,"inputSent",false));return 0;
    }catch{Write(Data("ok",false,"selfTest",true,"checks",checks));return 1;}}
}

internal static partial class AudioRouteProbe {
    internal sealed class NativeVoiceAudio:IDisposable {
        IMMDeviceEnumerator enumerator;IAudioSessionControl boundCapture;TimedVoiceAudioPump pump;
        readonly string captureId;bool disposed;
        internal double DurationMs{get{return pump.DurationMs;}}
        internal long StartedAtMs{get{return pump.StartedAtMs;}}
        internal long DrainedAtMs{get{return pump.DrainedAtMs;}}
        internal bool PlaybackCompleted{get{return pump.CompletedSuccessfully;}}
        internal NativeVoiceAudio(string render,string capture,string file,string sha256){captureId=capture;
            try{enumerator=(IMMDeviceEnumerator)new MMDeviceEnumerator();var devices=Enumerate(enumerator);Select(devices,captureId,1);Select(devices,render,0);CheckDefaults();
                pump=new TimedVoiceAudioPump(delegate(Func<bool> cancelled){return new VoiceWasapiOutput(render,file,sha256,cancelled);},delegate{return new VoiceTimerPeriodLease(VoiceTimeBeginPeriod,VoiceTimeEndPeriod);});
            }catch{Dispose();throw;}}
        internal void CheckDefaults(){for(int role=0;role<3;role++){IMMDevice current=null;try{Hr(enumerator.GetDefaultAudioEndpoint(1,role,out current));Endpoint endpoint=Describe(current,1);Check(endpoint.Id==captureId&&Eligible(endpoint),"AUDIO_DEFAULT_CAPTURE_NOT_CABLE");}finally{Release(current);}}}
        internal string ActiveSession(uint targetPid){return QuerySession(targetPid,null);}
        internal void BindCapture(uint targetPid,string expected){Check(boundCapture==null,"AUDIO_CAPTURE_ALREADY_BOUND");Check(QuerySession(targetPid,expected)==expected&&boundCapture!=null,"AUDIO_CAPTURE_BIND_FAILED");}
        internal bool BoundCaptureInactive(){if(boundCapture==null)return false;int state;Hr(((IAudioSessionControl2)boundCapture).GetState(out state));Check(state>=0&&state<=2,"AUDIO_SESSION_STATE_INVALID");return state==0||state==2;}
        string QuerySession(uint targetPid,string binding){string found=null;foreach(var endpoint in Enumerate(enumerator,1,1)){IMMDevice source=null;IAudioSessionManager2 manager=null;IAudioSessionEnumerator sessions=null;
                try{Hr(enumerator.GetDevice(endpoint.Id,out source));object instance;Guid guid=SessionManagerGuid;Hr(source.Activate(ref guid,23,IntPtr.Zero,out instance));manager=(IAudioSessionManager2)instance;Hr(manager.GetSessionEnumerator(out sessions));int count;Hr(sessions.GetCount(out count));Check(count>=0&&count<=256,"AUDIO_SESSION_LIMIT");
                    for(int i=0;i<count;i++){IAudioSessionControl current=null;try{Hr(sessions.GetSession(i,out current));var detail=(IAudioSessionControl2)current;uint pid;int owner=detail.GetProcessId(out pid);Hr(owner);if(pid!=targetPid)continue;int state;Hr(detail.GetState(out state));Check(state>=0&&state<=2,"AUDIO_SESSION_STATE_INVALID");if(state!=1)continue;
                            Check(owner==0&&endpoint.Id==captureId&&Eligible(endpoint),"AUDIO_CAPTURE_ROUTE_MISMATCH");Check(found==null,"AUDIO_CAPTURE_AMBIGUOUS");IntPtr name=IntPtr.Zero;try{Hr(detail.GetSessionInstanceIdentifier(out name));found=Marshal.PtrToStringUni(name);Check(!String.IsNullOrEmpty(found)&&found.Length<=2048,"AUDIO_SESSION_ID_INVALID");}finally{if(name!=IntPtr.Zero)Marshal.FreeCoTaskMem(name);}
                            if(binding!=null&&found==binding){boundCapture=current;current=null;}
                        }finally{Release(current);}}
                }finally{Release(sessions);Release(manager);Release(source);}}
            return found;
        }
        internal void Start(){pump.Start();}
        internal bool Pump(){return pump.Complete();}
        internal void Cancel(){var current=pump;if(current!=null)current.Cancel();}
        internal void StopOutput(){if(pump!=null)pump.StopAndJoin();}
        internal object PumpReport(){return pump==null?null:pump.Report();}
        public void Dispose(){if(disposed)return;disposed=true;if(pump!=null)pump.Dispose();Release(boundCapture);boundCapture=null;Release(enumerator);enumerator=null;}
        internal static int SyntheticTests(){int count=WaveSelfTest();Wave value=ParseWave(FixtureWave(16000,1,false,16000));Check(value.DurationMs==1000&&value.OutputFrames(48000)==48000,"AUDIO_SELF_TEST_FAILED");count++;
            return count+TimedVoiceAudioPump.SyntheticTests();}
    }
}
