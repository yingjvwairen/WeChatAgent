// Project-owned, read-only diagnostic. No input injection, UI Automation,
// clipboard, OCR, network, audio, window activation, or settings changes.
using System;
using System.IO;
using System.Text;
using System.Drawing;
using System.Drawing.Imaging;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Threading;
using System.Web.Script.Serialization;

internal static class WechatFrameCapture
{
    const int MaxDimension = 8192, MaxPixels = 32 * 1024 * 1024, MaxPngBytes = 64 * 1024 * 1024;
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 65536 };
    static bool UiAccessed,FrameAcquired;
    sealed class Fault : Exception {
        internal object Diagnostic;
        internal Fault(string code) : base(code) {}
        internal Fault(string code,object diagnostic) : base(code) {Diagnostic=diagnostic;}
    }
    static void Require(bool value, string code) { if (!value) throw new Fault(code); }
    static Dictionary<string,object> Data(params object[] fields) {
        var result = new Dictionary<string,object>();
        for (int index=0; index<fields.Length; index+=2) result.Add((string)fields[index],fields[index+1]);
        return result;
    }
    [MTAThread]
    static int Main(string[] args) {
        Console.OutputEncoding = new UTF8Encoding(false);
        try {
            object result;
            if (args.Length==0 || args.Length==1 && args[0]=="--help") result=Data("ok",true,"mode","help",
                "usage","WechatFrameCapture.exe --capture --executable <absolute exe path> --hwnd <decimal HWND> [--diagnostic-allow-overlap]",
                "output","Project state/diagnostics/wechat-frame-<random UUID>.png", "uiAccessed",false,"captured",false,"inputSent",false,"ready",false,
                "diagnosticOnly",true,"eligibleForAutomation",false,"occlusionVerified",false);
            else if (args.Length==1 && args[0]=="--self-test") result=SelfTest();
            else {
                var request=Parse(args);
                // Exit even if a desktop or GDI call blocks. No window is manipulated.
                using(var watchdog=new Timer(delegate { Environment.Exit(2); },null,15000,Timeout.Infinite)) result=Capture(request);
            }
            Console.WriteLine(Json.Serialize(result)); return 0;
        } catch(Exception error) {
            string code=error is Fault ? error.Message : "FRAME_CAPTURE_FAILED";
            Console.WriteLine(Json.Serialize(Data("ok",false,"error",code,"diagnostic",error is Fault?((Fault)error).Diagnostic:null,
                "readOnly",true,"uiAccessed",UiAccessed,"captured",FrameAcquired,"imageSaved",false,"inputSent",false,
                "ready",false,"diagnosticOnly",true,"eligibleForAutomation",false,"occlusionVerified",false,
                "accountVerified",false,"targetVerified",false,"draftVerified",false,"focusVerified",false)));
            return 1;
        }
    }
    sealed class Request { internal string Executable; internal IntPtr Window; internal bool AllowOverlap; }
    static Request Parse(string[] args) {
        Require((args.Length==5 || args.Length==6 && args[5]=="--diagnostic-allow-overlap") &&
            args[0]=="--capture" && args[1]=="--executable" && args[3]=="--hwnd","FRAME_ARGUMENTS_INVALID");
        string file=args[2];
        Require(!String.IsNullOrEmpty(file) && file.Length<=32760 && file.IndexOfAny(new char[]{'\0','\r','\n'})<0 &&
            file.Length>=3 && Char.IsLetter(file[0]) && file[1]==':' && (file[2]=='\\' || file[2]=='/'),"FRAME_EXECUTABLE_ABSOLUTE_REQUIRED");
        file=Path.GetFullPath(file);
        Require(String.Equals(Path.GetExtension(file),".exe",StringComparison.OrdinalIgnoreCase),"FRAME_EXECUTABLE_REQUIRED");
        long value=0;
        Require(args[4].Length>0 && args[4].Length<=19 && Int64.TryParse(args[4],NumberStyles.None,CultureInfo.InvariantCulture,out value) && value>0,"FRAME_HWND_INVALID");
        return new Request { Executable=file,Window=new IntPtr(value),AllowOverlap=args.Length==6 };
    }
    [StructLayout(LayoutKind.Sequential)]
    internal struct Rect {
        internal int Left,Top,Right,Bottom;
        internal Rect(int left,int top,int right,int bottom) { Left=left;Top=top;Right=right;Bottom=bottom; }
        internal long Width { get { return (long)Right-Left; } }
        internal long Height { get { return (long)Bottom-Top; } }
        internal object Report() { return Data("left",Left,"top",Top,"right",Right,"bottom",Bottom,"width",Width,"height",Height); }
    }
    [StructLayout(LayoutKind.Sequential)] struct Point { internal int X,Y; }
    [StructLayout(LayoutKind.Sequential)] struct FileTime { internal uint Low,High; internal long Ticks {get{return ((long)High<<32)|Low;}} }
    static bool Same(Rect a,Rect b) { return a.Left==b.Left && a.Top==b.Top && a.Right==b.Right && a.Bottom==b.Bottom; }
    static bool Intersects(Rect a,Rect b) { return a.Left<b.Right && b.Left<a.Right && a.Top<b.Bottom && b.Top<a.Bottom; }
    static bool Contains(Rect outer,Rect inner) { return outer.Left<=inner.Left && outer.Top<=inner.Top && outer.Right>=inner.Right && outer.Bottom>=inner.Bottom; }
    static void Dimensions(Rect rectangle) {
        Require(rectangle.Width>0 && rectangle.Height>0 && rectangle.Width<=MaxDimension && rectangle.Height<=MaxDimension &&
            rectangle.Width*rectangle.Height<=MaxPixels,"FRAME_DIMENSIONS_INVALID");
    }
    static bool Covered(Rect capture,List<Rect> monitors) {
        if(monitors.Count==0 || monitors.Count>64) return false;
        var cuts=new SortedSet<int>(); cuts.Add(capture.Left); cuts.Add(capture.Right);
        foreach(var monitor in monitors) if(Intersects(capture,monitor)) { cuts.Add(Math.Max(capture.Left,monitor.Left)); cuts.Add(Math.Min(capture.Right,monitor.Right)); }
        var xs=new List<int>(cuts);
        for(int x=1;x<xs.Count;x++) {
            var intervals=new List<Rect>();
            foreach(var monitor in monitors) if(monitor.Left<=xs[x-1] && monitor.Right>=xs[x] && Intersects(capture,monitor))
                intervals.Add(new Rect(0,Math.Max(capture.Top,monitor.Top),0,Math.Min(capture.Bottom,monitor.Bottom)));
            intervals.Sort(delegate(Rect a,Rect b) { return a.Top.CompareTo(b.Top); });
            int through=capture.Top;
            foreach(var interval in intervals) { if(interval.Top>through) return false; through=Math.Max(through,interval.Bottom); }
            if(through<capture.Bottom) return false;
        }
        return true;
    }
    static List<Rect> Monitors() {
        var result=new List<Rect>();
        MonitorCallback callback=delegate(IntPtr monitor,IntPtr dc,ref Rect rect,IntPtr data) {result.Add(rect);return result.Count<=64;};
        Require(EnumDisplayMonitors(IntPtr.Zero,IntPtr.Zero,callback,IntPtr.Zero) && result.Count>0 && result.Count<=64,"FRAME_MONITORS_UNAVAILABLE");
        return result;
    }
    static string ObjectName(IntPtr handle) {
        int needed; GetUserObjectInformation(handle,2,null,0,out needed);
        Require(needed>0 && needed<=1024,"FRAME_DESKTOP_UNAVAILABLE");
        var name=new StringBuilder(needed/2+1);
        Require(GetUserObjectInformation(handle,2,name,name.Capacity*2,out needed),"FRAME_DESKTOP_UNAVAILABLE");
        return name.ToString();
    }
    static int VerifyDesktop() {
        Require(String.Equals(ObjectName(GetProcessWindowStation()),"WinSta0",StringComparison.OrdinalIgnoreCase),"FRAME_INTERACTIVE_DESKTOP_REQUIRED");
        IntPtr desktop=OpenInputDesktop(0,false,0x0001);
        Require(desktop!=IntPtr.Zero,"FRAME_INPUT_DESKTOP_UNAVAILABLE");
        try {
            string input=ObjectName(desktop),current=ObjectName(GetThreadDesktop(GetCurrentThreadId()));
            Require(String.Equals(input,"Default",StringComparison.OrdinalIgnoreCase) && String.Equals(input,current,StringComparison.OrdinalIgnoreCase),"FRAME_DESKTOP_NOT_CURRENT");
        } finally { CloseDesktop(desktop); }
        uint session;
        Require(ProcessIdToSessionId(GetCurrentProcessId(),out session),"FRAME_SESSION_UNAVAILABLE");
        IntPtr buffer; int size;
        Require(WTSQuerySessionInformation(IntPtr.Zero,session,8,out buffer,out size),"FRAME_SESSION_UNAVAILABLE");
        try { Require(size==4 && Marshal.ReadInt32(buffer)==0,"FRAME_SESSION_NOT_ACTIVE"); }
        finally { WTSFreeMemory(buffer); }
        return checked((int)session);
    }
    static void NoLinks(string file) {
        string current=Path.GetFullPath(file);
        for(;;) {
            try { Require((File.GetAttributes(current)&FileAttributes.ReparsePoint)==0,"FRAME_REPARSE_PATH_REFUSED"); }
            catch(FileNotFoundException) {} catch(DirectoryNotFoundException) {}
            string parent=Path.GetDirectoryName(current);
            if(String.IsNullOrEmpty(parent) || String.Equals(parent,current,StringComparison.OrdinalIgnoreCase)) return;
            current=parent;
        }
    }
    static string OutputRoot() {
        string app=Path.GetFullPath(AppDomain.CurrentDomain.BaseDirectory).TrimEnd(Path.DirectorySeparatorChar,Path.AltDirectorySeparatorChar);
        Require(String.Equals(Path.GetFileName(app),"ui-host",StringComparison.OrdinalIgnoreCase),"FRAME_PROJECT_LOCATION_INVALID");
        string state=Path.GetDirectoryName(app);
        Require(String.Equals(Path.GetFileName(state),"state",StringComparison.OrdinalIgnoreCase),"FRAME_PROJECT_LOCATION_INVALID");
        string root=Path.Combine(state,"diagnostics"); NoLinks(root);
        Directory.CreateDirectory(root); NoLinks(root); return Path.GetFullPath(root);
    }
    sealed class Snapshot {
        internal IntPtr Window; internal uint Pid,ThreadId,Dpi; internal long CreationTime,Qpc;
        internal string Executable,Utc; internal int Session;
        internal Rect Client,WindowRect,CaptureRect; internal int TopLevelWindowsChecked;
        internal List<object> Overlaps=new List<object>();
        internal object Report() { return Data("hwnd",Window.ToInt64().ToString(CultureInfo.InvariantCulture),"pid",Pid,"threadId",ThreadId,
            "processCreatedFileTimeUtc",CreationTime.ToString(CultureInfo.InvariantCulture),"executable",Executable,"foregroundMatched",true,
            "visible",true,"minimized",false,"dpi",Dpi,"dpiAwareness","per-monitor-v2","sessionId",Session,"inputDesktopMatched",true,
            "windowRect",WindowRect.Report(),"clientRect",Client.Report(),"captureRect",CaptureRect.Report(),
            "observedAtUtc",Utc,"qpc",Qpc.ToString(CultureInfo.InvariantCulture),"qpcFrequency",Stopwatch.Frequency,
            "topLevelWindowsChecked",TopLevelWindowsChecked,"overlappingWindows",Overlaps); }
    }
    static bool Stable(Snapshot a,Snapshot b) { return a.Window==b.Window && a.Pid==b.Pid && a.ThreadId==b.ThreadId &&
        a.CreationTime==b.CreationTime && a.Dpi==b.Dpi && a.Session==b.Session && String.Equals(a.Executable,b.Executable,StringComparison.OrdinalIgnoreCase) &&
        Same(a.Client,b.Client) && Same(a.WindowRect,b.WindowRect) && Same(a.CaptureRect,b.CaptureRect); }
    static string Executable(uint pid,out long created) {
        IntPtr process=OpenProcess(0x1000,false,pid);
        Require(process!=IntPtr.Zero,"FRAME_PROCESS_QUERY_FAILED");
        try {
            var file=new StringBuilder(32768); int length=file.Capacity;
            Require(QueryFullProcessImageName(process,0,file,ref length),"FRAME_PROCESS_QUERY_FAILED");
            FileTime creation,exit,kernel,user;
            Require(GetProcessTimes(process,out creation,out exit,out kernel,out user),"FRAME_PROCESS_QUERY_FAILED");
            created=creation.Ticks; return Path.GetFullPath(file.ToString());
        } finally { CloseHandle(process); }
    }
    static bool Cloaked(IntPtr hwnd) {
        int cloaked;
        Require(DwmGetWindowAttribute(hwnd,14,out cloaked,4)>=0,"FRAME_WINDOW_VISIBILITY_UNAVAILABLE");
        return cloaked!=0;
    }
    static bool OwnedBy(IntPtr window,IntPtr target) {
        var visited=new HashSet<IntPtr>();
        for(int count=0;window!=IntPtr.Zero && count<64;count++) {
            window=GetWindow(window,4);
            if(window==target) return true;
            if(window!=IntPtr.Zero && !visited.Add(window)) throw new Fault("FRAME_OWNER_CHAIN_INVALID");
        }
        Require(window==IntPtr.Zero,"FRAME_OWNER_CHAIN_INVALID"); return false;
    }
    static object Occluder(IntPtr window,Rect rectangle,Rect area,bool owned) {
        uint pid;uint thread=GetWindowThreadProcessId(window,out pid);
        var windowClass=new StringBuilder(257);int classLength=GetClassName(window,windowClass,windowClass.Capacity);
        uint style=unchecked((uint)GetWindowLongPtr(window,-16).ToInt64()),extended=unchecked((uint)GetWindowLongPtr(window,-20).ToInt64());
        uint colorKey=0,flags=0;byte alpha=0;
        bool layeredAttributes=(extended&0x00080000)!=0 && GetLayeredWindowAttributes(window,out colorKey,out alpha,out flags);
        Rect frame;bool frameAvailable=DwmGetWindowAttributeRect(window,9,out frame,Marshal.SizeOf(typeof(Rect)))>=0;
        int cloak;bool cloakAvailable=DwmGetWindowAttribute(window,14,out cloak,4)>=0;
        var intersection=new Rect(Math.Max(rectangle.Left,area.Left),Math.Max(rectangle.Top,area.Top),Math.Min(rectangle.Right,area.Right),Math.Min(rectangle.Bottom,area.Bottom));
        return Data("hwnd",window.ToInt64().ToString(CultureInfo.InvariantCulture),"pid",pid,"threadId",thread,
            "class",classLength>0?windowClass.ToString():null,"style","0x"+style.ToString("X8"),"exStyle","0x"+extended.ToString("X8"),
            "ownerHwnd",GetWindow(window,4).ToInt64().ToString(CultureInfo.InvariantCulture),"ownedByTarget",owned,
            "rect",rectangle.Report(),"intersection",Intersects(rectangle,area)?intersection.Report():null,
            "dwmFrameBoundsAvailable",frameAvailable,"dwmFrameBounds",frameAvailable?frame.Report():null,
            "cloakedAvailable",cloakAvailable,"cloaked",cloakAvailable?(object)(cloak!=0):null,
            "layered",(extended&0x00080000)!=0,"transparentStyle",(extended&0x20)!=0,
            "layeredAttributesAvailable",layeredAttributes,"layeredAlpha",layeredAttributes?(object)alpha:null,
            "layeredFlags",layeredAttributes?(object)flags:null,"layeredColorKey",layeredAttributes?(object)colorKey:null,
            "titleRead",false);
    }
    sealed class OcclusionCheck { internal int WindowsChecked; internal List<object> Overlaps=new List<object>(); }
    static OcclusionCheck VerifyUncovered(IntPtr target,Rect area,bool allowOverlap) {
        bool seen=false; int count=0; Fault failure=null; var result=new OcclusionCheck();
        WindowCallback callback=delegate(IntPtr window,IntPtr data) {
            try {
                count++; Require(count<=16384,"FRAME_WINDOW_ENUMERATION_LIMIT");
                if(window==target) { seen=true; return true; }
                if(!IsWindowVisible(window) || IsIconic(window) || Cloaked(window)) return true;
                Rect rectangle;
                Require(GetWindowRect(window,out rectangle),"FRAME_WINDOW_ENUMERATION_CHANGED");
                if(rectangle.Width<=0 || rectangle.Height<=0) return true;
                if(OwnedBy(window,target)) throw new Fault("FRAME_OWNED_POPUP_VISIBLE",Occluder(window,rectangle,area,true));
                if(!seen && Intersects(area,rectangle)) {
                    object diagnostic=Occluder(window,rectangle,area,false);
                    if(!allowOverlap) throw new Fault("FRAME_WINDOW_OCCLUDED",diagnostic);
                    Require(result.Overlaps.Count<16,"FRAME_OCCLUSION_LIMIT"); result.Overlaps.Add(diagnostic);
                }
                return true;
            } catch(Fault error) { failure=error;return false; }
            catch {failure=new Fault("FRAME_WINDOW_ENUMERATION_FAILED");return false;}
        };
        bool complete=EnumWindows(callback,IntPtr.Zero);
        if(failure!=null) throw failure;
        Require(complete && seen,"FRAME_WINDOW_ENUMERATION_FAILED"); result.WindowsChecked=count;return result;
    }
    static Snapshot Observe(Request request) {
        var snapshot=new Snapshot {Window=request.Window,Utc=DateTime.UtcNow.ToString("o"),Qpc=Stopwatch.GetTimestamp()};
        snapshot.Session=VerifyDesktop();
        Require(IsWindow(request.Window) && GetAncestor(request.Window,2)==request.Window,"FRAME_TOP_LEVEL_WINDOW_REQUIRED");
        Require(GetForegroundWindow()==request.Window,"FRAME_FOREGROUND_REQUIRED");
        Require(IsWindowVisible(request.Window) && !IsIconic(request.Window) && !Cloaked(request.Window),"FRAME_WINDOW_NOT_VISIBLE");
        Require(IsWindowEnabled(request.Window),"FRAME_WINDOW_DISABLED");
        Require(GetWindow(request.Window,4)==IntPtr.Zero,"FRAME_UNOWNED_MAIN_WINDOW_REQUIRED");
        snapshot.ThreadId=GetWindowThreadProcessId(request.Window,out snapshot.Pid);
        Require(snapshot.ThreadId!=0 && snapshot.Pid!=0,"FRAME_PROCESS_QUERY_FAILED");
        snapshot.Executable=Executable(snapshot.Pid,out snapshot.CreationTime);
        Require(String.Equals(snapshot.Executable,request.Executable,StringComparison.OrdinalIgnoreCase),"FRAME_EXECUTABLE_MISMATCH");
        uint session; Require(ProcessIdToSessionId(snapshot.Pid,out session) && session==snapshot.Session,"FRAME_SESSION_MISMATCH");
        snapshot.Dpi=GetDpiForWindow(request.Window);
        Require(snapshot.Dpi>=48 && snapshot.Dpi<=768,"FRAME_DPI_UNAVAILABLE");
        Require(GetWindowRect(request.Window,out snapshot.WindowRect) && GetClientRect(request.Window,out snapshot.Client),"FRAME_GEOMETRY_UNAVAILABLE");
        var start=new Point {X=snapshot.Client.Left,Y=snapshot.Client.Top}; var end=new Point {X=snapshot.Client.Right,Y=snapshot.Client.Bottom};
        Require(ClientToScreen(request.Window,ref start) && ClientToScreen(request.Window,ref end),"FRAME_GEOMETRY_UNAVAILABLE");
        snapshot.CaptureRect=new Rect(start.X,start.Y,end.X,end.Y); Dimensions(snapshot.CaptureRect);
        Require(Contains(snapshot.WindowRect,snapshot.CaptureRect),"FRAME_GEOMETRY_INCONSISTENT");
        Require(Covered(snapshot.CaptureRect,Monitors()),"FRAME_WINDOW_OFF_SCREEN");
        var occlusion=VerifyUncovered(request.Window,snapshot.CaptureRect,request.AllowOverlap);
        snapshot.TopLevelWindowsChecked=occlusion.WindowsChecked;snapshot.Overlaps=occlusion.Overlaps;
        Require(GetForegroundWindow()==request.Window,"FRAME_FOREGROUND_CHANGED");
        return snapshot;
    }
    static byte[] Png(Bitmap bitmap,out int stride) {
        var locked=bitmap.LockBits(new Rectangle(0,0,bitmap.Width,bitmap.Height),ImageLockMode.ReadOnly,PixelFormat.Format32bppRgb);
        try { stride=locked.Stride; Require(Math.Abs((long)stride)>=bitmap.Width*4L,"FRAME_STRIDE_INVALID"); }
        finally {bitmap.UnlockBits(locked);}
        using(var stream=new MemoryStream()) { bitmap.Save(stream,ImageFormat.Png); Require(stream.Length>0 && stream.Length<=MaxPngBytes,"FRAME_IMAGE_TOO_LARGE");return stream.ToArray(); }
    }
    static object Capture(Request request) {
        Require(File.Exists(request.Executable),"FRAME_EXECUTABLE_NOT_FOUND"); NoLinks(request.Executable);
        string outputRoot=OutputRoot();
        UiAccessed=true;
        Require(SetProcessDpiAwarenessContext(new IntPtr(-4)),"FRAME_DPI_AWARENESS_UNAVAILABLE");
        Snapshot before=Observe(request),after; int stride; byte[] bytes;
        long started=Stopwatch.GetTimestamp();
        using(var bitmap=new Bitmap((int)before.CaptureRect.Width,(int)before.CaptureRect.Height,PixelFormat.Format32bppRgb)) {
            using(var drawing=Graphics.FromImage(bitmap)) drawing.CopyFromScreen(before.CaptureRect.Left,before.CaptureRect.Top,0,0,bitmap.Size,CopyPixelOperation.SourceCopy);
            FrameAcquired=true;
            after=Observe(request);
            Require(Stable(before,after),"FRAME_BINDING_CHANGED");
            Require((Stopwatch.GetTimestamp()-started)*1000.0/Stopwatch.Frequency<=1500,"FRAME_CAPTURE_TOO_SLOW");
            bytes=Png(bitmap,out stride);
        }
        string name="wechat-frame-"+Guid.NewGuid().ToString("D")+".png",file=Path.Combine(outputRoot,name);
        bool created=false;
        try {
            NoLinks(file);
            using(var output=new FileStream(file,FileMode.CreateNew,FileAccess.Write,FileShare.None)) {created=true;output.Write(bytes,0,bytes.Length);output.Flush(true);}
            string hash;using(var sha=SHA256.Create()) hash=BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-","").ToLowerInvariant();
            return Data("ok",true,"mode","window-frame-diagnostic","method","gdi-screen-client-area-srccopy","readOnly",true,"uiAccessed",true,
                "captured",true,"imageSaved",true,"inputSent",false,"ready",false,"diagnosticOnly",true,"eligibleForAutomation",false,
                "occlusionVerified",false,"diagnosticOverlapAllowed",request.AllowOverlap,
                "accountVerified",false,"targetVerified",false,"draftVerified",false,"focusVerified",false,
                "image",Data("file",file,"sha256",hash,"bytes",bytes.Length,"width",before.CaptureRect.Width,"height",before.CaptureRect.Height,
                    "sourcePixelFormat","Format32bppRgb","sourceStride",stride,"pngBitDepth",bytes[24],"pngColorType",bytes[25],"scaled",false),
                "before",before.Report(),"after",after.Report(),"bindingStable",true,
                "occlusion",Data("visibleTopLevelWindowsChecked",true,"ownedPopupCheckPassed",true,"detectedOcclusion",before.Overlaps.Count>0 || after.Overlaps.Count>0,
                    "enumeratedWindowsUncovered",before.Overlaps.Count==0 && after.Overlaps.Count==0,
                    "allOverlaysVerified",false,"visualContentStabilityVerified",false,"limitation","Guards sample enumerated windows before and after capture; compositor overlays and transient changes are not proven absent."),
                "captureDurationMs",(after.Qpc-started)*1000.0/Stopwatch.Frequency);
        } catch {
            if(created && String.Equals(Path.GetDirectoryName(Path.GetFullPath(file)),outputRoot,StringComparison.OrdinalIgnoreCase) && name==Path.GetFileName(file)) {
                try {NoLinks(file);File.Delete(file);}catch{}
            }
            throw;
        }
    }
    static object SelfTest() {
        int checks=0;
        Action<bool> check=delegate(bool value) {Require(value,"FRAME_SELF_TEST_FAILED");checks++;};
        Rect a=new Rect(10,20,110,220); Dimensions(a);check(a.Width==100 && a.Height==200);
        check(Intersects(a,new Rect(109,219,130,240)) && !Intersects(a,new Rect(110,20,150,220)));
        check(Contains(new Rect(-100,-100,200,300),a) && !Contains(a,new Rect(0,0,20,30)));
        check(Covered(new Rect(-100,0,100,100),new List<Rect>{new Rect(-100,0,0,100),new Rect(0,0,100,100)}));
        check(!Covered(new Rect(-100,0,100,100),new List<Rect>{new Rect(-100,0,-10,100),new Rect(0,0,100,100)}));
        check(Covered(a,new List<Rect>{new Rect(0,0,200,150),new Rect(0,100,200,300)}));
        check(!Covered(a,new List<Rect>{new Rect(0,0,200,150)}));
        bool rejected=false;try{Dimensions(new Rect(Int32.MinValue,0,Int32.MaxValue,100));}catch(Fault){rejected=true;}check(rejected);
        var request=Parse(new string[]{"--capture","--executable",@"C:\fixture\client.exe","--hwnd","12345"});check(request.Window.ToInt64()==12345 && !request.AllowOverlap);
        var overlapRequest=Parse(new string[]{"--capture","--executable",@"C:\fixture\client.exe","--hwnd","12345","--diagnostic-allow-overlap"});check(overlapRequest.AllowOverlap);
        rejected=false;try{Parse(new string[]{"--capture","--executable",@"C:\fixture\client.exe","--hwnd","-1"});}catch(Fault){rejected=true;}check(rejected);
        rejected=false;try{Parse(new string[]{"--capture","--executable",@"C:client.exe","--hwnd","1"});}catch(Fault){rejected=true;}check(rejected);
        var first=new Snapshot {Window=new IntPtr(2),Pid=3,ThreadId=4,CreationTime=5,Dpi=144,Session=1,Executable=@"C:\fixture.exe",Client=a,WindowRect=a,CaptureRect=a};
        var second=new Snapshot {Window=new IntPtr(2),Pid=3,ThreadId=4,CreationTime=5,Dpi=144,Session=1,Executable=@"c:\FIXTURE.exe",Client=a,WindowRect=a,CaptureRect=a};
        check(Stable(first,second)); second.CreationTime++;check(!Stable(first,second));second.CreationTime--;second.CaptureRect=new Rect(11,20,111,220);check(!Stable(first,second));
        using(var bitmap=new Bitmap(13,7,PixelFormat.Format32bppRgb)) {
            using(var drawing=Graphics.FromImage(bitmap)) {drawing.Clear(Color.FromArgb(17,93,201));drawing.FillRectangle(Brushes.White,8,2,3,2);}
            int stride;byte[] encoded=Png(bitmap,out stride);check(encoded[0]==137 && encoded[1]==80 && stride==52);
            using(var input=new MemoryStream(encoded))using(var decoded=new Bitmap(input))check(decoded.Width==13 && decoded.Height==7 && decoded.GetPixel(0,0).ToArgb()==Color.FromArgb(17,93,201).ToArgb() && decoded.GetPixel(9,2).ToArgb()==Color.White.ToArgb());
        }
        return Data("ok",true,"mode","self-test","checks",checks,"uiAccessed",false,"captured",false,"inputSent",false,"ready",false,
            "diagnosticOnly",true,"eligibleForAutomation",false,"occlusionVerified",false);
    }

    delegate bool WindowCallback(IntPtr hwnd,IntPtr data);
    delegate bool MonitorCallback(IntPtr monitor,IntPtr dc,ref Rect rectangle,IntPtr data);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr hwnd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr hwnd);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr hwnd,uint flags);
    [DllImport("user32.dll")] static extern IntPtr GetWindow(IntPtr hwnd,uint command);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd,out uint pid);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd,out Rect rectangle);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr hwnd,out Rect rectangle);
    [DllImport("user32.dll")] static extern bool ClientToScreen(IntPtr hwnd,ref Point point);
    [DllImport("user32.dll")] static extern bool EnumWindows(WindowCallback callback,IntPtr data);
    [DllImport("user32.dll")] static extern bool EnumDisplayMonitors(IntPtr dc,IntPtr clip,MonitorCallback callback,IntPtr data);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr hwnd,StringBuilder name,int maximum);
    [DllImport("user32.dll",EntryPoint="GetWindowLongPtrW")] static extern IntPtr GetWindowLongPtr(IntPtr hwnd,int index);
    [DllImport("user32.dll")] static extern bool GetLayeredWindowAttributes(IntPtr hwnd,out uint colorKey,out byte alpha,out uint flags);
    [DllImport("user32.dll")] static extern IntPtr OpenInputDesktop(uint flags,bool inherit,uint access);
    [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll")] static extern IntPtr GetThreadDesktop(uint thread);
    [DllImport("user32.dll")] static extern IntPtr GetProcessWindowStation();
    [DllImport("user32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool GetUserObjectInformation(IntPtr handle,int index,StringBuilder information,int length,out int needed);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr hwnd,int attribute,out int value,int bytes);
    [DllImport("dwmapi.dll",EntryPoint="DwmGetWindowAttribute")] static extern int DwmGetWindowAttributeRect(IntPtr hwnd,int attribute,out Rect value,int bytes);
    [DllImport("kernel32.dll")] static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll")] static extern uint GetCurrentProcessId();
    [DllImport("kernel32.dll")] static extern bool ProcessIdToSessionId(uint pid,out uint session);
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access,bool inherit,uint pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr process,uint flags,StringBuilder file,ref int length);
    [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr process,out FileTime created,out FileTime exited,out FileTime kernel,out FileTime user);
    [DllImport("wtsapi32.dll",CharSet=CharSet.Unicode)] static extern bool WTSQuerySessionInformation(IntPtr server,uint session,int info,out IntPtr buffer,out int bytes);
    [DllImport("wtsapi32.dll")] static extern void WTSFreeMemory(IntPtr buffer);
}
