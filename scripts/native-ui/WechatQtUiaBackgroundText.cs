// Inactive-window text transport. It owns no foreground lease and uses no
// clipboard, SetValue, screen pixels, or executable code in the target process.
// A queued message is only an attempt; delivery is confirmed by the coordinator.
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;
using System.Windows.Automation;

internal static partial class WechatDraftProbe {
    const string QtBgTransport="window-message-background-v1";
    sealed class QtBgTextLease {
        internal string Id,Token,ProofId,Digest,OwnText;
        internal long Revision,Issued;
        internal Binding Binding;
        internal IntPtr Foreground;
        internal Point Cursor;
        internal QtTextStepBinding Step;
        internal Dictionary<string,object> Fingerprint;
        internal List<QtUiaRole> Roles;
        internal bool WriteStarted,Written,SubmitStarted,Consumed,RetainedEditorRoute;
        internal string Phase="prepared";
        internal int CharactersPosted,SubmitMessagesPosted;
    }
    sealed class QtBgRetainedEditor {
        internal Binding Binding;internal long Revision,Issued;internal QtTextStepBinding Step;internal string HeaderHash,EditorHash;
    }
    static QtBgRetainedEditor QtBgEditorContinuation;
    static QtBgTextLease QtBgText;
    static bool QtBgRetentionRequested(Dictionary<string,object> request,string kind){if(!request.ContainsKey("retainBackgroundEditor"))return false;Need(kind=="text"&&Get(request,"retainBackgroundEditor") is bool,"QT_BG_RETAIN_REQUEST_INVALID");return Object.Equals(Get(request,"retainBackgroundEditor"),true);}
    static bool QtBgAction(string action){return action=="prepareUiaBackgroundText"||action=="writeUiaBackgroundText"||action=="submitUiaBackgroundText"||action=="releaseUiaBackgroundText";}
    static void QtBgRevoke(){if(QtBgText!=null){QtBgText.Consumed=true;QtBgText.ProofId=null;QtBgText.OwnText=null;}QtBgText=null;}
    static bool QtBgKeepsContinuation(string action){return action=="inspectLayout"||action=="inspectTargetOcclusion"||action=="inspectFocusHandoff"||action=="inspectFocusActivation"||action=="inspectUiaFocusGeometry"||action=="releaseFocusHandoff"||action=="prepareUiaBackgroundText"||action=="releaseUiaBackgroundText";}
    static void QtBgActionBoundary(string action){if(!QtBgKeepsContinuation(action))QtBgEditorContinuation=null;if(!QtBgAction(action))QtBgRevoke();else{QtCurrent=null;QtRevokeEnter();QtEmptyPhaseProof=null;}}
    static object QtBgFailure(){object report=QtBgText==null?null:QtBgProgress(QtBgText,GetForegroundWindow());if(QtBgText!=null&&QtBgText.WriteStarted)InputAttempted=true;QtBgRevoke();QtBgEditorContinuation=null;return report;}
    static object QtBgProgress(QtBgTextLease lease,IntPtr foreground){return Data("version",1,"transport",QtBgTransport,"phase",lease.Phase,"editorClickAttempted",false,"retainedEditorRoute",lease.RetainedEditorRoute,"charactersPosted",lease.CharactersPosted,"mouseMessagesPosted",lease.SubmitMessagesPosted,"writeStarted",lease.WriteStarted,"submitStarted",lease.SubmitStarted,"originalForegroundIsWechat",lease.Foreground==lease.Binding.Window,"currentForegroundIsWechat",foreground==lease.Binding.Window,"retryAllowed",false);}
    static QtBgRetainedEditor QtBgCaptureEditorContinuation(QtFrame frame,QtTextStepBinding step){
        // This optional capability is minted only by the native foreground text
        // submit path. A caller checkpoint or inactive HasKeyboardFocus=false
        // cannot claim that the logical character recipient is still the editor.
        try{
            if(frame==null||!frame.MetadataOnly||QtLease==null||!QtLease.UiaMode||step==null||frame.Binding.Focus!=frame.Binding.Window||!frame.Binding.FocusOwned||frame.UiaRoles==null)return null;
            QtUiaRole editor=null,header=null;foreach(var role in frame.UiaRoles){if(role.Role=="editor")editor=role;if(role.Role=="header")header=role;}
            if(editor==null||header==null||!editor.Node.Element.Current.HasKeyboardFocus||(editor.Node.NativeWindowHandle!=0&&new IntPtr(unchecked((long)(uint)editor.Node.NativeWindowHandle))!=frame.Binding.Window))return null;
            if(frame.Revision!=Interlocked.Read(ref Revision)||GetForegroundWindow()!=frame.Binding.Window)return null;
            return new QtBgRetainedEditor{Binding=frame.Binding,Revision=frame.Revision,Issued=Now(),Step=step,HeaderHash=header.Hash,EditorHash=editor.Hash};
        }catch{return null;}
    }
    static bool QtBgContinuationMatches(QtBgRetainedEditor retained,QtBgTextLease lease,long now){return retained!=null&&lease!=null&&now>=retained.Issued&&now-retained.Issued<=30000&&retained.Revision==lease.Revision&&QtBgSameBinding(retained.Binding,lease.Binding)&&retained.Step!=null&&lease.Step!=null&&retained.Step.Account==lease.Step.Account&&retained.Step.Target==lease.Step.Target&&retained.Step.Delivery!=lease.Step.Delivery&&retained.HeaderHash==QtBgRole(lease,"header").Hash&&retained.EditorHash==QtBgRole(lease,"editor").Hash;}
    static void QtBgRememberSubmittedEditor(QtBgRetainedEditor retained){QtBgEditorContinuation=retained!=null&&retained.Revision==Interlocked.Read(ref Revision)?retained:null;}
    static string QtBgHash(string value){return QtHash(Encoding.UTF8.GetBytes(value));}
    static void QtBgValidateText(string value){
        Need(!String.IsNullOrEmpty(value)&&value.Length<=16000,"QT_BG_TEXT_UNSUPPORTED");
        for(int i=0;i<value.Length;i++){
            char c=value[i];bool pair=Char.IsHighSurrogate(c);
            Need(!Char.IsLowSurrogate(c)&&(!pair||i+1<value.Length&&Char.IsLowSurrogate(value[i+1])),"QT_BG_TEXT_UNSUPPORTED");
            Need(!Char.IsControl(c)&&c!='\u2028'&&c!='\u2029'&&CharUnicodeInfo.GetUnicodeCategory(value,i)!=UnicodeCategory.Format,"QT_BG_TEXT_UNSUPPORTED");
            if(pair)i++;
        }
    }
    // Validate the whole string before the first post. No successful prefix can
    // cause a retry, even when PostMessage rejects its very first character.
    static int QtBgPostText(string text,Func<char,bool> post,Action guard,Action attempted){
        QtBgValidateText(text);int count=0;
        foreach(char c in text){guard();attempted();Need(post(c),"QT_BG_CHARACTER_QUEUE_REJECTED");count++;}
        return count;
    }
    static bool QtBgSameBinding(Binding a,Binding b){return a!=null&&b!=null&&a.Window==b.Window&&a.Pid==b.Pid&&a.Thread==b.Thread&&a.Created==b.Created&&a.Dpi==b.Dpi&&Same(a.Client,b.Client)&&Same(a.Capture,b.Capture);}
    static Binding QtBgSnapshot(IntPtr window){
        var identity=QtFocusWindow(window,QtExecutable);Need(QtUiaWindowEnabled(window)&&GetWindow(window,4)==IntPtr.Zero,"QT_BG_WINDOW_UNAVAILABLE");
        uint pid;uint thread=GetWindowThreadProcessId(window,out pid);Rect client;Point origin=new Point(0,0);
        Need(GetClientRect(window,out client)&&client.Width>0&&client.Height>0&&ClientToScreen(window,ref origin),"QT_BG_GEOMETRY_UNAVAILABLE");
        var gui=new GuiInfo{Size=(uint)Marshal.SizeOf(typeof(GuiInfo))};Need(GetGUIThreadInfo(thread,ref gui)&&gui.Capture==IntPtr.Zero&&gui.MenuOwner==IntPtr.Zero&&gui.MoveSize==IntPtr.Zero&&(gui.Flags&0x1e)==0,"QT_BG_GUI_BUSY");
        Need(GetForegroundWindow()!=window,"QT_BG_FOREGROUND_OWNED_BY_USER");
        return new Binding{Window=window,Pid=identity.Pid,Created=identity.Created,Thread=thread,Dpi=GetDpiForWindow(window),Client=client,Capture=new Rect(origin.X,origin.Y,origin.X+client.Width,origin.Y+client.Height),Focus=gui.Focus,FocusOwned=Owned(gui.Focus,window,pid),Caret=gui.Caret,CaretOwned=Owned(gui.Caret,window,pid),InputTick=QtInputTick(),GuiFlags=gui.Flags};
    }
    static object QtBgBindingReport(Binding binding){var report=Map(binding.Report());report["foreground"]=false;report["caretRectInClient"]=null;return report;}
    static void QtBgCheckpoint(Dictionary<string,object> request,Binding binding,long revision){
        var checkpoint=Map(Get(request,"checkpoint"));var expected=Map(Get(checkpoint,"binding"));
        Need(checkpoint!=null&&Text(checkpoint,"epoch")==QtEpoch&&Number(Get(checkpoint,"revision"))==revision&&expected!=null,"QT_BG_CHECKPOINT_CHANGED");
        Need(DecimalString(Get(expected,"hwnd"))==binding.Window.ToInt64()&&Number(Get(expected,"pid"))==binding.Pid&&DecimalString(Get(expected,"processCreatedFileTimeUtc"))==binding.Created&&Number(Get(expected,"threadId"))==binding.Thread&&Number(Get(expected,"dpi"))==binding.Dpi&&Same(ParseRect(Get(expected,"clientRect")),binding.Client)&&Same(ParseRect(Get(expected,"captureRect")),binding.Capture),"QT_BG_CHECKPOINT_CHANGED");
    }
    static bool QtBgFingerprintEqual(Dictionary<string,object> a,Dictionary<string,object> b){
        return a!=null&&b!=null&&Object.Equals(Get(a,"version"),Get(b,"version"))&&Text(a,"scope")=="chat-title-text-v1"&&Text(a,"scope")==Text(b,"scope")&&Text(a,"sha256")==Text(b,"sha256")&&Text(a,"headerRuntimeIdSha256")==Text(b,"headerRuntimeIdSha256")&&Text(a,"titleRuntimeIdSha256")==Text(b,"titleRuntimeIdSha256")&&Number(Get(a,"textNodeCount"))==Number(Get(b,"textNodeCount"));
    }
    static Dictionary<string,object> QtBgParseFingerprint(object value){
        var map=Map(value);Need(map!=null&&map.Count==7&&Number(Get(map,"version"))==1&&Text(map,"scope")=="chat-title-text-v1"&&Hex(Text(map,"sha256"),64)&&Hex(Text(map,"headerRuntimeIdSha256"),64)&&Hex(Text(map,"titleRuntimeIdSha256"),64)&&Number(Get(map,"textNodeCount"))>=1&&Number(Get(map,"textNodeCount"))<=4&&Object.Equals(Get(map,"targetVerified"),false),"QT_BG_CONVERSATION_INVALID");return map;
    }
    // The same digest/framing as BackgroundVerify: only the bounded, known
    // current-title subtree is read. Chat messages are never enumerated.
    static Dictionary<string,object> QtBgConversation(QtUiaRole header,Binding binding,List<string> titleParts=null){
        var cache=QtUiaControlCache();var names=QtUiaControlCache();names.Add(AutomationElement.NameProperty);
        var walker=TreeWalker.RawViewWalker;QtUiaNode title=null;var texts=new List<QtUiaNode>();int visited=0;long deadline=Now()+700;
        Action<QtUiaNode,int> walk=null;walk=delegate(QtUiaNode node,int depth){
            Need(++visited<=64&&depth<=24&&Now()<=deadline,"QT_BG_TITLE_SCAN_LIMIT");Need(node.Pid==binding.Pid,"QT_BG_TITLE_CHANGED");if(node.Offscreen)return;
            if(node.Class=="mmui::XHBoxView"&&node.Type==ControlType.Text&&(QtUiaAncestor(node,"mmui::ChatTitleBarChatSingleView")!=null||QtUiaAncestor(node,"mmui::ChatTitleBarChatRoomView")!=null)){Need(title==null,"QT_BG_TITLE_AMBIGUOUS");title=node;}
            for(var child=walker.GetFirstChild(node.Element,cache);child!=null;child=walker.GetNextSibling(child,cache)){var next=QtUiaReadControl(child,node,binding);if(Object.ReferenceEquals(node,title)&&!next.Offscreen&&next.Class=="mmui::XTextView"&&next.Type==ControlType.Text)texts.Add(next);walk(next,depth+1);}
        };walk(header.Node,0);Need(title!=null&&texts.Count>=1&&texts.Count<=4,"QT_BG_TITLE_UNAVAILABLE");
        var digest=new StringBuilder("chat-title-text-v1\n");int total=0;
        foreach(var node in texts){var live=node.Element.GetUpdatedCache(names);var current=QtUiaReadControl(live,node.Parent,binding);Need(QtUiaSameControl(node,current,binding.Pid),"QT_BG_TITLE_CHANGED");string value=live.Cached.Name;Need(value!=null&&value.Length>0&&value.Length<=256&&value.IndexOf('\0')<0&&(total+=value.Length)<=512,"QT_BG_TITLE_UNAVAILABLE");if(titleParts!=null)titleParts.Add(value);digest.Append(value.Length.ToString(CultureInfo.InvariantCulture)).Append(':').Append(value).Append('\n');}
        return Data("version",1,"scope","chat-title-text-v1","sha256",QtBgHash(digest.ToString()),"headerRuntimeIdSha256",QtBgHash(header.Node.Runtime),"titleRuntimeIdSha256",QtBgHash(title.Runtime),"textNodeCount",texts.Count,"targetVerified",false);
    }
    static QtUiaRole QtBgRole(QtBgTextLease lease,string name){foreach(var role in lease.Roles)if(role.Role==name)return role;throw new Fault("QT_BG_ROLE_UNAVAILABLE");}
    static string QtBgEditorValue(QtBgTextLease lease){object pattern;var editor=QtBgRole(lease,"editor").Node.Element;Need(editor.TryGetCurrentPattern(ValuePattern.Pattern,out pattern)&&pattern is ValuePattern,"QT_BG_VALUE_UNAVAILABLE");var value=(ValuePattern)pattern;Need(!value.Current.IsReadOnly,"QT_BG_VALUE_READ_ONLY");return value.Current.Value;}
    static void QtBgRequireEmpty(QtBgTextLease lease){
        Need(QtBgEditorValue(lease)=="","QT_BG_EDITOR_NOT_EMPTY");object pattern;var editor=QtBgRole(lease,"editor").Node.Element;
        Need(editor.TryGetCurrentPattern(TextPattern.Pattern,out pattern)&&pattern is TextPattern,"QT_BG_RICH_EMPTY_UNAVAILABLE");
        var range=((TextPattern)pattern).DocumentRange;Need(range!=null&&range.GetText(1)==""&&range.GetChildren().Length==0&&!QtBgRole(lease,"send").Node.Element.Current.IsEnabled,"QT_BG_RICH_EMPTY_UNVERIFIED");
        Need(QtBgEditorValue(lease)=="","QT_BG_EDITOR_NOT_EMPTY");
    }
    static void QtBgRequireOwnText(QtBgTextLease lease,string expected){
        Need(QtBgEditorValue(lease)==expected,"QT_BG_OWN_VALUE_CHANGED");object pattern;var editor=QtBgRole(lease,"editor").Node.Element;
        Need(editor.TryGetCurrentPattern(TextPattern.Pattern,out pattern)&&pattern is TextPattern,"QT_BG_RICH_EMPTY_UNAVAILABLE");
        var range=((TextPattern)pattern).DocumentRange;Need(range!=null&&range.GetChildren().Length==0&&range.GetText(expected.Length+1)==expected,"QT_BG_OWN_RICH_TEXT_CHANGED");
    }
    static void QtBgAwaitSubmitConsumption(QtBgTextLease lease){
        lease.Phase="submit-consumption";long deadline=Now()+650;
        for(;;){QtBgQuickGuard(lease);string value=QtBgEditorValue(lease);if(value==""&&!QtBgRole(lease,"send").Node.Element.Current.IsEnabled){QtBgGuard(lease,true);QtBgRequireEmpty(lease);QtBgQuickGuard(lease);return;}
            Need((value==""||value==lease.OwnText)&&Now()<deadline,"QT_BG_SUBMIT_CONSUMPTION_UNCONFIRMED");Thread.Sleep(5);
        }
    }
    static void QtBgQuickGuard(QtBgTextLease lease){
        Need(!Stopping&&!lease.Consumed&&lease.Revision==Interlocked.Read(ref Revision)&&lease.Binding.InputTick==QtInputTick(),"QT_HUMAN_ACTIVITY_CHANGED");
        Need(GetForegroundWindow()==lease.Foreground&&lease.Foreground!=lease.Binding.Window,"QT_BG_FOREGROUND_CHANGED");
        uint pid;Need(IsWindow(lease.Binding.Window)&&GetWindowThreadProcessId(lease.Binding.Window,out pid)==lease.Binding.Thread&&pid==lease.Binding.Pid,"QT_BG_BINDING_CHANGED");
        Point cursor;Need(FocusGetCursorPos(out cursor)&&QtSamePoint(cursor,lease.Cursor),"QT_HUMAN_ACTIVITY_CHANGED");
    }
    static void QtBgGuard(QtBgTextLease lease,bool scene){
        QtBgQuickGuard(lease);Need(QtLease==null&&QtParkedLease==null&&QtPopup==null&&QtPendingPopup==null&&QtSurface=="main","QT_BG_FOREGROUND_LEASE_CONFLICT");
        Binding current=QtBgSnapshot(lease.Binding.Window);Need(QtBgSameBinding(lease.Binding,current)&&QtRootWindow==current.Window&&QtRootPid==current.Pid&&QtRootCreated==current.Created,"QT_BG_BINDING_CHANGED");NoKeysHeld();
        if(scene){lease.Roles=QtUiaRefreshRoles(current,lease.Roles);var header=QtBgRole(lease,"header");string page=QtUiaAncestor(header.Node,"mmui::ChatMessagePage").Runtime;foreach(var role in lease.Roles)Need(QtUiaAncestor(role.Node,"mmui::ChatMessagePage").Runtime==page,"QT_BG_PAGE_CHANGED");Need(QtBgFingerprintEqual(lease.Fingerprint,QtBgConversation(header,current)),"QT_BG_CONVERSATION_CHANGED");}
        QtBgQuickGuard(lease);
    }
    static object QtBgFrame(QtBgTextLease lease,string editorState){
        var regions=new List<object>();foreach(var role in lease.Roles)regions.Add(Data("role",role.Role,"rect",role.Node.Rect.Report(),"controlSha256",role.Hash));
        return Data("token",lease.Token,"epoch",QtEpoch,"revision",lease.Revision,"idleMs",Math.Max(0,Now()-Interlocked.Read(ref LastActivity)),"binding",QtBgBindingReport(lease.Binding),"observationKind","uia-background-metadata-v1","pixelsRead",false,"inputTransport",QtBgTransport,"regions",regions,"backgroundLeaseId",lease.Id,"conversationFingerprint",lease.Fingerprint,"editorState",editorState,"image",null,"inputSent",false);
    }
    static object QtPrepareUiaBackgroundText(Dictionary<string,object> request){
        Need(QtBgText==null,"QT_BG_LEASE_ALREADY_EXISTS");
        try{
            Need(QtEnableInput&&!Stopping&&QtLease==null&&QtParkedLease==null&&QtPopup==null&&QtPendingPopup==null&&QtSurface=="main","QT_BG_FOREGROUND_LEASE_CONFLICT");
            long idle=Number(Get(request,"idleMs"));Need(idle>=1000&&idle<=300000,"QT_IDLE_INVALID");QtRequireIdle(idle);NoKeysHeld();
            long revision=Interlocked.Read(ref Revision);var step=QtParseTextStep(Get(request,"stepBinding"));Need(step!=null,"QT_TEXT_STEP_INVALID");var fingerprint=QtBgParseFingerprint(Get(request,"conversationFingerprint"));
            Need(QtRootWindow!=IntPtr.Zero&&QtRootWindow==QtWindow,"QT_BG_CHECKPOINT_REQUIRED");var binding=QtBgSnapshot(QtRootWindow);QtBgCheckpoint(request,binding,revision);
            var lease=new QtBgTextLease{Id=Guid.NewGuid().ToString("N"),Token=Guid.NewGuid().ToString("N"),Revision=revision,Issued=Now(),Binding=binding,Foreground=GetForegroundWindow(),Step=step,Fingerprint=fingerprint,Roles=new List<QtUiaRole>()};Need(FocusGetCursorPos(out lease.Cursor),"QT_POINTER_UNAVAILABLE");
            var found=QtUiaResolveRoles(binding,new[]{"header","editor","send"});foreach(string name in new[]{"header","editor","send"})lease.Roles.Add(found[name]);
            QtBgGuard(lease,true);QtBgRequireEmpty(lease);QtBgGuard(lease,false);Need(QtBgContinuationMatches(QtBgEditorContinuation,lease,Now()),"QT_BG_RETAINED_EDITOR_REQUIRED");lease.RetainedEditorRoute=true;QtBgEditorContinuation=null;QtBgText=lease;
            return Data("ready",true,"reason",null,"readOnly",true,"inputSent",false,"attempted",false,"focusChanged",false,"clipboardAccessed",false,"backgroundLeaseId",lease.Id,"frame",QtBgFrame(lease,"empty"));
        }catch(Fault error){QtBgRevoke();QtBgEditorContinuation=null;return Data("ready",false,"reason",error.Message,"readOnly",true,"inputSent",false,"attempted",false,"focusChanged",false,"clipboardAccessed",false);}
    }
    static QtBgTextLease QtBgRequest(Dictionary<string,object> request){
        var lease=QtBgText;Need(lease!=null&&!lease.Consumed&&Text(request,"backgroundLeaseId")==lease.Id&&Text(request,"token")==lease.Token&&Text(request,"epoch")==QtEpoch&&Number(Get(request,"revision"))==lease.Revision,"QT_BG_TOKEN_INVALID");
        Need(Now()>=lease.Issued&&Now()-lease.Issued<=30000&&QtSameTextStep(lease.Step,QtParseTextStep(Get(request,"stepBinding"))),"QT_BG_STEP_EXPIRED_OR_CHANGED");
        long idle=Number(Get(request,"idleMs"));Need(idle>=1000&&idle<=300000,"QT_IDLE_INVALID");QtRequireIdle(idle);QtBgGuard(lease,true);return lease;
    }
    static Point QtBgPoint(QtBgTextLease lease,string roleName){var role=QtBgRole(lease,roleName);Rect rect=role.Node.Rect;Need(role.Node.Element.Current.IsEnabled,"QT_UIA_CONTROL_DISABLED");var point=new Point(rect.Left+rect.Width/2,rect.Top+rect.Height/2);Need(Contains(lease.Binding.Client,rect)&&QtUiaChildAtPoint(lease.Binding.Window,point,7)==lease.Binding.Window,"QT_BG_NATIVE_CHILD_UNSUPPORTED");WindowMessageCoordinates(point);return point;}
    static object QtWriteUiaBackgroundText(Dictionary<string,object> request){
        string text=Text(request,"text");QtBgValidateText(text);Need(text==Text(request,"expectedText"),"QT_BG_APPEND_UNSUPPORTED");
        var lease=QtBgRequest(request);Need(!lease.WriteStarted&&!lease.Written&&!lease.SubmitStarted,"QT_BG_WRITE_ALREADY_ATTEMPTED");Need(lease.RetainedEditorRoute,"QT_BG_RETAINED_EDITOR_REQUIRED");lease.Phase="write-preflight";QtBgRequireEmpty(lease);
        Action mark=delegate{InputAttempted=true;lease.WriteStarted=true;lease.Token=null;};
        // No editor mouse messages: Qt can activate itself even for directed
        // clicks. This single use route survives only our preceding text Enter.
        lease.Phase="characters";int index=0;int posted=QtBgPostText(text,delegate(char c){bool queued=WindowMessagePost(lease.Binding.Window,0x102,new UIntPtr((uint)c),new IntPtr(1));if(queued)lease.CharactersPosted++;return queued;},delegate{QtBgQuickGuard(lease);if((index++&63)==0)QtBgGuard(lease,false);},mark);
        lease.Phase="value-confirmation";
        long deadline=Now()+1000;for(;;){QtBgQuickGuard(lease);string value=QtBgEditorValue(lease);if(value==text)break;Need(value!=null&&text.StartsWith(value,StringComparison.Ordinal)&&Now()<deadline,"QT_BG_OWN_VALUE_UNCONFIRMED");Thread.Sleep(5);}
        QtBgGuard(lease,true);QtBgRequireOwnText(lease,text);lease.OwnText=text;lease.Digest=QtBgHash(text);lease.ProofId=Guid.NewGuid().ToString("N");lease.Token=Guid.NewGuid().ToString("N");lease.Written=true;lease.Phase="written";
        return Data("performed",true,"attempted",true,"textTransport",QtBgTransport,"valueConfirmed",true,"uiaConsumptionConfirmed",true,"clipboardAccessed",false,"intendedText",text,"readbackPerformed",false,"interrupted",false,"messagesPosted",posted,"backgroundProgress",QtBgProgress(lease,GetForegroundWindow()),"postPasteFrame",QtBgFrame(lease,"own-text"),"textEnterProof",Data("version",1,"id",lease.ProofId,"textSha256",lease.Digest));
    }
    static bool QtBgProofMatches(QtBgTextLease lease,string proof,string digest){return lease!=null&&lease.Written&&lease.WriteStarted&&!lease.SubmitStarted&&!lease.Consumed&&Hex(proof,32)&&Hex(digest,64)&&lease.ProofId==proof&&lease.Digest==digest;}
    static object QtSubmitUiaBackgroundText(Dictionary<string,object> request){
        var lease=QtBgRequest(request);lease.Phase="submit-preflight";Need(QtBgProofMatches(lease,Text(request,"textEnterProofId"),Text(request,"textSha256")),"QT_BG_ENTER_PROOF_INVALID");QtBgRequireOwnText(lease,lease.OwnText);Point point=QtBgPoint(lease,"send");
        Need(QtQuoteInputClear(QtBgRole(lease,"editor").Node,false),"QT_QUOTE_DRAFT_PRESENT");
        // Consume before the very first directed message, including mousemove.
        // A partial queue, stale element or later activity can never resend it.
        lease.ProofId=null;lease.SubmitStarted=true;lease.Token=null;lease.Phase="submit-messages";
        int posted=WindowMessageClickCore(point,delegate(uint message,UIntPtr flags,IntPtr coordinates){bool queued=WindowMessagePost(lease.Binding.Window,message,flags,coordinates);if(queued)lease.SubmitMessagesPosted++;return queued;},delegate{QtBgGuard(lease,false);Need(QtBgEditorValue(lease)==lease.OwnText&&QtBgRole(lease,"send").Node.Element.Current.IsEnabled,"QT_BG_OWN_VALUE_CHANGED");},delegate{return QtUiaPointerRecipientSame(lease.Binding);},delegate{InputAttempted=true;});
        QtBgAwaitSubmitConsumption(lease);QtBgQuickGuard(lease);IntPtr finalForeground=GetForegroundWindow();Need(finalForeground==lease.Foreground,"QT_BG_FOREGROUND_CHANGED");lease.Consumed=true;lease.Phase="submit-consumed";
        return Data("performed",true,"attempted",true,"inputQueued",true,"submissionConfirmed",false,"editorEmptyAfterSubmit",true,"consumptionConfirmed",true,"revision",lease.Revision,"inputTransport",QtBgTransport,"messagesPosted",posted,"backgroundProgress",QtBgProgress(lease,finalForeground),"foregroundChanged",false,"clipboardAccessed",false);
    }
    static object QtReleaseUiaBackgroundText(Dictionary<string,object> request){string id=Text(request,"backgroundLeaseId");Need(Hex(id,32)&&(QtBgText==null||id==QtBgText.Id),"QT_BG_LEASE_INVALID");QtBgRevoke();return Data("released",true,"backgroundLeaseId",id,"inputSent",false,"focusChanged",false);}
    static int QtUiaBackgroundTextSelfTest(){int n=0;
        Need(!QtBgRetentionRequested(Data(),"text")&&!QtBgRetentionRequested(Data("retainBackgroundEditor",false),"text")&&QtBgRetentionRequested(Data("retainBackgroundEditor",true),"text"),"QT_BG_TEST_CONTINUATION_CAPTURE_EXPLICIT_ONLY");n++;
        foreach(object invalid in new object[]{null,0,1,"true",Data()}){Expect(delegate{QtBgRetentionRequested(Data("retainBackgroundEditor",invalid),"text");},"QT_BG_RETAIN_REQUEST_INVALID");n++;}
        foreach(bool value in new[]{false,true}){Expect(delegate{QtBgRetentionRequested(Data("retainBackgroundEditor",value),"search");},"QT_BG_RETAIN_REQUEST_INVALID");n++;}
        foreach(string good in new[]{"A","中文 123","a\ud83d\ude00b",new string('x',16000)}){QtBgValidateText(good);n++;}
        foreach(string bad in new[]{"",null,"a\nb","a\rb","a\tb","a\0b","a\u2028b","a\u2029b","a\u200db","\ud800","\udc00","\ud800A",new string('x',16001)}){Expect(delegate{QtBgValidateText(bad);},"QT_BG_TEXT_UNSUPPORTED");n++;}
        int posts=0,guards=0,attempts=0;Expect(delegate{QtBgPostText("valid\ninvalid",delegate(char c){posts++;return true;},delegate{guards++;},delegate{attempts++;});},"QT_BG_TEXT_UNSUPPORTED");Need(posts==0&&guards==0&&attempts==0,"QT_BG_TEST_FULL_PREFLIGHT");n++;
        for(int failure=0;failure<3;failure++){int fail=failure;posts=guards=attempts=0;Expect(delegate{QtBgPostText("abc",delegate(char c){return posts++!=fail;},delegate{guards++;},delegate{attempts++;});},"QT_BG_CHARACTER_QUEUE_REJECTED");Need(posts==failure+1&&guards==posts&&attempts==posts,"QT_BG_TEST_NO_RETRY");n++;}
        posts=attempts=0;Expect(delegate{QtBgPostText("abc",delegate(char c){posts++;return true;},delegate{if(posts==1)throw new Fault("QT_HUMAN_ACTIVITY_CHANGED");},delegate{attempts++;});},"QT_HUMAN_ACTIVITY_CHANGED");Need(posts==1&&attempts==1,"QT_BG_TEST_ACTIVITY_STOPS_PREFIX");n++;
        var lease=new QtBgTextLease{Written=true,WriteStarted=true,ProofId=new string('a',32),Digest=new string('b',64)};Need(QtBgProofMatches(lease,lease.ProofId,lease.Digest),"QT_BG_TEST_BOUND_PROOF");n++;lease.SubmitStarted=true;Need(!QtBgProofMatches(lease,lease.ProofId,lease.Digest),"QT_BG_TEST_CONSUMED_PROOF");n++;
        Need(!QtBgProofMatches(null,new string('a',32),new string('b',64)),"QT_BG_TEST_NO_CALLER_MINTED_PROOF");n++;
        var a=new Binding{Window=new IntPtr(1),Pid=2,Thread=3,Created=4,Dpi=96,Client=new Rect(0,0,600,500),Capture=new Rect(10,10,610,510),Focus=new IntPtr(1)};var b=new Binding{Window=a.Window,Pid=a.Pid,Thread=a.Thread,Created=a.Created,Dpi=a.Dpi,Client=a.Client,Capture=a.Capture,Focus=IntPtr.Zero};Need(QtBgSameBinding(a,b)&&Object.Equals(Get(Map(QtBgBindingReport(a)),"foreground"),false),"QT_BG_TEST_NO_FAKE_FOREGROUND");n++;b.Created++;Need(!QtBgSameBinding(a,b),"QT_BG_TEST_PROCESS_REUSE");n++;
        b.Created=a.Created;var retained=new QtBgRetainedEditor{Binding=a,Revision=7,Issued=100,Step=new QtTextStepBinding{Delivery="old",Account="account",Target="target"},HeaderHash="header",EditorHash="editor"};
        var next=new QtBgTextLease{Binding=b,Revision=7,Step=new QtTextStepBinding{Delivery="new",Account="account",Target="target"},Roles=new List<QtUiaRole>{new QtUiaRole{Role="header",Hash="header"},new QtUiaRole{Role="editor",Hash="editor"}}};
        Need(QtBgContinuationMatches(retained,next,101)&&!QtBgContinuationMatches(null,next,101)&&!QtBgContinuationMatches(retained,next,99)&&!QtBgContinuationMatches(retained,next,30101),"QT_BG_TEST_NATIVE_ROUTE_FRESH_BOUND_NOT_CALLER_MINTED");n++;
        next.Step.Account="different";Need(!QtBgContinuationMatches(retained,next,101),"QT_BG_TEST_ROUTE_ACCOUNT_BOUND");next.Step.Account="account";n++;
        next.Step.Target="different";Need(!QtBgContinuationMatches(retained,next,101),"QT_BG_TEST_ROUTE_TARGET_BOUND");next.Step.Target="target";n++;
        next.Step.Delivery="old";Need(!QtBgContinuationMatches(retained,next,101),"QT_BG_TEST_ROUTE_NEVER_RETRIES_PRIOR_DELIVERY");next.Step.Delivery="new";n++;
        next.Revision++;Need(!QtBgContinuationMatches(retained,next,101),"QT_BG_TEST_ROUTE_REJECTS_HUMAN_INPUT");next.Revision--;n++;
        next.Roles[1].Hash="other-editor";Need(!QtBgContinuationMatches(retained,next,101),"QT_BG_TEST_ROUTE_SAME_EDITOR_RUNTIME_AND_GEOMETRY");next.Roles[1].Hash="editor";n++;
        foreach(string action in new[]{"releaseFocusHandoff","inspectLayout","prepareUiaBackgroundText"}){Need(QtBgKeepsContinuation(action),"QT_BG_TEST_ROUTE_SAFE_BOUNDARY");n++;}
        foreach(string action in new[]{"paste","click","type","chord","openUiaSearch","beginFocusHandoff","submitUiaImage","submitUiaBackgroundText","stop"}){Need(!QtBgKeepsContinuation(action),"QT_BG_TEST_ROUTE_REVOKED_BY_POTENTIAL_INPUT");n++;}
        next.Foreground=new IntPtr(20);next.Phase="characters";next.WriteStarted=true;next.CharactersPosted=4;var partial=Map(QtBgProgress(next,next.Binding.Window));Need(Number(Get(partial,"charactersPosted"))==4&&Number(Get(partial,"mouseMessagesPosted"))==0&&Object.Equals(Get(partial,"currentForegroundIsWechat"),true)&&Object.Equals(Get(partial,"originalForegroundIsWechat"),false)&&Object.Equals(Get(partial,"retryAllowed"),false)&&!partial.ContainsKey("text"),"QT_BG_TEST_PARTIAL_DIAGNOSTIC_NOT_RETRY_PERMISSION");n++;
        return n;
    }
}
