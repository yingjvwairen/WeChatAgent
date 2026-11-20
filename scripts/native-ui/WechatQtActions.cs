// Project-owned Qt transport. Every mutation consumes a fresh, native observation
// and checks process, desktop, geometry, focus, physical activity and pixel anchors.
// Higher-level account/contact identity is established by the local coordinator.
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

internal static class WechatQtActions {
    [STAThread] static int Main(string[] args) { return WechatDraftProbe.QtMain(args); }
}

internal static partial class WechatDraftProbe {
    sealed class QtAnchor { internal Rect Rect; internal string Hash; }
    sealed class QtFrame { internal Binding Binding; internal string Token; internal long Revision,Issued; internal List<QtAnchor> Anchors; internal Rect? PopupBounds,PopupClient; internal bool NavigationOnly,UiaControlFrame,MetadataOnly; internal List<QtUiaRole> UiaRoles; internal QtFocusLease NavigationLease,UiaControlLease,MetadataLease; }
    static QtFrame QtCurrent;
    sealed class QtEmptyPhaseLease { internal string Id,Epoch;internal Binding Binding;internal long Revision,Issued;internal Rect Editor;internal HashSet<string> Known;internal List<QtAnchor> OtherAnchors; }
    static QtEmptyPhaseLease QtEmptyPhaseProof;
    static string QtExecutable,QtFrames;
    static IntPtr QtWindow;
    static IntPtr QtRootWindow;
    static uint QtRootPid;
    static long QtRootCreated;
    static bool QtEnableInput;
    static readonly string QtEpoch=Guid.NewGuid().ToString("N");
    static long QtCommandStarted;
    static readonly Queue<string> QtRequests=new Queue<string>();
    static bool QtInputEnded,QtInputFailed;
    static int QtExitCode;
    static bool? QtClipboardRestoreObserved;
    static bool QtClipboardReplacedObserved;
    sealed class QtPopupCalibration { internal string Kind,ClassName,OwnerRelation;internal Rect RelativeWindow;internal int ClientWidth,ClientHeight,OwnerDepth,MinHeight,MaxHeight;internal long Style,ExtendedStyle;internal HashSet<int> HeightVariants=new HashSet<int>(); }
    sealed class QtPopupLease { internal string Id;internal QtPopupCalibration Calibration;internal Binding Root;internal long Revision,Issued;internal HashSet<IntPtr> PreviouslyVisible;internal IntPtr Window;internal bool Observed,UiaSearch;internal Rect ObservedBounds,ObservedClient,ObservedClientScreen;internal QtQueryClickProof QueryClick; }
    sealed class QtQueryClickProof { internal QtPopupLease Popup;internal QtFrame Frame;internal string Epoch;internal bool Consumed; }
    sealed class QtSearchPasteCompletion { internal QtPopupLease Popup;internal QtQueryClickProof QueryClick; }
    static QtPopupLease QtPendingPopup,QtPopup;
    sealed class QtTextStepBinding {internal string Delivery,Account,Target;}
    sealed class QtEnterProof { internal string Id,Kind,Digest,Epoch;internal QtFrame Frame;internal QtPopupLease Popup;internal QtTextStepBinding Step;internal bool Consumed,Paused,InputOnly; }
    static QtEnterProof QtPendingEnter;
    static void QtRevokeEnter(){if(QtPendingEnter!=null)QtPendingEnter.Consumed=true;QtPendingEnter=null;}
    static void QtPauseTextEnter(){if(QtPendingEnter!=null&&QtPendingEnter.Kind=="text"&&QtPendingEnter.Step!=null&&!QtPendingEnter.Consumed)QtPendingEnter.Paused=true;else QtRevokeEnter();}
    static QtTextStepBinding QtParseTextStep(object value){if(value==null)return null;var map=Map(value);Need(map!=null&&map.Count==4&&Number(Get(map,"version"))==1,"QT_TEXT_STEP_INVALID");string delivery=Text(map,"deliveryId"),account=Text(map,"accountSha256"),target=Text(map,"targetSha256");Need(delivery!=null&&account!=null&&target!=null&&System.Text.RegularExpressions.Regex.IsMatch(delivery,"\\A[a-f0-9]{64}\\z")&&System.Text.RegularExpressions.Regex.IsMatch(account,"\\A[a-f0-9]{64}\\z")&&System.Text.RegularExpressions.Regex.IsMatch(target,"\\A[a-f0-9]{64}\\z"),"QT_TEXT_STEP_INVALID");return new QtTextStepBinding{Delivery=delivery,Account=account,Target=target};}
    static bool QtSameTextStep(QtTextStepBinding a,QtTextStepBinding b){return a==null?b==null:b!=null&&a.Delivery==b.Delivery&&a.Account==b.Account&&a.Target==b.Target;}
    static void QtFinishEnterAttempt(QtEnterProof proof,bool retain,bool attempted){if(proof!=null){if(retain&&!attempted){proof.Paused=true;QtPendingEnter=proof;}else proof.Consumed=true;}}
    // Error-only observation context. It never supplies a token or changes a guard.
    static string QtPasteDiagnosticStage;
    static QtFrame QtPasteDiagnosticFrame;
    static string QtSurface="main";
    sealed class QtFocusIdentity { internal IntPtr Window;internal uint Pid;internal long Created;internal object Report(){return Data("hwnd",Window.ToInt64().ToString(CultureInfo.InvariantCulture),"pid",Pid,"processCreatedFileTimeUtc",Created.ToString(CultureInfo.InvariantCulture));} }
    sealed class QtFocusLease { internal QtFocusIdentity Return,Wechat;internal long Revision,ForegroundStarted;internal long? TransferredInputTick;internal long TransferredIssuedAt;internal bool IncludesContactNavigation,AllowOverlappedReturn,UiaMode;internal FocusActivation Activation;internal QtUiaCaption UiaCaption;internal QtReturnCaption ReturnCaption;internal bool ReturnCaptionAttempted,TargetRaiseAttempted,ReturnRaiseAttempted;internal Point OriginalPointer,LastPointer;internal bool PointerSaved,PointerCertain,PointerMoved;internal object Handoff(){var value=Data("version",1,"returnWindow",Return.Report());if(Activation!=null)value.Add("activation",Activation.Report());if(ForegroundStarted>0)value.Add("foregroundLease",Data("version",1,"startedAtTickMs",ForegroundStarted,"includesContactNavigation",IncludesContactNavigation));return value;} }
    static QtFocusLease QtLease;
    static QtFocusLease QtInspectedFocus;
    static QtFocusLease QtParkedLease;
    static Binding QtParkedBinding;
    static long QtParkedAt;
    static QtFocusIdentity QtFocusWindow(IntPtr window,string executable=null,bool allowOwnedPopup=false) {
        Desktop();Need(window!=IntPtr.Zero&&IsWindow(window)&&IsWindowVisible(window)&&!IsIconic(window)&&GetAncestor(window,2)==window&&(allowOwnedPopup||GetLastActivePopup(window)==window),"QT_FOCUS_WINDOW_UNAVAILABLE");
        int cloaked;Need(DwmGetWindowAttribute(window,14,out cloaked,4)>=0&&cloaked==0,"QT_FOCUS_WINDOW_UNAVAILABLE");uint pid;Need(GetWindowThreadProcessId(window,out pid)!=0,"QT_FOCUS_WINDOW_UNAVAILABLE");
        uint session,own;Need(ProcessIdToSessionId(pid,out session)&&ProcessIdToSessionId(GetCurrentProcessId(),out own)&&session==own,"QT_FOCUS_WINDOW_UNAVAILABLE");
        IntPtr process=OpenProcess(0x1000,false,pid);Need(process!=IntPtr.Zero,"QT_FOCUS_WINDOW_UNAVAILABLE");try{FileTime start,exit,kernel,user;Need(GetProcessTimes(process,out start,out exit,out kernel,out user),"QT_FOCUS_WINDOW_UNAVAILABLE");
            if(executable!=null){var file=new StringBuilder(32768);int length=file.Capacity;Need(QueryFullProcessImageName(process,0,file,ref length)&&String.Equals(Path.GetFullPath(file.ToString()),executable,StringComparison.OrdinalIgnoreCase),"DRAFT_EXECUTABLE_MISMATCH");}
            return new QtFocusIdentity{Window=window,Pid=pid,Created=start.Value};}finally{CloseHandle(process);}
    }
    static bool QtSameFocus(QtFocusIdentity a,QtFocusIdentity b){return a!=null&&b!=null&&a.Window==b.Window&&a.Pid==b.Pid&&a.Created==b.Created;}
    static void QtCheckFocusPair(QtFocusLease inspected,QtFocusIdentity source,QtFocusIdentity target){
        if(inspected!=null)Need(QtSameFocus(inspected.Return,source)&&QtSameFocus(inspected.Wechat,target),"QT_FOCUS_TARGET_CHANGED");
        if(source.Window==target.Window)throw new Fault("QT_FOCUS_RETURN_WINDOW_REQUIRED");
        Need(source.Pid!=target.Pid,"QT_FOCUS_WECHAT_AUXILIARY_ACTIVE");
    }
    static QtFocusIdentity QtParseFocus(object value){var map=Map(value);Need(map!=null&&map.Count==3,"QT_FOCUS_LEASE_INVALID");long pid=Number(Get(map,"pid"));Need(pid>0&&pid<=UInt32.MaxValue,"QT_FOCUS_LEASE_INVALID");return new QtFocusIdentity{Window=new IntPtr(DecimalString(Get(map,"hwnd"))),Pid=(uint)pid,Created=DecimalString(Get(map,"processCreatedFileTimeUtc"))};}
    static uint QtInputTick(){var input=new LastInput{Size=(uint)Marshal.SizeOf(typeof(LastInput))};Need(GetLastInputInfo(ref input),"DRAFT_ACTIVITY_MONITOR_UNAVAILABLE");return input.Time;}
    static bool QtCanRestore(bool owned,bool identity,bool activity,bool keys){return owned&&identity&&activity&&keys;}
    static bool QtKeysReleased(){for(int key=1;key<256;key++)if((GetAsyncKeyState(key)&0x8000)!=0)return false;return true;}
    static bool QtSamePoint(Point a,Point b){return a.X==b.X&&a.Y==b.Y;}
    static bool QtNearPoint(Point a,Point b){return Math.Abs((long)a.X-b.X)<=1&&Math.Abs((long)a.Y-b.Y)<=1;}
    static Rect QtDesktopRect(){return new Rect(GetSystemMetrics(76),GetSystemMetrics(77),GetSystemMetrics(76)+GetSystemMetrics(78),GetSystemMetrics(77)+GetSystemMetrics(79));}
    static Input[] QtPointerEvents(Point point,Rect desktop){return new[]{ClickEvents(point.X,point.Y,desktop)[0]};}
    static bool QtCanParkPointer(string surface,Rect rect,int width,bool anchored){return surface=="main"&&FocusActivationGeometry(rect,width)&&anchored;}
    static bool QtCanRestorePointer(bool saved,bool moved,bool certain,bool activity,bool keys,bool identity,bool foreground,bool desktop,Point actual,Point last){return saved&&moved&&certain&&activity&&keys&&identity&&foreground&&desktop&&QtSamePoint(actual,last);}
    // Record only the observed destination of our own marked mouse input. A
    // later physical move invalidates this lease even if it returns to the spot.
    static void QtRememberPointer(Point expected,long revision){
        QtFocusLease lease=QtLease;if(lease!=null){lease.PointerMoved=true;lease.PointerCertain=false;}
        long end=Now()+100;for(;;){Need(revision==Interlocked.Read(ref Revision),"QT_HUMAN_ACTIVITY_CHANGED");Point actual;
            if(FocusGetCursorPos(out actual)&&QtNearPoint(actual,expected)){if(lease!=null){lease.LastPointer=actual;lease.PointerCertain=true;}return;}
            Need(Now()<end,"QT_POINTER_UNCONFIRMED");Thread.Sleep(5);
        }
    }
    static bool QtRestorePointer(QtFocusLease lease,IntPtr foreground){
        if(lease==null||!lease.PointerSaved||!lease.PointerMoved||!lease.PointerCertain)return false;
        Point actual;Rect desktop=QtDesktopRect();Point original=lease.OriginalPointer;
        if(!FocusGetCursorPos(out actual)||!QtCanRestorePointer(lease.PointerSaved,lease.PointerMoved,lease.PointerCertain,lease.Revision==Interlocked.Read(ref Revision),QtKeysReleased(),
            QtSameFocus(lease.Return,QtFocusWindow(lease.Return.Window))&&QtSameFocus(lease.Wechat,QtFocusWindow(lease.Wechat.Window,QtExecutable,true)),GetForegroundWindow()==foreground,
            original.X>=desktop.Left&&original.X<desktop.Right&&original.Y>=desktop.Top&&original.Y<desktop.Bottom,actual,lease.LastPointer))return false;
        Desktop();NoKeysHeld();if(lease.Revision!=Interlocked.Read(ref Revision)||GetForegroundWindow()!=foreground||!FocusGetCursorPos(out actual)||!QtSamePoint(actual,lease.LastPointer))return false;
        Input[] inputs=QtPointerEvents(original,desktop);lease.PointerCertain=false;InputAttempted=true;
        Need(SendInput(1,inputs,Marshal.SizeOf(typeof(Input)))==1,"QT_POINTER_RESTORE_UNCONFIRMED");
        long end=Now()+100;for(;;){if(lease.Revision!=Interlocked.Read(ref Revision)||!QtKeysReleased())return false;
            if(FocusGetCursorPos(out actual)&&QtNearPoint(actual,original)){lease.PointerMoved=false;return true;}
            Need(Now()<end,"QT_POINTER_RESTORE_UNCONFIRMED");Thread.Sleep(5);
        }
    }
    static QtFocusIdentity QtHandoffTarget(int width,int height,int dpi){
        Need(width>=600&&width<=4096&&height>=400&&height<=4096&&dpi>=48&&dpi<=768,"QT_FOCUS_GEOMETRY_INVALID");
        IntPtr pinned=QtRootWindow!=IntPtr.Zero?QtRootWindow:QtWindow;
        if(pinned!=IntPtr.Zero){QtFocusIdentity selected=QtFocusWindow(pinned,QtExecutable);Rect client;Need(GetWindow(pinned,4)==IntPtr.Zero&&(QtRootWindow==IntPtr.Zero||selected.Pid==QtRootPid&&selected.Created==QtRootCreated)&&GetClientRect(selected.Window,out client)&&client.Width==width&&client.Height==height&&GetDpiForWindow(selected.Window)==dpi,"QT_FOCUS_TARGET_CHANGED");return selected;}
        var candidates=new List<QtFocusIdentity>();EnumWindows(delegate(IntPtr window,IntPtr unused){try{Rect client;if(GetWindow(window,4)!=IntPtr.Zero)return true;QtFocusIdentity found=QtFocusWindow(window,QtExecutable);if(GetClientRect(window,out client)&&client.Width==width&&client.Height==height&&GetDpiForWindow(window)==dpi)candidates.Add(found);}catch{}return true;},IntPtr.Zero);
        Need(candidates.Count==1,"QT_FOCUS_TARGET_AMBIGUOUS");return candidates[0];
    }
    static object QtInspectLayout(){
        Need(!Stopping,"QT_STOPPING");Desktop();var candidates=new List<QtFocusIdentity>();
        IntPtr pinned=QtRootWindow!=IntPtr.Zero?QtRootWindow:QtWindow;
        EnumWindows(delegate(IntPtr window,IntPtr unused){
            try{
                if(pinned!=IntPtr.Zero&&pinned!=window||GetWindow(window,4)!=IntPtr.Zero)return true;
                Rect clientRect;var found=QtFocusWindow(window,QtExecutable);
                if((QtRootWindow==IntPtr.Zero||found.Pid==QtRootPid&&found.Created==QtRootCreated)&&GetClientRect(window,out clientRect)
                    &&clientRect.Width>=600&&clientRect.Width<=4096&&clientRect.Height>=400&&clientRect.Height<=4096)candidates.Add(found);
            }catch{}return true;
        },IntPtr.Zero);
        Need(candidates.Count==1,"QT_FOCUS_TARGET_AMBIGUOUS");var target=candidates[0];Rect client;Point origin=new Point(0,0);Need(GetClientRect(target.Window,out client)&&ClientToScreen(target.Window,ref origin),"DRAFT_GEOMETRY_UNAVAILABLE");uint dpi=GetDpiForWindow(target.Window);
        string version=FileVersionInfo.GetVersionInfo(QtExecutable).FileVersion,sha;using(var file=File.OpenRead(QtExecutable))using(var digest=SHA256.Create())sha=BitConverter.ToString(digest.ComputeHash(file)).Replace("-","").ToLowerInvariant();
        Rect after;Point at=new Point(0,0);Need(QtSameFocus(target,QtFocusWindow(target.Window,QtExecutable))&&GetClientRect(target.Window,out after)&&ClientToScreen(target.Window,ref at)&&Same(client,after)&&at.X==origin.X&&at.Y==origin.Y&&GetDpiForWindow(target.Window)==dpi,"QT_BINDING_CHANGED");
        return Data("version",1,"readOnly",true,"inputSent",false,"focusChanged",false,"clipboardAccessed",false,"executableVersion",version,"executableSha256",sha,"binding",Data("hwnd",target.Window.ToInt64().ToString(CultureInfo.InvariantCulture),"pid",target.Pid,"processCreatedFileTimeUtc",target.Created.ToString(CultureInfo.InvariantCulture),"dpi",dpi,"clientRect",client.Report(),"captureRect",new Rect(origin.X,origin.Y,origin.X+client.Width,origin.Y+client.Height).Report(),"foreground",GetForegroundWindow()==target.Window));
    }
    static Binding QtLayoutBound(){
        var inspection=Map(QtInspectLayout());var raw=Map(Get(inspection,"binding"));IntPtr window=new IntPtr(DecimalString(Get(raw,"hwnd")));var identity=QtFocusWindow(window,QtExecutable);Rect client;Point origin=new Point(0,0);Need(GetClientRect(window,out client)&&ClientToScreen(window,ref origin),"DRAFT_GEOMETRY_UNAVAILABLE");
        uint pid;uint thread=GetWindowThreadProcessId(window,out pid);var gui=new GuiInfo{Size=(uint)Marshal.SizeOf(typeof(GuiInfo))};Need(GetGUIThreadInfo(thread,ref gui)&&(gui.Flags&0x1e)==0,"QT_FOCUS_UNAVAILABLE");
        var result=new Binding{Window=window,Pid=identity.Pid,Thread=thread,Created=identity.Created,Dpi=GetDpiForWindow(window),Client=client,Capture=new Rect(origin.X,origin.Y,origin.X+client.Width,origin.Y+client.Height),Focus=gui.Focus,FocusOwned=Owned(gui.Focus,window,identity.Pid),InputTick=QtInputTick(),GuiFlags=gui.Flags};QtNoOverlap(result);return result;
    }
    // Evidence for a layout candidate only. No token is issued, so these
    // background pixels can never authorize a click or substitute for QtGuard.
    static object QtCaptureLayout(Dictionary<string,object> request){
        Need(!Stopping,"QT_STOPPING");var before=QtLayoutBound();var anchors=QtLayoutAnchors(Get(request,"regions"),Get(request,"image"),before.Client);var regions=new List<object>();foreach(var anchor in anchors){anchor.Hash=QtHash(QtPixels(before,anchor.Rect));regions.Add(Data("rect",anchor.Rect.Report(),"rgbaSha256",anchor.Hash));}
        string file=null,sha=null;
        if(Object.Equals(Get(request,"image"),true)){file=Path.Combine(QtFrames,"qt-"+Guid.NewGuid().ToString("N")+".png");using(var bitmap=new Bitmap(before.Client.Width,before.Client.Height,PixelFormat.Format32bppArgb)){using(var graphics=Graphics.FromImage(bitmap))graphics.CopyFromScreen(before.Capture.Left,before.Capture.Top,0,0,new Size(bitmap.Width,bitmap.Height),CopyPixelOperation.SourceCopy);using(var memory=new MemoryStream()){bitmap.Save(memory,ImageFormat.Png);var bytes=memory.ToArray();sha=QtHash(bytes);using(var output=new FileStream(file,FileMode.CreateNew,FileAccess.Write,FileShare.None))output.Write(bytes,0,bytes.Length);}}}
        var after=QtLayoutBound();Need(QtSameBinding(before,after),"QT_BINDING_CHANGED");for(int index=0;index<anchors.Count;index++)QtNeedAnchorPixels(anchors[index].Hash,QtHash(QtPixels(after,anchors[index].Rect)),"capture",index);
        var binding=Map(after.Report());binding["foreground"]=GetForegroundWindow()==after.Window;
        return Data("readOnly",true,"inputSent",false,"focusChanged",false,"authorizationGranted",false,"binding",binding,"executableVersion",FileVersionInfo.GetVersionInfo(QtExecutable).FileVersion,"pixelFormat","rgba-row-major-opaque-v1","regions",regions,"image",file==null?null:Data("file",file,"sha256",sha));
    }
    static bool QtLayoutExpectedMatches(Dictionary<string,object> expected,Dictionary<string,object> actual){
        if(expected==null||actual==null||expected.Count!=6)return false;
        foreach(string key in new[]{"hwnd","pid","processCreatedFileTimeUtc","dpi","clientRect","captureRect"})if(!expected.ContainsKey(key)||!actual.ContainsKey(key))return false;
        return Text(expected,"hwnd")==Text(actual,"hwnd")&&Number(Get(expected,"pid"))==Number(Get(actual,"pid"))&&Text(expected,"processCreatedFileTimeUtc")==Text(actual,"processCreatedFileTimeUtc")&&
            Number(Get(expected,"dpi"))==Number(Get(actual,"dpi"))&&Same(ParseRect(Get(expected,"clientRect")),ParseRect(Get(actual,"clientRect")))&&Same(ParseRect(Get(expected,"captureRect")),ParseRect(Get(actual,"captureRect")));
    }
    // Capture only while the exact current target owns foreground. Restore is
    // attempted exactly once even after acquisition/capture fails. No result
    // escapes until cleanup confirms its original return/activity contract.
    static T[] QtLayoutPairTransaction<T>(Action acquire,Action guard,Func<T> capture,Action restore,Action<T> discard){
        var samples=new List<T>();bool complete=false;
        try{
            try{acquire();guard();samples.Add(capture());guard();samples.Add(capture());guard();}
            finally{restore();}
            complete=true;return samples.ToArray();
        }finally{if(!complete)foreach(T sample in samples)discard(sample);}
    }
    static object QtCaptureLayoutHandoff(Dictionary<string,object> request){
        Need(QtEnableInput&&!Stopping&&QtLease==null&&QtParkedLease==null&&QtSurface=="main"&&QtPopup==null&&QtPendingPopup==null&&QtPendingEnter==null,"QT_FOCUS_LEASE_UNAVAILABLE");
        var expected=Map(Get(request,"expectedBinding"));var inspected=Map(QtInspectLayout());
        Need(QtLayoutExpectedMatches(expected,Map(Get(inspected,"binding"))),"QT_BINDING_CHANGED");
        long idle=Number(Get(request,"idleMs"));Need(idle>=1000&&idle<=300000,"QT_IDLE_INVALID");QtRequireIdle(idle);NoKeysHeld();
        long revision=Interlocked.Read(ref Revision);Rect client=ParseRect(Get(expected,"clientRect"));
        var expectedTarget=new QtFocusIdentity{Window=new IntPtr(DecimalString(Get(expected,"hwnd"))),Pid=checked((uint)Number(Get(expected,"pid"))),Created=DecimalString(Get(expected,"processCreatedFileTimeUtc"))};
        var expectedFocus=new QtFocusLease{Return=QtFocusWindow(GetForegroundWindow()),Wechat=expectedTarget,Revision=revision};
        var begin=Data("idleMs",idle,"width",client.Width,"height",client.Height,"dpi",Number(Get(expected,"dpi")),"includesContactNavigation",false);
        QtFocusLease lease=null;Binding bound=null;Dictionary<string,object> restored=null;var files=new List<string>();
        Bitmap[] samples=QtLayoutPairTransaction<Bitmap>(delegate{
            // No activation rectangle is supplied: unknown geometry must never
            // borrow stale coordinates or issue a guessed click into WeChat.
            QtBeginFocus(begin,revision,true,expectedFocus);lease=QtLease;bound=Snapshot(lease.Wechat.Window,QtExecutable);
            Need(QtLayoutExpectedMatches(expected,Map(bound.Report())),"QT_BINDING_CHANGED");
        },delegate{
            Need(lease!=null&&QtLease==lease,"QT_FOCUS_LEASE_UNAVAILABLE");QtFocusTransitionGuard(lease,revision,false);
            Need(GetForegroundWindow()==lease.Wechat.Window,"QT_FOCUS_TARGET_CHANGED");var actual=Snapshot(lease.Wechat.Window,QtExecutable);
            Need(QtSameBinding(bound,actual)&&QtLayoutExpectedMatches(expected,Map(actual.Report())),"QT_BINDING_CHANGED");QtNoOverlap(actual);
        },delegate{
            var bitmap=new Bitmap(bound.Client.Width,bound.Client.Height,PixelFormat.Format32bppArgb);
            try{using(var graphics=Graphics.FromImage(bitmap))graphics.CopyFromScreen(bound.Capture.Left,bound.Capture.Top,0,0,new Size(bitmap.Width,bitmap.Height),CopyPixelOperation.SourceCopy);return bitmap;}catch{bitmap.Dispose();throw;}
        },delegate{
            // QtBeginFocus already cleans its failed acquisition. Only a
            // successful lease is ours to return, including during stop.
            if(lease==null)return;QtLease=null;restored=Map(QtRestoreFocus(lease,revision==Interlocked.Read(ref Revision)));
            if(revision!=Interlocked.Read(ref Revision)){var interrupted=new Fault("QT_HUMAN_ACTIVITY_CHANGED");interrupted.Data["QtFocusRestoreOutcome"]=Get(restored,"focusRestoreOutcome");QtMarkFocusTimingFailure(interrupted,lease);throw interrupted;}
            QtNeedParkRestored(restored,revision==Interlocked.Read(ref Revision));
            Need(GetForegroundWindow()==lease.Return.Window,"QT_FOCUS_RETURN_UNCONFIRMED");
        },delegate(Bitmap sample){sample.Dispose();});
        try{
            var frames=new List<object>();var binding=Map(bound.Report());binding["foreground"]=true;
            // Encoding and filesystem writes run only after focus is returned.
            foreach(Bitmap bitmap in samples){
                string file=Path.Combine(QtFrames,"qt-"+Guid.NewGuid().ToString("N")+".png");files.Add(file);string sha;
                using(var memory=new MemoryStream()){bitmap.Save(memory,ImageFormat.Png);var bytes=memory.ToArray();sha=QtHash(bytes);using(var output=new FileStream(file,FileMode.CreateNew,FileAccess.Write,FileShare.None))output.Write(bytes,0,bytes.Length);}
                frames.Add(Data("readOnly",true,"inputSent",false,"focusChanged",true,"authorizationGranted",false,"binding",binding,"executableVersion",Text(inspected,"executableVersion"),"pixelFormat","rgba-row-major-opaque-v1","regions",new object[0],"image",Data("file",file,"sha256",sha)));
            }
            return Data("version",1,"mode","focus-handoff-layout-pair-v1","focusChanged",true,"inputSent",InputAttempted,"chatInputSent",false,"clipboardAccessed",false,"authorizationGranted",false,
                "restored",true,"activityUnchanged",true,"focusRestoreOutcome",Get(restored,"focusRestoreOutcome"),"foregroundInterval",Get(restored,"foregroundInterval"),"frames",frames);
        }catch{foreach(string file in files)try{File.Delete(file);}catch{}throw;}
        finally{foreach(Bitmap bitmap in samples)bitmap.Dispose();}
    }
    static int QtLayoutHandoffSelfTest(){int count=0;
        var expected=Data("hwnd","100","pid",2,"processCreatedFileTimeUtc","123","dpi",120,"clientRect",new Rect(0,0,1100,900).Report(),"captureRect",new Rect(-1100,0,0,900).Report());
        var actual=new Dictionary<string,object>(expected);actual.Add("foreground",true);
        Need(QtLayoutExpectedMatches(expected,actual),"QT_TEST_LAYOUT_CURRENT_GEOMETRY_ACCEPTED");count++;
        foreach(string key in new[]{"hwnd","pid","processCreatedFileTimeUtc","dpi","clientRect","captureRect"}){var changed=new Dictionary<string,object>(actual);changed[key]=key=="hwnd"||key=="processCreatedFileTimeUtc"?(object)"999":key=="clientRect"||key=="captureRect"?new Rect(0,0,800,600).Report():(object)999;Need(!QtLayoutExpectedMatches(expected,changed),"QT_TEST_LAYOUT_STALE_BINDING_REFUSED");count++;}
        var calls=new List<string>();int captures=0;var pair=QtLayoutPairTransaction<string>(delegate{calls.Add("acquire");},delegate{calls.Add("guard");},delegate{calls.Add("capture");return (++captures).ToString();},delegate{calls.Add("restore");},delegate(string sample){calls.Add("discard");});
        Need(pair.Length==2&&captures==2&&String.Join(",",calls.ToArray())=="acquire,guard,capture,guard,capture,guard,restore","QT_TEST_LAYOUT_TWO_SAMPLES_THEN_ONE_RETURN");count++;
        foreach(string failure in new[]{"acquire","guard","capture","restore"}){int discarded=0,returns=0,guards=0,taken=0;
            Expect(delegate{QtLayoutPairTransaction<string>(delegate{if(failure=="acquire")throw new Fault("QT_HUMAN_ACTIVITY_CHANGED");},delegate{if(++guards==2&&failure=="guard")throw new Fault("QT_HUMAN_ACTIVITY_CHANGED");},delegate{if(++taken==2&&failure=="capture")throw new Fault("QT_HUMAN_ACTIVITY_CHANGED");return "sample";},delegate{returns++;if(failure=="restore")throw new Fault("QT_HUMAN_ACTIVITY_CHANGED");},delegate(string sample){discarded++;});},"QT_HUMAN_ACTIVITY_CHANGED");
            Need(returns==1&&discarded==(failure=="acquire"?0:failure=="restore"?2:1),"QT_TEST_LAYOUT_INTERRUPT_RETURNS_ONCE_DISCARDS_IMAGES");count++;
        }return count;
    }
    static string QtIdleReason(long now,long lastActivity,long started,long revision,long minimum){
        if(now-lastActivity>=minimum)return null;
        return revision==0&&now-started<minimum?"QT_ACTIVITY_WARMUP":"QT_USER_ACTIVE";
    }
    static void QtRequireIdle(long minimum){string reason=QtIdleReason(Now(),Interlocked.Read(ref LastActivity),Interlocked.Read(ref ActivityMonitorStarted),Interlocked.Read(ref Revision),minimum);Need(reason==null,reason);}
    static object QtInspectFocus(Dictionary<string,object> request){
        long idle=Number(Get(request,"idleMs"));Need(idle>=1000&&idle<=300000,"QT_IDLE_INVALID");
        int width=checked((int)Number(Get(request,"width"))),height=checked((int)Number(Get(request,"height"))),dpi=checked((int)Number(Get(request,"dpi")));
        QtInspectedFocus=null;
        try{Need(!Stopping&&QtLease==null,"QT_FOCUS_LEASE_UNAVAILABLE");Desktop();long revision=Interlocked.Read(ref Revision);
            QtRequireIdle(idle);NoKeysHeld();QtFocusIdentity prior=QtFocusWindow(GetForegroundWindow()),target=QtHandoffTarget(width,height,dpi);
            Need(GetForegroundWindow()==prior.Window&&revision==Interlocked.Read(ref Revision),"QT_HUMAN_ACTIVITY_CHANGED");
            QtInspectedFocus=new QtFocusLease{Return=prior,Wechat=target,Revision=revision};QtCheckFocusPair(null,prior,target);
            return QtFocusInspectionResult(true,null,true);
        }catch(Fault error){return QtFocusInspectionResult(false,error.Message,true);}
    }
    static object QtForegroundDiagnostic(){try{Desktop();IntPtr window=GetForegroundWindow();uint pid=0;Need(window!=IntPtr.Zero&&GetWindowThreadProcessId(window,out pid)!=0,"QT_FOREGROUND_UNAVAILABLE");var name=new StringBuilder(257);Need(GetClassName(window,name,name.Capacity)>0,"QT_FOREGROUND_UNAVAILABLE");string processName;using(var process=Process.GetProcessById(checked((int)pid)))processName=process.ProcessName;return Data("available",true,"pid",pid,"processName",processName,"className",name.ToString(),"windowTitlesIncluded",false);}catch{return Data("available",false,"windowTitlesIncluded",false);}}
    static object QtFocusInspectionResult(bool ready,string reason,bool includeForeground=false){long now=Now();var report=Data("ready",ready,"reason",reason,"inputSent",false,"clipboardAccessed",false,"focusChanged",false,
        "idleMsObserved",Math.Max(0,now-Interlocked.Read(ref LastActivity)),"activityRevision",Interlocked.Read(ref Revision),"monitorUptimeMs",Math.Max(0,now-Interlocked.Read(ref ActivityMonitorStarted)),"inputActivityCounts",ActivityObserved.Report());if(includeForeground)report.Add("foreground",QtForegroundDiagnostic());return report;}
    static object QtInspectFocusActivation(Dictionary<string,object> request){
        Need(!Stopping&&QtLease==null,"QT_FOCUS_LEASE_UNAVAILABLE");long idle=Number(Get(request,"idleMs"));Need(idle>=1000&&idle<=300000,"QT_IDLE_INVALID");QtRequireIdle(idle);NoKeysHeld();Desktop();long revision=Interlocked.Read(ref Revision);
        int width=checked((int)Number(Get(request,"width"))),height=checked((int)Number(Get(request,"height"))),dpi=checked((int)Number(Get(request,"dpi")));Rect rect=ParseRect(Get(request,"rect"));Need(FocusActivationGeometry(rect,width),"DRAFT_FOCUS_CALIBRATION_INVALID");
        QtFocusIdentity target=QtHandoffTarget(width,height,dpi),source=QtFocusWindow(GetForegroundWindow());Need(source.Pid!=target.Pid,"QT_FOCUS_INACTIVE_WINDOW_REQUIRED");Point origin=new Point(0,0);Need(ClientToScreen(target.Window,ref origin),"DRAFT_GEOMETRY_UNAVAILABLE");Rect area=new Rect(origin.X+rect.Left,origin.Y+rect.Top,origin.X+rect.Right,origin.Y+rect.Bottom),client=new Rect(0,0,width,height);
        Rect desktop=new Rect(GetSystemMetrics(76),GetSystemMetrics(77),GetSystemMetrics(76)+GetSystemMetrics(78),GetSystemMetrics(77)+GetSystemMetrics(79));Need(Contains(desktop,area),"DRAFT_SCREEN_CHANGED");
        Action stable=delegate{Need(!Stopping&&revision==Interlocked.Read(ref Revision),"QT_HUMAN_ACTIVITY_CHANGED");Desktop();NoKeysHeld();Need(GetForegroundWindow()==source.Window&&QtSameFocus(source,QtFocusWindow(source.Window))&&QtSameFocus(target,QtHandoffTarget(width,height,dpi)),"QT_FOCUS_TARGET_CHANGED");Point at=new Point(0,0);Need(ClientToScreen(target.Window,ref at)&&at.X==origin.X&&at.Y==origin.Y,"DRAFT_FOCUS_GEOMETRY_CHANGED");Need(FocusAreaOwned(area,target.Window,target.Pid),"DRAFT_FOCUS_REGION_OBSCURED");};
        stable();string hash=FocusPixels(area);Thread.Sleep(35);stable();Need(FocusPixels(area)==hash,"QT_PIXELS_CHANGED");stable();
        return Data("rect",rect.Report(),"rgbaSha256",hash,"stableObservations",2,"readOnly",true,"inputSent",false,"focusChanged",false,"clipboardAccessed",false,
            "binding",Data("hwnd",target.Window.ToInt64().ToString(CultureInfo.InvariantCulture),"pid",target.Pid,"processCreatedFileTimeUtc",target.Created.ToString(CultureInfo.InvariantCulture),"dpi",dpi,"clientRect",client.Report(),"captureRect",new Rect(origin.X,origin.Y,origin.X+width,origin.Y+height).Report(),"foreground",false));
    }
    static object QtForegroundInterval(QtFocusLease lease,bool complete){
        return lease!=null&&lease.ForegroundStarted>0?Data("phase",lease.IncludesContactNavigation?"contact-navigation":"preparation","durationMs",Math.Max(0,Now()-lease.ForegroundStarted),"includesContactNavigation",lease.IncludesContactNavigation,"complete",complete):null;
    }
    static object QtFocusRestoreReport(Dictionary<string,object> report,QtFocusLease lease,bool complete){
        object interval=QtForegroundInterval(lease,complete);if(interval!=null)report.Add("foregroundInterval",interval);return report;
    }
    static void QtMarkFocusTimingFailure(Exception error,QtFocusLease lease){object interval=QtForegroundInterval(lease,false);if(interval!=null)error.Data["QtForegroundInterval"]=interval;}
    static object QtFocusTimingFailure(Exception error){return error.Data.Contains("QtForegroundInterval")?error.Data["QtForegroundInterval"]:null;}
    static object QtFocusRestoreFailure(Exception error){return error.Data.Contains("QtFocusRestoreOutcome")?error.Data["QtFocusRestoreOutcome"]:null;}
    // Observe the existing return checks once, in their original order. Null
    // means a check was not completed, never a guessed false/true result.
    static Dictionary<string,object> QtRestoreOutcome(string reason,bool? restored,bool? skipped,bool? foreground,bool? identities,bool? activity,bool? keys,bool? parkRevision=null){return Data("version",1,"reason",reason,"restored",restored,"skipped",skipped,"foregroundOwnedByWechat",foreground,"identitiesUnchanged",identities,"activityUnchanged",activity,"keysReleased",keys,"parkRevisionUnchanged",parkRevision);}
    static string QtRestoreSkipReason(bool foreground,bool identities,bool activity,bool keys){return !foreground?"foreground-not-wechat":!identities?"identity-changed":!activity?"activity-changed":!keys?"keys-held":"conditions-satisfied";}
    static long QtReturnActivityRevision(QtFocusLease lease,long current){Need(lease!=null&&lease.Revision==current,"QT_HUMAN_ACTIVITY_CHANGED");return lease.Revision;}
    static long QtBeginActivityRevision(long? required,long current){Need(!required.HasValue||required.Value==current,"QT_HUMAN_ACTIVITY_CHANGED");return required.HasValue?required.Value:current;}
    static bool QtTransferredUnchanged(long expectedTick,uint currentTick,long baseline,long current){return expectedTick==currentTick&&baseline==current;}
    static bool QtTransferredFresh(long issued,long now){return issued>0&&now>=issued&&now-issued<=30000;}
    static void QtTransferredGuard(QtFocusLease lease){
        if(!lease.TransferredInputTick.HasValue)return;
        Need(QtTransferredFresh(lease.TransferredIssuedAt,UtcMs()),"QT_FOCUS_LEASE_EXPIRED");
        // Until our single caption click is committed, the transfer token must
        // still match Windows' input tick, including the old/new-helper gap.
        // Afterwards its own marked mouse events may advance that tick; the
        // continuously running physical-input epoch remains mandatory.
        if(!lease.ReturnCaptionAttempted)Need(QtTransferredUnchanged(lease.TransferredInputTick.Value,QtInputTick(),lease.Revision,Interlocked.Read(ref Revision)),"QT_HUMAN_ACTIVITY_CHANGED");
    }
    static void QtNeedParkRestored(Dictionary<string,object> report,bool? revisionUnchanged){
        if(Object.Equals(Get(report,"restored"),true)&&revisionUnchanged==true)return;
        var error=new Fault("QT_FOCUS_RETURN_UNCONFIRMED");var origin=Map(Get(report,"focusRestoreOutcome"));
        if(origin!=null){var outcome=new Dictionary<string,object>(origin);outcome["parkRevisionUnchanged"]=revisionUnchanged;if(Object.Equals(Get(report,"restored"),true))outcome["reason"]="park-activity-changed";error.Data["QtFocusRestoreOutcome"]=outcome;}
        var interval=Map(Get(report,"foregroundInterval"));if(interval!=null){var incomplete=new Dictionary<string,object>(interval);incomplete["complete"]=false;error.Data["QtForegroundInterval"]=incomplete;}
        throw error;
    }
    static object QtRestoreFocus(QtFocusLease lease,bool unchanged){
        if(lease==null)return Data("restored",false,"skipped",true,"focusRestoreOutcome",QtRestoreOutcome("lease-absent",false,true,null,null,null,null));
        bool? foreground=null,identities=null,keys=null,restored=null;string stage="foreground-check-failed";
        try{foreground=QtOwnedPopup(GetForegroundWindow(),lease.Wechat.Window);stage="identity-check-failed";
            identities=QtSameFocus(lease.Return,QtFocusWindow(lease.Return.Window))&&QtSameFocus(lease.Wechat,QtFocusWindow(lease.Wechat.Window,QtExecutable,true));stage="keys-check-failed";keys=QtKeysReleased();
            if(!QtCanRestore(foreground.Value,identities.Value,unchanged,keys.Value))return QtFocusRestoreReport(Data("restored",false,"skipped",true,"focusRestoreOutcome",QtRestoreOutcome(QtRestoreSkipReason(foreground.Value,identities.Value,unchanged,keys.Value),false,true,foreground,identities,unchanged,keys)),lease,false);
            stage="restore-confirmation-failed";
            Need(!lease.ReturnCaptionAttempted,"QT_RETURN_CAPTION_ALREADY_ATTEMPTED");
            long revision=QtReturnActivityRevision(lease,Interlocked.Read(ref Revision));IntPtr source=GetForegroundWindow();Need(QtOwnedPopup(source,lease.Wechat.Window),"QT_FOCUS_RETURN_UNCONFIRMED");
            long returnDeadline=Now()+400;var result=ConfirmFocusOnce(source,lease.Return.Window,delegate{return QtActivateReturnOnce(lease,source,revision,returnDeadline);},delegate{QtFocusTransitionGuard(lease,revision,true);},GetForegroundWindow,Now,Thread.Sleep);
            NeedFocusConfirmed(result,"QT_FOCUS_RETURN_UNCONFIRMED");restored=true;stage="pointer-restore-failed";bool pointerRestored=QtRestorePointer(lease,lease.Return.Window);var report=Data("restored",true,"skipped",false,"pointerRestored",pointerRestored,"focusConfirmation",result.Report(),"focusRestoreOutcome",QtRestoreOutcome("restored",true,false,foreground,identities,unchanged,keys));
            return QtFocusRestoreReport(report,lease,true);
        }catch(Exception error){error.Data["QtFocusRestoreOutcome"]=QtRestoreOutcome(stage,restored,false,foreground,identities,unchanged,keys);QtMarkFocusTimingFailure(error,lease);throw;}finally{QtCurrent=null;}
    }
    static void QtFocusTransitionGuard(QtFocusLease lease,long revision,bool restoring){
        if(!restoring)Need(!Stopping,"QT_STOPPING");QtTransferredGuard(lease);Need(Interlocked.Read(ref Revision)==revision,"QT_HUMAN_ACTIVITY_CHANGED");NoKeysHeld();
        Need(QtSameFocus(lease.Return,QtFocusWindow(lease.Return.Window))&&QtSameFocus(lease.Wechat,QtFocusWindow(lease.Wechat.Window,QtExecutable,restoring)),"QT_FOCUS_TARGET_CHANGED");
        if(lease.ReturnCaption!=null)QtCaptionSourceReady(lease,lease.ReturnCaption);
        QtTransferredGuard(lease);Need(Interlocked.Read(ref Revision)==revision,"QT_HUMAN_ACTIVITY_CHANGED");NoKeysHeld();
    }

    static object QtFocusVisibilityFailure(Exception error){return error.Data.Contains("QtFocusVisibility")?error.Data["QtFocusVisibility"]:null;}
    static FocusVisibilityObservation QtConfirmVisibilityOnce(Action guard,Func<int> blocking,Func<bool> raise,Func<long> clock,Action<int> wait,bool priorRaise=false,bool? priorAccepted=null){return FocusConfirmVisibilityOnce(guard,blocking,raise,clock,wait,priorRaise,priorAccepted,"QtFocusVisibility");}
    static bool QtRaiseGuiClear(uint flags,IntPtr capture){return (flags&0x1e)==0&&capture==IntPtr.Zero;}
    static bool QtRaiseBindingMatches(Binding before,Binding actual,uint originalThread,Rect window,Rect currentWindow){return originalThread!=0&&actual.Thread==originalThread&&before.Thread==actual.Thread&&QtSameBinding(before,actual)&&Same(window,currentWindow);}
    static void QtMarkTargetRaise(QtFocusLease lease){Need(lease!=null&&!lease.TargetRaiseAttempted,"QT_FOCUS_RAISE_ALREADY_ATTEMPTED");lease.TargetRaiseAttempted=true;}
    static object QtAfterActivationReady(bool uia,Action controlGuard,Func<object> visibility){
        // A UIA operation does not need every pixel of the window exposed.
        // Null means visibility was not sampled, never a fabricated zero count.
        if(uia){controlGuard();return null;}return visibility();
    }
    static bool QtUiaActivatedBinding(Binding expected,Binding actual){return expected!=null&&actual!=null&&actual.Thread==expected.Thread&&QtSameBinding(expected,actual)&&actual.FocusOwned&&(actual.GuiFlags&0x1e)==0;}
    static void QtEnsureUiaTargetFocus(QtFocusLease lease,Binding bound){
        Need(lease!=null&&lease.UiaMode&&Object.ReferenceEquals(QtLease,lease)&&QtEnableInput&&QtSurface=="main"&&QtPopup==null&&QtPendingPopup==null,"QT_FOCUS_TARGET_CHANGED");
        QtFocusTransitionGuard(lease,lease.Revision,false);var actual=Snapshot(lease.Wechat.Window,QtExecutable);
        Need(QtUiaActivatedBinding(bound,actual),"QT_FOCUS_UNAVAILABLE");
        QtFocusTransitionGuard(lease,lease.Revision,false);Need(GetForegroundWindow()==lease.Wechat.Window,"QT_FOCUS_TARGET_CHANGED");
    }
    static object QtEnsureTargetVisible(QtFocusLease lease,Binding bound,FocusConfirmation confirmation){
        long revision=lease.Revision;Rect desktop=QtDesktopRect(),window=new Rect();Need(lease.ReturnCaption!=null&&GetWindowRect(lease.Wechat.Window,out window),"QT_FOCUS_TARGET_CHANGED");var activation=Map(confirmation.Activation);bool priorRaise=Object.Equals(Get(activation,"calibratedRaiseAttempted"),true);bool? priorAccepted=priorRaise?(bool?)Object.Equals(Get(activation,"calibratedRaiseAccepted"),true):null;if(priorRaise)QtMarkTargetRaise(lease);
        Action guard=delegate{
            Need(QtLease==lease&&QtEnableInput&&QtSurface=="main"&&QtPopup==null&&QtPendingPopup==null,"QT_FOCUS_TARGET_CHANGED");QtFocusTransitionGuard(lease,revision,false);
            Need(GetForegroundWindow()==lease.Wechat.Window&&GetWindow(lease.Wechat.Window,4)==IntPtr.Zero&&GetAncestor(lease.Wechat.Window,3)==lease.Wechat.Window&&(GetWindowLongPtr(lease.Wechat.Window,-20).ToInt64()&8)==0,"QT_FOCUS_TARGET_CHANGED");
            Binding actual=Snapshot(lease.Wechat.Window,QtExecutable);Rect currentWindow;Need(GetWindowRect(lease.Wechat.Window,out currentWindow)&&QtRaiseBindingMatches(bound,actual,lease.ReturnCaption.SourceThread,window,currentWindow)&&actual.FocusOwned&&Same(desktop,QtDesktopRect()),"QT_BINDING_CHANGED");
            var displays=new List<Rect>();foreach(Screen screen in Screen.AllScreens){Rectangle area=screen.Bounds;displays.Add(new Rect(area.Left,area.Top,area.Right,area.Bottom));}Need(QtCoveredByDisplays(actual.Capture,displays),"QT_WINDOW_OUTSIDE_DISPLAY");
            uint returnPid;uint returnThread=GetWindowThreadProcessId(lease.Return.Window,out returnPid);Need(lease.ReturnCaption!=null&&returnThread==lease.ReturnCaption.Thread&&returnPid==lease.Return.Pid,"QT_FOCUS_TARGET_CHANGED");
            foreach(uint thread in new[]{actual.Thread,returnThread}){FocusThreadReady(thread);var gui=new GuiInfo{Size=(uint)Marshal.SizeOf(typeof(GuiInfo))};Need(GetGUIThreadInfo(thread,ref gui)&&QtRaiseGuiClear(gui.Flags,gui.Capture),"QT_FOCUS_UNAVAILABLE");}
            QtFocusTransitionGuard(lease,revision,false);Need(GetForegroundWindow()==lease.Wechat.Window,"QT_FOCUS_TARGET_CHANGED");
        };
        var result=QtConfirmVisibilityOnce(guard,delegate{return checked((int)Number(Get(QtOverlapReport(bound),"blockingCount")));},delegate{QtMarkTargetRaise(lease);return FocusSetWindowPos(lease.Wechat.Window,IntPtr.Zero,0,0,0,0,0x4213);},Now,Thread.Sleep,priorRaise,priorAccepted);
        if(!result.Confirmed){var error=new Fault("QT_WINDOW_OBSCURED");error.Data["QtFocusVisibility"]=result.Report();throw error;}return result.Report();
    }
    static int QtFocusVisibilitySelfTest(){
        int count=0,raises=0,samples=0,guards=0;long clock=0;Action guard=delegate{guards++;};Action<int> wait=delegate(int ms){clock+=ms;};Func<bool> raise=delegate{raises++;return true;};
        var source=new QtFocusIdentity{Window=new IntPtr(1),Pid=10,Created=100};var main=new QtFocusIdentity{Window=new IntPtr(2),Pid=20,Created=200};
        var other=new QtFocusIdentity{Window=new IntPtr(3),Pid=30,Created=300};var auxiliary=new QtFocusIdentity{Window=new IntPtr(4),Pid=20,Created=200};var expected=new QtFocusLease{Return=source,Wechat=main};
        QtCheckFocusPair(expected,source,main);Expect(delegate{QtCheckFocusPair(expected,other,main);},"QT_FOCUS_TARGET_CHANGED");
        Expect(delegate{QtCheckFocusPair(expected,source,new QtFocusIdentity{Window=main.Window,Pid=main.Pid,Created=999});},"QT_FOCUS_TARGET_CHANGED");
        Expect(delegate{QtCheckFocusPair(null,main,main);},"QT_FOCUS_RETURN_WINDOW_REQUIRED");Expect(delegate{QtCheckFocusPair(null,auxiliary,main);},"QT_FOCUS_WECHAT_AUXILIARY_ACTIVE");count+=5;
        Func<IntPtr,uint> pid=delegate(IntPtr w){return w==other.Window?other.Pid:main.Pid;};
        Need(QtOwnedPopupChain(auxiliary.Window,main.Window,main.Pid,pid,delegate{return main.Window;})
            &&!QtOwnedPopupChain(other.Window,main.Window,main.Pid,pid,delegate{return main.Window;})
            &&!QtOwnedPopupChain(auxiliary.Window,main.Window,main.Pid,pid,delegate(IntPtr w){return w==auxiliary.Window?other.Window:main.Window;}),"QT_TEST_RETURN_ONLY_FROM_OWN_PROCESS_POPUP_CHAIN");count++;
        var result=QtConfirmVisibilityOnce(guard,delegate{samples++;return 0;},raise,delegate{return clock;},wait);Need(result.Confirmed&&!result.RaiseAttempted&&raises==0&&samples==1&&guards==2&&result.Reason=="already-visible","QT_TEST_VISIBLE_TARGET_NEVER_RAISED");count++;
        raises=samples=guards=0;clock=0;result=QtConfirmVisibilityOnce(guard,delegate{return ++samples<3?2:0;},raise,delegate{return clock;},wait);Need(result.Confirmed&&result.RaiseAttempted&&result.RequestAccepted==true&&raises==1&&samples==3&&clock==10,"QT_TEST_RAISE_ONCE_THEN_FULL_OVERLAP_RECHECK");count++;
        raises=samples=guards=0;clock=0;result=QtConfirmVisibilityOnce(guard,delegate{return ++samples==1?1:0;},delegate{raises++;return false;},delegate{return clock;},wait);Need(result.Confirmed&&result.RequestAccepted==false&&raises==1&&result.LastBlockingCount==0,"QT_TEST_FALSE_RAISE_REQUIRES_ACTUAL_VISIBLE_STATE");count++;
        raises=samples=guards=0;clock=0;result=QtConfirmVisibilityOnce(guard,delegate{samples++;return 2;},delegate{raises++;return false;},delegate{return clock;},wait);Need(!result.Confirmed&&raises==1&&clock==250&&result.Reason=="timeout"&&result.LastBlockingCount==2,"QT_TEST_BLOCKED_RAISE_STOPS_WITHOUT_RETRY");count++;
        raises=guards=0;clock=0;Expect(delegate{QtConfirmVisibilityOnce(delegate{if(++guards==3)throw new Fault("QT_HUMAN_ACTIVITY_CHANGED");},delegate{return 1;},raise,delegate{return clock;},wait);},"QT_HUMAN_ACTIVITY_CHANGED");Need(raises==0,"QT_TEST_ACTIVITY_BEFORE_RAISE_PREVENTS_REQUEST");count++;
        raises=guards=0;clock=0;Expect(delegate{QtConfirmVisibilityOnce(delegate{if(++guards==4)throw new Fault("QT_HUMAN_ACTIVITY_CHANGED");},delegate{return 1;},raise,delegate{return clock;},wait);},"QT_HUMAN_ACTIVITY_CHANGED");Need(raises==1,"QT_TEST_ACTIVITY_AFTER_RAISE_STOPS_READINESS_WITHOUT_RETRY");count++;
        raises=samples=guards=0;clock=0;result=QtConfirmVisibilityOnce(delegate{if(++guards==5)clock=251;},delegate{return ++samples==1?1:0;},raise,delegate{return clock;},wait);Need(!result.Confirmed&&raises==1&&result.Reason=="timeout","QT_TEST_SLOW_FINAL_GUARD_CANNOT_CONFIRM_LATE_VISIBILITY");count++;
        raises=samples=guards=0;clock=0;result=QtConfirmVisibilityOnce(guard,delegate{return ++samples<3?1:0;},raise,delegate{return clock;},wait,true,true);Need(result.Confirmed&&result.RaiseAttempted&&result.RequestAccepted==true&&raises==0&&samples==3,"QT_TEST_COMMON_CALIBRATED_RAISE_IS_NOT_REPEATED_BY_QT");count++;
        var lease=new QtFocusLease();QtMarkTargetRaise(lease);Expect(delegate{QtMarkTargetRaise(lease);},"QT_FOCUS_RAISE_ALREADY_ATTEMPTED");Need(lease.TargetRaiseAttempted,"QT_TEST_TARGET_RAISE_LATCH");count++;
        Need(QtRaiseGuiClear(0,IntPtr.Zero)&&!QtRaiseGuiClear(4,IntPtr.Zero)&&!QtRaiseGuiClear(0,new IntPtr(1)),"QT_TEST_RAISE_REFUSES_MODAL_OR_MOUSE_CAPTURE");count++;
        var original=new Binding{Window=new IntPtr(1),Pid=2,Created=3,Thread=4,Dpi=120,Client=new Rect(0,0,800,600),Capture=new Rect(100,100,900,700)};var current=new Binding{Window=original.Window,Pid=original.Pid,Created=original.Created,Thread=4,Dpi=120,Client=original.Client,Capture=original.Capture};Rect window=new Rect(90,90,910,710);Need(QtRaiseBindingMatches(original,current,4,window,window)&&!QtRaiseBindingMatches(original,current,5,window,window)&&!QtRaiseBindingMatches(original,current,4,window,new Rect(89,90,910,710)),"QT_TEST_RAISE_ORIGINAL_THREAD_AND_OUTER_GEOMETRY_FROZEN");count++;
        int controlGuards=0,visibilityCalls=0;object observation=new object();Need(QtAfterActivationReady(true,delegate{controlGuards++;},delegate{visibilityCalls++;return observation;})==null&&controlGuards==1&&visibilityCalls==0,"QT_TEST_UIA_ACTIVATION_NO_VISIBILITY_QUERY_OR_CLAIM");count++;
        Need(Object.ReferenceEquals(QtAfterActivationReady(false,delegate{controlGuards++;},delegate{visibilityCalls++;return observation;}),observation)&&controlGuards==1&&visibilityCalls==1,"QT_TEST_PIXEL_ACTIVATION_KEEPS_VISIBILITY_PATH");count++;
        Expect(delegate{QtAfterActivationReady(true,delegate{throw new Fault("QT_HUMAN_ACTIVITY_CHANGED");},delegate{visibilityCalls++;return observation;});},"QT_HUMAN_ACTIVITY_CHANGED");Need(visibilityCalls==1,"QT_TEST_UIA_ACTIVATION_GUARD_FAILURE_NO_FALLBACK");count++;
        original.FocusOwned=true;current.FocusOwned=true;Need(QtUiaActivatedBinding(original,current),"QT_TEST_UIA_ACTIVATION_BOUND_FOCUS");count++;current.FocusOwned=false;Need(!QtUiaActivatedBinding(original,current),"QT_TEST_UIA_ACTIVATION_OWNED_FOCUS_REQUIRED");current.FocusOwned=true;current.GuiFlags=4;Need(!QtUiaActivatedBinding(original,current),"QT_TEST_UIA_ACTIVATION_MODAL_REFUSED");current.GuiFlags=0;current.Thread++;Need(!QtUiaActivatedBinding(original,current),"QT_TEST_UIA_ACTIVATION_THREAD_BOUND");count+=3;
        return count;
    }
    static object QtBeginFocus(Dictionary<string,object> request,long? requiredRevision=null,bool allowOverlappedReturn=false,QtFocusLease expected=null){
        bool uiaCaption=QtUiaCaptionRequested(request);
        Need(QtEnableInput&&!Stopping&&QtLease==null&&QtParkedLease==null,"QT_FOCUS_LEASE_UNAVAILABLE");long idle=Number(Get(request,"idleMs"));Need(idle>=1000&&idle<=300000,"QT_IDLE_INVALID");
        long revision=QtBeginActivityRevision(requiredRevision,Interlocked.Read(ref Revision)),end=Now()+idle;while(Now()-Interlocked.Read(ref LastActivity)<idle){Need(!Stopping&&revision==Interlocked.Read(ref Revision),"QT_USER_ACTIVE");Need(Now()<=end,"QT_USER_ACTIVE");Thread.Sleep(10);}NoKeysHeld();
        QtFocusIdentity prior=QtFocusWindow(GetForegroundWindow());
        int width=checked((int)Number(Get(request,"width"))),height=checked((int)Number(Get(request,"height"))),dpi=checked((int)Number(Get(request,"dpi")));
        QtFocusIdentity target=QtHandoffTarget(width,height,dpi);
        QtCheckFocusPair(expected,prior,target);
        Need(GetForegroundWindow()==prior.Window&&revision==Interlocked.Read(ref Revision),"QT_HUMAN_ACTIVITY_CHANGED");NoKeysHeld();
        Point originalPointer;Need(FocusGetCursorPos(out originalPointer),"QT_POINTER_UNAVAILABLE");
        Need(GetForegroundWindow()==prior.Window&&revision==Interlocked.Read(ref Revision),"QT_HUMAN_ACTIVITY_CHANGED");NoKeysHeld();
        if(request.ContainsKey("includesContactNavigation"))Need(Get(request,"includesContactNavigation") is bool,"QT_FOCUS_LEASE_INVALID");
        var candidateLease=new QtFocusLease{Return=prior,Wechat=target,Revision=revision,UiaMode=uiaCaption,Activation=ParseFocusActivation(Get(request,"focusActivation"),width),OriginalPointer=originalPointer,PointerSaved=true,IncludesContactNavigation=Object.Equals(Get(request,"includesContactNavigation"),true),AllowOverlappedReturn=allowOverlappedReturn};
        // Obtain a safe return capability while the user's window is still
        // foreground. Unsupported/fullscreen windows do not borrow focus.
        candidateLease.ReturnCaption=QtCaptureReturnCaption(candidateLease,revision);candidateLease.ForegroundStarted=Now();QtLease=candidateLease;
        try{var confirmation=ConfirmFocusOnce(prior.Window,target.Window,delegate{return uiaCaption?QtActivateUiaCaptionOnce(QtLease):ActivateForegroundOnce(prior.Window,target.Window,delegate{QtFocusTransitionGuard(QtLease,revision,false);},QtLease.Activation);},delegate{QtFocusTransitionGuard(QtLease,revision,false);},GetForegroundWindow,Now,Thread.Sleep);NeedFocusConfirmed(confirmation,"QT_FOCUS_ACQUIRE_UNCONFIRMED");Need(revision==Interlocked.Read(ref Revision),"QT_HUMAN_ACTIVITY_CHANGED");
            Binding bound=Snapshot(target.Window,QtExecutable);Need(bound.Pid==target.Pid&&bound.Created==target.Created&&bound.Client.Width==width&&bound.Client.Height==height&&bound.Dpi==dpi,"QT_FOCUS_TARGET_CHANGED");object visibility=QtAfterActivationReady(uiaCaption,delegate{QtEnsureUiaTargetFocus(QtLease,bound);},delegate{return QtEnsureTargetVisible(QtLease,bound,confirmation);});
            QtWindow=target.Window;QtRootWindow=target.Window;QtRootPid=target.Pid;QtRootCreated=target.Created;QtCurrent=null;
            return Data("focusHandoff",QtLease.Handoff(),"activated",true,"focusConfirmation",confirmation.Report(),"focusVisibility",visibility);
        }catch(Exception error){QtFocusLease lease=QtLease;QtLease=null;
            try{var restored=Map(QtRestoreFocus(lease,revision==Interlocked.Read(ref Revision)));if(Get(restored,"focusRestoreOutcome")!=null)error.Data["QtFocusRestoreOutcome"]=Get(restored,"focusRestoreOutcome");}
            catch(Exception cleanupError){var outcome=QtFocusRestoreFailure(cleanupError);if(outcome!=null)error.Data["QtFocusRestoreOutcome"]=outcome;}
            QtMarkFocusTimingFailure(error,lease);throw;}
    }
    static object QtParkFocus(){
        Need(QtEnableInput&&!Stopping&&QtLease!=null&&QtParkedLease==null&&QtSurface=="main"&&QtPopup==null&&QtPendingPopup==null,"QT_FOCUS_PARK_UNAVAILABLE");var lease=QtLease;
        QtFocusTransitionGuard(lease,lease.Revision,false);Need(GetForegroundWindow()==lease.Wechat.Window,"QT_FOCUS_TARGET_CHANGED");var binding=Snapshot(lease.Wechat.Window,QtExecutable);
        var report=Map(QtRestoreFocus(lease,lease.Revision==Interlocked.Read(ref Revision)));QtLease=null;
        bool? parkRevision=Object.Equals(Get(report,"restored"),true)?(bool?)(lease.Revision==Interlocked.Read(ref Revision)):null;QtNeedParkRestored(report,parkRevision);QtParkedLease=lease;QtParkedBinding=binding;QtParkedAt=Now();report.Add("parked",true);return report;
    }
    static object QtResumeFocus(Dictionary<string,object> request){
        Need(QtEnableInput&&!Stopping&&QtLease==null&&QtParkedLease!=null,"QT_FOCUS_PARK_UNAVAILABLE");var previous=QtParkedLease;var binding=QtParkedBinding;
        Need(Now()-QtParkedAt<=30000&&previous.Revision==Interlocked.Read(ref Revision),"QT_HUMAN_ACTIVITY_CHANGED");QtFocusTransitionGuard(previous,previous.Revision,false);Need(GetForegroundWindow()==previous.Return.Window,"QT_FOCUS_TARGET_CHANGED");
        Rect client;Point origin=new Point(0,0);Need(GetClientRect(previous.Wechat.Window,out client)&&ClientToScreen(previous.Wechat.Window,ref origin)&&Same(client,binding.Client)&&origin.X==binding.Capture.Left&&origin.Y==binding.Capture.Top&&GetDpiForWindow(previous.Wechat.Window)==binding.Dpi,"QT_BINDING_CHANGED");
        var begin=Data("idleMs",1000,"width",binding.Client.Width,"height",binding.Client.Height,"dpi",binding.Dpi,"includesContactNavigation",Object.Equals(Get(request,"includesContactNavigation"),true));if(previous.UiaMode)begin.Add("uiaCaptionActivation",true);else if(previous.Activation!=null)begin.Add("focusActivation",previous.Activation.Report());
        QtParkedLease=null;QtParkedBinding=null;var result=Map(QtBeginFocus(begin,previous.Revision,false,previous));result.Add("resumed",true);return result;
    }
    static object QtTransferFocus(){QtEmptyPhaseProof=null;Need(QtLease!=null&&QtEnableInput&&!Stopping,"QT_FOCUS_LEASE_UNAVAILABLE");QtFocusLease lease=QtLease;Need(GetForegroundWindow()==lease.Wechat.Window&&lease.Revision==Interlocked.Read(ref Revision),"QT_HUMAN_ACTIVITY_CHANGED");NoKeysHeld();
        Need(QtSameFocus(lease.Return,QtFocusWindow(lease.Return.Window))&&QtSameFocus(lease.Wechat,QtFocusWindow(lease.Wechat.Window,QtExecutable)),"QT_FOCUS_TARGET_CHANGED");
        // Finish Qt's mouse ownership before passing the existing window-only
        // lease to another process; no cursor state is trusted across helpers.
        bool pointerRestored=QtRestorePointer(lease,lease.Wechat.Window);QtFocusTransitionGuard(lease,lease.Revision,false);Need(GetForegroundWindow()==lease.Wechat.Window,"QT_FOCUS_TARGET_CHANGED");
        uint finalInputTick=QtInputTick();QtFocusTransitionGuard(lease,lease.Revision,false);Need(GetForegroundWindow()==lease.Wechat.Window,"QT_FOCUS_TARGET_CHANGED");
        object cleanup=Data("version",1,"returnWindow",lease.Return.Report(),"wechatWindow",lease.Wechat.Report(),"lastInputTick",finalInputTick,"issuedAtMs",UtcMs());QtLease=null;
        return Data("focusHandoff",lease.Handoff(),"cleanup",cleanup,"transferred",true,"pointerRestored",pointerRestored,"revision",lease.Revision);
    }
    static object QtRestoreTransferred(Dictionary<string,object> request){long revision=Interlocked.Read(ref Revision);Need(QtEnableInput&&QtLease==null,"QT_FOCUS_LEASE_UNAVAILABLE");var token=Map(Get(request,"cleanup"));Need(token!=null&&token.Count==5&&Number(Get(token,"version"))==1,"QT_FOCUS_LEASE_INVALID");
        long issued=Number(Get(token,"issuedAtMs"));Need(QtTransferredFresh(issued,UtcMs()),"QT_FOCUS_LEASE_EXPIRED");
        var lease=new QtFocusLease{Return=QtParseFocus(Get(token,"returnWindow")),Wechat=QtParseFocus(Get(token,"wechatWindow")),Revision=revision,TransferredInputTick=Number(Get(token,"lastInputTick")),TransferredIssuedAt=issued};Need(lease.Return.Pid!=lease.Wechat.Pid,"QT_FOCUS_LEASE_INVALID");
        // A replacement helper has no click history or caption capability.
        // Observe one full double-click interval without input before allowing
        // a freshly measured, visible return caption as the denied-API fallback.
        if(GetForegroundWindow()==lease.Wechat.Window&&QtKeysReleased()&&QtTransferredUnchanged(lease.TransferredInputTick.Value,QtInputTick(),revision,Interlocked.Read(ref Revision)))QtWarmTransferredCaption(lease,revision);
        return QtRestoreFocus(lease,QtTransferredUnchanged(Number(Get(token,"lastInputTick")),QtInputTick(),revision,Interlocked.Read(ref Revision)));
    }
    static string QtHash(byte[] bytes) { using(var sha=SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-","").ToLowerInvariant(); }
    static void QtRgbaRow(byte[] bgra,byte[] rgba,int offset){for(int source=0;source<bgra.Length;source+=4){rgba[offset++]=bgra[source+2];rgba[offset++]=bgra[source+1];rgba[offset++]=bgra[source];rgba[offset++]=255;}}
    static byte[] QtPixels(Binding binding,Rect region) {
        Need(Contains(binding.Client,region)&&region.Width<=4096&&region.Height<=4096,"QT_REGION_INVALID");
        using(var bitmap=new Bitmap(region.Width,region.Height,PixelFormat.Format32bppArgb)) {
            using(var graphic=Graphics.FromImage(bitmap)) graphic.CopyFromScreen(binding.Capture.Left+region.Left,binding.Capture.Top+region.Top,0,0,new Size(region.Width,region.Height),CopyPixelOperation.SourceCopy);
            var bits=bitmap.LockBits(new Rectangle(0,0,bitmap.Width,bitmap.Height),ImageLockMode.ReadOnly,PixelFormat.Format32bppArgb);
            try { byte[] bytes=new byte[checked(region.Width*region.Height*4)],rowBytes=new byte[region.Width*4]; for(int row=0;row<region.Height;row++){Marshal.Copy(IntPtr.Add(bits.Scan0,row*bits.Stride),rowBytes,0,rowBytes.Length);QtRgbaRow(rowBytes,bytes,row*rowBytes.Length);}return bytes; }
            finally { bitmap.UnlockBits(bits); }
        }
    }
    static bool QtSameBinding(Binding a,Binding b) { return a.Window==b.Window&&a.Pid==b.Pid&&a.Created==b.Created&&a.Dpi==b.Dpi&&Same(a.Client,b.Client)&&Same(a.Capture,b.Capture)&&a.Focus==b.Focus; }
    static void QtNeedAnchorPixels(string expected,string actual,string stage,int index){if(expected!=actual){var error=new Fault("QT_PIXELS_CHANGED");error.Data["QtPixelMismatch"]=Data("stage",stage,"anchorIndex",index);throw error;}}
    static object QtPixelMismatch(Exception error){return error.Data.Contains("QtPixelMismatch")?error.Data["QtPixelMismatch"]:null;}
    delegate bool QtEnumWindow(IntPtr hwnd,IntPtr value);
    [DllImport("user32.dll")] static extern bool EnumWindows(QtEnumWindow callback,IntPtr value);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd,out Rect rect);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd,uint command);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd,StringBuilder name,int maximum);
    [DllImport("user32.dll",EntryPoint="GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr(IntPtr hwnd,int index);
    [DllImport("user32.dll")] static extern bool GetLayeredWindowAttributes(IntPtr hwnd,out uint colorKey,out byte alpha,out uint flags);
    static bool QtOwnedPopupChain(IntPtr window,IntPtr root,uint pid,Func<IntPtr,uint> process,Func<IntPtr,IntPtr> owner){
        for(int depth=0;window!=IntPtr.Zero&&depth<16;depth++){if(pid==0||process(window)!=pid)return false;if(window==root)return true;window=owner(window);}return false;
    }
    static bool QtOwnedPopup(IntPtr window,IntPtr root) {
        uint pid;GetWindowThreadProcessId(root,out pid);
        return QtOwnedPopupChain(window,root,pid,delegate(IntPtr w){uint p;GetWindowThreadProcessId(w,out p);return p;},delegate(IntPtr w){return GetWindow(w,4);});
    }
    static QtPopupCalibration QtParsePopupCalibration(object value,bool observed=false) {
        var data=Map(value);Need(data!=null&&data.Count==(observed?7:data.ContainsKey("heightVariants")||data.ContainsKey("heightRange")?11:10)&&Number(Get(data,"version"))==1,"QT_POPUP_CALIBRATION_INVALID");
        string kind=Text(data,"kind"),name=Text(data,"className"),relation=Text(data,"ownerRelation");
        Need((kind=="profile"||kind=="search")&&!String.IsNullOrEmpty(name)&&name.Length<=256&&name.IndexOf('\0')<0&&name.IndexOf('\r')<0&&name.IndexOf('\n')<0,"QT_POPUP_CALIBRATION_INVALID");
        long depth=Number(Get(data,"ownerDepth")),style=Number(Get(data,"style")),extended=Number(Get(data,"extendedStyle"));
        Need((relation=="root-owned"&&depth>=1&&depth<=16||relation=="same-thread-unowned"&&depth==0)&&style>=Int32.MinValue&&style<=UInt32.MaxValue&&extended>=Int32.MinValue&&extended<=UInt32.MaxValue,"QT_POPUP_CALIBRATION_INVALID");
        if(observed)return new QtPopupCalibration{Kind=kind,ClassName=name,OwnerRelation=relation,OwnerDepth=(int)depth,Style=style,ExtendedStyle=extended};
        long width=Number(Get(data,"clientWidth")),height=Number(Get(data,"clientHeight"));Need(width>=20&&width<=4096&&height>=20&&height<=4096,"QT_POPUP_CALIBRATION_INVALID");
        Rect region=ParseRect(Get(data,"windowRect"));Need(region.Width<=4096&&region.Height<=4096,"QT_POPUP_CALIBRATION_INVALID");
        var result=new QtPopupCalibration{Kind=kind,ClassName=name,OwnerRelation=relation,OwnerDepth=(int)depth,RelativeWindow=region,ClientWidth=(int)width,ClientHeight=(int)height,Style=style,ExtendedStyle=extended};
        if(data.ContainsKey("heightVariants")){var values=Get(data,"heightVariants") as object[];Need(kind=="search"&&region.Height==height&&values!=null&&values.Length>=1&&values.Length<=4,"QT_POPUP_CALIBRATION_INVALID");foreach(var item in values){long h=Number(item);Need(h>=20&&h<=4096&&result.HeightVariants.Add((int)h),"QT_POPUP_CALIBRATION_INVALID");}}
        if(data.ContainsKey("heightRange")){var range=Map(Get(data,"heightRange"));Need(kind=="search"&&region.Height==height&&range!=null&&range.Count==2,"QT_POPUP_CALIBRATION_INVALID");long min=Number(Get(range,"min")),max=Number(Get(range,"max"));Need(min>=20&&max<=4096&&min<=height&&max>=height,"QT_POPUP_CALIBRATION_INVALID");result.MinHeight=(int)min;result.MaxHeight=(int)max;}
        return result;
    }
    // A virtual desktop rectangle includes gaps between monitors. Subtract
    // actual monitor coverage rather than accepting a clipped popup in a gap.
    static bool QtCoveredByDisplays(Rect area,List<Rect> displays){return FocusCoveredByDisplays(area,displays);}
    // The UIA search surface is read as metadata and receives guarded keyboard
    // input. It does not need monitor pixels. This capability is minted only by
    // the native UIA navigation frame; caller-supplied geometry cannot enable it.
    static bool QtPopupUsesUiaSearch(QtFrame frame,QtFocusLease lease,bool observed,string id,QtPopupCalibration calibration){return observed&&id=="search"&&calibration!=null&&calibration.Kind=="search"&&frame!=null&&frame.MetadataOnly&&frame.NavigationOnly&&lease!=null&&lease.UiaMode&&QtNavigationLeaseMatches(frame,lease);}
    static bool QtPopupMetadataSearch(QtPopupLease lease){return lease!=null&&lease.UiaSearch&&lease.Observed&&lease.Id=="search"&&lease.Calibration!=null&&lease.Calibration.Kind=="search";}
    static bool QtPopupDisplayAllowed(QtPopupLease lease,Rect bounds,List<Rect> displays){return QtPopupMetadataSearch(lease)||QtCoveredByDisplays(bounds,displays);}
    static void QtPopupObservationPause(QtPopupLease lease,Action<int> wait){if(!QtPopupMetadataSearch(lease))wait(35);}
    static List<Rect> QtPopupDisplays(){var displays=new List<Rect>();foreach(Screen screen in Screen.AllScreens){Rectangle b=screen.Bounds;displays.Add(new Rect(b.Left,b.Top,b.Right,b.Bottom));}return displays;}
    static bool QtPopupOutsideDisplays(Rect root,List<Rect> displays){if(displays.Count==0)return false;foreach(Rect display in displays)if(Intersects(root,display))return false;return true;}
    static bool QtPopupOffscreenScope(QtPopupLease lease,bool rootOutside,bool popupOutside){return QtPopupMetadataSearch(lease)&&rootOutside&&popupOutside&&lease.Calibration.ClassName=="Qt51514QWindowToolSaveBits"&&lease.Calibration.OwnerRelation=="root-owned"&&lease.Calibration.OwnerDepth==1;}
    static bool QtPopupOffscreenSearch(QtPopupLease lease,Rect bounds){var displays=QtPopupDisplays();return QtPopupOffscreenScope(lease,QtPopupOutsideDisplays(lease.Root.Capture,displays),QtPopupOutsideDisplays(bounds,displays));}
    static bool QtPopupShapeAllowed(Rect bounds,Rect client,Rect clientScreen){return client.Left==0&&client.Top==0&&client.Width>=20&&client.Height>=20&&client.Width<=4096&&client.Height<=4096&&(long)client.Width*client.Height<=12000000&&bounds.Width>=client.Width&&bounds.Height>=client.Height&&bounds.Width<=4096&&bounds.Height<=4096&&Contains(bounds,clientScreen);}
    static bool QtPopupGeometryAllowed(Rect bounds,Rect client,Rect clientScreen,QtPopupLease lease,bool offscreenSearch=false){
        if(!QtPopupShapeAllowed(bounds,client,clientScreen))return false;
        // An offscreen result list may follow Qt's own positioning outside its
        // parent's client. No pointer or pixel operation uses that rectangle:
        // the UIA query field remains inside the unchanged main window.
        if(offscreenSearch){if(!QtPopupMetadataSearch(lease)||bounds.Width>lease.Root.Client.Width||bounds.Height>lease.Root.Client.Height)return false;}
        else if(lease.Calibration.Kind=="search"&&!Contains(lease.Root.Capture,bounds))return false;
        if(lease.Window==IntPtr.Zero)return true;
        if(lease.Calibration.Kind=="profile")return Same(bounds,lease.ObservedBounds)&&Same(client,lease.ObservedClient)&&Same(clientScreen,lease.ObservedClientScreen);
        if(offscreenSearch)return bounds.Width==lease.ObservedBounds.Width&&client.Width==lease.ObservedClient.Width&&
            clientScreen.Left-bounds.Left==lease.ObservedClientScreen.Left-lease.ObservedBounds.Left&&clientScreen.Top-bounds.Top==lease.ObservedClientScreen.Top-lease.ObservedBounds.Top&&
            bounds.Right-clientScreen.Right==lease.ObservedBounds.Right-lease.ObservedClientScreen.Right&&bounds.Bottom-clientScreen.Bottom==lease.ObservedBounds.Bottom-lease.ObservedClientScreen.Bottom;
        // Search result height may change as the query resolves. Position,
        // width, client origin and non-client margins remain the same.
        return bounds.Left==lease.ObservedBounds.Left&&bounds.Top==lease.ObservedBounds.Top&&bounds.Right==lease.ObservedBounds.Right&&client.Width==lease.ObservedClient.Width&&clientScreen.Left==lease.ObservedClientScreen.Left&&clientScreen.Top==lease.ObservedClientScreen.Top&&bounds.Bottom-clientScreen.Bottom==lease.ObservedBounds.Bottom-lease.ObservedClientScreen.Bottom;
    }
    static Rect QtPopupClientInRoot(QtPopupLease lease){Rect client;Point origin=new Point(0,0);Need(GetClientRect(lease.Window,out client)&&ClientToScreen(lease.Window,ref origin),"QT_POPUP_GEOMETRY_UNAVAILABLE");return new Rect(origin.X-lease.Root.Capture.Left,origin.Y-lease.Root.Capture.Top,origin.X-lease.Root.Capture.Left+client.Width,origin.Y-lease.Root.Capture.Top+client.Height);}
    static bool QtPopupSurface(string surface){return surface=="calibrated-profile"||surface=="calibrated-search"||surface=="observed-profile"||surface=="observed-search";}
    static bool QtSearchSurface(string surface){return surface=="calibrated-search"||surface=="observed-search";}
    static bool QtPopupCausalEligible(bool sameProcess,bool sameThread,bool relation,bool exactGeometry,bool exactClass,bool exactStyle,bool visibleBefore,bool stable) {
        return sameProcess&&sameThread&&relation&&exactGeometry&&exactClass&&exactStyle&&!visibleBefore&&stable;
    }
    static bool QtPopupOwnerMatches(IntPtr candidate,QtPopupLease lease) {
        if(lease.Calibration.OwnerRelation=="same-thread-unowned")return GetWindow(candidate,4)==IntPtr.Zero&&GetAncestor(candidate,3)==candidate;
        IntPtr current=candidate;int depth=0;var visited=new HashSet<IntPtr>();
        while(current!=IntPtr.Zero&&current!=lease.Root.Window&&depth<=16&&visited.Add(current)) {uint pid;Need(GetWindowThreadProcessId(current,out pid)==lease.Root.Thread&&pid==lease.Root.Pid,"QT_POPUP_OWNER_CHANGED");current=GetWindow(current,4);depth++;}
        return current==lease.Root.Window&&depth==lease.Calibration.OwnerDepth;
    }
    static void QtPopupRootStable(QtPopupLease lease) {
        Need(lease!=null&&!Stopping&&lease.Revision==Interlocked.Read(ref Revision),"QT_HUMAN_ACTIVITY_CHANGED");
        var identity=QtFocusWindow(lease.Root.Window,QtExecutable,true);Need(identity.Pid==lease.Root.Pid&&identity.Created==lease.Root.Created,"QT_POPUP_PROCESS_CHANGED");
        Rect client;Point origin=new Point(0,0);uint pid;
        Need(GetClientRect(lease.Root.Window,out client)&&ClientToScreen(lease.Root.Window,ref origin)&&Same(client,lease.Root.Client)&&origin.X==lease.Root.Capture.Left&&origin.Y==lease.Root.Capture.Top&&GetDpiForWindow(lease.Root.Window)==lease.Root.Dpi&&GetWindowThreadProcessId(lease.Root.Window,out pid)==lease.Root.Thread&&pid==lease.Root.Pid,"QT_POPUP_ROOT_CHANGED");
    }
    static bool QtPopupWindowMatches(IntPtr candidate,QtPopupLease lease) {
        if(candidate==IntPtr.Zero||candidate==lease.Root.Window)return false;
        try {
            var identity=QtFocusWindow(candidate,QtExecutable,true);uint pid;uint thread=GetWindowThreadProcessId(candidate,out pid);Rect bounds,client;
            Point origin=new Point(0,0);if(!GetWindowRect(candidate,out bounds)||!GetClientRect(candidate,out client)||!ClientToScreen(candidate,ref origin))return false;
            var name=new StringBuilder(257);GetClassName(candidate,name,name.Capacity);QtPopupCalibration c=lease.Calibration;
            // A search result list changes height when the query resolves. Only
            // Only calibrated heights or the bounded search-height range may vary; HWND, width,
            // position, owner, thread and all remaining identity stay fixed.
            bool heightMatches=client.Height==c.ClientHeight||c.Kind=="search"&&(c.HeightVariants.Contains(client.Height)||c.MinHeight>0&&client.Height>=c.MinHeight&&client.Height<=c.MaxHeight&&c.RelativeWindow.Top+c.MaxHeight<=lease.Root.Client.Height);
            int bottom=c.RelativeWindow.Bottom+(client.Height-c.ClientHeight);
            Rect expected=new Rect(lease.Root.Capture.Left+c.RelativeWindow.Left,lease.Root.Capture.Top+c.RelativeWindow.Top,lease.Root.Capture.Left+c.RelativeWindow.Right,lease.Root.Capture.Top+bottom);
            bool geometry=Same(bounds,expected)&&client.Width==c.ClientWidth&&heightMatches;
            if(lease.Observed){Rect clientScreen=new Rect(origin.X,origin.Y,origin.X+client.Width,origin.Y+client.Height);var displays=QtPopupDisplays();bool offscreen=QtPopupOffscreenScope(lease,QtPopupOutsideDisplays(lease.Root.Capture,displays),QtPopupOutsideDisplays(bounds,displays));geometry=QtPopupGeometryAllowed(bounds,client,clientScreen,lease,offscreen)&&QtPopupDisplayAllowed(lease,bounds,displays);}
            return identity.Pid==lease.Root.Pid&&identity.Created==lease.Root.Created&&thread==lease.Root.Thread&&QtPopupOwnerMatches(candidate,lease)&&
                geometry&&GetDpiForWindow(candidate)==lease.Root.Dpi&&name.ToString()==c.ClassName&&GetWindowLongPtr(candidate,-16).ToInt64()==c.Style&&GetWindowLongPtr(candidate,-20).ToInt64()==c.ExtendedStyle;
        } catch { return false; }
    }
    static object QtPopupRelativeRect(Rect value,Rect root){return new Rect(value.Left-root.Left,value.Top-root.Top,value.Right-root.Left,value.Bottom-root.Top).Report();}
    static object QtPopupFailureWindow(IntPtr window,QtPopupLease lease){
        var raw=Map(QtWindowDiagnostic(window,new QtFocusIdentity{Window=lease.Root.Window,Pid=lease.Root.Pid,Created=lease.Root.Created}));
        var result=Data("available",Get(raw,"available"),"sameBoundWindow",window==lease.Window,"previouslyVisible",lease.PreviouslyVisible!=null&&lease.PreviouslyVisible.Contains(window));
        if(!Object.Equals(Get(raw,"available"),true))return result;
        foreach(string key in new[]{"visible","minimized","identityReadable"})result.Add(key,Get(raw,key));
        result.Add("processMatches",Get(raw,"sameRootProcess"));result.Add("threadMatches",Number(Get(raw,"threadId"))==lease.Root.Thread);
        result.Add("classMatches",Text(raw,"className")==lease.Calibration.ClassName);result.Add("styleMatches",Number(Get(raw,"style"))==lease.Calibration.Style);result.Add("extendedStyleMatches",Number(Get(raw,"extendedStyle"))==lease.Calibration.ExtendedStyle);
        result.Add("dpiMatches",Number(Get(raw,"dpi"))==lease.Root.Dpi);result.Add("dpi",Get(raw,"dpi"));
        bool? owner=null;try{owner=QtPopupOwnerMatches(window,lease);}catch{}result.Add("ownerMatches",owner);
        if(Get(raw,"rect")!=null&&Get(raw,"clientRect")!=null&&Get(raw,"clientScreenRect")!=null){
            Rect bounds=ParseRect(Get(raw,"rect")),client=ParseRect(Get(raw,"clientRect")),screen=ParseRect(Get(raw,"clientScreenRect"));
            result.Add("windowRectInRoot",QtPopupRelativeRect(bounds,lease.Root.Capture));result.Add("clientRect",client.Report());result.Add("clientRectInRoot",QtPopupRelativeRect(screen,lease.Root.Capture));
            result.Add("boundsInsideRoot",Contains(lease.Root.Capture,bounds));result.Add("observedGeometryAllowed",lease.Observed?(object)QtPopupGeometryAllowed(bounds,client,screen,lease):null);
        }
        return result;
    }
    static Fault QtPopupBindingChanged(QtPopupLease lease,string stage,QtFrame failedFrame=null){
        var error=new Fault("QT_POPUP_BINDING_CHANGED");
        // Preserve the original refusal. Observations follow that refusal and
        // can be incomplete/racy; they never authorize input or a replacement HWND.
        try{
            long started=Now(),deadline=started+80;var report=Data("version",1,"stage",stage,"pasteStage",QtPasteDiagnosticStage??"none","inputAttempted",InputAttempted,"readOnly",true,"authorizationGranted",false,"observationAfterFailure",true);
            report.Add("observed",lease.Observed);report.Add("kind",lease.Calibration.Kind);report.Add("revisionUnchangedBefore",lease.Revision==Interlocked.Read(ref Revision));
            report.Add("foregroundIsRoot",GetForegroundWindow()==lease.Root.Window);report.Add("foregroundIsPopup",GetForegroundWindow()==lease.Window);
            report.Add("boundWindowRectInRoot",QtPopupRelativeRect(lease.ObservedBounds,lease.Root.Capture));report.Add("boundClientRect",lease.ObservedClient.Report());report.Add("boundClientRectInRoot",QtPopupRelativeRect(lease.ObservedClientScreen,lease.Root.Capture));
            var frame=failedFrame??QtPasteDiagnosticFrame;if(frame!=null&&frame.PopupBounds.HasValue&&frame.PopupClient.HasValue){report.Add("frameWindowRectInRoot",QtPopupRelativeRect(frame.PopupBounds.Value,lease.Root.Capture));report.Add("frameClientRect",frame.PopupClient.Value.Report());}
            try{report.Add("boundNow",QtPopupFailureWindow(lease.Window,lease));}catch{report.Add("boundNow",Data("available",false,"sameBoundWindow",true,"previouslyVisible",false));}
            var windows=new List<IntPtr>();int visited=0;bool complete=true;
            if(!EnumWindows(delegate(IntPtr window,IntPtr unused){if(++visited>128||Now()>deadline){complete=false;return false;}uint pid;GetWindowThreadProcessId(window,out pid);if(window!=lease.Root.Window&&pid==lease.Root.Pid&&IsWindowVisible(window)){if(windows.Count>=8){complete=false;return false;}windows.Add(window);}return true;},IntPtr.Zero))complete=false;
            var candidates=new List<object>();foreach(IntPtr window in windows){if(Now()>deadline){complete=false;break;}try{candidates.Add(window==lease.Window?Get(report,"boundNow"):QtPopupFailureWindow(window,lease));}catch{complete=false;}}
            report.Add("visibleCandidates",candidates);report.Add("enumerationComplete",complete&&Now()<=deadline);report.Add("revisionUnchangedAfter",lease.Revision==Interlocked.Read(ref Revision));report.Add("elapsedMs",Math.Max(0,Now()-started));error.Data["QtPopupBindingMismatch"]=report;
        }catch{}
        return error;
    }
    static void QtNeedPopupBinding(QtPopupLease lease,string stage){if(!QtPopupWindowMatches(lease.Window,lease))throw QtPopupBindingChanged(lease,stage);}
    static object QtPopupBindingMismatch(Exception error){return error.Data.Contains("QtPopupBindingMismatch")?error.Data["QtPopupBindingMismatch"]:null;}
    static bool QtPopupTriggerMatches(string id,string kind,string action,string key,bool anchoredClick) {return id=="search"&&kind=="search"&&action=="chord"&&key=="Control+F"||((id=="self"||id=="profile")&&kind=="profile"&&action=="click"&&anchoredClick);}
    static QtPopupLease QtPreparePopupTransition(object value,QtFrame frame,string action,string key,object clickRect) {
        if(value==null)return null;var data=Map(value);bool observed=data!=null&&Text(data,"geometryMode")=="observed-v1";Need(data!=null&&data.Count==(observed?3:2),"QT_POPUP_TRANSITION_INVALID");
        string id=Text(data,"id");var calibration=QtParsePopupCalibration(Get(data,"calibration"),observed);
        bool anchored=false;if(action=="click"){Rect clicked=ParseRect(clickRect);foreach(var anchor in frame.Anchors)if(Contains(anchor.Rect,clicked))anchored=true;}
        Need(QtPopupTriggerMatches(id,calibration.Kind,action,key,anchored)&&QtSurface=="main"&&frame.Binding.Window==QtRootWindow,"QT_POPUP_TRANSITION_INVALID");
        var visible=new HashSet<IntPtr>();int count=0;EnumWindows(delegate(IntPtr window,IntPtr unused){if(IsWindowVisible(window))visible.Add(window);return ++count<4096;},IntPtr.Zero);Need(count<4096,"QT_POPUP_ENUMERATION_LIMIT");
        return new QtPopupLease{Id=id,Calibration=calibration,Root=frame.Binding,Revision=frame.Revision,Issued=UtcMs(),PreviouslyVisible=visible,Observed=observed,UiaSearch=QtPopupUsesUiaSearch(frame,QtLease,observed,id,calibration)};
    }
    static IntPtr QtUniquePopupCandidate(QtPopupLease lease){var candidates=new List<IntPtr>();int count=0;EnumWindows(delegate(IntPtr window,IntPtr unused){if(!lease.PreviouslyVisible.Contains(window)&&QtPopupWindowMatches(window,lease))candidates.Add(window);return ++count<4096;},IntPtr.Zero);Need(count<4096&&candidates.Count==1,"QT_POPUP_CANDIDATE_NOT_UNIQUE");return candidates[0];}
    static void QtBindCalibratedPopup(string surface,string id) {
        QtPopupLease lease=QtPopup??QtPendingPopup;Need(lease!=null&&lease.Id==id&&lease.Observed==surface.StartsWith("observed-",StringComparison.Ordinal)&&(surface.EndsWith("profile",StringComparison.Ordinal)&&lease.Calibration.Kind=="profile"||surface.EndsWith("search",StringComparison.Ordinal)&&lease.Calibration.Kind=="search"),"QT_POPUP_TRANSITION_REQUIRED");
        QtPopupRootStable(lease);
        if(lease.Window==IntPtr.Zero) {
            Need(UtcMs()-lease.Issued>=0&&UtcMs()-lease.Issued<=10000,"QT_POPUP_TRANSITION_EXPIRED");
            IntPtr candidate=QtUniquePopupCandidate(lease);Rect firstBounds=new Rect(),firstClient=new Rect();Point firstOrigin=new Point(0,0);Need(GetWindowRect(candidate,out firstBounds)&&GetClientRect(candidate,out firstClient)&&ClientToScreen(candidate,ref firstOrigin),"QT_POPUP_GEOMETRY_UNAVAILABLE");QtPopupObservationPause(lease,Thread.Sleep);QtPopupRootStable(lease);
            Need(QtPopupCausalEligible(true,true,true,true,true,true,lease.PreviouslyVisible.Contains(candidate),QtUniquePopupCandidate(lease)==candidate),"QT_POPUP_UNSTABLE");
            Rect secondBounds,secondClient;Point secondOrigin=new Point(0,0);Need(GetWindowRect(candidate,out secondBounds)&&GetClientRect(candidate,out secondClient)&&ClientToScreen(candidate,ref secondOrigin)&&Same(firstBounds,secondBounds)&&Same(firstClient,secondClient)&&firstOrigin.X==secondOrigin.X&&firstOrigin.Y==secondOrigin.Y,"QT_POPUP_UNSTABLE");
            lease.ObservedBounds=firstBounds;lease.ObservedClient=firstClient;lease.ObservedClientScreen=new Rect(firstOrigin.X,firstOrigin.Y,firstOrigin.X+firstClient.Width,firstOrigin.Y+firstClient.Height);lease.Window=candidate;QtPopup=lease;QtPendingPopup=null;
        }
        QtNeedPopupBinding(lease,"bind");
        Need(GetForegroundWindow()==(lease.Calibration.Kind=="profile"?lease.Window:lease.Root.Window),"QT_POPUP_FOCUS_CHANGED");
        QtWindow=lease.Calibration.Kind=="profile"?lease.Window:lease.Root.Window;QtSurface=surface;
    }
    static void QtValidateActivePopup(){if(QtPopupSurface(QtSurface)){QtPopupRootStable(QtPopup);QtNeedPopupBinding(QtPopup,"active");Need(GetForegroundWindow()==QtWindow,"QT_POPUP_FOCUS_CHANGED");}}
    // Diagnostics never promote a same-process window into an owned surface.
    // A captured main binding is required; inspection does not bind or activate.
    static string QtHandle(IntPtr window){return window.ToInt64().ToString(CultureInfo.InvariantCulture);}
    static List<IntPtr> QtDiagnosticOwners(IntPtr start,Func<IntPtr,IntPtr> next){var result=new List<IntPtr>();while(start!=IntPtr.Zero&&result.Count<16&&!result.Contains(start)){result.Add(start);start=next(start);}return result;}
    static List<Rect> QtDiagnosticHitRects(object value,Rect client){var result=new List<Rect>();if(value==null)return result;object[] values=value as object[];Need(values!=null&&values.Length<=4,"QT_DIAGNOSTIC_REGIONS_INVALID");foreach(object item in values){Rect region=ParseRect(item);Need(Contains(client,region),"QT_DIAGNOSTIC_REGIONS_INVALID");result.Add(region);}return result;}
    static object QtWindowDiagnostic(IntPtr window,QtFocusIdentity root){
        var report=Data("hwnd",QtHandle(window),"available",false);uint pid;uint thread=GetWindowThreadProcessId(window,out pid);if(window==IntPtr.Zero||thread==0||!IsWindow(window))return report;
        var name=new StringBuilder(257);GetClassName(window,name,name.Capacity);Rect bounds;bool hasBounds=GetWindowRect(window,out bounds);long created=0;bool executableMatches=false;
        IntPtr process=OpenProcess(0x1000,false,pid);if(process!=IntPtr.Zero)try{FileTime start,exit,kernel,user;if(GetProcessTimes(process,out start,out exit,out kernel,out user))created=start.Value;var file=new StringBuilder(32768);int length=file.Capacity;if(QueryFullProcessImageName(process,0,file,ref length))executableMatches=String.Equals(Path.GetFullPath(file.ToString()),QtExecutable,StringComparison.OrdinalIgnoreCase);}finally{CloseHandle(process);}
        uint afterPid;bool stable=GetWindowThreadProcessId(window,out afterPid)==thread&&afterPid==pid;
        report["available"]=true;report.Add("pid",pid);report.Add("threadId",thread);report.Add("processCreatedFileTimeUtc",created>0?(object)created.ToString(CultureInfo.InvariantCulture):null);report.Add("identityReadable",stable&&created>0);
        report.Add("sameRootProcess",stable&&pid==root.Pid&&created==root.Created&&executableMatches);report.Add("executableMatches",executableMatches);report.Add("className",name.ToString());report.Add("visible",IsWindowVisible(window));report.Add("minimized",IsIconic(window));report.Add("rect",hasBounds?bounds.Report():null);
        Rect client;Point origin=new Point(0,0);bool hasClient=GetClientRect(window,out client)&&ClientToScreen(window,ref origin);report.Add("clientRect",hasClient?client.Report():null);report.Add("clientScreenRect",hasClient?new Rect(origin.X,origin.Y,origin.X+client.Width,origin.Y+client.Height).Report():null);report.Add("dpi",GetDpiForWindow(window));
        report.Add("style",GetWindowLongPtr(window,-16).ToInt64());report.Add("extendedStyle",GetWindowLongPtr(window,-20).ToInt64());report.Add("ownerHwnd",QtHandle(GetWindow(window,4)));report.Add("parentHwnd",QtHandle(GetAncestor(window,1)));report.Add("rootHwnd",QtHandle(GetAncestor(window,2)));report.Add("rootOwnerHwnd",QtHandle(GetAncestor(window,3)));report.Add("lastActivePopupHwnd",QtHandle(GetLastActivePopup(window)));report.Add("ownerChainReachesMain",QtOwnedPopup(window,root.Window));return report;
    }
    static object QtThreadDiagnostic(uint thread,QtFocusIdentity root){var gui=new GuiInfo{Size=(uint)Marshal.SizeOf(typeof(GuiInfo))};if(thread==0||!GetGUIThreadInfo(thread,ref gui))return Data("available",false,"threadId",thread);return Data("available",true,"threadId",thread,"flags",gui.Flags,"active",QtWindowDiagnostic(gui.Active,root),"focus",QtWindowDiagnostic(gui.Focus,root),"captureHwnd",QtHandle(gui.Capture),"menuOwnerHwnd",QtHandle(gui.MenuOwner));}
    static object QtInspectPopup(Dictionary<string,object> request){
        Desktop();Need(QtRootWindow!=IntPtr.Zero,"QT_POPUP_ROOT_REQUIRED");var expected=new QtFocusIdentity{Window=QtRootWindow,Pid=QtRootPid,Created=QtRootCreated};var root=QtFocusWindow(QtRootWindow,QtExecutable,true);Need(QtSameFocus(root,expected),"QT_POPUP_PROCESS_CHANGED");
        Rect client;Need(GetClientRect(root.Window,out client),"DRAFT_GEOMETRY_UNAVAILABLE");var regions=QtDiagnosticHitRects(Get(request,"hitRects"),client);Point origin=new Point(0,0);Need(ClientToScreen(root.Window,ref origin),"DRAFT_GEOMETRY_UNAVAILABLE");
        long revision=Interlocked.Read(ref Revision);IntPtr foreground=GetForegroundWindow();uint ignored;uint foregroundThread=GetWindowThreadProcessId(foreground,out ignored),rootThread=GetWindowThreadProcessId(root.Window,out ignored);
        var owners=new List<object>();foreach(IntPtr window in QtDiagnosticOwners(foreground,delegate(IntPtr value){return GetWindow(value,4);}))owners.Add(QtWindowDiagnostic(window,root));
        var candidates=new List<object>();int total=0;EnumWindows(delegate(IntPtr window,IntPtr unused){uint pid;if(IsWindowVisible(window)&&GetWindowThreadProcessId(window,out pid)!=0&&pid==root.Pid){total++;if(candidates.Count<16)candidates.Add(QtWindowDiagnostic(window,root));}return true;},IntPtr.Zero);
        var hits=new List<object>();foreach(Rect region in regions){Point point=new Point(origin.X+region.Left+region.Width/2,origin.Y+region.Top+region.Height/2);hits.Add(Data("region",region.Report(),"hit",QtWindowDiagnostic(WindowFromPoint(point),root)));}
        object rootReport=QtWindowDiagnostic(root.Window,root),foregroundReport=QtWindowDiagnostic(foreground,root),foregroundGui=QtThreadDiagnostic(foregroundThread,root),rootGui=QtThreadDiagnostic(rootThread,root);
        bool rootStable;try{rootStable=QtSameFocus(root,QtFocusWindow(root.Window,QtExecutable,true));}catch{rootStable=false;}IntPtr foregroundAfter=GetForegroundWindow();
        return Data("readOnly",true,"inputSent",false,"clipboardAccessed",false,"focusChanged",false,"authorizationGranted",false,"windowTitlesIncluded",false,"textIncluded",false,"observedAtMs",UtcMs(),"activityRevision",revision,"stableObservation",rootStable&&foreground==foregroundAfter&&revision==Interlocked.Read(ref Revision),"foregroundAfterHwnd",QtHandle(foregroundAfter),"root",rootReport,"foreground",foregroundReport,"foregroundOwnerChain",owners,"mainThread",rootGui,"foregroundThread",foregroundGui,"samePidVisibleWindows",candidates,"samePidWindowsTruncated",total>candidates.Count,"hitTests",hits);
    }
    static void QtSelectSurface(string surface,string surfaceId=null) {
        if(QtRootWindow==IntPtr.Zero){
            var expected=QtInspectedFocus==null?null:QtInspectedFocus.Wechat;
            IntPtr candidate=expected!=null?expected.Window:QtWindow==IntPtr.Zero?GetForegroundWindow():QtWindow;
            Need(GetWindow(candidate,4)==IntPtr.Zero,"QT_FOCUS_TARGET_CHANGED");Binding root=Snapshot(candidate,QtExecutable);
            Need(expected==null||root.Pid==expected.Pid&&root.Created==expected.Created,"QT_FOCUS_TARGET_CHANGED");
            QtRootWindow=candidate;QtWindow=candidate;QtRootPid=root.Pid;QtRootCreated=root.Created;
        }
        if(surface==null||surface=="main"){QtWindow=QtRootWindow;QtSurface="main";QtPopup=null;QtPendingPopup=null;}
        else if(QtPopupSurface(surface))QtBindCalibratedPopup(surface,surfaceId);
        else {Need(surface=="owned-profile","QT_SURFACE_INVALID");QtPopup=null;QtPendingPopup=null;QtSurface=surface;IntPtr current=GetForegroundWindow();Need(QtOwnedPopup(current,QtRootWindow),"QT_POPUP_NOT_OWNED");Binding actual=Snapshot(current,QtExecutable);Need(actual.Pid==QtRootPid&&actual.Created==QtRootCreated,"QT_POPUP_PROCESS_CHANGED");QtWindow=current;}
    }
    static Dictionary<string,object> QtOverlapReport(Binding binding) {
        bool before=true;int blocking=0,total=0;var windows=new List<object>();
        EnumWindows(delegate(IntPtr hwnd,IntPtr unused) {
            if(hwnd==binding.Window){before=false;return true;}
            if(!before||!IsWindowVisible(hwnd)||IsIconic(hwnd))return true;
            int cloaked; if(DwmGetWindowAttribute(hwnd,14,out cloaked,4)>=0&&cloaked!=0)return true;
            Rect bounds;if(GetWindowRect(hwnd,out bounds)&&Intersects(bounds,binding.Capture)){
                total++;long exStyle=GetWindowLongPtr(hwnd,-20).ToInt64(),style=GetWindowLongPtr(hwnd,-16).ToInt64();uint key=0,flags=0;byte alpha=255;
                bool layered=(exStyle&0x80000)!=0,attributes=layered&&GetLayeredWindowAttributes(hwnd,out key,out alpha,out flags);
                // WS_EX_TRANSPARENT controls hit testing/paint order, not visual
                // transparency. Ignore only a confirmed global zero-alpha layer.
                bool transparent=attributes&&(flags&2)!=0&&alpha==0;
                bool calibrated=QtSearchSurface(QtSurface)&&QtPopup!=null&&hwnd==QtPopup.Window&&binding.Window==QtPopup.Root.Window&&QtPopupWindowMatches(hwnd,QtPopup);
                if(!transparent&&!calibrated)blocking++;
                if(windows.Count<16){uint pid;GetWindowThreadProcessId(hwnd,out pid);var name=new StringBuilder(257);GetClassName(hwnd,name,name.Capacity);
                    windows.Add(Data("className",name.ToString(),"pid",pid,"rect",bounds.Report(),"style",style,"extendedStyle",exStyle,"layered",layered,"layeredAttributesAvailable",attributes,"globalAlpha",attributes&&(flags&2)!=0?(object)alpha:null,"colorKeyEnabled",attributes&&(flags&1)!=0,"ignoredTransparent",transparent,"matchedCalibratedPopup",calibrated));}
            }
            return true;
        },IntPtr.Zero);
        Need(!before,"QT_WINDOW_Z_ORDER_UNAVAILABLE");return Data("blockingCount",blocking,"overlappingCount",total,"windows",windows,"truncated",total>windows.Count,"windowTitlesIncluded",false);
    }
    // This bounded comparison is diagnostic only. It neither changes the
    // overlap decision above nor grants a capture/input token.
    sealed class QtDiagnosticPreviousChain { internal List<IntPtr> Windows=new List<IntPtr>();internal string Reason;internal bool Complete; }
    static QtDiagnosticPreviousChain QtReadPreviousChain(IntPtr target,Func<IntPtr,IntPtr> previous,Func<IntPtr,bool> valid,Func<long> clock,long deadline,int limit){
        var result=new QtDiagnosticPreviousChain();var seen=new HashSet<IntPtr>{target};IntPtr current=target;
        for(int index=0;index<limit;index++){
            if(clock()>deadline){result.Reason="deadline";return result;}
            if(!valid(current)){result.Reason="window-unavailable";return result;}
            IntPtr above=previous(current);if(above==IntPtr.Zero){result.Complete=true;result.Reason="end";return result;}
            if(!seen.Add(above)){result.Reason="cycle";return result;}
            if(!valid(above)){result.Reason="window-unavailable";return result;}
            result.Windows.Add(above);current=above;
        }
        result.Reason="limit";return result;
    }
    static Dictionary<string,object> QtAnonymousWindow(IntPtr window){
        if(window==IntPtr.Zero||!IsWindow(window))return Data("available",false);
        uint pid;GetWindowThreadProcessId(window,out pid);var name=new StringBuilder(257);GetClassName(window,name,name.Capacity);Rect bounds;bool rectangle=GetWindowRect(window,out bounds);int cloaked;bool cloakKnown=DwmGetWindowAttribute(window,14,out cloaked,4)>=0;long exStyle=GetWindowLongPtr(window,-20).ToInt64();
        return Data("available",true,"pid",pid,"className",name.ToString(),"rect",rectangle?(object)bounds.Report():null,"visible",IsWindowVisible(window),"iconic",IsIconic(window),"topmost",(exStyle&8)!=0,"cloaked",cloakKnown?(object)(cloaked!=0):null);
    }
    static List<Point> QtOcclusionRegionPoints(Rect rect){return new List<Point>{new Point(rect.Left+rect.Width/2,rect.Top+rect.Height/2),new Point(rect.Left,rect.Top),new Point(rect.Right-1,rect.Top),new Point(rect.Left,rect.Bottom-1),new Point(rect.Right-1,rect.Bottom-1)};}
    static Dictionary<string,Rect> QtOcclusionRegions(object value,Rect client){
        var result=new Dictionary<string,Rect>();if(value==null)return result;var map=Map(value);Need(map!=null&&map.Count<=2,"QT_OCCLUSION_REGIONS_INVALID");
        foreach(var item in map){Need(item.Key=="header"||item.Key=="editor","QT_OCCLUSION_REGIONS_INVALID");Rect rect=ParseRect(item.Value);Need(Contains(client,rect),"QT_OCCLUSION_REGIONS_INVALID");result.Add(item.Key,rect);}return result;
    }
    static object QtOcclusionDiagnostics(Binding binding,object requestedRegions){
        var regions=QtOcclusionRegions(requestedRegions,binding.Client);long started=Now(),deadline=started+200,revision=Interlocked.Read(ref Revision);bool foregroundBefore=GetForegroundWindow()==binding.Window;
        var chain=QtReadPreviousChain(binding.Window,delegate(IntPtr window){return GetWindow(window,3);},IsWindow,Now,deadline,16);var above=new List<object>();
        foreach(IntPtr window in chain.Windows){if(Now()>deadline)break;var row=QtAnonymousWindow(window);Rect bounds;row.Add("overlapsBoundClient",GetWindowRect(window,out bounds)&&Intersects(bounds,binding.Capture));row.Add("sameBoundProcess",Object.Equals(Get(row,"pid"),binding.Pid));above.Add(row);}
        var points=new List<object>();foreach(var region in regions){foreach(Point point in QtOcclusionRegionPoints(region.Value)){if(Now()>deadline)break;Point screen=new Point(binding.Capture.Left+point.X,binding.Capture.Top+point.Y);IntPtr hit=WindowFromPoint(screen),root=hit==IntPtr.Zero?IntPtr.Zero:GetAncestor(hit,2);
                points.Add(Data("region",region.Key,"clientX",point.X,"clientY",point.Y,"ownedByBoundWindow",Owned(hit,binding.Window,binding.Pid),"rootIsBoundWindow",root==binding.Window,"hit",QtAnonymousWindow(hit),"root",QtAnonymousWindow(root)));}}
        bool chainUnchanged=chain.Reason=="end"||chain.Reason=="limit";IntPtr current=binding.Window;foreach(IntPtr expected in chain.Windows){if(Now()>deadline||!IsWindow(current)||!IsWindow(expected)||GetWindow(current,3)!=expected){chainUnchanged=false;break;}current=expected;}if(chain.Complete&&chainUnchanged)chainUnchanged=Now()<=deadline&&GetWindow(current,3)==IntPtr.Zero;
        bool bindingUnchanged=false;try{var identity=QtFocusWindow(binding.Window,QtExecutable);Rect client;Point origin=new Point(0,0);bindingUnchanged=identity.Pid==binding.Pid&&identity.Created==binding.Created&&GetClientRect(binding.Window,out client)&&ClientToScreen(binding.Window,ref origin)&&Same(client,binding.Client)&&origin.X==binding.Capture.Left&&origin.Y==binding.Capture.Top&&GetDpiForWindow(binding.Window)==binding.Dpi;}catch{}
        return Data("version",1,"readOnly",true,"inputAuthorized",false,"windowTitlesIncluded",false,"foregroundExactBefore",foregroundBefore,"foregroundExactAfter",GetForegroundWindow()==binding.Window,"activityUnchanged",revision==Interlocked.Read(ref Revision),"bindingUnchanged",bindingUnchanged,"previousChainSource","GW_HWNDPREV","previousChainOrder","nearest-above-first","previousChainComplete",chain.Complete,"previousChainReason",chain.Reason,"previousChainUnchanged",chainUnchanged,"previousWindows",above,"pointHits",points,"deadlineExceeded",Now()>deadline,"elapsedMs",Math.Max(0,Now()-started));
    }
    static void QtNoOverlap(Binding binding) { var report=QtOverlapReport(binding);Need(Number(Get(report,"blockingCount"))==0,"QT_WINDOW_OBSCURED"); }
    static Binding QtBound(bool requireUnobscured=true) {
        Need(!Stopping,"QT_STOPPING");QtValidateActivePopup(); IntPtr candidate=QtWindow==IntPtr.Zero?GetForegroundWindow():QtWindow; Binding binding=Snapshot(candidate,QtExecutable);QtWindow=candidate;
        Need(binding.Client.Width<=4096&&binding.Client.Height<=4096&&(long)binding.Client.Width*binding.Client.Height<=12000000,"QT_GEOMETRY_INVALID");
        Need(binding.FocusOwned&&(binding.GuiFlags&0x1e)==0,"QT_FOCUS_UNAVAILABLE");if(requireUnobscured)QtNoOverlap(binding);return binding;
    }
    // Candidate screenshots carry no input token. Their subsequently located
    // regions are checked separately; unrelated animated messages need not be
    // frozen. The ordinary input capture still requires guarded anchors.
    static List<QtAnchor> QtLayoutAnchors(object value,object image,Rect client){
        var values=value as object[];
        if(values!=null&&values.Length==0&&Object.Equals(image,true))return new List<QtAnchor>();
        return QtParseAnchors(value,client);
    }
    static List<QtAnchor> QtParseAnchors(object value,Rect client) {
        object[] values=value as object[];Need(values!=null&&values.Length>=1&&values.Length<=8,"QT_ANCHORS_REQUIRED");
        var result=new List<QtAnchor>();long area=0;
        foreach(object item in values){Rect rect=ParseRect(item);Need(Contains(client,rect),"QT_REGION_INVALID");area+=(long)rect.Width*rect.Height;Need(area<=12000000,"QT_REGION_INVALID");result.Add(new QtAnchor{Rect=rect});}
        return result;
    }
    sealed class QtPopupCaptureSnapshot {
        internal readonly QtPopupLease Lease;internal readonly IntPtr Window;internal readonly Rect Bounds,Client,ClientScreen,Relative;internal readonly uint Dpi;
        internal readonly string Id,Kind,OwnerRelation;
        internal QtPopupCaptureSnapshot(QtPopupLease lease,Rect bounds,Rect client,Point origin,uint dpi){
            Lease=lease;Window=lease.Window;Bounds=bounds;Client=client;Dpi=dpi;Id=lease.Id;Kind=lease.Calibration.Kind;OwnerRelation=lease.Calibration.OwnerRelation;
            ClientScreen=new Rect(origin.X,origin.Y,origin.X+client.Width,origin.Y+client.Height);
            Relative=new Rect(origin.X-lease.Root.Capture.Left,origin.Y-lease.Root.Capture.Top,origin.X-lease.Root.Capture.Left+client.Width,origin.Y-lease.Root.Capture.Top+client.Height);
        }
        internal Dictionary<string,object> Report(){return Data("surfaceId",Id,"kind",Kind,"hwnd",QtHandle(Window),"ownerRelation",OwnerRelation,"stableObservations",2,
            "geometryMode","observed-v1","windowRect",Bounds.Report(),"clientRect",Client.Report(),"clientRectInRoot",Relative.Report(),"dpi",Dpi);}
    }
    static QtPopupCaptureSnapshot QtReadPopupCaptureSnapshot(QtPopupLease lease){
        Need(lease!=null&&lease.Observed&&Object.ReferenceEquals(lease,QtPopup),"QT_POPUP_BINDING_CHANGED");
        Rect bounds=new Rect(),client=new Rect();Point origin=new Point(0,0);
        Need(GetWindowRect(lease.Window,out bounds)&&GetClientRect(lease.Window,out client)&&ClientToScreen(lease.Window,ref origin),"QT_POPUP_GEOMETRY_UNAVAILABLE");
        var result=new QtPopupCaptureSnapshot(lease,bounds,client,origin,GetDpiForWindow(lease.Window));
        Need(result.Dpi==lease.Root.Dpi&&QtPopupGeometryAllowed(result.Bounds,result.Client,result.ClientScreen,lease,QtPopupOffscreenSearch(lease,result.Bounds)),"QT_POPUP_BINDING_CHANGED");return result;
    }
    static void QtNeedSamePopupCaptureSnapshot(QtPopupCaptureSnapshot before,QtPopupCaptureSnapshot after){
        Need(before!=null&&after!=null&&Object.ReferenceEquals(before.Lease,after.Lease)&&before.Window==after.Window&&before.Dpi==after.Dpi&&
            before.Id==after.Id&&before.Kind==after.Kind&&before.OwnerRelation==after.OwnerRelation&&Same(before.Bounds,after.Bounds)&&Same(before.Client,after.Client)&&
            Same(before.ClientScreen,after.ClientScreen)&&Same(before.Relative,after.Relative),"QT_POPUP_BINDING_CHANGED");
    }
    // Ownership begins only after this exact CreateNew succeeds. A refused
    // observation never hands its PNG to JavaScript, so it must dispose it here.
    sealed class QtOwnedCaptureImage : IDisposable {
        internal readonly string File;bool owned,returned;
        internal QtOwnedCaptureImage(string file){File=file;}
        internal void Write(byte[] bytes){using(var output=new FileStream(File,FileMode.CreateNew,FileAccess.Write,FileShare.None)){owned=true;output.Write(bytes,0,bytes.Length);}}
        internal void Transfer(){returned=true;}
        public void Dispose(){if(owned&&!returned){try{System.IO.File.Delete(File);}catch{}}}
    }
    static object QtCapture(Dictionary<string,object> request,bool stablePixels=true) {
        QtRejectFrameAuthority(request);
        QtCurrent=null;QtSelectSurface(Text(request,"surface"),Text(request,"surfaceId")); long revision=Interlocked.Read(ref Revision);Binding before=QtBound();
        var popupLease=QtPopup;var popupSnapshot=popupLease!=null&&popupLease.Observed?QtReadPopupCaptureSnapshot(popupLease):null;
        Dictionary<string,object> popup=popupLease==null?null:popupSnapshot!=null?popupSnapshot.Report():Data("surfaceId",popupLease.Id,"kind",popupLease.Calibration.Kind,"hwnd",QtHandle(popupLease.Window),"ownerRelation",popupLease.Calibration.OwnerRelation,"stableObservations",2);
        object regions=Get(request,"regions");var regionValues=regions as object[];
        if(regionValues!=null&&regionValues.Length==0){Need(Object.Equals(Get(request,"image"),true)||popupSnapshot!=null,"QT_ANCHORS_REQUIRED");Rect full=popupSnapshot!=null&&QtSearchSurface(QtSurface)?popupSnapshot.Relative:before.Client;regions=new object[]{full.Report()};}
        var anchors=QtParseAnchors(regions,before.Client);Rect? popupBounds=null,popupClient=null;
        if(popupSnapshot!=null){popupBounds=popupSnapshot.Bounds;popupClient=popupSnapshot.Client;}
        var report=new List<object>();foreach(var anchor in anchors){anchor.Hash=QtHash(QtPixels(before,anchor.Rect));report.Add(Data("rect",anchor.Rect.Report(),"rgbaSha256",anchor.Hash));}
        string file=null,sha=null;QtOwnedCaptureImage ownedImage=null;
        try{
        if(Object.Equals(Get(request,"image"),true)) {
            file=Path.Combine(QtFrames,"qt-"+Guid.NewGuid().ToString("N")+".png");ownedImage=new QtOwnedCaptureImage(file);
            using(var bitmap=new Bitmap(before.Client.Width,before.Client.Height,PixelFormat.Format32bppArgb)) {
                using(var graphic=Graphics.FromImage(bitmap))graphic.CopyFromScreen(before.Capture.Left,before.Capture.Top,0,0,new Size(bitmap.Width,bitmap.Height),CopyPixelOperation.SourceCopy);
                using(var memory=new MemoryStream()){bitmap.Save(memory,ImageFormat.Png);byte[] bytes=memory.ToArray();sha=QtHash(bytes);ownedImage.Write(bytes);}
            }
        }
        Binding after=QtBound();Need(QtSameBinding(before,after)&&revision==Interlocked.Read(ref Revision),"QT_OBSERVATION_CHANGED");
        Need(Object.ReferenceEquals(popupLease,QtPopup),"QT_POPUP_BINDING_CHANGED");
        if(stablePixels&&popupSnapshot!=null)QtNeedSamePopupCaptureSnapshot(popupSnapshot,QtReadPopupCaptureSnapshot(popupLease));
        if(stablePixels)for(int index=0;index<anchors.Count;index++)QtNeedAnchorPixels(anchors[index].Hash,QtHash(QtPixels(after,anchors[index].Rect)),"capture",index);
        // Pixels are another observation boundary. Freeze every emitted popup
        // field to the original tuple, and reject geometry changing during the
        // final pixel reads instead of mixing a new height into the reply.
        if(stablePixels&&popupSnapshot!=null)QtNeedSamePopupCaptureSnapshot(popupSnapshot,QtReadPopupCaptureSnapshot(popupLease));
        QtCurrent=new QtFrame{Binding=after,Token=Guid.NewGuid().ToString("N"),Revision=revision,Issued=UtcMs(),Anchors=anchors,PopupBounds=popupBounds,PopupClient=popupClient};
        var result=Data("binding",after.Report(),"executableVersion",FileVersionInfo.GetVersionInfo(QtExecutable).FileVersion,"pixelFormat","rgba-row-major-opaque-v1","token",QtCurrent.Token,"epoch",QtEpoch,"revision",revision,"idleMs",Math.Max(0,Now()-Interlocked.Read(ref LastActivity)),"regions",report,"image",file==null?null:Data("file",file,"sha256",sha),"inputSent",false,
            "popup",popup);
        if(ownedImage!=null)ownedImage.Transfer();return result;
        }finally{if(ownedImage!=null)ownedImage.Dispose();}
    }
    static void QtFramePurpose(QtFrame frame,bool navigation){Need(frame!=null&&frame.NavigationOnly==navigation,"QT_OBSERVATION_PURPOSE_INVALID");}
    static void QtRejectFrameAuthority(Dictionary<string,object> request){Need(!request.ContainsKey("uiaControlFrame")&&!request.ContainsKey("uiaControlLease"),"QT_UIA_CONTROL_FRAME_INVALID");}
    static bool QtUiaControlLeaseMatches(QtFrame frame,QtFocusLease lease){return frame!=null&&frame.UiaControlFrame&&!frame.NavigationOnly&&frame.UiaControlLease!=null&&Object.ReferenceEquals(frame.UiaControlLease,lease)&&frame.Binding!=null&&lease.Wechat!=null&&frame.Binding.Window==lease.Wechat.Window&&frame.Binding.Pid==lease.Wechat.Pid&&frame.Binding.Created==lease.Wechat.Created&&frame.Revision==lease.Revision;}
    static void QtCheckUiaControlLease(QtFrame frame){if(frame!=null&&frame.UiaControlFrame)Need(QtUiaControlLeaseMatches(frame,QtLease)&&QtParkedLease==null&&QtSurface=="main"&&QtPopup==null&&QtPendingPopup==null,"QT_UIA_CONTROL_FRAME_INVALID");}
    static bool QtUiaInputHeader(QtFrame frame,string kind,bool inputOnly,QtFocusLease lease){return kind=="text"&&inputOnly&&QtUiaControlLeaseMatches(frame,lease);}
    static void QtMarkUiaControlFrame(QtFrame frame,QtFocusLease lease,Dictionary<string,object> report){Need(frame!=null&&!frame.NavigationOnly&&frame.Anchors!=null&&(frame.Anchors.Count==2||frame.MetadataOnly&&frame.Anchors.Count==3),"QT_UIA_CONTROL_FRAME_INVALID");frame.UiaControlFrame=true;frame.UiaControlLease=lease;Need(QtUiaControlLeaseMatches(frame,lease),"QT_UIA_CONTROL_FRAME_INVALID");report["uiaControlFrame"]=true;}
    static bool QtAttachTextHeaderMatches(QtFrame source,QtFrame current,bool inputOnly,QtFocusLease lease){return current!=null&&source!=null&&current.Anchors.Count==2&&source.Anchors.Count>=1&&Same(current.Anchors[0].Rect,source.Anchors[0].Rect)&&(current.Anchors[0].Hash==source.Anchors[0].Hash||QtUiaInputHeader(source,"text",inputOnly,lease));}
    static void QtUiaNavigationContext(){Need(QtEnableInput&&!Stopping&&QtLease!=null&&QtParkedLease==null&&QtSurface=="main"&&QtPopup==null&&QtPendingPopup==null,"QT_UIA_NAVIGATION_UNAVAILABLE");Need(QtLease.Revision==Interlocked.Read(ref Revision),"QT_HUMAN_ACTIVITY_CHANGED");}
    static bool QtNavigationLeaseMatches(QtFrame frame,QtFocusLease lease){return frame!=null&&frame.NavigationOnly&&frame.NavigationLease!=null&&Object.ReferenceEquals(frame.NavigationLease,lease)&&frame.Binding!=null&&lease.Wechat!=null&&frame.Binding.Window==lease.Wechat.Window&&frame.Binding.Pid==lease.Wechat.Pid&&frame.Binding.Created==lease.Wechat.Created;}
    static object QtCaptureUiaNavigation(Dictionary<string,object> request){
        QtUiaNavigationContext();foreach(string key in request.Keys)Need(key=="id"||key=="action"||key=="surface"||key=="regions"||key=="image","QT_UIA_NAVIGATION_REQUEST_INVALID");
        var regions=Get(request,"regions") as object[];Need(Text(request,"surface")=="main"&&Object.Equals(Get(request,"image"),false)&&regions!=null&&regions.Length==1,"QT_UIA_NAVIGATION_REQUEST_INVALID");
        var lease=QtLease;var result=QtCaptureUiaControls(request,"navigation");QtUiaNavigationContext();Need(Object.ReferenceEquals(lease,QtLease),"QT_UIA_NAVIGATION_UNAVAILABLE");
        QtCurrent.NavigationOnly=true;QtCurrent.NavigationLease=lease;Need(QtNavigationLeaseMatches(QtCurrent,lease),"QT_UIA_NAVIGATION_UNAVAILABLE");
        result.Add("navigationOnly",true);result.Add("baselinePixelStable",false);return result;
    }
    static object QtOpenUiaSearch(Dictionary<string,object> request){
        QtUiaNavigationContext();foreach(string key in request.Keys)Need(key=="id"||key=="action"||key=="token"||key=="epoch"||key=="revision"||key=="idleMs"||key=="popupTransition","QT_UIA_NAVIGATION_REQUEST_INVALID");
        QtFramePurpose(QtCurrent,true);Need(QtNavigationLeaseMatches(QtCurrent,QtLease)&&QtCurrent.Anchors.Count==1&&!QtCurrent.PopupBounds.HasValue,"QT_UIA_NAVIGATION_UNAVAILABLE");
        var transition=Map(Get(request,"popupTransition"));Need(transition!=null&&Text(transition,"id")=="search","QT_UIA_NAVIGATION_REQUEST_INVALID");
        var action=new Dictionary<string,object>(request);action["key"]="Control+F";return QtAct(action,"chord",true);
    }
    static bool QtUiaEditorRegion(Rect editor,Rect header,Rect client){return Contains(client,editor)&&editor.Top>=client.Top+client.Height/2&&editor.Top>=header.Bottom&&editor.Width>=20&&editor.Height>=12;}
    static object QtFocusUiaEditor(Dictionary<string,object> request){
        QtUiaNavigationContext();foreach(string key in request.Keys)Need(key=="id"||key=="action"||key=="token"||key=="epoch"||key=="revision"||key=="idleMs"||key=="editorRect","QT_UIA_NAVIGATION_REQUEST_INVALID");
        QtFramePurpose(QtCurrent,true);var frame=QtCurrent;Need(QtNavigationLeaseMatches(frame,QtLease)&&frame.Anchors.Count==1&&!frame.PopupBounds.HasValue,"QT_UIA_NAVIGATION_UNAVAILABLE");
        Rect editor=ParseRect(Get(request,"editorRect")),header=frame.Anchors[0].Rect;Need(QtUiaEditorRegion(editor,header,frame.Binding.Client),"QT_UIA_EDITOR_REGION_INVALID");
        var action=new Dictionary<string,object>(request);action.Remove("editorRect");action["rect"]=editor.Report();var focused=Map(QtAct(action,"click",false,true));
        // This frame authorizes the ordinary input-only paste guards, not a
        // pixel-stability claim. The navigation token was consumed by QtAct.
        var captured=QtCaptureUiaControls(Data("surface","main","regions",new object[]{header.Report(),editor.Report()},"image",false));
        QtMarkUiaControlFrame(QtCurrent,frame.NavigationLease,captured);QtCheckUiaControlLease(QtCurrent);
        QtUiaRole currentEditor=null;foreach(var role in QtCurrent.UiaRoles)if(role.Role=="editor")currentEditor=role;Need(currentEditor!=null&&currentEditor.Node.Element.Current.HasKeyboardFocus,"QT_UIA_EDITOR_FOCUS_UNCONFIRMED");
        bool reused=Object.Equals(Get(focused,"editorFocusReused"),true);
        captured.Add("navigationOnly",false);captured.Add("baselinePixelStable",false);return Data("performed",true,"attempted",!reused,"revision",captured["revision"],"editorFocused",true,"inputSent",!reused,"editorFocusReused",reused,"postFocusFrame",captured,"pointerDelivery",Get(focused,"pointerDelivery"));
    }
    static QtFrame QtGuard(Dictionary<string,object> request,bool idle,bool pixels=true,bool navigation=false) {
        QtRejectFrameAuthority(request);
        Need(QtEnableInput||!idle,"QT_INPUT_DISABLED");QtFrame frame=QtCurrent;
        Need(frame!=null&&Text(request,"token")==frame.Token&&Text(request,"epoch")==QtEpoch,"QT_OBSERVATION_REQUIRED");
        QtFramePurpose(frame,navigation);
        QtCheckUiaControlLease(frame);
        Need(UtcMs()-frame.Issued>=0&&UtcMs()-frame.Issued<=30000,"QT_OBSERVATION_EXPIRED");
        Need(Number(Get(request,"revision"))==frame.Revision&&Interlocked.Read(ref Revision)==frame.Revision,"QT_HUMAN_ACTIVITY_CHANGED");
        Binding actual=QtBound(!frame.MetadataOnly);Need(QtSameBinding(frame.Binding,actual),"QT_BINDING_CHANGED");
        if(frame.MetadataOnly)QtCheckUiaFrame(frame);
        else if(pixels){QtFramePopupStable(frame);
        for(int index=0;index<frame.Anchors.Count;index++)QtNeedAnchorPixels(frame.Anchors[index].Hash,QtHash(QtPixels(actual,frame.Anchors[index].Rect)),"guard",index);}
        Need(Interlocked.Read(ref Revision)==frame.Revision,"QT_HUMAN_ACTIVITY_CHANGED");NoKeysHeld();
        if(idle){long minimum=Number(Get(request,"idleMs"));Need(minimum>=1000&&minimum<=300000,"QT_IDLE_INVALID");QtRequireIdle(minimum);}
        return frame;
    }
    static void QtFramePopupStable(QtFrame frame){if(frame.PopupBounds.HasValue){Rect bounds,client;if(!(QtPopup!=null&&QtPopup.Observed&&GetWindowRect(QtPopup.Window,out bounds)&&GetClientRect(QtPopup.Window,out client)&&Same(bounds,frame.PopupBounds.Value)&&Same(client,frame.PopupClient.Value)))throw QtPopupBindingChanged(QtPopup,"frame",frame);}}
    static void QtStable(QtFrame frame) { QtCheckUiaControlLease(frame);Need(!Stopping&&Interlocked.Read(ref Revision)==frame.Revision,"QT_HUMAN_ACTIVITY_CHANGED");Need(QtSameBinding(frame.Binding,QtBound(!frame.MetadataOnly)),"QT_BINDING_CHANGED");QtFramePopupStable(frame);QtCheckUiaFrame(frame);NoKeysHeld(); }
    // Metadata does not require unobscured pixels. Read-only clipboard work
    // retains the native window/focus/activity guard without rewalking UIA;
    // actual input keeps fresh roles, and mouse input rechecks its hit point.
    static void QtInputStable(QtFrame frame,bool refreshControls=true){QtCheckUiaControlLease(frame);Need(!Stopping&&Interlocked.Read(ref Revision)==frame.Revision,"QT_HUMAN_ACTIVITY_CHANGED");Need(QtSameBinding(frame.Binding,QtBound(!frame.MetadataOnly)),"QT_BINDING_CHANGED");if(refreshControls)QtCheckUiaFrame(frame);Need(frame.Revision==Interlocked.Read(ref Revision),"QT_HUMAN_ACTIVITY_CHANGED");NoKeysHeld();}
    static Input[] QtChord(string key) {
        if(key=="Control+F")return new[]{Key(0x11,0),Key(0x46,0),Key(0x46,2),Key(0x11,2)};
        if(key=="Control+A")return ChordEvents(0x41);
        if(key=="Control+C")return ChordEvents(0x43);
        if(key=="Control+End")return ChordEvents(0x23);
        if(key=="Escape")return new[]{Key(0x1b,0),Key(0x1b,2)};
        // Generic Enter stays forbidden; dedicated actions require a one-use
        // proof of the complete text just read back by this native process.
        throw new Fault("QT_CHORD_FORBIDDEN");
    }
    static object QtAct(Dictionary<string,object> request,string action,bool uiaOpenSearch=false,bool uiaEditor=false) {
        QtRevokeEnter();
        QtEmptyPhaseProof=null;
        QtRevokeQueryClick(QtPopup);
        if(uiaOpenSearch){QtUiaNavigationContext();Need(action=="chord"&&Text(request,"key")=="Control+F"&&QtNavigationLeaseMatches(QtCurrent,QtLease),"QT_UIA_NAVIGATION_UNAVAILABLE");}
        if(uiaEditor){QtUiaNavigationContext();Need(!uiaOpenSearch&&action=="click"&&QtNavigationLeaseMatches(QtCurrent,QtLease)&&Get(request,"popupTransition")==null&&QtCurrent.Anchors.Count==1&&QtUiaEditorRegion(ParseRect(Get(request,"rect")),QtCurrent.Anchors[0].Rect,QtCurrent.Binding.Client),"QT_UIA_NAVIGATION_UNAVAILABLE");}
        bool navigation=uiaOpenSearch||uiaEditor;QtFrame frame=QtGuard(request,true,!navigation,navigation);Input[] inputs;Point destination=new Point(0,0);bool pointerAction=action=="click"||action=="movePointer";QtPopupLease queryClick=null,pending=QtPreparePopupTransition(Get(request,"popupTransition"),frame,action,Text(request,"key"),Get(request,"rect"));
        if(uiaEditor){var editorRole=QtUiaResolveRoles(frame.Binding,new[]{"editor"})["editor"];Need(Same(editorRole.Node.Rect,ParseRect(Get(request,"rect"))),"QT_UIA_CONTROL_RECT_CHANGED");
            var delivery=QtUiaPointerClick(frame,editorRole,"editor-focus",delegate{QtCurrent=null;});return Data("performed",true,"attempted",delivery!=null,"revision",frame.Revision,"editorFocusReused",delivery==null,"pointerDelivery",delivery);}
        if(action=="type") {if(Text(request,"text")=="\n"){Need(Text(request,"newlineKey")=="Shift+Enter","QT_NEWLINE_CALIBRATION_REQUIRED");inputs=new[]{Key(0x10,0),Key(0x0d,0),Key(0x0d,2),Key(0x10,2)};}else inputs=TextEvents(Text(request,"text"));}
        else if(action=="chord") inputs=QtChord(Text(request,"key"));
        else {
            Rect rect=ParseRect(Get(request,"rect"));Need(Contains(frame.Binding.Client,rect),"QT_REGION_INVALID");
            Point center=new Point(frame.Binding.Capture.Left+rect.Left+rect.Width/2,frame.Binding.Capture.Top+rect.Top+rect.Height/2);
            if(action=="movePointer"){
                bool anchored=false;foreach(var anchor in frame.Anchors)if(Same(anchor.Rect,rect))anchored=true;
                Need(QtCanParkPointer(QtSurface,rect,frame.Binding.Client.Width,anchored),"QT_POINTER_PARK_INVALID");
            }
            IntPtr hit=WindowFromPoint(center);bool acceptedPopup=false;
            if(QtSearchSurface(QtSurface)&&QtPopup!=null&&Owned(hit,QtPopup.Window,frame.Binding.Pid)){
                bool anchored=false;foreach(var anchor in frame.Anchors)if(Contains(anchor.Rect,rect))anchored=true;
                acceptedPopup=anchored&&Contains(QtPopup.Observed?QtPopupClientInRoot(QtPopup):QtPopup.Calibration.RelativeWindow,rect)&&QtPopupWindowMatches(QtPopup.Window,QtPopup);
            }
            Need(Owned(hit,frame.Binding.Window,frame.Binding.Pid)||acceptedPopup,"QT_CLICK_OBSCURED");
            if(action=="click"&&QtSearchQueryClickEligible(QtSurface,frame,QtPopup,rect,Owned(hit,frame.Binding.Window,frame.Binding.Pid)))queryClick=QtPopup;
            destination=center;inputs=action=="movePointer"?QtPointerEvents(center,QtDesktopRect()):ClickEvents(center.X,center.Y,QtDesktopRect());
        }
        Need(!frame.MetadataOnly||navigation,"QT_UIA_ACTION_FORBIDDEN");
        QtStable(frame);if(frame.MetadataOnly&&pointerAction)Need(Owned(WindowFromPoint(destination),frame.Binding.Window,frame.Binding.Pid),"QT_CLICK_OBSCURED");QtCurrent=null;InputAttempted=true;
        if(action=="click")ObserveMouseIntent(0x201,destination);
        uint accepted=SendInput((uint)inputs.Length,inputs,Marshal.SizeOf(typeof(Input)));
        if(accepted!=inputs.Length){QtPendingPopup=null;if(pointerAction&&accepted>0&&QtLease!=null){QtLease.PointerMoved=true;QtLease.PointerCertain=false;}Input[] release=action=="click"?ClickReleases(accepted):Releases(inputs,accepted);if(release.Length>0)SendInput((uint)release.Length,release,Marshal.SizeOf(typeof(Input)));throw new Fault("QT_INPUT_UNCERTAIN");}
        if(pointerAction)QtRememberPointer(destination,frame.Revision);
        if(queryClick!=null){QtStable(frame);Need(Object.ReferenceEquals(queryClick,QtPopup),"QT_POPUP_BINDING_CHANGED");queryClick.QueryClick=new QtQueryClickProof{Popup=queryClick,Frame=frame,Epoch=QtEpoch};}
        if(action=="movePointer"){QtStable(frame);return Data("performed",true,"attempted",true,"revision",frame.Revision,"pointerParked",true,"focusPreserved",true);}
        if(pending!=null){QtPendingPopup=pending;QtPopup=null;}
        return uiaOpenSearch?Data("performed",true,"attempted",true,"revision",Interlocked.Read(ref Revision),"navigationOnly",true,"openedSearch",true,"baselinePixelStable",false):Data("performed",true,"attempted",true,"revision",Interlocked.Read(ref Revision));
    }
    static void QtPause(QtFrame frame,int milliseconds){long end=Now()+milliseconds;while(Now()<end){Thread.Sleep(10);QtStable(frame);}}
    static string QtFormatName(uint format){if(format<0xc000)return null;var name=new StringBuilder(129);return GetClipboardFormatName(format,name,name.Capacity)>0?name.ToString():null;}
    // Chromium's CustomPlatformType/ClipboardFormatType use TYMED_HGLOBAL;
    // SourceRFHToken is serialized Pickle bytes and InternalSourceUrl is bytes.
    // Preserve both as opaque data; never parse, follow or print the source URL.
    static bool QtBackupFormat(uint format,string name){return SafeFormat(format)||format==8||format==15||format==17||format>=0xc000&&(name=="HTML Format"||name=="Rich Text Format"||name=="PNG"||name=="image/png"||name=="Chromium internal source RFH token"||name=="Chromium internal source URL"||name=="Chromium Web Custom MIME Data Format"||name=="CanIncludeInClipboardHistory"||name=="CanUploadToCloudClipboard");}
    static object QtClipboardFormats(IntPtr owner){Need(OpenClipboard(owner),"DRAFT_CLIPBOARD_BUSY");try{int total=CountClipboardFormats();uint format=0;var entries=new List<object>();while((format=EnumClipboardFormats(format))!=0&&entries.Count<32){string name=QtFormatName(format);entries.Add(Data("id",format,"registeredName",name,"backupSupported",QtBackupFormat(format,name)));}return Data("formats",entries,"total",total,"truncated",total>entries.Count,"payloadIncluded",false,"clipboardModified",false,"inputSent",false);}finally{CloseClipboard();}}
    static bool QtOriginalClipboardBlocked(string code,bool restoring,bool attempted){
        if(restoring||attempted)return false;
        return code=="DRAFT_CLIPBOARD_COMPLEX_FORMAT"||code=="DRAFT_CLIPBOARD_DATA_TOO_LARGE"||code=="DRAFT_CLIPBOARD_DATA_UNAVAILABLE"||code=="DRAFT_CLIPBOARD_FORMAT_INVALID";
    }
    static bool QtAllowClipboardReplacement(Dictionary<string,object> request){
        if(!request.ContainsKey("allowClipboardReplacement"))return false;
        string action=Text(request,"action");
        Need((action=="paste"||action=="pasteImage"||action=="pasteUiaImage"||action=="pasteUiaFile")&&Get(request,"allowClipboardReplacement") is bool,"QT_PASTE_POLICY_INVALID");
        return (bool)Get(request,"allowClipboardReplacement");
    }
    const int QtMaxClipboardBackupFormats=32;
    static uint QtNextClipboardFormat(uint previous){
        FocusClearLastError(0);
        uint next=EnumClipboardFormats(previous);
        if(next==0)Need(Marshal.GetLastWin32Error()==0,"DRAFT_CLIPBOARD_CHANGED");
        return next;
    }
    static int QtClipboardFormatCount(){
        FocusClearLastError(0);
        int count=CountClipboardFormats();
        if(count==0){
            // Win32 uses zero both for an empty clipboard and for a failed
            // count. A locked enumeration must independently reach its end.
            Need(Marshal.GetLastWin32Error()==0&&QtNextClipboardFormat(0)==0,"DRAFT_CLIPBOARD_CHANGED");
        }
        return count;
    }
    static ClipboardState QtOriginalClipboardBaseline(int count,uint sequence,IntPtr window,uint pid,bool allowReplacement){
        var state=new ClipboardState{Sequence=sequence,OwnerWindow=window,OwnerPid=pid};
        // An empty clipboard is fully representable, regardless of whether its
        // last owner still has a window. Never treat zero formats as a refusal.
        if(count>QtMaxClipboardBackupFormats&&allowReplacement)state.ReplaceOnPaste=true;
        return state;
    }
    static void QtSelectBackupFormat(ClipboardState original,List<uint> formats,uint id,string name,bool canReplace){
        if(formats.Count<QtMaxClipboardBackupFormats&&QtBackupFormat(id,name)){
            formats.Add(id);
            return;
        }
        Need(canReplace,"DRAFT_CLIPBOARD_COMPLEX_FORMAT");
        original.ReplaceOnPaste=true;
    }
    static ClipboardState QtReadOriginalClipboard(IntPtr owner,bool restoring=false,bool allowReplacement=false){Need(OpenClipboard(owner),"DRAFT_CLIPBOARD_BUSY");try{
        bool canReplace=allowReplacement&&!restoring&&!InputAttempted;
        int count=QtClipboardFormatCount();var result=QtOriginalClipboardBaseline(count,GetClipboardSequenceNumber(),GetClipboardOwner(),ClipboardOwnerPid(),canReplace);
        if(count==0)return result;
        Need(count>0&&(count<=QtMaxClipboardBackupFormats||canReplace),"DRAFT_CLIPBOARD_COMPLEX_FORMAT");
        // Inspect the offered types before requesting delayed data. Some image
        // editors offer a perfectly usable PNG/DIB alongside a private OLE handle.
        var formats=new List<uint>();uint format=0;int seen=0;
        while((format=QtNextClipboardFormat(format))!=0){
            Need(++seen<=count,"DRAFT_CLIPBOARD_CHANGED");
            // CF_BITMAP is a GDI handle, not GlobalAlloc memory. Its lossless
            // DIB companion is backed up; Windows regenerates the bitmap.
            if(format==2&&(IsClipboardFormatAvailable(8)||IsClipboardFormatAvailable(17)))continue;
            QtSelectBackupFormat(result,formats,format,QtFormatName(format),canReplace);
        }
        Need(seen==count,"DRAFT_CLIPBOARD_CHANGED");
        int remaining=64*1024*1024;
        foreach(uint id in formats){
            try{
                byte[] bytes=ClipboardBytes(id,Math.Min(remaining,32*1024*1024));
                Need(id!=16||bytes.Length==4,"DRAFT_CLIPBOARD_FORMAT_INVALID");
                result.Formats.Add(new ClipFormat{Id=id,Bytes=bytes});remaining-=bytes.Length;
            }catch(Fault error){
                if(!canReplace||!QtOriginalClipboardBlocked(error.Message,false,false))throw;
                result.ReplaceOnPaste=true;
            }
        }
        Need(result.OwnerWindow==GetClipboardOwner()&&result.OwnerPid==ClipboardOwnerPid()&&QtClipboardFormatCount()==count,"DRAFT_CLIPBOARD_CHANGED");
        // Resolving a synthesized format may update the sequence while this
        // process still holds the clipboard lock; no other writer can enter.
        result.Sequence=GetClipboardSequenceNumber();return result;
    }catch(Fault error){
        if(QtOriginalClipboardBlocked(error.Message,restoring,InputAttempted)){
            error.Data["QtOriginalClipboardBlocked"]=true;
        }
        throw;
    }finally{CloseClipboard();}}
    static bool QtOriginalClipboardMatches(ClipboardState state,uint sequence,IntPtr window,uint pid){
        return state.Sequence==sequence&&state.OwnerWindow==window&&state.OwnerPid==pid;
    }
    static bool QtOriginalClipboardStillCurrent(ClipboardState state){
        return QtOriginalClipboardMatches(state,GetClipboardSequenceNumber(),GetClipboardOwner(),ClipboardOwnerPid());
    }
    static void QtClearOwnedForRestore(uint expected,uint expectedOwner,uint current,uint currentOwner,Func<bool> empty){
        Need(current==expected&&currentOwner==expectedOwner,"DRAFT_CLIPBOARD_CHANGED");
        Need(empty(),"DRAFT_CLIPBOARD_RESTORE_FAILED");
    }
    static bool QtRestoreOriginalClipboard(IntPtr owner,ClipboardState original,uint sequence,uint expectedOwner){
        var handles=new List<IntPtr>();try{
            foreach(var format in original.Formats){IntPtr handle=GlobalAlloc(0x42,new UIntPtr((uint)format.Bytes.Length));Need(handle!=IntPtr.Zero,"DRAFT_CLIPBOARD_RESTORE_FAILED");handles.Add(handle);IntPtr memory=GlobalLock(handle);Need(memory!=IntPtr.Zero,"DRAFT_CLIPBOARD_RESTORE_FAILED");try{Marshal.Copy(format.Bytes,0,memory,format.Bytes.Length);}finally{GlobalUnlock(handle);}}
            // Clipboard listeners can hold a short read lock immediately after
            // the paste. Retry only that lock, never repeat the actual input.
            long deadline=Now()+350;
            while(!OpenClipboard(owner)){
                Need(GetClipboardSequenceNumber()==sequence&&ClipboardOwnerPid()==expectedOwner,"DRAFT_CLIPBOARD_CHANGED");
                Need(Now()<deadline,"DRAFT_CLIPBOARD_BUSY");Thread.Sleep(5);
            }
            try{
                // Physical movement may stop keyboard actions, but restoring the
                // still-owned exact copy is safe. A newer clipboard is never touched.
                QtClearOwnedForRestore(sequence,expectedOwner,GetClipboardSequenceNumber(),ClipboardOwnerPid(),EmptyClipboard);
                if(original.Formats.Count==0)return QtClipboardFormatCount()==0;
                for(int index=0;index<handles.Count;index++){Need(SetClipboardData(original.Formats[index].Id,handles[index])!=IntPtr.Zero,"DRAFT_CLIPBOARD_RESTORE_FAILED");handles[index]=IntPtr.Zero;}
                // All captured handles have been accepted while still locked.
                // Windows can synthesize additional types from a partial image.
                if(original.ReplaceOnPaste)return GetClipboardOwner()==owner;
            }finally{CloseClipboard();}
            ClipboardState restored=QtReadOriginalClipboard(owner,true);return restored.OwnerPid==GetCurrentProcessId()&&SamePayload(original,restored);
        }finally{foreach(IntPtr handle in handles)if(handle!=IntPtr.Zero)GlobalFree(handle);}
    }
    static bool QtKeepPublishedPaste(ClipboardState original,bool search){
        return original.ReplaceOnPaste&&original.Formats.Count==0&&!search;
    }
    static bool QtFinishPasteClipboard(IntPtr owner,ClipboardState original,bool changed,bool published,uint sequence,uint ownerPid,bool search=false){
        if(changed&&original.ReplaceOnPaste){
            QtClipboardRestoreObserved=false;
            // Restore usable representations even on an interrupted paste. If
            // none exist, remove our transient search text before the body can
            // take a new snapshot. A later user copy wins via the sequence guard.
            if(!QtKeepPublishedPaste(original,search)){
                Need(QtRestoreOriginalClipboard(owner,original,sequence,ownerPid),"DRAFT_CLIPBOARD_RESTORE_UNCONFIRMED");
            }else{
                Need(GetClipboardSequenceNumber()==sequence&&ClipboardOwnerPid()==ownerPid,"DRAFT_CLIPBOARD_CHANGED");
            }
            Need(published,"DRAFT_CLIPBOARD_PUBLICATION_UNCONFIRMED");
            QtClipboardReplacedObserved=true;
            return false;
        }
        bool restored=changed?QtRestoreOriginalClipboard(owner,original,sequence,ownerPid):QtOriginalClipboardStillCurrent(original);
        QtClipboardRestoreObserved=restored;Need(restored,"DRAFT_CLIPBOARD_RESTORE_UNCONFIRMED");return true;
    }
    static string QtSchemaName(string name){return name!=null&&System.Text.RegularExpressions.Regex.IsMatch(name,"^[A-Za-z_][A-Za-z0-9_.:-]{0,63}$")?name:"unsupported-name";}
    static string QtUtf8Payload(byte[] bytes){int length=bytes.Length;while(length>0&&bytes[length-1]==0)length--;string value=new UTF8Encoding(false,true).GetString(bytes,0,length);if(value.Length>0&&value[0]=='\ufeff')value=value.Substring(1);return value;}
    static XmlDocument QtXml(string text){var settings=new XmlReaderSettings{DtdProcessing=DtdProcessing.Prohibit,XmlResolver=null,MaxCharactersInDocument=131072,MaxCharactersFromEntities=0};var document=new XmlDocument{XmlResolver=null,PreserveWhitespace=true};using(var reader=XmlReader.Create(new StringReader(text),settings))document.Load(reader);return document;}
    static object QtDescribePayload(string format,byte[] bytes,string draft){
        var result=Data("formatName",format,"payloadIncluded",false,"byteLength",bytes.Length,"exactUtf8Text",EncodedTextOnly(bytes,Encoding.UTF8.GetBytes(draft),1),"exactUtf16Text",EncodedTextOnly(bytes,Encoding.Unicode.GetBytes(draft),2));
        string text;try{text=QtUtf8Payload(bytes);result["validUtf8"]=true;}catch{result["validUtf8"]=false;return result;}
        result["textPlainMime"]=text=="text/plain";
        result["asciiDecimal10"]=System.Text.RegularExpressions.Regex.IsMatch(text,"^[0-9]{10}$");long timestamp;
        result["unixSecondsNearNow"]=Int64.TryParse(text,NumberStyles.None,CultureInfo.InvariantCulture,out timestamp)&&Math.Abs(UtcMs()/1000-timestamp)<=10;
        string trimmed=text.TrimStart();result["startsWithXml"]=trimmed.StartsWith("<",StringComparison.Ordinal);result["startsWithJson"]=trimmed.StartsWith("{",StringComparison.Ordinal)||trimmed.StartsWith("[",StringComparison.Ordinal);
        if(!trimmed.StartsWith("<",StringComparison.Ordinal))return result;
        try{
            XmlDocument document=QtXml(text);var nodes=new List<object>();var pending=new Queue<XmlNode>();pending.Enqueue(document.DocumentElement);int total=0;
            while(pending.Count>0){XmlNode node=pending.Dequeue();Need(++total<=64,"QT_STRUCTURE_LIMIT");var attributes=new List<object>();
                if(node.Attributes!=null)foreach(XmlAttribute attribute in node.Attributes){Need(attributes.Count<16,"QT_STRUCTURE_LIMIT");string value=attribute.Value;attributes.Add(Data("name",QtSchemaName(attribute.Name),"empty",value.Length==0,"zero",value=="0","one",value=="1","numeric",System.Text.RegularExpressions.Regex.IsMatch(value,"^[0-9]{1,20}$"),"matchesDraft",value==draft));}
                var children=new List<string>();foreach(XmlNode child in node.ChildNodes)if(child.NodeType==XmlNodeType.Element){children.Add(QtSchemaName(child.Name));pending.Enqueue(child);}
                nodes.Add(Data("name",QtSchemaName(node.Name),"attributes",attributes,"children",children,"textMatchesDraft",node.InnerText==draft,"textEmpty",node.InnerText.Length==0,"textWhitespace",String.IsNullOrWhiteSpace(node.InnerText)));
            }
            result["xmlParsed"]=true;result["root"]=QtSchemaName(document.DocumentElement.Name);result["nodes"]=nodes;
        }catch{result["xmlParsed"]=false;}
        return result;
    }
    static bool QtPlainRichPayload(string format,byte[] bytes,string draft){
        try{
            // This companion is a numeric copy metadata token on this client,
            // not a MIME type or payload. Both independent rich documents below
            // must still describe only type=0 text matching CF_UNICODETEXT.
            string text=QtUtf8Payload(bytes);if(format=="x-application-mimetype-xwechat")return System.Text.RegularExpressions.Regex.IsMatch(text,"^[0-9]{10}$");
            string rootName=format=="WeChat_RichEdit_Format"?"WeChatRichEditFormat":format=="QQ_Unicode_RichEdit_Format"?"QQRichEditFormat":null;
            if(rootName==null||String.IsNullOrEmpty(draft))return false;
            XmlDocument document=QtXml(text);XmlElement root=document.DocumentElement;if(root==null||root.Name!=rootName||root.NamespaceURI.Length!=0||root.Attributes.Count!=0)return false;
            foreach(XmlNode node in document.ChildNodes)if(node!=root&&node.NodeType!=XmlNodeType.XmlDeclaration&&node.NodeType!=XmlNodeType.Whitespace)return false;
            var plain=new StringBuilder();int elements=0;
            foreach(XmlNode element in root.ChildNodes){
                if(element.NodeType!=XmlNodeType.Element||element.Name!="EditElement"||element.NamespaceURI.Length!=0||element.Attributes==null||element.Attributes.Count!=1||element.Attributes["type"]==null||element.Attributes["type"].Value!="0"||++elements>4096)return false;
                foreach(XmlNode part in element.ChildNodes){if(part.NodeType!=XmlNodeType.Text&&part.NodeType!=XmlNodeType.CDATA&&part.NodeType!=XmlNodeType.Whitespace&&part.NodeType!=XmlNodeType.SignificantWhitespace)return false;plain.Append(part.Value);if(plain.Length>16000)return false;}
            }
            return elements>0&&String.Equals(plain.ToString(),draft,StringComparison.Ordinal);
        }catch{return false;}
    }
    static HashSet<string> QtEmptyTemplates(Dictionary<string,object> request){
        string primary=Text(request,"emptyEditorSha256");Need(Hex(primary,64),"QT_EMPTY_TEMPLATES_INVALID");var result=new HashSet<string>(StringComparer.Ordinal);result.Add(primary);
        if(request.ContainsKey("emptyEditorSha256s")){object[] variants=Get(request,"emptyEditorSha256s") as object[];Need(variants!=null&&variants.Length>=1&&variants.Length<=4,"QT_EMPTY_TEMPLATES_INVALID");var unique=new HashSet<string>(StringComparer.Ordinal);
            foreach(object item in variants){string value=item as string;Need(Hex(value,64)&&unique.Add(value),"QT_EMPTY_TEMPLATES_INVALID");result.Add(value);}Need(result.Count<=4,"QT_EMPTY_TEMPLATES_INVALID");}
        return result;
    }
    // Scalar diagnostics only: never retain pixels/hashes or use elapsed values
    // in a decision. The observer clock is separate from the deadline clock so
    // instrumentation cannot change its reads, guards, samples or sleep calls.
    sealed class QtEmptyWaitTiming {
        readonly Func<long> Observe;readonly long Started;
        internal long Samples,GuardMs,CaptureMs,WaitMs,SettleMs;internal long? FirstMatchAfterMs;
        internal QtEmptyWaitTiming(Func<long> observe){Observe=observe;Started=observe();}
        internal void Guard(Action action){long start=Observe();try{action();}finally{GuardMs+=Math.Max(0,Observe()-start);}}
        internal string Capture(Func<string> action){long start=Observe();Samples++;try{return action();}finally{CaptureMs+=Math.Max(0,Observe()-start);}}
        internal void Wait(Action<int> action,int milliseconds){long start=Observe();try{action(milliseconds);}finally{WaitMs+=Math.Max(0,Observe()-start);}}
        internal void Matched(){if(!FirstMatchAfterMs.HasValue)FirstMatchAfterMs=Math.Max(0,Observe()-Started);}
        internal object Report(){return Data("sampleCount",Samples,"firstMatchAfterMs",FirstMatchAfterMs,"guardMs",GuardMs,"captureMs",CaptureMs,"waitMs",WaitMs,"settleMs",SettleMs);}
    }
    // Candidate samples must resolve to an exact complete known image. The
    // initial-copy caller may normalize only the strict caret below; unknown
    // pixels still use this same bounded observation, never a similarity score.
    static bool QtWaitEmptyTemplate(HashSet<string> expected,long deadline,Action guard,Func<string> sample,Func<long> now,Action<int> wait){
        return QtWaitEmptyTemplate(expected,deadline,guard,sample,now,wait,null);
    }
    static bool QtWaitEmptyTemplate(HashSet<string> expected,long deadline,Action guard,Func<string> sample,Func<long> now,Action<int> wait,QtEmptyWaitTiming timing){
        Action checkedGuard=guard;Func<string> capturedSample=sample;Action<int> measuredWait=wait;
        if(timing!=null){checkedGuard=delegate{timing.Guard(guard);};capturedSample=delegate{return timing.Capture(sample);};measuredWait=delegate(int milliseconds){timing.Wait(wait,milliseconds);};}
        for(;;){checkedGuard();if(now()>=deadline)return false;string actual=capturedSample();checkedGuard();if(now()>deadline)return false;if(expected.Contains(actual)){if(timing!=null)timing.Matched();return true;}long remaining=deadline-now();if(remaining<=0)return false;measuredWait((int)Math.Min(25,remaining));}
    }
    // A transaction-local proof can only follow a successful empty Ctrl+A/C
    // check and confirmed clipboard restoration. It does not calibrate a new
    // persistent template or excuse any later input, identity or pixel change.
    static object QtIssueEmptyPhaseProof(QtFrame frame,Rect editor,HashSet<string> known){
        if(QtSurface!="main"||QtPopup!=null||QtPendingPopup!=null)return null;
        // readDraft deliberately guards a stable header-only frame: its
        // separate whole-editor blank comparison already proved this exact
        // editor rectangle, without anchoring a blinking pre-copy caret.
        var other=new List<QtAnchor>();foreach(var anchor in frame.Anchors)if(!Intersects(anchor.Rect,editor))other.Add(new QtAnchor{Rect=anchor.Rect,Hash=anchor.Hash});
        if(other.Count==0)return null;
        QtEmptyPhaseProof=new QtEmptyPhaseLease{Id=Guid.NewGuid().ToString("N"),Epoch=QtEpoch,Binding=frame.Binding,Revision=frame.Revision,Issued=Now(),Editor=editor,Known=new HashSet<string>(known,StringComparer.Ordinal),OtherAnchors=other};
        var hashes=new List<string>(known);hashes.Sort(StringComparer.Ordinal);
        return Data("version",1,"id",QtEmptyPhaseProof.Id,"editorRect",editor.Report(),"knownEmptySha256s",hashes);
    }
    static bool QtEmptyPhaseBound(QtEmptyPhaseLease proof,string id,QtFrame frame,long now,string surface,bool popup){
        if(proof==null||frame==null||id!=proof.Id||proof.Epoch!=QtEpoch||surface!="main"||popup||now<proof.Issued||now-proof.Issued>30000||proof.Revision!=frame.Revision||!QtSameBinding(proof.Binding,frame.Binding)||proof.Binding.Thread!=frame.Binding.Thread)return false;
        bool editor=false;foreach(var anchor in frame.Anchors)if(Same(anchor.Rect,proof.Editor))editor=true;if(!editor||proof.OtherAnchors==null||proof.OtherAnchors.Count==0)return false;
        foreach(var saved in proof.OtherAnchors){bool same=false;foreach(var anchor in frame.Anchors)if(Same(anchor.Rect,saved.Rect)&&anchor.Hash==saved.Hash)same=true;if(!same)return false;}return true;
    }
    static bool QtGreenCaret(byte[] pixels,int offset){int r=pixels[offset],g=pixels[offset+1],b=pixels[offset+2];return pixels[offset+3]==255&&r<=32&&g>=120&&g<=220&&b>=64&&b<=128&&g-b>=40;}
    static object QtEmptyPhasePixels(byte[] pixels,Rect editor,uint dpi,HashSet<string> known){
        int width=editor.Width,height=editor.Height;Need(width>=100&&height>=40&&width<=4096&&height<=4096&&dpi>=96&&dpi<=240&&pixels!=null&&pixels.Length==checked(width*height*4)&&known!=null&&known.Count>0&&known.Count<=4,"QT_EMPTY_PHASE_UNVERIFIED");
        for(int offset=3;offset<pixels.Length;offset+=4)Need(pixels[offset]==255,"QT_EMPTY_PHASE_UNVERIFIED");
        string actual=QtHash(pixels);if(known.Contains(actual))return Data("actualRgbaSha256",actual,"normalizedRgbaSha256",actual,"caretRemoved",false);
        int center=((height/2)*width+width/2)*4;byte red=pixels[center],green=pixels[center+1],blue=pixels[center+2];Need(Math.Max(red,Math.Max(green,blue))-Math.Min(red,Math.Min(green,blue))<=3,"QT_EMPTY_PHASE_UNVERIFIED");
        for(int y=height/2-1;y<=height/2+1;y++)for(int x=width/2-1;x<=width/2+1;x++){int at=(y*width+x)*4;Need(pixels[at]==red&&pixels[at+1]==green&&pixels[at+2]==blue,"QT_EMPTY_PHASE_UNVERIFIED");}
        int left=width,top=height,right=0,bottom=0,count=0;for(int y=0;y<height;y++)for(int x=0;x<width;x++){int at=(y*width+x)*4;if(QtGreenCaret(pixels,at)){left=Math.Min(left,x);right=Math.Max(right,x+1);top=Math.Min(top,y);bottom=Math.Max(bottom,y+1);count++;}}
        double scale=dpi/96.0;Need(count>0&&right-left<=Math.Ceiling(2*scale)&&bottom-top>=Math.Floor(8*scale)&&bottom-top<=Math.Ceiling(32*scale)&&left<=Math.Ceiling(40*scale)&&top<=Math.Ceiling(32*scale)&&count==(right-left)*(bottom-top),"QT_EMPTY_PHASE_UNVERIFIED");
        int first=(top*width+left)*4;var normalized=(byte[])pixels.Clone();for(int y=top;y<bottom;y++)for(int x=left;x<right;x++){int at=(y*width+x)*4;Need(QtGreenCaret(pixels,at)&&pixels[at]==pixels[first]&&pixels[at+1]==pixels[first+1]&&pixels[at+2]==pixels[first+2],"QT_EMPTY_PHASE_UNVERIFIED");normalized[at]=red;normalized[at+1]=green;normalized[at+2]=blue;}
        string empty=QtHash(normalized);Need(known.Contains(empty),"QT_EMPTY_PHASE_UNVERIFIED");return Data("actualRgbaSha256",actual,"normalizedRgbaSha256",empty,"caretRemoved",true);
    }
    // Called only after the full asynchronous Ctrl+A/C observation completed
    // without a clipboard update. This is pixel evidence, not a phase proof:
    // the unchanged-clipboard guards and final restoration still have to pass.
    // Keep the original full-image fast path. Otherwise only a unique strict
    // caret can be removed, and every remaining pixel must match a known full
    // editor image. Do not learn a new template or mutate the captured pixels.
    static string QtInitialEmptyTemplate(byte[] pixels,Rect editor,uint dpi,HashSet<string> known,out bool caretNormalized){
        caretNormalized=false;string actual=QtHash(pixels);if(known.Contains(actual))return actual;
        try{var candidate=Map(QtEmptyPhasePixels(pixels,editor,dpi,known));caretNormalized=Object.Equals(Get(candidate,"caretRemoved"),true);return Text(candidate,"normalizedRgbaSha256");}
        catch(Fault error){if(error.Message!="QT_EMPTY_PHASE_UNVERIFIED")throw;return actual;}
    }
    static object QtInspectEmptyEditorPhase(Dictionary<string,object> request){
        string id=Text(request,"emptyDraftPhaseProofId");Need(Hex(id,32),"QT_EMPTY_PHASE_PROOF_INVALID");QtFrame frame=QtGuard(request,false);var proof=QtEmptyPhaseProof;
        Need(QtEmptyPhaseBound(proof,id,frame,Now(),QtSurface,QtPopup!=null||QtPendingPopup!=null),"QT_EMPTY_PHASE_PROOF_INVALID");QtStable(frame);
        var pixels=Map(QtEmptyPhasePixels(QtPixels(frame.Binding,proof.Editor),proof.Editor,frame.Binding.Dpi,proof.Known));string actual=Text(pixels,"actualRgbaSha256");
        bool matches=false;foreach(var anchor in frame.Anchors)if(Same(anchor.Rect,proof.Editor)&&anchor.Hash==actual)matches=true;Need(matches,"QT_EMPTY_PHASE_CHANGED");
        // Re-read every supplied anchor, including the entire editor, after
        // normalization. A blink during this read fails closed, never retries.
        QtGuard(request,false);Need(Object.ReferenceEquals(proof,QtEmptyPhaseProof)&&QtEmptyPhaseBound(proof,id,frame,Now(),QtSurface,QtPopup!=null||QtPendingPopup!=null),"QT_EMPTY_PHASE_PROOF_INVALID");QtStable(frame);
        return Data("version",1,"emptyDraftPhaseVerified",true,"proofId",proof.Id,"actualRgbaSha256",actual,"normalizedRgbaSha256",Text(pixels,"normalizedRgbaSha256"),"caretRemoved",Get(pixels,"caretRemoved"),"revision",frame.Revision,"readOnly",true,"inputSent",false);
    }
    static object QtReadDraft(Dictionary<string,object> request,IntPtr owner) {
        QtRevokeEnter();
        QtEmptyPhaseProof=null;QtRevokeQueryClick(QtPopup);
        long measureStart=Now(),measureClipboard=0,measureCopyStart=0,measureCopyEnd=0,measureReadEnd=0;
        QtEmptyWaitTiming emptyTiming=null;bool emptyCaretNormalized=false;
        bool diagnostic=Text(request,"action")=="diagnoseDraftStructure";var structure=new List<object>();
        QtClipboardRestoreObserved=true;
        QtFrame frame=QtGuard(request,true);Rect editor=ParseRect(Get(request,"editorRect"));Need(Contains(frame.Binding.Client,editor),"QT_REGION_INVALID");HashSet<string> emptyTemplates=QtEmptyTemplates(request);
        var textStep=QtParseTextStep(Get(request,"stepBinding"));
        if(request.ContainsKey("headerRect"))QtNeedDraftSource(frame,ParseRect(Get(request,"headerRect")),editor);
        QtCurrent=null;ClipboardState original=QtReadOriginalClipboard(owner);uint copied=0;bool selected=false,copyStarted=false,copyObserved=false;string draft=null;bool empty=false,restored=false;
        measureClipboard=Now();
        try {
            QtStable(frame);Need(GetClipboardSequenceNumber()==original.Sequence,"DRAFT_CLIPBOARD_CHANGED");SendEvents(ChordEvents(0x41));selected=true;QtPause(frame,50);
            Need(GetClipboardSequenceNumber()==original.Sequence,"DRAFT_CLIPBOARD_CHANGED");QtClipboardRestoreObserved=null;copyStarted=true;SendEvents(ChordEvents(0x43));
            // Ctrl+C is asynchronous in Qt. Cancellation must still observe its
            // bounded completion so finally can restore the resulting clipboard.
            // This wait does not inject any input or relax the next action guard.
            measureCopyStart=Now();long end=Now()+650;while(GetClipboardSequenceNumber()==original.Sequence&&Now()<end)Thread.Sleep(15);measureCopyEnd=Now();
            copied=GetClipboardSequenceNumber();copyObserved=true;QtStable(frame);
            if(copied==original.Sequence){
                // No clipboard update is not enough to prove an empty draft. The
                // operator-calibrated *entire editor* blank image must also match.
                SendEvents(ChordEvents(0x23));long emptyDeadline=Now()+650;QtPause(frame,50);selected=false;
                long emptySettleMs=Now()-(emptyDeadline-650);emptyTiming=new QtEmptyWaitTiming(Now);emptyTiming.SettleMs=emptySettleMs;
                Need(QtWaitEmptyTemplate(emptyTemplates,emptyDeadline,delegate{QtStable(frame);Need(GetClipboardSequenceNumber()==original.Sequence,"DRAFT_CLIPBOARD_CHANGED");},delegate{return QtInitialEmptyTemplate(QtPixels(frame.Binding,editor),editor,frame.Binding.Dpi,emptyTemplates,out emptyCaretNormalized);},Now,Thread.Sleep,emptyTiming),"QT_EMPTY_DRAFT_UNVERIFIED");empty=true;draft="";
            } else {
                Need(ClipboardOwnerPid()==frame.Binding.Pid,"DRAFT_COPY_OWNER_MISMATCH");
                Need(OpenClipboard(owner),"DRAFT_CLIPBOARD_BUSY");
                try {
                    int count=CountClipboardFormats();Need(count>0&&count<=16,"DRAFT_CLIPBOARD_COMPLEX_FORMAT");uint id=0;bool unicode=false;
                    while((id=EnumClipboardFormats(id))!=0){string name=null;if(id>=0xc000){var buffer=new StringBuilder(129);if(GetClipboardFormatName(id,buffer,buffer.Capacity)>0)name=buffer.ToString();}Need(SafeFormat(id)||id>=0xc000&&KnownCompanion(name),"DRAFT_CLIPBOARD_COMPLEX_FORMAT");if(id==13)unicode=true;}
                    Need(unicode,"DRAFT_COPY_NOT_UNICODE_TEXT");draft=DecodeUnicode(ClipboardBytes(13,131072));Need(draft.Length>0&&draft.Length<=16000,"QT_DRAFT_INVALID");
                    // A text projection must never hide an attachment that would
                    // also be sent. Accept companion payloads only when their
                    // complete bytes encode this exact plain text.
                    bool wechatText=false,qqText=false,plainMime=false;
                    id=0;while((id=EnumClipboardFormats(id))!=0){if(id<0xc000)continue;var name=new StringBuilder(129);GetClipboardFormatName(id,name,name.Capacity);string tag=name.ToString();
                        if(tag=="DataObject"||tag=="Ole Private Data")continue;
                        byte[] payload=ClipboardBytes(id,131072);
                        if(diagnostic)structure.Add(QtDescribePayload(tag,payload,draft));
                        else {Need(QtPlainRichPayload(tag,payload,draft),"QT_RICH_DRAFT_UNSUPPORTED");if(tag=="WeChat_RichEdit_Format")wechatText=true;else if(tag=="QQ_Unicode_RichEdit_Format")qqText=true;else if(tag=="x-application-mimetype-xwechat")plainMime=true;}
                    }
                    if(!diagnostic)Need(wechatText&&qqText&&plainMime,"QT_RICH_DRAFT_UNSUPPORTED");
                    Need(GetClipboardSequenceNumber()==copied&&ClipboardOwnerPid()==frame.Binding.Pid,"DRAFT_CLIPBOARD_CHANGED");
                } finally { CloseClipboard(); }
            }
            QtStable(frame);
            if(selected){SendEvents(ChordEvents(0x23));QtPause(frame,50);selected=false;}measureReadEnd=Now();
        } finally {
            // After intervention leave selection and newer clipboard untouched.
            if(copyStarted&&!copyObserved){long end=Now()+650;while(GetClipboardSequenceNumber()==original.Sequence&&Now()<end)Thread.Sleep(15);copied=GetClipboardSequenceNumber();}
            // A delayed Ctrl+C may complete during the bounded empty-image
            // sampling. Only adopt that exact WeChat-owned sequence while the
            // input revision is unchanged; a newer user clipboard is untouched.
            if(copyStarted&&copyObserved&&copied==original.Sequence&&frame.Revision==Interlocked.Read(ref Revision)&&ClipboardOwnerPid()==frame.Binding.Pid){uint late=GetClipboardSequenceNumber();if(late!=original.Sequence)copied=late;}
            if(copied!=0&&copied!=original.Sequence){restored=QtRestoreOriginalClipboard(owner,original,copied,frame.Binding.Pid);QtClipboardRestoreObserved=restored;Need(restored,"DRAFT_CLIPBOARD_RESTORE_UNCONFIRMED");}
            else restored=GetClipboardSequenceNumber()==original.Sequence;
            QtClipboardRestoreObserved=restored;
        }
        QtStable(frame);if(diagnostic)return Data("diagnosticOnly",true,"payloadIncluded",false,"formats",structure,"draftVerified",false,"richContentVerified",false,"clipboardRestored",restored,"revision",frame.Revision,"inputSent",true,"textTyped",false,"submitted",false);
        var outcome=Data("draft",draft,"emptyTemplateMatched",empty,"emptyTemplateCaretNormalized",emptyCaretNormalized,"draftVerified",true,"richContentVerified",true,"clipboardRestored",restored,"revision",frame.Revision,"inputSent",true,"timingMs",Data("guardAndClipboard",measureClipboard-measureStart,"selectAndCopy",measureCopyStart-measureClipboard,"copyWait",measureCopyEnd-measureCopyStart,"readVerification",measureReadEnd-measureCopyEnd,"restoreAndFinal",Now()-measureReadEnd,"emptyTemplateCheck",emptyTiming==null?null:emptyTiming.Report()));
        if(empty&&draft==""&&restored){object proof=QtIssueEmptyPhaseProof(frame,editor,emptyTemplates);if(proof!=null)outcome.Add("emptyDraftPhaseProof",proof);}
        if(!empty&&restored&&draft!=""&&request.ContainsKey("headerRect")){Rect header=ParseRect(Get(request,"headerRect"));QtAttachEnterProof(outcome,"text",QtNormalizeText(draft),frame,new List<QtAnchor>{new QtAnchor{Rect=header},new QtAnchor{Rect=editor}},textStep);}
        return outcome;
    }
    static string QtNormalizeText(string value){return value==null?null:value.Replace("\r\n","\n").Replace("\r","\n");}
    // Clipboard paste belongs only to this explicitly verified transaction.
    // Keep the general draft probe's ChordEvents allowlist unchanged.
    static Input[] QtPasteChord(){return new[]{Key(0x11,0),Key(0x56,0),Key(0x56,2),Key(0x11,2)};}
    static Input[] QtPasteInput(Dictionary<string,object> request,string scope){
        if(!request.ContainsKey("replaceSearch"))return QtPasteChord();
        Need(scope=="search"&&Object.Equals(Get(request,"replaceSearch"),true),"QT_SEARCH_PASTE_SCOPE_INVALID");
        // Both chords enter the same SendInput queue after the clipboard is
        // installed. No focus change or independent input token lies between
        // selection and paste; the existing full read-back proves completion.
        Input[] select=ChordEvents(0x41),paste=QtPasteChord(),events=new Input[select.Length+paste.Length];Array.Copy(select,0,events,0,select.Length);Array.Copy(paste,0,events,select.Length,paste.Length);return events;
    }
    static void QtValidatePaste(string text,string expected,string scope,string searchKind=null){
        Need((scope=="editor"||scope=="search")&&!String.IsNullOrEmpty(text)&&text.Length<=16000&&text.IndexOf('\0')<0&&!String.IsNullOrEmpty(expected)&&expected.Length<=16000&&expected.IndexOf('\0')<0,"QT_PASTE_INVALID");
        Need(searchKind==null||(scope=="search"&&(searchKind=="group-title"||searchKind=="private-name")),"QT_PASTE_SEARCH_INVALID");
        if(scope=="search")Need(text==expected&&(searchKind=="group-title"||searchKind=="private-name"?
            text.Length<=128&&text==text.Trim()&&!text.EndsWith("@chatroom",StringComparison.Ordinal)&&!System.Text.RegularExpressions.Regex.IsMatch(text,"[\\x00-\\x1f\\x7f]"):
            System.Text.RegularExpressions.Regex.IsMatch(text,"^[A-Za-z0-9_-]{1,256}$")),"QT_PASTE_SEARCH_INVALID");
    }
    static bool QtOwnPasteSnapshot(IntPtr owner,IntPtr observedOwner,uint pid,uint observedPid,bool published,uint[] formats,byte[] actual,byte[] expected){
        if(owner==IntPtr.Zero||observedOwner!=owner||pid==0||observedPid!=pid||formats==null)return false;
        if(!published)return formats.Length==0&&actual==null;
        if(formats.Length<1||formats.Length>4||actual==null||expected==null||actual.Length!=expected.Length)return false;
        bool unicode=false;var seen=new HashSet<uint>();foreach(uint format in formats){if(!seen.Add(format)||(format!=1&&format!=7&&format!=13&&format!=16))return false;if(format==13)unicode=true;}
        if(!unicode)return false;for(int index=0;index<actual.Length;index++)if(actual[index]!=expected[index])return false;return true;
    }
    // Windows may synthesize text formats and advance the sequence when a
    // newly written Unicode clipboard is closed. Reopen it and prove this is
    // still our exact HWND/PID/buffer, rather than accepting any newer sequence.
    static uint QtConfirmOwnPaste(IntPtr owner,uint pid,bool published,byte[] expected){
        for(int attempt=0;attempt<2;attempt++){
            uint observed;Need(OpenClipboard(owner),"DRAFT_CLIPBOARD_BUSY");try{
                IntPtr observedOwner=GetClipboardOwner();uint observedPid=ClipboardOwnerPid();observed=GetClipboardSequenceNumber();var formats=new List<uint>();uint format=0;
                while((format=EnumClipboardFormats(format))!=0){Need(formats.Count<4,"DRAFT_CLIPBOARD_CHANGED");formats.Add(format);}
                byte[] actual=published?ClipboardBytes(13,131072):null;
                Need(QtOwnPasteSnapshot(owner,observedOwner,pid,observedPid,published,formats.ToArray(),actual,expected),"DRAFT_CLIPBOARD_CHANGED");
                Need(GetClipboardOwner()==owner&&ClipboardOwnerPid()==pid&&GetClipboardSequenceNumber()==observed,"DRAFT_CLIPBOARD_CHANGED");
            }finally{CloseClipboard();}
            if(GetClipboardOwner()==owner&&ClipboardOwnerPid()==pid&&GetClipboardSequenceNumber()==observed)return observed;
        }
        throw new Fault("DRAFT_CLIPBOARD_CHANGED");
    }
    static void QtPutText(IntPtr owner,string text,ClipboardState previous,ref bool changed,ref uint owned,ref uint ownerPid){byte[] bytes=Encoding.Unicode.GetBytes(text+"\0");IntPtr handle=GlobalAlloc(0x42,new UIntPtr((uint)bytes.Length));Need(handle!=IntPtr.Zero,"DRAFT_CLIPBOARD_RESTORE_FAILED");try{
        ulong allocated=GlobalSize(handle).ToUInt64();Need(allocated>=(ulong)bytes.Length&&allocated<=131072,"DRAFT_CLIPBOARD_RESTORE_FAILED");byte[] exact=new byte[(int)allocated];Array.Copy(bytes,exact,bytes.Length);
        IntPtr memory=GlobalLock(handle);Need(memory!=IntPtr.Zero,"DRAFT_CLIPBOARD_RESTORE_FAILED");try{Marshal.Copy(exact,0,memory,exact.Length);}finally{GlobalUnlock(handle);}
        bool published=false;Exception failure=null;
        try{Need(OpenClipboard(owner),"DRAFT_CLIPBOARD_BUSY");try{Need(QtOriginalClipboardStillCurrent(previous),"DRAFT_CLIPBOARD_CHANGED");Need(EmptyClipboard(),"DRAFT_CLIPBOARD_RESTORE_FAILED");
            // Publish rollback ownership immediately after EmptyClipboard. A
            // SetClipboardData failure must also restore our owned empty buffer.
            changed=true;owned=GetClipboardSequenceNumber();ownerPid=GetCurrentProcessId();QtClipboardRestoreObserved=false;
            Need(SetClipboardData(13,handle)!=IntPtr.Zero,"DRAFT_CLIPBOARD_RESTORE_FAILED");handle=IntPtr.Zero;published=true;owned=GetClipboardSequenceNumber();}finally{CloseClipboard();}
        }catch(Exception error){failure=error;}
        if(changed)owned=QtConfirmOwnPaste(owner,ownerPid,published,exact);
        if(failure!=null)throw failure;
    }finally{if(handle!=IntPtr.Zero)GlobalFree(handle);}}
    // Ctrl+A/C is queued after Ctrl+V. Its exact read-back proves the target
    // consumed the pasted text before the original clipboard is restored.
    static bool QtSearchPasteCompletionScope(string scope,string surface,QtFrame frame,QtPopupLease popup){
        if(scope!="search"||surface!="observed-search"||frame==null||popup==null||!popup.Observed||popup.Id!="search"||popup.Calibration==null||popup.Calibration.Kind!="search"||popup.Window==IntPtr.Zero||popup.Root==null||frame.Binding==null||frame.Binding.Window==IntPtr.Zero||frame.Binding.Window!=popup.Root.Window||frame.Revision!=popup.Revision||!frame.PopupBounds.HasValue||!frame.PopupClient.HasValue||frame.Anchors==null||frame.Anchors.Count!=1)return false;
        return Contains(frame.Binding.Client,frame.Anchors[0].Rect);
    }
    static bool QtSearchQueryClickEligible(string surface,QtFrame frame,QtPopupLease popup,Rect clicked,bool hitMain){
        if(!hitMain||!QtSearchPasteCompletionScope("search",surface,frame,popup)||!Same(clicked,frame.Anchors[0].Rect))return false;
        int top=popup.ObservedClientScreen.Top-frame.Binding.Capture.Top,left=popup.ObservedClientScreen.Left-frame.Binding.Capture.Left,right=popup.ObservedClientScreen.Right-frame.Binding.Capture.Left;
        // A full query anchor may extend under the result popup's top edge.
        // Only an actual root-owned click above that edge can establish this
        // extra local proof; a result-row click or overlapping rectangle alone
        // cannot. Full pixels/focus are checked again before and after input.
        return clicked.Width>0&&clicked.Height>0&&clicked.Left>=left&&clicked.Right<=right&&clicked.Top+clicked.Height/2<top;
    }
    static void QtRevokeQueryClick(QtPopupLease popup){if(popup==null)return;if(popup.QueryClick!=null)popup.QueryClick.Consumed=true;popup.QueryClick=null;}
    static QtQueryClickProof QtTakeQueryClick(QtPopupLease popup){if(popup==null)return null;var proof=popup.QueryClick;popup.QueryClick=null;if(proof==null||proof.Consumed)return null;proof.Consumed=true;return proof;}
    static bool QtSearchPasteCompletionEligible(string scope,string surface,QtFrame frame,QtPopupLease popup,QtQueryClickProof proof=null,long now=-1){
        if(!QtSearchPasteCompletionScope(scope,surface,frame,popup))return false;
        // The query field is on the main window, above the causally observed
        // result popup. A result-row/profile anchor never receives this scope.
        Rect query=frame.Anchors[0].Rect;int resultTop=popup.ObservedClientScreen.Top-frame.Binding.Capture.Top;
        if(query.Bottom<=resultTop)return true;
        if(proof==null||!proof.Consumed||!Object.ReferenceEquals(proof.Popup,popup)||proof.Epoch!=QtEpoch)return false;var queryClick=proof.Frame;
        if(queryClick==null||!QtSearchQueryClickEligible(surface,queryClick,popup,query,true)||!Same(queryClick.Anchors[0].Rect,query)||queryClick.Revision!=frame.Revision||queryClick.Binding.Thread!=frame.Binding.Thread||!QtSameBinding(queryClick.Binding,frame.Binding)||!Same(queryClick.PopupBounds.Value,frame.PopupBounds.Value)||!Same(queryClick.PopupClient.Value,frame.PopupClient.Value))return false;
        long age=(now<0?UtcMs():now)-queryClick.Issued;return age>=0&&age<=30000;
    }
    static void QtPasteCompletionStable(QtFrame frame,QtSearchPasteCompletion completion){
        if(completion==null){QtStable(frame);return;}
        var search=completion.Popup;
        if(!(Object.ReferenceEquals(QtPopup,search)&&QtSearchPasteCompletionEligible("search",QtSurface,frame,search,completion.QueryClick)))throw QtPopupBindingChanged(search,"paste-completion");
        Need(!Stopping&&Interlocked.Read(ref Revision)==frame.Revision,"QT_HUMAN_ACTIVITY_CHANGED");
        // QtBound retains the original popup HWND/process/thread/owner/class,
        // style/DPI/position/width and main-window/focus/occlusion guards. Its
        // observed-search lease already permits only height changes inside the
        // root. The pre-input capture's old height is not a completion guard
        // for a query which this very paste is changing.
        Need(QtSameBinding(frame.Binding,QtBound()),"QT_BINDING_CHANGED");NoKeysHeld();
    }
    static void QtPasteCompletionPause(QtFrame frame,QtSearchPasteCompletion search,int milliseconds){long end=Now()+milliseconds;while(Now()<end){Thread.Sleep(10);QtPasteCompletionStable(frame,search);}}
    static bool QtPasteReadback(Dictionary<string,object> request){if(!request.ContainsKey("readback"))return true;Need(Get(request,"readback") is bool,"QT_PASTE_INVALID");return (bool)Get(request,"readback");}
    static bool QtForegroundPasteOnly(Dictionary<string,object> request){if(!request.ContainsKey("foregroundOnly"))return false;Need(Get(request,"foregroundOnly") is bool,"QT_PASTE_INVALID");return (bool)Get(request,"foregroundOnly");}
    // A return-focus lease is unnecessary when WeChat was already foreground.
    // QtGuard/QtBound still prove the actual foreground, idle input and exact
    // process/window binding before this explicit fast-paste mode is accepted.
    static bool QtFastPasteAuthorized(bool borrowed,bool foregroundOnly,bool parked,Binding binding,IntPtr root,uint pid,long created,string surface){
        return borrowed||foregroundOnly&&!parked&&binding!=null&&root!=IntPtr.Zero&&pid>0&&created>0&&binding.Window==root&&binding.Pid==pid&&binding.Created==created&&binding.FocusOwned&&(surface=="main"||QtSearchSurface(surface));
    }
    static object QtInputProofPacket(QtEnterProof proof){return Data("version",1,"id",proof.Id,proof.Kind=="search"?"querySha256":"textSha256",proof.Digest);}
    static Input[] QtTypedTextEvents(string text,string newlineKey){
        if(text!="\n")return TextEvents(text);
        Need(newlineKey=="Shift+Enter","QT_NEWLINE_CALIBRATION_REQUIRED");
        return new[]{Key(0x10,0),Key(0x0d,0),Key(0x0d,2),Key(0x10,2)};
    }
    static bool QtTypedPrefixMatches(QtEnterProof proof,QtTextStepBinding step,string text,string expected,QtFrame frame,string proofId){
        if(step==null||String.IsNullOrEmpty(text)||String.IsNullOrEmpty(expected)||expected.Length>16000||!expected.EndsWith(text,StringComparison.Ordinal))return false;
        string prefix=expected.Substring(0,expected.Length-text.Length);
        if(prefix.Length==0)return proofId==null;
        return proof!=null&&proof.InputOnly&&QtSameTextStep(proof.Step,step)&&QtEnterProofMatches(proof,"text",proofId,QtHash(Encoding.UTF8.GetBytes(prefix)),frame,UtcMs());
    }
    // OCR shared mode types one grapheme while retaining only our own accepted
    // input prefix. Like fast paste this never reads or overwrites the draft.
    static object QtTypeText(Dictionary<string,object> request){
        QtEmptyPhaseProof=null;QtRevokeQueryClick(QtPopup);
        QtFrame frame=QtGuard(request,true,false);Need(!frame.MetadataOnly,"QT_TYPED_TEXT_SCOPE_INVALID");
        string text=QtNormalizeText(Text(request,"text")),expected=QtNormalizeText(Text(request,"expectedText"));
        QtValidatePaste(text,expected,"editor",null);
        Input[] events=QtTypedTextEvents(text,Text(request,"newlineKey"));
        Need(QtFastPasteAuthorized(QtLease!=null,QtForegroundPasteOnly(request),QtParkedLease!=null,frame.Binding,QtRootWindow,QtRootPid,QtRootCreated,QtSurface),"QT_FOCUS_LEASE_REQUIRED");
        var step=QtParseTextStep(Get(request,"stepBinding"));Rect header=ParseRect(Get(request,"headerRect")),editor=ParseRect(Get(request,"editorRect"));QtNeedTextAnchors(frame,header,editor);
        Need(QtTypedPrefixMatches(QtPendingEnter,step,text,expected,frame,Text(request,"textEnterProofId")),"QT_TYPED_TEXT_PREFIX_CHANGED");
        QtInputStable(frame);QtRevokeEnter();QtCurrent=null;SendEvents(events);
        var report=Data("performed",true,"attempted",true,"revision",frame.Revision,"typeApplied",true,"readbackPerformed",false,"intendedText",expected,"clipboardAccessed",false,"interrupted",false);
        try{
            QtInputStable(frame,false);QtAttachEnterProof(report,"text",expected,frame,new List<QtAnchor>{new QtAnchor{Rect=header},new QtAnchor{Rect=editor}},step,true);
        }catch(Exception){
            if(Stopping||Interlocked.Read(ref Revision)==frame.Revision)throw;
            var proof=new QtEnterProof{Id=Guid.NewGuid().ToString("N"),Kind="text",Digest=QtHash(Encoding.UTF8.GetBytes(expected)),Epoch=QtEpoch,Frame=frame,Step=step,InputOnly=true,Paused=true};QtPendingEnter=proof;
            report["interrupted"]=true;report.Add("textEnterProof",QtInputProofPacket(proof));
        }
        return report;
    }
    static object QtPasteWithoutReadback(Dictionary<string,object> request,IntPtr owner){
        QtRevokeEnter();QtEmptyPhaseProof=null;QtRevokeQueryClick(QtPopup);QtClipboardRestoreObserved=true;
        QtFrame frame=QtGuard(request,true,false);string text=QtNormalizeText(Text(request,"text")),expected=QtNormalizeText(Text(request,"expectedText")),scope=Text(request,"scope");QtValidatePaste(text,expected,scope,Text(request,"searchKind"));
        Need(QtFastPasteAuthorized(QtLease!=null,QtForegroundPasteOnly(request),QtParkedLease!=null,frame.Binding,QtRootWindow,QtRootPid,QtRootCreated,QtSurface),"QT_FOCUS_LEASE_REQUIRED");var step=QtParseTextStep(Get(request,"stepBinding"));
        var anchors=new List<QtAnchor>();
        if(scope=="editor"){Rect header=ParseRect(Get(request,"headerRect")),editor=ParseRect(Get(request,"editorRect"));QtNeedTextAnchors(frame,header,editor);anchors.Add(new QtAnchor{Rect=header});anchors.Add(new QtAnchor{Rect=editor});}
        else {Need(QtSearchPasteCompletionScope(scope,QtSurface,frame,QtPopup),"QT_SEARCH_PASTE_SCOPE_INVALID");anchors.Add(new QtAnchor{Rect=frame.Anchors[0].Rect});}
        Input[] events=QtPasteInput(request,scope);ClipboardState original=QtReadOriginalClipboard(owner,false,QtAllowClipboardReplacement(request));uint owned=original.Sequence,ownerPid=original.OwnerPid;bool changed=false,published=false,restored=false,applied=false,inputEntered=false;long inputAt=0;
        try{
            QtInputStable(frame,false);QtPutText(owner,text,original,ref changed,ref owned,ref ownerPid);published=true;QtInputStable(frame);
            Need(GetClipboardSequenceNumber()==owned&&ClipboardOwnerPid()==ownerPid,"DRAFT_CLIPBOARD_CHANGED");QtCurrent=null;inputAt=Now();inputEntered=true;SendEvents(events);applied=true;
            if(frame.MetadataOnly)QtUiaAwaitOwnPaste(frame,scope,expected,owned,ownerPid);
        }finally{
            // Even a partial SendInput may have queued Ctrl+V. Keep the same
            // clipboard for its scheduling window before restoring it. This
            // does not read back text or claim that the paste was consumed.
            if(inputEntered&&!frame.MetadataOnly){long remaining=60-(Now()-inputAt);if(remaining>0)Thread.Sleep((int)Math.Min(60,remaining));}
            restored=QtFinishPasteClipboard(owner,original,changed,published,owned,ownerPid,scope=="search");
        }
        Need(applied,"QT_INPUT_UNCERTAIN");
        var report=Data("performed",true,"attempted",true,"revision",frame.Revision,"pasteApplied",true,"readbackPerformed",false,"intendedText",expected,"clipboardRestored",restored,"interrupted",false);if(QtClipboardReplacedObserved)report.Add("clipboardReplaced",true);if(frame.MetadataOnly)report.Add("uiaConsumptionConfirmed",true);
        try{
            QtInputStable(frame,false);QtAttachEnterProof(report,scope=="search"?"search":"text",expected,frame,anchors,step,true);
        }catch(Exception){
            if(scope!="editor"||Stopping||Interlocked.Read(ref Revision)==frame.Revision)throw;
            // The paste was accepted before the user intervened. Preserve only
            // its intended prefix; resumption refocuses the original editor and
            // sends Enter without copying or pasting it again.
            var proof=new QtEnterProof{Id=Guid.NewGuid().ToString("N"),Kind="text",Digest=QtHash(Encoding.UTF8.GetBytes(expected)),Epoch=QtEpoch,Frame=frame,Step=step,InputOnly=true,Paused=true};QtPendingEnter=proof;
            report["interrupted"]=true;report.Add("textEnterProof",QtInputProofPacket(proof));
        }
        return report;
    }
    static object QtPaste(Dictionary<string,object> request,IntPtr owner){
        if(!QtPasteReadback(request))return QtPasteWithoutReadback(request,owner);
        QtRevokeEnter();
        QtEmptyPhaseProof=null;QtQueryClickProof queryClick=QtTakeQueryClick(QtPopup);
        QtPasteDiagnosticStage="initial-guard";
        QtClipboardRestoreObserved=true;QtFrame frame=QtGuard(request,true);string text=QtNormalizeText(Text(request,"text")),expected=QtNormalizeText(Text(request,"expectedText")),scope=Text(request,"scope");QtValidatePaste(text,expected,scope,Text(request,"searchKind"));
        QtPasteDiagnosticFrame=frame;QtPasteDiagnosticStage="before-publish";
        Rect textHeader=new Rect(),textEditor=new Rect();bool textProof=scope=="editor"&&request.ContainsKey("headerRect");
        var textStep=QtParseTextStep(Get(request,"stepBinding"));
        if(textProof){textHeader=ParseRect(Get(request,"headerRect"));textEditor=ParseRect(Get(request,"editorRect"));QtNeedTextAnchors(frame,textHeader,textEditor);}
        Input[] pasteKeys=QtPasteInput(request,scope);
        QtSearchPasteCompletion completionSearch=QtSearchPasteCompletionEligible(scope,QtSurface,frame,QtPopup,queryClick)?new QtSearchPasteCompletion{Popup=QtPopup,QueryClick=queryClick}:null;
        ClipboardState original=QtReadOriginalClipboard(owner,false,QtAllowClipboardReplacement(request));uint owned=original.Sequence,ownerPid=original.OwnerPid;bool changed=false,published=false,copied=false,copyStarted=false,restored=false;string actual=null;
        try{QtStable(frame);Need(GetClipboardSequenceNumber()==original.Sequence,"DRAFT_CLIPBOARD_CHANGED");QtClipboardRestoreObserved=null;
            QtPutText(owner,text,original,ref changed,ref owned,ref ownerPid);published=true;QtPasteDiagnosticStage="before-paste";QtStable(frame);
            Need(GetClipboardSequenceNumber()==owned&&ClipboardOwnerPid()==ownerPid,"DRAFT_CLIPBOARD_CHANGED");QtCurrent=null;QtPasteDiagnosticStage="paste-settle";SendEvents(pasteKeys);QtPasteCompletionPause(frame,completionSearch,120);
            Need(GetClipboardSequenceNumber()==owned&&ClipboardOwnerPid()==ownerPid,"DRAFT_CLIPBOARD_CHANGED");QtPasteDiagnosticStage="select-settle";SendEvents(ChordEvents(0x41));QtPasteCompletionPause(frame,completionSearch,50);copyStarted=true;QtPasteDiagnosticStage="copy-readback";SendEvents(ChordEvents(0x43));
            long end=Now()+650;while(GetClipboardSequenceNumber()==owned&&Now()<end)Thread.Sleep(15);uint after=GetClipboardSequenceNumber();
            if(after!=owned&&frame.Revision==Interlocked.Read(ref Revision)){owned=after;ownerPid=frame.Binding.Pid;copied=true;}QtPasteCompletionStable(frame,completionSearch);Need(copied&&ClipboardOwnerPid()==frame.Binding.Pid,"QT_PASTE_READBACK_UNCONFIRMED");
            Need(OpenClipboard(owner),"DRAFT_CLIPBOARD_BUSY");try{
                int count=CountClipboardFormats();Need(count>0&&count<=16,"DRAFT_CLIPBOARD_COMPLEX_FORMAT");actual=QtNormalizeText(DecodeUnicode(ClipboardBytes(13,131072)));Need(actual==expected,"QT_PASTE_TEXT_MISMATCH");
                bool wechat=false,qq=false,mime=false;uint format=0;while((format=EnumClipboardFormats(format))!=0){string name=QtFormatName(format);
                    if(SafeFormat(format))continue;
                    // Search's Qt clipboard also publishes OLE bookkeeping and
                    // sometimes the same rich-text companions as the editor.
                    // Validate these bytes by the identical plain-text parser;
                    // do not reject a verified query just for having companions.
                    Need(format>=0xc000&&KnownCompanion(name),"QT_RICH_DRAFT_UNSUPPORTED");if(name=="DataObject"||name=="Ole Private Data")continue;
                    Need(QtPlainRichPayload(name,ClipboardBytes(format,131072),DecodeUnicode(ClipboardBytes(13,131072))),"QT_RICH_DRAFT_UNSUPPORTED");
                    if(name=="WeChat_RichEdit_Format")wechat=true;else if(name=="QQ_Unicode_RichEdit_Format")qq=true;else if(name=="x-application-mimetype-xwechat")mime=true;
                }
                Need(scope=="search"||wechat&&qq&&mime,"QT_RICH_DRAFT_UNSUPPORTED");Need(GetClipboardSequenceNumber()==owned&&ClipboardOwnerPid()==ownerPid,"DRAFT_CLIPBOARD_CHANGED");
            }finally{CloseClipboard();}
            QtPasteDiagnosticStage="readback-verified";QtPasteCompletionStable(frame,completionSearch);QtPasteDiagnosticStage="end-settle";SendEvents(ChordEvents(0x23));QtPasteCompletionPause(frame,completionSearch,50);
        }finally{
            // On cancellation a queued copy can still complete. Wait for it
            // without injecting further input, then restore only our exact copy.
            if(copyStarted&&!copied){long end=Now()+650;while(GetClipboardSequenceNumber()==owned&&Now()<end)Thread.Sleep(15);uint after=GetClipboardSequenceNumber();if(after!=owned&&frame.Revision==Interlocked.Read(ref Revision)){owned=after;ownerPid=frame.Binding.Pid;}}
            restored=QtFinishPasteClipboard(owner,original,changed,published,owned,ownerPid,scope=="search");
        }
        QtPasteDiagnosticStage=QtClipboardReplacedObserved?"clipboard-replaced":"clipboard-restored";QtPasteCompletionStable(frame,completionSearch);var report=Data("performed",true,"attempted",true,"revision",frame.Revision,"pasteVerified",true,"clipboardRestored",restored,"draft",actual);if(QtClipboardReplacedObserved)report.Add("clipboardReplaced",true);if(request.ContainsKey("replaceSearch"))report.Add("searchReplaced",true);
        if(scope=="search"&&Object.Equals(Get(request,"replaceSearch"),true)&&completionSearch!=null)QtAttachEnterProof(report,"search",actual,frame,new List<QtAnchor>{new QtAnchor{Rect=frame.Anchors[0].Rect}});
        else if(textProof)QtAttachEnterProof(report,"text",actual,frame,new List<QtAnchor>{new QtAnchor{Rect=textHeader},new QtAnchor{Rect=textEditor}},textStep);
        return report;
    }
    static void QtNeedTextAnchors(QtFrame frame,Rect header,Rect editor){
        Need(QtSurface=="main"&&QtPopup==null&&QtPendingPopup==null&&frame.Anchors.Count==2&&Same(frame.Anchors[0].Rect,header)&&Same(frame.Anchors[1].Rect,editor)&&Contains(frame.Binding.Client,header)&&Contains(frame.Binding.Client,editor)&&header.Bottom<=editor.Top,"QT_TEXT_ENTER_ANCHORS_REQUIRED");
    }
    static void QtNeedDraftSource(QtFrame frame,Rect header,Rect editor){
        Need(QtSurface=="main"&&QtPopup==null&&QtPendingPopup==null&&(frame.Anchors.Count==1||frame.Anchors.Count==2)&&Same(frame.Anchors[0].Rect,header)&&(frame.Anchors.Count==1||Same(frame.Anchors[1].Rect,editor))&&Contains(frame.Binding.Client,header)&&Contains(frame.Binding.Client,editor)&&header.Bottom<=editor.Top,"QT_TEXT_ENTER_ANCHORS_REQUIRED");
    }
    // A one-use continuation binds either a completed readback or the explicit
    // unchecked paste intent. Neither permits repeating an attempted Enter.
    static void QtAttachEnterProof(Dictionary<string,object> report,string kind,string text,QtFrame source,List<QtAnchor> anchors,QtTextStepBinding step=null,bool inputOnly=false){
        QtCheckUiaControlLease(source);bool uiaHeader=QtUiaInputHeader(source,kind,inputOnly,QtLease);
        var savedPopup=QtPopup;var regions=new List<object>();foreach(var anchor in anchors)regions.Add(anchor.Rect.Report());
        var request=Data("surface",kind=="search"?"observed-search":"main","regions",regions.ToArray(),"image",false);if(kind=="search")request.Add("surfaceId","search");
        var captured=source.MetadataOnly?QtCaptureUiaControls(request,kind=="search"?"search":"control"):Map(QtCapture(request,!inputOnly));var current=QtCurrent;
        Need(current!=null&&current.Revision==source.Revision&&QtSameBinding(current.Binding,source.Binding)&&current.Binding.Thread==source.Binding.Thread&&Object.ReferenceEquals(savedPopup,QtPopup),"QT_OBSERVATION_CHANGED");
        QtCheckUiaControlLease(source);if(kind=="text")Need(QtAttachTextHeaderMatches(source,current,inputOnly,QtLease),"QT_TEXT_ENTER_HEADER_CHANGED");
        if(uiaHeader)QtMarkUiaControlFrame(current,source.UiaControlLease,captured);
        var proof=new QtEnterProof{Id=Guid.NewGuid().ToString("N"),Kind=kind,Digest=QtHash(Encoding.UTF8.GetBytes(text)),Epoch=QtEpoch,Frame=current,Popup=QtPopup,Step=kind=="text"?step:null,InputOnly=inputOnly};QtPendingEnter=proof;
        report.Add("postPasteFrame",captured);report.Add(kind=="search"?"searchEnterProof":"textEnterProof",Data("version",1,"id",proof.Id,kind=="search"?"querySha256":"textSha256",proof.Digest));
    }
    static bool QtEnterCaret(Binding actual,Rect area,int? popupTop){
        Rect caret=actual.CaretInClient;return actual.FocusOwned&&actual.CaretOwned&&actual.Focus==actual.Window&&actual.Caret==actual.Window&&(actual.GuiFlags&0x1f)==1&&caret.Width>0&&caret.Height>0&&Contains(area,caret)&&(!popupTop.HasValue||caret.Bottom<=popupTop.Value);
    }
    static bool QtExplicitNoCaret(Binding value){return value.Caret==IntPtr.Zero&&!value.CaretOwned&&value.GuiFlags==0&&Same(value.CaretInClient,new Rect(0,0,0,0));}
    static bool QtTextEditorCaret(Binding value,Rect editor){return value.CaretOwned&&value.Caret==value.Window&&(value.GuiFlags==0||value.GuiFlags==1)&&value.CaretInClient.Width>0&&value.CaretInClient.Height>0&&Contains(editor,value.CaretInClient);}
    static bool QtTextEnterFocus(Binding source,Binding current,Rect editor){
        if(source==null||current==null||source.Thread!=current.Thread||!QtSameBinding(source,current)||!source.FocusOwned||source.Focus!=source.Window||!current.FocusOwned||current.Focus!=current.Window)return false;
        // GUI_CARETBLINKING describes visibility, not keyboard focus. Only the
        // immediately preceding full editor copy/readback proof permits this
        // path. An absent caret is accepted only as the same complete zero
        // tuple before/after; a visible query/foreign caret remains a refusal.
        if(!QtTextEditorCaret(source,editor)&&!QtExplicitNoCaret(source))return false;
        return QtTextEditorCaret(current,editor)||QtExplicitNoCaret(source)&&QtExplicitNoCaret(current);
    }
    static object QtEnterFocusSnapshot(Binding value,Rect area){return Data("focusOwned",value.FocusOwned,"focusIsRoot",value.Focus==value.Window,"caretOwned",value.CaretOwned,"caretIsRoot",value.Caret==value.Window,"caretAbsent",value.Caret==IntPtr.Zero,"caretRectEmpty",Same(value.CaretInClient,new Rect(0,0,0,0)),"caretInside",value.CaretInClient.Width>0&&value.CaretInClient.Height>0&&Contains(area,value.CaretInClient),"guiFlags",value.GuiFlags);}
    static Exception QtEnterFocusRefusal(string kind,Binding source,Binding current,Rect area){var error=new Fault("QT_ENTER_FOCUS_UNVERIFIED");error.Data["QtEnterFocus"]=Data("version",1,"kind",kind,"proofVerified",true,"sameBinding",QtSameBinding(source,current),"sameThread",source.Thread==current.Thread,"source",QtEnterFocusSnapshot(source,area),"current",QtEnterFocusSnapshot(current,area));return error;}
    static object QtEnterFocusFailure(Exception error){return error.Data.Contains("QtEnterFocus")?error.Data["QtEnterFocus"]:null;}
    static bool QtEnterProofMatches(QtEnterProof proof,string kind,string proofId,string digest,QtFrame frame,long now){
        if(proof==null||proof.Consumed||proof.Paused||proof.Kind!=kind||proof.Id!=proofId||proof.Digest!=digest||proof.Epoch!=QtEpoch||proof.Frame==null||frame==null||frame.Revision!=proof.Frame.Revision||now<proof.Frame.Issued||now-proof.Frame.Issued>30000||frame.Binding.Thread!=proof.Frame.Binding.Thread||!QtSameBinding(frame.Binding,proof.Frame.Binding)||frame.Anchors.Count!=proof.Frame.Anchors.Count)return false;
        if((proof.Frame.UiaControlFrame||frame.UiaControlFrame)&&(!proof.InputOnly||kind!="text"||!QtUiaControlLeaseMatches(proof.Frame,QtLease)||!QtUiaControlLeaseMatches(frame,QtLease)))return false;
        for(int i=0;i<frame.Anchors.Count;i++)if(!Same(frame.Anchors[i].Rect,proof.Frame.Anchors[i].Rect)||!proof.InputOnly&&frame.Anchors[i].Hash!=proof.Frame.Anchors[i].Hash)return false;
        if(kind=="search")return QtSurface=="observed-search"&&Object.ReferenceEquals(proof.Popup,QtPopup)&&frame.PopupBounds.HasValue&&proof.Frame.PopupBounds.HasValue&&frame.PopupClient.HasValue&&proof.Frame.PopupClient.HasValue&&(proof.InputOnly||Same(frame.PopupBounds.Value,proof.Frame.PopupBounds.Value)&&Same(frame.PopupClient.Value,proof.Frame.PopupClient.Value))&&QtSearchPasteCompletionScope("search",QtSurface,frame,QtPopup);
        return kind=="text"&&QtSurface=="main"&&proof.Popup==null&&QtPopup==null&&QtPendingPopup==null&&frame.Anchors.Count==2;
    }
    static object QtDedicatedEnter(Dictionary<string,object> request,string kind){
        bool retainBackgroundEditor=QtBgRetentionRequested(request,kind);
        var proof=QtPendingEnter;QtPendingEnter=null;QtEmptyPhaseProof=null;QtRevokeQueryClick(QtPopup);
        bool retain=false;
        try{
            var step=QtParseTextStep(Get(request,"stepBinding"));
            Need(kind!="text"||proof!=null&&QtSameTextStep(proof.Step,step),"QT_TEXT_STEP_CHANGED");
            retain=kind=="text"&&proof!=null&&proof.Step!=null&&!proof.Consumed&&proof.Id==Text(request,"textEnterProofId")&&proof.Digest==Text(request,"textSha256")&&proof.Epoch==QtEpoch;
            QtFrame frame=QtGuard(request,true,proof==null||!proof.InputOnly);string digest=Text(request,kind=="search"?"querySha256":"textSha256"),proofId=Text(request,kind=="search"?"searchEnterProofId":"textEnterProofId");
            Need(QtEnterProofMatches(proof,kind,proofId,digest,frame,UtcMs()),"QT_ENTER_PROOF_INVALID");
            Rect area=frame.Anchors[kind=="search"?0:1].Rect;
            if(kind=="text"){QtNeedTextAnchors(frame,ParseRect(Get(request,"headerRect")),ParseRect(Get(request,"editorRect")));}
            int? top=kind=="search"?(int?)(QtPopup.ObservedClientScreen.Top-frame.Binding.Capture.Top):null;
            if(proof.InputOnly)QtInputStable(frame);else QtStable(frame);Binding current=QtBound(!frame.MetadataOnly);
            bool focusValid=current.Thread==frame.Binding.Thread&&QtSameBinding(frame.Binding,current)&&(proof.InputOnly?current.FocusOwned&&current.Focus==current.Window:(kind=="text"?QtTextEnterFocus(proof.Frame.Binding,current,area):QtEnterCaret(current,area,top)));
            if(!focusValid)throw QtEnterFocusRefusal(kind,proof.Frame.Binding,current,area);
            if(kind=="text")QtVerifyQuote(request,frame);
            var continuation=retainBackgroundEditor?QtBgCaptureEditorContinuation(frame,step):null;
            NoKeysHeld();Need(frame.Revision==Interlocked.Read(ref Revision),"QT_HUMAN_ACTIVITY_CHANGED");retain=false;proof.Consumed=true;QtCurrent=null;
            Input[] inputs=new[]{Key(0x0d,0),Key(0x0d,2)};InputAttempted=true;uint accepted=SendInput((uint)inputs.Length,inputs,Marshal.SizeOf(typeof(Input)));
            if(accepted!=inputs.Length){var release=Releases(inputs,accepted);if(release.Length>0)SendInput((uint)release.Length,release,Marshal.SizeOf(typeof(Input)));throw new Fault("QT_INPUT_UNCERTAIN");}
            QtBgRememberSubmittedEditor(continuation);
            if(kind=="text"){QtActiveQuote=null;QtActiveOcrQuote=null;}
            var report=Data("performed",true,"attempted",true,"revision",frame.Revision,kind=="search"?"searchAccepted":"submittedViaEnter",true);if(kind=="search"){string generation=QtMintUiaSearch(frame,proof.Popup);if(generation!=null)report.Add("searchGeneration",generation);}return report;
        }finally{QtFinishEnterAttempt(proof,retain,InputAttempted);}
    }
    static bool QtTextResumeMatches(QtEnterProof proof,QtTextStepBinding step,string id,string digest,QtFrame frame,Rect header,Rect editor){
        if(proof==null||proof.Kind!="text"||proof.Consumed||!proof.Paused||proof.Step==null||!QtSameTextStep(proof.Step,step)||proof.Id!=id||proof.Digest!=digest||proof.Epoch!=QtEpoch||proof.Frame==null||frame==null||QtSurface!="main"||QtPopup!=null||QtPendingPopup!=null)return false;
        if((proof.Frame.UiaControlFrame||frame.UiaControlFrame)&&(!proof.InputOnly||!QtUiaControlLeaseMatches(proof.Frame,QtLease)||!QtUiaControlLeaseMatches(frame,QtLease)))return false;
        var a=proof.Frame.Binding;var b=frame.Binding;
        if(a.Window!=b.Window||a.Pid!=b.Pid||a.Created!=b.Created||a.Thread!=b.Thread||a.Dpi!=b.Dpi||!Same(a.Client,b.Client)||!Same(a.Capture,b.Capture)||frame.Anchors.Count!=2||proof.Frame.Anchors.Count!=2)return false;
        return Same(frame.Anchors[0].Rect,header)&&Same(frame.Anchors[1].Rect,editor)&&Same(proof.Frame.Anchors[0].Rect,header)&&Same(proof.Frame.Anchors[1].Rect,editor)&&frame.Anchors[0].Hash==proof.Frame.Anchors[0].Hash&&Contains(b.Client,header)&&Contains(b.Client,editor)&&header.Bottom<=editor.Top;
    }
    static object QtResumeTextEnterProof(Dictionary<string,object> request){
        var proof=QtPendingEnter;Need(proof!=null&&!proof.Consumed,"QT_TEXT_STEP_UNAVAILABLE");
        QtFrame frame=QtGuard(request,true,!proof.InputOnly);Rect header=ParseRect(Get(request,"headerRect")),editor=ParseRect(Get(request,"editorRect"));var step=QtParseTextStep(Get(request,"stepBinding"));
        Need(QtTextResumeMatches(proof,step,Text(request,"textEnterProofId"),Text(request,"textSha256"),frame,header,editor),"QT_TEXT_STEP_CHANGED");
        // Operator-selected continuation: the completed paste is not repeated
        // or copied again. Re-focus this exact job's original editor, bind the
        // next Enter to a fresh frame/revision, and retain the original receipt
        // digest. This does not assert that a manually edited draft is unchanged.
        proof.Paused=true;Point center=new Point(frame.Binding.Capture.Left+editor.Left+editor.Width/2,frame.Binding.Capture.Top+editor.Top+editor.Height/2);
        Rect desktop=QtDesktopRect();Need(Contains(desktop,frame.Binding.Capture),"QT_TEXT_STEP_FOCUS_CHANGED");QtStable(frame);Need(Owned(WindowFromPoint(center),frame.Binding.Window,frame.Binding.Pid),"QT_TEXT_STEP_FOCUS_CHANGED");
        Input[] inputs=ClickEvents(center.X,center.Y,desktop);QtCurrent=null;InputAttempted=true;ObserveMouseIntent(0x201,center);uint accepted=SendInput((uint)inputs.Length,inputs,Marshal.SizeOf(typeof(Input)));
        if(accepted==inputs.Length)QtRememberPointer(center,frame.Revision);else if(accepted>0&&QtLease!=null){QtLease.PointerMoved=true;QtLease.PointerCertain=false;}
        if(accepted!=inputs.Length){Input[] release=ClickReleases(accepted);if(release.Length>0)SendInput((uint)release.Length,release,Marshal.SizeOf(typeof(Input)));throw new Fault("QT_INPUT_UNCERTAIN");}
        QtStable(frame);
        var captured=frame.MetadataOnly?QtCaptureUiaControls(Data("surface","main","regions",new object[]{header.Report(),editor.Report()},"image",false)):Map(QtCapture(Data("surface","main","regions",new object[]{header.Report(),editor.Report()},"image",false),!proof.InputOnly));var current=QtCurrent;
        Need(current!=null&&current.Revision==frame.Revision&&current.Binding.Thread==frame.Binding.Thread&&QtSameBinding(current.Binding,frame.Binding)&&current.Anchors[0].Hash==frame.Anchors[0].Hash,"QT_TEXT_STEP_CHANGED");
        if(QtUiaInputHeader(frame,"text",proof.InputOnly,QtLease))QtMarkUiaControlFrame(current,frame.UiaControlLease,captured);
        proof.Consumed=true;var next=new QtEnterProof{Id=Guid.NewGuid().ToString("N"),Kind="text",Digest=proof.Digest,Epoch=QtEpoch,Frame=current,Step=proof.Step,InputOnly=proof.InputOnly};QtPendingEnter=next;
        return Data("performed",true,"attempted",true,"resumed",true,"revision",current.Revision,"postPasteFrame",captured,"textEnterProof",Data("version",1,"id",next.Id,"textSha256",next.Digest));
    }
    // Read control messages independently of an in-flight copy. Stop prevents
    // subsequent keyboard input immediately; the worker still runs its finally
    // block and restores an unchanged owned clipboard before acknowledging exit.
    static void QtInputLoop(){try{
        var controlJson=new System.Web.Script.Serialization.JavaScriptSerializer();
        for(;;){string line=QtReadBoundedLine();if(line==null)break;var request=Map(controlJson.DeserializeObject(line));Need(request!=null,"QT_REQUEST_INVALID");
            if(Text(request,"action")=="stop")Stopping=true;
            lock(QtRequests){Need(QtRequests.Count<2,"QT_REQUEST_QUEUE_FULL");QtRequests.Enqueue(line);Monitor.PulseAll(QtRequests);}
        }
    }catch{QtInputFailed=true;}finally{Stopping=true;lock(QtRequests){QtInputEnded=true;Monitor.PulseAll(QtRequests);}}}
    static string QtNextRequest(){lock(QtRequests){while(QtRequests.Count==0&&!QtInputEnded)Monitor.Wait(QtRequests);if(QtInputFailed)throw new Fault("QT_INPUT_STREAM_INVALID");return QtRequests.Count>0?QtRequests.Dequeue():null;}}
    static void QtReadLoop(IntPtr owner) {
        try {
            for(;;){string line=QtNextRequest();if(line==null)break;object id=null;InputAttempted=false;QtClipboardRestoreObserved=null;QtClipboardReplacedObserved=false;QtPasteDiagnosticStage=null;QtPasteDiagnosticFrame=null;QtCommandStarted=Now();
                try {Need(line.Length<=65536,"QT_REQUEST_TOO_LARGE");var request=Map(Json.DeserializeObject(line));Need(request!=null,"QT_REQUEST_INVALID");id=Get(request,"id");Number(id);string action=Text(request,"action");object result;
                    QtBgActionBoundary(action);QtImageActionBoundary(action);
                    if(action=="releaseFocusHandoff"||action=="stop"){QtActiveQuote=null;QtActiveOcrQuote=null;}
                    if((action=="paste"&&Text(request,"scope")=="editor")||action=="typeText")QtVerifyQuote(request,QtCurrent);
                    if(!QtUiaSearchReadOnlyAction(action)&&action!="focusUiaReadyEditor")QtRevokeUiaSearch();
                    if(action=="stop"||action=="transferFocusHandoff"||action=="restoreTransferredFocus")QtRevokeEnter();
                    else if(action=="beginFocusHandoff"||action=="parkFocusHandoff"||action=="resumeFocusHandoff"||action=="releaseFocusHandoff")QtPauseTextEnter();
                    if(action=="stop"){QtEmptyPhaseProof=null;QtParkedLease=null;QtParkedBinding=null;if(QtLease!=null){QtFocusLease lease=QtLease;QtLease=null;QtRestoreFocus(lease,lease.Revision==Interlocked.Read(ref Revision));}Write(Data("id",id,"ok",true,"result",Data("stopped",true)));break;}
                    if(action=="attachMessageQuote")result=QtAttachQuote(request);
                    else if(action=="checkClearMessageQuote")result=QtCheckClearQuote(request);
                    else if(action=="verifyMessageQuote"){var verifiedQuoteFrame=QtGuard(request,true,false);Need(Text(request,"quoteToken")!=null,"QT_QUOTE_CHANGED");QtVerifyQuote(request,verifiedQuoteFrame);result=Data("verified",true);}
                    else if(action=="scrollOcrQuoteHistory")result=QtScrollOcrQuoteHistory(request);
                    else if(action=="openOcrQuoteMenu")result=QtOpenOcrQuoteMenu(request);
                    else if(action=="captureOcrQuoteMenu")result=QtCaptureOcrQuoteMenu(request);
                    else if(action=="chooseOcrQuoteMenu")result=QtChooseOcrQuoteMenu(request);
                    else if(action=="bindOcrQuotePreview")result=QtBindOcrQuotePreview(request);
                    else if(action=="prepareUiaBackgroundText")result=QtPrepareUiaBackgroundText(request);
                    else if(action=="writeUiaBackgroundText")result=QtWriteUiaBackgroundText(request);
                    else if(action=="submitUiaBackgroundText")result=QtSubmitUiaBackgroundText(request);
                    else if(action=="releaseUiaBackgroundText")result=QtReleaseUiaBackgroundText(request);
                    else if(action=="inspectClipboard")result=QtClipboardFormats(owner);
                    else if(action=="inspectLayout")result=QtInspectLayout();
                    else if(action=="warmUiaLocators")result=QtWarmUiaLocators(request);
                    else if(action=="inspectUiaFocusGeometry")result=QtInspectUiaFocusGeometry(request);
                    else if(action=="inspectTargetOcclusion"){var observed=Map(QtInspectLayout());var identity=Map(Get(observed,"binding"));Binding bound=new Binding{Window=new IntPtr(DecimalString(Get(identity,"hwnd"))),Capture=ParseRect(Get(identity,"captureRect")),Client=ParseRect(Get(identity,"clientRect"))};result=Data("readOnly",true,"inputSent",false,"occlusion",QtOverlapReport(bound));}
                    else if(action=="captureLayout")result=QtCaptureLayout(request);
                    else if(action=="captureLayoutHandoff")result=QtCaptureLayoutHandoff(request);
                    else if(action=="captureLayoutRaised")result=QtCaptureLayoutRaised(request);
                    else if(action=="inspectFocusHandoff")result=QtInspectFocus(request);
                    else if(action=="inspectFocusActivation")result=QtInspectFocusActivation(request);
                    else if(action=="inspectPopup")result=QtInspectPopup(request);
                    else if(action=="inspectEmptyEditorPhase")result=QtInspectEmptyEditorPhase(request);
                    else if(action=="beginFocusHandoff"){var expected=QtInspectedFocus;QtInspectedFocus=null;result=QtBeginFocus(request,expected==null?(long?)null:expected.Revision,false,expected);}
                    else if(action=="parkFocusHandoff")result=QtParkFocus();
                    else if(action=="resumeFocusHandoff")result=QtResumeFocus(request);
                    else if(action=="transferFocusHandoff")result=QtTransferFocus();
                    else if(action=="restoreTransferredFocus")result=QtRestoreTransferred(request);
                    else if(action=="releaseFocusHandoff"){QtEmptyPhaseProof=null;QtParkedLease=null;QtParkedBinding=null;QtFocusLease lease=QtLease;QtLease=null;result=QtRestoreFocus(lease,lease!=null&&lease.Revision==Interlocked.Read(ref Revision));}
                    else if(action=="inspectOcclusion"){QtSelectSurface(Text(request,"surface"),Text(request,"surfaceId"));Binding bound=Snapshot(QtWindow,QtExecutable);var occlusion=QtOverlapReport(bound);occlusion.Add("diagnostics",QtOcclusionDiagnostics(bound,Get(request,"diagnosticRegions")));result=Data("occlusion",occlusion,"binding",bound.Report(),"readOnly",true,"inputSent",false);}
                    else if(action=="capture")result=QtCapture(request);
                    else if(action=="captureUiaControls")result=QtCaptureUiaControls(request);
                    else if(action=="captureUiaSearch")result=QtCaptureUiaControls(request,"search");
                    else if(action=="captureUiaNavigation")result=QtCaptureUiaNavigation(request);
                    else if(action=="openUiaSearch")result=QtOpenUiaSearch(request);
                    else if(action=="focusUiaEditor")result=QtFocusUiaEditor(request);
                    else if(action=="focusUiaReadyEditor")result=QtFocusUiaReadyEditor(request);
                    else if(action=="readDraft"||action=="diagnoseDraftStructure")result=QtReadDraft(request,owner);
                    else if(action=="resumeTextEnterProof")result=QtResumeTextEnterProof(request);
                    else if(action=="paste")result=QtPaste(request,owner);
                    else if(action=="pasteImage")result=QtPasteImage(request,owner);
                    else if(action=="pasteUiaImage"||action=="pasteUiaFile")result=QtPasteUiaImage(request,owner,action=="pasteUiaFile");
                    else if(action=="submitUiaFileDialog")result=QtSubmitUiaFileDialog(request);
                    else if(action=="submitUiaImage")result=QtSubmitUiaImage(request);
                    else if(action=="resumeUiaImage")result=QtResumeUiaImage(request);
                    else if(action=="searchEnter"||action=="submitTextEnter")result=QtDedicatedEnter(request,action=="searchEnter"?"search":"text");
                    else if(action=="typeText")result=QtTypeText(request);
                    else if(action=="click"||action=="movePointer"||action=="chord"||action=="type")result=QtAct(request,action);
                    else throw new Fault("QT_ACTION_INVALID");
                    Write(Data("id",id,"ok",true,"result",result));
                }catch(Exception error){QtCurrent=null;object backgroundProgress=QtBgFailure();Write(Data("id",id,"ok",false,"error",Data("code",error is Fault?error.Message:"QT_OPERATION_FAILED","attempted",InputAttempted,"clipboardRestored",QtClipboardRestoreObserved,"clipboardReplaced",QtClipboardReplacedObserved,"originalClipboardBlocked",error.Data["QtOriginalClipboardBlocked"],"focusConfirmation",FocusFailureDiagnostic(error),"focusVisibility",QtFocusVisibilityFailure(error),"focusRestoreOutcome",QtFocusRestoreFailure(error),"foregroundInterval",QtFocusTimingFailure(error),"visibilityRestoreOutcome",error.Data["QtVisibilityRestoreOutcome"],"raisedVisibilityInterval",error.Data["QtRaisedVisibilityInterval"],"pixelMismatch",QtPixelMismatch(error),"popupBindingMismatch",QtPopupBindingMismatch(error),"enterFocus",QtEnterFocusFailure(error),"imageClipboard",error.Data["QtImageClipboard"],"backgroundProgress",backgroundProgress)));}
                finally{QtCommandStarted=0;}
            }
        }catch(Exception error){QtExitCode=1;Write(Data("id",null,"ok",false,"error",Data("code",error is Fault?error.Message:"QT_OPERATION_FAILED")));}
        finally{QtBgRevoke();QtEmptyPhaseProof=null;if(QtLease!=null){QtFocusLease lease=QtLease;QtLease=null;try{QtRestoreFocus(lease,lease.Revision==Interlocked.Read(ref Revision));}catch{}}Stopping=true;try{Dispatcher.BeginInvoke((Action)delegate{Application.ExitThread();});}catch{}}
    }
    static string QtReadBoundedLine(){var value=new StringBuilder();int c;while((c=Console.In.Read())!=-1){if(c=='\n')return value.ToString();Need(value.Length<65536,"QT_REQUEST_TOO_LARGE");value.Append((char)c);}Need(value.Length==0,"QT_REQUEST_TRUNCATED");return null;}
    // Geometry only: no capture, input hooks, process memory, titles or focus
    // changes. Display positions can be negative on an extended desktop.
    static object QtDesktopLayout(){
        SetProcessDpiAwarenessContext(new IntPtr(-4));Desktop();var screens=new List<object>();
        foreach(Screen screen in Screen.AllScreens){Rectangle b=screen.Bounds,w=screen.WorkingArea;screens.Add(Data("primary",screen.Primary,"bounds",new Rect(b.Left,b.Top,b.Right,b.Bottom).Report(),"workArea",new Rect(w.Left,w.Top,w.Right,w.Bottom).Report()));}
        return Data("version",1,"readOnly",true,"inputSent",false,"focusChanged",false,"virtualDesktop",QtDesktopRect().Report(),"displays",screens);
    }
    internal static int QtMain(string[] args) {
        Console.InputEncoding=new UTF8Encoding(false);Console.OutputEncoding=new UTF8Encoding(false);
        if(args.Length==1&&args[0]=="--self-test")return QtSelfTest();
        if(args.Length==1&&args[0]=="--desktop-layout"){try{Write(QtDesktopLayout());return 0;}catch(Exception error){Write(Data("ok",false,"code",error is Fault?error.Message:"QT_DESKTOP_LAYOUT_FAILED"));return 1;}}
        try {
            Need(args.Length==7&&args[0]=="--executable"&&args[2]=="--hwnd"&&args[4]=="--frames"&&(args[6]=="--enable-input"||args[6]=="--read-only"),"QT_ARGUMENTS_INVALID");
            QtExecutable=Exe(args[1]);QtWindow=args[3]=="auto"?IntPtr.Zero:new IntPtr(DecimalString(args[3]));QtFrames=Path.GetFullPath(args[5]);Need(Directory.Exists(QtFrames),"QT_FRAMES_REQUIRED");QtEnableInput=args[6]=="--enable-input";
            SetProcessDpiAwarenessContext(new IntPtr(-4));if(QtEnableInput)Gate=Acquire("Local\\WeChatAgent.UiInput.v1");ActivityMonitorStarted=LastActivity=Now();QtCaptionClicks=new QtCaptionClickHistory();MouseObservationObserver=QtEnableInput?QtCaptionObserver:null;
            using(var process=Process.GetCurrentProcess()){IntPtr module=GetModuleHandle(process.MainModule.ModuleName);KeyboardHook=SetWindowsHookEx(13,KeyboardCallback,module,0);MouseHook=SetWindowsHookEx(14,MouseCallback,module,0);}
            Need(KeyboardHook!=IntPtr.Zero&&MouseHook!=IntPtr.Zero,"QT_ACTIVITY_MONITOR_UNAVAILABLE");
            Dispatcher=new Control();IntPtr owner=Dispatcher.Handle;
            using(var watchdog=new System.Threading.Timer(delegate{long started=Interlocked.Read(ref QtCommandStarted);if(started>0&&Now()-started>20000)Environment.Exit(124);},null,1000,1000)) {
                var control=new Thread(QtInputLoop);control.IsBackground=true;control.SetApartmentState(ApartmentState.MTA);control.Start();
                var worker=new Thread(delegate(){QtReadLoop(owner);});worker.IsBackground=true;worker.SetApartmentState(ApartmentState.MTA);worker.Start();Application.Run();
            }
            return QtExitCode;
        }catch(Exception error){Write(Data("id",null,"ok",false,"error",Data("code",error is Fault?error.Message:"QT_START_FAILED")));return 1;}
        finally{Stopping=true;MouseObservationObserver=null;if(KeyboardHook!=IntPtr.Zero)UnhookWindowsHookEx(KeyboardHook);if(MouseHook!=IntPtr.Zero)UnhookWindowsHookEx(MouseHook);if(Dispatcher!=null)Dispatcher.Dispose();if(Gate!=null){try{Gate.ReleaseMutex();}finally{Gate.Dispose();}}}
    }
    static int QtParkResumeSelfTest(){
        int checks=0;bool enabled=QtEnableInput,stopping=Stopping,attempted=InputAttempted;var lease=QtLease;var parked=QtParkedLease;var binding=QtParkedBinding;long parkedAt=QtParkedAt;string surface=QtSurface;var popup=QtPopup;
        try{
            for(int missing=0;missing<6;missing++){
                QtEnableInput=true;Stopping=false;InputAttempted=false;QtLease=new QtFocusLease();QtParkedLease=null;QtSurface="main";QtPopup=null;
                if(missing==0)QtEnableInput=false;if(missing==1)Stopping=true;if(missing==2)QtLease=null;if(missing==3)QtParkedLease=new QtFocusLease();if(missing==4)QtSurface="profile";if(missing==5)QtPopup=new QtPopupLease();
                var before=QtLease;Expect(delegate{QtParkFocus();},"QT_FOCUS_PARK_UNAVAILABLE");Need(!InputAttempted&&Object.ReferenceEquals(before,QtLease),"QT_TEST_PARK_REFUSAL_NO_INPUT_OR_LEASE_LOSS");checks++;
            }
            for(int missing=0;missing<4;missing++){
                QtEnableInput=true;Stopping=false;InputAttempted=false;QtLease=null;QtParkedLease=new QtFocusLease();
                if(missing==0)QtEnableInput=false;if(missing==1)Stopping=true;if(missing==2)QtLease=new QtFocusLease();if(missing==3)QtParkedLease=null;
                var before=QtParkedLease;Expect(delegate{QtResumeFocus(Data());},"QT_FOCUS_PARK_UNAVAILABLE");Need(!InputAttempted&&Object.ReferenceEquals(before,QtParkedLease),"QT_TEST_RESUME_REFUSAL_NO_INPUT_OR_LEASE_LOSS");checks++;
            }
            QtEnableInput=true;Stopping=false;InputAttempted=false;QtLease=null;QtParkedLease=new QtFocusLease{Revision=Interlocked.Read(ref Revision)};QtParkedAt=Now()-30001;
            Expect(delegate{QtResumeFocus(Data());},"QT_HUMAN_ACTIVITY_CHANGED");Need(!InputAttempted&&QtParkedLease!=null,"QT_TEST_EXPIRED_PARK_NO_INPUT");checks++;
            QtParkedAt=Now();QtParkedLease.Revision=Interlocked.Read(ref Revision)+1;
            Expect(delegate{QtResumeFocus(Data());},"QT_HUMAN_ACTIVITY_CHANGED");Need(!InputAttempted&&QtParkedLease!=null,"QT_TEST_CHANGED_PARK_NO_INPUT");checks++;
        }finally{QtEnableInput=enabled;Stopping=stopping;InputAttempted=attempted;QtLease=lease;QtParkedLease=parked;QtParkedBinding=binding;QtParkedAt=parkedAt;QtSurface=surface;QtPopup=popup;}
        return checks;
    }
    static byte[] QtEmptyPhaseFixture(int width,int height){var pixels=new byte[width*height*4];for(int offset=0;offset<pixels.Length;offset+=4){pixels[offset]=31;pixels[offset+1]=31;pixels[offset+2]=31;pixels[offset+3]=255;}pixels[0]=pixels[1]=pixels[2]=48;return pixels;}
    static void QtCaretFixture(byte[] pixels,int width,int left,int top,int right,int bottom){for(int y=top;y<bottom;y++)for(int x=left;x<right;x++){int at=(y*width+x)*4;pixels[at]=0;pixels[at+1]=163;pixels[at+2]=97;}}
    static int QtEmptyPhaseSelfTest(){int checks=0;Rect editor=new Rect(300,400,460,500);byte[] blank=QtEmptyPhaseFixture(160,100);string blankHash=QtHash(blank);var known=new HashSet<string>(StringComparer.Ordinal){blankHash};
        var unchanged=Map(QtEmptyPhasePixels(blank,editor,144,known));Need(Text(unchanged,"actualRgbaSha256")==blankHash&&Text(unchanged,"normalizedRgbaSha256")==blankHash&&Object.Equals(Get(unchanged,"caretRemoved"),false),"QT_TEST_EMPTY_PHASE_EXACT");checks++;
        foreach(uint dpi in new uint[]{96,120,144,192,240}){byte[] pixels=(byte[])blank.Clone();int width=(int)Math.Ceiling(2*dpi/96.0),height=(int)Math.Round(19*dpi/96.0);QtCaretFixture(pixels,160,15,14,15+width,14+height);string before=QtHash(pixels);var matched=Map(QtEmptyPhasePixels(pixels,editor,dpi,known));Need(Text(matched,"actualRgbaSha256")==before&&Text(matched,"normalizedRgbaSha256")==blankHash&&Object.Equals(Get(matched,"caretRemoved"),true)&&QtHash(pixels)==before,"QT_TEST_EMPTY_PHASE_CARET_ONLY_SOURCE_UNCHANGED");checks++;}
        for(int variant=0;variant<9;variant++){byte[] pixels=(byte[])blank.Clone();QtCaretFixture(pixels,160,15,14,18,42);
            if(variant==0)pixels[(20*160+16)*4+1]=31;
            else if(variant==1)QtCaretFixture(pixels,160,25,14,28,42);
            else if(variant==2)QtCaretFixture(pixels,160,15,14,20,42);
            else if(variant==3)pixels[(80*160+100)*4]=90;
            else if(variant==4)pixels[(20*160+16)*4+2]=96;
            else if(variant==5)pixels[3]=0;
            else if(variant==6){pixels=(byte[])blank.Clone();QtCaretFixture(pixels,160,100,14,103,42);}
            else if(variant==7){pixels=(byte[])blank.Clone();QtCaretFixture(pixels,160,15,55,18,83);}
            else {pixels[0]=pixels[1]=pixels[2]=31;}
            Expect(delegate{QtEmptyPhasePixels(pixels,editor,144,known);},"QT_EMPTY_PHASE_UNVERIFIED");checks++;
        }
        var binding=new Binding{Window=new IntPtr(10),Pid=20,Thread=30,Created=40,Dpi=144,Focus=new IntPtr(10),Client=new Rect(0,0,800,600),Capture=new Rect(100,100,900,700)};
        var header=new QtAnchor{Rect=new Rect(300,40,700,90),Hash=new string('b',64)};var frame=new QtFrame{Binding=binding,Revision=50,Anchors=new List<QtAnchor>{header,new QtAnchor{Rect=editor,Hash=blankHash}}};
        var proof=new QtEmptyPhaseLease{Id=new string('a',32),Epoch=QtEpoch,Binding=binding,Revision=50,Issued=100,Editor=editor,Known=known,OtherAnchors=new List<QtAnchor>{header}};
        var priorProof=QtEmptyPhaseProof;string priorSurface=QtSurface;var priorPopup=QtPopup;var priorPending=QtPendingPopup;try{
            QtSurface="main";QtPopup=null;QtPendingPopup=null;var sourceFrame=new QtFrame{Binding=binding,Revision=50,Anchors=new List<QtAnchor>{header}};
            var issued=Map(QtIssueEmptyPhaseProof(sourceFrame,editor,known));Need(issued!=null&&issued.Count==4&&Same(ParseRect(Get(issued,"editorRect")),editor)&&QtEmptyPhaseBound(QtEmptyPhaseProof,Text(issued,"id"),frame,Now(),"main",false),"QT_TEST_HEADER_ONLY_COPY_SOURCE_ISSUES_BOUND_PROOF");checks++;
            Need(!QtEmptyPhaseBound(QtEmptyPhaseProof,Text(issued,"id"),sourceFrame,Now(),"main",false),"QT_TEST_PHASE_INSPECTION_STILL_REQUIRES_FULL_EDITOR");checks++;
            sourceFrame.Anchors=new List<QtAnchor>{new QtAnchor{Rect=editor,Hash=blankHash}};Need(QtIssueEmptyPhaseProof(sourceFrame,editor,known)==null,"QT_TEST_EMPTY_PHASE_REQUIRES_ORIGINAL_NONEDITOR_ANCHOR");checks++;
        }finally{QtEmptyPhaseProof=priorProof;QtSurface=priorSurface;QtPopup=priorPopup;QtPendingPopup=priorPending;}
        Need(QtEmptyPhaseBound(proof,proof.Id,frame,100,"main",false)&&QtEmptyPhaseBound(proof,proof.Id,frame,30100,"main",false),"QT_TEST_EMPTY_PHASE_EXACT_TRANSACTION");checks++;
        Need(!QtEmptyPhaseBound(proof,new string('b',32),frame,100,"main",false)&&!QtEmptyPhaseBound(proof,proof.Id,frame,99,"main",false)&&!QtEmptyPhaseBound(proof,proof.Id,frame,30101,"main",false)&&!QtEmptyPhaseBound(proof,proof.Id,frame,100,"profile",false)&&!QtEmptyPhaseBound(proof,proof.Id,frame,100,"main",true),"QT_TEST_EMPTY_PHASE_ID_AGE_AND_SURFACE");checks++;
        frame.Revision=51;Need(!QtEmptyPhaseBound(proof,proof.Id,frame,100,"main",false),"QT_TEST_EMPTY_PHASE_ACTIVITY_REVOKES");frame.Revision=50;checks++;
        proof.Epoch="other";Need(!QtEmptyPhaseBound(proof,proof.Id,frame,100,"main",false),"QT_TEST_EMPTY_PHASE_EPOCH_REVOKES");proof.Epoch=QtEpoch;checks++;
        frame.Anchors[0]=new QtAnchor{Rect=header.Rect,Hash=new string('c',64)};Need(!QtEmptyPhaseBound(proof,proof.Id,frame,100,"main",false),"QT_TEST_EMPTY_PHASE_HEADER_REVOKES");frame.Anchors[0]=header;checks++;
        frame.Anchors[1]=new QtAnchor{Rect=new Rect(301,400,460,500),Hash=blankHash};Need(!QtEmptyPhaseBound(proof,proof.Id,frame,100,"main",false),"QT_TEST_EMPTY_PHASE_FULL_EDITOR_REQUIRED");frame.Anchors[1]=new QtAnchor{Rect=editor,Hash=blankHash};checks++;
        for(int variant=0;variant<8;variant++){var changed=new Binding{Window=binding.Window,Pid=binding.Pid,Thread=binding.Thread,Created=binding.Created,Dpi=binding.Dpi,Focus=binding.Focus,Client=binding.Client,Capture=binding.Capture};
            if(variant==0)changed.Window=new IntPtr(11);else if(variant==1)changed.Pid++;else if(variant==2)changed.Thread++;else if(variant==3)changed.Created++;else if(variant==4)changed.Dpi++;else if(variant==5)changed.Focus=new IntPtr(11);else if(variant==6)changed.Client.Right++;else changed.Capture.Left++;
            frame.Binding=changed;Need(!QtEmptyPhaseBound(proof,proof.Id,frame,100,"main",false),"QT_TEST_EMPTY_PHASE_NATIVE_BINDING_REVOKES");checks++;
        }frame.Binding=binding;
        var savedProof=QtEmptyPhaseProof;bool enabled=QtEnableInput;try{QtEnableInput=false;
            foreach(string action in new string[]{"click","movePointer","chord","type"}){QtEmptyPhaseProof=proof;Expect(delegate{QtAct(Data(),action);},"QT_INPUT_DISABLED");Need(QtEmptyPhaseProof==null,"QT_TEST_OWN_INPUT_REVOKES_EMPTY_PHASE");checks++;}
            QtEmptyPhaseProof=proof;Expect(delegate{QtPaste(Data(),IntPtr.Zero);},"QT_INPUT_DISABLED");Need(QtEmptyPhaseProof==null,"QT_TEST_PASTE_REVOKES_EMPTY_PHASE");checks++;
            QtEmptyPhaseProof=proof;Expect(delegate{QtReadDraft(Data(),IntPtr.Zero);},"QT_INPUT_DISABLED");Need(QtEmptyPhaseProof==null,"QT_TEST_NEW_COPY_REVOKES_EMPTY_PHASE");checks++;
            QtEmptyPhaseProof=proof;Expect(delegate{QtTransferFocus();},"QT_FOCUS_LEASE_UNAVAILABLE");Need(QtEmptyPhaseProof==null,"QT_TEST_TRANSFER_REVOKES_EMPTY_PHASE");checks++;
        }finally{QtEmptyPhaseProof=savedProof;QtEnableInput=enabled;}
        return checks;
    }
    static int QtInitialEmptyTemplateSelfTest(){int count=0;Rect editor=new Rect(300,400,460,500);byte[] blank=QtEmptyPhaseFixture(160,100);string blankHash=QtHash(blank);var known=new HashSet<string>(StringComparer.Ordinal){blankHash};bool normalized;
        Need(QtInitialEmptyTemplate(blank,editor,144,known,out normalized)==blankHash&&!normalized,"QT_TEST_INITIAL_EMPTY_EXACT_PATH");count++;
        foreach(uint dpi in new uint[]{96,120,144,192,240}){byte[] pixels=(byte[])blank.Clone();QtCaretFixture(pixels,160,15,14,15+(int)Math.Ceiling(2*dpi/96.0),14+(int)Math.Round(19*dpi/96.0));string original=QtHash(pixels);
            Need(QtInitialEmptyTemplate(pixels,editor,dpi,known,out normalized)==blankHash&&normalized&&QtHash(pixels)==original&&known.Count==1&&known.Contains(blankHash),"QT_TEST_INITIAL_EMPTY_STRICT_CARET_NO_LEARNING");count++;}
        for(int variant=0;variant<11;variant++){byte[] pixels=(byte[])blank.Clone();QtCaretFixture(pixels,160,15,14,18,42);
            if(variant==0)pixels[(20*160+16)*4+1]=31;
            else if(variant==1)QtCaretFixture(pixels,160,25,14,28,42);
            else if(variant==2)QtCaretFixture(pixels,160,15,14,20,42);
            else if(variant==3)pixels[(80*160+100)*4]=90;
            else if(variant==4)pixels[(20*160+16)*4+2]=96;
            else if(variant==5)pixels[3]=0;
            else if(variant==6){pixels=(byte[])blank.Clone();QtCaretFixture(pixels,160,100,14,103,42);}
            else if(variant==7){pixels=(byte[])blank.Clone();QtCaretFixture(pixels,160,15,55,18,83);}
            else if(variant==8){pixels[0]=pixels[1]=pixels[2]=31;}
            else if(variant==9){pixels=(byte[])blank.Clone();QtCaretFixture(pixels,160,15,14,18,19);}
            else {pixels=(byte[])blank.Clone();QtCaretFixture(pixels,160,15,14,18,75);}
            string original=QtHash(pixels),candidate=QtInitialEmptyTemplate(pixels,editor,144,known,out normalized);
            Need(candidate==original&&!known.Contains(candidate)&&!normalized&&QtHash(pixels)==original,"QT_TEST_INITIAL_EMPTY_UNKNOWN_PIXELS_STAY_UNMATCHED");count++;
        }
        byte[] legal=(byte[])blank.Clone();QtCaretFixture(legal,160,15,14,18,42);string legalHash=QtHash(legal);var unknown=new HashSet<string>(StringComparer.Ordinal){new string('a',64)};
        Need(QtInitialEmptyTemplate(legal,editor,144,unknown,out normalized)==legalHash&&!normalized&&unknown.Count==1,"QT_TEST_INITIAL_EMPTY_REQUIRES_KNOWN_NORMALIZED_FRAME");count++;
        long clock=0;int guards=0,samples=0,waits=0;bool sampledNormalized=false;
        Need(QtWaitEmptyTemplate(known,650,delegate{guards++;},delegate{samples++;return QtInitialEmptyTemplate(legal,editor,144,known,out sampledNormalized);},delegate{return clock;},delegate(int ms){waits++;clock+=ms;})&&sampledNormalized&&guards==2&&samples==1&&waits==0,"QT_TEST_INITIAL_EMPTY_MATCH_KEEPS_BOTH_GUARDS");count++;
        guards=0;Expect(delegate{QtWaitEmptyTemplate(known,650,delegate{if(++guards==2)throw new Fault("DRAFT_CLIPBOARD_CHANGED");},delegate{return QtInitialEmptyTemplate(legal,editor,144,known,out sampledNormalized);},delegate{return clock;},delegate(int ms){clock+=ms;});},"DRAFT_CLIPBOARD_CHANGED");count++;
        clock=0;Need(!QtWaitEmptyTemplate(known,650,delegate{},delegate{clock=651;return QtInitialEmptyTemplate(legal,editor,144,known,out sampledNormalized);},delegate{return clock;},delegate(int ms){clock+=ms;}),"QT_TEST_INITIAL_EMPTY_LATE_NORMALIZED_FRAME_REJECTED");count++;
        clock=0;samples=0;Need(!QtWaitEmptyTemplate(known,650,delegate{},delegate{samples++;return QtInitialEmptyTemplate(legal,editor,144,unknown,out sampledNormalized);},delegate{return clock;},delegate(int ms){clock+=ms;})&&clock==650&&samples==26,"QT_TEST_INITIAL_EMPTY_UNKNOWN_NORMALIZATION_BOUNDED");count++;
        return count;
    }
    static Dictionary<string,object> QtEmptyTimingFixture(int scenario,bool measured){
        long clock=1000,deadline=scenario==3?1000:1100;int samples=0,guards=0;var trace=new List<string>();
        var timing=measured?new QtEmptyWaitTiming(delegate{return clock;}):null;bool? result=null;string fault=null;
        try{result=QtWaitEmptyTemplate(new HashSet<string>(StringComparer.Ordinal){new string('a',64)},deadline,
            delegate{trace.Add("guard");guards++;clock+=2;if(scenario==5&&guards==3)throw new Fault("QT_HUMAN_ACTIVITY_CHANGED");},
            delegate{trace.Add("sample");samples++;clock+=3;if(scenario==6)throw new Fault("QT_CAPTURE_FIXTURE_FAILED");if(scenario==4)clock=deadline+1;return scenario==0||scenario==4||scenario==1&&samples==3?new string('a',64):new string('b',64);},
            delegate{trace.Add("clock");return clock;},
            delegate(int milliseconds){trace.Add("wait:"+milliseconds.ToString(CultureInfo.InvariantCulture));clock+=milliseconds;if(scenario==7)throw new Fault("QT_WAIT_FIXTURE_FAILED");},timing);
        }catch(Fault error){fault=error.Message;}
        return Data("result",result,"fault",fault,"clock",clock,"trace",trace,"sampleCount",samples,"guardCount",guards,"timing",timing==null?null:timing.Report());
    }
    static int QtEmptyTimingSelfTest(){int count=0;
        for(int scenario=0;scenario<8;scenario++){
            var plain=QtEmptyTimingFixture(scenario,false);var measured=QtEmptyTimingFixture(scenario,true);plain.Remove("timing");measured.Remove("timing");
            Need(Json.Serialize(plain)==Json.Serialize(measured),"QT_TEST_EMPTY_TIMING_PRESERVES_ACTION_AND_CLOCK_TRACE");count++;
        }
        var immediate=Map(Get(QtEmptyTimingFixture(0,true),"timing"));Need(Number(Get(immediate,"sampleCount"))==1&&Number(Get(immediate,"firstMatchAfterMs"))==7&&Number(Get(immediate,"guardMs"))==4&&Number(Get(immediate,"captureMs"))==3&&Number(Get(immediate,"waitMs"))==0,"QT_TEST_EMPTY_TIMING_IMMEDIATE_COMPONENTS");count++;
        var delayed=Map(Get(QtEmptyTimingFixture(1,true),"timing"));Need(Number(Get(delayed,"sampleCount"))==3&&Number(Get(delayed,"firstMatchAfterMs"))==71&&Number(Get(delayed,"guardMs"))==12&&Number(Get(delayed,"captureMs"))==9&&Number(Get(delayed,"waitMs"))==50,"QT_TEST_EMPTY_TIMING_RETRY_COMPONENTS");count++;
        foreach(int scenario in new[]{2,3,4,5,6,7})Need(Get(Map(Get(QtEmptyTimingFixture(scenario,true),"timing")),"firstMatchAfterMs")==null,"QT_TEST_EMPTY_TIMING_FAILURE_HAS_NO_MATCH");count++;
        var expired=Map(Get(QtEmptyTimingFixture(3,true),"timing"));Need(Number(Get(expired,"sampleCount"))==0&&Number(Get(expired,"guardMs"))==2&&Number(Get(expired,"captureMs"))==0&&Number(Get(expired,"waitMs"))==0,"QT_TEST_EMPTY_TIMING_EXPIRED_STILL_GUARDS_WITHOUT_SAMPLE");count++;
        Need(immediate.Count==6&&!Json.Serialize(immediate).Contains(new string('a',64))&&!Json.Serialize(immediate).Contains(new string('b',64)),"QT_TEST_EMPTY_TIMING_NUMBERS_ONLY");foreach(object value in immediate.Values)Need(value==null||value is long,"QT_TEST_EMPTY_TIMING_NO_PAYLOAD");count++;
        return count;
    }
    static int QtFocusRestoreDiagnosticSelfTest(){int count=0;
        var epochLease=new QtFocusLease{Revision=12};Need(QtReturnActivityRevision(epochLease,12)==12,"QT_TEST_RETURN_PRESERVES_LEASE_ACTIVITY_EPOCH");Expect(delegate{QtReturnActivityRevision(epochLease,13);},"QT_HUMAN_ACTIVITY_CHANGED");count++;
        IntPtr zTarget=new IntPtr(1),zNear=new IntPtr(2),zFar=new IntPtr(3);Func<IntPtr,IntPtr> zPrevious=delegate(IntPtr window){return window==zTarget?zNear:window==zNear?zFar:IntPtr.Zero;};
        var zChain=QtReadPreviousChain(zTarget,zPrevious,delegate(IntPtr window){return true;},delegate{return 0;},200,16);Need(zChain.Complete&&zChain.Reason=="end"&&zChain.Windows.Count==2&&zChain.Windows[0]==zNear&&zChain.Windows[1]==zFar,"QT_TEST_OCCLUSION_EXPLICIT_PREDECESSOR_ORDER");count++;
        zChain=QtReadPreviousChain(zTarget,delegate(IntPtr window){return window==zTarget?zNear:zTarget;},delegate(IntPtr window){return true;},delegate{return 0;},200,16);Need(!zChain.Complete&&zChain.Reason=="cycle"&&zChain.Windows.Count==1,"QT_TEST_OCCLUSION_DIAGNOSTIC_CYCLE_BOUND");count++;
        zChain=QtReadPreviousChain(zTarget,zPrevious,delegate(IntPtr window){return window!=zNear;},delegate{return 0;},200,16);Need(!zChain.Complete&&zChain.Reason=="window-unavailable"&&zChain.Windows.Count==0,"QT_TEST_OCCLUSION_DIAGNOSTIC_DESTROYED_WINDOW");count++;
        zChain=QtReadPreviousChain(zTarget,zPrevious,delegate(IntPtr window){return true;},delegate{return 0;},200,1);Need(!zChain.Complete&&zChain.Reason=="limit"&&zChain.Windows.Count==1,"QT_TEST_OCCLUSION_DIAGNOSTIC_COUNT_BOUND");count++;
        int zCalls=0;zChain=QtReadPreviousChain(zTarget,delegate(IntPtr window){zCalls++;return zNear;},delegate(IntPtr window){return true;},delegate{return 201;},200,16);Need(!zChain.Complete&&zChain.Reason=="deadline"&&zCalls==0,"QT_TEST_OCCLUSION_DIAGNOSTIC_TIME_BOUND");count++;
        var zRegions=QtOcclusionRegions(Data("header",new Rect(20,10,200,60).Report(),"editor",new Rect(20,100,200,180).Report()),new Rect(0,0,220,200));Need(zRegions.Count==2&&QtOcclusionRegionPoints(zRegions["header"]).Count==5,"QT_TEST_OCCLUSION_EXPLICIT_REGIONS_ONLY");Expect(delegate{QtOcclusionRegions(Data("private-title",new Rect(20,10,200,60).Report()),new Rect(0,0,220,200));},"QT_OCCLUSION_REGIONS_INVALID");Expect(delegate{QtOcclusionRegions(Data("editor",new Rect(20,100,201,180).Report()),new Rect(0,0,200,200));},"QT_OCCLUSION_REGIONS_INVALID");count++;
        Need(QtBeginActivityRevision(null,12)==12&&QtBeginActivityRevision(12,12)==12,"QT_TEST_BEGIN_AND_RESUME_EXPLICIT_EPOCH");Expect(delegate{QtBeginActivityRevision(12,13);},"QT_HUMAN_ACTIVITY_CHANGED");count++;
        Need(QtTransferredUnchanged(100,100,12,12)&&!QtTransferredUnchanged(100,101,12,12)&&!QtTransferredUnchanged(100,100,12,13),"QT_TEST_TRANSFERRED_TOKEN_REQUIRES_BOTH_INPUT_TICK_AND_INITIAL_MONITOR_EPOCH");count++;
        Need(QtTransferredFresh(1000,1000)&&QtTransferredFresh(1000,31000)&&!QtTransferredFresh(1000,31001)&&!QtTransferredFresh(1000,999)&&!QtTransferredFresh(0,1000),"QT_TEST_TRANSFERRED_TOKEN_EXPIRY_NOT_REBASED_BY_NEW_HELPER");count++;
        for(int flags=0;flags<16;flags++){bool foreground=(flags&1)!=0,identities=(flags&2)!=0,activity=(flags&4)!=0,keys=(flags&8)!=0;string reason=QtRestoreSkipReason(foreground,identities,activity,keys);
            Need((reason=="conditions-satisfied")==QtCanRestore(foreground,identities,activity,keys),"QT_TEST_RESTORE_DIAGNOSTIC_PRESERVES_CONDITIONS");count++;}
        var absent=Map(QtRestoreFocus(null,false));var unavailable=Map(Get(absent,"focusRestoreOutcome"));Need(Text(unavailable,"reason")=="lease-absent"&&unavailable.Count==9&&Get(unavailable,"foregroundOwnedByWechat")==null&&Get(unavailable,"activityUnchanged")==null,"QT_TEST_ABSENT_LEASE_IS_NOT_A_FALSE_ACTIVITY_CLAIM");count++;
        var skipped=QtRestoreOutcome("keys-held",false,true,true,true,true,false);var interval=Data("phase","preparation","durationMs",78L,"includesContactNavigation",false,"complete",false);var report=Data("restored",false,"skipped",true,"focusRestoreOutcome",skipped,"foregroundInterval",interval);
        try{QtNeedParkRestored(report,null);throw new Fault("QT_TEST_PARK_SKIP_WAS_ACCEPTED");}catch(Fault error){Need(error.Message=="QT_FOCUS_RETURN_UNCONFIRMED"&&Json.Serialize(QtFocusRestoreFailure(error))==Json.Serialize(skipped)&&Object.Equals(Get(Map(QtFocusTimingFailure(error)),"complete"),false),"QT_TEST_PARK_SKIP_PRESERVES_ORIGIN_AND_TIMING");}count++;
        var restored=QtRestoreOutcome("restored",true,false,true,true,true,true);var complete=Data("phase","preparation","durationMs",78L,"includesContactNavigation",false,"complete",true);var restoredReport=Data("restored",true,"skipped",false,"focusRestoreOutcome",restored,"foregroundInterval",complete);
        try{QtNeedParkRestored(restoredReport,false);throw new Fault("QT_TEST_PARK_ACTIVITY_WAS_ACCEPTED");}catch(Fault error){var origin=Map(QtFocusRestoreFailure(error));Need(error.Message=="QT_FOCUS_RETURN_UNCONFIRMED"&&Text(origin,"reason")=="park-activity-changed"&&Object.Equals(Get(origin,"restored"),true)&&Object.Equals(Get(origin,"parkRevisionUnchanged"),false)&&Object.Equals(Get(Map(QtFocusTimingFailure(error)),"complete"),false),"QT_TEST_PARK_POST_RETURN_ACTIVITY_PRESERVES_RETURN_SUCCESS");}count++;
        Need(Text(restored,"reason")=="restored"&&Get(restored,"parkRevisionUnchanged")==null&&Object.Equals(Get(complete,"complete"),true),"QT_TEST_PARK_DIAGNOSTIC_DOES_NOT_MUTATE_ORIGIN");count++;
        bool attempted=InputAttempted;QtNeedParkRestored(restoredReport,true);Need(InputAttempted==attempted,"QT_TEST_RESTORE_DIAGNOSTIC_NO_INPUT");count++;
        var partial=QtRestoreOutcome("identity-check-failed",null,false,true,null,true,null);Need(Get(partial,"restored")==null&&Get(partial,"identitiesUnchanged")==null&&Get(partial,"keysReleased")==null,"QT_TEST_UNCOMPLETED_CHECKS_REMAIN_UNKNOWN");foreach(var item in partial)Need(item.Key=="reason"?item.Value is string:item.Key=="version"?Object.Equals(item.Value,1):item.Value==null||item.Value is bool,"QT_TEST_RESTORE_DIAGNOSTIC_NO_IDENTITIES_OR_TEXT");count++;
        return count;
    }
    static int QtCaptureSnapshotSelfTest(){int count=0;
        Func<QtPopupLease> lease=delegate{return new QtPopupLease{Id="search",Window=new IntPtr(21),Observed=true,
            Calibration=new QtPopupCalibration{Kind="search",OwnerRelation="same-thread-unowned"},Root=new Binding{Dpi=120,Capture=new Rect(900,100,1676,836)},
            ObservedBounds=new Rect(960,179,1420,299),ObservedClient=new Rect(0,0,460,120),ObservedClientScreen=new Rect(960,179,1420,299)};};
        var originalLease=lease();var original=new QtPopupCaptureSnapshot(originalLease,new Rect(960,179,1420,579),new Rect(0,0,460,400),new Point(960,179),120);
        Func<QtPopupCaptureSnapshot> same=delegate{return new QtPopupCaptureSnapshot(originalLease,new Rect(960,179,1420,579),new Rect(0,0,460,400),new Point(960,179),120);};
        QtNeedSamePopupCaptureSnapshot(original,same());Need(QtPopupGeometryAllowed(original.Bounds,original.Client,original.ClientScreen,originalLease),"QT_TEST_CAPTURE_SNAPSHOT_INITIAL_GEOMETRY");count++;
        var expanded=new QtPopupCaptureSnapshot(originalLease,new Rect(960,179,1420,662),new Rect(0,0,460,483),new Point(960,179),120);
        Need(QtPopupGeometryAllowed(expanded.Bounds,expanded.Client,expanded.ClientScreen,originalLease),"QT_TEST_CAPTURE_SNAPSHOT_LATER_HEIGHT_INDIVIDUALLY_ALLOWED");
        Expect(delegate{QtNeedSamePopupCaptureSnapshot(original,expanded);},"QT_POPUP_BINDING_CHANGED");count++;
        // Reproduce the reported 400px window/client with a later 483px
        // clientRectInRoot: one frozen tuple is used for both anchor and reply.
        var report=original.Report();Rect reportedClient=ParseRect(Get(report,"clientRect")),reportedRelative=ParseRect(Get(report,"clientRectInRoot"));
        Need(reportedClient.Height==400&&reportedRelative.Height==400&&Same(reportedRelative,original.Relative)&&Same(ParseRect(Get(report,"windowRect")),original.Bounds),"QT_TEST_CAPTURE_REPORT_CANNOT_MIX_LATER_HEIGHT");count++;
        for(int change=0;change<10;change++){
            QtPopupLease currentLease=originalLease;Rect bounds=original.Bounds,client=original.Client;Point origin=new Point(960,179);uint dpi=120;
            if(change==0)bounds.Bottom++;else if(change==1)client.Bottom++;else if(change==2)origin.Y++;else if(change==3)dpi=144;
            else if(change==4)currentLease=lease();else if(change==5)originalLease.Window=new IntPtr(22);else if(change==6)originalLease.Id="profile";
            else if(change==7)originalLease.Calibration.Kind="profile";else if(change==8)originalLease.Calibration.OwnerRelation="root-owned";else originalLease.Root.Capture.Left++;
            var changed=new QtPopupCaptureSnapshot(currentLease,bounds,client,origin,dpi);
            Expect(delegate{QtNeedSamePopupCaptureSnapshot(original,changed);},"QT_POPUP_BINDING_CHANGED");count++;
            // The emitted result cannot query the now-mutated lease either.
            var frozen=original.Report();Need(Text(frozen,"surfaceId")=="search"&&Text(frozen,"kind")=="search"&&Text(frozen,"hwnd")=="21"&&Number(Get(frozen,"dpi"))==120&&Same(ParseRect(Get(frozen,"clientRectInRoot")),original.Relative),"QT_TEST_CAPTURE_REPORT_USES_IMMUTABLE_FIELDS");
            originalLease.Window=new IntPtr(21);originalLease.Id="search";originalLease.Calibration.Kind="search";originalLease.Calibration.OwnerRelation="same-thread-unowned";originalLease.Root.Capture=new Rect(900,100,1676,836);
        }
        string directory=Path.Combine(Path.GetTempPath(),"wechatagent-qt-capture-"+Guid.NewGuid().ToString("N"));Directory.CreateDirectory(directory);
        string failed=Path.Combine(directory,"failed.png"),success=Path.Combine(directory,"success.png"),existing=Path.Combine(directory,"existing.png"),partial=Path.Combine(directory,"partial.png"),uncreated=Path.Combine(directory,"uncreated.png");
        try{
            Expect(delegate{using(var image=new QtOwnedCaptureImage(failed)){image.Write(new byte[]{1,2,3});QtNeedSamePopupCaptureSnapshot(original,expanded);}},"QT_POPUP_BINDING_CHANGED");
            Need(!File.Exists(failed),"QT_TEST_CAPTURE_REFUSAL_REMOVES_OWNED_IMAGE");count++;
            using(var image=new QtOwnedCaptureImage(success)){image.Write(new byte[]{1,2,3});image.Transfer();}
            Need(File.Exists(success)&&QtHash(File.ReadAllBytes(success))==QtHash(new byte[]{1,2,3}),"QT_TEST_CAPTURE_SUCCESS_RETURNS_OWNED_IMAGE");count++;
            File.WriteAllBytes(existing,new byte[]{7,8,9});bool collision=false;
            try{using(var image=new QtOwnedCaptureImage(existing)){image.Write(new byte[]{1,2,3});}}catch(IOException){collision=true;}
            Need(collision&&QtHash(File.ReadAllBytes(existing))==QtHash(new byte[]{7,8,9}),"QT_TEST_CAPTURE_CREATE_NEW_FAILURE_NEVER_DELETES_EXISTING");count++;
            bool writeFailed=false;try{using(var image=new QtOwnedCaptureImage(partial)){image.Write(null);}}catch(NullReferenceException){writeFailed=true;}
            Need(writeFailed&&!File.Exists(partial),"QT_TEST_CAPTURE_WRITE_FAILURE_REMOVES_ONLY_OWN_CREATED_FILE");count++;
            using(var image=new QtOwnedCaptureImage(uncreated)){}Need(!File.Exists(uncreated)&&File.Exists(existing)&&File.Exists(success),"QT_TEST_CAPTURE_NO_DIRECTORY_SCAN_OR_UNCREATED_DELETE");count++;
        }finally{foreach(string file in new[]{failed,success,existing,partial,uncreated})if(File.Exists(file))File.Delete(file);Directory.Delete(directory);}
        return count;
    }
    static int QtEnterSelfTest(){int count=0;string savedSurface=QtSurface;var savedPopup=QtPopup;var savedPending=QtPendingPopup;var savedEnter=QtPendingEnter;
        try{
            Func<Binding> binding=delegate{return new Binding{Window=new IntPtr(20),Pid=30,Created=40,Thread=50,Dpi=120,Focus=new IntPtr(20),Caret=new IntPtr(20),FocusOwned=true,CaretOwned=true,GuiFlags=1,CaretInClient=new Rect(125,60,127,62),Client=new Rect(0,0,800,600),Capture=new Rect(900,100,1700,700)};};
            Rect query=new Rect(91,53,261,87);var popup=new QtPopupLease{Id="search",Observed=true,Calibration=new QtPopupCalibration{Kind="search"},Root=binding(),Window=new IntPtr(21),Revision=7};QtPopup=popup;QtPendingPopup=null;QtSurface="observed-search";
            Func<QtFrame> frame=delegate{return new QtFrame{Binding=binding(),Revision=7,Issued=1000,PopupBounds=new Rect(960,179,1420,299),PopupClient=new Rect(0,0,460,120),Anchors=new List<QtAnchor>{new QtAnchor{Rect=query,Hash=new string('a',64)}}};};
            Func<QtEnterProof> proof=delegate{return new QtEnterProof{Id="fixture",Kind="search",Digest=new string('b',64),Epoch=QtEpoch,Frame=frame(),Popup=popup};};
            Need(QtEnterProofMatches(proof(),"search","fixture",new string('b',64),frame(),1001)&&QtEnterCaret(binding(),query,79),"QT_TEST_ENTER_SEARCH_PROOF_AND_ACTUAL_CARET");count++;
            for(int change=0;change<12;change++){var p=proof();var f=frame();long now=1001;string digest=new string('b',64),name="fixture",kind="search";
                if(change==0)p.Consumed=true;if(change==1)p.Epoch="other";if(change==2)f.Revision++;if(change==3)f.Binding.Thread++;if(change==4)f.Binding.Focus=new IntPtr(99);if(change==5)f.Anchors[0].Hash=new string('c',64);if(change==6)f.Anchors[0].Rect=new Rect(92,53,261,87);if(change==7)now=31001;if(change==8)now=999;if(change==9)digest=new string('d',64);if(change==10)name="other";if(change==11)kind="text";
                Need(!QtEnterProofMatches(p,kind,name,digest,f,now),"QT_TEST_ENTER_CHANGED_PROOF_REFUSED");count++;
            }
            var prior=proof();QtPopup=new QtPopupLease();Need(!QtEnterProofMatches(prior,"search","fixture",new string('b',64),frame(),1001),"QT_TEST_ENTER_REOPENED_LEASE_REFUSED");QtPopup=popup;count++;
            var resized=frame();resized.PopupBounds=new Rect(960,179,1420,579);resized.PopupClient=new Rect(0,0,460,400);Need(!QtEnterProofMatches(proof(),"search","fixture",new string('b',64),resized,1001),"QT_TEST_ENTER_POSTPASTE_POPUP_CHANGED_REFUSED");count++;
            for(int change=0;change<8;change++){var b=binding();if(change==0)b.Caret=IntPtr.Zero;if(change==1)b.CaretOwned=false;if(change==2)b.FocusOwned=false;if(change==3)b.Focus=new IntPtr(99);if(change==4)b.GuiFlags=0;if(change==5)b.CaretInClient=new Rect(125,78,127,80);if(change==6)b.CaretInClient=new Rect(90,60,92,62);if(change==7)b.CaretInClient=new Rect(125,60,125,62);Need(!QtEnterCaret(b,query,79),"QT_TEST_ENTER_INVALID_CARET_REFUSED");count++;}
            QtSurface="main";QtPopup=null;var textFrame=frame();textFrame.Anchors=new List<QtAnchor>{new QtAnchor{Rect=new Rect(300,20,780,70),Hash=new string('a',64)},new QtAnchor{Rect=new Rect(300,400,780,550),Hash=new string('b',64)}};var textProof=new QtEnterProof{Id="text",Kind="text",Digest=new string('c',64),Epoch=QtEpoch,Frame=textFrame};
            QtNeedTextAnchors(textFrame,textFrame.Anchors[0].Rect,textFrame.Anchors[1].Rect);Need(QtEnterProofMatches(textProof,"text","text",new string('c',64),textFrame,1001),"QT_TEST_ENTER_VERIFIED_TEXT_ONLY");count++;
            var copied=frame();copied.Anchors=new List<QtAnchor>{new QtAnchor{Rect=textFrame.Anchors[0].Rect,Hash=textFrame.Anchors[0].Hash},new QtAnchor{Rect=textFrame.Anchors[1].Rect,Hash=textFrame.Anchors[1].Hash}};
            Need(QtEnterProofMatches(textProof,"text","text",new string('c',64),copied,1001),"QT_TEST_ENTER_FRESH_SAME_PIXELS_ALLOWED");count++;
            copied.Anchors[1].Hash=new string('d',64);Need(!QtEnterProofMatches(textProof,"text","text",new string('c',64),copied,1001),"QT_TEST_ENTER_CHANGED_DRAFT_PIXELS_REFUSED");count++;
            textProof.InputOnly=true;Need(QtEnterProofMatches(textProof,"text","text",new string('c',64),copied,1001),"QT_TEST_UNCHECKED_PASTE_NO_BODY_PIXEL_RECHECK");count++;
            copied.Revision++;Need(!QtEnterProofMatches(textProof,"text","text",new string('c',64),copied,1001),"QT_TEST_UNCHECKED_PASTE_HUMAN_INTERRUPT_STILL_STOPS");copied.Revision--;count++;
            copied.Binding.Window=new IntPtr(99);Need(!QtEnterProofMatches(textProof,"text","text",new string('c',64),copied,1001),"QT_TEST_UNCHECKED_PASTE_STAYS_IN_ORIGINAL_WINDOW");copied.Binding.Window=textFrame.Binding.Window;count++;
            textProof.Consumed=true;Need(!QtEnterProofMatches(textProof,"text","text",new string('c',64),copied,1001),"QT_TEST_UNCHECKED_PASTE_CANNOT_REPEAT_ENTER");textProof.Consumed=false;textProof.InputOnly=false;count++;
            copied.Anchors[1].Hash=textFrame.Anchors[1].Hash;copied.Anchors[0].Hash=new string('d',64);Need(!QtEnterProofMatches(textProof,"text","text",new string('c',64),copied,1001),"QT_TEST_ENTER_CHANGED_CHAT_HEADER_REFUSED");count++;
            var editorBinding=binding();editorBinding.CaretInClient=new Rect(320,420,322,422);Need(QtEnterCaret(editorBinding,textFrame.Anchors[1].Rect,null)&&!QtEnterCaret(binding(),textFrame.Anchors[1].Rect,null),"QT_TEST_ENTER_EDITOR_CARET_NOT_SEARCH_CARET");count++;
            Rect editor=textFrame.Anchors[1].Rect;Func<Binding> editorFocus=delegate{var b=binding();b.CaretInClient=new Rect(320,420,322,422);return b;};Func<Binding> absentFocus=delegate{var b=binding();b.Caret=IntPtr.Zero;b.CaretOwned=false;b.GuiFlags=0;b.CaretInClient=new Rect(0,0,0,0);return b;};
            var hidden=editorFocus();hidden.GuiFlags=0;Need(QtTextEnterFocus(editorFocus(),hidden,editor)&&QtTextEnterFocus(hidden,editorFocus(),editor),"QT_TEST_TEXT_ENTER_CARET_VISIBILITY_NOT_FOCUS");count++;
            Need(QtTextEnterFocus(absentFocus(),absentFocus(),editor)&&QtTextEnterFocus(absentFocus(),editorFocus(),editor),"QT_TEST_TEXT_ENTER_PROVEN_ZERO_CARET_TUPLE");count++;
            Need(!QtTextEnterFocus(editorFocus(),absentFocus(),editor),"QT_TEST_TEXT_ENTER_NEWLY_ABSENT_CARET_REFUSED");count++;
            for(int change=0;change<13;change++){var beforeFocus=absentFocus();var afterFocus=absentFocus();if(change==0)beforeFocus.FocusOwned=false;if(change==1)afterFocus.FocusOwned=false;if(change==2)afterFocus.Focus=new IntPtr(99);if(change==3)afterFocus.Thread++;if(change==4)afterFocus.Pid++;if(change==5)afterFocus.GuiFlags=1;if(change==6)afterFocus.CaretOwned=true;if(change==7)afterFocus.CaretInClient=new Rect(0,0,1,0);if(change==8)afterFocus.Caret=new IntPtr(99);if(change==9)beforeFocus.GuiFlags=4;if(change==10)beforeFocus.CaretInClient=query;if(change==11)afterFocus.GuiFlags=2;if(change==12)beforeFocus.Caret=new IntPtr(99);Need(!QtTextEnterFocus(beforeFocus,afterFocus,editor),"QT_TEST_TEXT_ENTER_CONTRADICTORY_FOCUS_REFUSED");count++;}
            Need(!QtTextEnterFocus(editorFocus(),binding(),editor)&&!QtTextEnterFocus(binding(),editorFocus(),editor),"QT_TEST_TEXT_ENTER_QUERY_CARET_REFUSED");count++;
            for(uint flag=2;flag<=16;flag*=2){var menu=editorFocus();menu.GuiFlags=flag;Need(!QtTextEnterFocus(editorFocus(),menu,editor),"QT_TEST_TEXT_ENTER_MENU_OR_MOVE_REFUSED");count++;}
            var diagnostic=Map(QtEnterFocusFailure(QtEnterFocusRefusal("text",editorFocus(),binding(),editor)));Need(diagnostic.Count==7&&Object.Equals(diagnostic["proofVerified"],true)&&Map(diagnostic["source"]).Count==8&&Map(diagnostic["current"]).Count==8&&!diagnostic.ContainsKey("text")&&!Map(diagnostic["source"]).ContainsKey("hwnd"),"QT_TEST_TEXT_ENTER_ANONYMOUS_DIAGNOSTIC");count++;
            Expect(delegate{QtNeedTextAnchors(textFrame,textFrame.Anchors[1].Rect,textFrame.Anchors[0].Rect);},"QT_TEXT_ENTER_ANCHORS_REQUIRED");count++;
            var draftSource=frame();draftSource.Anchors=new List<QtAnchor>{textFrame.Anchors[0]};QtNeedDraftSource(draftSource,textFrame.Anchors[0].Rect,textFrame.Anchors[1].Rect);count++;
            Expect(delegate{QtNeedTextAnchors(draftSource,textFrame.Anchors[0].Rect,textFrame.Anchors[1].Rect);},"QT_TEXT_ENTER_ANCHORS_REQUIRED");count++;
            Expect(delegate{QtNeedDraftSource(draftSource,new Rect(301,20,780,70),textFrame.Anchors[1].Rect);},"QT_TEXT_ENTER_ANCHORS_REQUIRED");count++;
            QtSurface="observed-search";Expect(delegate{QtNeedDraftSource(draftSource,textFrame.Anchors[0].Rect,textFrame.Anchors[1].Rect);},"QT_TEXT_ENTER_ANCHORS_REQUIRED");QtSurface="main";count++;
            Need(QtHash(Encoding.UTF8.GetBytes(QtNormalizeText("a\r\nb\rc")))==QtHash(Encoding.UTF8.GetBytes("a\nb\nc")),"QT_TEST_ENTER_RECOVERED_CRLF_DIGEST_NORMALIZED");count++;
            var stepPacket=Data("version",1,"deliveryId",new string('a',64),"accountSha256",new string('b',64),"targetSha256",new string('c',64));var step=QtParseTextStep(stepPacket);Need(QtSameTextStep(step,QtParseTextStep(stepPacket))&&QtSameTextStep(null,null)&&!QtSameTextStep(step,null),"QT_TEST_TEXT_STEP_EXACT_BINDING");count++;
            Need(QtTypedTextEvents("\u597d",null).Length==2&&QtTypedTextEvents("\ud83d\ude0a",null).Length==4&&QtTypedTextEvents("\ud83d\udc69\u200d\ud83d\udcbb",null).Length==10,"QT_TEST_TYPED_GRAPHEME_EVENTS");count++;
            var newline=QtTypedTextEvents("\n","Shift+Enter");Need(newline.Length==4&&newline[0].Value.Keyboard.Key==0x10&&newline[1].Value.Keyboard.Key==0x0d&&newline[2].Value.Keyboard.Flags==2&&newline[3].Value.Keyboard.Flags==2,"QT_TEST_TYPED_NEWLINE_NOT_SUBMIT");count++;
            Expect(delegate{QtTypedTextEvents("\n",null);},"QT_NEWLINE_CALIBRATION_REQUIRED");count++;
            Expect(delegate{QtTypedTextEvents("ab",null);},"DRAFT_APPEND_NOT_SINGLE_GRAPHEME");count++;
            var typedFrame=new QtFrame{Binding=textFrame.Binding,Revision=textFrame.Revision,Issued=UtcMs(),Anchors=textFrame.Anchors};
            var typedProof=new QtEnterProof{Id="typed",Kind="text",Digest=QtHash(Encoding.UTF8.GetBytes("\u4f60")),Epoch=QtEpoch,Frame=typedFrame,Step=step,InputOnly=true};
            Need(QtTypedPrefixMatches(null,step,"\u4f60","\u4f60",typedFrame,null)&&QtTypedPrefixMatches(typedProof,step,"\u597d","\u4f60\u597d",typedFrame,"typed"),"QT_TEST_TYPED_PREFIX_CONTINUATION");count++;
            Need(!QtTypedPrefixMatches(null,step,"\u597d","\u4f60\u597d",typedFrame,null)&&!QtTypedPrefixMatches(typedProof,step,"\u597d","\u4ed6\u597d",typedFrame,"typed")&&!QtTypedPrefixMatches(typedProof,step,"\u597d","\u4f60\u597d",typedFrame,"other"),"QT_TEST_TYPED_PREFIX_NOT_FORGED");count++;
            typedProof.Paused=true;Need(!QtTypedPrefixMatches(typedProof,step,"\u597d","\u4f60\u597d",typedFrame,"typed"),"QT_TEST_TYPED_PAUSE_NEEDS_RESUME");count++;
            for(int change=0;change<5;change++){var invalid=new Dictionary<string,object>(stepPacket);if(change==0)invalid["version"]=2;if(change==1)invalid["deliveryId"]="plain job";if(change==2)invalid["accountSha256"]=new string('B',64);if(change==3)invalid.Remove("targetSha256");if(change==4)invalid.Add("allowSend",true);Expect(delegate{QtParseTextStep(invalid);},"QT_TEXT_STEP_INVALID");count++;}
            Func<QtEnterProof> pausedProof=delegate{return new QtEnterProof{Id="paused",Kind="text",Digest=new string('c',64),Epoch=QtEpoch,Frame=textFrame,Step=QtParseTextStep(stepPacket),Paused=true};};
            Func<QtFrame> resumedFrame=delegate{return new QtFrame{Binding=editorFocus(),Revision=107,Issued=90000,Anchors=new List<QtAnchor>{new QtAnchor{Rect=textFrame.Anchors[0].Rect,Hash=textFrame.Anchors[0].Hash},new QtAnchor{Rect=editor,Hash=new string('f',64)}}};};
            Need(QtTextResumeMatches(pausedProof(),step,"paused",new string('c',64),resumedFrame(),textFrame.Anchors[0].Rect,editor),"QT_TEST_TEXT_STEP_CONTINUES_NEW_REVISION_WITHOUT_READING_DRAFT");count++;
            for(int change=0;change<16;change++){var p=pausedProof();var f=resumedFrame();var s=QtParseTextStep(stepPacket);string name="paused",d=new string('c',64);Rect h=textFrame.Anchors[0].Rect,e=editor;
                if(change==0)p.Consumed=true;if(change==1)p.Paused=false;if(change==2)p.Kind="search";if(change==3)s.Delivery=new string('d',64);if(change==4)s.Account=new string('d',64);if(change==5)s.Target=new string('d',64);if(change==6)f.Binding.Window=new IntPtr(99);if(change==7)f.Binding.Pid++;if(change==8)f.Binding.Thread++;if(change==9)f.Binding.Created++;if(change==10)f.Binding.Dpi++;if(change==11)f.Anchors[0].Hash=new string('d',64);if(change==12)name="other";if(change==13)d=new string('d',64);if(change==14)e=new Rect(301,400,780,550);if(change==15)f.Binding.Capture=new Rect(901,100,1701,700);
                Need(!QtTextResumeMatches(p,s,name,d,f,h,e),"QT_TEST_TEXT_STEP_CHANGED_CONTEXT_REFUSED");count++;}
            QtPendingEnter=pausedProof();QtPendingEnter.Paused=false;QtPauseTextEnter();Need(QtPendingEnter.Paused&&!QtPendingEnter.Consumed,"QT_TEST_TEXT_FOCUS_HANDOFF_PAUSES_PROOF");count++;
            var noStep=pausedProof();noStep.Step=null;QtPendingEnter=noStep;QtPauseTextEnter();Need(QtPendingEnter==null&&noStep.Consumed,"QT_TEST_LEGACY_PROOF_NOT_RESUMABLE");count++;
            var searchProof=pausedProof();searchProof.Kind="search";QtPendingEnter=searchProof;QtPauseTextEnter();Need(QtPendingEnter==null&&searchProof.Consumed,"QT_TEST_SEARCH_INTERRUPTION_RESTARTS_SEARCH");count++;
            var refusal=pausedProof();QtPendingEnter=null;QtFinishEnterAttempt(refusal,true,false);Need(Object.ReferenceEquals(QtPendingEnter,refusal)&&refusal.Paused&&!refusal.Consumed,"QT_TEST_DEFINITE_PREINPUT_ENTER_REFUSAL_RETAINED");count++;
            var attemptedProof=pausedProof();QtPendingEnter=null;QtFinishEnterAttempt(attemptedProof,true,true);Need(attemptedProof.Consumed&&QtPendingEnter==null,"QT_TEST_UNKNOWN_ENTER_CANNOT_RESUME");count++;
            var enteredProof=pausedProof();QtPendingEnter=null;QtFinishEnterAttempt(enteredProof,false,true);Need(enteredProof.Consumed&&QtPendingEnter==null,"QT_TEST_PERFORMED_ENTER_SINGLE_USE");count++;
            Need(!QtEnterProofMatches(pausedProof(),"text","paused",new string('c',64),textFrame,1001),"QT_TEST_PAUSED_PROOF_NEVER_DIRECT_ENTER_AUTHORITY");count++;
            QtPendingEnter=textProof;QtRevokeEnter();Need(QtPendingEnter==null&&textProof.Consumed&&!QtEnterProofMatches(textProof,"text","text",new string('c',64),textFrame,1001),"QT_TEST_ENTER_SINGLE_USE_REVOKED");count++;
            Expect(delegate{QtChord("Enter");},"QT_CHORD_FORBIDDEN");count++;
        }finally{QtSurface=savedSurface;QtPopup=savedPopup;QtPendingPopup=savedPending;QtPendingEnter=savedEnter;}return count;
    }
    static int QtUiaNavigationSelfTest(){int checks=0;
        var lease=new QtFocusLease{Wechat=new QtFocusIdentity{Window=new IntPtr(42),Pid=7,Created=123},Revision=Interlocked.Read(ref Revision)};
        var frame=new QtFrame{Binding=new Binding{Window=new IntPtr(42),Pid=7,Created=123},NavigationOnly=true,NavigationLease=lease};
        Need(QtNavigationLeaseMatches(frame,lease),"QT_TEST_UIA_LEASE_MATCH");checks++;
        QtFramePurpose(frame,true);Expect(delegate{QtFramePurpose(frame,false);},"QT_OBSERVATION_PURPOSE_INVALID");checks++;
        var ordinary=new QtFrame();QtFramePurpose(ordinary,false);Expect(delegate{QtFramePurpose(ordinary,true);},"QT_OBSERVATION_PURPOSE_INVALID");checks++;
        Need(!QtNavigationLeaseMatches(frame,new QtFocusLease{Wechat=lease.Wechat})&&!QtNavigationLeaseMatches(ordinary,lease),"QT_TEST_UIA_LEASE_EXACT_OWNER");checks++;
        foreach(int field in new[]{0,1,2}){var changed=new QtFrame{NavigationOnly=true,NavigationLease=lease,Binding=new Binding{Window=new IntPtr(field==0?43:42),Pid=(uint)(field==1?8:7),Created=field==2?124:123}};Need(!QtNavigationLeaseMatches(changed,lease),"QT_TEST_UIA_BINDING_CHANGED");checks++;}
        bool enabled=QtEnableInput,stopping=Stopping,attempted=InputAttempted;var savedLease=QtLease;var parked=QtParkedLease;var popup=QtPopup;var pending=QtPendingPopup;string surface=QtSurface;var current=QtCurrent;
        try{
            for(int invalid=0;invalid<7;invalid++){
                QtEnableInput=true;Stopping=false;InputAttempted=false;QtLease=lease;QtParkedLease=null;QtPopup=null;QtPendingPopup=null;QtSurface="main";QtCurrent=frame;
                if(invalid==0)QtEnableInput=false;if(invalid==1)Stopping=true;if(invalid==2)QtLease=null;if(invalid==3)QtParkedLease=lease;if(invalid==4)QtPopup=new QtPopupLease();if(invalid==5)QtPendingPopup=new QtPopupLease();if(invalid==6)QtSurface="search";
                Expect(delegate{QtCaptureUiaNavigation(Data());},"QT_UIA_NAVIGATION_UNAVAILABLE");Need(!InputAttempted,"QT_TEST_UIA_CAPTURE_REFUSAL_NO_INPUT");checks++;
            }
            QtEnableInput=true;Stopping=false;InputAttempted=false;QtLease=lease;QtParkedLease=null;QtPopup=null;QtPendingPopup=null;QtSurface="main";QtCurrent=frame;
            foreach(var request in new[]{Data("surface","main","image",true,"regions",new object[]{Data()}),Data("surface","search","image",false,"regions",new object[]{Data()}),Data("surface","main","image",false,"regions",new object[0]),Data("surface","main","image",false,"regions",new object[]{Data()},"allowInput",true)}){Expect(delegate{QtCaptureUiaNavigation(request);},"QT_UIA_NAVIGATION_REQUEST_INVALID");Need(!InputAttempted,"QT_TEST_UIA_INVALID_CAPTURE_NO_INPUT");checks++;}
            frame.Anchors=new List<QtAnchor>{new QtAnchor()};
            foreach(var request in new[]{Data("key","Enter"),Data("rect",Data()),Data("popupTransition",Data("id","profile"))}){Expect(delegate{QtOpenUiaSearch(request);},"QT_UIA_NAVIGATION_REQUEST_INVALID");Need(!InputAttempted,"QT_TEST_UIA_INVALID_ACTION_NO_INPUT");checks++;}
            foreach(var request in new[]{Data("key","Enter"),Data("rect",Data()),Data("popupTransition",Data("id","search"))}){Expect(delegate{QtFocusUiaEditor(request);},"QT_UIA_NAVIGATION_REQUEST_INVALID");Need(!InputAttempted,"QT_TEST_UIA_INVALID_EDITOR_NO_INPUT");checks++;}
            QtCurrent=ordinary;Expect(delegate{QtOpenUiaSearch(Data());},"QT_OBSERVATION_PURPOSE_INVALID");checks++;
            Expect(delegate{QtFocusUiaEditor(Data());},"QT_OBSERVATION_PURPOSE_INVALID");checks++;
            var client=new Rect(0,0,1080,1848);var header=new Rect(385,48,1073,120);Need(QtUiaEditorRegion(new Rect(385,1550,1073,1800),header,client),"QT_TEST_UIA_EDITOR_REGION");checks++;
            foreach(var rect in new[]{new Rect(385,48,1073,120),new Rect(385,900,1073,1000),new Rect(-1,1550,1073,1800),new Rect(385,1550,1081,1800),new Rect(385,1550,390,1800),new Rect(385,1550,1073,1551)}){Need(!QtUiaEditorRegion(rect,header,client),"QT_TEST_UIA_EDITOR_REGION_REJECT");checks++;}
        }finally{QtEnableInput=enabled;Stopping=stopping;InputAttempted=attempted;QtLease=savedLease;QtParkedLease=parked;QtPopup=popup;QtPendingPopup=pending;QtSurface=surface;QtCurrent=current;}
        return checks;
    }
    static int QtUiaControlFrameSelfTest(){int n=0;var savedLease=QtLease;var savedParked=QtParkedLease;var savedPopup=QtPopup;var savedPending=QtPendingPopup;string savedSurface=QtSurface;
        try{
            var lease=new QtFocusLease{Wechat=new QtFocusIdentity{Window=new IntPtr(42),Pid=7,Created=123},Revision=5};QtLease=lease;QtParkedLease=null;QtPopup=null;QtPendingPopup=null;QtSurface="main";
            Func<string,QtFrame> frame=delegate(string hash){return new QtFrame{Binding=new Binding{Window=new IntPtr(42),Pid=7,Created=123,Thread=8,Client=new Rect(0,0,800,600),Capture=new Rect(0,0,800,600)},Revision=5,Issued=1,Anchors=new List<QtAnchor>{new QtAnchor{Rect=new Rect(300,10,780,60),Hash=hash},new QtAnchor{Rect=new Rect(300,450,780,550),Hash="editor"}}};};
            var source=frame("before");var current=frame("after");var report=Data();Need(!source.UiaControlFrame&&!QtUiaInputHeader(source,"text",true,lease),"QT_TEST_UIA_ORDINARY_FRAME_UNMARKED");n++;
            QtMarkUiaControlFrame(source,lease,report);Need(Object.Equals(Get(report,"uiaControlFrame"),true)&&QtUiaInputHeader(source,"text",true,lease),"QT_TEST_UIA_CONTROL_INTERNAL_SOURCE");n++;
            Need(QtAttachTextHeaderMatches(source,current,true,lease)&&!QtAttachTextHeaderMatches(source,current,false,lease),"QT_TEST_UIA_ONLY_INPUT_HEADER_ANIMATION");n++;
            Need(!QtAttachTextHeaderMatches(frame("before"),current,true,lease)&&!QtUiaInputHeader(source,"search",true,lease),"QT_TEST_UIA_ORDINARY_AND_SEARCH_NOT_DOWNGRADED");n++;
            source.NavigationOnly=true;Need(!QtUiaInputHeader(source,"text",true,lease),"QT_TEST_UIA_NAVIGATION_NOT_INPUT_AUTHORITY");source.NavigationOnly=false;n++;
            foreach(var request in new[]{Data("uiaControlFrame",true),Data("uiaControlFrame",false),Data("uiaControlLease",Data())}){Expect(delegate{QtRejectFrameAuthority(request);},"QT_UIA_CONTROL_FRAME_INVALID");n++;}QtRejectFrameAuthority(Data());n++;
            QtMarkUiaControlFrame(current,lease,Data());var proof=new QtEnterProof{Id="fixture",Kind="text",Digest="digest",Epoch=QtEpoch,Frame=source,InputOnly=true};Need(QtEnterProofMatches(proof,"text","fixture","digest",current,2),"QT_TEST_UIA_PROOF_RETAINS_INTERNAL_SOURCE");n++;
            Need(!QtEnterProofMatches(proof,"text","fixture","digest",frame("after"),2),"QT_TEST_UIA_PROOF_CANNOT_STRIP_SOURCE");n++;
            QtLease=null;Expect(delegate{QtCheckUiaControlLease(source);},"QT_UIA_CONTROL_FRAME_INVALID");Need(!QtEnterProofMatches(proof,"text","fixture","digest",current,2),"QT_TEST_UIA_CLEARED_LEASE_PROOF_REFUSED");n++;
            QtLease=new QtFocusLease{Wechat=lease.Wechat,Revision=lease.Revision};Expect(delegate{QtCheckUiaControlLease(source);},"QT_UIA_CONTROL_FRAME_INVALID");Need(!QtAttachTextHeaderMatches(source,current,true,QtLease)&&!QtEnterProofMatches(proof,"text","fixture","digest",current,2),"QT_TEST_UIA_REPLACED_LEASE_REFUSED");n++;
            QtLease=lease;QtParkedLease=lease;Expect(delegate{QtCheckUiaControlLease(source);},"QT_UIA_CONTROL_FRAME_INVALID");QtParkedLease=null;n++;
            foreach(int changed in new[]{0,1,2,3}){var invalid=frame("before");invalid.UiaControlFrame=true;invalid.UiaControlLease=lease;if(changed==0)invalid.Binding.Window=new IntPtr(43);if(changed==1)invalid.Binding.Pid=8;if(changed==2)invalid.Binding.Created=124;if(changed==3)invalid.Revision=6;Need(!QtUiaControlLeaseMatches(invalid,lease),"QT_TEST_UIA_CONTROL_BINDING_CHANGED");n++;}
            current.Anchors[0].Rect=new Rect(301,10,780,60);Need(!QtAttachTextHeaderMatches(source,current,true,lease),"QT_TEST_UIA_HEADER_REGION_STILL_EXACT");n++;
        }finally{QtLease=savedLease;QtParkedLease=savedParked;QtPopup=savedPopup;QtPendingPopup=savedPending;QtSurface=savedSurface;}return n;
    }
    static int QtSelfTest(){int count=0;try{
        count+=QtUiaControlFrameSelfTest();
        count+=QtUiaGeometrySelfTest();
        count+=QtUiaControlsSelfTest();
        count+=QtUiaPointerSelfTest();
        count+=QtUiaBackgroundTextSelfTest();
        count+=QtUiaNavigationSelfTest();
        count+=QtImageSelfTest();
        count+=QtEnterSelfTest();
        count+=QtQuoteSelfTest();
        count+=QtCaptureSnapshotSelfTest();
        count+=QtLayoutHandoffSelfTest();
        count+=QtLayoutRaisedSelfTest();
        count+=QtReturnCaptionSelfTest();
        count+=QtFocusRestoreDiagnosticSelfTest();
        count+=QtEmptyTimingSelfTest();
        count+=QtInitialEmptyTemplateSelfTest();
        count+=QtEmptyPhaseSelfTest();
        var timingLease=new QtFocusLease{ForegroundStarted=Now()-50,IncludesContactNavigation=true};
        var timingSuccess=Map(QtFocusRestoreReport(Data("restored",true,"skipped",false),timingLease,true));var timingComplete=Map(Get(timingSuccess,"foregroundInterval"));
        Need(Object.Equals(Get(timingComplete,"complete"),true)&&Text(timingComplete,"phase")=="contact-navigation"&&Number(Get(timingComplete,"durationMs"))>=50,"QT_TEST_FOCUS_SUCCESS_COMPLETE_TIMING");count++;
        var timingSkipped=Map(QtFocusRestoreReport(Data("restored",false,"skipped",true),timingLease,false));Need(Object.Equals(Get(Map(Get(timingSkipped,"foregroundInterval")),"complete"),false)&&Object.Equals(Get(timingSkipped,"skipped"),true),"QT_TEST_SKIPPED_FOCUS_TIMING_INCOMPLETE");count++;
        var timingError=new Fault("QT_FOCUS_RETURN_UNCONFIRMED");QtMarkFocusTimingFailure(timingError,timingLease);var timingFailed=Map(QtFocusTimingFailure(timingError));Need(Object.Equals(Get(timingFailed,"complete"),false)&&Text(timingFailed,"phase")=="contact-navigation"&&timingError.Message=="QT_FOCUS_RETURN_UNCONFIRMED","QT_TEST_FOCUS_EXCEPTION_TIMING_INCOMPLETE");count++;
        Need(QtForegroundInterval(null,false)==null&&QtForegroundInterval(new QtFocusLease(),false)==null&&!Map(QtFocusRestoreReport(Data("restored",false,"skipped",true),null,false)).ContainsKey("foregroundInterval"),"QT_TEST_NO_LEASE_NO_INVENTED_TIMING");count++;
        var untimedError=new Fault("QT_FOCUS_RETURN_UNCONFIRMED");QtMarkFocusTimingFailure(untimedError,new QtFocusLease());Need(QtFocusTimingFailure(untimedError)==null,"QT_TEST_UNTIMED_ERROR_NO_INVENTED_TIMING");count++;
        count+=QtParkResumeSelfTest();
        count+=FocusConfirmationSelfTest();
        count+=QtFocusVisibilitySelfTest();
        var popupFixture=Data("version",1,"kind","profile","className","QtFixtureWindow","ownerRelation","same-thread-unowned","ownerDepth",0,"windowRect",new Rect(-20,40,280,340).Report(),"clientWidth",300,"clientHeight",300,"style",unchecked((int)0x80000000),"extendedStyle",128);
        var parsedPopup=QtParsePopupCalibration(popupFixture);Need(parsedPopup.OwnerDepth==0&&parsedPopup.RelativeWindow.Left==-20&&parsedPopup.ClientWidth==300,"QT_TEST_EXACT_POPUP_CALIBRATION");count++;
        popupFixture["ownerRelation"]="same-process";Expect(delegate{QtParsePopupCalibration(popupFixture);},"QT_POPUP_CALIBRATION_INVALID");popupFixture["ownerRelation"]="same-thread-unowned";count++;
        popupFixture["ownerDepth"]=1;Expect(delegate{QtParsePopupCalibration(popupFixture);},"QT_POPUP_CALIBRATION_INVALID");popupFixture["ownerDepth"]=0;count++;
        popupFixture["className"]="";Expect(delegate{QtParsePopupCalibration(popupFixture);},"QT_POPUP_CALIBRATION_INVALID");popupFixture["className"]="QtFixtureWindow";count++;
        popupFixture["unexpected"]=true;Expect(delegate{QtParsePopupCalibration(popupFixture);},"QT_POPUP_CALIBRATION_INVALID");popupFixture.Remove("unexpected");count++;
        QtNeedAnchorPixels("same","same","guard",0);try{QtNeedAnchorPixels("old","new","guard",1);throw new Fault("QT_TEST_PIXEL_MISMATCH_REQUIRED");}catch(Fault error){var mismatch=Map(QtPixelMismatch(error));Need(error.Message=="QT_PIXELS_CHANGED"&&mismatch!=null&&mismatch.Count==2&&Text(mismatch,"stage")=="guard"&&Number(Get(mismatch,"anchorIndex"))==1,"QT_TEST_PIXEL_MISMATCH_ANONYMOUS");}count++;
        var observedFixture=Data("version",1,"kind","profile","className","QtFixtureWindow","ownerRelation","same-thread-unowned","ownerDepth",0,"style",unchecked((int)0x80000000),"extendedStyle",128);
        Need(QtParsePopupCalibration(observedFixture,true).ClassName=="QtFixtureWindow","QT_TEST_OBSERVED_IDENTITY_ONLY");Expect(delegate{QtParsePopupCalibration(observedFixture);},"QT_POPUP_CALIBRATION_INVALID");count++;
        observedFixture["windowRect"]=new Rect(0,0,100,100).Report();Expect(delegate{QtParsePopupCalibration(observedFixture,true);},"QT_POPUP_CALIBRATION_INVALID");observedFixture.Remove("windowRect");count++;
        Need(QtCoveredByDisplays(new Rect(90,10,110,90),new List<Rect>{new Rect(0,0,100,100),new Rect(100,0,200,100)})&&!QtCoveredByDisplays(new Rect(90,10,120,90),new List<Rect>{new Rect(0,0,100,100),new Rect(110,0,200,100)}),"QT_TEST_OBSERVED_DISPLAY_GAPS_REFUSED");count++;
        {
            var root=new Binding{Window=new IntPtr(42),Pid=7,Created=123,Client=new Rect(0,0,800,600),Capture=new Rect(2000,100,2800,700)};
            var focus=new QtFocusLease{UiaMode=true,Wechat=new QtFocusIdentity{Window=root.Window,Pid=root.Pid,Created=root.Created}};
            var frame=new QtFrame{Binding=root,MetadataOnly=true,NavigationOnly=true,NavigationLease=focus};var search=new QtPopupCalibration{Kind="search"};
            Need(QtPopupUsesUiaSearch(frame,focus,true,"search",search),"QT_TEST_OFFSCREEN_SEARCH_NATIVE_UIA_NAVIGATION_REQUIRED");count++;
            foreach(int change in new[]{0,1,2,3,4,5,6}){
                frame.MetadataOnly=change!=0;frame.NavigationOnly=change!=1;focus.UiaMode=change!=2;frame.NavigationLease=change==3?new QtFocusLease():focus;
                Need(!QtPopupUsesUiaSearch(frame,focus,change!=4,change==5?"profile":"search",change==6?new QtPopupCalibration{Kind="profile"}:search),"QT_TEST_OFFSCREEN_SEARCH_NO_CALLER_AUTHORITY");count++;
            }
            frame.MetadataOnly=true;frame.NavigationOnly=true;focus.UiaMode=true;frame.NavigationLease=focus;
            var popup=new QtPopupLease{Id="search",Observed=true,UiaSearch=true,Root=root,Calibration=search};var bounds=new Rect(2100,150,2400,450);var client=new Rect(0,0,300,300);var displays=new List<Rect>{new Rect(0,0,1920,1080)};
            Need(QtPopupDisplayAllowed(popup,bounds,displays)&&QtPopupGeometryAllowed(bounds,client,bounds,popup),"QT_TEST_OFFSCREEN_SEARCH_METADATA_WITH_BOUND_GEOMETRY");count++;
            Need(!QtPopupGeometryAllowed(new Rect(1800,150,2100,450),client,new Rect(1800,150,2100,450),popup),"QT_TEST_OFFSCREEN_SEARCH_STILL_INSIDE_BOUND_ROOT");count++;
            int waited=0;QtPopupObservationPause(popup,delegate(int ms){waited+=ms;});Need(waited==0,"QT_TEST_UIA_SEARCH_NO_FIXED_REPAINT_WAIT");count++;
            popup.UiaSearch=false;Need(!QtPopupDisplayAllowed(popup,bounds,displays),"QT_TEST_OCR_SEARCH_RETAINS_DISPLAY_GUARD");QtPopupObservationPause(popup,delegate(int ms){waited+=ms;});Need(waited==35,"QT_TEST_OCR_SEARCH_RETAINS_OBSERVATION_WAIT");count+=2;
            popup.UiaSearch=true;popup.Calibration.Kind="profile";Need(!QtPopupDisplayAllowed(popup,bounds,displays),"QT_TEST_PROFILE_CANNOT_ADOPT_UIA_SEARCH_SCOPE");count++;
            popup.Calibration.Kind="search";popup.Observed=false;Need(!QtPopupDisplayAllowed(popup,bounds,displays),"QT_TEST_CALIBRATED_SEARCH_CANNOT_ADOPT_UIA_SCOPE");count++;
            popup.Observed=true;popup.Calibration.ClassName="Qt51514QWindowToolSaveBits";popup.Calibration.OwnerRelation="root-owned";popup.Calibration.OwnerDepth=1;
            Need(QtPopupOffscreenScope(popup,true,true)&&!QtPopupOffscreenScope(popup,false,true)&&!QtPopupOffscreenScope(popup,true,false),"QT_TEST_POPUP_BOTH_ROOT_AND_SEARCH_MUST_BE_OFFSCREEN");count++;
            foreach(int changed in new[]{0,1,2,3}){popup.UiaSearch=changed!=0;popup.Calibration.ClassName=changed==1?"unknown":"Qt51514QWindowToolSaveBits";popup.Calibration.OwnerRelation=changed==2?"same-thread-unowned":"root-owned";popup.Calibration.OwnerDepth=changed==3?2:1;Need(!QtPopupOffscreenScope(popup,true,true),"QT_TEST_OFFSCREEN_POPUP_EXACT_NATIVE_SCOPE");count++;}
            popup.UiaSearch=true;popup.Calibration.ClassName="Qt51514QWindowToolSaveBits";popup.Calibration.OwnerRelation="root-owned";popup.Calibration.OwnerDepth=1;
            Rect actualRoot=new Rect(3715,610,4790,1297),driftedPopup=new Rect(4223,588,4683,708),driftedClient=new Rect(0,0,460,120);popup.Root.Client=new Rect(0,0,1075,687);popup.Root.Capture=actualRoot;
            Need(!QtPopupGeometryAllowed(driftedPopup,driftedClient,driftedPopup,popup)&&QtPopupGeometryAllowed(driftedPopup,driftedClient,driftedPopup,popup,true),"QT_TEST_OFFSCREEN_POPUP_MEASURED_DETACHED_GEOMETRY_ONLY_NATIVE_SCOPE");count++;
            popup.Window=new IntPtr(22);popup.ObservedBounds=driftedPopup;popup.ObservedClient=driftedClient;popup.ObservedClientScreen=driftedPopup;
            Rect moved=new Rect(4200,610,4660,1010),expanded=new Rect(0,0,460,400);Need(QtPopupGeometryAllowed(moved,expanded,moved,popup,true),"QT_TEST_OFFSCREEN_POPUP_QT_POSITION_AND_HEIGHT_FOLLOW_WITHOUT_MOVING");count++;
            Need(!QtPopupGeometryAllowed(new Rect(4200,610,4661,1010),expanded,moved,popup,true)&&!QtPopupGeometryAllowed(new Rect(4200,609,4660,1010),expanded,moved,popup,true),"QT_TEST_OFFSCREEN_POPUP_WIDTH_AND_MARGINS_STILL_BOUND");count++;
            Need(QtPopupOutsideDisplays(actualRoot,displays)&&!QtPopupOutsideDisplays(new Rect(1910,10,2000,100),displays)&&!QtPopupOutsideDisplays(actualRoot,new List<Rect>()),"QT_TEST_OFFSCREEN_POPUP_DISPLAY_INTERSECTION_REFUSED");count++;
            Need(!QtPopupShapeAllowed(driftedPopup,driftedClient,new Rect(4223,588,4684,708)),"QT_TEST_OFFSCREEN_POPUP_PRESERVES_CLIENT_CONTAINMENT");count++;
        }
        var observedLease=new QtPopupLease{Observed=true,Calibration=QtParsePopupCalibration(observedFixture,true),Root=new Binding{Capture=new Rect(0,0,800,600)},Window=new IntPtr(4),ObservedBounds=new Rect(100,100,400,400),ObservedClient=new Rect(0,0,300,300),ObservedClientScreen=new Rect(100,100,400,400)};
        Need(QtPopupGeometryAllowed(new Rect(100,100,400,400),new Rect(0,0,300,300),new Rect(100,100,400,400),observedLease)&&!QtPopupGeometryAllowed(new Rect(101,100,401,400),new Rect(0,0,300,300),new Rect(101,100,401,400),observedLease),"QT_TEST_OBSERVED_PROFILE_GEOMETRY_FROZEN");count++;
        observedLease.Calibration.Kind="search";Need(QtPopupGeometryAllowed(new Rect(100,100,400,450),new Rect(0,0,300,350),new Rect(100,100,400,450),observedLease)&&!QtPopupGeometryAllowed(new Rect(100,100,401,450),new Rect(0,0,301,350),new Rect(100,100,401,450),observedLease)&&!QtPopupGeometryAllowed(new Rect(100,100,400,650),new Rect(0,0,300,550),new Rect(100,100,400,650),observedLease),"QT_TEST_OBSERVED_SEARCH_ONLY_HEIGHT_CAN_VARY_WITHIN_ROOT");count++;
        {
            var searchRoot=new Binding{Window=new IntPtr(20),Client=new Rect(0,0,800,600),Capture=new Rect(900,0,1700,600)};
            var searchPopup=new QtPopupLease{Id="search",Observed=true,Calibration=new QtPopupCalibration{Kind="search"},Root=searchRoot,Window=new IntPtr(21),Revision=7,ObservedClientScreen=new Rect(1000,100,1300,400)};
            var queryAnchor=new QtAnchor{Rect=new Rect(110,20,380,60),Hash=new string('a',64)};
            var searchFrame=new QtFrame{Binding=searchRoot,Revision=7,PopupBounds=new Rect(1000,100,1300,400),PopupClient=new Rect(0,0,300,300),Anchors=new List<QtAnchor>{queryAnchor}};
            Need(QtSearchPasteCompletionEligible("search","observed-search",searchFrame,searchPopup),"QT_TEST_SEARCH_PASTE_COMPLETION_SCOPE");count++;
            Need(!QtSearchPasteCompletionEligible("editor","observed-search",searchFrame,searchPopup)&&!QtSearchPasteCompletionEligible("search","observed-profile",searchFrame,searchPopup)&&!QtSearchPasteCompletionEligible("search","calibrated-search",searchFrame,searchPopup),"QT_TEST_SEARCH_PASTE_COMPLETION_EXCLUDES_OTHER_SCOPES");count++;
            queryAnchor.Rect=new Rect(110,110,380,160);Need(!QtSearchPasteCompletionEligible("search","observed-search",searchFrame,searchPopup),"QT_TEST_SEARCH_PASTE_COMPLETION_EXCLUDES_RESULT_ROWS");queryAnchor.Rect=new Rect(110,20,380,60);count++;
            searchFrame.Anchors.Add(new QtAnchor{Rect=new Rect(110,110,380,160)});Need(!QtSearchPasteCompletionEligible("search","observed-search",searchFrame,searchPopup),"QT_TEST_SEARCH_PASTE_COMPLETION_SINGLE_QUERY_ANCHOR");searchFrame.Anchors.RemoveAt(1);count++;
            searchFrame.Revision=8;Need(!QtSearchPasteCompletionEligible("search","observed-search",searchFrame,searchPopup),"QT_TEST_SEARCH_PASTE_COMPLETION_ORIGINAL_REVISION");searchFrame.Revision=7;count++;
            searchPopup.Root=new Binding{Window=new IntPtr(22)};Need(!QtSearchPasteCompletionEligible("search","observed-search",searchFrame,searchPopup),"QT_TEST_SEARCH_PASTE_COMPLETION_ORIGINAL_ROOT");searchPopup.Root=searchRoot;count++;
            searchFrame.PopupBounds=null;Need(!QtSearchPasteCompletionEligible("search","observed-search",searchFrame,searchPopup),"QT_TEST_SEARCH_PASTE_COMPLETION_CAPTURE_GEOMETRY_REQUIRED");searchFrame.PopupBounds=new Rect(1000,100,1300,400);count++;
            searchPopup.Calibration.Kind="profile";Need(!QtSearchPasteCompletionEligible("search","observed-search",searchFrame,searchPopup),"QT_TEST_SEARCH_PASTE_COMPLETION_EXCLUDES_PROFILE");searchPopup.Calibration.Kind="search";count++;
            var savedPopup=QtPopup;try{QtPopup=new QtPopupLease();Expect(delegate{QtPasteCompletionStable(searchFrame,new QtSearchPasteCompletion{Popup=searchPopup});},"QT_POPUP_BINDING_CHANGED");Need(!InputAttempted,"QT_TEST_SEARCH_PASTE_CHANGED_LEASE_NO_INPUT");}finally{QtPopup=savedPopup;}count++;
        }
        {
            // Anonymous geometry from the actual 120 -> 400 search result
            // expansion. The query anchor overlaps the popup's top by 8px,
            // while its real, root-owned click center remains above it.
            Func<Binding> binding=delegate{return new Binding{Window=new IntPtr(20),Pid=30,Created=40,Thread=50,Dpi=120,Focus=new IntPtr(20),FocusOwned=true,Client=new Rect(0,0,800,600),Capture=new Rect(900,100,1700,700)};};
            var popup=new QtPopupLease{Id="search",Observed=true,Calibration=new QtPopupCalibration{Kind="search"},Root=binding(),Window=new IntPtr(21),Revision=7,ObservedBounds=new Rect(960,179,1420,299),ObservedClient=new Rect(0,0,460,120),ObservedClientScreen=new Rect(960,179,1420,299)};
            Rect query=new Rect(91,53,261,87);
            Func<QtFrame> capture=delegate{return new QtFrame{Binding=binding(),Revision=7,Issued=1000,PopupBounds=popup.ObservedBounds,PopupClient=popup.ObservedClient,Anchors=new List<QtAnchor>{new QtAnchor{Rect=query,Hash=new string('a',64)}}};};
            QtFrame clicked=capture(),fresh=capture();
            Need(QtSearchQueryClickEligible("observed-search",clicked,popup,query,true)&&!QtSearchQueryClickEligible("observed-search",clicked,popup,query,false)&&!QtSearchQueryClickEligible("observed-profile",clicked,popup,query,true),"QT_TEST_PARTIAL_QUERY_REQUIRES_ROOT_OWNED_OBSERVED_CLICK");count++;
            var boundary=capture();boundary.Anchors[0].Rect=new Rect(91,70,261,88);Need(!QtSearchQueryClickEligible("observed-search",boundary,popup,boundary.Anchors[0].Rect,true)&&!QtSearchQueryClickEligible("observed-search",clicked,popup,new Rect(92,53,261,87),true),"QT_TEST_QUERY_CENTER_AT_RESULTS_AND_DIFFERENT_ANCHOR_REFUSED");count++;
            Need(!QtSearchPasteCompletionEligible("search","observed-search",fresh,popup),"QT_TEST_PARTIAL_QUERY_CANNOT_SKIP_FROZEN_HEIGHT_WITHOUT_CLICK");count++;
            var proof=new QtQueryClickProof{Popup=popup,Frame=clicked,Epoch=QtEpoch};popup.QueryClick=proof;Need(!QtSearchPasteCompletionEligible("search","observed-search",fresh,popup,proof,1001),"QT_TEST_QUERY_PROOF_NOT_USABLE_BEFORE_SINGLE_CONSUMPTION");var consumed=QtTakeQueryClick(popup);
            Need(Object.ReferenceEquals(consumed,proof)&&proof.Consumed&&popup.QueryClick==null&&QtSearchPasteCompletionEligible("search","observed-search",fresh,popup,proof,1001),"QT_TEST_PARTIAL_QUERY_SINGLE_CONSUMED_CLICK_PROOF");count++;
            Need(QtTakeQueryClick(popup)==null,"QT_TEST_QUERY_CLICK_SECOND_PASTE_HAS_NO_PROOF");popup.QueryClick=proof;Need(QtTakeQueryClick(popup)==null,"QT_TEST_QUERY_CLICK_CONSUMED_PROOF_CANNOT_BE_REINSERTED");count++;
            foreach(int change in new[]{0,1,2,3,4,5,6,7,8}){
                var altered=capture();var p=new QtQueryClickProof{Popup=popup,Frame=clicked,Epoch=QtEpoch,Consumed=true};long now=1001;
                if(change==0)p.Popup=new QtPopupLease();if(change==1)p.Epoch="other";if(change==2)altered.Binding.Focus=new IntPtr(99);if(change==3)altered.Binding.Thread++;if(change==4)altered.Revision++;if(change==5)altered.Anchors[0].Rect=new Rect(92,53,261,87);if(change==6)now=31001;if(change==7)now=999;if(change==8)altered.PopupBounds=new Rect(960,179,1420,579);
                Need(!QtSearchPasteCompletionEligible("search","observed-search",altered,popup,p,now),"QT_TEST_QUERY_COMPLETION_IDENTITY_EPOCH_FOCUS_RECT_AGE_FROZEN");count++;
            }
            popup.QueryClick=new QtQueryClickProof{Popup=popup,Frame=clicked,Epoch=QtEpoch};var revoked=popup.QueryClick;QtRevokeQueryClick(popup);Need(popup.QueryClick==null&&revoked.Consumed&&QtTakeQueryClick(popup)==null,"QT_TEST_OTHER_INPUT_REVOKES_QUERY_CLICK");count++;
            Need(QtPopupGeometryAllowed(new Rect(960,179,1420,579),new Rect(0,0,460,400),new Rect(960,179,1420,579),popup)&&!QtPopupGeometryAllowed(new Rect(960,179,1421,579),new Rect(0,0,461,400),new Rect(960,179,1421,579),popup)&&!QtPopupGeometryAllowed(new Rect(960,180,1420,580),new Rect(0,0,460,400),new Rect(960,180,1420,580),popup),"QT_TEST_ACTUAL_SEARCH_120_TO_400_ONLY_HEIGHT_ALLOWED");count++;
        }
        for(int guards=0;guards<256;guards++)Need(QtPopupCausalEligible((guards&1)!=0,(guards&2)!=0,(guards&4)!=0,(guards&8)!=0,(guards&16)!=0,(guards&32)!=0,(guards&64)!=0,(guards&128)!=0)==(guards==191),"QT_TEST_POPUP_EVERY_GUARD_REQUIRED");count++;
        Need(QtPopupTriggerMatches("search","search","chord","Control+F",false)&&QtPopupTriggerMatches("self","profile","click",null,true)&&QtPopupTriggerMatches("profile","profile","click",null,true),"QT_TEST_POPUP_CALIBRATED_TRIGGER");count++;
        Need(!QtPopupTriggerMatches("search","search","type",null,true)&&!QtPopupTriggerMatches("search","profile","chord","Control+F",true)&&!QtPopupTriggerMatches("self","profile","click",null,false)&&!QtPopupTriggerMatches("profile","profile","chord","Escape",true),"QT_TEST_POPUP_UNRELATED_ACTION_REFUSED");count++;
        Need(QtDiagnosticOwners(new IntPtr(1),delegate(IntPtr window){return new IntPtr(window.ToInt64()==1?2:1);}).Count==2,"QT_TEST_DIAGNOSTIC_OWNER_CYCLE_BOUNDED");count++;
        Need(QtDiagnosticOwners(new IntPtr(1),delegate(IntPtr window){return new IntPtr(window.ToInt64()+1);}).Count==16,"QT_TEST_DIAGNOSTIC_OWNER_DEPTH_BOUNDED");count++;
        Need(QtDiagnosticHitRects(null,new Rect(0,0,800,600)).Count==0,"QT_TEST_DIAGNOSTIC_NO_HITS");count++;
        Expect(delegate{QtDiagnosticHitRects(new object[]{new Rect(700,500,900,650).Report()},new Rect(0,0,800,600));},"QT_DIAGNOSTIC_REGIONS_INVALID");count++;
        Input[] pasteChord=QtPasteChord();Need(pasteChord.Length==4,"QT_TEST_PASTE_CHORD_LENGTH");ushort[] pasteKeys=new ushort[]{0x11,0x56,0x56,0x11};uint[] pasteFlags=new uint[]{0,0,2,2};
        for(int index=0;index<4;index++){KeyInput keyboard=pasteChord[index].Value.Keyboard;Need(pasteChord[index].Type==1&&keyboard.Key==pasteKeys[index]&&keyboard.Scan==0&&keyboard.Flags==pasteFlags[index]&&keyboard.Extra.Equals(Marker),"QT_TEST_PASTE_CHORD_LAYOUT");}count++;
        Input[] searchPaste=QtPasteInput(Data("replaceSearch",true),"search");Need(searchPaste.Length==8,"QT_TEST_SEARCH_PASTE_ONE_QUEUE");ushort[] searchKeys=new ushort[]{0x11,0x41,0x41,0x11,0x11,0x56,0x56,0x11};uint[] searchFlags=new uint[]{0,0,2,2,0,0,2,2};
        for(int index=0;index<searchPaste.Length;index++){KeyInput keyboard=searchPaste[index].Value.Keyboard;Need(searchPaste[index].Type==1&&keyboard.Key==searchKeys[index]&&keyboard.Scan==0&&keyboard.Flags==searchFlags[index]&&keyboard.Extra.Equals(Marker),"QT_TEST_SEARCH_PASTE_ORDER_AND_MARKER");}count++;
        Need(QtPasteInput(Data(),"editor").Length==4&&QtPasteInput(Data(),"search").Length==4,"QT_TEST_LEGACY_PASTE_UNCHANGED");count++;
        Need(QtPasteReadback(Data())&&QtPasteReadback(Data("readback",true))&&!QtPasteReadback(Data("readback",false)),"QT_TEST_UNCHECKED_PASTE_EXPLICIT_MODE");count++;
        Expect(delegate{QtPasteReadback(Data("readback","false"));},"QT_PASTE_INVALID");count++;
        Need(!QtForegroundPasteOnly(Data())&&!QtForegroundPasteOnly(Data("foregroundOnly",false))&&QtForegroundPasteOnly(Data("foregroundOnly",true)),"QT_TEST_FOREGROUND_FAST_PASTE_REQUIRES_EXPLICIT_MODE");count++;
        Expect(delegate{QtForegroundPasteOnly(Data("foregroundOnly","true"));},"QT_PASTE_INVALID");count++;
        {var root=new IntPtr(100);var binding=new Binding{Window=root,Pid=42,Created=123,FocusOwned=true};
            foreach(string surface in new[]{"main","calibrated-search","observed-search"}){Need(QtFastPasteAuthorized(false,true,false,binding,root,42,123,surface),"QT_TEST_ALREADY_FOREGROUND_FAST_PASTE_MAIN_AND_BOUND_SEARCH");count++;}
            foreach(string change in new[]{"implicit","parked","window","pid","created","focus","surface","missing-binding","missing-root"}){
                var current=new Binding{Window=root,Pid=42,Created=123,FocusOwned=true};if(change=="window")current.Window=new IntPtr(101);if(change=="pid")current.Pid++;if(change=="created")current.Created++;if(change=="focus")current.FocusOwned=false;
                Need(!QtFastPasteAuthorized(false,change!="implicit",change=="parked",change=="missing-binding"?null:current,change=="missing-root"?IntPtr.Zero:root,42,123,change=="surface"?"owned-profile":"main"),"QT_TEST_FOREGROUND_FAST_PASTE_CANNOT_REPLACE_ROOT_FOCUS_OR_PARKED_LEASE_GUARDS");count++;
            }
            Need(QtFastPasteAuthorized(true,false,false,binding,root,42,123,"main"),"QT_TEST_BORROWED_FAST_PASTE_BACKWARD_COMPATIBLE");count++;
        }
        bool beforeSearchIntent=InputAttempted;InputAttempted=false;Expect(delegate{QtPasteInput(Data("replaceSearch",true),"editor");},"QT_SEARCH_PASTE_SCOPE_INVALID");Expect(delegate{QtPasteInput(Data("replaceSearch",false),"search");},"QT_SEARCH_PASTE_SCOPE_INVALID");Need(!InputAttempted,"QT_TEST_SEARCH_PASTE_INVALID_NOT_ATTEMPTED");InputAttempted=beforeSearchIntent;count++;
        bool priorAttempted=InputAttempted;InputAttempted=false;Expect(delegate{ChordEvents(0x56);},"DRAFT_KEY_FORBIDDEN");Need(!InputAttempted,"QT_TEST_CHORD_CONSTRUCTION_NOT_INPUT");InputAttempted=priorAttempted;count++;
        Need(QtIdleReason(1032,1000,1000,0,1000)=="QT_ACTIVITY_WARMUP"&&QtIdleReason(1999,1000,1000,0,1000)=="QT_ACTIVITY_WARMUP","QT_TEST_STARTUP_IS_WARMUP");count++;
        Need(QtIdleReason(2000,1000,1000,0,1000)==null&&QtIdleReason(2657,1000,1000,0,1000)==null,"QT_TEST_WARMUP_COMPLETE");count++;
        Need(QtIdleReason(1500,1499,1000,1,1000)=="QT_USER_ACTIVE"&&QtIdleReason(3000,2999,1000,1,1000)=="QT_USER_ACTIVE"&&QtIdleReason(4000,3000,1000,1,1000)==null,"QT_TEST_REAL_ACTIVITY_STILL_GUARDED");count++;
        Need(QtIdleReason(3000,2999,1000,0,1000)!="QT_ACTIVITY_WARMUP","QT_TEST_WARMUP_ONLY_DURING_STARTUP");count++;
        var observed=new ActivityCounters();observed.Observe(true,0x100,0,0x10,UIntPtr.Zero);observed.Observe(false,0x200,0,1,UIntPtr.Zero);observed.Observe(false,0x201,1,1,UIntPtr.Zero);observed.Observe(false,0x20a,0,1,UIntPtr.Zero);observed.Observe(false,0x20e,0,1,UIntPtr.Zero);observed.Observe(false,0x999,0,1,UIntPtr.Zero);observed.Observe(true,0x100,0x10,0x10,Marker);observed.Observe(false,0x200,1,1,Marker);
        var totals=Map(observed.Report());Need(totals.Count==11&&Number(Get(totals,"keyboard"))==1&&Number(Get(totals,"mouseMove"))==1&&Number(Get(totals,"mouseButton"))==1&&Number(Get(totals,"mouseWheel"))==2&&Number(Get(totals,"mouseOther"))==1&&Number(Get(totals,"nonInjected"))==5&&Number(Get(totals,"foreignInjected"))==1&&Number(Get(totals,"ownInjected"))==2,"QT_TEST_ANONYMOUS_ACTIVITY_COUNTS");count++;
        var positions=new ActivityCounters();positions.Observe(false,0x200,0,1,UIntPtr.Zero,7319,-2391);positions.Observe(false,0x200,0,1,UIntPtr.Zero,7319,-2391);positions.Observe(false,0x200,0,1,UIntPtr.Zero,7320,-2391);positions.Observe(false,0x200,1,1,Marker,100,100);positions.Observe(false,0x200,0,1,UIntPtr.Zero,7320,-2391);var positionReport=Map(positions.Report());Need(Number(Get(positionReport,"mouseMove"))==4&&Number(Get(positionReport,"firstPositionMouseMove"))==1&&Number(Get(positionReport,"samePositionMouseMove"))==2&&Number(Get(positionReport,"changedPositionMouseMove"))==1&&Number(Get(positionReport,"nonInjected"))==4&&!Json.Serialize(positionReport).Contains("7319")&&!Json.Serialize(positionReport).Contains("2391"),"QT_TEST_POSITION_COUNTS_WITHOUT_COORDINATES");count++;
        long revisionBefore=Revision,lastBefore=LastActivity;ActivityMonitorStarted=LastActivity=Now();var inspection=Map(QtFocusInspectionResult(false,"QT_USER_ACTIVE"));Need(inspection.Count==9&&Number(Get(inspection,"idleMsObserved"))>=0&&Number(Get(inspection,"monitorUptimeMs"))>=0&&Number(Get(inspection,"activityRevision"))==revisionBefore&&Map(Get(inspection,"inputActivityCounts")).Count==11&&Revision==revisionBefore,"QT_TEST_READ_ONLY_ACTIVITY_DIAGNOSTICS");LastActivity=lastBefore;ActivityMonitorStarted=0;count++;
        var identity=new QtFocusIdentity{Window=new IntPtr(100),Pid=42,Created=123};Need(QtSameFocus(identity,QtParseFocus(identity.Report())),"QT_TEST_FOCUS_IDENTITY");count++;
        Need(!QtSameFocus(identity,new QtFocusIdentity{Window=identity.Window,Pid=42,Created=124}),"QT_TEST_FOCUS_REUSE");count++;
        for(int flags=0;flags<16;flags++)Need(QtCanRestore((flags&1)!=0,(flags&2)!=0,(flags&4)!=0,(flags&8)!=0)==(flags==15),"QT_TEST_FOCUS_RESTORE_GUARDS");count++;
        Point ownPoint=new Point(-500,50),userPoint=new Point(-499,50);
        for(int flags=0;flags<256;flags++)Need(QtCanRestorePointer((flags&1)!=0,(flags&2)!=0,(flags&4)!=0,(flags&8)!=0,(flags&16)!=0,(flags&32)!=0,(flags&64)!=0,(flags&128)!=0,ownPoint,ownPoint)==(flags==255),"QT_TEST_POINTER_RESTORE_EVERY_GUARD");count++;
        Need(!QtCanRestorePointer(true,true,true,true,true,true,true,true,userPoint,ownPoint),"QT_TEST_POINTER_USER_MOVE_NOT_OVERWRITTEN");count++;
        Need(QtNearPoint(ownPoint,userPoint)&&!QtSamePoint(ownPoint,userPoint),"QT_TEST_POINTER_INJECTION_TOLERANCE_NOT_RETURN_TOLERANCE");count++;
        var pointerEvents=QtPointerEvents(ownPoint,new Rect(-1000,0,1000,1000));Need(pointerEvents.Length==1&&pointerEvents[0].Type==0&&pointerEvents[0].Value.Mouse.Flags==0xc001&&pointerEvents[0].Value.Mouse.Data==0&&pointerEvents[0].Value.Mouse.Extra.Equals(Marker),"QT_TEST_POINTER_NO_CLICK_OR_KEY");count++;
        Expect(delegate{QtPointerEvents(new Point(1000,0),new Rect(-1000,0,1000,1000));},"DRAFT_SCREEN_CHANGED");count++;
        Rect parkRect=new Rect(400,8,500,22);Need(QtCanParkPointer("main",parkRect,800,true)&&!QtCanParkPointer("main",parkRect,800,false)&&!QtCanParkPointer("calibrated-search",parkRect,800,true)&&!QtCanParkPointer("main",new Rect(400,450,500,470),800,true),"QT_TEST_PARK_EXACT_MAIN_TITLE_ANCHOR");count++;
        QtValidatePaste("hello\nworld","hello\nworld","editor");QtValidatePaste("target_A","target_A","search");count+=2;
        QtValidatePaste("桌面自动化示例讨论组","桌面自动化示例讨论组","search","group-title");count++;
        QtValidatePaste("联系人备注","联系人备注","search","private-name");count++;
        foreach(string invalid in new[]{" 名称","名称 ","名\n称","name@chatroom",new string('名',129)}){Expect(delegate{QtValidatePaste(invalid,invalid,"search","private-name");},"QT_PASTE_SEARCH_INVALID");count++;}
        Expect(delegate{QtValidatePaste("联系人","联系人","editor","private-name");},"QT_PASTE_SEARCH_INVALID");count++;
        Expect(delegate{QtValidatePaste("中文群","中文群","search");},"QT_PASTE_SEARCH_INVALID");
        Expect(delegate{QtValidatePaste("room@chatroom","room@chatroom","search","group-title");},"QT_PASTE_SEARCH_INVALID");
        Expect(delegate{QtValidatePaste("群\n名","群\n名","search","group-title");},"QT_PASTE_SEARCH_INVALID");
        Expect(delegate{QtValidatePaste("群名","群名","editor","group-title");},"QT_PASTE_SEARCH_INVALID");count+=4;
        Expect(delegate{QtValidatePaste("a\0b","ab","editor");},"QT_PASTE_INVALID");Expect(delegate{QtValidatePaste("a\nb","a\nb","search");},"QT_PASTE_SEARCH_INVALID");count+=2;
        byte[] ownText=Encoding.Unicode.GetBytes("private fixture\0");IntPtr ownWindow=new IntPtr(321);
        Need(QtOwnPasteSnapshot(ownWindow,ownWindow,42,42,true,new uint[]{13},ownText,ownText)&&QtOwnPasteSnapshot(ownWindow,ownWindow,42,42,true,new uint[]{13,16,1,7},ownText,ownText),"QT_TEST_POST_CLOSE_SYNTHESIZED_TEXT");count++;
        Need(!QtOwnPasteSnapshot(ownWindow,new IntPtr(322),42,42,true,new uint[]{13},ownText,ownText)&&!QtOwnPasteSnapshot(ownWindow,ownWindow,42,99,true,new uint[]{13},ownText,ownText),"QT_TEST_FOREIGN_COPY_SAME_TEXT_REJECTED");count++;
        Need(!QtOwnPasteSnapshot(ownWindow,ownWindow,42,42,true,new uint[]{13},Encoding.Unicode.GetBytes("new user text\0"),ownText)&&!QtOwnPasteSnapshot(ownWindow,ownWindow,42,42,true,new uint[]{13,0xc001},ownText,ownText),"QT_TEST_REPLACED_OR_AUGMENTED_CLIPBOARD_REJECTED");count++;
        Need(QtOwnPasteSnapshot(ownWindow,ownWindow,42,42,false,new uint[0],null,ownText)&&!QtOwnPasteSnapshot(ownWindow,ownWindow,42,42,false,new uint[]{13},ownText,ownText),"QT_TEST_SET_FAILURE_ONLY_OWN_EMPTY_ROLLBACK");count++;
        byte[] appended=new byte[ownText.Length+2];Array.Copy(ownText,appended,ownText.Length);Need(!QtOwnPasteSnapshot(ownWindow,ownWindow,42,42,true,new uint[]{13},appended,ownText),"QT_TEST_OWN_BUFFER_LENGTH_EXACT");count++;
        string emptyA=new string('a',64),emptyB=new string('b',64);var emptyRequest=Data("emptyEditorSha256",emptyA);
        Need(QtEmptyTemplates(emptyRequest).Count==1,"QT_TEST_LEGACY_EMPTY_TEMPLATE");count++;
        emptyRequest["emptyEditorSha256s"]=new object[]{emptyA,emptyB};var emptyHashes=QtEmptyTemplates(emptyRequest);Need(emptyHashes.Count==2&&emptyHashes.Contains(emptyA)&&emptyHashes.Contains(emptyB),"QT_TEST_EMPTY_VARIANTS_EXACT");count++;
        foreach(object invalid in new object[]{new object[0],new object[]{emptyB,emptyB},new object[]{"invalid"},new object[]{emptyB,new string('c',64),new string('d',64),new string('e',64)}}){emptyRequest["emptyEditorSha256s"]=invalid;Expect(delegate{QtEmptyTemplates(emptyRequest);},"QT_EMPTY_TEMPLATES_INVALID");count++;}
        long emptyClock=0;int emptySamples=0,emptyGuards=0;
        bool emptyMatched=QtWaitEmptyTemplate(emptyHashes,650,delegate{emptyGuards++;},delegate{emptySamples++;return emptyClock>=100?emptyB:new string('c',64);},delegate{return emptyClock;},delegate(int ms){emptyClock+=ms;});
        Need(emptyMatched&&emptyClock==100&&emptySamples==5&&emptyGuards==10,"QT_TEST_EMPTY_BLINK_VARIANT_GUARDED");count++;
        emptyClock=0;emptySamples=0;Need(!QtWaitEmptyTemplate(emptyHashes,650,delegate{},delegate{emptySamples++;return new string('c',64);},delegate{return emptyClock;},delegate(int ms){emptyClock+=ms;})&&emptyClock==650&&emptySamples==26,"QT_TEST_UNKNOWN_IMAGE_BOUNDED_REFUSAL");count++;
        emptyClock=0;emptyGuards=0;Expect(delegate{QtWaitEmptyTemplate(emptyHashes,650,delegate{if(++emptyGuards==3)throw new Fault("QT_HUMAN_ACTIVITY_CHANGED");},delegate{return new string('c',64);},delegate{return emptyClock;},delegate(int ms){emptyClock+=ms;});},"QT_HUMAN_ACTIVITY_CHANGED");count++;
        emptyClock=0;Need(!QtWaitEmptyTemplate(emptyHashes,650,delegate{},delegate{emptyClock=651;return emptyA;},delegate{return emptyClock;},delegate(int ms){emptyClock+=ms;}),"QT_TEST_LATE_EMPTY_SAMPLE_REFUSED");count++;
        foreach(string key in new[]{"Control+F","Control+A","Control+C","Control+End","Escape"}){Need(QtChord(key).Length>=2,"QT_TEST_CHORD");count++;}
        Expect(delegate{QtChord("Enter");},"QT_CHORD_FORBIDDEN");count++;
        Expect(delegate{QtParseAnchors(new object[0],new Rect(0,0,800,600));},"QT_ANCHORS_REQUIRED");count++;
        Need(QtLayoutAnchors(new object[0],true,new Rect(0,0,800,600)).Count==0,"QT_TEST_LAYOUT_IMAGE_ONLY");count++;
        Expect(delegate{QtLayoutAnchors(new object[0],false,new Rect(0,0,800,600));},"QT_ANCHORS_REQUIRED");count++;
        Expect(delegate{QtLayoutAnchors(null,true,new Rect(0,0,800,600));},"QT_ANCHORS_REQUIRED");count++;
        Expect(delegate{QtParseAnchors(new object[]{new Rect(0,0,900,600).Report()},new Rect(0,0,800,600));},"QT_REGION_INVALID");count++;
        var anchors=QtParseAnchors(new object[]{new Rect(1,1,100,100).Report()},new Rect(0,0,800,600));Need(anchors.Count==1,"QT_TEST_ANCHOR");count++;
        Need(QtHash(new byte[]{1,2,3})=="039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81","QT_TEST_HASH");count++;
        byte[] colors=new byte[8];QtRgbaRow(new byte[]{3,2,1,0,6,5,4,20},colors,0);Need(QtHash(colors)==QtHash(new byte[]{1,2,3,255,4,5,6,255}),"QT_TEST_RGBA_COMPATIBILITY");count++;
        foreach(uint format in new uint[]{1,7,8,13,15,16,17}){Need(QtBackupFormat(format,null),"QT_TEST_STANDARD_HGLOBAL");count++;}
        foreach(string format in new[]{"HTML Format","Rich Text Format","PNG","image/png","Chromium internal source RFH token","Chromium internal source URL","Chromium Web Custom MIME Data Format","CanIncludeInClipboardHistory","CanUploadToCloudClipboard"}){Need(QtBackupFormat(0xc001,format),"QT_TEST_REGISTERED_HGLOBAL");count++;}
        foreach(string action in new[]{"paste","pasteImage","pasteUiaImage","pasteUiaFile"}){
            Need(!QtAllowClipboardReplacement(Data("action",action))&&!QtAllowClipboardReplacement(Data("action",action,"allowClipboardReplacement",false))&&QtAllowClipboardReplacement(Data("action",action,"allowClipboardReplacement",true)),"QT_TEST_EXPLICIT_PASTE_REPLACEMENT_POLICY");
            Expect(delegate{QtAllowClipboardReplacement(Data("action",action,"allowClipboardReplacement","true"));},"QT_PASTE_POLICY_INVALID");count++;
            foreach(IntPtr window in new[]{IntPtr.Zero,new IntPtr(700)}){
                uint pid=window==IntPtr.Zero?0u:42u;
                var original=QtOriginalClipboardBaseline(0,31,window,pid,QtAllowClipboardReplacement(Data("action",action,"allowClipboardReplacement",true)));
                Need(!original.ReplaceOnPaste&&original.Formats.Count==0&&QtOriginalClipboardMatches(original,31,window,pid)&&!QtOriginalClipboardMatches(original,32,window,pid),"QT_TEST_KNOWN_EMPTY_ALWAYS_RESTORED");count++;
                int cleared=0;Func<bool> clear=delegate{cleared++;return true;};
                Expect(delegate{QtClearOwnedForRestore(32,7,33,7,clear);},"DRAFT_CLIPBOARD_CHANGED");
                Expect(delegate{QtClearOwnedForRestore(32,7,32,8,clear);},"DRAFT_CLIPBOARD_CHANGED");
                Need(cleared==0,"QT_TEST_LATER_COPY_NEVER_CLEARED");QtClearOwnedForRestore(32,7,32,7,clear);
                Need(cleared==1,"QT_TEST_TEMPORARY_CONTENT_CLEARED_ON_EMPTY_RESTORE");count++;
            }
        }
        Expect(delegate{QtAllowClipboardReplacement(Data("action","readDraft","allowClipboardReplacement",true));},"QT_PASTE_POLICY_INVALID");count++;
        foreach(string code in new[]{"DRAFT_CLIPBOARD_COMPLEX_FORMAT","DRAFT_CLIPBOARD_DATA_TOO_LARGE","DRAFT_CLIPBOARD_DATA_UNAVAILABLE","DRAFT_CLIPBOARD_FORMAT_INVALID"}){
            Need(QtOriginalClipboardBlocked(code,false,false)&&!QtOriginalClipboardBlocked(code,true,false)&&!QtOriginalClipboardBlocked(code,false,true),"QT_TEST_ONLY_ORIGINAL_CLIPBOARD_IS_REPLACEABLE");count++;
        }
        Need(!QtOriginalClipboardBlocked("DRAFT_CLIPBOARD_CHANGED",false,false)&&!QtOriginalClipboardBlocked("DRAFT_CLIPBOARD_RESTORE_UNCONFIRMED",false,false),"QT_TEST_NO_UNCERTAIN_CLIPBOARD_REPLACEMENT");count++;
        foreach(string format in new[]{"DataObject","Ole Private Data","Unknown Format"}){Need(!QtBackupFormat(0xc001,format),"QT_TEST_POINTER_REJECTED");count++;}
        foreach(bool opaqueFirst in new[]{false,true}){
            var selected=new List<uint>();var source=new ClipboardState();
            if(opaqueFirst)QtSelectBackupFormat(source,selected,0xc001,"DataObject",true);
            QtSelectBackupFormat(source,selected,8,null,true);
            if(!opaqueFirst)QtSelectBackupFormat(source,selected,0xc001,"DataObject",true);
            QtSelectBackupFormat(source,selected,0xc002,"PNG",true);
            Need(source.ReplaceOnPaste&&selected.Count==2&&selected[0]==8&&selected[1]==0xc002,"QT_TEST_PRIVATE_COMPANION_KEEPS_ORIGINAL_IMAGE");count++;
            Need(!QtKeepPublishedPaste(source,true)&&QtKeepPublishedPaste(source,false),"QT_TEST_OPAQUE_ORIGINAL_NEVER_KEEPS_SEARCH");count++;
            source.Formats.Add(new ClipFormat{Id=8,Bytes=new byte[]{1}});
            Need(!QtKeepPublishedPaste(source,true)&&!QtKeepPublishedPaste(source,false),"QT_TEST_IMAGE_RESTORED_AFTER_SEARCH_AND_BODY");count++;
            Expect(delegate{QtSelectBackupFormat(new ClipboardState(),new List<uint>(),0xc001,"DataObject",false);},"DRAFT_CLIPBOARD_COMPLEX_FORMAT");count++;
        }
        foreach(uint format in new uint[]{2,3,9,14}){Need(!QtBackupFormat(format,null),"QT_TEST_GDI_HANDLE_REJECTED");count++;}
        var structure=Map(QtDescribePayload("fixture",Encoding.UTF8.GetBytes("<root flag=\"0\"><text><![CDATA[PRIVATE FIXTURE]]></text></root>"),"PRIVATE FIXTURE"));Need(Object.Equals(Get(structure,"xmlParsed"),true)&&Text(structure,"root")=="root"&&!Json.Serialize(structure).Contains("PRIVATE FIXTURE"),"QT_TEST_STRUCTURE_PRIVACY");count++;
        var external=Map(QtDescribePayload("fixture",Encoding.UTF8.GetBytes("<!DOCTYPE root [<!ENTITY payload SYSTEM 'file:///C:/private'>]><root>&payload;</root>"),"fixture"));Need(Object.Equals(Get(external,"xmlParsed"),false),"QT_TEST_XML_ENTITY_REFUSED");count++;
        foreach(string format in new[]{"WeChat_RichEdit_Format","QQ_Unicode_RichEdit_Format"}){
            string rootName=format=="WeChat_RichEdit_Format"?"WeChatRichEditFormat":"QQRichEditFormat";
            Func<string,byte[]> wrap=delegate(string body){return Encoding.UTF8.GetBytes("<"+rootName+">"+body+"</"+rootName+">\0");};
            Need(QtPlainRichPayload(format,wrap("<EditElement type=\"0\"><![CDATA[\u6d4b]]></EditElement>"),"\u6d4b"),"QT_TEST_REAL_TEXT_STRUCTURE");count++;
            Need(QtPlainRichPayload(format,wrap("<EditElement type=\"0\">a&amp;&lt;</EditElement><EditElement type=\"0\"><![CDATA[\n\uD83D\uDE0A]]></EditElement>"),"a&<\n\uD83D\uDE0A"),"QT_TEST_RICH_TEXT_JOIN");count++;
            foreach(string body in new[]{"<EditElement type=\"1\">x</EditElement>","<EditElement type=\"0\" path=\"hidden\">x</EditElement>","<EditElement type=\"0\"><image/>x</EditElement>","<EditElement type=\"0\">x</EditElement><EditElement type=\"2\"/>","<EditElement type=\"0\">x</EditElement><!-- hidden -->","<EditElement type=\"0\">other</EditElement>"}){Need(!QtPlainRichPayload(format,wrap(body),"x"),"QT_TEST_ATTACHMENT_OR_UNKNOWN_REJECTED");count++;}
        }
        Need(QtPlainRichPayload("x-application-mimetype-xwechat",Encoding.UTF8.GetBytes("1234567890\0"),"x")&&!QtPlainRichPayload("x-application-mimetype-xwechat",Encoding.UTF8.GetBytes("image/png"),"x")&&!QtPlainRichPayload("x-application-mimetype-xwechat",Encoding.UTF8.GetBytes("12345abcd0"),"x"),"QT_TEST_COPY_METADATA_ONLY");count++;
        var a=new Binding{Window=new IntPtr(100),Pid=5,Created=6,Dpi=96,Focus=new IntPtr(100),Client=new Rect(0,0,800,600),Capture=new Rect(1,2,801,602)};
        var b=new Binding{Window=a.Window,Pid=a.Pid,Created=a.Created,Dpi=a.Dpi,Focus=a.Focus,Client=a.Client,Capture=a.Capture};Need(QtSameBinding(a,b),"QT_TEST_BINDING");count++;b.Created++;Need(!QtSameBinding(a,b),"QT_TEST_PROCESS_REUSE");count++;
        Write(Data("ok",true,"selfTest",true,"checks",count,"uiAccessed",false,"inputSent",false,"clipboardAccessed",false));return 0;
    }catch(Exception error){Write(Data("ok",false,"selfTest",true,"checks",count,"reason",error is Fault?error.Message:"QT_SELFTEST_FAILED","exceptionType",error.GetType().Name));return 1;}}
}
