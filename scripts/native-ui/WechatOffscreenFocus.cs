// One-shot, bounded child for an offscreen-only foreground fallback. No input
// events, pointer movement, clipboard or target-process writes are performed.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal static class WechatOffscreenFocus {
    static readonly JavaScriptSerializer Json=new JavaScriptSerializer{MaxJsonLength=16384};
    [StructLayout(LayoutKind.Sequential)]struct Point {internal int X,Y;}
    [StructLayout(LayoutKind.Sequential)]struct Rect {internal int Left,Top,Right,Bottom;}
    [StructLayout(LayoutKind.Sequential)]struct FileTime {internal uint Low,High;internal long Value{get{return ((long)High<<32)|Low;}}}
    [StructLayout(LayoutKind.Sequential)]struct LastInput {internal uint Size,Time;}
    [StructLayout(LayoutKind.Sequential)]struct Message {internal IntPtr Window;internal uint Id;internal UIntPtr WParam;internal IntPtr LParam;internal uint Time;internal Point Point;internal uint Private;}
    [StructLayout(LayoutKind.Sequential)]struct GuiInfo {internal uint Size,Flags;internal IntPtr Active,Focus,Capture,MenuOwner,MoveSize,Caret;internal Rect CaretRect;}
    sealed class Identity {internal IntPtr Window;internal uint Pid,Thread;internal long Created;}
    static void Need(bool value,string code){if(!value)throw new InvalidOperationException(code);}
    static Dictionary<string,object> D(params object[] values){var result=new Dictionary<string,object>();for(int i=0;i<values.Length;i+=2)result.Add((string)values[i],values[i+1]);return result;}
    static Dictionary<string,object> Map(object value){var d=value as Dictionary<string,object>;Need(d!=null,"OFFSCREEN_FOCUS_REQUEST_INVALID");return d;}
    static object G(Dictionary<string,object> value,string key){object result;Need(value.TryGetValue(key,out result),"OFFSCREEN_FOCUS_REQUEST_INVALID");return result;}
    static long N(object value){Need(value!=null&&!(value is bool)&&!(value is string),"OFFSCREEN_FOCUS_REQUEST_INVALID");decimal n=Convert.ToDecimal(value,CultureInfo.InvariantCulture);Need(n==Decimal.Truncate(n)&&n>=Int64.MinValue&&n<=Int64.MaxValue,"OFFSCREEN_FOCUS_REQUEST_INVALID");return (long)n;}
    static long Id(object value){long n;Need(value is string&&Int64.TryParse((string)value,NumberStyles.None,CultureInfo.InvariantCulture,out n)&&n>0,"OFFSCREEN_FOCUS_REQUEST_INVALID");return Int64.Parse((string)value,CultureInfo.InvariantCulture);}
    static Identity I(object value){var d=Map(value);Need(d.Count==4,"OFFSCREEN_FOCUS_REQUEST_INVALID");return new Identity{Window=new IntPtr(Id(G(d,"hwnd"))),Pid=checked((uint)N(G(d,"pid"))),Thread=checked((uint)N(G(d,"threadId"))),Created=Id(G(d,"processCreatedFileTimeUtc"))};}
    static Rect R(object value){var d=Map(value);Need(d.Count==4,"OFFSCREEN_FOCUS_REQUEST_INVALID");return new Rect{Left=checked((int)N(G(d,"left"))),Top=checked((int)N(G(d,"top"))),Right=checked((int)N(G(d,"right"))),Bottom=checked((int)N(G(d,"bottom")))};}
    static bool Same(Rect a,Rect b){return a.Left==b.Left&&a.Top==b.Top&&a.Right==b.Right&&a.Bottom==b.Bottom;}
    static bool Intersects(Rect a,Rect b){return a.Left<b.Right&&b.Left<a.Right&&a.Top<b.Bottom&&b.Top<a.Bottom;}
    static bool Outside(Rect rect,IEnumerable<Rect> displays){int count=0;foreach(var display in displays){count++;if(Intersects(rect,display))return false;}return count>0&&rect.Right>rect.Left&&rect.Bottom>rect.Top;}
    static List<Rect> Displays(){var result=new List<Rect>();foreach(Screen screen in Screen.AllScreens){var b=screen.Bounds;result.Add(new Rect{Left=b.Left,Top=b.Top,Right=b.Right,Bottom=b.Bottom});}return result;}
    static string ObjectName(IntPtr handle){uint size;GetUserObjectInformation(handle,2,IntPtr.Zero,0,out size);Need(size>0&&size<4096,"OFFSCREEN_FOCUS_DESKTOP_INVALID");IntPtr memory=Marshal.AllocHGlobal((int)size);try{Need(GetUserObjectInformation(handle,2,memory,size,out size),"OFFSCREEN_FOCUS_DESKTOP_INVALID");return Marshal.PtrToStringUni(memory);}finally{Marshal.FreeHGlobal(memory);}}
    static void ProcessIdentity(uint pid,long expected,string executable){IntPtr process=OpenProcess(0x1000,false,pid);Need(process!=IntPtr.Zero,"OFFSCREEN_FOCUS_PROCESS_CHANGED");try{FileTime start,exit,kernel,user;uint code;Need(GetExitCodeProcess(process,out code)&&code==259&&GetProcessTimes(process,out start,out exit,out kernel,out user)&&start.Value==expected,"OFFSCREEN_FOCUS_PROCESS_CHANGED");if(executable!=null){var file=new StringBuilder(32768);int length=file.Capacity;Need(QueryFullProcessImageName(process,0,file,ref length)&&Path.GetFullPath(file.ToString()).Equals(executable,StringComparison.OrdinalIgnoreCase),"OFFSCREEN_FOCUS_PROCESS_CHANGED");}}finally{CloseHandle(process);}}
    static void WindowIdentity(Identity identity,string executable){uint pid=0,session,own;Need(identity.Pid>0&&identity.Thread>0&&IsWindow(identity.Window)&&IsWindowVisible(identity.Window)&&!IsIconic(identity.Window)&&IsWindowEnabled(identity.Window)&&GetAncestor(identity.Window,2)==identity.Window&&GetWindowThreadProcessId(identity.Window,out pid)==identity.Thread&&pid==identity.Pid,"OFFSCREEN_FOCUS_WINDOW_CHANGED");Need(ProcessIdToSessionId(pid,out session)&&ProcessIdToSessionId(GetCurrentProcessId(),out own)&&session==own,"OFFSCREEN_FOCUS_SESSION_CHANGED");ProcessIdentity(pid,identity.Created,executable);Need(ObjectName(GetThreadDesktop(identity.Thread))=="Default","OFFSCREEN_FOCUS_DESKTOP_INVALID");var gui=new GuiInfo{Size=(uint)Marshal.SizeOf(typeof(GuiInfo))};Need(GetGUIThreadInfo(identity.Thread,ref gui)&&(gui.Flags&0x1e)==0&&gui.Capture==IntPtr.Zero,"OFFSCREEN_FOCUS_MODAL_CHANGED");}
    static void Keys(){for(int key=1;key<256;key++)Need((GetAsyncKeyState(key)&0x8000)==0,"OFFSCREEN_FOCUS_KEYS_HELD");}
    static bool DeadlineValid(long now,long deadline){return deadline>=now&&deadline-now<=500;}
    static void AttachedOnce(Action guard,Func<bool> attachSource,Func<bool> attachOwn,Action activate,Func<bool> detachOwn,Func<bool> detachSource){
        bool source=false,own=false;try{guard();if(attachSource!=null){source=attachSource();Need(source,"OFFSCREEN_FOCUS_ATTACH_FAILED");}guard();if(attachOwn!=null){own=attachOwn();Need(own,"OFFSCREEN_FOCUS_ATTACH_FAILED");}guard();activate();}
        finally{bool detached=true;if(own)detached=detachOwn()&&detached;if(source)detached=detachSource()&&detached;Need(detached,"OFFSCREEN_FOCUS_DETACH_FAILED");}
    }
    static void HelperQueuesOnce(uint helper,uint source,uint target,Action guard,Func<uint,uint,bool,bool> change,Action activate){
        Need(helper!=0&&source!=0&&target!=0&&helper!=source&&helper!=target&&source!=target,"OFFSCREEN_FOCUS_THREAD_INVALID");
        // Both attachment edges include this disposable helper thread. Never
        // directly link the two external UI threads: killing the helper must
        // not leave an attachment between two surviving application threads.
        AttachedOnce(guard,delegate{return change(helper,source,true);},delegate{return change(helper,target,true);},activate,delegate{return change(helper,target,false);},delegate{return change(helper,source,false);});
    }
    static object Run(Dictionary<string,object> request){
        Need(request.Count==10&&N(G(request,"version"))==1,"OFFSCREEN_FOCUS_REQUEST_INVALID");string nonce=G(request,"nonce") as string;Guid id;Need(nonce!=null&&Guid.TryParseExact(nonce,"N",out id),"OFFSCREEN_FOCUS_REQUEST_INVALID");var source=I(G(request,"source"));var target=I(G(request,"target"));Need(source.Window!=target.Window&&source.Pid!=target.Pid,"OFFSCREEN_FOCUS_REQUEST_INVALID");
        string executable=Path.GetFullPath((string)G(request,"executable"));Need((Path.GetFileName(executable).Equals("Weixin.exe",StringComparison.OrdinalIgnoreCase)||Path.GetFileName(executable).Equals("WeChat.exe",StringComparison.OrdinalIgnoreCase))&&FileVersionInfo.GetVersionInfo(executable).FileVersion=="4.1.15.56","OFFSCREEN_FOCUS_EXECUTABLE_INVALID");
        var parent=Map(G(request,"parent"));Need(parent.Count==2,"OFFSCREEN_FOCUS_REQUEST_INVALID");uint parentPid=checked((uint)N(G(parent,"pid")));long parentCreated=Id(G(parent,"processCreatedFileTimeUtc"));uint tick=checked((uint)N(G(request,"inputTick")));var point=Map(G(request,"cursor"));Need(point.Count==2,"OFFSCREEN_FOCUS_REQUEST_INVALID");Point cursor=new Point{X=checked((int)N(G(point,"x"))),Y=checked((int)N(G(point,"y")))};Rect bounds=R(G(request,"targetRect"));long deadline=N(G(request,"deadlineTickMs"));Need(DeadlineValid((long)GetTickCount64(),deadline),"OFFSCREEN_FOCUS_EXPIRED");
        Need(ObjectName(GetThreadDesktop(GetCurrentThreadId()))=="Default"&&ObjectName(GetProcessWindowStation())=="WinSta0","OFFSCREEN_FOCUS_DESKTOP_INVALID");IntPtr desktop=OpenInputDesktop(0,false,0x0001);Need(desktop!=IntPtr.Zero,"OFFSCREEN_FOCUS_DESKTOP_INVALID");try{Need(ObjectName(desktop)=="Default","OFFSCREEN_FOCUS_DESKTOP_INVALID");}finally{CloseDesktop(desktop);}
        Action guard=delegate{Need((long)GetTickCount64()<=deadline,"OFFSCREEN_FOCUS_EXPIRED");ProcessIdentity(parentPid,parentCreated,null);WindowIdentity(source,null);WindowIdentity(target,executable);Rect actual;Need(GetWindowRect(target.Window,out actual)&&Same(actual,bounds)&&Outside(actual,Displays()),"OFFSCREEN_FOCUS_TARGET_NOT_OFFSCREEN");Point p;var input=new LastInput{Size=(uint)Marshal.SizeOf(typeof(LastInput))};Need(GetLastInputInfo(ref input)&&input.Time==tick&&GetCursorPos(out p)&&p.X==cursor.X&&p.Y==cursor.Y&&GetForegroundWindow()==source.Window,"OFFSCREEN_FOCUS_ACTIVITY_CHANGED");Keys();};
        guard();Message message;PeekMessage(out message,IntPtr.Zero,0,0,0);uint ownThread=GetCurrentThreadId();bool attempted=false,accepted=false;
        HelperQueuesOnce(ownThread,source.Thread,target.Thread,guard,AttachThreadInput,delegate{attempted=true;accepted=SetForegroundWindow(target.Window);});
        return D("version",1,"nonce",nonce,"attempted",attempted,"accepted",accepted,"activated",GetForegroundWindow()==target.Window,"inputSent",false,"clipboardAccessed",false);
    }
    static object SelfTest(){int n=0;var displays=new[]{new Rect{Left=-1920,Top=0,Right=0,Bottom=1080},new Rect{Left=0,Top=0,Right=3840,Bottom=2160}};Need(Outside(new Rect{Left=3900,Top=0,Right=4700,Bottom=600},displays),"OFFSCREEN_FOCUS_TEST_OUTSIDE");n++;Need(!Outside(new Rect{Left=-1900,Top=0,Right=-1000,Bottom=600},displays),"OFFSCREEN_FOCUS_TEST_NEGATIVE_DISPLAY");n++;Need(!Outside(new Rect{Left=3800,Top=0,Right=4700,Bottom=600},displays),"OFFSCREEN_FOCUS_TEST_PARTIAL_INTERSECTION");n++;Need(!Outside(new Rect{Left=0,Top=0,Right=0,Bottom=0},displays)&&!Outside(new Rect{Left=1,Top=1,Right=2,Bottom=2},new Rect[0]),"OFFSCREEN_FOCUS_TEST_EMPTY");n++;
        var identity=I(D("hwnd","123","pid",456,"threadId",789,"processCreatedFileTimeUtc","123456"));Need(identity.Window==new IntPtr(123)&&identity.Pid==456&&identity.Thread==789&&identity.Created==123456,"OFFSCREEN_FOCUS_TEST_IDENTITY");n++;
        Need(DeadlineValid(1000,1000)&&DeadlineValid(1000,1500)&&!DeadlineValid(1000,999)&&!DeadlineValid(1000,1501),"OFFSCREEN_FOCUS_TEST_DEADLINE");n++;
        foreach(int failed in new[]{0,1,2,3}){int guards=0,activations=0,sourceDetached=0,ownDetached=0;bool threw=false;try{AttachedOnce(delegate{guards++;if(failed==0||failed==3&&guards==3)throw new InvalidOperationException("expected");},delegate{return true;},delegate{return failed!=1;},delegate{activations++;if(failed==2)throw new InvalidOperationException("expected");},delegate{ownDetached++;return true;},delegate{sourceDetached++;return true;});}catch(InvalidOperationException){threw=true;}Need(threw&&activations==(failed==2?1:0)&&sourceDetached==(failed==0?0:1)&&ownDetached==(failed>=2?1:0),"OFFSCREEN_FOCUS_TEST_ATTACH_GUARD_CLEANUP");n++;}
        int detachedSource=0;bool detachFailure=false;try{AttachedOnce(delegate{},delegate{return true;},delegate{return true;},delegate{},delegate{return false;},delegate{detachedSource++;return true;});}catch(InvalidOperationException){detachFailure=true;}Need(detachFailure&&detachedSource==1,"OFFSCREEN_FOCUS_TEST_DETACH_BOTH_AFTER_FAILURE");n++;
        var edges=new List<string>();HelperQueuesOnce(5,6,7,delegate{},delegate(uint from,uint to,bool attach){Need(from==5&&(to==6||to==7),"OFFSCREEN_FOCUS_TEST_HELPER_PARTICIPATES_IN_EVERY_EDGE");edges.Add(from+":"+to+":"+attach);return true;},delegate{edges.Add("activate");});Need(String.Join(",",edges.ToArray())=="5:6:True,5:7:True,activate,5:7:False,5:6:False","OFFSCREEN_FOCUS_TEST_REVERSE_DETACH_TOPOLOGY");n++;
        edges.Clear();bool attachmentFailed=false;try{HelperQueuesOnce(5,6,7,delegate{},delegate(uint from,uint to,bool attach){Need(from==5,"OFFSCREEN_FOCUS_TEST_NO_EXTERNAL_EDGE_ON_FAILURE");edges.Add(from+":"+to+":"+attach);return !(to==7&&attach);},delegate{throw new Exception("activation must not run");});}catch(InvalidOperationException){attachmentFailed=true;}Need(attachmentFailed&&String.Join(",",edges.ToArray())=="5:6:True,5:7:True,5:6:False","OFFSCREEN_FOCUS_TEST_SECOND_EDGE_FAILURE_DETACHES_FIRST");n++;
        return D("ok",true,"selfTest",true,"checks",n,"uiAccessed",false,"inputSent",false,"clipboardAccessed",false);
    }
    [STAThread]static int Main(string[] args){Console.InputEncoding=new UTF8Encoding(false);Console.OutputEncoding=new UTF8Encoding(false);try{if(args.Length==1&&args[0]=="--self-test"){Console.WriteLine(Json.Serialize(SelfTest()));return 0;}Need(args.Length==1&&args[0]=="--once","OFFSCREEN_FOCUS_ARGUMENTS_INVALID");Need(SetProcessDpiAwarenessContext(new IntPtr(-4)),"OFFSCREEN_FOCUS_DPI_UNAVAILABLE");var text=new StringBuilder();for(;;){int c=Console.In.Read();Need(c>=0,"OFFSCREEN_FOCUS_REQUEST_TRUNCATED");if(c=='\n')break;Need(text.Length<8192,"OFFSCREEN_FOCUS_REQUEST_INVALID");text.Append((char)c);}
        var request=Map(Json.DeserializeObject(text.ToString()));long remaining=N(G(request,"deadlineTickMs"))-(long)GetTickCount64();Need(remaining>=0&&remaining<=500,"OFFSCREEN_FOCUS_EXPIRED");
        // The parent also enforces a shorter wait, but it can itself exit.
        // This independent deadline terminates this helper even while a
        // foreground API is synchronously blocked. Every attached edge owns
        // this helper's thread, so its exit does not leave external links.
        using(var watchdog=new System.Threading.Timer(delegate{Environment.Exit(124);},null,checked((int)Math.Max(1,remaining)),Timeout.Infinite)){var result=Run(request);Console.WriteLine(Json.Serialize(result));return 0;}
    }catch(Exception error){string code=error is InvalidOperationException&&error.Message.StartsWith("OFFSCREEN_FOCUS_",StringComparison.Ordinal)?error.Message:"OFFSCREEN_FOCUS_FAILED";Console.WriteLine(Json.Serialize(D("version",1,"error",code,"inputSent",false,"clipboardAccessed",false)));return 1;}}
    [DllImport("user32.dll")]static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")]static extern bool IsWindow(IntPtr w);
    [DllImport("user32.dll")]static extern bool IsWindowVisible(IntPtr w);
    [DllImport("user32.dll")]static extern bool IsWindowEnabled(IntPtr w);
    [DllImport("user32.dll")]static extern bool IsIconic(IntPtr w);
    [DllImport("user32.dll")]static extern IntPtr GetAncestor(IntPtr w,uint flags);
    [DllImport("user32.dll")]static extern uint GetWindowThreadProcessId(IntPtr w,out uint pid);
    [DllImport("user32.dll")]static extern bool GetWindowRect(IntPtr w,out Rect rect);
    [DllImport("user32.dll")]static extern bool GetGUIThreadInfo(uint thread,ref GuiInfo info);
    [DllImport("user32.dll")]static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll")]static extern bool GetLastInputInfo(ref LastInput input);
    [DllImport("user32.dll")]static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")]static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]static extern bool SetForegroundWindow(IntPtr w);
    [DllImport("user32.dll")]static extern bool AttachThreadInput(uint from,uint to,bool attach);
    [DllImport("user32.dll")]static extern bool PeekMessage(out Message message,IntPtr hwnd,uint min,uint max,uint remove);
    [DllImport("user32.dll")]static extern IntPtr GetThreadDesktop(uint thread);
    [DllImport("user32.dll")]static extern IntPtr GetProcessWindowStation();
    [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern bool GetUserObjectInformation(IntPtr handle,int index,IntPtr information,uint length,out uint needed);
    [DllImport("user32.dll")]static extern IntPtr OpenInputDesktop(uint flags,bool inherit,uint access);
    [DllImport("user32.dll")]static extern bool CloseDesktop(IntPtr handle);
    [DllImport("kernel32.dll")]static extern uint GetCurrentProcessId();
    [DllImport("kernel32.dll")]static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll")]static extern bool ProcessIdToSessionId(uint pid,out uint session);
    [DllImport("kernel32.dll")]static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
    [DllImport("kernel32.dll")]static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll")]static extern bool GetProcessTimes(IntPtr process,out FileTime start,out FileTime exit,out FileTime kernel,out FileTime user);
    [DllImport("kernel32.dll")]static extern bool GetExitCodeProcess(IntPtr process,out uint code);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode)]static extern bool QueryFullProcessImageName(IntPtr process,uint flags,StringBuilder file,ref int length);
    [DllImport("kernel32.dll")]static extern ulong GetTickCount64();
}
