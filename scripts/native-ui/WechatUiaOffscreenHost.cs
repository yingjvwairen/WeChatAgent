// Production offscreen window ownership. No keyboard, mouse, clipboard or send API.
using System;
using System.IO;
using System.Text;
using System.Diagnostics;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Threading;
using System.Collections.Concurrent;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal static class WechatUiaOffscreenHost {
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

    sealed class Lease {internal Bound Bound;internal State Original,Owned,FocusPending;internal Rect Destination;internal string LastMutation;internal bool Recovery;}
    static string Root,JournalFile;static Lease Current;static bool Recalled,CleanupAttempted;static volatile bool Stopping;static int ParentPid;static long ParentCreated;static long CommandStarted;
    static readonly BlockingCollection<string> Commands=new BlockingCollection<string>(8);
    static readonly object OutputLock=new object();
    static void KeysReleased(){for(int key=1;key<256;key++)Need((GetAsyncKeyState(key)&0x8000)==0,"OFFSCREEN_KEYS_HELD");}
    // A console toggle is explicit window management, so its own recent click
    // does not require a new idle period. It still cannot cross an intervening
    // input, pointer or foreground change, or run while a key is held.
    static bool ParkActivityMatches(State before,uint tick,IntPtr foreground,Point cursor,uint now,bool explicitRequest){return tick==before.InputTick&&foreground==before.Foreground&&Same(cursor,before.Cursor)&&(explicitRequest||unchecked(now-tick)>=1000);}
    static void ParkActivityStable(State before,bool explicitRequest){var last=new LastInput{Size=(uint)Marshal.SizeOf(typeof(LastInput))};Point cursor;Need(GetLastInputInfo(ref last)&&GetCursorPos(out cursor)&&ParkActivityMatches(before,last.Time,GetForegroundWindow(),cursor,unchecked((uint)GetTickCount64()),explicitRequest),"OFFSCREEN_USER_ACTIVITY_CHANGED");KeysReleased();}
    static void Quiet(State before){ParkActivityStable(before,false);}
    static string ParkDeferral(bool explicitRequest,bool recalled,bool foregroundWechat,bool alreadyOutside){if(alreadyOutside)return "OFFSCREEN_ALREADY_OUTSIDE";if(!explicitRequest&&recalled)return "OFFSCREEN_USER_RECALL_PRESERVED";if(!explicitRequest&&foregroundWechat)return "OFFSCREEN_WECHAT_IN_USE";return null;}
    static bool SameBound(Bound a,Bound b){return a!=null&&b!=null&&a.Window==b.Window&&a.Pid==b.Pid&&a.Created==b.Created&&a.Executable.Equals(b.Executable,StringComparison.OrdinalIgnoreCase);}
    static Bound Parse(object value){
        var request=Map(value);Need(request.Count==5,"OFFSCREEN_REQUEST_INVALID");foreach(string key in request.Keys)Need(key=="version"||key=="hwnd"||key=="pid"||key=="processCreatedFileTimeUtc"||key=="executable","OFFSCREEN_REQUEST_INVALID");Need(Num(Get(request,"version"))==1,"OFFSCREEN_REQUEST_INVALID");
        var b=new Bound{Window=new IntPtr(DecimalId(Str(request,"hwnd"))),Pid=checked((uint)Num(Get(request,"pid"))),Created=DecimalId(Str(request,"processCreatedFileTimeUtc")),Executable=PathChecked(Str(request,"executable")),Root=Root,Journal=JournalFile,Request=request};
        Need(b.Pid>0&&b.Pid<=Int32.MaxValue&&(Path.GetFileName(b.Executable).Equals("Weixin.exe",StringComparison.OrdinalIgnoreCase)||Path.GetFileName(b.Executable).Equals("WeChat.exe",StringComparison.OrdinalIgnoreCase)),"OFFSCREEN_EXECUTABLE_INVALID");return b;
    }
    static void TargetVersion(Bound b){Need(FileVersionInfo.GetVersionInfo(b.Executable).FileVersion=="4.1.15.56","OFFSCREEN_EXECUTABLE_INVALID");}
    static string Safe(Exception error){return error is InvalidOperationException&&error.Message.StartsWith("OFFSCREEN_",StringComparison.Ordinal)?error.Message:"OFFSCREEN_OPERATION_FAILED";}
    static bool Terminal(string phase){return phase=="restored"||phase=="ownership-lost";}
    static void ArchiveJournal(){if(File.Exists(JournalFile)){string archive=Path.Combine(Path.GetDirectoryName(JournalFile),"completed-"+Guid.NewGuid().ToString("N")+".jsonl");File.Move(JournalFile,archive);}}
    static void LoadJournal(){
        Current=null;if(!File.Exists(JournalFile))return;Need(new FileInfo(JournalFile).Length<=262144,"OFFSCREEN_JOURNAL_INVALID");byte[] bytes=File.ReadAllBytes(JournalFile);int complete=JournalPrefix(bytes);Need(complete>0,"OFFSCREEN_JOURNAL_INVALID");
        string[] lines=new UTF8Encoding(false,true).GetString(bytes,0,complete).TrimEnd('\n','\r').Split('\n');var first=Map(Json.DeserializeObject(lines[0]));Need(Str(first,"kind")=="uia-offscreen-host-v1"&&Num(Get(first,"version"))==1,"OFFSCREEN_JOURNAL_INVALID");
        var lease=new Lease{Bound=Parse(Get(first,"request")),Original=S(Get(first,"before")),Destination=R(Get(first,"destination")),Recovery=true};
        foreach(string line in lines){var row=Map(Json.DeserializeObject(line));lease.LastMutation=Str(row,"phase");if(Get(row,"owned")!=null)lease.Owned=S(Get(row,"owned"));if(Get(row,"focusBaseline")!=null)lease.FocusPending=S(Get(row,"focusBaseline"));}
        if(Terminal(lease.LastMutation))return;
        // Retain a torn tail until a later explicit mutation command holds the
        // input lock. Startup and inspect never write or move any window.
        Current=lease;
    }
    static void RepairJournalTail(){
        if(!File.Exists(JournalFile))return;byte[] bytes=File.ReadAllBytes(JournalFile);int complete=JournalPrefix(bytes);Need(complete>0,"OFFSCREEN_JOURNAL_INVALID");if(complete==bytes.Length)return;
        using(var file=new FileStream(JournalFile,FileMode.Open,FileAccess.ReadWrite,FileShare.Read)){Need(file.Length==bytes.Length,"OFFSCREEN_JOURNAL_CHANGED");for(int i=0;i<bytes.Length;i++)Need(file.ReadByte()==bytes[i],"OFFSCREEN_JOURNAL_CHANGED");file.SetLength(complete);file.Flush(true);}
    }
    static bool OwnedAt(Lease lease,State state){return lease.Owned!=null?SameWindowState(state,lease.Owned):PreparedLease(state,lease.Original,lease.Destination);}
    static bool RecoverPositionBoundary(Lease lease,State state){
        if(lease.LastMutation!="restoring-position"||lease.Owned==null||!Same(state.Outer,lease.Original.Outer)||!Same(state.Client,lease.Original.Client)||state.Dpi!=lease.Original.Dpi||state.Placement.Show!=lease.Owned.Placement.Show)return false;
        Placement expected=lease.Owned.Placement;int dx=lease.Original.Outer.Left-lease.Owned.Outer.Left,dy=lease.Original.Outer.Top-lease.Owned.Outer.Top;expected.Normal=new Rect(checked(expected.Normal.Left+dx),checked(expected.Normal.Top+dy),checked(expected.Normal.Right+dx),checked(expected.Normal.Bottom+dy));
        return Same(state.Placement,expected)||Same(state.Placement,lease.Original.Placement);
    }
    static object BindingReport(Bound b,State state){return b==null||state==null?null:D("hwnd",b.Window.ToInt64().ToString(CultureInfo.InvariantCulture),"pid",b.Pid,"processCreatedFileTimeUtc",b.Created.ToString(CultureInfo.InvariantCulture),"dpi",state.Dpi,"clientRect",state.Client.Report(),"captureRect",state.ClientScreen.Report());}
    static object Result(string action,string state,Bound bound,State snapshot,bool moved,bool restored,string reason,bool foregroundChanged=false,bool eligible=false){return D("version",1,"action",action,"state",state,"parked",state=="parked","restored",restored,"released",Current==null,"parkEligible",eligible,"windowMoved",moved,"inputSent",false,"clipboardAccessed",false,"foregroundChanged",foregroundChanged,"reason",reason,"binding",BindingReport(bound,snapshot),"journalPath",JournalFile);}
    static bool Eligible(Bound b,State state){if(Recalled||Current!=null||state.ForegroundPid==b.Pid||Outside(state.Outer,Screens()))return false;try{Quiet(state);return true;}catch{return false;}}
    static object Inspect(string action,Bound b){
        b=b??(Current==null?null:Current.Bound);if(b==null)return Result(action,"visible",null,null,false,false,null);
        State state;try{state=Snapshot(b);}catch(Exception error){if(Current!=null&&SameBound(b,Current.Bound))return Result(action,"ownership-lost",b,null,false,false,Safe(error));throw;}
        if(Current!=null&&!SameBound(b,Current.Bound))return Result(action,"deferred",b,state,false,false,"OFFSCREEN_RECOVERY_REQUIRED");
        if(Current!=null&&SameBound(b,Current.Bound)){
            if(OwnedAt(Current,state)&&Outside(state.Outer,Screens()))return Result(action,"parked",b,state,false,false,null);
            if(Current.Recovery||RecoverPositionBoundary(Current,state)||SemanticWindowState(state,Current.Original))return Result(action,"deferred",b,state,false,false,"OFFSCREEN_RECOVERY_REQUIRED");
            return Result(action,"ownership-lost",b,state,false,false,"OFFSCREEN_WINDOW_MOVED_BY_USER");
        }
        // Screen position is independent of ownership. A user-positioned
        // window is usable by UIA but is never adopted as our restoration lease.
        if(Outside(state.Outer,Screens()))return Result(action,"deferred",b,state,false,false,"OFFSCREEN_ALREADY_OUTSIDE");
        return Result(action,"visible",b,state,false,false,Recalled?"OFFSCREEN_USER_RECALL_PRESERVED":null,false,Eligible(b,state));
    }
    static T WithInput<T>(Func<T> work,int waitMs,bool recovery){using(var gate=new Mutex(false,"Local\\WeChatAgent.UiInput.v1")){bool held=false;try{try{held=gate.WaitOne(waitMs);}catch(AbandonedMutexException){held=true;Need(recovery,"OFFSCREEN_INPUT_LOCK_ABANDONED");}Need(held,"OFFSCREEN_INPUT_MUTEX_BUSY");return work();}finally{if(held)gate.ReleaseMutex();}}}
    static void ReleaseOwned(string phase,string reason){var old=Current;if(old!=null){Journal(old.Bound,D("phase",phase,"reason",reason));Current=null;}}
    static object RestoreCurrent(string action){
        if(Current==null)return Result(action,"restored",null,null,false,true,null);
        RepairJournalTail();var lease=Current;State current;
        try{current=Snapshot(lease.Bound);}catch(Exception error){
            // A new PID/creation, minimized/hidden window or removed HWND is
            // outside this lease. Never reopen or move its replacement.
            string reason=Safe(error);if(reason=="OFFSCREEN_SNAPSHOT_FAILED"||reason=="OFFSCREEN_FOREGROUND_UNAVAILABLE"||reason=="OFFSCREEN_PROCESS_UNAVAILABLE")throw;
            Recalled=true;ReleaseOwned("ownership-lost",reason);return Result(action,"ownership-lost",lease.Bound,null,false,false,reason);
        }
        if(RecoverPositionBoundary(lease,current))lease.Owned=current;
        if(!SemanticWindowState(current,lease.Original)&&!OwnedAt(lease,current)){Recalled=true;ReleaseOwned("ownership-lost","OFFSCREEN_WINDOW_MOVED_BY_USER");return Result(action,"ownership-lost",lease.Bound,current,false,false,"OFFSCREEN_WINDOW_MOVED_BY_USER");}
        if(lease.FocusPending!=null&&SemanticWindowState(current,lease.Original)&&current.Foreground!=lease.FocusPending.Foreground&&MayReturnForeground(current,lease.FocusPending,lease.Bound.Window,ForegroundIdentity(lease.FocusPending))){Need(SetForegroundWindow(lease.FocusPending.Foreground),"OFFSCREEN_FOREGROUND_RESTORE_UNCONFIRMED");current=Snapshot(lease.Bound);Need(current.Foreground==lease.FocusPending.Foreground,"OFFSCREEN_FOREGROUND_RESTORE_UNCONFIRMED");}
        var restore=Map(Restore(lease.Bound,lease.Original,lease.Owned,lease.Destination,true));
        if(!Object.Equals(Get(restore,"restored"),true)){LoadJournal();throw new InvalidOperationException("OFFSCREEN_RESTORE_UNCONFIRMED");}
        var after=Snapshot(lease.Bound);bool moved=Object.Equals(Get(restore,"positionApplied"),true)||Object.Equals(Get(restore,"placementApplied"),true);ReleaseOwned("restored","restored");return Result(action,"restored",lease.Bound,after,moved,true,null,after.Foreground!=current.Foreground);
    }
    static object Park(Bound b,bool explicitRequest=false){
        TargetVersion(b);string action=explicitRequest?"park-explicit":"park";
        if(Current!=null&&!Current.Recovery&&SameBound(Current.Bound,b)){
            var inspected=Map(Inspect(action,b));if(Object.Equals(Get(inspected,"parked"),true))return inspected;
        }
        return WithInput(delegate{
            if(Current!=null){var old=Map(RestoreCurrent("restore"));Need(Object.Equals(Get(old,"released"),true),"OFFSCREEN_RECOVERY_REQUIRED");}
            State before=Snapshot(b);string reason=ParkDeferral(explicitRequest,Recalled,before.ForegroundPid==b.Pid,Outside(before.Outer,Screens()));
            if(reason!=null)return Result(action,"deferred",b,before,false,false,reason);
            try{ParkActivityStable(before,explicitRequest);}catch(Exception error){return Result(action,"deferred",b,before,false,false,Safe(error));}
            if(explicitRequest)Recalled=false;
            Rect destination=Destination(before.Outer,Screens());ArchiveJournal();Journal(b,D("version",1,"kind","uia-offscreen-host-v1","phase","prepared","ownerPid",GetCurrentProcessId(),"ownerCreated",ProcessCreated(GetCurrentProcessId()).ToString(CultureInfo.InvariantCulture),"request",b.Request,"before",before.Report(),"destination",destination.Report()),true);
            Current=new Lease{Bound=b,Original=before,Destination=destination,LastMutation="prepared"};bool attempted=false;
            try{
                State check=Snapshot(b);Need(SameWindowState(check,before),"OFFSCREEN_WINDOW_CHANGED");ParkActivityStable(before,explicitRequest);
                Need(!Stopping&&ParentAlive(),"OFFSCREEN_CANCELLED");
                attempted=true;Need(SetWindowPos(b.Window,IntPtr.Zero,destination.Left,destination.Top,0,0,0x0001|0x0004|0x0010|0x0200),"OFFSCREEN_MOVE_FAILED");State after=Snapshot(b);
                if(SameUser(before,after))Current.Owned=after;Journal(b,D("phase","moved","owned",Current.Owned==null?null:after.Report()));Current.LastMutation="moved";
                Need(Same(after.Outer,destination)&&Same(after.Client,before.Client)&&after.Dpi==before.Dpi&&after.Placement.Show==before.Placement.Show,"OFFSCREEN_AUTOMATIC_GEOMETRY_CHANGED");Need(Outside(after.Outer,Screens()),"OFFSCREEN_MOVE_UNCONFIRMED");Need(SameUser(before,after),"OFFSCREEN_USER_ACTIVITY_CHANGED");
                return Result(action,"parked",b,after,true,false,null);
            }catch{if(attempted){try{RestoreCurrent("restore");}catch{}}else ReleaseOwned("restored","not-moved");throw;}
        },0,true);
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
        State focusBaseline=current;
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
                KeysReleased();
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

    static bool ParentAlive(){IntPtr process=IntPtr.Zero;try{process=OpenProcess(0x1000,false,(uint)ParentPid);uint code;FileTime start,exit,kernel,user;return process!=IntPtr.Zero&&GetExitCodeProcess(process,out code)&&code==259&&GetProcessTimes(process,out start,out exit,out kernel,out user)&&start.Value==ParentCreated;}catch{return false;}finally{if(process!=IntPtr.Zero)CloseHandle(process);}}
    static void Write(object value){lock(OutputLock){Console.WriteLine(Json.Serialize(value));Console.Out.Flush();}}
    static string ReadBounded(){var text=new StringBuilder();for(;;){int c=Console.In.Read();if(c<0){Need(text.Length==0,"OFFSCREEN_REQUEST_TRUNCATED");return null;}if(c=='\n')return text.ToString();Need(text.Length<16384,"OFFSCREEN_REQUEST_TOO_LARGE");text.Append((char)c);}}
    static void ReadRequests(){try{for(;;){string line=ReadBounded();if(line==null)break;if(!Commands.TryAdd(line,1000))throw new InvalidOperationException("OFFSCREEN_REQUEST_QUEUE_FULL");}}catch{Stopping=true;}finally{Stopping=true;Commands.CompleteAdding();}}
    static object Handle(Dictionary<string,object> request){
        foreach(string key in request.Keys)Need(key=="id"||key=="action"||key=="binding","OFFSCREEN_REQUEST_INVALID");Need(Get(request,"id") is string&&Str(request,"id").Length<=128,"OFFSCREEN_REQUEST_INVALID");string action=Str(request,"action");Need(action=="inspect"||action=="park"||action=="park-explicit"||action=="restore"||action=="stop"||action=="handoff-offline","OFFSCREEN_ACTION_INVALID");
        if(action=="inspect")return Inspect(action,Get(request,"binding")==null?null:Parse(Get(request,"binding")));
        if(action=="handoff-offline"){
            Need(!request.ContainsKey("binding")&&Current!=null,"OFFSCREEN_HANDOFF_UNAVAILABLE");
            return WithInput(delegate{
                var lease=Current;
                var state=Snapshot(lease.Bound);
                Need(OwnedAt(lease,state)&&Outside(state.Outer,Screens()),"OFFSCREEN_HANDOFF_UNAVAILABLE");
                var handoff=Result(action,"parked",lease.Bound,state,false,false,null);
                // Flush the recovery record before releasing the host. A later
                // console or service can recall this exact window and placement.
                Journal(lease.Bound,D("phase","offline-parked","owned",state.Report()));
                Current=null;
                return handoff;
            },0,true);
        }
        if(action=="park"||action=="park-explicit"){Need(Get(request,"binding")!=null,"OFFSCREEN_BINDING_REQUIRED");return Park(Parse(Get(request,"binding")),action=="park-explicit");}
        Need(!request.ContainsKey("binding"),"OFFSCREEN_REQUEST_INVALID");var result=Current==null?RestoreCurrent(action):WithInput(delegate{return RestoreCurrent(action);},3000,true);if(action=="stop")Stopping=true;return result;
    }
    static void Cleanup(){CleanupAttempted=true;if(Current==null)return;try{WithInput(delegate{return RestoreCurrent("stop");},3000,true);}catch(Exception error){try{RestoreJournal(Current.Bound,D("phase","recovery-required","reason",Safe(error)));}catch{}}}
    static object HostSelfTest(){
        var result=Map(SelfTest());int n=(int)result["checks"];
        Need(Terminal("restored")&&Terminal("ownership-lost")&&!Terminal("moved")&&!Terminal("recovery-required"),"OFFSCREEN_TEST_JOURNAL_TERMINAL");n++;
        var a=new Bound{Window=new IntPtr(1),Pid=2,Created=3,Executable=@"C:\Weixin.exe"};var b=new Bound{Window=a.Window,Pid=a.Pid,Created=a.Created,Executable=@"c:\weixin.exe"};Need(SameBound(a,b),"OFFSCREEN_TEST_BOUND_IDENTITY");n++;
        b.Created++;Need(!SameBound(a,b),"OFFSCREEN_TEST_PID_REUSE");b.Created--;b.Window=new IntPtr(2);Need(!SameBound(a,b),"OFFSCREEN_TEST_HWND_REUSE");n+=2;
        var original=new State{Outer=new Rect(100,100,900,700),Client=new Rect(0,0,780,560),ClientScreen=new Rect(110,130,890,690),Dpi=96,Placement=new Placement{Show=1,Normal=new Rect(100,100,900,700)}};
        var owned=new State{Outer=new Rect(2000,100,2800,700),Client=original.Client,ClientScreen=new Rect(2010,130,2790,690),Dpi=96,Placement=new Placement{Show=1,Normal=new Rect(2000,100,2800,700)}};
        var lease=new Lease{Original=original,Owned=owned,Destination=owned.Outer,LastMutation="restoring-position"};
        Need(OwnedAt(lease,owned)&&RecoverPositionBoundary(lease,original),"OFFSCREEN_TEST_EXACT_ROLLBACK_BOUNDARY");n++;
        var altered=new State{Outer=original.Outer,Client=original.Client,ClientScreen=original.ClientScreen,Dpi=original.Dpi,Placement=original.Placement};altered.Placement.Normal.Left++;Need(!RecoverPositionBoundary(lease,altered),"OFFSCREEN_TEST_ROLLBACK_CANNOT_ADOPT_USER_PLACEMENT");n++;
        owned.Placement.Show=3;Need(!RecoverPositionBoundary(lease,original),"OFFSCREEN_TEST_ROLLBACK_SHOW_CHANGED");owned.Placement.Show=1;n++;
        Current=null;var report=Map(Result("inspect","visible",a,original,false,false,null,false,true));Need(Object.Equals(report["released"],true)&&Object.Equals(report["parkEligible"],true)&&Object.Equals(report["inputSent"],false)&&Object.Equals(report["clipboardAccessed"],false)&&Object.Equals(report["windowMoved"],false),"OFFSCREEN_TEST_READONLY_REPORT");n++;
        Current=lease;report=Map(Result("park","parked",a,owned,true,false,null));Need(Object.Equals(report["released"],false)&&Object.Equals(report["parked"],true)&&!Object.Equals(report["restored"],true),"OFFSCREEN_TEST_PARK_NOT_RESTORE");Current=null;n++;
        var multi=new List<Rect>{new Rect(-6000,-4000,-2000,0),new Rect(-2000,-1000,0,1000),new Rect(0,0,7680,4320)};var destination=Destination(new Rect(-3000,-3000,-2200,-2400),multi);Need(Outside(destination,multi),"OFFSCREEN_TEST_NO_FIXED_NEGATIVE_POINT");n++;
        var activity=new State{InputTick=100,Foreground=new IntPtr(99),Cursor=new Point(20,30)};
        Need(ParkActivityMatches(activity,100,activity.Foreground,activity.Cursor,105,true)&&!ParkActivityMatches(activity,100,activity.Foreground,activity.Cursor,105,false),"OFFSCREEN_TEST_EXPLICIT_TOGGLE_OWN_CLICK_NEEDS_NO_IDLE_DELAY");n++;
        Need(ParkActivityMatches(activity,100,activity.Foreground,activity.Cursor,1100,false),"OFFSCREEN_TEST_AUTOMATIC_PARK_RETAINS_IDLE_DELAY");n++;
        foreach(bool explicitRequest in new[]{false,true}){
            Need(!ParkActivityMatches(activity,101,activity.Foreground,activity.Cursor,1200,explicitRequest),"OFFSCREEN_TEST_EXPLICIT_NEVER_BYPASSES_NEW_INPUT");n++;
            Need(!ParkActivityMatches(activity,100,new IntPtr(100),activity.Cursor,1200,explicitRequest),"OFFSCREEN_TEST_EXPLICIT_NEVER_BYPASSES_FOREGROUND_CHANGE");n++;
            Need(!ParkActivityMatches(activity,100,activity.Foreground,new Point(21,30),1200,explicitRequest),"OFFSCREEN_TEST_EXPLICIT_NEVER_BYPASSES_CURSOR_CHANGE");n++;
        }
        Need(ParkDeferral(true,true,true,false)==null&&ParkDeferral(false,false,true,false)=="OFFSCREEN_WECHAT_IN_USE"&&ParkDeferral(false,true,false,false)=="OFFSCREEN_USER_RECALL_PRESERVED","OFFSCREEN_TEST_EXPLICIT_INTENT_CAN_HIDE_FOREGROUND_OR_RECALLED_WINDOW");n++;
        Need(ParkDeferral(true,true,true,true)=="OFFSCREEN_ALREADY_OUTSIDE"&&ParkDeferral(false,false,false,true)=="OFFSCREEN_ALREADY_OUTSIDE","OFFSCREEN_TEST_MANUAL_OUTSIDE_IS_NEVER_ADOPTED");n++;
        Current=null;report=Map(Result("park-explicit","deferred",a,owned,false,false,"OFFSCREEN_ALREADY_OUTSIDE"));Need(Object.Equals(report["released"],true)&&Object.Equals(report["parked"],false)&&Object.Equals(report["windowMoved"],false)&&Object.Equals(report["action"],"park-explicit"),"OFFSCREEN_TEST_EXPLICIT_MANUAL_POSITION_ACK_HAS_NO_LEASE");n++;
        result["checks"]=n;return result;
    }
    [STAThread]static int Main(string[] args){
        Console.InputEncoding=new UTF8Encoding(false);Console.OutputEncoding=new UTF8Encoding(false);Mutex hostGate=null;bool held=false;
        try{
            if(args.Length==1&&args[0]=="--self-test"){Write(HostSelfTest());return 0;}
            Need(args.Length==5&&args[0]=="--host"&&args[1]=="--root"&&args[3]=="--parent-pid","OFFSCREEN_ARGUMENTS_INVALID");Root=PathChecked(args[2]).TrimEnd('\\');ParentPid=checked((int)DecimalId(args[4]));Need(ParentPid!=GetCurrentProcessId(),"OFFSCREEN_PARENT_INVALID");ParentCreated=ProcessCreated((uint)ParentPid);
            string own=PathChecked(System.Reflection.Assembly.GetExecutingAssembly().Location);Need(own.Equals(Path.Combine(Root,"state","ui-host","WechatUiaOffscreenHost.exe"),StringComparison.OrdinalIgnoreCase)&&File.Exists(Path.Combine(Root,"scripts","ui-service.mjs")),"OFFSCREEN_WORKSPACE_BINDING_INVALID");
            string directory=PathChecked(Path.Combine(Root,"state","ui-offscreen"));Directory.CreateDirectory(directory);JournalFile=PathChecked(Path.Combine(directory,"active.jsonl"));
            hostGate=new Mutex(false,"Local\\WeChatAgent.UiOffscreenHost.v1");try{held=hostGate.WaitOne(0);}catch(AbandonedMutexException){held=true;}Need(held,"OFFSCREEN_HOST_ALREADY_RUNNING");
            Need(SetProcessDpiAwarenessContext(new IntPtr(-4)),"OFFSCREEN_DPI_UNAVAILABLE");LoadJournal();
            Write(D("version",1,"ready",true,"backend","uia-offscreen","inputSent",false,"clipboardAccessed",false));var reader=new Thread(ReadRequests){IsBackground=true};reader.Start();
            using(var watchdog=new System.Threading.Timer(delegate{long started=Interlocked.Read(ref CommandStarted);if(started>0&&(long)GetTickCount64()-started>8000)Environment.Exit(124);},null,500,500)){
                while(!Stopping&&ParentAlive()){
                    string line;if(!Commands.TryTake(out line,100)){if(Commands.IsCompleted)break;continue;}object id=null;Interlocked.Exchange(ref CommandStarted,(long)GetTickCount64());
                    try{var request=Map(Json.DeserializeObject(line));id=Get(request,"id");Need(ParentAlive(),"OFFSCREEN_PARENT_EXITED");Write(D("id",id,"ok",true,"result",Handle(request)));}
                    catch(Exception error){Write(D("id",id,"ok",false,"error",D("code",Safe(error))));}
                    finally{Interlocked.Exchange(ref CommandStarted,0);}
                }
                Interlocked.Exchange(ref CommandStarted,(long)GetTickCount64());Cleanup();Interlocked.Exchange(ref CommandStarted,0);
            }
            return Current==null?0:1;
        }catch(Exception error){try{Write(D("id",null,"ok",false,"error",D("code",Safe(error))));}catch{}return 1;}
        finally{
            // A parent can disappear between a completed move and writing its
            // acknowledgment. Broken stdout must take the same rollback path
            // as stdin EOF; only a bounded cleanup is attempted once.
            if(held&&!CleanupAttempted&&Current!=null){using(var cleanupWatchdog=new System.Threading.Timer(delegate{Environment.Exit(124);},null,8000,Timeout.Infinite)){Cleanup();}}
            if(hostGate!=null){if(held)hostGate.ReleaseMutex();hostGate.Dispose();}
        }
    }
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
    [DllImport("kernel32.dll")]static extern bool GetExitCodeProcess(IntPtr process,out uint code);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode)]static extern bool QueryFullProcessImageName(IntPtr process,uint flags,StringBuilder file,ref int length);
    [DllImport("kernel32.dll")]static extern ulong GetTickCount64();
    [DllImport("dwmapi.dll")]static extern int DwmGetWindowAttribute(IntPtr window,uint attribute,out int value,int size);
}
