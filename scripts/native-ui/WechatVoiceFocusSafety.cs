// Voice-local focus capabilities. Nothing in this file imports a Qt lease or
// accepts a serialized caption/coordinate proof from another process.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Threading;

internal static partial class WechatDraftProbe {
    static bool VoiceUiaActivationNeedsDiscovery(bool uia,FocusActivation activation){return uia&&activation==null;}
    static FocusActivation VoiceDiscoverUiaActivation(VoiceRequest request,Action guard){
        long deadline=Now()+650;var capture=request.Binding.Capture;var title=QtReadUiaTitleGeometry(request.Binding.Window,request.Binding.Pid,capture,guard,deadline);
        int dx=Math.Max(10,(int)Math.Ceiling(8*request.Binding.Dpi/96.0)),dy=Math.Max(4,(int)Math.Ceiling(3*request.Binding.Dpi/96.0));
        int left=capture.Left+160+dx,right=Math.Min(title.Toolbar.Left-16,capture.Right-160)-dx;
        Need(right>left&&title.Band.Height>dy*2,"VOICE_UIA_CAPTION_UNAVAILABLE");
        foreach(int y in QtUiaCaptionRows(title.Band,dy))foreach(double fraction in new[]{.5,.3,.7,.1,.9}){
            int x=left+(int)Math.Round((right-left)*fraction);var area=new Rect(x-dx,y-dy,x+dx+1,y+dy+1);var client=new Rect(area.Left-capture.Left,area.Top-capture.Top,area.Right-capture.Left,area.Bottom-capture.Top);
            if(!FocusActivationGeometry(client,request.Binding.Client.Width)||!UiaCaptionClientRegionSafe(title,area,capture)||!FocusCoveredByDisplays(area,FocusDisplayRects()))continue;
            Point[] points={new Point(x,y),new Point(area.Left,area.Top),new Point(area.Right-1,area.Top),new Point(area.Left,area.Bottom-1),new Point(area.Right-1,area.Bottom-1)};int[] hits=new int[5];
            for(int i=0;i<points.Length;i++){guard();long remaining=deadline-Now();Need(remaining>0,"VOICE_UIA_CAPTION_UNAVAILABLE");UIntPtr value;Need(FocusSendMessageTimeout(request.Binding.Window,0x84,UIntPtr.Zero,FocusCaptionCoordinates(points[i],"VOICE_CAPTION_COORDINATES_INVALID"),0x23,(uint)Math.Min(20,remaining),out value)!=IntPtr.Zero,"VOICE_UIA_CAPTION_UNAVAILABLE");hits[i]=unchecked((int)value.ToUInt64());}
            if(!UiaCaptionHitSet(hits))continue;guard();Need(Now()<=deadline,"VOICE_UIA_CAPTION_UNAVAILABLE");return new FocusActivation{Rect=client,UiaCaption=true};
        }
        throw new Fault("VOICE_UIA_CAPTION_UNAVAILABLE");
    }
    static bool VoiceActivateWechatOnce(VoiceRequest request,IntPtr source,long revision,Action guard,FocusActivation activation){
        bool discover=VoiceUiaActivationNeedsDiscovery(request.Uia!=null,activation);Dictionary<string,object> priorAttempt=null;
        if(discover){
            // A successful initial Qt activation carried no caption capability.
            // Discover one only when this later voice cleanup actually needs
            // it. The foreground API is attempted once, never repeated here.
            if(ActivateForegroundOnce(source,request.Binding.Window,guard))return true;
            priorAttempt=FocusActivationDiagnostic;Need(priorAttempt!=null,"VOICE_UIA_CAPTION_UNAVAILABLE");
            if(FocusTargetBeforeClick(source,request.Binding.Window,guard,GetForegroundWindow,priorAttempt))return true;
            Action sourceGuard=delegate{guard();VoiceBoundWindowGuard(request);Need(Interlocked.Read(ref Revision)==revision&&GetForegroundWindow()==source,"VOICE_FOCUS_SOURCE_CHANGED");};
            if(IsOffscreenFocusWindow(request.Binding.Window)){
                bool activated=ActivateOffscreenForegroundOnce(source,request.Binding.Window,request.Binding.Executable,guard);
                Need(activated,"VOICE_OFFSCREEN_FOCUS_UNCONFIRMED");return true;
            }
            activation=VoiceDiscoverUiaActivation(request,sourceGuard);
        }
        Action<Rect> semantic=null;
        if(request.Uia!=null){
            Need(activation==null||activation.UiaCaption,"VOICE_UIA_FOCUS_MODE_REQUIRED");
            if(activation!=null)semantic=delegate(Rect area){
                Action stable=delegate{guard();VoiceBoundWindowGuard(request);Need(Interlocked.Read(ref Revision)==revision,"DRAFT_HUMAN_ACTIVITY_CHANGED");};
                stable();Point center=new Point(area.Left+area.Width/2,area.Top+area.Height/2);
                Need(VoiceCaptionHistorySafe(center,request.Binding.Dpi),"VOICE_CAPTION_DOUBLE_CLICK_UNCERTAIN");
                ValidateUiaCaptionRegion(request.Binding.Window,request.Binding.Pid,request.Binding.Capture,area,stable,Now()+650);
                stable();Need(VoiceCaptionHistorySafe(center,request.Binding.Dpi),"VOICE_CAPTION_DOUBLE_CLICK_UNCERTAIN");
            };
        }
        return discover?FocusCalibratedClick(source,request.Binding.Window,request.Binding.Pid,activation,guard,priorAttempt,semantic):ActivateForegroundOnce(source,request.Binding.Window,guard,activation,semantic);
    }
    sealed class VoiceCaption {
        internal VoiceReturnWindow Identity;internal uint Thread,Dpi,SourceThread;internal Rect Window,Client;internal Point ClientOrigin,Center;internal Point[] Points;
        internal long Issued,Revision;internal bool RequestAttempted,ClickAttempted,ClickApplied,Verified;
    }
    static FocusClickHistory VoiceCaptionClicks=new FocusClickHistory();
    static readonly Action<uint,Point> VoiceCaptionObserver=delegate(uint message,Point point){VoiceCaptionClicks.Observe(message,point,Now());};
    static void VoiceStartCaptionMonitor(){VoiceCaptionClicks=new FocusClickHistory();MouseObservationObserver=VoiceCaptionObserver;}
    static bool VoiceCaptionHistorySafe(Point point,uint dpi){double scale=Math.Max(1,dpi/96.0);return MouseObservationObserver==VoiceCaptionObserver&&VoiceCaptionClicks.Safe(point,Now(),Interlocked.Read(ref ActivityMonitorStarted),Interlocked.Read(ref LastActivity),FocusDoubleClickTime(),(int)Math.Ceiling(GetSystemMetrics(36)*scale),(int)Math.Ceiling(GetSystemMetrics(37)*scale));}
    static int VoiceSafeGapMs(uint doubleClick){Need(doubleClick>=1&&doubleClick<=5000,"VOICE_CAPTION_MONITOR_UNAVAILABLE");return Math.Max(250,checked((int)doubleClick+1));}
    static void VoiceRequireCaptionMonitor(){Need(MouseObservationObserver==VoiceCaptionObserver&&ActivityMonitorStarted>0&&Now()-Interlocked.Read(ref ActivityMonitorStarted)>FocusDoubleClickTime(),"VOICE_CAPTION_MONITOR_WARMUP_REQUIRED");}
    static VoiceCaption VoiceCaptionSnapshot(VoiceReturnWindow expected){
        VoiceReturnWindow identity=VoiceReadReturnWindow(expected.Window);Need(VoiceSameReturn(expected,identity)&&FocusGetWindow(expected.Window,4)==IntPtr.Zero,"VOICE_CAPTION_WINDOW_CHANGED");
        uint pid;uint thread=GetWindowThreadProcessId(expected.Window,out pid);Need(thread!=0&&thread!=GetCurrentThreadId()&&pid==expected.Pid&&ObjectName(GetThreadDesktop(thread))=="Default","VOICE_CAPTION_WINDOW_CHANGED");
        var gui=new GuiInfo{Size=(uint)Marshal.SizeOf(typeof(GuiInfo))};Need(GetGUIThreadInfo(thread,ref gui)&&(gui.Flags&0x1e)==0&&gui.Capture==IntPtr.Zero,"VOICE_CAPTION_CAPTURE_ACTIVE");
        Rect window=new Rect(),client=new Rect();Point origin=new Point(0,0);Need(FocusGetWindowRect(expected.Window,out window)&&GetClientRect(expected.Window,out client)&&ClientToScreen(expected.Window,ref origin),"VOICE_CAPTION_WINDOW_CHANGED");uint dpi=GetDpiForWindow(expected.Window);
        Need(window.Width>=400&&window.Width<=8192&&window.Height>=200&&window.Height<=8192&&client.Width>0&&client.Height>0&&dpi>=96&&dpi<=240,"VOICE_CAPTION_UNAVAILABLE");
        return new VoiceCaption{Identity=identity,Thread=thread,Dpi=dpi,Window=window,Client=client,ClientOrigin=origin,Issued=Now()};
    }
    static bool VoiceSameCaption(VoiceCaption a,VoiceCaption b){return a!=null&&b!=null&&VoiceSameReturn(a.Identity,b.Identity)&&a.Thread==b.Thread&&a.Dpi==b.Dpi&&Same(a.Window,b.Window)&&Same(a.Client,b.Client)&&a.ClientOrigin.X==b.ClientOrigin.X&&a.ClientOrigin.Y==b.ClientOrigin.Y;}
    static bool VoiceCaptionPointsOwned(VoiceCaption proof){
        if(proof==null||proof.Points==null||proof.Points.Length!=5)return false;
        Rect area=new Rect(proof.Points[1].X,proof.Points[1].Y,proof.Points[4].X+1,proof.Points[4].Y+1);if(!FocusCoveredByDisplays(area,FocusDisplayRects()))return false;
        // A later HWND_TOP request for this unchanged WeChat rectangle must
        // not cover the return click that was proved before acquiring focus.
        if(VoiceHandoff==null||Intersects(area,VoiceHandoff.WechatBounds))return false;
        foreach(Point point in proof.Points)if(FocusMonitorFromPoint(point,0)==IntPtr.Zero||!Owned(WindowFromPoint(point),proof.Identity.Window,proof.Identity.Pid))return false;return true;
    }
    static bool VoiceCaptionHit(VoiceCaption proof,Point point,long deadline){
        long remaining=deadline-Now();Need(remaining>0,"VOICE_CAPTION_PROBE_TIMEOUT");UIntPtr value;
        IntPtr status=FocusSendMessageTimeout(proof.Identity.Window,0x84,UIntPtr.Zero,FocusCaptionCoordinates(point,"VOICE_CAPTION_COORDINATES_INVALID"),0x23,(uint)Math.Min(20,remaining),out value);
        Need(status!=IntPtr.Zero&&Now()<=deadline,"VOICE_CAPTION_PROBE_TIMEOUT");return unchecked((long)value.ToUInt64())==2;
    }
    static void VoiceSourceThreadGuard(VoiceRequest request){
        VoiceHandoffState state=VoiceHandoff;Need(state!=null&&state.WechatThread!=0,"VOICE_FOCUS_HANDOFF_INVALID");uint pid;uint thread=GetWindowThreadProcessId(request.Binding.Window,out pid);Rect window;
        var gui=new GuiInfo{Size=(uint)Marshal.SizeOf(typeof(GuiInfo))};Need(thread==state.WechatThread&&pid==request.Binding.Pid&&GetGUIThreadInfo(thread,ref gui)&&(gui.Flags&0x1e)==0&&gui.Capture==IntPtr.Zero&&FocusGetWindowRect(request.Binding.Window,out window)&&Same(window,state.WechatBounds),"VOICE_FOCUS_SOURCE_CHANGED");
    }
    static VoiceCaption VoiceCaptureCaption(VoiceRequest request,VoiceReturnWindow target,long revision,IntPtr foreground,Action extra,bool cleanup=false){
        VoiceRequireCaptionMonitor();long deadline=Now()+600;Action guard=delegate{VoiceFocusTransitionGuard(request,target,revision,cleanup);VoiceSourceThreadGuard(request);if(extra!=null)extra();Need(GetForegroundWindow()==foreground,"VOICE_CAPTION_FOREGROUND_CHANGED");};
        guard();var proof=VoiceCaptionSnapshot(target);proof.SourceThread=VoiceHandoff.WechatThread;proof.Revision=revision;
        foreach(Point point in FocusCaptionCandidates(proof.Window,proof.Dpi)){
            guard();Need(VoiceSameCaption(proof,VoiceCaptionSnapshot(target))&&Now()<deadline,"VOICE_CAPTION_WINDOW_CHANGED");if(!VoiceCaptionHistorySafe(point,proof.Dpi))continue;
            proof.Center=point;proof.Points=FocusCaptionPoints(point,proof.Dpi);if(!VoiceCaptionPointsOwned(proof))continue;bool caption=true;
            foreach(Point sample in proof.Points)if(!VoiceCaptionHit(proof,sample,deadline)){caption=false;break;}if(!caption)continue;
            guard();Need(VoiceSameCaption(proof,VoiceCaptionSnapshot(target))&&VoiceCaptionPointsOwned(proof)&&VoiceCaptionHistorySafe(point,proof.Dpi)&&Now()<=deadline,"VOICE_CAPTION_WINDOW_CHANGED");return proof;
        }
        throw new Fault("VOICE_CAPTION_UNAVAILABLE");
    }
    static bool VoiceCaptionMayClick(bool attempted,bool foreground,bool proof,bool revision,bool keys,bool history,bool geometry,bool caption,bool owned){return !attempted&&foreground&&proof&&revision&&keys&&history&&geometry&&caption&&owned;}
    static void VoiceArmCaptionRequest(VoiceCaption proof,long revision){if(proof==null)return;Need(proof.Revision==revision&&!proof.RequestAttempted,"VOICE_CAPTION_ALREADY_ATTEMPTED");proof.RequestAttempted=true;}
    static void VoiceValidateInitialCaptionBeforeRecording(VoiceRequest request,long revision){
        VoiceHandoffState state=VoiceHandoff;VoiceCaption proof=state==null?null:state.InitialCaption;Need(proof!=null&&!proof.RequestAttempted&&proof.Revision==revision,"VOICE_CAPTION_UNAVAILABLE");VoiceRequireCaptionMonitor();long deadline=Now()+150;
        Action guard=delegate{VoiceFocusTransitionGuard(request,state.InitialReturn,revision,false);VoiceSourceThreadGuard(request);Need(GetForegroundWindow()==request.Binding.Window,"VOICE_CAPTION_FOREGROUND_CHANGED");};
        guard();Need(Now()-proof.Issued>=0&&Now()-proof.Issued<=30000&&VoiceSameCaption(proof,VoiceCaptionSnapshot(state.InitialReturn))&&VoiceCaptionPointsOwned(proof)&&VoiceCaptionHistorySafe(proof.Center,proof.Dpi),"VOICE_CAPTION_WINDOW_CHANGED");
        foreach(Point point in proof.Points){guard();Need(VoiceCaptionHit(proof,point,deadline),"VOICE_CAPTION_WINDOW_CHANGED");}
        guard();Need(VoiceSameCaption(proof,VoiceCaptionSnapshot(state.InitialReturn))&&VoiceCaptionPointsOwned(proof)&&VoiceCaptionHistorySafe(proof.Center,proof.Dpi)&&Now()<deadline,"VOICE_CAPTION_WINDOW_CHANGED");
    }
    static bool VoiceActivateReturnOnce(VoiceRequest request,VoiceReturnWindow target,VoiceCaption proof,VoicePointerLease pointer,long revision,bool cleanup){
        Action guard=delegate{VoiceFocusTransitionGuard(request,target,revision,cleanup);VoiceSourceThreadGuard(request);};guard();
        VoiceArmCaptionRequest(proof,revision);
        bool accepted=ActivateForegroundOnce(request.Binding.Window,target.Window,guard);if(accepted)return true;
        guard();IntPtr current=GetForegroundWindow();if(current==target.Window)return true;Need(current==request.Binding.Window,"VOICE_CAPTION_FOREGROUND_CHANGED");
        if(proof==null)return false;
        Need(Now()-proof.Issued>=0&&Now()-proof.Issued<=30000&&proof.SourceThread==VoiceHandoff.WechatThread,"VOICE_CAPTION_EXPIRED");long deadline=Now()+150;
        guard();Need(VoiceSameCaption(proof,VoiceCaptionSnapshot(target))&&VoiceCaptionPointsOwned(proof)&&VoiceCaptionHistorySafe(proof.Center,proof.Dpi),"VOICE_CAPTION_WINDOW_CHANGED");
        foreach(Point point in proof.Points){guard();Need(GetForegroundWindow()==request.Binding.Window&&VoiceCaptionHit(proof,point,deadline),"VOICE_CAPTION_WINDOW_CHANGED");}
        guard();Need(VoiceCaptionMayClick(proof.ClickAttempted,GetForegroundWindow()==request.Binding.Window,proof.Identity.Window==target.Window,revision==Interlocked.Read(ref Revision),VoiceKeysReleased(),VoiceCaptionHistorySafe(proof.Center,proof.Dpi),VoiceSameCaption(proof,VoiceCaptionSnapshot(target)),true,VoiceCaptionPointsOwned(proof)),"VOICE_CAPTION_WINDOW_CHANGED");
        Rect desktop=VoicePointerDesktop();Input[] inputs=ClickEvents(proof.Center.X,proof.Center.Y,desktop);Need(VoiceCaptionHit(proof,proof.Center,deadline),"VOICE_CAPTION_WINDOW_CHANGED");guard();
        Need(GetForegroundWindow()==request.Binding.Window&&VoiceSameCaption(proof,VoiceCaptionSnapshot(target))&&VoiceCaptionPointsOwned(proof)&&VoiceCaptionHistorySafe(proof.Center,proof.Dpi)&&Same(desktop,VoicePointerDesktop())&&Now()<deadline,"VOICE_CAPTION_WINDOW_CHANGED");
        proof.ClickAttempted=true;proof.Verified=true;InputAttempted=true;if(pointer!=null)pointer.LastOwnKnown=false;ObserveMouseIntent(0x201,proof.Center);
        uint inserted=SendInput((uint)inputs.Length,inputs,Marshal.SizeOf(typeof(Input)));proof.ClickApplied=inserted==inputs.Length;
        if(!proof.ClickApplied){Input[] releases=ClickReleases(inserted);if(releases.Length>0)SendInput((uint)releases.Length,releases,Marshal.SizeOf(typeof(Input)));throw new Fault("VOICE_CAPTION_INPUT_UNCERTAIN");}
        long pointerDeadline=Now()+100;while(pointer!=null){guard();Point actual;if(Interlocked.Read(ref VoicePointerRevision)!=pointer.PointerRevision)break;
            if(FocusGetCursorPos(out actual)&&VoicePointerNear(actual,proof.Center)){pointer.LastOwn=actual;pointer.LastOwnKnown=true;break;}Need(Now()<pointerDeadline,"VOICE_CAPTION_POINTER_UNCONFIRMED");Thread.Sleep(5);}
        return true;
    }
    static void VoiceRequireFullVisibility(VoiceRequest request){Need(FocusBlockingWindows(request.Binding.Window,request.Binding.Capture,"VOICE_VISIBILITY_UNAVAILABLE")==0,"VOICE_WINDOW_OBSCURED");}
    static void VoiceEnsureSubmitVisible(VoiceRequest request,AudioRouteProbe.NativeVoiceAudio audio,VoiceReturnWindow other,long revision,FocusConfirmation confirmation){
        VoiceHandoffState state=VoiceHandoff;var prior=Map(confirmation.Activation);bool raised=Object.Equals(Get(prior,"calibratedRaiseAttempted"),true);state.SubmitRaiseAttempted=raised;
        Action guard=delegate{Need(state==VoiceHandoff&&state.LeaseRevision==revision&&Interlocked.CompareExchange(ref state.Phase,0,0)==2,"VOICE_FOCUS_HANDOFF_INVALID");VoiceFocusTransitionGuard(request,other,revision,false);VoiceSourceThreadGuard(request);
            Need(GetForegroundWindow()==request.Binding.Window&&FocusGetWindow(request.Binding.Window,4)==IntPtr.Zero&&GetAncestor(request.Binding.Window,3)==request.Binding.Window&&(FocusGetWindowLongPtr(request.Binding.Window,-20).ToInt64()&8)==0,"VOICE_FOCUS_SOURCE_CHANGED");
            var current=Snapshot(request.Binding.Window,request.Binding.Executable);Need(current.Thread==state.WechatThread&&current.FocusOwned&&current.Focus==request.RecordingFocus&&FocusCoveredByDisplays(current.Capture,FocusDisplayRects()),"VOICE_FOCUS_CHANGED");
            Need(VoiceSameCaption(state.SubmitCaption,VoiceCaptionSnapshot(other)),"VOICE_CAPTION_WINDOW_CHANGED");audio.CheckDefaults();Need(audio.ActiveSession(request.Binding.Pid)==VoiceCaptureInstance,"VOICE_CAPTURE_CHANGED");
            Need(Interlocked.Read(ref Revision)==revision&&GetForegroundWindow()==request.Binding.Window,"DRAFT_HUMAN_ACTIVITY_CHANGED");NoKeysHeld();};
        try{var result=FocusConfirmVisibilityOnce(guard,delegate{return FocusBlockingWindows(request.Binding.Window,request.Binding.Capture,"VOICE_VISIBILITY_UNAVAILABLE");},delegate{Need(!state.SubmitRaiseAttempted,"VOICE_RAISE_ALREADY_ATTEMPTED");state.SubmitRaiseAttempted=true;return FocusSetWindowPos(request.Binding.Window,IntPtr.Zero,0,0,0,0,0x4213);},Now,Thread.Sleep,raised,raised?(bool?)Object.Equals(Get(prior,"calibratedRaiseAccepted"),true):null,"VoiceFocusVisibility");state.SubmitVisibility=result.Report();Need(result.Confirmed,"VOICE_WINDOW_OBSCURED");}
        catch(Exception error){if(error.Data.Contains("VoiceFocusVisibility"))state.SubmitVisibility=error.Data["VoiceFocusVisibility"];throw;}
    }
    static object VoiceCaptionReport(VoiceCaption proof){return proof==null?null:Data("prepared",true,"requestAttempted",proof.RequestAttempted,"clickAttempted",proof.ClickAttempted,"clickApplied",proof.ClickApplied,"verified",proof.Verified);}
    static int VoiceFocusSafetySelfTest(){int checks=OffscreenActivationSelfTest();
        checks+=UiaCaptionSharedSelfTest();
        Need(VoiceUiaActivationNeedsDiscovery(true,null)&&!VoiceUiaActivationNeedsDiscovery(false,null)&&!VoiceUiaActivationNeedsDiscovery(true,new FocusActivation{UiaCaption=true})&&!VoiceUiaActivationNeedsDiscovery(false,new FocusActivation()),"TEST_VOICE_LAZY_CAPTION_ONLY_MISSING_UIA_CAPABILITY");checks++;
        Need(VoiceSafeGapMs(100)==250&&VoiceSafeGapMs(500)==501&&VoiceSafeGapMs(5000)==5001,"TEST_VOICE_CAPTION_SAFE_GAP_ONLY_BACKGROUND");Expect(delegate{VoiceSafeGapMs(0);},"VOICE_CAPTION_MONITOR_UNAVAILABLE");checks++;
        var identity=new VoiceReturnWindow{Window=new IntPtr(1),Pid=2,Created=3};var a=new VoiceCaption{Identity=identity,Thread=4,Dpi=120,Window=new Rect(0,0,1000,700),Client=new Rect(0,0,980,680),ClientOrigin=new Point(10,10)};
        var b=new VoiceCaption{Identity=new VoiceReturnWindow{Window=identity.Window,Pid=identity.Pid,Created=identity.Created},Thread=a.Thread,Dpi=a.Dpi,Window=a.Window,Client=a.Client,ClientOrigin=a.ClientOrigin};Need(VoiceSameCaption(a,b),"TEST_VOICE_CAPTION_LOCAL_IDENTITY");checks++;
        b.Thread++;Need(!VoiceSameCaption(a,b),"TEST_VOICE_CAPTION_THREAD_CHANGE_REFUSED");b.Thread--;b.Identity.Created++;Need(!VoiceSameCaption(a,b),"TEST_VOICE_CAPTION_PROCESS_REUSE_REFUSED");checks++;
        for(int flags=0;flags<512;flags++)Need(VoiceCaptionMayClick((flags&1)!=0,(flags&2)!=0,(flags&4)!=0,(flags&8)!=0,(flags&16)!=0,(flags&32)!=0,(flags&64)!=0,(flags&128)!=0,(flags&256)!=0)==(flags==510),"TEST_VOICE_CAPTION_ALL_GUARDS_REQUIRED");checks++;
        var history=new FocusClickHistory();Point point=new Point(-100,20),other=new Point(100,20);history.Observe(0x201,point,1000);history.Observe(0x201,other,1100);Need(!history.Safe(point,1101,0,0,500,4,4)&&!history.Safe(other,1101,0,0,500,4,4)&&!history.Safe(point,1500,0,0,500,4,4)&&history.Safe(point,1501,0,0,500,4,4),"TEST_VOICE_CAPTION_INTENT_LATE_CALLBACK_AND_STRICT_BOUNDARY");checks++;
        Need(!FocusCaptionClickSafe(false,0,point,point,500,0,0,500,4,4)&&FocusCaptionClickSafe(false,0,point,point,501,0,0,500,4,4),"TEST_VOICE_UNKNOWN_HISTORY_REQUIRES_EXISTING_MONITOR_WARMUP");checks++;
        long packed=FocusCaptionCoordinates(new Point(-100,-20),"VOICE_CAPTION_COORDINATES_INVALID").ToInt64();Need(unchecked((short)packed)==-100&&unchecked((short)(packed>>16))==-20,"TEST_VOICE_CAPTION_NEGATIVE_SCREEN_COORDINATES");Expect(delegate{FocusCaptionCoordinates(new Point(32768,20),"VOICE_CAPTION_COORDINATES_INVALID");},"VOICE_CAPTION_COORDINATES_INVALID");checks++;
        Need(!FocusCoveredByDisplays(new Rect(95,10,105,20),new List<Rect>{new Rect(0,0,100,100),new Rect(110,0,210,100)}),"TEST_VOICE_CAPTION_MONITOR_GAP_REFUSED");checks++;
        int requests=0,samples=0;long clock=0;var visible=FocusConfirmVisibilityOnce(delegate{},delegate{return ++samples<3?1:0;},delegate{requests++;return true;},delegate{return clock;},delegate(int ms){clock+=ms;},true,true,"VoiceFocusVisibility");Need(visible.Confirmed&&requests==0&&clock==10,"TEST_VOICE_DOES_NOT_REPEAT_COMMON_RAISE");checks++;
        requests=samples=0;clock=0;visible=FocusConfirmVisibilityOnce(delegate{},delegate{return 1;},delegate{requests++;return false;},delegate{return clock;},delegate(int ms){clock+=ms;},false,null,"VoiceFocusVisibility");Need(!visible.Confirmed&&requests==1&&clock==250,"TEST_VOICE_VISIBILITY_DEADLINE_NO_RETRY");checks++;
        var report=Map(VoiceCaptionReport(new VoiceCaption{Identity=identity,Center=new Point(7123,9123),Revision=99,Issued=999}));Need(report.Count==5&&!Json.Serialize(report).Contains("7123")&&!Json.Serialize(report).Contains("hwnd")&&!Json.Serialize(report).Contains("Revision"),"TEST_VOICE_CAPTION_REPORT_NO_PRIVATE_PROOF");checks++;
        var armed=new VoiceCaption{Revision=7};Expect(delegate{VoiceArmCaptionRequest(armed,8);},"VOICE_CAPTION_ALREADY_ATTEMPTED");Need(!armed.RequestAttempted,"TEST_VOICE_CAPTION_WRONG_EPOCH_NOT_ARMED");VoiceArmCaptionRequest(armed,7);Expect(delegate{VoiceArmCaptionRequest(armed,7);},"VOICE_CAPTION_ALREADY_ATTEMPTED");Need(armed.RequestAttempted&&!armed.ClickAttempted,"TEST_VOICE_RETURN_REQUEST_CANNOT_REPLAY_AFTER_API_FAILURE");checks++;
        requests=0;clock=0;int guards=0;Expect(delegate{FocusConfirmVisibilityOnce(delegate{if(++guards==2)throw new Fault("DRAFT_HUMAN_ACTIVITY_CHANGED");},delegate{return 0;},delegate{requests++;return true;},delegate{return clock;},delegate(int ms){clock+=ms;},false,null,"VoiceFocusVisibility");},"DRAFT_HUMAN_ACTIVITY_CHANGED");Need(requests==0,"TEST_VOICE_EMPTY_OCCLUSION_RESULT_STILL_REVALIDATES_ACTIVITY");checks++;
        requests=0;clock=0;guards=0;Expect(delegate{FocusConfirmVisibilityOnce(delegate{if(++guards==3)throw new Fault("VOICE_CAPTURE_CHANGED");},delegate{return 1;},delegate{requests++;return true;},delegate{return clock;},delegate(int ms){clock+=ms;},false,null,"VoiceFocusVisibility");},"VOICE_CAPTURE_CHANGED");Need(requests==0,"TEST_VOICE_AUDIO_CHANGE_BEFORE_RAISE_NO_REQUEST");checks++;
        requests=samples=0;clock=0;visible=FocusConfirmVisibilityOnce(delegate{},delegate{return ++samples==1?1:0;},delegate{requests++;return false;},delegate{return clock;},delegate(int ms){clock+=ms;},false,null,"VoiceFocusVisibility");Need(visible.Confirmed&&requests==1&&visible.RequestAccepted==false&&visible.LastBlockingCount==0,"TEST_VOICE_RAISE_RESULT_REQUIRES_ACTUAL_FULL_VISIBILITY");checks++;
        return checks;
    }
}
