// Diagnostic for a single calibrated, non-send mouse gesture. This program does
// not inject a DLL, inspect target memory, activate windows, attach input queues,
// move the system cursor, send keyboard events, or access the clipboard.
// PostMessage returning true proves queue admission only, never a successful click.
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
using System.Web.Script.Serialization;

internal static class WechatWindowMessageProbe
{
    static readonly JavaScriptSerializer Json=new JavaScriptSerializer {MaxJsonLength=131072,RecursionLimit=24};
    const uint MouseMove=0x0200,LeftDown=0x0201,LeftUp=0x0202;
    static bool UiAccessed,Attempted,UnpairedDownQueued; static int MessagesPosted;
    sealed class Fault:Exception { internal Fault(string code):base(code){} }
    static void Need(bool value,string code){if(!value)throw new Fault(code);}
    static Dictionary<string,object> Data(params object[] pairs){var result=new Dictionary<string,object>();for(int i=0;i<pairs.Length;i+=2)result.Add((string)pairs[i],pairs[i+1]);return result;}
    static Dictionary<string,object> Map(object value){return value as Dictionary<string,object>;}
    static object Get(Dictionary<string,object> value,string key){object result;return value!=null&&value.TryGetValue(key,out result)?result:null;}
    static string Str(Dictionary<string,object> value,string key){return Get(value,key) as string;}
    static long Number(object value){Need(value!=null&&!(value is bool)&&!(value is string),"WM_PROBE_NUMBER_INVALID");try{decimal n=Convert.ToDecimal(value,CultureInfo.InvariantCulture);Need(n>=Int32.MinValue&&n<=9007199254740991M&&decimal.Truncate(n)==n,"WM_PROBE_NUMBER_INVALID");return (long)n;}catch(Fault){throw;}catch{throw new Fault("WM_PROBE_NUMBER_INVALID");}}
    static long DecimalString(object value){long n;string s=value as string;Need(s!=null&&s.Length<=19&&Int64.TryParse(s,NumberStyles.None,CultureInfo.InvariantCulture,out n)&&n>0,"WM_PROBE_ID_INVALID");return Int64.Parse(s,CultureInfo.InvariantCulture);}
    static string Id(long value){return value.ToString(CultureInfo.InvariantCulture);}
    static string Hash(byte[] bytes){using(var sha=SHA256.Create())return BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-","").ToLowerInvariant();}
    static bool ValidHash(string hash){return hash!=null&&System.Text.RegularExpressions.Regex.IsMatch(hash,"^[a-f0-9]{64}$");}
    static string ReadPath(string path){Need(!String.IsNullOrEmpty(path)&&path.Length<=1024&&Path.IsPathRooted(path)&&path.IndexOfAny(new char[]{'\0','\r','\n'})<0,"WM_PROBE_PATH_INVALID");return Path.GetFullPath(path);}
    static byte[] ReadBounded(string path){var file=new FileInfo(path);Need(file.Exists&&file.Length>0&&file.Length<=131072,"WM_PROBE_FILE_INVALID");byte[] bytes=File.ReadAllBytes(path);Need(bytes.Length>0&&bytes.Length<=131072,"WM_PROBE_FILE_INVALID");return bytes;}
    static Dictionary<string,object> ReadJson(string path){var value=Map(Json.DeserializeObject(Encoding.UTF8.GetString(ReadBounded(path))));Need(value!=null,"WM_PROBE_JSON_INVALID");return value;}
    [StructLayout(LayoutKind.Sequential)] struct Point {internal int X,Y;internal Point(int x,int y){X=x;Y=y;}internal object Report(){return Data("x",X,"y",Y);}}
    [StructLayout(LayoutKind.Sequential)] struct Rect {internal int Left,Top,Right,Bottom;internal int Width{get{return Right-Left;}}internal int Height{get{return Bottom-Top;}}internal object Report(){return Data("left",Left,"top",Top,"right",Right,"bottom",Bottom);}}
    [StructLayout(LayoutKind.Sequential)] struct LastInput {internal uint Size,Time;}
    [StructLayout(LayoutKind.Sequential)] struct FileTime {internal uint Low,High;internal long Ticks{get{return ((long)High<<32)|Low;}}}
    sealed class Binding {internal string ConfigPath,ConfigHash,Executable,Version,ExecutableHash,Scope;internal int Width,Height,Dpi,Idle;internal IntPtr Window;internal Rect Region;}
    static bool Same(Rect a,Rect b){return a.Left==b.Left&&a.Top==b.Top&&a.Right==b.Right&&a.Bottom==b.Bottom;}
    static Rect Rectangle(object value){var r=Map(value);Need(r!=null,"WM_PROBE_RECT_INVALID");return new Rect{Left=checked((int)Number(Get(r,"left"))),Top=checked((int)Number(Get(r,"top"))),Right=checked((int)Number(Get(r,"right"))),Bottom=checked((int)Number(Get(r,"bottom")))};}
    static Rect ScopeRegion(string scope,Dictionary<string,object> layout,int width,int height){
        Need(scope=="self-profile-open"||scope=="search-focus","WM_PROBE_SCOPE_FORBIDDEN");Rect r=Rectangle(Get(layout,scope=="self-profile-open"?"selfOpen":"search"));
        Need(r.Left>=0&&r.Top>=0&&r.Right>r.Left&&r.Bottom>r.Top&&r.Right<=width&&r.Bottom<=height,"WM_PROBE_RECT_INVALID");
        // Both allowed landmarks are in the top-left navigation area. Never
        // accept a config that relabels a chat send button as a diagnostic scope.
        Need(r.Bottom<=height/4&&r.Right<=(scope=="self-profile-open"?width/5:width*2/5),"WM_PROBE_SCOPE_GEOMETRY_FORBIDDEN");return r;
    }
    static Binding Load(Dictionary<string,object> request){
        Need(Number(Get(request,"version"))==1,"WM_PROBE_REQUEST_VERSION_INVALID");string path=ReadPath(Str(request,"configPath"));byte[] bytes=ReadBounded(path);var config=Map(Json.DeserializeObject(Encoding.UTF8.GetString(bytes)));Need(config!=null&&Number(Get(config,"version"))==1&&Str(config,"backend")=="qt-visual","WM_PROBE_CONFIG_INVALID");
        var layout=Map(Get(config,"layout"));Need(layout!=null,"WM_PROBE_CONFIG_INVALID");string exe=ReadPath(Str(config,"executable"));Need(String.Equals(Path.GetFileName(exe),"Weixin.exe",StringComparison.OrdinalIgnoreCase),"WM_PROBE_EXECUTABLE_FORBIDDEN");
        string version=Str(config,"executableVersion"),hash=Str(config,"executableSha256");Need(version=="4.1.15.56"&&ValidHash(hash),"WM_PROBE_BUILD_UNSUPPORTED");
        int width=checked((int)Number(Get(layout,"width"))),height=checked((int)Number(Get(layout,"height"))),dpi=checked((int)Number(Get(layout,"dpi")));Need(width>=600&&width<=4096&&height>=400&&height<=4096&&dpi>=48&&dpi<=768,"WM_PROBE_GEOMETRY_INVALID");
        int idle=checked((int)Number(Get(config,"idleMs")));Need(idle>=1000&&idle<=300000,"WM_PROBE_IDLE_INVALID");string scope=Str(request,"scope");
        return new Binding{ConfigPath=path,ConfigHash=Hash(bytes),Executable=exe,Version=version,ExecutableHash=hash,Width=width,Height=height,Dpi=dpi,Idle=idle,Window=new IntPtr(DecimalString(Get(request,"hwnd"))),Scope=scope,Region=ScopeRegion(scope,layout,width,height)};
    }
    static void VerifyBuild(Binding b){var info=new FileInfo(b.Executable);Need(info.Exists&&info.Length>0&&info.Length<=64*1024*1024,"WM_PROBE_EXECUTABLE_INVALID");Need(FileVersionInfo.GetVersionInfo(b.Executable).FileVersion==b.Version&&Hash(File.ReadAllBytes(b.Executable))==b.ExecutableHash,"WM_PROBE_BUILD_CHANGED");Need(Hash(ReadBounded(b.ConfigPath))==b.ConfigHash,"WM_PROBE_CONFIG_CHANGED");}
    static string DesktopName(IntPtr handle){uint needed;GetUserObjectInformation(handle,2,null,0,out needed);Need(needed>0&&needed<=1024,"WM_PROBE_DESKTOP_UNAVAILABLE");var value=new StringBuilder(checked((int)needed/2+1));Need(GetUserObjectInformation(handle,2,value,needed,out needed),"WM_PROBE_DESKTOP_UNAVAILABLE");return value.ToString();}
    static void Desktop(){IntPtr input=OpenInputDesktop(0,false,1);Need(input!=IntPtr.Zero,"WM_PROBE_DESKTOP_UNAVAILABLE");try{string name=DesktopName(input);Need(name=="Default"&&name==DesktopName(GetThreadDesktop(GetCurrentThreadId())),"WM_PROBE_DESKTOP_UNAVAILABLE");}finally{CloseDesktop(input);}}
    static object Snapshot(Binding b){
        UiAccessed=true;Desktop();Need(IsWindow(b.Window)&&IsWindowVisible(b.Window)&&IsWindowEnabled(b.Window)&&!IsIconic(b.Window)&&GetAncestor(b.Window,2)==b.Window,"WM_PROBE_WINDOW_UNAVAILABLE");int cloaked;Need(DwmGetWindowAttribute(b.Window,14,out cloaked,4)>=0&&cloaked==0,"WM_PROBE_WINDOW_UNAVAILABLE");
        uint pid;uint thread=GetWindowThreadProcessId(b.Window,out pid);Need(pid>0&&thread>0,"WM_PROBE_PROCESS_UNAVAILABLE");IntPtr process=OpenProcess(0x1000,false,pid);Need(process!=IntPtr.Zero,"WM_PROBE_PROCESS_UNAVAILABLE");long created;
        try{var path=new StringBuilder(32768);uint size=(uint)path.Capacity;Need(QueryFullProcessImageName(process,0,path,ref size)&&String.Equals(Path.GetFullPath(path.ToString()),b.Executable,StringComparison.OrdinalIgnoreCase),"WM_PROBE_EXECUTABLE_CHANGED");FileTime start,exit,kernel,user;Need(GetProcessTimes(process,out start,out exit,out kernel,out user),"WM_PROBE_PROCESS_UNAVAILABLE");created=start.Ticks;}finally{CloseHandle(process);}
        uint session;Need(ProcessIdToSessionId(pid,out session)&&session==(uint)Process.GetCurrentProcess().SessionId,"WM_PROBE_SESSION_CHANGED");
        var className=new StringBuilder(257);Need(GetClassName(b.Window,className,className.Capacity)>0&&className.ToString()=="Qt51514QWindowIcon","WM_PROBE_WINDOW_CLASS_CHANGED");
        Rect client=new Rect(),window=new Rect();Point origin=new Point(0,0),cursor=new Point();Need(GetClientRect(b.Window,out client)&&GetWindowRect(b.Window,out window)&&ClientToScreen(b.Window,ref origin)&&GetCursorPos(out cursor),"WM_PROBE_GEOMETRY_UNAVAILABLE");Need(client.Left==0&&client.Top==0&&client.Width==b.Width&&client.Height==b.Height&&GetDpiForWindow(b.Window)==b.Dpi,"WM_PROBE_GEOMETRY_CHANGED");
        var input=new LastInput{Size=(uint)Marshal.SizeOf(typeof(LastInput))};Need(GetLastInputInfo(ref input),"WM_PROBE_INPUT_STATE_UNAVAILABLE");uint idle=unchecked((uint)GetTickCount64()-input.Time);bool keysReleased=true;for(int key=1;key<256;key++)if((GetAsyncKeyState(key)&0x8000)!=0){keysReleased=false;break;}
        return Data("hwnd",Id(b.Window.ToInt64()),"pid",pid,"threadId",thread,"processCreatedFileTimeUtc",Id(created),"executable",b.Executable,"executableVersion",b.Version,"executableSha256",b.ExecutableHash,"className",className.ToString(),"clientRect",client.Report(),"windowRect",window.Report(),"clientScreenRect",new Rect{Left=origin.X,Top=origin.Y,Right=origin.X+client.Width,Bottom=origin.Y+client.Height}.Report(),"dpi",b.Dpi,"foregroundHwnd",Id(GetForegroundWindow().ToInt64()),"cursor",cursor.Report(),"lastInputTick",input.Time,"idleMsObserved",idle,"keysReleased",keysReleased,"observedAtTick",Id(checked((long)GetTickCount64())));
    }
    static bool EqualValue(object a,object b){return a!=null&&b!=null&&Convert.ToString(a,CultureInfo.InvariantCulture)==Convert.ToString(b,CultureInfo.InvariantCulture);}
    static bool SameTarget(Dictionary<string,object> a,Dictionary<string,object> b){
        foreach(string key in new[]{"hwnd","pid","threadId","processCreatedFileTimeUtc","executable","executableVersion","executableSha256","className","dpi"})if(!EqualValue(Get(a,key),Get(b,key)))return false;
        foreach(string key in new[]{"clientRect","windowRect","clientScreenRect"})if(!Same(Rectangle(Get(a,key)),Rectangle(Get(b,key))))return false;return true;
    }
    static bool SameUserState(Dictionary<string,object> a,Dictionary<string,object> b){var ac=Map(Get(a,"cursor"));var bc=Map(Get(b,"cursor"));return EqualValue(Get(a,"foregroundHwnd"),Get(b,"foregroundHwnd"))&&EqualValue(Get(a,"lastInputTick"),Get(b,"lastInputTick"))&&EqualValue(Get(ac,"x"),Get(bc,"x"))&&EqualValue(Get(ac,"y"),Get(bc,"y"));}
    static void VerifyExpected(Dictionary<string,object> expected,Dictionary<string,object> current,int idle){Need(expected!=null&&SameTarget(expected,current),"WM_PROBE_BINDING_CHANGED");Need(SameUserState(expected,current),"WM_PROBE_USER_STATE_CHANGED");Need(Get(current,"keysReleased") is bool&&(bool)Get(current,"keysReleased"),"WM_PROBE_KEYS_HELD");Need(Number(Get(current,"idleMsObserved"))>=idle,"WM_PROBE_USER_ACTIVE");}
    static uint Coordinate(Point p){Need(p.X>=0&&p.X<=32767&&p.Y>=0&&p.Y<=32767,"WM_PROBE_POINT_INVALID");return (uint)p.X|((uint)p.Y<<16);}
    static object Prepared(Binding b,Dictionary<string,object> snapshot){return Data("version",1,"configPath",b.ConfigPath,"configSha256",b.ConfigHash,"hwnd",Id(b.Window.ToInt64()),"scope",b.Scope,"expected",snapshot,"preparedAtTick",Id(checked((long)GetTickCount64())));}
    static void VerifyAge(long prepared,long now){long age=now-prepared;Need(prepared>0&&age>=0&&age<=5000,"WM_PROBE_PREPARATION_EXPIRED");}
    static void SendPointer(uint message,Point point,Func<uint,uint,UIntPtr,bool> send){Need(message==MouseMove||message==LeftDown||message==LeftUp,"WM_PROBE_MESSAGE_FORBIDDEN");uint coordinates=Coordinate(point);Attempted=true;Need(send(message,coordinates,new UIntPtr(message==LeftDown?1U:0U)),"WM_PROBE_POST_REJECTED");MessagesPosted++;if(message==LeftDown)UnpairedDownQueued=true;if(message==LeftUp)UnpairedDownQueued=false;}
    static void Gesture(Point point,Func<uint,uint,UIntPtr,bool> post,Action beforeDown,Func<bool> releaseTargetSame,Action<int> sleep){
        SendPointer(MouseMove,point,post);sleep(10);beforeDown();SendPointer(LeftDown,point,post);
        try{sleep(20);}finally{Need(releaseTargetSame(),"WM_PROBE_RELEASE_TARGET_CHANGED");SendPointer(LeftUp,point,post);}
    }
    static object Execute(Binding b,Dictionary<string,object> request,Dictionary<string,object> before){
        Need(Str(request,"configSha256")==b.ConfigHash,"WM_PROBE_PREPARATION_CONFIG_CHANGED");VerifyAge(DecimalString(Get(request,"preparedAtTick")),checked((long)GetTickCount64()));VerifyExpected(Map(Get(request,"expected")),before,b.Idle);
        Point point=new Point(b.Region.Left+b.Region.Width/2,b.Region.Top+b.Region.Height/2);var watch=Stopwatch.StartNew();
        Func<uint,uint,UIntPtr,bool> post=delegate(uint message,uint coordinates,UIntPtr flags){return PostMessage(b.Window,message,flags,new IntPtr(unchecked((int)coordinates)));};
        // Release the same local button even if physical input changes after
        // down. No further gesture is sent. Never release into a reused HWND.
        Gesture(point,post,delegate{VerifyExpected(before,Map(Snapshot(b)),b.Idle);},delegate{return SameTarget(before,Map(Snapshot(b)));},Thread.Sleep);
        Thread.Sleep(80);var after=Map(Snapshot(b));return Data("ok",true,"mode","execute","scope",b.Scope,"region",b.Region.Report(),"point",point.Report(),"before",before,"after",after,"bindingStable",SameTarget(before,after),"foregroundUnchanged",EqualValue(Get(before,"foregroundHwnd"),Get(after,"foregroundHwnd")),"systemCursorUnchanged",Json.Serialize(Get(before,"cursor"))==Json.Serialize(Get(after,"cursor")),"inputTickUnchanged",EqualValue(Get(before,"lastInputTick"),Get(after,"lastInputTick")),"elapsedMs",watch.ElapsedMilliseconds,"queueAccepted",MessagesPosted==3,"clickConfirmed",false,"retryAllowed",false,"unpairedDownQueued",UnpairedDownQueued,"ready",false,"eligibleForAutomation",false,"diagnosticOnly",true,"inputSent",Attempted,"messagesPosted",MessagesPosted,"clipboardAccessed",false,"focusActivationRequested",false,"systemCursorMovementRequested",false,"globalKeysSent",false);
    }
    static object Capture(Binding b,Dictionary<string,object> request,Dictionary<string,object> before){
        string output=ReadPath(Str(request,"imagePath"));Need(Path.GetExtension(output)==".png"&&!File.Exists(output)&&Directory.Exists(Path.GetDirectoryName(output)),"WM_PROBE_IMAGE_PATH_INVALID");
        var watch=Stopwatch.StartNew();bool painted;
        using(var bitmap=new Bitmap(b.Width,b.Height,PixelFormat.Format32bppArgb)){
            using(var graphics=Graphics.FromImage(bitmap)){
                graphics.Clear(Color.Magenta);IntPtr dc=graphics.GetHdc();
                try{painted=PrintWindow(b.Window,dc,3);}finally{graphics.ReleaseHdc(dc);}
            }
            Need(painted,"WM_PROBE_PRINT_FAILED");var after=Map(Snapshot(b));Need(SameTarget(before,after),"WM_PROBE_BINDING_CHANGED");
            byte[] encoded=EncodePng(bitmap);using(var stream=new FileStream(output,FileMode.CreateNew,FileAccess.Write,FileShare.None))stream.Write(encoded,0,encoded.Length);
            var colors=new HashSet<int>();for(int y=0;y<b.Height;y+=8)for(int x=0;x<b.Width;x+=8)colors.Add(bitmap.GetPixel(x,y).ToArgb());
            return CaptureReport(b,output,Hash(encoded),before,after,colors.Count,watch.ElapsedMilliseconds);
        }
    }
    static byte[] EncodePng(Bitmap bitmap){using(var memory=new MemoryStream()){bitmap.Save(memory,ImageFormat.Png);return memory.ToArray();}}
    static object CaptureReport(Binding b,string output,string sha,Dictionary<string,object> before,Dictionary<string,object> after,int colors,long elapsed){
        Need(ValidHash(sha),"WM_PROBE_IMAGE_HASH_INVALID");
        return Data("ok",true,"mode","capture","imagePath",output,"imageSha256",sha,"width",b.Width,"height",b.Height,"sampledColorCount",colors,"before",before,"after",after,"bindingStable",SameTarget(before,after),"foregroundUnchanged",EqualValue(Get(before,"foregroundHwnd"),Get(after,"foregroundHwnd")),"systemCursorUnchanged",Json.Serialize(Get(before,"cursor"))==Json.Serialize(Get(after,"cursor")),"inputTickUnchanged",EqualValue(Get(before,"lastInputTick"),Get(after,"lastInputTick")),"elapsedMs",elapsed,"captureMethod","PrintWindow-client-full-content","contentVerified",false,"inputSent",false,"diagnosticOnly",true,"eligibleForAutomation",false,"retryAllowed",false,"livePostMessageCalled",false);
    }
    static string ParseMode(string[] args,out bool enabled){
        Need((args.Length==3||args.Length==4&&args[3]=="--enable-pointer-messages")&&args[1]=="--request"&&(args[0]=="--inspect"||args[0]=="--prepare"||args[0]=="--execute"||args[0]=="--capture"),"WM_PROBE_ARGUMENTS_INVALID");
        enabled=args.Length==4;Need(args[0]=="--execute"?enabled:!enabled,"WM_PROBE_INPUT_DISABLED");return args[0].Substring(2);
    }
    static object Run(string mode,string path,bool enabled){
        var request=ReadJson(ReadPath(path));Binding b=Load(request);VerifyBuild(b);SetProcessDpiAwarenessContext(new IntPtr(-4));var before=Map(Snapshot(b));
        if(mode=="capture")return Capture(b,request,before);
        if(mode=="inspect")return Data("ok",true,"mode",mode,"scope",b.Scope,"region",b.Region.Report(),"observation",before,"candidateRequest",Prepared(b,before),"ready",false,"inputSent",false,"clipboardAccessed",false,"diagnosticOnly",true,"eligibleForAutomation",false);
        Need(Str(request,"configSha256")==b.ConfigHash,"WM_PROBE_PREPARATION_CONFIG_CHANGED");VerifyExpected(Map(Get(request,"expected")),before,b.Idle);
        if(mode=="prepare")return Data("ok",true,"mode",mode,"scope",b.Scope,"region",b.Region.Report(),"preparedRequest",Prepared(b,before),"ready",true,"inputSent",false,"clipboardAccessed",false,"diagnosticOnly",true,"eligibleForAutomation",false);
        Need(mode=="execute"&&enabled,"WM_PROBE_INPUT_DISABLED");using(var gate=new Mutex(false,"Local\\WeChatAgent.UiInput.v1")){bool held=false;try{try{held=gate.WaitOne(0);}catch(AbandonedMutexException){held=true;}Need(held,"WM_PROBE_INPUT_ALREADY_OWNED");VerifyBuild(b);VerifyExpected(before,Map(Snapshot(b)),b.Idle);return Execute(b,request,before);}finally{if(held)gate.ReleaseMutex();}}
    }
    static void Write(object value){Console.WriteLine(Json.Serialize(value));}
    static int Main(string[] args){Console.OutputEncoding=new UTF8Encoding(false);try{
        if(args.Length==1&&args[0]=="--self-test"){Write(SelfTest());return 0;}
        if(args.Length==0||args.Length==1&&args[0]=="--help"){Write(Data("ok",true,"usage","--inspect|--prepare|--capture --request <absolute JSON>; capture requires imagePath (new local PNG); --execute --request <absolute prepared JSON> --enable-pointer-messages","scopes",new[]{"self-profile-open","search-focus"},"captureContentVerified",false,"inputSent",false));return 0;}
        bool enabled;string mode=ParseMode(args,out enabled);
        using(var watchdog=new Timer(delegate{Environment.Exit(2);},null,10000,Timeout.Infinite))Write(Run(mode,args[2],enabled));return 0;
    }catch(Exception error){Write(Data("ok",false,"error",error is Fault?error.Message:"WM_PROBE_FAILED","diagnosticOnly",true,"eligibleForAutomation",false,"ready",false,"uiAccessed",UiAccessed,"inputSent",Attempted,"messagesPosted",MessagesPosted,"unpairedDownQueued",UnpairedDownQueued,"clipboardAccessed",false,"clickConfirmed",false,"retryAllowed",false));return 1;}}
    static void Reject(Action action,string code){try{action();}catch(Fault error){Need(error.Message==code,"WM_PROBE_TEST_WRONG_FAULT");return;}throw new Fault("WM_PROBE_TEST_ACCEPTED_INVALID_INPUT");}
    static object SelfTest(){int n=0;var layout=Data("selfOpen",Data("left",20,"top",55,"right",55,"bottom",95),"search",Data("left",100,"top",40,"right",300,"bottom",90));
        Need(ScopeRegion("self-profile-open",layout,1100,800).Width==35,"WM_PROBE_TEST_SCOPE");n++;Need(ScopeRegion("search-focus",layout,1100,800).Height==50,"WM_PROBE_TEST_SCOPE");n++;
        foreach(string scope in new[]{"send","editor","record-start","search-result",null}){Reject(delegate{ScopeRegion(scope,layout,1100,800);},"WM_PROBE_SCOPE_FORBIDDEN");n++;}
        Reject(delegate{ScopeRegion("self-profile-open",Data("selfOpen",Data("left",900,"top",650,"right",1000,"bottom",720)),1100,800);},"WM_PROBE_SCOPE_GEOMETRY_FORBIDDEN");n++;
        Reject(delegate{ScopeRegion("search-focus",Data("search",Data("left",100,"top",80,"right",80,"bottom",90)),1100,800);},"WM_PROBE_RECT_INVALID");n++;
        Need(Coordinate(new Point(37,75))==0x004b0025U,"WM_PROBE_TEST_COORDINATE");n++;Reject(delegate{Coordinate(new Point(-1,3));},"WM_PROBE_POINT_INVALID");n++;
        int called=0;var messages=new List<uint>();Func<uint,uint,UIntPtr,bool> mock=delegate(uint message,uint position,UIntPtr flags){called++;messages.Add(message);Need(position==0x004b0025U&&flags.ToUInt64()==(message==LeftDown?1UL:0UL),"WM_PROBE_TEST_MESSAGE_LAYOUT");return true;};
        SendPointer(MouseMove,new Point(37,75),mock);SendPointer(LeftDown,new Point(37,75),mock);SendPointer(LeftUp,new Point(37,75),mock);Need(called==3&&messages[0]==MouseMove&&messages[1]==LeftDown&&messages[2]==LeftUp,"WM_PROBE_TEST_SEQUENCE");n++;
        Attempted=false;MessagesPosted=0;Reject(delegate{SendPointer(0x0102,new Point(37,75),mock);},"WM_PROBE_MESSAGE_FORBIDDEN");Need(!Attempted&&MessagesPosted==0&&called==3,"WM_PROBE_TEST_NO_FORBIDDEN_POST");n++;
        Reject(delegate{SendPointer(MouseMove,new Point(-1,75),mock);},"WM_PROBE_POINT_INVALID");Need(!Attempted&&MessagesPosted==0,"WM_PROBE_TEST_NO_INVALID_POST");n++;
        Reject(delegate{SendPointer(MouseMove,new Point(37,75),delegate{return false;});},"WM_PROBE_POST_REJECTED");Need(Attempted&&MessagesPosted==0,"WM_PROBE_TEST_REJECTED_UNKNOWN");n++;
        var a=Data("foregroundHwnd","99","lastInputTick",100,"cursor",Data("x",-1920,"y",500));var b=Data("foregroundHwnd","99","lastInputTick",100,"cursor",Data("x",-1920,"y",500));Need(SameUserState(a,b),"WM_PROBE_TEST_STATE");n++;
        b["foregroundHwnd"]="100";Need(!SameUserState(a,b),"WM_PROBE_TEST_FOREGROUND");b["foregroundHwnd"]="99";n++;b["lastInputTick"]=101;Need(!SameUserState(a,b),"WM_PROBE_TEST_ACTIVITY");b["lastInputTick"]=100;n++;b["cursor"]=Data("x",-1919,"y",500);Need(!SameUserState(a,b),"WM_PROBE_TEST_CURSOR");n++;
        var target=Data("hwnd","394950","pid",14944,"threadId",10,"processCreatedFileTimeUtc","134374923857440392","executable","D:\\Weixin\\Weixin.exe","executableVersion","4.1.15.56","executableSha256",new string('a',64),"className","Qt51514QWindowIcon","dpi",120,"clientRect",Data("left",0,"top",0,"right",1100,"bottom",800),"windowRect",Data("left",10,"top",20,"right",1110,"bottom",820),"clientScreenRect",Data("left",10,"top",20,"right",1110,"bottom",820),"foregroundHwnd","99","lastInputTick",100,"cursor",Data("x",-1920,"y",500),"keysReleased",true,"idleMsObserved",2000);
        var copy=Map(Json.DeserializeObject(Json.Serialize(target)));VerifyExpected(target,copy,1000);n++;
        foreach(string key in new[]{"hwnd","pid","threadId","processCreatedFileTimeUtc","executable","executableVersion","executableSha256","className","dpi"}){object original=copy[key];copy[key]="changed";Need(!SameTarget(target,copy),"WM_PROBE_TEST_IDENTITY_REUSE");copy[key]=original;n++;}
        foreach(string key in new[]{"clientRect","windowRect","clientScreenRect"}){var rect=Map(copy[key]);object original=rect["left"];rect["left"]=Number(original)+1;Need(!SameTarget(target,copy),"WM_PROBE_TEST_MOVEMENT");rect["left"]=original;n++;}
        copy["keysReleased"]=false;Reject(delegate{VerifyExpected(target,copy,1000);},"WM_PROBE_KEYS_HELD");copy["keysReleased"]=true;n++;
        copy["idleMsObserved"]=999;Reject(delegate{VerifyExpected(target,copy,1000);},"WM_PROBE_USER_ACTIVE");copy["idleMsObserved"]=2000;n++;
        VerifyAge(100,5100);Reject(delegate{VerifyAge(100,5101);},"WM_PROBE_PREPARATION_EXPIRED");Reject(delegate{VerifyAge(101,100);},"WM_PROBE_PREPARATION_EXPIRED");n+=3;
        messages.Clear();UnpairedDownQueued=false;Gesture(new Point(37,75),mock,delegate{},delegate{return true;},delegate{});Need(messages.Count==3&&!UnpairedDownQueued,"WM_PROBE_TEST_GESTURE");n++;
        messages.Clear();Reject(delegate{Gesture(new Point(37,75),mock,delegate{throw new Fault("WM_PROBE_USER_STATE_CHANGED");},delegate{return true;},delegate{});},"WM_PROBE_USER_STATE_CHANGED");Need(messages.Count==1&&!UnpairedDownQueued,"WM_PROBE_TEST_NO_DOWN_AFTER_ACTIVITY");n++;
        messages.Clear();Reject(delegate{Gesture(new Point(37,75),mock,delegate{},delegate{return false;},delegate{});},"WM_PROBE_RELEASE_TARGET_CHANGED");Need(messages.Count==2&&UnpairedDownQueued,"WM_PROBE_TEST_NO_RELEASE_REUSED_TARGET");n++;
        messages.Clear();UnpairedDownQueued=false;Reject(delegate{Gesture(new Point(37,75),mock,delegate{},delegate{return true;},delegate(int milliseconds){if(milliseconds==20)throw new Fault("WM_PROBE_INTERRUPTED");});},"WM_PROBE_INTERRUPTED");Need(messages.Count==3&&!UnpairedDownQueued,"WM_PROBE_TEST_RELEASE_AFTER_EXCEPTION");n++;
        bool enabled;Need(ParseMode(new[]{"--capture","--request","fixture.json"},out enabled)=="capture"&&!enabled,"WM_PROBE_TEST_CAPTURE_PARSE");n++;
        foreach(string mode in new[]{"--capture","--inspect","--prepare"}){Reject(delegate{bool flag;ParseMode(new[]{mode,"--request","fixture.json","--enable-pointer-messages"},out flag);},"WM_PROBE_INPUT_DISABLED");n++;}
        Reject(delegate{bool flag;ParseMode(new[]{"--execute","--request","fixture.json"},out flag);},"WM_PROBE_INPUT_DISABLED");n++;
        Need(ParseMode(new[]{"--execute","--request","fixture.json","--enable-pointer-messages"},out enabled)=="execute"&&enabled,"WM_PROBE_TEST_EXECUTE_PARSE");n++;
        using(var bitmap=new Bitmap(32,16,PixelFormat.Format32bppArgb)){using(var graphic=Graphics.FromImage(bitmap))graphic.Clear(Color.Blue);byte[] encoded=EncodePng(bitmap);Need(encoded.Length>24&&encoded[0]==137&&encoded[1]==80&&encoded[2]==78&&encoded[3]==71,"WM_PROBE_TEST_PNG_ENCODING");n++;
            var captured=Map(CaptureReport(new Binding{Width=32,Height=16},"fixture.png",Hash(encoded),target,copy,5000,3));Need((bool)captured["bindingStable"]&&!(bool)captured["contentVerified"]&&!(bool)captured["eligibleForAutomation"]&&!(bool)captured["inputSent"]&&!(bool)captured["livePostMessageCalled"]&&!(bool)captured["retryAllowed"]&&Str(captured,"imageSha256")==Hash(encoded),"WM_PROBE_TEST_CAPTURE_NOT_AUTHORITY");n++;
            copy["lastInputTick"]=101;captured=Map(CaptureReport(new Binding{Width=32,Height=16},"fixture.png",Hash(encoded),target,copy,2,3));Need(!(bool)captured["inputTickUnchanged"]&&!(bool)captured["contentVerified"],"WM_PROBE_TEST_CAPTURE_ACTIVITY_REPORT");n++;}
        Attempted=false;MessagesPosted=0;return Data("ok",true,"selfTest",true,"checks",n,"uiAccessed",false,"inputSent",false,"livePostMessageCalled",false,"livePrintWindowCalled",false);
    }
    [DllImport("user32.dll")]static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll",SetLastError=true)]static extern bool PrintWindow(IntPtr window,IntPtr dc,uint flags);
    [DllImport("user32.dll")]static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")]static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")]static extern bool IsWindowEnabled(IntPtr hwnd);
    [DllImport("user32.dll")]static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")]static extern IntPtr GetAncestor(IntPtr hwnd,uint flags);
    [DllImport("user32.dll")]static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)]static extern int GetClassName(IntPtr hwnd,StringBuilder value,int length);
    [DllImport("user32.dll")]static extern bool GetClientRect(IntPtr hwnd,out Rect value);
    [DllImport("user32.dll")]static extern bool GetWindowRect(IntPtr hwnd,out Rect value);
    [DllImport("user32.dll")]static extern bool ClientToScreen(IntPtr hwnd,ref Point point);
    [DllImport("user32.dll")]static extern uint GetDpiForWindow(IntPtr hwnd);
    [DllImport("user32.dll")]static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll")]static extern bool GetLastInputInfo(ref LastInput info);
    [DllImport("user32.dll")]static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll",EntryPoint="PostMessageW",SetLastError=true)]static extern bool PostMessage(IntPtr hwnd,uint message,UIntPtr flags,IntPtr position);
    [DllImport("user32.dll")]static extern IntPtr OpenInputDesktop(uint flags,bool inherit,uint access);
    [DllImport("user32.dll")]static extern bool CloseDesktop(IntPtr handle);
    [DllImport("user32.dll")]static extern IntPtr GetThreadDesktop(uint thread);
    [DllImport("user32.dll",EntryPoint="GetUserObjectInformationW",CharSet=CharSet.Unicode)]static extern bool GetUserObjectInformation(IntPtr handle,int index,StringBuilder result,uint length,out uint needed);
    [DllImport("kernel32.dll")]static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll")]static extern ulong GetTickCount64();
    [DllImport("kernel32.dll")]static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
    [DllImport("kernel32.dll")]static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll",EntryPoint="QueryFullProcessImageNameW",CharSet=CharSet.Unicode)]static extern bool QueryFullProcessImageName(IntPtr process,uint flags,StringBuilder path,ref uint size);
    [DllImport("kernel32.dll")]static extern bool GetProcessTimes(IntPtr process,out FileTime creation,out FileTime exit,out FileTime kernel,out FileTime user);
    [DllImport("kernel32.dll")]static extern bool ProcessIdToSessionId(uint pid,out uint session);
    [DllImport("dwmapi.dll")]static extern int DwmGetWindowAttribute(IntPtr hwnd,int attribute,out int value,int size);
}
