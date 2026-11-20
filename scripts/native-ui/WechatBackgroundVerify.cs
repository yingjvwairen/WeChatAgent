// Fast read-only verification of control identities discovered by --layout.
// Paths are lookup hints only: every resolved node must keep its runtime ID,
// role metadata and actual client rectangle before it is returned as verified.
using System;
using System.Collections;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Windows.Automation;

internal static partial class WechatBackgroundControls
{
    static void WarmVerifier(){
        // Load UIA/WindowsBase and JIT the verifier before foreground ownership.
        // These operations do not query an application or obtain a UIA element.
        Need(TreeWalker.RawViewWalker!=null&&AutomationElement.ProcessIdProperty!=null,"UI_CONTROLS_VERIFIER_WARMUP_FAILED");
        var method=typeof(WechatBackgroundControls).GetMethod("VerifyLayout",System.Reflection.BindingFlags.NonPublic|System.Reflection.BindingFlags.Static);
        Need(method!=null,"UI_CONTROLS_VERIFIER_WARMUP_FAILED");System.Runtime.CompilerServices.RuntimeHelpers.PrepareMethod(method.MethodHandle);
    }
    static Dictionary<string,object> VerifierEnvelope(object value,long previous,out long id){
        var packet=value as Dictionary<string,object>;Need(packet!=null&&packet.Count==3&&Number(Get(packet,"version"))==1&&Get(packet,"request") is Dictionary<string,object>,"UI_CONTROLS_VERIFIER_PROTOCOL_INVALID");
        id=Number(Get(packet,"id"));Need(id>previous&&id<=9007199254740991L,"UI_CONTROLS_VERIFIER_PROTOCOL_INVALID");return (Dictionary<string,object>)packet["request"];
    }
    static object VerifierRequest(Dictionary<string,object> request){
        object verification=Get(request,"verification");string phase=Get(request,"verifyPhase") as string;
        object readiness=Get(request,"navigationReadiness");Need(phase=="navigation-ready"?readiness!=null:readiness==null,"UI_CONTROLS_CONVERSATION_REQUEST_INVALID");
        bool refresh=NavigationGeometryRefresh(request,phase,readiness);
        bool fingerprint=FingerprintRequested(request)||phase=="navigation-ready";var identity=new Dictionary<string,object>(request);identity.Remove("verification");identity.Remove("verifyPhase");identity.Remove("includeConversationFingerprint");identity.Remove("navigationReadiness");identity.Remove("refreshNavigationGeometry");
        return VerifyLayout(Parse(identity),verification,phase,fingerprint,readiness,refresh);
    }
    static bool NavigationGeometryRefresh(Dictionary<string,object> request,string phase,object readiness){
        object value;if(!request.TryGetValue("refreshNavigationGeometry",out value))return false;
        Need(value is bool,"UI_CONTROLS_CONVERSATION_REQUEST_INVALID");if(!(bool)value)return false;
        var navigation=readiness as Dictionary<string,object>;
        Need(phase=="navigation-ready"&&navigation!=null&&Get(navigation,"searchPopupHwnd") is string&&(string)navigation["searchPopupHwnd"]!="0","UI_CONTROLS_CONVERSATION_REQUEST_INVALID");return true;
    }
    static bool FingerprintRequested(Dictionary<string,object> request){object value; if(!request.TryGetValue("includeConversationFingerprint",out value))return false;Need(value is bool,"UI_CONTROLS_TITLE_OPTION_INVALID");return (bool)value;}
    static int ServeVerifier(){
        Console.InputEncoding=new System.Text.UTF8Encoding(false);WarmVerifier();Console.WriteLine(Json.Serialize(Data("version",1,"ready",true,"backend","uia-verifier","readOnly",true,"inputSent",false)));Console.Out.Flush();long previous=0;string line;
        while((line=Console.ReadLine())!=null){
            UiAccessed=false;ControlWriteAttempted=false;SearchValueRead=false;TitleTextRead=false;
            Need(line.Length>0&&System.Text.Encoding.UTF8.GetByteCount(line)<=32768,"UI_CONTROLS_VERIFIER_PROTOCOL_INVALID");long id;var request=VerifierEnvelope(Json.DeserializeObject(line),previous,out id);previous=id;object report;
            try{report=VerifierRequest(request);}catch(Exception error){report=ErrorReport(error);}
            Console.WriteLine(Json.Serialize(Data("version",1,"id",id,"report",report)));Console.Out.Flush();
        }return 0;
    }
    static readonly string[] VerifyRoles={"search","editor","header","send","recordStart","toolbar"};
    static string[] RequestedRoles(string phase){Need(phase=="input"||phase=="voice-start"||phase=="navigation-ready","UI_CONTROLS_FAST_PHASE_INVALID");return phase=="voice-start"?new[]{"editor","send","header","recordStart","toolbar"}:new[]{"editor","send","header"};}
    static bool Digest(object value){string text=value as string;if(text==null||text.Length!=64)return false;foreach(char c in text)if(!(c>='0'&&c<='9'||c>='a'&&c<='f'))return false;return true;}
    static int[] NodePath(IList<object> nodes,int index){
        var reversed=new List<int>();for(int depth=0;index>0&&depth<128;depth++){
            int parent=Parent(nodes,index);Need(parent>=0&&parent<index,"UI_CONTROLS_ANCESTRY_INVALID");int position=0;
            for(int other=parent+1;other<index;other++)if(Parent(nodes,other)==parent)position++;
            reversed.Add(position);index=parent;
        }Need(index==0&&reversed.Count>0,"UI_CONTROLS_ANCESTRY_INVALID");reversed.Reverse();return reversed.ToArray();
    }
    static object VerificationProof(int[] rootId,LayoutGeometry geometry,Dictionary<string,object> controls){
        var selected=new Dictionary<string,object>();foreach(string role in VerifyRoles){object control;if(!controls.TryGetValue(role,out control))return null;selected.Add(role,control);}
        return Data("version",1,"rootRuntimeIdSha256",Hash(String.Join(",",rootId)),"clientRect",geometry.Client(),"captureRect",geometry.Screen(),"dpi",geometry.Dpi,"roles",selected);
    }
    static int[] LocatorPath(object value){var list=value as IList;Need(list!=null&&list.Count>0&&list.Count<=96,"UI_CONTROLS_FAST_PROOF_INVALID");var path=new int[list.Count];for(int i=0;i<path.Length;i++){long n=Number(list[i]);Need(n<512,"UI_CONTROLS_FAST_PROOF_INVALID");path[i]=(int)n;}return path;}
    static bool ExactRect(object expected,Dictionary<string,object> actual){var map=expected as Dictionary<string,object>;if(map==null||map.Count!=4)return false;foreach(string key in new[]{"left","top","right","bottom"}){object a=Get(map,key),b=Get(actual,key);if(a==null||a is string||a is bool||b==null)return false;try{if(Convert.ToDecimal(a,CultureInfo.InvariantCulture)!=Convert.ToDecimal(b,CultureInfo.InvariantCulture))return false;}catch{return false;}}return true;}
    sealed class LocatorReplay<T> where T:class {
        readonly T root;readonly Func<T,T> child,sibling;readonly Func<bool> expired;
        readonly Dictionary<string,List<T>> children=new Dictionary<string,List<T>>();internal int Visited;
        internal LocatorReplay(T root,Func<T,T> child,Func<T,T> sibling,Func<bool> expired){this.root=root;this.child=child;this.sibling=sibling;this.expired=expired;}
        internal T Resolve(int[] path){T node=root;string prefix="";foreach(int index in path){
            Need(!expired(),"UI_CONTROLS_FAST_DEADLINE");List<T> list;if(!children.TryGetValue(prefix,out list)){list=new List<T>();children.Add(prefix,list);}
            while(list.Count<=index){Need(++Visited<=512&&!expired(),"UI_CONTROLS_FAST_DEADLINE");T next=list.Count==0?child(node):sibling(list[list.Count-1]);Need(next!=null,"UI_CONTROLS_FAST_LOCATOR_CHANGED");list.Add(next);}
            node=list[index];prefix+="/"+index.ToString(CultureInfo.InvariantCulture);
        }return node;}
    }
    // Lifetime is exactly one read-only verification. Keys are UIA runtime IDs,
    // so two element wrappers for a shared ancestor reuse one parent lookup.
    sealed class ParentObservation<T> where T:class {
        readonly Func<T,string> identity;readonly Func<T,T> parent;
        readonly Dictionary<string,T> parents=new Dictionary<string,T>(StringComparer.Ordinal);internal int Queries;
        internal ParentObservation(Func<T,string> identity,Func<T,T> parent){this.identity=identity;this.parent=parent;}
        internal T GetParent(T node){string key=identity(node);T value;if(parents.TryGetValue(key,out value))return value;value=parent(node);Queries++;parents.Add(key,value);return value;}
    }
    static Dictionary<string,object> CheckedVerification(object value){
        var proof=value as Dictionary<string,object>;Need(proof!=null&&proof.Count==6&&Number(Get(proof,"version"))==1&&Digest(Get(proof,"rootRuntimeIdSha256")),"UI_CONTROLS_FAST_PROOF_INVALID");
        Need(Get(proof,"clientRect") is Dictionary<string,object>&&Get(proof,"captureRect") is Dictionary<string,object>&&Number(Get(proof,"dpi"))>=48&&Number(Get(proof,"dpi"))<=768,"UI_CONTROLS_FAST_PROOF_INVALID");
        var roles=Get(proof,"roles") as Dictionary<string,object>;Need(roles!=null&&roles.Count==VerifyRoles.Length,"UI_CONTROLS_FAST_PROOF_INVALID");var identities=new HashSet<string>();
        foreach(string role in VerifyRoles){var control=Get(roles,role) as Dictionary<string,object>;Need(control!=null&&Digest(Get(control,"runtimeIdSha256"))&&identities.Add((string)Get(control,"runtimeIdSha256"))&&Get(control,"className") is string&&Get(control,"controlType") is string&&Get(control,"rect") is Dictionary<string,object>,"UI_CONTROLS_FAST_PROOF_INVALID");LocatorPath(Get(control,"path"));if(role=="send"||role=="recordStart"){var label=KnownToolbarLabel(Get(control,"staticLabel") as string,"proof");Need(label!=null&&label.Role==role,"UI_CONTROLS_FAST_PROOF_INVALID");}}
        return proof;
    }
    // Only the verified header subtree is traversed. Message and editor trees
    // are never inspected for this optional continuation hint.
    static List<int> TitleTextNodes(IList<object> nodes,out int title){
        Need(nodes.Count>0&&Class(nodes,0)=="mmui::ChatTitleBarMasterView","UI_CONTROLS_TITLE_UNAVAILABLE");title=-1;
        for(int i=1;i<nodes.Count;i++)if(VisibleNode(nodes,i)&&Class(nodes,i)=="mmui::XHBoxView"&&Type(nodes,i)=="ControlType.Text"&&(Ancestor(nodes,i,"mmui::ChatTitleBarChatSingleView")>=0||Ancestor(nodes,i,"mmui::ChatTitleBarChatRoomView")>=0)){
            Need(title<0,"UI_CONTROLS_TITLE_AMBIGUOUS");title=i;
        }Need(title>=0,"UI_CONTROLS_TITLE_UNAVAILABLE");var selected=new List<int>();
        for(int i=title+1;i<nodes.Count;i++)if(Parent(nodes,i)==title&&VisibleNode(nodes,i)&&Class(nodes,i)=="mmui::XTextView"&&Type(nodes,i)=="ControlType.Text")selected.Add(i);
        Need(selected.Count>=1&&selected.Count<=4,"UI_CONTROLS_TITLE_UNAVAILABLE");return selected;
    }
    static string TitleDigest(IList<string> texts){
        Need(texts!=null&&texts.Count>=1&&texts.Count<=4,"UI_CONTROLS_TITLE_UNAVAILABLE");int total=0;var framed=new System.Text.StringBuilder("chat-title-text-v1\n");
        foreach(string value in texts){Need(value!=null&&value.Length>0&&value.Length<=256&&value.IndexOf('\0')<0,"UI_CONTROLS_TITLE_UNAVAILABLE");total+=value.Length;Need(total<=512,"UI_CONTROLS_TITLE_UNAVAILABLE");framed.Append(value.Length.ToString(CultureInfo.InvariantCulture)).Append(':').Append(value).Append('\n');}
        return Hash(framed.ToString());
    }
    const string CurrentChatTitleBoxId="content_view.top_content_view.title_h_view.left_v_view.left_content_v_view.left_ui_.big_title_line_h_view";
    const string CurrentChatNameId=CurrentChatTitleBoxId+".current_chat_name_label";
    static int PrimaryTitleTextOffset(IList<object> nodes,int title,IList<int> selected){
        // Qt exposes a full static object path, not a bare label ID. A group
        // adds a sibling count label; neither order nor text shape is identity.
        if(Class(nodes,title)!="mmui::XHBoxView"||Type(nodes,title)!="ControlType.Text"||!Object.Equals(Get(Node(nodes,title),"automationId"),CurrentChatTitleBoxId))return -1;
        int found=-1;for(int offset=0;offset<selected.Count;offset++){
            int index=selected[offset];if(!Object.Equals(Get(Node(nodes,index),"automationId"),CurrentChatNameId))continue;
            Need(Parent(nodes,index)==title&&VisibleNode(nodes,index)&&Class(nodes,index)=="mmui::XTextView"&&Type(nodes,index)=="ControlType.Text","UI_CONTROLS_TITLE_CHANGED");
            Need(found<0,"UI_CONTROLS_TITLE_AMBIGUOUS");found=offset;
        }return found;
    }
    static object ConversationFingerprint(AutomationElement header,uint pid,Stopwatch timer,out string primaryTitleSha256){
        primaryTitleSha256=null;
        var cache=LayoutControlCache();var textCache=LayoutControlCache();textCache.Add(AutomationElement.NameProperty);
        // VerifyLayout supplies the header from this operation's fresh locator
        // replay. Descendants get their cache with each tree navigation call.
        var walker=TreeWalker.RawViewWalker;var elements=new List<AutomationElement>();var ids=new List<int[]>();int[] headerId=header.GetRuntimeId();
        var tree=Walk(header,delegate(AutomationElement el){return walker.GetFirstChild(el,cache);},delegate(AutomationElement el){return walker.GetNextSibling(el,cache);},delegate(AutomationElement el){
            elements.Add(el);ids.Add(el.GetRuntimeId());var current=el.Cached;Need(current.ProcessId==(int)pid,"UI_CONTROLS_TITLE_CHANGED");return Data("className",current.ClassName,"controlType",current.ControlType.ProgrammaticName,"offscreen",current.IsOffscreen,"automationId",current.AutomationId,"rect",current.BoundingRectangle.IsEmpty?null:Data());
        },64,24,delegate{return timer.ElapsedMilliseconds>1000;});Need(tree.Complete,"UI_CONTROLS_TITLE_UNAVAILABLE");int title;var selected=TitleTextNodes(tree.Nodes,out title);int primary=PrimaryTitleTextOffset(tree.Nodes,title,selected);var texts=new List<string>();
        foreach(int index in selected){TitleTextRead=true;texts.Add(elements[index].Current.Name);}string digest=TitleDigest(texts);
        // Resolve again from the header and reread exact title text, so detached
        // or replaced label objects cannot become a positive continuation hint.
        var replay=new LocatorReplay<AutomationElement>(header,delegate(AutomationElement el){return walker.GetFirstChild(el,cache);},delegate(AutomationElement el){return walker.GetNextSibling(el,cache);},delegate{return timer.ElapsedMilliseconds>1000;});
        var liveTitle=replay.Resolve(NodePath(tree.Nodes,title));var liveTitleInfo=liveTitle.Cached;Need(liveTitleInfo.ProcessId==(int)pid&&!liveTitleInfo.IsOffscreen&&liveTitleInfo.ClassName=="mmui::XHBoxView"&&liveTitleInfo.ControlType==ControlType.Text&&Object.Equals(liveTitleInfo.AutomationId,Get(Node(tree.Nodes,title),"automationId"))&&Automation.Compare(ids[title],liveTitle.GetRuntimeId()),"UI_CONTROLS_TITLE_CHANGED");var again=new List<string>();
        foreach(int index in selected){var element=replay.Resolve(NodePath(tree.Nodes,index)).GetUpdatedCache(textCache);var current=element.Cached;Need(current.ProcessId==(int)pid&&!current.IsOffscreen&&current.ClassName=="mmui::XTextView"&&current.ControlType==ControlType.Text&&Object.Equals(current.AutomationId,Get(Node(tree.Nodes,index),"automationId"))&&Automation.Compare(ids[index],element.GetRuntimeId()),"UI_CONTROLS_TITLE_CHANGED");TitleTextRead=true;again.Add(current.Name);}
        Need(digest==TitleDigest(again)&&Automation.Compare(headerId,header.GetRuntimeId()),"UI_CONTROLS_TITLE_CHANGED");
        if(primary>=0)primaryTitleSha256=Hash(texts[primary]);
        return Data("version",1,"scope","chat-title-text-v1","sha256",digest,"headerRuntimeIdSha256",Hash(String.Join(",",headerId)),"titleRuntimeIdSha256",Hash(String.Join(",",ids[title])),"textNodeCount",selected.Count,"targetVerified",false);
    }
    sealed class NavigationReadinessRequest {internal string Title,Query,Popup;internal IntPtr PopupWindow;}
    static NavigationReadinessRequest ReadinessRequest(object value,Binding binding){
        var request=value as Dictionary<string,object>;Need(request!=null&&request.Count==4&&Number(Get(request,"version"))==1&&Digest(Get(request,"expectedTitleSha256"))&&Digest(Get(request,"expectedQuerySha256")),"UI_CONTROLS_CONVERSATION_REQUEST_INVALID");
        string popup=Get(request,"searchPopupHwnd") as string;long window=popup=="0"?0:DecimalId(popup);Need(popup==Id(window)&&window!=binding.Window.ToInt64(),"UI_CONTROLS_CONVERSATION_REQUEST_INVALID");
        return new NavigationReadinessRequest{Title=(string)request["expectedTitleSha256"],Query=(string)request["expectedQuerySha256"],Popup=popup,PopupWindow=new IntPtr(window)};
    }
    [StructLayout(LayoutKind.Sequential)]struct ConversationGuiInfo {internal uint Size,Flags;internal IntPtr Active,Focus,Capture,MenuOwner,MoveSize,Caret;internal NativeRect CaretRect;}
    delegate bool ConversationWindowCallback(IntPtr window,IntPtr parameter);
    [DllImport("user32.dll")]static extern bool GetGUIThreadInfo(uint thread,ref ConversationGuiInfo info);
    [DllImport("user32.dll")]static extern bool EnumWindows(ConversationWindowCallback callback,IntPtr parameter);
    [DllImport("user32.dll")]static extern IntPtr GetWindow(IntPtr window,uint command);
    static bool ConversationRootFocused(Binding binding,uint thread){var gui=new ConversationGuiInfo{Size=(uint)Marshal.SizeOf(typeof(ConversationGuiInfo))};return GetForegroundWindow()==binding.Window&&GetGUIThreadInfo(thread,ref gui)&&gui.Active==binding.Window&&gui.Focus==binding.Window&&gui.Capture==IntPtr.Zero&&gui.MenuOwner==IntPtr.Zero&&gui.MoveSize==IntPtr.Zero&&(gui.Flags&0x1e)==0;}
    static bool ConversationSearchClosed(Binding binding,uint thread,NavigationReadinessRequest request,Stopwatch timer){
        if(request.PopupWindow!=IntPtr.Zero&&IsWindow(request.PopupWindow)){
            uint popupPid;uint popupThread=GetWindowThreadProcessId(request.PopupWindow,out popupPid);var cls=new System.Text.StringBuilder(256);
            Need(popupPid==binding.Pid&&popupThread==thread&&GetClassName(request.PopupWindow,cls,cls.Capacity)>0&&cls.ToString()=="Qt51514QWindowToolSaveBits","UI_CONTROLS_CONVERSATION_CHANGED");
            if(IsWindowVisible(request.PopupWindow))return false;
        }
        int visited=0;bool closed=true,complete=true;
        bool enumerated=EnumWindows(delegate(IntPtr window,IntPtr ignored){
            if(++visited>1024||timer.ElapsedMilliseconds>1000){complete=false;return false;}
            if(window==binding.Window||!IsWindowVisible(window))return true;uint pid;uint windowThread=GetWindowThreadProcessId(window,out pid);if(pid!=binding.Pid)return true;
            IntPtr owner=GetWindow(window,4);bool owned=false;for(int depth=0;owner!=IntPtr.Zero&&depth<8;depth++){if(owner==binding.Window){owned=true;break;}owner=GetWindow(owner,4);}
            if(owned){closed=false;return false;}
            if(windowThread==thread){var cls=new System.Text.StringBuilder(256);if(GetClassName(window,cls,cls.Capacity)<=0){complete=false;return false;}if(cls.ToString()=="Qt51514QWindowToolSaveBits"){closed=false;return false;}}
            return true;
        },IntPtr.Zero);
        Need(complete&&(enumerated||!closed),"UI_CONTROLS_CONVERSATION_CHANGED");return closed;
    }
    static AutomationElement ConversationPage(AutomationElement element,AutomationElement root,uint pid,Stopwatch timer,ParentObservation<AutomationElement> parents){
        AutomationElement page=null;bool reached=false;
        for(int depth=0;depth<32;depth++){
            Need(timer.ElapsedMilliseconds<=1000,"UI_CONTROLS_CONVERSATION_CHANGED");element=parents.GetParent(element);Need(element!=null,"UI_CONTROLS_CONVERSATION_PAGE_UNAVAILABLE");var current=element.Cached;Need(current.ProcessId==(int)pid,"UI_CONTROLS_CONVERSATION_CHANGED");
            if(Automation.Compare(element,root)){reached=true;break;}
            if(current.ClassName=="mmui::ChatMessagePage"){
                Need(page==null&&ConversationPageRole(current.ClassName,current.ControlType.ProgrammaticName,current.AutomationId,current.IsEnabled,current.IsOffscreen,current.BoundingRectangle.IsEmpty),"UI_CONTROLS_CONVERSATION_PAGE_UNAVAILABLE");page=element;
            }
        }Need(reached&&page!=null,"UI_CONTROLS_CONVERSATION_PAGE_UNAVAILABLE");return page;
    }
    static bool ConversationPageRole(string cls,string type,string id,bool enabled,bool offscreen,bool empty){return cls=="mmui::ChatMessagePage"&&type=="ControlType.Group"&&id=="chat_message_page"&&enabled&&!offscreen&&!empty;}
    static bool ConversationEditorRole(string cls,string type,string id,bool enabled,bool offscreen,bool focusable){return cls=="mmui::ChatInputField"&&type=="ControlType.Edit"&&id=="chat_input_field"&&enabled&&!offscreen&&focusable;}
    static string ReadinessReason(Exception error){string code=ErrorCode(error);return code=="UI_CONTROLS_CONVERSATION_WINDOW_INACTIVE"||code=="UI_CONTROLS_CONVERSATION_SEARCH_OPEN"||code=="UI_CONTROLS_CONVERSATION_PAGE_UNAVAILABLE"||code=="UI_CONTROLS_CONVERSATION_EDITOR_UNAVAILABLE"||code=="UI_CONTROLS_CONVERSATION_TITLE_UNAVAILABLE"||code=="UI_CONTROLS_CONVERSATION_TITLE_MISMATCH"?code:"UI_CONTROLS_CONVERSATION_CHANGED";}
    static Dictionary<string,object> ConversationReadinessCore(NavigationReadinessRequest request,string primaryTitleSha256,Func<bool> focused,Func<bool> searchClosed,Func<string> samePage,Func<bool> writable){
        var report=Data("version",1,"ready",false,"reason",null,"primaryTitleSha256",primaryTitleSha256,"querySha256",request.Query,"samePage",false,"pageRuntimeIdSha256",null,"editorWritable",false,"searchClosed",false,"searchPopupHwnd",request.Popup,"targetVerified",false);
        try{
            Need(focused(),"UI_CONTROLS_CONVERSATION_WINDOW_INACTIVE");
            bool closed=searchClosed();report["searchClosed"]=closed;Need(closed,"UI_CONTROLS_CONVERSATION_SEARCH_OPEN");
            string page=samePage();Need(Digest(page),"UI_CONTROLS_CONVERSATION_PAGE_UNAVAILABLE");report["samePage"]=true;report["pageRuntimeIdSha256"]=page;
            bool canWrite=writable();report["editorWritable"]=canWrite;Need(canWrite,"UI_CONTROLS_CONVERSATION_EDITOR_UNAVAILABLE");
            Need(Digest(primaryTitleSha256),"UI_CONTROLS_CONVERSATION_TITLE_UNAVAILABLE");Need(primaryTitleSha256==request.Title,"UI_CONTROLS_CONVERSATION_TITLE_MISMATCH");report["ready"]=true;
        }catch(Exception error){report["reason"]=ReadinessReason(error);}return report;
    }
    static Dictionary<string,object> ConversationReadiness(Binding binding,uint thread,AutomationElement root,AutomationElement header,AutomationElement editor,NavigationReadinessRequest request,string primaryTitleSha256,Stopwatch timer){
        var cache=LayoutControlCache();var walker=TreeWalker.RawViewWalker;var parents=new ParentObservation<AutomationElement>(delegate(AutomationElement node){return String.Join(",",node.GetRuntimeId());},delegate(AutomationElement node){return walker.GetParent(node,cache);});
        return ConversationReadinessCore(request,primaryTitleSha256,delegate{return ConversationRootFocused(binding,thread);},delegate{return ConversationSearchClosed(binding,thread,request,timer);},delegate{
            var headerPage=ConversationPage(header,root,binding.Pid,timer,parents);var editorPage=ConversationPage(editor,root,binding.Pid,timer,parents);Need(Automation.Compare(headerPage,editorPage),"UI_CONTROLS_CONVERSATION_PAGE_UNAVAILABLE");
            var pageBox=headerPage.Cached.BoundingRectangle;Need(pageBox.Contains(header.Cached.BoundingRectangle)&&pageBox.Contains(editor.Cached.BoundingRectangle),"UI_CONTROLS_CONVERSATION_PAGE_UNAVAILABLE");return Hash(String.Join(",",headerPage.GetRuntimeId()));
        },delegate{var current=editor.Cached;object pattern;return ConversationEditorRole(current.ClassName,current.ControlType.ProgrammaticName,current.AutomationId,current.IsEnabled,current.IsOffscreen,current.IsKeyboardFocusable)&&editor.TryGetCurrentPattern(ValuePattern.Pattern,out pattern)&&!((ValuePattern)pattern).Current.IsReadOnly;});
    }
    static object VerifyLayout(Binding binding,object supplied,string phase,bool includeFingerprint=false,object navigationRequest=null,bool refreshGeometry=false){
        NavigationReadinessRequest navigation=phase=="navigation-ready"?ReadinessRequest(navigationRequest,binding):null;
        var requested=refreshGeometry?VerifyRoles:RequestedRoles(phase);var proof=CheckedVerification(supplied);var expectedRoles=(Dictionary<string,object>)proof["roles"];
        IntPtr dpiContext=SetThreadDpiAwarenessContext(new IntPtr(-4));Need(dpiContext!=IntPtr.Zero,"UI_CONTROLS_DPI_CONTEXT_UNAVAILABLE");IntPtr process=IntPtr.Zero;
        try{
            process=OpenProcess(0x1000|0x100000,false,binding.Pid);Need(process!=IntPtr.Zero,"UI_CONTROLS_PROCESS_UNAVAILABLE");var before=Observe(binding,process);Need((bool)before["visible"]&&!(bool)before["minimized"],"UI_CONTROLS_LAYOUT_WINDOW_UNAVAILABLE");var geometry=Geometry(binding);
            Need(ExactRect(proof["clientRect"],geometry.Client())&&ExactRect(proof["captureRect"],geometry.Screen())&&Number(proof["dpi"])==geometry.Dpi,"UI_CONTROLS_LAYOUT_BINDING_CHANGED");
            string version=FileVersionInfo.GetVersionInfo(binding.Executable).FileVersion;Need(version=="4.1.15.56","UI_CONTROLS_LAYOUT_VERSION_UNSUPPORTED");UiAccessed=true;var timer=Stopwatch.StartNew();var cache=LayoutControlCache();AutomationElement root;using(cache.Activate())root=AutomationElement.FromHandle(binding.Window);
            Need(root!=null&&root.Cached.ClassName=="mmui::MainWindow"&&Hash(String.Join(",",root.GetRuntimeId()))==(string)proof["rootRuntimeIdSha256"],"UI_CONTROLS_FAST_LOCATOR_CHANGED");
            var walker=TreeWalker.RawViewWalker;var replay=new LocatorReplay<AutomationElement>(root,delegate(AutomationElement node){return walker.GetFirstChild(node,cache);},delegate(AutomationElement node){return walker.GetNextSibling(node,cache);},delegate{return timer.ElapsedMilliseconds>1000;});
            var controls=new Dictionary<string,object>();var layout=Data("width",geometry.Width,"height",geometry.Height,"dpi",geometry.Dpi);var voice=new Dictionary<string,object>();var resolved=new Dictionary<string,AutomationElement>();
            foreach(string role in requested){
                var expected=(Dictionary<string,object>)expectedRoles[role];var element=replay.Resolve(LocatorPath(expected["path"]));resolved.Add(role,element);
                Need(Hash(String.Join(",",element.GetRuntimeId()))==(string)expected["runtimeIdSha256"],"UI_CONTROLS_FAST_LOCATOR_CHANGED");var current=element.Cached;
                Need(current.ProcessId==(int)binding.Pid&&current.ClassName==(string)expected["className"]&&current.ControlType.ProgrammaticName==(string)expected["controlType"]&&(Get(expected,"automationId")==null||current.AutomationId==(string)expected["automationId"])&&!current.IsOffscreen,"UI_CONTROLS_LAYOUT_CONTROL_CHANGED");
                var box=current.BoundingRectangle;Need(!box.IsEmpty,"UI_CONTROLS_LAYOUT_MOVED");var rect=ClientRegion(Data("left",box.Left,"top",box.Top,"right",box.Right,"bottom",box.Bottom),geometry);Need(refreshGeometry||ExactRect(expected["rect"],rect),"UI_CONTROLS_LAYOUT_MOVED");
                LabelMatch label=null;if(role=="send"||role=="recordStart"){label=ReadToolbarLabel(element);Need(label!=null&&label.Role==role&&label.Text==(string)expected["staticLabel"],"UI_CONTROLS_LAYOUT_LABEL_CHANGED");}
                controls.Add(role,Data("rect",rect,"className",current.ClassName,"controlType",current.ControlType.ProgrammaticName,"automationId",Get(expected,"automationId"),"runtimeIdSha256",expected["runtimeIdSha256"],"path",expected["path"],"enabled",current.IsEnabled,"offscreen",false,"staticLabel",label==null?null:label.Text,"labelSource",label==null?null:label.Source));
                if(role=="recordStart")voice["recordStartRect"]=rect;else if(role=="toolbar")voice["toolbarRect"]=rect;else layout[role]=rect;
            }
            object fingerprint=null;bool fingerprintUnavailable=false;string primaryTitleSha256=null;
            if(includeFingerprint){try{fingerprint=ConversationFingerprint(resolved["header"],binding.Pid,timer,out primaryTitleSha256);}catch(Exception){fingerprintUnavailable=true;primaryTitleSha256=null;}}
            // Recheck only this operation's three/five elements, never values.
            foreach(string role in requested){var element=resolved[role].GetUpdatedCache(cache);resolved[role]=element;var expected=(Dictionary<string,object>)controls[role];var current=element.Cached;var box=current.BoundingRectangle;
                Need(current.ProcessId==(int)binding.Pid&&!current.IsOffscreen&&current.ClassName==(string)expected["className"]&&current.ControlType.ProgrammaticName==(string)expected["controlType"]&&(Get(expected,"automationId")==null||current.AutomationId==(string)expected["automationId"])&&Hash(String.Join(",",element.GetRuntimeId()))==(string)expected["runtimeIdSha256"]&&!box.IsEmpty&&ExactRect(expected["rect"],ClientRegion(Data("left",box.Left,"top",box.Top,"right",box.Right,"bottom",box.Bottom),geometry)),"UI_CONTROLS_LAYOUT_CONTROL_CHANGED");}
            // Readiness uses these freshly rechecked controls once. No input
            // occurs inside verification; rebuilding the same ancestry and
            // enumerating owned windows twice adds no new transaction boundary.
            Dictionary<string,object> readiness=navigation==null?null:ConversationReadiness(binding,Convert.ToUInt32(before["threadId"],CultureInfo.InvariantCulture),root,resolved["header"],resolved["editor"],navigation,primaryTitleSha256,timer);
            var finalRoot=AutomationElement.FromHandle(binding.Window);Need(finalRoot!=null&&Hash(String.Join(",",finalRoot.GetRuntimeId()))==(string)proof["rootRuntimeIdSha256"],"UI_CONTROLS_ROOT_CHANGED");var after=Observe(binding,process);
            Need(Same(before,after,"threadId")&&Same(before,after,"nativeClassName")&&SameGeometry(geometry,Geometry(binding))&&(bool)after["visible"]&&!(bool)after["minimized"],"UI_CONTROLS_LAYOUT_BINDING_CHANGED");
            if(readiness!=null&&(!Same(before,after,"lastInputTick")||!Same(before,after,"foregroundHwnd"))){readiness["ready"]=false;readiness["reason"]="UI_CONTROLS_CONVERSATION_CHANGED";}
            var identity=Data("hwnd",Id(binding.Window.ToInt64()),"pid",binding.Pid,"threadId",before["threadId"],"processCreatedFileTimeUtc",Id(binding.Created),"dpi",geometry.Dpi,"clientRect",geometry.Client(),"captureRect",geometry.Screen(),"rootRuntimeIdSha256",proof["rootRuntimeIdSha256"],"executableVersion",version);
            var report=Data("ok",true,"schemaVersion",1,"version",1,"backend","uia-layout","operation","verify-layout","readOnly",true,"inputSent",false,"staticLabelsRead",true,"chatTextRead",false,"draftValueRead",false,"accountVerified",false,"targetVerified",false,"emptyDraftAuthorized",false,"authorizationGranted",false,"bindingStable",true,"complete",true,"binding",identity,"layout",layout,"voice",voice,"controls",controls,"missing",new string[0],"ambiguous",new string[0],"verifiedRoleCount",requested.Length,"verifiedRoles",requested,"locatorNodesVisited",replay.Visited,"foregroundUnchanged",Same(before,after,"foregroundHwnd"),"inputTickUnchanged",Same(before,after,"lastInputTick"),"before",before,"after",after,"elapsedMs",timer.ElapsedMilliseconds);
            if(includeFingerprint){report.Add("conversationFingerprint",fingerprint);report.Add("fingerprintUnavailable",fingerprintUnavailable);report.Add("titleTextRead",TitleTextRead);}if(readiness!=null)report.Add("navigationReadiness",readiness);
            if(refreshGeometry){report.Add("navigationGeometryRefreshed",true);report.Add("verification",VerificationProof(root.GetRuntimeId(),geometry,controls));}return report;
        }finally{if(process!=IntPtr.Zero)CloseHandle(process);SetThreadDpiAwarenessContext(dpiContext);}
    }
    static int VerifyLayoutSelfTest(){int n=0;
        Need(!NavigationGeometryRefresh(Data(),"input",null)&&!NavigationGeometryRefresh(Data("refreshNavigationGeometry",false),"input",null),"UI_CONTROLS_TEST_GEOMETRY_REFRESH_OPT_IN");n++;
        Need(NavigationGeometryRefresh(Data("refreshNavigationGeometry",true),"navigation-ready",Data("searchPopupHwnd","43")),"UI_CONTROLS_TEST_GEOMETRY_REFRESH_SEARCH");n++;
        foreach(var invalid in new[]{Data("refreshNavigationGeometry",1),Data("refreshNavigationGeometry","true"),Data("refreshNavigationGeometry",null)}){Reject(delegate{NavigationGeometryRefresh(invalid,"navigation-ready",Data("searchPopupHwnd","43"));},"UI_CONTROLS_CONVERSATION_REQUEST_INVALID");n++;}
        Reject(delegate{NavigationGeometryRefresh(Data("refreshNavigationGeometry",true),"input",Data("searchPopupHwnd","43"));},"UI_CONTROLS_CONVERSATION_REQUEST_INVALID");n++;
        Reject(delegate{NavigationGeometryRefresh(Data("refreshNavigationGeometry",true),"navigation-ready",Data("searchPopupHwnd","0"));},"UI_CONTROLS_CONVERSATION_REQUEST_INVALID");n++;
        n+=ConversationReadinessSelfTest();
        n+=PrimaryTitleSelfTest();
        Need(!FingerprintRequested(Data())&&!FingerprintRequested(Data("includeConversationFingerprint",false))&&FingerprintRequested(Data("includeConversationFingerprint",true)),"UI_CONTROLS_TEST_TITLE_OPT_IN");n++;
        foreach(object invalid in new object[]{null,"true",1,Data()}){Reject(delegate{FingerprintRequested(Data("includeConversationFingerprint",invalid));},"UI_CONTROLS_TITLE_OPTION_INVALID");n++;}
        var titleNodes=new List<object>{LayoutFixtureNode(-1,"mmui::ChatTitleBarMasterView","ControlType.Group"),LayoutFixtureNode(0,"mmui::ChatTitleBarChatSingleView","ControlType.Group"),LayoutFixtureNode(1,"mmui::XHBoxView","ControlType.Text"),LayoutFixtureNode(2,"mmui::XTextView","ControlType.Text"),LayoutFixtureNode(0,"mmui::ChatInputField","ControlType.Edit"),LayoutFixtureNode(4,"mmui::XTextView","ControlType.Text")};int titleIndex;
        Need(String.Join(",",TitleTextNodes(titleNodes,out titleIndex))=="3"&&titleIndex==2,"UI_CONTROLS_TEST_TITLE_READ_SCOPE");n++;
        Node(titleNodes,1)["className"]="mmui::ChatTitleBarChatRoomView";Need(TitleTextNodes(titleNodes,out titleIndex).Count==1,"UI_CONTROLS_TEST_TITLE_ROOM");n++;
        Node(titleNodes,3)["offscreen"]=true;Reject(delegate{TitleTextNodes(titleNodes,out titleIndex);},"UI_CONTROLS_TITLE_UNAVAILABLE");n++;Node(titleNodes,3)["offscreen"]=false;
        titleNodes.Add(LayoutFixtureNode(1,"mmui::XHBoxView","ControlType.Text"));Reject(delegate{TitleTextNodes(titleNodes,out titleIndex);},"UI_CONTROLS_TITLE_AMBIGUOUS");n++;titleNodes.RemoveAt(titleNodes.Count-1);
        Node(titleNodes,1)["className"]="mmui::MessageListView";Reject(delegate{TitleTextNodes(titleNodes,out titleIndex);},"UI_CONTROLS_TITLE_UNAVAILABLE");n++;
        string titleDigest=TitleDigest(new[]{"fixture title"});Need(Digest(titleDigest)&&titleDigest==TitleDigest(new[]{"fixture title"})&&titleDigest!=TitleDigest(new[]{"other title"})&&titleDigest!=TitleDigest(new[]{"fixture"," title"})&&!titleDigest.Contains("fixture"),"UI_CONTROLS_TEST_TITLE_DIGEST_CONTENT");n++;
        Need(TitleDigest(new[]{"a","bc"})!=TitleDigest(new[]{"ab","c"})&&TitleDigest(new[]{"a","b"})!=TitleDigest(new[]{"b","a"}),"UI_CONTROLS_TEST_TITLE_DIGEST_FRAMING");n++;
        var titleRoot=new Fixture{Name="mmui::ChatTitleBarMasterView"};var single=new Fixture{Name="mmui::ChatTitleBarChatSingleView"};var titleBox=new Fixture{Name="mmui::XHBoxView"};var titleLabel=new Fixture{Name="mmui::XTextView"};var decoration=new Fixture{Name="mmui::ChatlogMigrateView"};titleRoot.Children.Add(single);titleRoot.Children.Add(decoration);single.Next=decoration;single.Children.Add(titleBox);titleBox.Children.Add(titleLabel);var lastDecoration=decoration;
        for(int i=0;i<15;i++){var childDecoration=new Fixture{Name="mmui::XIcon"};lastDecoration.Children.Add(childDecoration);lastDecoration=childDecoration;}
        Func<Fixture,Fixture> fixtureChild=delegate(Fixture node){return node.Children.Count==0?null:node.Children[0];};Func<Fixture,Fixture> fixtureSibling=delegate(Fixture node){return node.Next;};Func<Fixture,Dictionary<string,object>> fixtureMetadata=delegate(Fixture node){return Data("className",node.Name,"controlType",node==titleBox||node==titleLabel?"ControlType.Text":"ControlType.Group","offscreen",false,"rect",Data());};
        Need(!Walk(titleRoot,fixtureChild,fixtureSibling,fixtureMetadata,64,12,delegate{return false;}).Complete,"UI_CONTROLS_TEST_TITLE_OLD_DECORATION_LIMIT");n++;
        var headerTree=Walk(titleRoot,fixtureChild,fixtureSibling,fixtureMetadata,64,24,delegate{return false;});Need(headerTree.Complete&&TitleTextNodes(headerTree.Nodes,out titleIndex).Count==1,"UI_CONTROLS_TEST_TITLE_DEEP_DECORATION");n++;
        foreach(var invalid in new IList<string>[] {null,new string[0],new[]{""},new string[]{null},new[]{"a\0b"},new[]{new string('a',257)},new[]{new string('a',256),new string('b',256),"x"},new[]{"a","b","c","d","e"}}){Reject(delegate{TitleDigest(invalid);},"UI_CONTROLS_TITLE_UNAVAILABLE");n++;}
        var nodes=new List<object>{LayoutFixtureNode(-1,"root","Window"),LayoutFixtureNode(0,"a","Group"),LayoutFixtureNode(1,"leaf","Text"),LayoutFixtureNode(0,"b","Group"),LayoutFixtureNode(3,"other","Text"),LayoutFixtureNode(3,"last","Text")};
        Need(String.Join(",",NodePath(nodes,2))=="0,0"&&String.Join(",",NodePath(nodes,5))=="1,1","UI_CONTROLS_TEST_FAST_PATH");n++;
        var root=new Fixture{Name="root"};var a=new Fixture{Name="a"};var b=new Fixture{Name="b"};var leaf=new Fixture{Name="leaf"};root.Children.Add(a);root.Children.Add(b);a.Next=b;b.Children.Add(leaf);int queries=0;
        var replay=new LocatorReplay<Fixture>(root,delegate(Fixture node){queries++;return node.Children.Count==0?null:node.Children[0];},delegate(Fixture node){queries++;return node.Next;},delegate{return false;});Need(replay.Resolve(new[]{1,0})==leaf&&queries==3,"UI_CONTROLS_TEST_FAST_REPLAY");n++;
        Need(replay.Resolve(new[]{1,0})==leaf&&queries==3,"UI_CONTROLS_TEST_FAST_SHARED_ANCESTORS");n++;Reject(delegate{replay.Resolve(new[]{2});},"UI_CONTROLS_FAST_LOCATOR_CHANGED");n++;
        var parentMap=new Dictionary<Fixture,Fixture>{{leaf,b},{b,root},{a,root},{root,null}};int parentReads=0;
        Func<Fixture,string> parentIdentity=delegate(Fixture node){return node.Name;};Func<Fixture,Fixture> parentRead=delegate(Fixture node){parentReads++;return parentMap[node];};var observation=new ParentObservation<Fixture>(parentIdentity,parentRead);
        Need(observation.GetParent(leaf)==b&&observation.GetParent(b)==root&&observation.GetParent(a)==root&&observation.GetParent(b)==root&&parentReads==3,"UI_CONTROLS_TEST_PARENT_OBSERVATION_SHARED_PATH");n++;
        Need(observation.GetParent(new Fixture{Name="b"})==root&&parentReads==3,"UI_CONTROLS_TEST_PARENT_OBSERVATION_RUNTIME_NOT_WRAPPER");n++;
        parentMap[b]=a;var nextObservation=new ParentObservation<Fixture>(parentIdentity,parentRead);Need(nextObservation.GetParent(b)==a&&parentReads==4,"UI_CONTROLS_TEST_PARENT_OBSERVATION_NEW_OPERATION_FRESH");n++;
        Need(observation.GetParent(root)==null&&observation.GetParent(root)==null&&parentReads==5,"UI_CONTROLS_TEST_PARENT_OBSERVATION_NULL_CACHED");n++;
        foreach(object invalid in new object[]{new int[0],new[]{512},new[]{-1},new object[]{"1"},new int[97]}){try{LocatorPath(invalid);throw new Exception("accepted invalid path");}catch(Fault){n++;}}
        var expected=Data("right",30,"bottom",40,"left",10,"top",20);Need(ExactRect(expected,Data("left",10,"top",20,"right",30,"bottom",40)),"UI_CONTROLS_TEST_FAST_RECT_ORDER");n++;expected["left"]=11;Need(!ExactRect(expected,Data("left",10,"top",20,"right",30,"bottom",40)),"UI_CONTROLS_TEST_FAST_RECT_CHANGED");n++;
        Need(!ParseArguments(new[]{"--verify-layout","--request","fixture.json"}),"UI_CONTROLS_TEST_FAST_READONLY");n++;Reject(delegate{ParseArguments(new[]{"--verify-layout","--request","fixture.json","--allow-control-write"});},"UI_CONTROLS_ARGUMENTS_INVALID");n++;
        var controls=new Dictionary<string,object>();int roleIndex=0;foreach(string role in VerifyRoles)controls.Add(role,Data("path",new[]{0,roleIndex++},"runtimeIdSha256",Hash(role),"className","mmui::Fixture","controlType","ControlType.Group","rect",Data("left",1,"top",2,"right",3,"bottom",4),"staticLabel",role=="send"?"发送":role=="recordStart"?"语音消息":null));
        var proof=VerificationProof(new[]{42,1},new LayoutGeometry{X=-100,Y=0,Width=800,Height=600,Dpi=96},controls);
        Need(CheckedVerification(Json.DeserializeObject(Json.Serialize(proof)))!=null,"UI_CONTROLS_TEST_FAST_PROOF_ROUNDTRIP");n++;
        foreach(string kind in new[]{"missing","duplicate","label","root","path"}){
            var changed=(Dictionary<string,object>)Json.DeserializeObject(Json.Serialize(proof));var roles=(Dictionary<string,object>)changed["roles"];var editor=(Dictionary<string,object>)roles["editor"];
            if(kind=="missing")roles.Remove("send");if(kind=="duplicate")editor["runtimeIdSha256"]=((Dictionary<string,object>)roles["search"])["runtimeIdSha256"];if(kind=="label")((Dictionary<string,object>)roles["send"])["staticLabel"]="private message";if(kind=="root")changed["rootRuntimeIdSha256"]="invalid";if(kind=="path")editor["path"]=new[]{512};
            Reject(delegate{CheckedVerification(changed);},"UI_CONTROLS_FAST_PROOF_INVALID");n++;
        }
        var expired=new LocatorReplay<Fixture>(root,delegate(Fixture node){throw new Exception("must not read tree");},delegate(Fixture node){throw new Exception("must not read tree");},delegate{return true;});Reject(delegate{expired.Resolve(new[]{0});},"UI_CONTROLS_FAST_DEADLINE");n++;
        Need(String.Join(",",RequestedRoles("input"))=="editor,send,header"&&String.Join(",",RequestedRoles("voice-start"))=="editor,send,header,recordStart,toolbar","UI_CONTROLS_TEST_FAST_ROLE_SCOPE");n++;foreach(string invalid in new[]{null,"","search","send"}){Reject(delegate{RequestedRoles(invalid);},"UI_CONTROLS_FAST_PHASE_INVALID");n++;}
        long requestId;Need(VerifierEnvelope(Data("version",1,"id",2,"request",Data()),1,out requestId)!=null&&requestId==2,"UI_CONTROLS_TEST_VERIFIER_ENVELOPE");n++;
        foreach(var packet in new[]{Data("version",1,"id",1,"request",Data()),Data("version",2,"id",2,"request",Data()),Data("version",1,"id",2,"request",Data(),"command","send"),Data("version",1,"id",2,"request","private")}){Reject(delegate{VerifierEnvelope(packet,1,out requestId);},"UI_CONTROLS_VERIFIER_PROTOCOL_INVALID");n++;}
        WarmVerifier();Need(!UiAccessed&&!ControlWriteAttempted&&!SearchValueRead,"UI_CONTROLS_TEST_VERIFIER_WARMUP_READONLY");n++;return n;
    }
    static int ConversationReadinessSelfTest(){int n=0;var binding=new Binding{Window=new IntPtr(42)};var request=Data("version",1,"expectedTitleSha256",Hash("fixture title"),"expectedQuerySha256",Hash("fixture query"),"searchPopupHwnd","0");var parsed=ReadinessRequest(request,binding);
        Need(parsed.PopupWindow==IntPtr.Zero&&parsed.Title==Hash("fixture title")&&parsed.Query==Hash("fixture query")&&String.Join(",",RequestedRoles("navigation-ready"))=="editor,send,header","UI_CONTROLS_TEST_READINESS_REQUEST");n++;
        request["searchPopupHwnd"]="43";Need(ReadinessRequest(request,binding).PopupWindow.ToInt64()==43,"UI_CONTROLS_TEST_READINESS_EXACT_POPUP");n++;request["searchPopupHwnd"]="0";
        foreach(string kind in new[]{"extra","version","title","query","popup-zeroes","popup-own","popup-negative","popup-numeric","popup-null"}){var changed=new Dictionary<string,object>(request);if(kind=="extra")changed["sameTargetAlreadyConfirmed"]=true;if(kind=="version")changed["version"]=2;if(kind=="title")changed["expectedTitleSha256"]="fixture title";if(kind=="query")changed["expectedQuerySha256"]="not a hash";if(kind=="popup-zeroes")changed["searchPopupHwnd"]="043";if(kind=="popup-own")changed["searchPopupHwnd"]="42";if(kind=="popup-negative")changed["searchPopupHwnd"]="-1";if(kind=="popup-numeric")changed["searchPopupHwnd"]=43;if(kind=="popup-null")changed["searchPopupHwnd"]=null;bool refused=false;try{ReadinessRequest(changed,binding);}catch(Fault){refused=true;}Need(refused,"UI_CONTROLS_TEST_READINESS_BAD_REQUEST");n++;}
        var ready=ConversationReadinessCore(parsed,parsed.Title,delegate{return true;},delegate{return true;},delegate{return Hash("page");},delegate{return true;});
        Need(ready.Count==11&&Object.Equals(ready["ready"],true)&&ready["reason"]==null&&Object.Equals(ready["samePage"],true)&&Object.Equals(ready["editorWritable"],true)&&Object.Equals(ready["searchClosed"],true)&&Object.Equals(ready["targetVerified"],false)&&(string)ready["querySha256"]==parsed.Query&&!Json.Serialize(ready).Contains("fixture title")&&!Json.Serialize(ready).Contains("fixture query"),"UI_CONTROLS_TEST_READINESS_REDACTED_FACTS_NOT_AUTHORIZATION");n++;
        foreach(string kind in new[]{"focus","search","page","editor","missing-title","wrong-title"}){int calls=0;string actual=kind=="missing-title"?null:kind=="wrong-title"?Hash("other title"):parsed.Title;var denied=ConversationReadinessCore(parsed,actual,delegate{calls++;return kind!="focus";},delegate{calls++;return kind!="search";},delegate{calls++;return kind=="page"?null:Hash("page");},delegate{calls++;return kind!="editor";});string expected=kind=="focus"?"WINDOW_INACTIVE":kind=="search"?"SEARCH_OPEN":kind=="page"?"PAGE_UNAVAILABLE":kind=="editor"?"EDITOR_UNAVAILABLE":kind=="missing-title"?"TITLE_UNAVAILABLE":"TITLE_MISMATCH";Need(Object.Equals(denied["ready"],false)&&(string)denied["reason"]=="UI_CONTROLS_CONVERSATION_"+expected&&calls==(kind=="focus"?1:kind=="search"?2:kind=="page"?3:4),"UI_CONTROLS_TEST_READINESS_INCOMPLETE_EVIDENCE");n++;}
        var changedDuringRead=ConversationReadinessCore(parsed,parsed.Title,delegate{return true;},delegate{return true;},delegate{throw new Exception("PRIVATE_PROVIDER_FIXTURE");},delegate{throw new Exception("must not read editor");});Need(Object.Equals(changedDuringRead["ready"],false)&&(string)changedDuringRead["reason"]=="UI_CONTROLS_CONVERSATION_CHANGED"&&!Json.Serialize(changedDuringRead).Contains("PRIVATE"),"UI_CONTROLS_TEST_READINESS_EXCEPTION_REDACTED");n++;
        Need(Hash("fixture title")!=TitleDigest(new[]{"fixture title"})&&Hash("fixture title")!=Hash("fixture title "),"UI_CONTROLS_TEST_READINESS_EXACT_PRIMARY_TEXT_HASH");n++;
        Need(ConversationPageRole("mmui::ChatMessagePage","ControlType.Group","chat_message_page",true,false,false)&&ConversationEditorRole("mmui::ChatInputField","ControlType.Edit","chat_input_field",true,false,true),"UI_CONTROLS_TEST_READINESS_KNOWN_ROLES");n++;
        foreach(int invalid in new[]{0,1,2,3,4,5}){Need(!ConversationPageRole(invalid==0?"mmui::Other":"mmui::ChatMessagePage",invalid==1?"ControlType.Edit":"ControlType.Group",invalid==2?"other_page":"chat_message_page",invalid!=3,invalid==4,invalid==5),"UI_CONTROLS_TEST_READINESS_PAGE_NOT_GENERIC_GROUP");Need(!ConversationEditorRole(invalid==0?"mmui::Other":"mmui::ChatInputField",invalid==1?"ControlType.Group":"ControlType.Edit",invalid==2?"other_field":"chat_input_field",invalid!=3,invalid==4,invalid!=5),"UI_CONTROLS_TEST_READINESS_EDITOR_NOT_ENABLED_ALONE");n+=2;}
        return n;
    }
    static int PrimaryTitleSelfTest(){int n=0;
        var nodes=new List<object>{LayoutFixtureNode(-1,"mmui::ChatTitleBarMasterView","ControlType.Group"),LayoutFixtureNode(0,"mmui::ChatTitleBarChatRoomView","ControlType.Group"),LayoutFixtureNode(1,"mmui::XHBoxView","ControlType.Text"),LayoutFixtureNode(2,"mmui::XTextView","ControlType.Text"),LayoutFixtureNode(2,"mmui::XTextView","ControlType.Text")};
        Node(nodes,2)["automationId"]=CurrentChatTitleBoxId;Node(nodes,3)["automationId"]=CurrentChatTitleBoxId+".current_chat_count_label";Node(nodes,4)["automationId"]=CurrentChatNameId;int title;var selected=TitleTextNodes(nodes,out title);
        Need(PrimaryTitleTextOffset(nodes,title,selected)==1,"UI_CONTROLS_TEST_GROUP_PRIMARY_ROLE_NOT_FIRST_TEXT");n++;
        var first=new[]{"(12)","fixture room"};var changedCount=new[]{"(13)","fixture room"};int primary=PrimaryTitleTextOffset(nodes,title,selected);
        Need(Hash(first[primary])==Hash(changedCount[primary])&&TitleDigest(first)!=TitleDigest(changedCount),"UI_CONTROLS_TEST_GROUP_COUNT_IN_FULL_FINGERPRINT_ONLY");n++;
        Node(nodes,3)["automationId"]=CurrentChatNameId;Node(nodes,4)["automationId"]=CurrentChatTitleBoxId+".current_chat_count_label";Need(PrimaryTitleTextOffset(nodes,title,selected)==0,"UI_CONTROLS_TEST_GROUP_PRIMARY_ROLE_OTHER_ORDER");n++;
        foreach(string unknown in new[]{"current_chat_name_label","other."+CurrentChatNameId,CurrentChatNameId+".extra",CurrentChatNameId.ToUpperInvariant(),"",null}){Node(nodes,3)["automationId"]=unknown;Need(PrimaryTitleTextOffset(nodes,title,selected)==-1,"UI_CONTROLS_TEST_PRIMARY_EXACT_OBJECT_PATH");n++;}
        Node(nodes,3)["automationId"]=CurrentChatNameId;Node(nodes,2)["automationId"]="other_title_line";Need(PrimaryTitleTextOffset(nodes,title,selected)==-1,"UI_CONTROLS_TEST_PRIMARY_PARENT_ROLE_REQUIRED");n++;Node(nodes,2)["automationId"]=CurrentChatTitleBoxId;
        Node(nodes,4)["automationId"]=CurrentChatNameId;Reject(delegate{PrimaryTitleTextOffset(nodes,title,selected);},"UI_CONTROLS_TITLE_AMBIGUOUS");n++;
        Node(nodes,4)["automationId"]=CurrentChatTitleBoxId+".current_chat_count_label";Node(nodes,3)["parent"]=1;Reject(delegate{PrimaryTitleTextOffset(nodes,title,selected);},"UI_CONTROLS_TITLE_CHANGED");n++;Node(nodes,3)["parent"]=2;
        Node(nodes,3)["offscreen"]=true;Reject(delegate{PrimaryTitleTextOffset(nodes,title,selected);},"UI_CONTROLS_TITLE_CHANGED");n++;Node(nodes,3)["offscreen"]=false;
        Node(nodes,1)["className"]="mmui::ChatTitleBarChatSingleView";nodes.RemoveAt(4);selected=TitleTextNodes(nodes,out title);Need(selected.Count==1&&PrimaryTitleTextOffset(nodes,title,selected)==0,"UI_CONTROLS_TEST_SINGLE_PRIMARY_KNOWN_ROLE");n++;
        Node(nodes,3)["automationId"]="unknown_single_label";Need(PrimaryTitleTextOffset(nodes,title,selected)==-1,"UI_CONTROLS_TEST_SINGLE_TEXT_WITHOUT_ROLE_NOT_PRIMARY");n++;
        return n;
    }
}
