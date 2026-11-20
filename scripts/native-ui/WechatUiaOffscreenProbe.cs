// Independent diagnostic only. No keyboard, mouse, clipboard or send API.
using System;
using System.IO;
using System.Text;
using System.Diagnostics;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;
using System.Windows.Forms;

internal static class WechatUiaOffscreenProbe {
    static readonly JavaScriptSerializer Json=new JavaScriptSerializer{MaxJsonLength=262144};
    [StructLayout(LayoutKind.Sequential)] struct Point {internal int X,Y;internal Point(int x,int y){X=x;Y=y;}internal object Report(){return D("x",X,"y",Y);}}
    [StructLayout(LayoutKind.Sequential)] struct Rect {internal int Left,Top,Right,Bottom;internal Rect(int l,int t,int r,int b){Left=l;Top=t;Right=r;Bottom=b;}internal int Width{get{return Right-Left;}}internal int Height{get{return Bottom-Top;}}internal object Report(){return D("left",Left,"top",Top,"right",Right,"bottom",Bottom);}}
    [StructLayout(LayoutKind.Sequential)] struct Placement {internal uint Length,Flags,Show;internal Point Min,Max;internal Rect Normal;internal object Report(){return D("length",Length,"flags",Flags,"showCmd",Show,"minPosition",Min.Report(),"maxPosition",Max.Report(),"normalPosition",Normal.Report());}}
    [StructLayout(LayoutKind.Sequential)] struct LastInput {internal uint Size,Time;}
    [StructLayout(LayoutKind.Sequential)] struct MonitorInfo {internal uint Size;internal Rect Bounds,Work;internal uint Flags;}
    [StructLayout(LayoutKind.Sequential)] struct FileTime {internal uint Low,High;internal long Value{get{return ((long)High<<32)|Low;}}}
    sealed class Bound {internal IntPtr Window;internal uint Pid;internal long Created;internal string Executable,Root,Journal;internal Dictionary<string,object> Request;}
    sealed class State {internal Rect Outer,Client,ClientScreen,MonitorBounds,MonitorWork;internal bool MonitorKnown;internal Placement Placement;internal uint Dpi,InputTick,ForegroundPid;internal long ForegroundCreated;internal IntPtr Foreground;internal Point Cursor;internal object Report(){return D("outer",Outer.Report(),"client",Client.Report(),"clientScreen",ClientScreen.Report(),"placement",Placement.Report(),"dpi",Dpi,"foregroundHwnd",Foreground.ToInt64().ToString(CultureInfo.InvariantCulture),"foregroundPid",ForegroundPid,"foregroundCreated",ForegroundCreated.ToString(CultureInfo.InvariantCulture),"inputTick",InputTick,"cursor",Cursor.Report(),"monitorBounds",MonitorKnown?MonitorBounds.Report():null,"monitorWork",MonitorKnown?MonitorWork.Report():null);}}
    static void Need(bool value,string reason){if(!value)throw new InvalidOperationException(reason);}
    static Dictionary<string,object> D(params object[] values){var d=new Dictionary<string,object>();for(int i=0;i<values.Length;i+=2)d.Add((string)values[i],values[i+1]);return d;}
    static Dictionary<string,object> Map(object value){var d=value as Dictionary<string,object>;Need(d!=null,"OFFSCREEN_JSON_INVALID");return d;}
    static object Get(Dictionary<string,object> d,string key){object value;return d.TryGetValue(key,out value)?value:null;}
    static long Num(object value){Need(value!=null&&!(value is bool)&&!(value is string),"OFFSCREEN_NUMBER_INVALID");decimal n=Convert.ToDecimal(value,CultureInfo.InvariantCulture);Need(n==Decimal.Truncate(n)&&n>=Int32.MinValue&&n<=UInt32.MaxValue,"OFFSCREEN_NUMBER_INVALID");return (long)n;}
    static string Str(Dictionary<string,object> d,string key){var s=Get(d,key) as string;Need(!String.IsNullOrEmpty(s),"OFFSCREEN_STRING_INVALID");return s;}
    static long DecimalId(string value){long n;Need(Int64.TryParse(value,NumberStyles.None,CultureInfo.InvariantCulture,out n)&&n>0,"OFFSCREEN_ID_INVALID");return n;}
    static Rect R(object value){var d=Map(value);return new Rect(checked((int)Num(Get(d,"left"))),checked((int)Num(Get(d,"top"))),checked((int)Num(Get(d,"right"))),checked((int)Num(Get(d,"bottom"))));}
    static Point P(object value){var d=Map(value);return new Point(checked((int)Num(Get(d,"x"))),checked((int)Num(Get(d,"y"))));}
    static Placement W(object value){var d=Map(value);return new Placement{Length=checked((uint)Num(Get(d,"length"))),Flags=checked((uint)Num(Get(d,"flags"))),Show=checked((uint)Num(Get(d,"showCmd"))),Min=P(Get(d,"minPosition")),Max=P(Get(d,"maxPosition")),Normal=R(Get(d,"normalPosition"))};}
    static State S(object value){var d=Map(value);var state=new State{Outer=R(Get(d,"outer")),Client=R(Get(d,"client")),ClientScreen=R(Get(d,"clientScreen")),Placement=W(Get(d,"placement")),Dpi=checked((uint)Num(Get(d,"dpi"))),InputTick=checked((uint)Num(Get(d,"inputTick"))),Cursor=P(Get(d,"cursor")),Foreground=new IntPtr(DecimalId(Str(d,"foregroundHwnd"))),ForegroundPid=checked((uint)Num(Get(d,"foregroundPid"))),ForegroundCreated=DecimalId(Str(d,"foregroundCreated"))};state.MonitorKnown=Get(d,"monitorBounds")!=null&&Get(d,"monitorWork")!=null;if(state.MonitorKnown){state.MonitorBounds=R(Get(d,"monitorBounds"));state.MonitorWork=R(Get(d,"monitorWork"));}return state;}
    static bool Same(Rect a,Rect b){return a.Left==b.Left&&a.Top==b.Top&&a.Right==b.Right&&a.Bottom==b.Bottom;}
    static bool Same(Point a,Point b){return a.X==b.X&&a.Y==b.Y;}
    static bool Same(Placement a,Placement b){return a.Length==b.Length&&a.Flags==b.Flags&&a.Show==b.Show&&Same(a.Min,b.Min)&&Same(a.Max,b.Max)&&Same(a.Normal,b.Normal);}
    static bool SamePlacementIntent(Placement a,Placement b){return a.Length==b.Length&&a.Flags==b.Flags&&a.Show==b.Show&&Same(a.Normal,b.Normal);}
    static bool SameGeometry(State a,State b){return Same(a.Outer,b.Outer)&&Same(a.Client,b.Client)&&Same(a.ClientScreen,b.ClientScreen)&&a.Dpi==b.Dpi;}
    static bool SameWindowState(State a,State b){return Same(a.Outer,b.Outer)&&Same(a.Client,b.Client)&&Same(a.ClientScreen,b.ClientScreen)&&a.Dpi==b.Dpi&&Same(a.Placement,b.Placement);}
    // Keep byte-exact comparisons for ownership leases. Only restoration may
    // accept Windows-normalized position caches, with real geometry unchanged.
    // WPF_SETMINPOSITION governs whether ptMinPosition is a requested position:
    // https://learn.microsoft.com/windows/win32/api/winuser/ns-winuser-windowplacement
    // The max-position exception is deliberately narrower than general Win32:
    // a previously unspecified (-1,-1) cache, currently maximized, with its
    // client exactly filling the same monitor work area, may become the actual
    // monitor-relative outer origin. Ambiguous taskbar-origin/custom layouts
    // and any nondefault previous max position still require exact metadata.
    static bool SemanticPlacement(State current,State original){
        var a=current.Placement;var b=original.Placement;
        if(!SamePlacementIntent(a,b))return false;
        if(!Same(a.Min,b.Min)&&(b.Flags&1)!=0)return false;
        if(Same(a.Max,b.Max))return true;
        return a.Show==3&&Same(b.Max,new Point(-1,-1))&&current.MonitorKnown&&
            (!original.MonitorKnown||(Same(current.MonitorBounds,original.MonitorBounds)&&Same(current.MonitorWork,original.MonitorWork)))&&
            current.MonitorBounds.Left==current.MonitorWork.Left&&current.MonitorBounds.Top==current.MonitorWork.Top&&
            Same(current.ClientScreen,current.MonitorWork)&&
            (long)a.Max.X==(long)current.Outer.Left-current.MonitorBounds.Left&&
            (long)a.Max.Y==(long)current.Outer.Top-current.MonitorBounds.Top;
    }
    static bool SemanticWindowState(State current,State original){return SameGeometry(current,original)&&SemanticPlacement(current,original);}
    static bool SameUser(State a,State b){return a.InputTick==b.InputTick&&Same(a.Cursor,b.Cursor)&&a.Foreground==b.Foreground&&a.ForegroundPid==b.ForegroundPid&&a.ForegroundCreated==b.ForegroundCreated;}
    static bool MayReturnForeground(State current,State baseline,IntPtr target,bool identity){return current.Foreground==target&&current.Foreground!=baseline.Foreground&&current.InputTick==baseline.InputTick&&Same(current.Cursor,baseline.Cursor)&&identity;}
    static long ProcessCreated(uint pid){IntPtr process=OpenProcess(0x1000,false,pid);Need(process!=IntPtr.Zero,"OFFSCREEN_PROCESS_UNAVAILABLE");try{FileTime start,exit,kernel,user;Need(GetProcessTimes(process,out start,out exit,out kernel,out user),"OFFSCREEN_PROCESS_UNAVAILABLE");return start.Value;}finally{CloseHandle(process);}}
    static bool ForegroundIdentity(State state){uint pid;try{return IsWindow(state.Foreground)&&GetWindowThreadProcessId(state.Foreground,out pid)!=0&&pid==state.ForegroundPid&&ProcessCreated(pid)==state.ForegroundCreated;}catch{return false;}}
    static bool Intersects(Rect a,Rect b){return a.Left<b.Right&&b.Left<a.Right&&a.Top<b.Bottom&&b.Top<a.Bottom;}
    static List<Rect> Screens(){var result=new List<Rect>();foreach(Screen s in Screen.AllScreens){var r=s.Bounds;result.Add(new Rect(r.Left,r.Top,r.Right,r.Bottom));}Need(result.Count>0&&result.Count<=32,"OFFSCREEN_DISPLAY_INVALID");return result;}
    static bool Outside(Rect value,List<Rect> screens){foreach(var screen in screens)if(Intersects(value,screen))return false;return true;}
    static Rect Destination(Rect original,List<Rect> screens){
        Need(original.Width>0&&original.Height>0&&original.Width<=8192&&original.Height<=8192&&screens.Count>0,"OFFSCREEN_GEOMETRY_INVALID");int left=Int32.MaxValue,right=Int32.MinValue,top=Int32.MaxValue,bottom=Int32.MinValue;
        foreach(var r in screens){left=Math.Min(left,r.Left);right=Math.Max(right,r.Right);top=Math.Min(top,r.Top);bottom=Math.Max(bottom,r.Bottom);}
        var candidates=new[]{new Rect(checked(right+64),original.Top,checked(right+64+original.Width),original.Bottom),new Rect(checked(left-64-original.Width),original.Top,checked(left-64),original.Bottom),new Rect(original.Left,checked(bottom+64),original.Right,checked(bottom+64+original.Height)),new Rect(original.Left,checked(top-64-original.Height),original.Right,checked(top-64))};
        Rect best=candidates[0];long distance=Int64.MaxValue;foreach(var r in candidates){if(r.Left< -32768||r.Top< -32768||r.Right>32767||r.Bottom>32767||!Outside(r,screens))continue;long delta=Math.Abs((long)r.Left-original.Left)+Math.Abs((long)r.Top-original.Top);if(delta<distance){distance=delta;best=r;}}
        Need(distance<Int64.MaxValue,"OFFSCREEN_POSITION_UNAVAILABLE");return best;
    }
    static string PathChecked(string value){Need(Path.IsPathRooted(value)&&!value.StartsWith(@"\\"),"OFFSCREEN_PATH_INVALID");string full=Path.GetFullPath(value);for(string at=full;!String.IsNullOrEmpty(at);at=Path.GetDirectoryName(at)){if(File.Exists(at)||Directory.Exists(at))Need((File.GetAttributes(at)&FileAttributes.ReparsePoint)==0,"OFFSCREEN_LINK_REFUSED");if(Path.GetDirectoryName(at)==at)break;}return full;}
    static Bound Parse(Dictionary<string,object> request,bool mutation){
        foreach(string key in request.Keys)Need(key=="version"||key=="hwnd"||key=="pid"||key=="processCreatedFileTimeUtc"||key=="executable"||key=="root"||key=="journalPath","OFFSCREEN_REQUEST_INVALID");Need(Num(Get(request,"version"))==1,"OFFSCREEN_REQUEST_INVALID");
        var b=new Bound{Window=new IntPtr(DecimalId(Str(request,"hwnd"))),Pid=checked((uint)Num(Get(request,"pid"))),Created=DecimalId(Str(request,"processCreatedFileTimeUtc")),Executable=PathChecked(Str(request,"executable")),Request=request};
        Need(b.Pid>0&&(Path.GetFileName(b.Executable).Equals("Weixin.exe",StringComparison.OrdinalIgnoreCase)||Path.GetFileName(b.Executable).Equals("WeChat.exe",StringComparison.OrdinalIgnoreCase))&&FileVersionInfo.GetVersionInfo(b.Executable).FileVersion=="4.1.15.56","OFFSCREEN_EXECUTABLE_INVALID");
        if(mutation){b.Root=PathChecked(Str(request,"root")).TrimEnd('\\');b.Journal=PathChecked(Str(request,"journalPath"));string directory=Path.Combine(b.Root,"state","diagnostics");Need(PathChecked(System.Reflection.Assembly.GetExecutingAssembly().Location).StartsWith(directory+"\\",StringComparison.OrdinalIgnoreCase)&&File.Exists(Path.Combine(b.Root,"scripts","ui-service.mjs"))&&File.Exists(Path.Combine(b.Root,"scripts","reader-target-service.mjs")),"OFFSCREEN_WORKSPACE_BINDING_INVALID");Need(Directory.Exists(directory)&&b.Journal.StartsWith(directory+"\\",StringComparison.OrdinalIgnoreCase)&&Path.GetExtension(b.Journal)==".jsonl"&&Directory.Exists(Path.GetDirectoryName(b.Journal)),"OFFSCREEN_JOURNAL_SCOPE_INVALID");}
        return b;
    }
    static void Identity(Bound b){
        uint pid=0;Need(IsWindow(b.Window)&&GetAncestor(b.Window,2)==b.Window&&GetWindowThreadProcessId(b.Window,out pid)!=0&&pid==b.Pid,"OFFSCREEN_WINDOW_CHANGED");uint session,own;Need(ProcessIdToSessionId(pid,out session)&&ProcessIdToSessionId(GetCurrentProcessId(),out own)&&session==own,"OFFSCREEN_SESSION_CHANGED");
        IntPtr process=OpenProcess(0x1000,false,pid);Need(process!=IntPtr.Zero,"OFFSCREEN_PROCESS_UNAVAILABLE");try{FileTime start,exit,kernel,user;var file=new StringBuilder(32768);int length=file.Capacity;Need(GetProcessTimes(process,out start,out exit,out kernel,out user)&&start.Value==b.Created&&QueryFullProcessImageName(process,0,file,ref length)&&Path.GetFullPath(file.ToString()).Equals(b.Executable,StringComparison.OrdinalIgnoreCase),"OFFSCREEN_PROCESS_CHANGED");}finally{CloseHandle(process);}
    }
    static State Snapshot(Bound b){Identity(b);Need(IsWindowVisible(b.Window)&&!IsIconic(b.Window),"OFFSCREEN_WINDOW_MINIMIZED_OR_HIDDEN");int cloaked;Need(DwmGetWindowAttribute(b.Window,14,out cloaked,4)>=0&&cloaked==0,"OFFSCREEN_WINDOW_CLOAKED");
        var state=new State();state.Placement.Length=(uint)Marshal.SizeOf(typeof(Placement));Point origin=new Point();var last=new LastInput{Size=(uint)Marshal.SizeOf(typeof(LastInput))};
        Need(GetWindowRect(b.Window,out state.Outer)&&GetClientRect(b.Window,out state.Client)&&ClientToScreen(b.Window,ref origin)&&GetWindowPlacement(b.Window,ref state.Placement)&&GetCursorPos(out state.Cursor)&&GetLastInputInfo(ref last),"OFFSCREEN_SNAPSHOT_FAILED");
        state.ClientScreen=new Rect(origin.X,origin.Y,origin.X+state.Client.Width,origin.Y+state.Client.Height);state.Dpi=GetDpiForWindow(b.Window);state.Foreground=GetForegroundWindow();Need(GetWindowThreadProcessId(state.Foreground,out state.ForegroundPid)!=0,"OFFSCREEN_FOREGROUND_UNAVAILABLE");state.ForegroundCreated=ProcessCreated(state.ForegroundPid);state.InputTick=last.Time;Need(state.Placement.Show==1||state.Placement.Show==3,"OFFSCREEN_SHOW_STATE_UNSUPPORTED");var monitor=new MonitorInfo{Size=(uint)Marshal.SizeOf(typeof(MonitorInfo))};Need(GetMonitorInfo(MonitorFromWindow(b.Window,2),ref monitor),"OFFSCREEN_MONITOR_UNAVAILABLE");state.MonitorKnown=true;state.MonitorBounds=monitor.Bounds;state.MonitorWork=monitor.Work;return state;
    }
    static bool Alive(long pid){if(pid<=0||pid>Int32.MaxValue)return true;try{using(var p=Process.GetProcessById((int)pid))return !p.HasExited;}catch(ArgumentException){return false;}catch{return true;}}
    static void ServicesStopped(Bound b){
        foreach(string relative in new[]{"state\\ui-service.lock","state\\reader-service\\service.lock"}){string file=PathChecked(Path.Combine(b.Root,relative));if(File.Exists(file)){var data=Map(Json.DeserializeObject(File.ReadAllText(file)));Need(!Alive(Num(Get(data,"pid"))),"OFFSCREEN_SERVICE_RUNNING");}}
        string runtime=PathChecked(Path.Combine(b.Root,"state","runtime.json"));if(File.Exists(runtime)){var data=Map(Json.DeserializeObject(File.ReadAllText(runtime)));foreach(string key in new[]{"adapter","reader"})if(Get(data,key)!=null)Need(!Alive(Num(Get(Map(Get(data,key)),"pid"))),"OFFSCREEN_SERVICE_RUNNING");}
    }
    static void Quiet(State before){var last=new LastInput{Size=(uint)Marshal.SizeOf(typeof(LastInput))};Point cursor;Need(GetLastInputInfo(ref last)&&last.Time==before.InputTick&&unchecked((uint)GetTickCount64()-last.Time)>=1000&&GetForegroundWindow()==before.Foreground&&GetCursorPos(out cursor)&&Same(cursor,before.Cursor),"OFFSCREEN_USER_ACTIVITY_CHANGED");for(int key=1;key<256;key++)Need((GetAsyncKeyState(key)&0x8000)==0,"OFFSCREEN_KEYS_HELD");}
    static object Controls(Bound b,out bool filehelper){
        Identity(b);var counts=new Dictionary<string,List<object>>();foreach(string role in new[]{"editor","send","title","voice"})counts.Add(role,new List<object>());bool matched=false;int headers=0,visited=0;var timer=Stopwatch.StartNew();var walker=TreeWalker.RawViewWalker;
        Action<AutomationElement,int,bool,bool,bool> walk=null;walk=delegate(AutomationElement element,int depth,bool input,bool title,bool page){Need(++visited<=2048&&depth<=96&&timer.ElapsedMilliseconds<=1500,"OFFSCREEN_UIA_SCAN_LIMIT");var info=element.Current;Need(info.ProcessId==(int)b.Pid,"OFFSCREEN_UIA_PROCESS_CHANGED");string cls=info.ClassName;page=page||cls=="mmui::ChatMessagePage";input=input||cls=="mmui::ChatInputView";title=title||cls=="mmui::ChatTitleBarMasterView";
            if(depth==0)Need(cls=="mmui::MainWindow"&&info.ControlType==ControlType.Window,"OFFSCREEN_UIA_ROOT_INVALID");
            string role=null;if(page&&cls=="mmui::ChatTitleBarMasterView"){role="title";headers++;}if(input&&cls=="mmui::ChatInputField"&&info.AutomationId=="chat_input_field"&&info.ControlType==ControlType.Edit)role="editor";
            if(title&&cls=="mmui::XTextView"&&info.ControlType==ControlType.Text){string name=info.Name;if(name=="文件传输助手"||name=="File Transfer")matched=true;}
            if(input&&info.ControlType==ControlType.Button){string label=info.Name,help=info.HelpText;if(label=="发送"||label=="Send"||help=="发送"||help=="Send")role="send";if(label=="发语音 ( 按住右 Alt )"||label=="语音消息"||label=="Voice message"||help=="发语音 ( 按住右 Alt )")role="voice";}
            if(role!=null){var area=info.BoundingRectangle;counts[role].Add(D("enabled",info.IsEnabled,"offscreen",info.IsOffscreen,"hasRect",!area.IsEmpty&&area.Width>0&&area.Height>0,"rect",area.IsEmpty?null:D("left",area.Left,"top",area.Top,"right",area.Right,"bottom",area.Bottom)));}
            if(info.ControlType==ControlType.Edit||info.ControlType==ControlType.List||info.ControlType==ControlType.ListItem||cls=="mmui::ChatMessageView"||cls=="mmui::ChatMessageListView")return;
            for(var child=walker.GetFirstChild(element);child!=null;child=walker.GetNextSibling(child))walk(child,depth+1,input,title,page);
        };walk(AutomationElement.FromHandle(b.Window),0,false,false,false);filehelper=matched&&headers==1;var report=D("filehelperMatched",filehelper,"visited",visited,"elapsedMs",timer.ElapsedMilliseconds);foreach(var role in counts)report.Add(role.Key,D("count",role.Value.Count,"unique",role.Value.Count==1,"controls",role.Value));return report;
    }
    static void Journal(Bound b,object entry,bool first=false){using(var file=new FileStream(b.Journal,first?FileMode.CreateNew:FileMode.Append,FileAccess.Write,FileShare.Read)){byte[] bytes=Encoding.UTF8.GetBytes(Json.Serialize(entry)+"\n");file.Write(bytes,0,bytes.Length);file.Flush(true);}}
    static void RestoreJournal(Bound b,object entry){try{Journal(b,entry);}catch{/* The prepared journal is durable; an append error must not prevent rollback. */}}
    static int JournalPrefix(byte[] bytes){for(int i=bytes.Length-1;i>=0;i--)if(bytes[i]==10)return i+1;return 0;}
    static bool MayRestore(Rect current,Rect owned,uint currentShow,uint ownedShow,bool identity){return identity&&Same(current,owned)&&currentShow==ownedShow;}
    static bool PreparedLease(State current,State original,Rect destination){
        Placement expected=original.Placement;int dx=destination.Left-original.Outer.Left,dy=destination.Top-original.Outer.Top;
        expected.Normal=new Rect(checked(expected.Normal.Left+dx),checked(expected.Normal.Top+dy),checked(expected.Normal.Right+dx),checked(expected.Normal.Bottom+dy));
        return Same(current.Outer,destination)&&Same(current.Client,original.Client)&&current.Dpi==original.Dpi&&(Same(current.Placement,original.Placement)||Same(current.Placement,expected));
    }
    static object Restore(Bound b,State original,State owned,Rect destination,bool recovery){
        State current;try{current=Snapshot(b);}catch{return D("restored",false,"semanticRestored",false,"exactMetadataMatched",false,"reason","identity-or-show-state-changed","placementRestored",false);}
        if(SemanticWindowState(current,original))return D("restored",true,"semanticRestored",true,"exactMetadataMatched",Same(current.Placement,original.Placement),"reason",SameWindowState(current,original)?"already-restored":"already-semantically-restored","placementRestored",true,"positionApplied",false,"placementApplied",false,"foregroundRestoreRequested",false,"after",current.Report());
        if(!(owned!=null?SameWindowState(current,owned):PreparedLease(current,original,destination)))return D("restored",false,"semanticRestored",false,"exactMetadataMatched",Same(current.Placement,original.Placement),"reason","window-moved-by-other","placementRestored",false);
        State focusBaseline=recovery?current:original;if(recovery)Quiet(focusBaseline);
        State after=current;bool positionApplied=false,placementApplied=false,focusRestored=false,focusRequested=false;
        try{
            // Even after keyboard input, this exact still-owned position can
            // return without activation. Record every mutation boundary so an
            // explicit recovery can finish after a crash during compensation.
            if(!Same(current.Outer,original.Outer)){
                RestoreJournal(b,D("phase","restoring-position","owned",current.Report()));
                positionApplied=true;Need(SetWindowPos(b.Window,IntPtr.Zero,original.Outer.Left,original.Outer.Top,original.Outer.Width,original.Outer.Height,0x0010|0x0004|0x0200),"OFFSCREEN_RESTORE_POSITION_FAILED");after=Snapshot(b);
                Need(Same(after.Outer,original.Outer)&&after.Placement.Show==current.Placement.Show,"OFFSCREEN_RESTORE_POSITION_UNCONFIRMED");RestoreJournal(b,D("phase","position-restored","owned",after.Report()));
            }
            if(!SemanticWindowState(after,original)){
                // Never reapply an old min/max cache repeatedly. An unknown
                // cache-only difference needs review, not another window move.
                Need(!(SameGeometry(after,original)&&SamePlacementIntent(after.Placement,original.Placement)),"OFFSCREEN_PLACEMENT_METADATA_REQUIRES_REVIEW");
                // SetWindowPlacement may activate a maximized window. Only
                // enter this boundary with a still-valid foreground identity
                // and unchanged user input, then restore that exact foreground.
                Need(SameUser(after,focusBaseline)&&ForegroundIdentity(focusBaseline),"OFFSCREEN_PLACEMENT_REPAIR_REQUIRES_QUIET_RECOVERY");
                State beforePlacement=Snapshot(b);Need(SameWindowState(beforePlacement,after)&&SameUser(beforePlacement,focusBaseline),"OFFSCREEN_WINDOW_CHANGED");
                RestoreJournal(b,D("phase","restoring-placement","owned",after.Report(),"focusBaseline",focusBaseline.Report()));Placement placement=original.Placement;
                placementApplied=true;Need(SetWindowPlacement(b.Window,ref placement),"OFFSCREEN_RESTORE_PLACEMENT_FAILED");after=Snapshot(b);
                Need(SemanticWindowState(after,original),"OFFSCREEN_RESTORE_PLACEMENT_UNCONFIRMED");RestoreJournal(b,D("phase","placement-restored","owned",after.Report(),"focusBaseline",focusBaseline.Report()));
                if(after.Foreground!=focusBaseline.Foreground){
                    Need(MayReturnForeground(after,focusBaseline,b.Window,ForegroundIdentity(focusBaseline)),"OFFSCREEN_FOREGROUND_RESTORE_UNSAFE");
                    focusRequested=true;Need(SetForegroundWindow(focusBaseline.Foreground),"OFFSCREEN_FOREGROUND_RESTORE_UNCONFIRMED");after=Snapshot(b);Need(after.Foreground==focusBaseline.Foreground,"OFFSCREEN_FOREGROUND_RESTORE_UNCONFIRMED");focusRestored=true;
                }
            }
            bool complete=SemanticWindowState(after,original);return D("restored",complete,"semanticRestored",complete,"exactMetadataMatched",Same(after.Placement,original.Placement),"reason",complete?"restored":"restore-unconfirmed","placementRestored",SemanticPlacement(after,original),"positionApplied",positionApplied,"placementApplied",placementApplied,"foregroundRestored",focusRestored,"foregroundUnchangedDuringRestore",after.Foreground==current.Foreground,"after",after.Report());
        }catch(Exception error){
            // A failed placement verification can still have activated the
            // target. Compensate that side effect once under the same lease.
            if(placementApplied&&!focusRequested){try{State latest=Snapshot(b);if(MayReturnForeground(latest,focusBaseline,b.Window,ForegroundIdentity(focusBaseline))){focusRequested=true;focusRestored=SetForegroundWindow(focusBaseline.Foreground)&&GetForegroundWindow()==focusBaseline.Foreground;}after=Snapshot(b);}catch{}}
            RestoreJournal(b,D("phase","restore-failed","reason",Safe(error),"foregroundRestoreRequested",focusRequested,"foregroundRestored",focusRestored));return D("restored",false,"semanticRestored",SemanticWindowState(after,original),"exactMetadataMatched",Same(after.Placement,original.Placement),"reason",Safe(error),"positionApplied",positionApplied,"placementApplied",placementApplied,"placementRestored",SemanticPlacement(after,original),"foregroundRestoreRequested",focusRequested,"foregroundRestored",focusRestored,"after",after.Report());}
    }
    static object Run(Bound b,bool move){
        State before=Snapshot(b);bool helper;object controls=Controls(b,out helper);var screens=Screens();var report=D("version",1,"mode",move?"probe-position":"inspect","inputSent",false,"clipboardAccessed",false,"messageSent",false,"probeActivationRequested",false,"binding",b.Request,"before",before.Report(),"controlsBefore",controls);
        if(!move){report.Add("ok",true);return report;}Need(helper,"OFFSCREEN_FILEHELPER_REQUIRED");Need(!Outside(before.Outer,screens),"OFFSCREEN_ALREADY_OUTSIDE");ServicesStopped(b);Quiet(before);Rect destination=Destination(before.Outer,screens);report.Add("destination",destination.Report());
        using(var gate=new Mutex(false,"Local\\WeChatAgent.UiInput.v1")){bool acquired=false;try{try{acquired=gate.WaitOne(0);}catch(AbandonedMutexException){acquired=true;}Need(acquired,"OFFSCREEN_INPUT_MUTEX_BUSY");ServicesStopped(b);State current=Snapshot(b);Need(Same(current.Outer,before.Outer)&&Same(current.Placement,before.Placement)&&current.Dpi==before.Dpi,"OFFSCREEN_WINDOW_CHANGED");Quiet(before);
            Journal(b,D("version",1,"kind","uia-offscreen-position-v1","phase","prepared","request",b.Request,"before",before.Report(),"destination",destination.Report()),true);bool attempted=false;State moved=null,ownedState=null;
            try{attempted=true;Need(SetWindowPos(b.Window,IntPtr.Zero,destination.Left,destination.Top,0,0,0x0001|0x0004|0x0010|0x0200),"OFFSCREEN_MOVE_FAILED");moved=Snapshot(b);if(SameUser(before,moved))ownedState=moved;Journal(b,D("phase","moved","state",moved.Report(),"owned",ownedState==null?null:ownedState.Report()));report.Add("offscreen",moved.Report());Need(Same(moved.Outer,destination)&&Same(moved.Client,before.Client)&&moved.Dpi==before.Dpi&&moved.Placement.Show==before.Placement.Show,"OFFSCREEN_AUTOMATIC_GEOMETRY_CHANGED");Need(Outside(moved.Outer,screens),"OFFSCREEN_MOVE_UNCONFIRMED");Need(moved.Foreground==before.Foreground,"OFFSCREEN_FOREGROUND_CHANGED");Quiet(before);report.Add("controlsOffscreen",Controls(b,out helper));report.Add("ok",true);
            }catch(Exception error){report["ok"]=false;report["reason"]=Safe(error);RestoreJournal(b,D("phase","probe-failed","reason",Safe(error)));}
            finally{if(attempted){object restored=Restore(b,before,ownedState,destination,false);report.Add("restoration",restored);RestoreJournal(b,D("phase",Object.Equals(Get(Map(restored),"restored"),true)?"restored":"recovery-required","restoration",restored));if(!Object.Equals(Get(Map(restored),"restored"),true))report["ok"]=false;}}
        }finally{if(acquired)gate.ReleaseMutex();}}return report;
    }
    static string Safe(Exception error){return error is InvalidOperationException&&error.Message.StartsWith("OFFSCREEN_",StringComparison.Ordinal)?error.Message:"OFFSCREEN_OPERATION_FAILED";}
    static object Recover(Bound b){ServicesStopped(b);Need(File.Exists(b.Journal)&&new FileInfo(b.Journal).Length<=262144,"OFFSCREEN_JOURNAL_INVALID");byte[] journalBytes=File.ReadAllBytes(b.Journal);int complete=JournalPrefix(journalBytes);Need(complete>0,"OFFSCREEN_JOURNAL_INVALID");string[] lines=new UTF8Encoding(false,true).GetString(journalBytes,0,complete).TrimEnd('\n','\r').Split('\n');Need(lines.Length>=1,"OFFSCREEN_JOURNAL_INVALID");var first=Map(Json.DeserializeObject(lines[0]));Need(Str(first,"kind")=="uia-offscreen-position-v1"&&Json.Serialize(Get(first,"request"))==Json.Serialize(b.Request),"OFFSCREEN_JOURNAL_BINDING_INVALID");var last=Map(Json.DeserializeObject(lines[lines.Length-1]));Need(Str(last,"phase")!="restored","OFFSCREEN_ALREADY_RESTORED");State original=S(Get(first,"before")),owned=null,focusPending=null;Rect destination=R(Get(first,"destination"));string lastMutation=null;
        foreach(string line in lines){var entry=Map(Json.DeserializeObject(line));if(Get(entry,"owned")!=null){owned=S(Get(entry,"owned"));lastMutation=Str(entry,"phase");}if(Get(entry,"focusBaseline")!=null)focusPending=S(Get(entry,"focusBaseline"));}
        using(var gate=new Mutex(false,"Local\\WeChatAgent.UiInput.v1")){bool acquired=false;try{try{acquired=gate.WaitOne(0);}catch(AbandonedMutexException){acquired=true;}Need(acquired,"OFFSCREEN_INPUT_MUTEX_BUSY");ServicesStopped(b);
            if(complete<journalBytes.Length){using(var file=new FileStream(b.Journal,FileMode.Open,FileAccess.ReadWrite,FileShare.Read)){Need(file.Length==journalBytes.Length,"OFFSCREEN_JOURNAL_CHANGED");for(int i=0;i<journalBytes.Length;i++)Need(file.ReadByte()==journalBytes[i],"OFFSCREEN_JOURNAL_CHANGED");file.SetLength(complete);file.Flush(true);}}
            State current=Snapshot(b);
            // Complete a crash between a successful position rollback and its
            // journal append only when the expected normal placement transform
            // and original screen geometry still match exactly.
            if(lastMutation=="restoring-position"&&owned!=null&&Same(current.Outer,original.Outer)&&Same(current.Client,original.Client)&&current.Dpi==original.Dpi&&current.Placement.Show==owned.Placement.Show){
                var expected=owned.Placement;int dx=original.Outer.Left-owned.Outer.Left,dy=original.Outer.Top-owned.Outer.Top;expected.Normal=new Rect(checked(expected.Normal.Left+dx),checked(expected.Normal.Top+dy),checked(expected.Normal.Right+dx),checked(expected.Normal.Bottom+dy));
                if(Same(current.Placement,expected)||Same(current.Placement,original.Placement))owned=current;
            }
            bool returnedFocus=false,focusSkipped=false;
            if(focusPending!=null&&SemanticWindowState(current,original)&&current.Foreground!=focusPending.Foreground){
                if(MayReturnForeground(current,focusPending,b.Window,ForegroundIdentity(focusPending))){Need(SetForegroundWindow(focusPending.Foreground),"OFFSCREEN_FOREGROUND_RESTORE_UNCONFIRMED");current=Snapshot(b);Need(current.Foreground==focusPending.Foreground,"OFFSCREEN_FOREGROUND_RESTORE_UNCONFIRMED");returnedFocus=true;}
                else focusSkipped=true;
            }
            object result=Restore(b,original,owned,destination,true);RestoreJournal(b,D("phase",Object.Equals(Get(Map(result),"restored"),true)?"restored":"recovery-required","restoration",result));return D("version",1,"ok",Get(Map(result),"restored"),"mode","recover-position","inputSent",false,"clipboardAccessed",false,"foregroundRestored",returnedFocus,"focusReturnSkippedForUserChange",focusSkipped,"restoration",result);
        }finally{if(acquired)gate.ReleaseMutex();}}
    }
    static object SelfTest(){int n=0;var screens=new List<Rect>{new Rect(-1920,0,0,1080),new Rect(0,-1080,1920,1080),new Rect(1920,0,3840,2160)};foreach(var sample in new[]{new Rect(-1800,40,-1000,640),new Rect(100,-900,900,-300),new Rect(2000,40,2800,640)}){Rect dest=Destination(sample,screens);Need(Outside(dest,screens)&&dest.Width==sample.Width&&dest.Height==sample.Height,"OFFSCREEN_TEST_UNION");n++;}
        var owned=new Rect(3904,40,4704,640);Need(MayRestore(owned,owned,3,3,true),"OFFSCREEN_TEST_RESTORE_MAXIMIZED_WITH_NO_INPUT_DEPENDENCE");n++;
        Need(!MayRestore(new Rect(3905,40,4705,640),owned,3,3,true)&&!MayRestore(owned,owned,1,3,true)&&!MayRestore(owned,owned,3,3,false),"OFFSCREEN_TEST_USER_MOVE_SHOW_REUSE_REFUSED");n++;
        var placement=new Placement{Length=(uint)Marshal.SizeOf(typeof(Placement)),Show=3,Flags=2,Normal=new Rect(10,20,810,620),Min=new Point(-1,-1),Max=new Point(0,0)};Need(Same(placement,W(Json.DeserializeObject(Json.Serialize(placement.Report())))),"OFFSCREEN_TEST_FULL_PLACEMENT_ROUNDTRIP");n++;
        var original=new State{Outer=new Rect(0,0,800,600),Client=new Rect(0,0,780,560),ClientScreen=new Rect(10,30,790,590),Dpi=96,Placement=placement,Foreground=new IntPtr(123),ForegroundPid=9,ForegroundCreated=42,InputTick=100,Cursor=new Point(20,30)};
        var moved=new State{Outer=owned,Client=original.Client,ClientScreen=new Rect(3914,70,4694,630),Dpi=96,Placement=placement,Foreground=original.Foreground,ForegroundPid=9,ForegroundCreated=42,InputTick=100,Cursor=original.Cursor};
        Need(PreparedLease(moved,original,owned)&&SameUser(original,moved),"OFFSCREEN_TEST_MAXIMIZED_PREPARED_CRASH_LEASE");n++;
        moved.Dpi=144;Need(!PreparedLease(moved,original,owned)&&SameUser(original,moved),"OFFSCREEN_TEST_DPI_ADJUSTMENT_NEEDS_IMMEDIATE_OWNED_SNAPSHOT");moved.Dpi=96;n++;
        moved.InputTick++;Need(!SameUser(original,moved),"OFFSCREEN_TEST_USER_INPUT_DISALLOWS_ADOPTING_ADJUSTED_GEOMETRY");moved.InputTick--;n++;
        moved.Foreground=new IntPtr(77);Need(MayReturnForeground(moved,original,new IntPtr(77),true)&&!MayReturnForeground(moved,original,new IntPtr(77),false),"OFFSCREEN_TEST_FOREGROUND_IDENTITY_REQUIRED");n++;
        moved.InputTick++;Need(!MayReturnForeground(moved,original,new IntPtr(77),true),"OFFSCREEN_TEST_NO_FOCUS_RETURN_AFTER_INPUT");n++;
        Need(JournalPrefix(Encoding.UTF8.GetBytes("{ok}\n{torn"))==5&&JournalPrefix(Encoding.UTF8.GetBytes("{torn"))==0&&JournalPrefix(Encoding.UTF8.GetBytes("{ok}\n"))==5,"OFFSCREEN_TEST_TORN_JOURNAL_TAIL");n++;
        var saved=new State{Outer=new Rect(2549,-11,3651,1859),Client=new Rect(0,0,1080,1848),ClientScreen=new Rect(2560,0,3640,1848),Dpi=144,Placement=new Placement{Length=44,Flags=2,Show=3,Min=new Point(-32000,-32000),Max=new Point(-1,-1),Normal=new Rect(2634,767,3732,1465)}};
        var normalized=new State{Outer=saved.Outer,Client=saved.Client,ClientScreen=saved.ClientScreen,Dpi=144,Placement=saved.Placement,MonitorKnown=true,MonitorBounds=new Rect(2560,0,3640,1920),MonitorWork=new Rect(2560,0,3640,1848)};
        normalized.Placement.Min=new Point(-1,-1);normalized.Placement.Max=new Point(-11,-11);Need(SemanticWindowState(normalized,saved)&&!SameWindowState(normalized,saved),"OFFSCREEN_TEST_REAL_MAXIMIZED_NORMALIZATION");n++;
        normalized.Placement.Normal.Left++;Need(!SemanticWindowState(normalized,saved),"OFFSCREEN_TEST_RESTORE_RECT_ALWAYS_EXACT");normalized.Placement.Normal.Left--;n++;
        normalized.Placement.Flags=0;Need(!SemanticWindowState(normalized,saved),"OFFSCREEN_TEST_FLAGS_ALWAYS_EXACT");normalized.Placement.Flags=2;n++;
        normalized.Placement.Show=1;Need(!SemanticWindowState(normalized,saved),"OFFSCREEN_TEST_SHOW_ALWAYS_EXACT");normalized.Placement.Show=3;n++;
        normalized.Placement.Flags=saved.Placement.Flags=3;Need(!SemanticWindowState(normalized,saved),"OFFSCREEN_TEST_EXPLICIT_MIN_POSITION_ALWAYS_EXACT");normalized.Placement.Flags=saved.Placement.Flags=2;n++;
        saved.Placement.Max=new Point(0,0);Need(!SemanticWindowState(normalized,saved),"OFFSCREEN_TEST_EXPLICIT_MAX_POSITION_ALWAYS_EXACT");saved.Placement.Max=new Point(-1,-1);n++;
        normalized.Placement.Max.X++;Need(!SemanticWindowState(normalized,saved),"OFFSCREEN_TEST_MAX_CACHE_REQUIRES_ACTUAL_ORIGIN");normalized.Placement.Max.X--;n++;
        normalized.Outer.Left++;Need(!SemanticWindowState(normalized,saved),"OFFSCREEN_TEST_GEOMETRY_ALWAYS_EXACT");normalized.Outer.Left--;n++;
        normalized.Dpi=96;Need(!SemanticWindowState(normalized,saved),"OFFSCREEN_TEST_DPI_ALWAYS_EXACT");normalized.Dpi=144;n++;
        normalized.MonitorWork.Left++;Need(!SemanticWindowState(normalized,saved),"OFFSCREEN_TEST_AMBIGUOUS_WORKSPACE_ORIGIN_REFUSED");normalized.MonitorWork.Left--;n++;
        normalized.MonitorKnown=false;Need(!SemanticWindowState(normalized,saved),"OFFSCREEN_TEST_UNKNOWN_MONITOR_REFUSED");normalized.MonitorKnown=true;n++;
        normalized.Placement.Max=saved.Placement.Max;normalized.MonitorKnown=false;Need(SemanticWindowState(normalized,saved),"OFFSCREEN_TEST_UNSPECIFIED_MIN_CACHE_ONLY");n++;
        return D("ok",true,"selfTest",true,"checks",n,"uiAccessed",false,"inputSent",false,"clipboardAccessed",false,"windowMoved",false);
    }
    [STAThread]static int Main(string[] args){Console.OutputEncoding=new UTF8Encoding(false);try{if(args.Length==1&&args[0]=="--self-test"){Console.WriteLine(Json.Serialize(SelfTest()));return 0;}Need(args.Length==3&&(args[0]=="--inspect"||args[0]=="--probe-position"||args[0]=="--recover-position")&&args[1]=="--request","OFFSCREEN_ARGUMENTS_INVALID");SetProcessDpiAwarenessContext(new IntPtr(-4));bool mutation=args[0]!="--inspect";var b=Parse(Map(Json.DeserializeObject(File.ReadAllText(PathChecked(args[2])))),mutation);object report=args[0]=="--recover-position"?Recover(b):Run(b,mutation);Console.WriteLine(Json.Serialize(report));return Object.Equals(Get(Map(report),"ok"),true)?0:1;}catch(Exception error){Console.WriteLine(Json.Serialize(D("ok",false,"reason",Safe(error),"inputSent",false,"clipboardAccessed",false)));return 1;}}
    [DllImport("user32.dll")]static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")]static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")]static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")]static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")]static extern IntPtr GetAncestor(IntPtr window,uint flags);
    [DllImport("user32.dll")]static extern uint GetWindowThreadProcessId(IntPtr window,out uint pid);
    [DllImport("user32.dll")]static extern bool GetWindowRect(IntPtr window,out Rect rect);
    [DllImport("user32.dll")]static extern bool GetClientRect(IntPtr window,out Rect rect);
    [DllImport("user32.dll")]static extern bool ClientToScreen(IntPtr window,ref Point point);
    [DllImport("user32.dll")]static extern bool GetWindowPlacement(IntPtr window,ref Placement placement);
    [DllImport("user32.dll")]static extern bool SetWindowPlacement(IntPtr window,ref Placement placement);
    [DllImport("user32.dll")]static extern bool SetWindowPos(IntPtr window,IntPtr after,int x,int y,int width,int height,uint flags);
    [DllImport("user32.dll")]static extern uint GetDpiForWindow(IntPtr window);
    [DllImport("user32.dll")]static extern IntPtr MonitorFromWindow(IntPtr window,uint flags);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern bool GetMonitorInfo(IntPtr monitor,ref MonitorInfo info);
    [DllImport("user32.dll")]static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")]static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll")]static extern bool GetLastInputInfo(ref LastInput input);
    [DllImport("user32.dll")]static extern short GetAsyncKeyState(int key);
    [DllImport("kernel32.dll")]static extern uint GetCurrentProcessId();
    [DllImport("kernel32.dll")]static extern bool ProcessIdToSessionId(uint pid,out uint session);
    [DllImport("kernel32.dll")]static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
    [DllImport("kernel32.dll")]static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")]static extern bool GetProcessTimes(IntPtr process,out FileTime start,out FileTime exit,out FileTime kernel,out FileTime user);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode)]static extern bool QueryFullProcessImageName(IntPtr process,uint flags,StringBuilder file,ref int length);
    [DllImport("kernel32.dll")]static extern ulong GetTickCount64();
    [DllImport("dwmapi.dll")]static extern int DwmGetWindowAttribute(IntPtr window,uint attribute,out int value,int size);
}
