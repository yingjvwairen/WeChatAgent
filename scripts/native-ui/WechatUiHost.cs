// Windows-only development preview. UIA is read-only; all editing uses SendInput.
// The host refuses to guess controls or fall back to coordinates when UIA is absent.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;
using System.Windows.Automation;
using System.Windows.Automation.Text;
using System.Windows.Forms;

internal static class WechatUiHost
{
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 131072, RecursionLimit = 24 };
    // A 32-bit value survives the mouse path observed on this host. Ownership
    // still requires the complete pointer-sized value and the injected flag.
    static readonly UIntPtr InputMarker = new UIntPtr(0x55493031U);
    static readonly string SessionToken = Guid.NewGuid().ToString("N");
    static readonly HookProc KeyboardCallback = OnKeyboard;
    static readonly HookProc MouseCallback = OnMouse;
    static readonly Dictionary<string, ControlType> Types = new Dictionary<string, ControlType>(StringComparer.OrdinalIgnoreCase) {
        {"Edit",ControlType.Edit},{"Document",ControlType.Document},{"Text",ControlType.Text},
        {"Button",ControlType.Button},{"Pane",ControlType.Pane},{"Window",ControlType.Window},
        {"Custom",ControlType.Custom},{"Group",ControlType.Group},{"ListItem",ControlType.ListItem},
        {"List",ControlType.List},{"MenuItem",ControlType.MenuItem},{"ToolBar",ControlType.ToolBar}
    };
    static Dictionary<string, object> Config;
    static string Executable;
    static bool InputEnabled;
    static volatile bool Stopping;
    static bool SendAttempted;
    static IntPtr KeyboardHook, MouseHook;
    static long ActivityRevision;
    static long LastActivity;
    static int IdleRequired;
    static Control Dispatcher;
    static Mutex InputGate;

    sealed class Fault : Exception { internal Fault(string code) : base(code) {} }
    sealed class Snapshot
    {
        internal IntPtr Window;
        internal AutomationElement Editor;
        internal string Draft, Token, Account, Target;
        internal long Revision;
        internal long Idle;
    }

    static Dictionary<string, object> Obj(object value) { return value as Dictionary<string, object>; }
    static object Get(Dictionary<string, object> obj, string key) { object value; return obj != null && obj.TryGetValue(key, out value) ? value : null; }
    static string Str(Dictionary<string, object> obj, string key) { return Get(obj, key) as string; }
    static Dictionary<string, object> Map(Dictionary<string, object> obj, string key) { return Obj(Get(obj,key)); }
    static Dictionary<string, object> Result(params object[] pairs)
    {
        var result = new Dictionary<string, object>();
        for (int i=0;i<pairs.Length;i+=2) result[(string)pairs[i]]=pairs[i+1];
        return result;
    }
    static long Integer(object value, string code)
    {
        if (value == null || value is bool || value is string) throw new Fault(code);
        try { decimal n=Convert.ToDecimal(value,CultureInfo.InvariantCulture); if (n<0 || n>9007199254740991M || decimal.Truncate(n)!=n) throw new Fault(code); return (long)n; }
        catch (Fault) { throw; } catch { throw new Fault(code); }
    }
    static string Limited(string value, int max, string code)
    {
        if (String.IsNullOrEmpty(value) || value.Length>max || value.IndexOf('\0')>=0) throw new Fault(code);
        return value;
    }
    static string NormalizeDraft(string value) { return (value??"").Replace("\r\n","\n").Replace("\r","\n"); }
    static long Now() { return unchecked((long)GetTickCount64()); }
    static void HumanActivity() { Interlocked.Exchange(ref LastActivity,Now()); Interlocked.Increment(ref ActivityRevision); }

    [STAThread]
    static int Main(string[] args)
    {
        Console.InputEncoding=new UTF8Encoding(false); Console.OutputEncoding=new UTF8Encoding(false);
        if (args.Length==1 && args[0]=="--self-test") return SelfTest();
        try
        {
            string configPath=null;
            for(int i=0;i<args.Length;i++) {
                if(args[i]=="--config" && i+1<args.Length) configPath=args[++i];
                else if(args[i]=="--enable-input") InputEnabled=true;
                else throw new Fault("UI_ARGUMENT_INVALID");
            }
            if(configPath==null) throw new Fault("UI_CONFIG_REQUIRED");
            var info=new FileInfo(Path.GetFullPath(configPath));
            if(!info.Exists || info.Length>131072) throw new Fault("UI_CONFIG_INVALID");
            Config=Obj(Json.DeserializeObject(File.ReadAllText(info.FullName,Encoding.UTF8)));
            ValidateConfig();
            if(InputEnabled) InputGate=AcquireInputGate("Local\\WeChatAgent.UiInput.v1");
            LastActivity=Now();
            using(var process=Process.GetCurrentProcess())
            {
                IntPtr module=GetModuleHandle(process.MainModule.ModuleName);
                KeyboardHook=SetWindowsHookEx(13,KeyboardCallback,module,0);
                MouseHook=SetWindowsHookEx(14,MouseCallback,module,0);
            }
            if(KeyboardHook==IntPtr.Zero || MouseHook==IntPtr.Zero) throw new Fault("UI_ACTIVITY_MONITOR_UNAVAILABLE");
            Dispatcher=new Control(); var handle=Dispatcher.Handle;
            var reader=new Thread(ReadRequests); reader.IsBackground=true; reader.SetApartmentState(ApartmentState.MTA); reader.Start();
            Application.Run();
            return 0;
        }
        catch(Fault error) { Write(Result("id",null,"ok",false,"error",Result("code",error.Message))); return 1; }
        catch { Write(Result("id",null,"ok",false,"error",Result("code","UI_HOST_FAILED"))); return 1; }
        finally
        {
            Stopping=true;
            if(KeyboardHook!=IntPtr.Zero) UnhookWindowsHookEx(KeyboardHook);
            if(MouseHook!=IntPtr.Zero) UnhookWindowsHookEx(MouseHook);
            if(Dispatcher!=null) Dispatcher.Dispose();
            if(InputGate!=null) { try { InputGate.ReleaseMutex(); } finally { InputGate.Dispose(); } }
        }
    }
    static Mutex AcquireInputGate(string name)
    {
        var gate=new Mutex(false,name);
        bool acquired;
        try { acquired=gate.WaitOne(0); }
        catch(AbandonedMutexException) { acquired=true; }
        catch { gate.Dispose(); throw; }
        if(!acquired) { gate.Dispose(); throw new Fault("UI_INPUT_ALREADY_OWNED"); }
        return gate;
    }
    static void ValidateConfig()
    {
        if(Config==null) throw new Fault("UI_CONFIG_INVALID");
        string value=Limited(Str(Config,"executable"),1024,"UI_EXECUTABLE_REQUIRED");
        if(!Path.IsPathRooted(value)) throw new Fault("UI_EXECUTABLE_REQUIRED");
        Executable=Path.GetFullPath(value);
        string file=Path.GetFileName(Executable);
        if(!String.Equals(file,"Weixin.exe",StringComparison.OrdinalIgnoreCase) && !String.Equals(file,"WeChat.exe",StringComparison.OrdinalIgnoreCase)) throw new Fault("UI_EXECUTABLE_INVALID");
        long idle=Get(Config,"idleMs")==null?10000:Integer(Get(Config,"idleMs"),"UI_IDLE_INVALID");
        if(idle<1000 || idle>300000) throw new Fault("UI_IDLE_INVALID");
        IdleRequired=(int)idle;
        foreach(string key in new[]{"windowClass","windowTitle"}) if(Get(Config,key)!=null) Limited(Str(Config,key),256,"UI_WINDOW_BINDING_INVALID");
    }
    static void Write(object response) { Console.WriteLine(Json.Serialize(response)); Console.Out.Flush(); }
    static void ReadRequests()
    {
        try
        {
            while(!Stopping)
            {
                string line=ReadBoundedLine(); if(line==null) break;
                object id=null;
                SendAttempted=false;
                try {
                    if(line.Length>65536) throw new Fault("UI_REQUEST_TOO_LARGE");
                    var request=Obj(Json.DeserializeObject(line)); if(request==null) throw new Fault("UI_REQUEST_INVALID");
                    id=Get(request,"id"); ValidateRequestId(id);
                    var action=Str(request,"action"); object result;
                    if(action=="stop") { Write(Result("id",id,"ok",true,"result",Result("stopped",true))); break; }
                    if(action=="inspect") result=Inspect();
                    else if(action=="observe") result=Observe(request);
                    else if(action=="type" || action=="submit") result=Execute(request,action);
                    else throw new Fault("UI_ACTION_INVALID");
                    Write(Result("id",id,"ok",true,"result",result));
                } catch(Fault error) { Write(Result("id",id,"ok",false,"error",Result("code",error.Message,"attempted",SendAttempted))); }
                  catch(ElementNotAvailableException) { Write(Result("id",id,"ok",false,"error",Result("code","UI_ELEMENT_CHANGED","attempted",SendAttempted))); }
                  catch { Write(Result("id",id,"ok",false,"error",Result("code","UI_REQUEST_FAILED","attempted",SendAttempted))); }
            }
        }
        finally { Stopping=true; try { Dispatcher.BeginInvoke((Action)delegate { Application.ExitThread(); }); } catch {} }
    }

    static void ValidateRequestId(object id)
    {
        if(id is string) { Limited((string)id,100,"UI_REQUEST_ID_INVALID"); return; }
        Integer(id,"UI_REQUEST_ID_INVALID");
    }

    static string ReadBoundedLine()
    {
        var value=new StringBuilder(); int character;
        while((character=Console.In.Read())!=-1) {
            if(character=='\n') return value.ToString().TrimEnd('\r');
            // Keep one extra character so the request loop can reject the entire line.
            if(value.Length<=65536) value.Append((char)character);
        }
        return value.Length==0?null:value.ToString();
    }

    static Dictionary<string,object> Observe(Dictionary<string,object> request)
    {
        try {
            Snapshot state=Capture(request);
            return Result("ready",true,"reason",null,"account",state.Account,"target",state.Target,"foreground",true,
                "idleMs",state.Idle,"draft",state.Draft,"editorToken",state.Token,"activityRevision",state.Revision,"inputEnabled",InputEnabled);
        } catch(Fault error) {
            return Result("ready",false,"reason",error.Message,"account",null,"target",null,"foreground",IsConfiguredForeground(),
                "idleMs",Math.Max(0,Now()-Interlocked.Read(ref LastActivity)),"draft",null,"editorToken",null,
                "activityRevision",Interlocked.Read(ref ActivityRevision),"inputEnabled",InputEnabled);
        } catch(ElementNotAvailableException) {
            return Result("ready",false,"reason","UI_ELEMENT_CHANGED","account",null,"target",null,"foreground",false,
                "idleMs",0,"draft",null,"editorToken",null,"activityRevision",Interlocked.Read(ref ActivityRevision),"inputEnabled",InputEnabled);
        }
    }
    static Snapshot Capture(Dictionary<string,object> request)
    {
        if(Stopping) throw new Fault("UI_HOST_STOPPING");
        if(!DesktopAvailable()) throw new Fault("UI_DESKTOP_UNAVAILABLE");
        long revision=Interlocked.Read(ref ActivityRevision);
        IntPtr window=FindWindow();
        if(GetForegroundWindow()!=window || GetAncestor(window,2)!=window) throw new Fault("UI_NOT_FOREGROUND");
        string account=Limited(Str(request,"account"),256,"UI_ACCOUNT_REQUIRED");
        string target=Limited(Str(request,"target"),256,"UI_TARGET_REQUIRED");
        var accountBinding=Map(Config,"account");
        var targetBinding=Map(Map(Config,"targets"),target);
        if(accountBinding==null || targetBinding==null || Map(Config,"editor")==null) throw new Fault("UI_BINDING_REQUIRED");
        if(Str(accountBinding,"kind")!="wechat-id" || (Str(targetBinding,"kind")!="wechat-id" && Str(targetBinding,"kind")!="chatroom-id")) throw new Fault("UI_IDENTITY_BINDING_REQUIRED");
        if(Str(accountBinding,"expected")!=account) throw new Fault("UI_ACCOUNT_MISMATCH");
        if(Limited(Str(targetBinding,"expected"),256,"UI_TARGET_BINDING_INVALID")!=target) throw new Fault("UI_TARGET_BINDING_INVALID");
        AutomationElement root=AutomationElement.FromHandle(window);
        if(!IdentityMatches(root,accountBinding)) throw new Fault("UI_ACCOUNT_UNVERIFIED");
        if(!IdentityMatches(root,targetBinding)) throw new Fault("UI_TARGET_UNVERIFIED");
        AutomationElement editor=Unique(root,Map(Map(Config,"editor"),"selector"),"UI_EDITOR_UNAVAILABLE");
        var current=editor.Current;
        if(!current.IsEnabled || current.IsOffscreen || !current.IsKeyboardFocusable || current.IsPassword ||
            (current.ControlType!=ControlType.Edit && current.ControlType!=ControlType.Document)) throw new Fault("UI_EDITOR_UNAVAILABLE");
        if(!SameElement(AutomationElement.FocusedElement,editor)) throw new Fault("UI_EDITOR_NOT_FOCUSED");
        string draft=ReadEditor(editor);
        if(draft.Length>16000) throw new Fault("UI_DRAFT_TOO_LARGE");
        VerifyCaretAtEnd(editor);
        if(GetForegroundWindow()!=window || revision!=Interlocked.Read(ref ActivityRevision)) throw new Fault("UI_ACTIVITY_CHANGED");
        if(IsModifierDown()) throw new Fault("UI_KEYS_HELD");
        long idle=Math.Max(0,Now()-Interlocked.Read(ref LastActivity));
        if(idle<IdleRequired) throw new Fault("UI_USER_ACTIVE");
        string token=SessionToken+":"+window.ToInt64().ToString(CultureInfo.InvariantCulture)+":"+RuntimeId(editor);
        return new Snapshot { Window=window,Editor=editor,Draft=draft,Token=token,Account=account,Target=target,Revision=revision,Idle=idle };
    }
    static bool IdentityMatches(AutomationElement root, Dictionary<string,object> binding)
    {
        AutomationElement element=Unique(root,Map(binding,"selector"),"UI_IDENTITY_UNAVAILABLE");
        string property=Str(binding,"property");
        string actual;
        if(property=="name") actual=element.Current.Name;
        else if(property=="value") { object pattern; if(!element.TryGetCurrentPattern(ValuePattern.Pattern,out pattern)) throw new Fault("UI_IDENTITY_UNAVAILABLE"); actual=((ValuePattern)pattern).Current.Value; }
        else throw new Fault("UI_IDENTITY_BINDING_REQUIRED");
        return !element.Current.IsOffscreen && String.Equals(actual,Str(binding,"expected"),StringComparison.Ordinal);
    }
    static AutomationElement Unique(AutomationElement root, Dictionary<string,object> selector, string code)
    {
        Condition condition=BuildCondition(selector);
        AutomationElementCollection found=root.FindAll(TreeScope.Descendants,condition);
        if(found.Count!=1) throw new Fault(code);
        return found[0];
    }
    static Condition BuildCondition(Dictionary<string,object> selector)
    {
        if(selector==null || selector.Count==0 || selector.Count>4) throw new Fault("UI_SELECTOR_REQUIRED");
        var conditions=new List<Condition>();
        foreach(var pair in selector)
        {
            string value=Limited(pair.Value as string,256,"UI_SELECTOR_INVALID");
            if(pair.Key=="automationId") conditions.Add(new PropertyCondition(AutomationElement.AutomationIdProperty,value));
            else if(pair.Key=="name") conditions.Add(new PropertyCondition(AutomationElement.NameProperty,value));
            else if(pair.Key=="className") conditions.Add(new PropertyCondition(AutomationElement.ClassNameProperty,value));
            else if(pair.Key=="controlType") { ControlType type; if(!Types.TryGetValue(value,out type)) throw new Fault("UI_SELECTOR_INVALID"); conditions.Add(new PropertyCondition(AutomationElement.ControlTypeProperty,type)); }
            else throw new Fault("UI_SELECTOR_INVALID");
        }
        return conditions.Count==1?conditions[0]:new AndCondition(conditions.ToArray());
    }
    static string ReadEditor(AutomationElement editor)
    {
        object pattern;
        if(editor.TryGetCurrentPattern(ValuePattern.Pattern,out pattern)) {
            var value=(ValuePattern)pattern; if(value.Current.IsReadOnly) throw new Fault("UI_EDITOR_READONLY");
            return NormalizeDraft(value.Current.Value);
        }
        if(editor.TryGetCurrentPattern(TextPattern.Pattern,out pattern)) return NormalizeDraft(((TextPattern)pattern).DocumentRange.GetText(16001));
        throw new Fault("UI_DRAFT_UNREADABLE");
    }
    static void VerifyCaretAtEnd(AutomationElement editor)
    {
        object pattern;
        if(!editor.TryGetCurrentPattern(TextPattern.Pattern,out pattern)) throw new Fault("UI_CARET_UNVERIFIED");
        var text=(TextPattern)pattern;
        var ranges=text.GetSelection();
        if(ranges.Length!=1 || ranges[0].CompareEndpoints(TextPatternRangeEndpoint.Start,ranges[0],TextPatternRangeEndpoint.End)!=0 ||
            ranges[0].CompareEndpoints(TextPatternRangeEndpoint.End,text.DocumentRange,TextPatternRangeEndpoint.End)!=0) throw new Fault("UI_CARET_CHANGED");
    }
    static string RuntimeId(AutomationElement element) { return String.Join(".",Array.ConvertAll(element.GetRuntimeId(),delegate(int n) { return n.ToString(CultureInfo.InvariantCulture); })); }
    static bool SameElement(AutomationElement a, AutomationElement b) { return a!=null && b!=null && RuntimeId(a)==RuntimeId(b); }

    static object Execute(Dictionary<string,object> request,string action)
    {
        if(!InputEnabled) throw new Fault("UI_INPUT_DISABLED");
        var state=Capture(request);
        string draft=Str(request,"expectedDraft");
        if(draft==null || draft.Length>16000 || NormalizeDraft(draft)!=state.Draft) throw new Fault("UI_DRAFT_CHANGED");
        if(Str(request,"editorToken")!=state.Token) throw new Fault("UI_EDITOR_CHANGED");
        if(Integer(Get(request,"activityRevision"),"UI_ACTIVITY_REQUIRED")!=state.Revision) throw new Fault("UI_ACTIVITY_CHANGED");
        INPUT[] events;
        if(action=="type") events=TextEvents(Str(request,"text"));
        else {
            if(state.Draft.Length==0) throw new Fault("UI_EMPTY_DRAFT");
            var send=Map(Config,"send"); if(send==null) throw new Fault("UI_SEND_BINDING_REQUIRED");
            string key=Str(send,"key");
            if(key!=null) {
                if(Map(send,"selector")!=null) throw new Fault("UI_SEND_BINDING_INVALID");
                if(key!="Enter" && key!="Control+Enter") throw new Fault("UI_SEND_KEY_INVALID");
                events=ChordEvents(key);
            } else events=ButtonEvents(state,Map(send,"selector"));
        }
        // Check again after all UIA reads. Input is a minimal key pair/chord or one click,
        // never a whole message; subsequent activity prevents the next command.
        if(Stopping || GetForegroundWindow()!=state.Window || Interlocked.Read(ref ActivityRevision)!=state.Revision || IsModifierDown() || !SameElement(AutomationElement.FocusedElement,state.Editor)) throw new Fault("UI_ACTIVITY_CHANGED");
        SendAttempted=true;
        uint inserted=SendInput((uint)events.Length,events,Marshal.SizeOf(typeof(INPUT)));
        if(inserted!=events.Length) {
            ReleaseInsertedKeys(events,inserted);
            throw new Fault("UI_INPUT_UNCERTAIN");
        }
        return Result("attempted",true,"activityRevision",Interlocked.Read(ref ActivityRevision));
    }
    static INPUT[] TextEvents(string text)
    {
        if(text==null || text.Length==0 || text.Length>64) throw new Fault("UI_TEXT_INVALID");
        if(text=="\n") {
            if(Str(Config,"newlineKey")!="Shift+Enter") throw new Fault("UI_NEWLINE_BINDING_REQUIRED");
            return ChordEvents("Shift+Enter");
        }
        for(int i=0;i<text.Length;i++) {
            if(Char.IsControl(text[i]) || text[i]=='\u2028' || text[i]=='\u2029') throw new Fault("UI_TEXT_CONTROL_CHARACTER");
            if(Char.IsHighSurrogate(text[i])) { if(i+1>=text.Length || !Char.IsLowSurrogate(text[i+1])) throw new Fault("UI_TEXT_INVALID"); i++; }
            else if(Char.IsLowSurrogate(text[i])) throw new Fault("UI_TEXT_INVALID");
        }
        // JS outbox performs extended-grapheme segmentation; reject ordinary multi-character
        // batches here as a second boundary. ZWJ emoji may span several .NET text elements.
        int elements=new StringInfo(text).LengthInTextElements;
        if(elements>1 && !IsRegionalPair(text) && !IsEmojiSequence(text)) throw new Fault("UI_TEXT_NOT_SINGLE_GRAPHEME");
        var events=new List<INPUT>();
        foreach(char character in text) { events.Add(Key(0,character,4)); events.Add(Key(0,character,6)); }
        return events.ToArray();
    }
    static bool IsRegionalPair(string text) { return text.Length==4 && Char.ConvertToUtf32(text,0)>=0x1f1e6 && Char.ConvertToUtf32(text,0)<=0x1f1ff && Char.ConvertToUtf32(text,2)>=0x1f1e6 && Char.ConvertToUtf32(text,2)<=0x1f1ff; }
    static bool IsEmojiSequence(string text)
    {
        string[] parts=text.Split('\u200d');
        foreach(string part in parts) {
            if(part.Length==0) return false;
            int first=Char.ConvertToUtf32(part,0);
            if(!((first>=0x1f000 && first<=0x1faff) || (first>=0x2600 && first<=0x27bf))) return false;
            string remainder=part;
            if(part.Length>=4) {
                int lastOffset=Char.IsLowSurrogate(part[part.Length-1])?part.Length-2:part.Length-1;
                int last=Char.ConvertToUtf32(part,lastOffset);
                if(last>=0x1f3fb && last<=0x1f3ff) remainder=part.Substring(0,lastOffset);
            }
            if(new StringInfo(remainder).LengthInTextElements!=1) return false;
        }
        return true;
    }
    static INPUT[] ChordEvents(string chord)
    {
        var events=new List<INPUT>(); ushort modifier=chord=="Shift+Enter"?(ushort)16:chord=="Control+Enter"?(ushort)17:(ushort)0;
        if(modifier!=0) events.Add(Key(modifier,0,0));
        events.Add(Key(13,0,0)); events.Add(Key(13,0,2));
        if(modifier!=0) events.Add(Key(modifier,0,2));
        return events.ToArray();
    }
    static INPUT[] ButtonEvents(Snapshot state,Dictionary<string,object> selector)
    {
        AutomationElement button=Unique(AutomationElement.FromHandle(state.Window),selector,"UI_SEND_BUTTON_UNAVAILABLE");
        var info=button.Current; var bounds=info.BoundingRectangle;
        if(info.ControlType!=ControlType.Button || !info.IsEnabled || info.IsOffscreen || bounds.IsEmpty || bounds.Width<1 || bounds.Height<1) throw new Fault("UI_SEND_BUTTON_UNAVAILABLE");
        int x=(int)(bounds.Left+bounds.Width/2),y=(int)(bounds.Top+bounds.Height/2);
        var point=new POINT { x=x,y=y };
        if(GetAncestor(WindowFromPoint(point),2)!=state.Window) throw new Fault("UI_SEND_BUTTON_OBSCURED");
        int left=GetSystemMetrics(76),top=GetSystemMetrics(77),width=GetSystemMetrics(78),height=GetSystemMetrics(79);
        if(width<2 || height<2 || x<left || x>=left+width || y<top || y>=top+height) throw new Fault("UI_SCREEN_CHANGED");
        int absoluteX=(int)(((long)x-left)*65535/(width-1)),absoluteY=(int)(((long)y-top)*65535/(height-1));
        return new[]{Mouse(absoluteX,absoluteY,0xC001),Mouse(0,0,0x0002),Mouse(0,0,0x0004)};
    }
    static INPUT Key(ushort key,ushort scan,uint flags) { var value=new INPUT(); value.type=1; value.data.ki=new KEYBDINPUT { wVk=key,wScan=scan,dwFlags=flags,dwExtraInfo=InputMarker }; return value; }
    static INPUT Mouse(int x,int y,uint flags) { var value=new INPUT(); value.type=0; value.data.mi=new MOUSEINPUT { dx=x,dy=y,dwFlags=flags,dwExtraInfo=InputMarker }; return value; }
    static void ReleaseInsertedKeys(INPUT[] events,uint inserted)
    {
        // Best effort release only our own partially inserted down-events.
        var releases=new List<INPUT>();
        for(int i=(int)Math.Min(inserted,(uint)events.Length)-1;i>=0;i--) {
            INPUT item=events[i];
            if(item.type==1 && (item.data.ki.dwFlags&2)==0) releases.Add(Key(item.data.ki.wVk,item.data.ki.wScan,item.data.ki.dwFlags|2));
            if(item.type==0 && (item.data.mi.dwFlags&2)!=0) releases.Add(Mouse(0,0,4));
        }
        if(releases.Count>0) SendInput((uint)releases.Count,releases.ToArray(),Marshal.SizeOf(typeof(INPUT)));
    }
    static bool IsModifierDown() { foreach(int key in new[]{16,17,18,91,92,1,2,4}) if((GetAsyncKeyState(key)&0x8000)!=0) return true; return false; }

    static bool DesktopAvailable()
    {
        IntPtr desktop=OpenInputDesktop(0,false,1); if(desktop==IntPtr.Zero) return false;
        try { uint required; var name=new StringBuilder(128); return GetUserObjectInformation(desktop,2,name,256,out required) && String.Equals(name.ToString(),"Default",StringComparison.OrdinalIgnoreCase); }
        finally { CloseDesktop(desktop); }
    }
    static bool ProcessMatches(IntPtr window)
    {
        uint pid; GetWindowThreadProcessId(window,out pid);
        try { using(var process=Process.GetProcessById((int)pid)) return String.Equals(Path.GetFullPath(process.MainModule.FileName),Executable,StringComparison.OrdinalIgnoreCase); } catch { return false; }
    }
    static bool IsConfiguredForeground() { IntPtr window=GetForegroundWindow(); return window!=IntPtr.Zero && ProcessMatches(window); }
    static List<IntPtr> Windows()
    {
        var windows=new List<IntPtr>();
        EnumWindows(delegate(IntPtr window,IntPtr parameter) {
            if(!IsWindowVisible(window) || !ProcessMatches(window)) return true;
            string expectedClass=Str(Config,"windowClass"),expectedTitle=Str(Config,"windowTitle");
            var name=new StringBuilder(512); GetWindowText(window,name,name.Capacity);
            var className=new StringBuilder(256); GetClassName(window,className,className.Capacity);
            if((expectedClass==null || expectedClass==className.ToString()) && (expectedTitle==null || expectedTitle==name.ToString())) windows.Add(window);
            return true;
        },IntPtr.Zero);
        return windows;
    }
    static IntPtr FindWindow()
    {
        var windows=Windows(); if(windows.Count==0) throw new Fault("UI_WINDOW_UNAVAILABLE");
        if(windows.Count!=1) throw new Fault("UI_WINDOW_AMBIGUOUS"); return windows[0];
    }
    static object Inspect()
    {
        var windows=Windows(); var result=new List<object>();
        foreach(IntPtr window in windows) {
            var nodes=new List<object>();
            try {
                AutomationElement root=AutomationElement.FromHandle(window);
                var queue=new Queue<KeyValuePair<AutomationElement,int>>(); queue.Enqueue(new KeyValuePair<AutomationElement,int>(root,0));
                while(queue.Count>0 && nodes.Count<128) {
                    var entry=queue.Dequeue(); var info=entry.Key.Current;
                    nodes.Add(Result("depth",entry.Value,"name",Cut(info.Name),"automationId",Cut(info.AutomationId),"className",Cut(info.ClassName),
                        "controlType",info.ControlType.ProgrammaticName,"enabled",info.IsEnabled,"offscreen",info.IsOffscreen,
                        "focusable",info.IsKeyboardFocusable,"focused",info.HasKeyboardFocus,"password",info.IsPassword));
                    if(entry.Value<12) {
                        AutomationElement child=TreeWalker.RawViewWalker.GetFirstChild(entry.Key); int siblings=0;
                        while(child!=null && siblings++<128 && queue.Count<128) { queue.Enqueue(new KeyValuePair<AutomationElement,int>(child,entry.Value+1)); child=TreeWalker.RawViewWalker.GetNextSibling(child); }
                    }
                }
            } catch { nodes.Add(Result("error","UI_INSPECTION_INCOMPLETE")); }
            result.Add(Result("windowHandle",window.ToInt64().ToString(CultureInfo.InvariantCulture),"foreground",GetForegroundWindow()==window,"nodes",nodes));
        }
        return Result("inputEnabled",InputEnabled,"windows",result,"notice","Local UI metadata may contain private names. Do not publish inspection output.");
    }
    static string Cut(string value) { return value==null?"":value.Length<=256?value:value.Substring(0,256); }

    static IntPtr OnKeyboard(int code,IntPtr message,IntPtr data)
    {
        if(code>=0) { var info=(KBDLLHOOKSTRUCT)Marshal.PtrToStructure(data,typeof(KBDLLHOOKSTRUCT)); if(!OwnInput(info.flags,0x10,info.dwExtraInfo)) HumanActivity(); }
        return CallNextHookEx(KeyboardHook,code,message,data);
    }
    static IntPtr OnMouse(int code,IntPtr message,IntPtr data)
    {
        if(code>=0) { var info=(MSLLHOOKSTRUCT)Marshal.PtrToStructure(data,typeof(MSLLHOOKSTRUCT)); if(!OwnInput(info.flags,1,info.dwExtraInfo)) HumanActivity(); }
        return CallNextHookEx(MouseHook,code,message,data);
    }
    static bool OwnInput(uint flags,uint injectedFlag,UIntPtr marker) { return (flags&injectedFlag)!=0 && marker.Equals(InputMarker); }

    static int SelfTest()
    {
        int checks=0;
        try {
            Config=Result("newlineKey","Shift+Enter");
            Check(Marshal.SizeOf(typeof(INPUT))==40,"INPUT x64 layout"); checks++;
            var chinese=TextEvents("你"); Check(chinese.Length==2 && chinese[0].data.ki.wScan=='你' && chinese[1].data.ki.dwFlags==6,"Unicode pair"); checks++;
            var emoji=TextEvents("\uD83D\uDE00"); Check(emoji.Length==4,"surrogate pair"); checks++;
            var combining=TextEvents("e\u0301"); Check(combining.Length==4,"combining character"); checks++;
            Check(TextEvents("\uD83D\uDC69\u200D\uD83D\uDCBB").Length==10,"ZWJ emoji"); checks++;
            Check(TextEvents("\uD83D\uDC4D\uD83C\uDFFD").Length==8,"skin tone emoji"); checks++;
            ExpectFault(delegate { TextEvents("a\u200db"); },"UI_TEXT_NOT_SINGLE_GRAPHEME"); checks++;
            Check(TextEvents("\n").Length==4,"explicit newline chord"); checks++;
            var enter=ChordEvents("Control+Enter"); Check(enter.Length==4 && enter[3].data.ki.wVk==17 && enter[3].data.ki.dwFlags==2,"modifier release"); checks++;
            ExpectFault(delegate { TextEvents("hello"); },"UI_TEXT_NOT_SINGLE_GRAPHEME"); checks++;
            ExpectFault(delegate { TextEvents("\uD800"); },"UI_TEXT_INVALID"); checks++;
            ExpectFault(delegate { TextEvents("\t"); },"UI_TEXT_CONTROL_CHARACTER"); checks++;
            ExpectFault(delegate { BuildCondition(Result("unknown","x")); },"UI_SELECTOR_INVALID"); checks++;
            ExpectFault(delegate { Integer(0.5,"INVALID"); },"INVALID"); checks++;
            Check(NormalizeDraft("a\r\nb\r")=="a\nb\n","draft normalization"); checks++;
            Check(OwnInput(0x10,0x10,InputMarker) && !OwnInput(0,0x10,InputMarker) && !OwnInput(0x10,0x10,UIntPtr.Zero),"input ownership"); checks++;
            var mouseMarker=Mouse(0,0,1).data.mi.dwExtraInfo;
            Check(InputMarker.ToUInt64()>0 && InputMarker.ToUInt64()<=UInt32.MaxValue && mouseMarker.Equals(InputMarker) && OwnInput(1,1,mouseMarker) && !OwnInput(0,1,mouseMarker) && !OwnInput(1,1,UIntPtr.Zero),"mouse marker ownership"); checks++;
            Check(!OwnInput(1,1,new UIntPtr(0x100000000UL|InputMarker.ToUInt64())),"mouse marker full-width equality"); checks++;
            ExpectFault(delegate { Execute(Result(),"type"); },"UI_INPUT_DISABLED"); checks++;
            ValidateRequestId(1); ValidateRequestId("command-1"); ExpectFault(delegate { ValidateRequestId(1.5); },"UI_REQUEST_ID_INVALID"); checks++;
            string mutexName="Local\\WeChatAgent.UiInput.SelfTest."+Guid.NewGuid().ToString("N");
            string competingResult=null;
            using(var owner=AcquireInputGate(mutexName)) {
                var competing=new Thread(delegate() {
                    try { using(var duplicate=AcquireInputGate(mutexName)) { duplicate.ReleaseMutex(); competingResult="unexpected-owner"; } }
                    catch(Fault error) { competingResult=error.Message; }
                });
                competing.Start(); Check(competing.Join(2000),"mutex peer completion");
                owner.ReleaseMutex();
            }
            Check(competingResult=="UI_INPUT_ALREADY_OWNED","global input ownership"); checks++;
            using(var next=AcquireInputGate(mutexName)) { next.ReleaseMutex(); } checks++;
            Write(Result("ok",true,"selfTest",true,"checks",checks,"uiAccessed",false,"inputSent",false)); return 0;
        } catch { Write(Result("ok",false,"selfTest",true,"checks",checks)); return 1; }
    }
    static void Check(bool condition,string label) { if(!condition) throw new InvalidOperationException(label); }
    static void ExpectFault(Action action,string code) { try { action(); } catch(Fault error) { if(error.Message==code) return; throw; } throw new InvalidOperationException("expected "+code); }

    delegate IntPtr HookProc(int code,IntPtr message,IntPtr data);
    delegate bool EnumWindowsProc(IntPtr window,IntPtr parameter);
    [StructLayout(LayoutKind.Sequential)] struct POINT { public int x,y; }
    [StructLayout(LayoutKind.Sequential)] struct MOUSEINPUT { public int dx,dy; public uint mouseData,dwFlags,time; public UIntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] struct KEYBDINPUT { public ushort wVk,wScan; public uint dwFlags,time; public UIntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] struct HARDWAREINPUT { public uint uMsg; public ushort wParamL,wParamH; }
    [StructLayout(LayoutKind.Explicit)] struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; [FieldOffset(0)] public HARDWAREINPUT hi; }
    [StructLayout(LayoutKind.Sequential)] struct INPUT { public uint type; public INPUTUNION data; }
    [StructLayout(LayoutKind.Sequential)] struct KBDLLHOOKSTRUCT { public uint vkCode,scanCode,flags,time; public UIntPtr dwExtraInfo; }
    [StructLayout(LayoutKind.Sequential)] struct MSLLHOOKSTRUCT { public POINT pt; public uint mouseData,flags,time; public UIntPtr dwExtraInfo; }
    [DllImport("user32.dll",SetLastError=true)] static extern uint SendInput(uint count,INPUT[] inputs,int size);
    [DllImport("user32.dll")] static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window,uint flags);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(POINT point);
    [DllImport("user32.dll")] static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc callback,IntPtr parameter);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr window,StringBuilder text,int count);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern int GetClassName(IntPtr window,StringBuilder name,int count);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window,out uint processId);
    [DllImport("user32.dll",SetLastError=true)] static extern IntPtr SetWindowsHookEx(int id,HookProc callback,IntPtr module,uint threadId);
    [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr hook,int code,IntPtr message,IntPtr data);
    [DllImport("kernel32.dll",CharSet=CharSet.Unicode)] static extern IntPtr GetModuleHandle(string name);
    [DllImport("kernel32.dll")] static extern ulong GetTickCount64();
    [DllImport("user32.dll",SetLastError=true)] static extern IntPtr OpenInputDesktop(uint flags,bool inherit,uint access);
    [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll",CharSet=CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr handle,int index,StringBuilder text,uint length,out uint needed);
}
