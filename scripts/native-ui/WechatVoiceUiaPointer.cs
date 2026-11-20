using System;
using System.Collections;
using System.Threading;

internal static partial class WechatDraftProbe {
    static int VoiceUiaPointerMessages;
    static Exception VoiceUiaPointerFailure(Exception error){
        if(!(error is Fault)||!error.Message.StartsWith("UIA_POINTER_",StringComparison.Ordinal))return error;
        var mapped=new Fault("VOICE_"+error.Message);foreach(DictionaryEntry item in error.Data)mapped.Data[item.Key]=item.Value;return mapped;
    }
    static int VoiceUiaDispatchPointer(Func<Action,int> dispatch,Action guard,Action mark){
        try{int posted=dispatch(delegate{guard();mark();});VoiceUiaPointerMessages+=posted;return posted;}
        catch(Exception error){
            var partial=Map(error.Data["WindowMessageInput"]);object count=Get(partial,"messagesPosted");
            if(count is int&&(int)count>=0&&(int)count<=3)VoiceUiaPointerMessages+=(int)count;
            Exception mapped=VoiceUiaPointerFailure(error);if(Object.ReferenceEquals(mapped,error))throw;throw mapped;
        }
    }
    static bool VoiceUiaPointerRecipient(VoiceRequest request,uint thread){
        try{
            uint pid=0;Need(IsWindow(request.Binding.Window)&&GetWindowThreadProcessId(request.Binding.Window,out pid)==thread&&pid==request.Binding.Pid,"VOICE_UIA_POINTER_TARGET_CHANGED");
            IntPtr process=OpenProcess(0x1000,false,pid);if(process==IntPtr.Zero)return false;
            try{FileTime start,exit,kernel,user;return GetProcessTimes(process,out start,out exit,out kernel,out user)&&start.Value==request.Binding.Created;}finally{CloseHandle(process);}
        }catch{return false;}
    }
    static void VoiceMarkBackgroundSubmission(VoiceHandoffState state,VoiceBackgroundSubmission submission,long at){
        InputAttempted=true;if(!submission.Attempted){submission.Attempted=true;VoiceSubmitAttempted=true;VoiceSubmitMs=at;Interlocked.Exchange(ref state.Phase,7);}
    }
    static void VoiceUiaPointerClick(VoiceRequest request,long revision,Rect rect,int phase,Action mark,bool allowStopped){
        Need(request.Uia!=null&&Contains(request.Binding.Client,rect),"VOICE_UIA_CLICK_ROLE_CHANGED");
        VoiceUiaConversationAndClickGuard(request,rect,phase);
        Point saved;Need(FocusGetCursorPos(out saved),"VOICE_POINTER_UNAVAILABLE");
        uint pid,thread=GetWindowThreadProcessId(request.Binding.Window,out pid);Need(thread!=0&&pid==request.Binding.Pid,"VOICE_UIA_POINTER_TARGET_CHANGED");
        Action guard=delegate{VoiceGuard(request,revision,phase,allowStopped);NoKeysHeld();Point current;Need(GetForegroundWindow()==request.Binding.Window&&FocusGetCursorPos(out current)&&current.X==saved.X&&current.Y==saved.Y,"DRAFT_HUMAN_ACTIVITY_CHANGED");};
        guard();
        VoiceUiaDispatchPointer(delegate(Action beforeDown){return WindowMessageClick(request.Binding.Window,new Point(rect.Left+rect.Width/2,rect.Top+rect.Height/2),beforeDown,
            delegate{return VoiceUiaPointerRecipient(request,thread);},delegate{InputAttempted=true;});},guard,mark);
        // The existing recorder-ready/audio-start and recorder-ended checks
        // acknowledge the state transition. Queue acceptance never does.
        Point after;Need(Interlocked.Read(ref Revision)==revision&&FocusGetCursorPos(out after)&&after.X==saved.X&&after.Y==saved.Y,"DRAFT_HUMAN_ACTIVITY_CHANGED");
    }
    static void VoiceUiaSubmitInBackground(VoiceRequest request,AudioRouteProbe.NativeVoiceAudio audio){
        var state=VoiceHandoff;string capture=VoiceCaptureInstance,recorder=request.Uia==null?null:request.Uia.Recorder;
        Need(state!=null&&VoiceMaySubmitInBackground(request.Uia!=null,state.InitialReturnConfirmed,state.BackgroundEntered,Interlocked.CompareExchange(ref state.Phase,0,0),VoiceCaptureVerified&&capture!=null,recorder!=null,VoiceSubmitAttempted),"VOICE_BACKGROUND_SUBMIT_UNAVAILABLE");
        var submission=new VoiceBackgroundSubmission{ForegroundBefore=GetForegroundWindow(),ForegroundUnchanged=true};state.BackgroundSubmit=submission;
        Rect rect=request.Submit.Rect;Need(Contains(request.Binding.Client,rect),"VOICE_UIA_CLICK_ROLE_CHANGED");
        uint pid,thread=GetWindowThreadProcessId(request.Binding.Window,out pid);Need(thread!=0&&pid==request.Binding.Pid,"VOICE_UIA_POINTER_TARGET_CHANGED");
        Action guard=delegate{
            if(GetForegroundWindow()!=submission.ForegroundBefore)submission.ForegroundUnchanged=false;
            int phase=Interlocked.CompareExchange(ref state.Phase,0,0);
            Need(Object.ReferenceEquals(state,VoiceHandoff)&&Object.ReferenceEquals(submission,state.BackgroundSubmit)&&(phase==1||phase==7)&&VoiceCaptureInstance==capture&&request.Uia.Recorder==recorder,"VOICE_BACKGROUND_SUBMIT_UNAVAILABLE");
            VoiceBackgroundGuard(request,audio);
        };
        // UIA reads bind the original page, title, recorder runtime and enabled
        // submit role. No foreground/focus claim or physical input is needed.
        guard();VoiceUiaConversationAndClickGuard(request,rect,1);guard();
        try{
            VoiceUiaDispatchPointer(delegate(Action beforeDown){return WindowMessageClick(request.Binding.Window,new Point(rect.Left+rect.Width/2,rect.Top+rect.Height/2),beforeDown,
                delegate{return VoiceUiaPointerRecipient(request,thread);},delegate{
                    VoiceMarkBackgroundSubmission(state,submission,Now());
                });},delegate{guard();VoiceUiaConversationAndClickGuard(request,rect,1);guard();},delegate{});
            submission.Applied=true;VoiceSubmitApplied=true;
            // The recorder may already have stopped after the queued click;
            // only the subsequent bound-session/idle observer confirms that.
            VoiceActive();VoiceBoundWindowGuard(request);Need(!VoiceWindowProcess(GetForegroundWindow(),request.Binding.Pid),"VOICE_BACKGROUND_WECHAT_ACTIVATED");
        }finally{submission.ForegroundUnchanged=submission.ForegroundUnchanged&&GetForegroundWindow()==submission.ForegroundBefore&&!VoiceWindowProcess(GetForegroundWindow(),request.Binding.Pid);}
    }
    static int VoiceUiaPointerSelfTest(){int checks=0,saved=VoiceUiaPointerMessages;bool oldInput=InputAttempted,oldSubmit=VoiceSubmitAttempted;long oldSubmitMs=VoiceSubmitMs;try{
        var backgroundState=new VoiceHandoffState{Phase=1};var background=new VoiceBackgroundSubmission();int backgroundCalls=0;
        Expect(delegate{WindowMessageClickCore(new Point(1,2),delegate(uint message,UIntPtr flags,IntPtr position){backgroundCalls++;return false;},delegate{},delegate{return true;},delegate{VoiceMarkBackgroundSubmission(backgroundState,background,123);});},"UIA_POINTER_QUEUE_REJECTED");
        Need(backgroundCalls==1&&background.Attempted&&!background.Applied&&!background.Confirmed&&VoiceSubmitAttempted&&VoiceSubmitMs==123&&backgroundState.Phase==7,"VOICE_TEST_BACKGROUND_FIRST_QUEUE_FAILURE_RETAINS_UNCERTAIN_ATTEMPT_WITHOUT_RETRY");checks++;
        VoiceMarkBackgroundSubmission(backgroundState,background,456);Need(VoiceSubmitMs==123,"VOICE_TEST_BACKGROUND_MARK_PRESERVES_FIRST_ATTEMPT");checks++;
        VoiceUiaPointerMessages=0;bool marked=false;var interrupted=new Fault("DRAFT_HUMAN_ACTIVITY_CHANGED");
        try{VoiceUiaDispatchPointer(delegate(Action beforeDown){return WindowMessageClickCore(new Point(1,2),delegate(uint message,UIntPtr flags,IntPtr position){Need(!marked,"VOICE_TEST_POINTER_NOT_MARKED_BEFORE_GUARD");return true;},beforeDown,delegate{return true;},delegate{});},delegate{throw interrupted;},delegate{marked=true;});throw new Exception("missing failure");}
        catch(Fault error){Need(Object.ReferenceEquals(error,interrupted)&&!marked&&VoiceUiaPointerMessages==1&&Number(Get(Map(error.Data["WindowMessageInput"]),"messagesPosted"))==1,"VOICE_TEST_POINTER_PRE_DOWN_INTERRUPTION_COUNTED_NOT_SUBMITTED");}checks++;
        for(int failure=0;failure<3;failure++){
            int calls=0,stop=failure,before=VoiceUiaPointerMessages;marked=false;
            try{VoiceUiaDispatchPointer(delegate(Action beforeDown){return WindowMessageClickCore(new Point(1,2),delegate(uint message,UIntPtr flags,IntPtr position){Need(marked==(message!=0x200),"VOICE_TEST_POINTER_MARK_ONLY_AFTER_GUARD");return calls++!=stop;},beforeDown,delegate{return true;},delegate{});},delegate{},delegate{marked=true;});throw new Exception("missing failure");}
            catch(Fault error){var partial=Map(error.Data["WindowMessageInput"]);Need(error.Message=="VOICE_UIA_POINTER_QUEUE_REJECTED"&&VoiceSafeReason(error)==error.Message&&calls==stop+1&&VoiceUiaPointerMessages-before==stop&&marked==(stop>0)&&Number(Get(partial,"messagesPosted"))==stop&&Object.Equals(Get(partial,"unpairedDownQueued"),stop==2)&&Object.Equals(Get(partial,"retryAllowed"),false),"VOICE_TEST_POINTER_PARTIAL_COUNT_AND_ERROR_DATA_PRESERVED");}checks++;
        }
        int initial=VoiceUiaPointerMessages,guards=0,marks=0;
        int posted=VoiceUiaDispatchPointer(delegate(Action beforeDown){return WindowMessageClickCore(new Point(1,2),delegate(uint message,UIntPtr flags,IntPtr position){return true;},beforeDown,delegate{return true;},delegate{});},delegate{guards++;},delegate{Need(guards==1,"VOICE_TEST_POINTER_MARK_REQUIRES_GUARD");marks++;});
        Need(posted==3&&VoiceUiaPointerMessages==initial+3&&guards==1&&marks==1,"VOICE_TEST_POINTER_SUCCESS_COUNTED_ONCE");checks++;
        var source=new Fault("UIA_POINTER_RELEASE_TARGET_CHANGED");object detail=Data("fixture",true);source.Data["WindowMessageInput"]=detail;source.Data["extra"]=7;var mapped=VoiceUiaPointerFailure(source);Need(mapped.Message=="VOICE_UIA_POINTER_RELEASE_TARGET_CHANGED"&&Object.ReferenceEquals(mapped.Data["WindowMessageInput"],detail)&&Object.Equals(mapped.Data["extra"],7),"VOICE_TEST_POINTER_MAPPING_PRESERVES_ALL_DATA");checks++;
        return checks;
    }finally{VoiceUiaPointerMessages=saved;InputAttempted=oldInput;VoiceSubmitAttempted=oldSubmit;VoiceSubmitMs=oldSubmitMs;}}
}
