// Shared current UIA title geometry. No pixels, names, values or serialized
// control evidence authorize a click. Caller supplies a live process/window guard.
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Windows.Automation;

internal static partial class WechatDraftProbe {
    sealed class QtUiaTitleGeometry { internal Rect Toolbar,Band;internal string Metadata;internal List<Rect> Excluded=new List<Rect>(); }
    sealed class QtUiaCaptionNode { internal AutomationElement Element;internal string Class,Runtime;internal ControlType Type;internal Rect Rect;internal bool Offscreen,Focusable;internal int Pid; }
    static QtUiaCaptionNode QtUiaCaptionNodeRead(AutomationElement element){
        var info=element.Cached;var area=info.BoundingRectangle;Rect rect=new Rect();
        if(!area.IsEmpty){Need(!Double.IsNaN(area.Left)&&!Double.IsInfinity(area.Left)&&!Double.IsNaN(area.Top)&&!Double.IsInfinity(area.Top)&&!Double.IsNaN(area.Right)&&!Double.IsInfinity(area.Right)&&!Double.IsNaN(area.Bottom)&&!Double.IsInfinity(area.Bottom),"QT_UIA_CAPTION_METADATA_INVALID");rect=new Rect(checked((int)Math.Floor(area.Left)),checked((int)Math.Floor(area.Top)),checked((int)Math.Ceiling(area.Right)),checked((int)Math.Ceiling(area.Bottom)));}
        int[] id=element.GetRuntimeId();Need(id!=null&&id.Length>0&&id.Length<=64,"QT_UIA_CAPTION_METADATA_INVALID");
        return new QtUiaCaptionNode{Element=element,Class=info.ClassName,Type=info.ControlType,Rect=rect,Offscreen=info.IsOffscreen,Focusable=info.IsKeyboardFocusable,Pid=info.ProcessId,Runtime=String.Join(",",Array.ConvertAll(id,delegate(int n){return n.ToString(System.Globalization.CultureInfo.InvariantCulture);}))};
    }
    static bool QtUiaCaptionContainer(QtUiaCaptionNode node,bool root){
        if(root)return node.Class=="mmui::MainWindow"&&node.Type==ControlType.Window;
        if(node.Focusable)return false;
        return node.Class=="MMUIRenderSubWindowHW"&&node.Type==ControlType.Pane||node.Class=="QWidget"&&node.Type==ControlType.Group||node.Class=="QStackedWidget"&&node.Type==ControlType.Custom||node.Class=="mmui::MainView"&&node.Type==ControlType.Group;
    }
    static Rect QtUiaCaptionIntersection(Rect a,Rect b){return new Rect(Math.Max(a.Left,b.Left),Math.Max(a.Top,b.Top),Math.Min(a.Right,b.Right),Math.Min(a.Bottom,b.Bottom));}
    // Qt's UIA provider can round a restored window's physical client edges
    // by one pixel at fractional display scale. This tolerance identifies the
    // container only; candidate clicks remain inside the exact Win32 client.
    static bool QtUiaCaptionSameClient(Rect area,Rect client){return area.Width>0&&area.Height>0&&Math.Abs((long)area.Left-client.Left)<=1&&Math.Abs((long)area.Top-client.Top)<=1&&Math.Abs((long)area.Right-client.Right)<=1&&Math.Abs((long)area.Bottom-client.Bottom)<=1;}
    static bool QtUiaCaptionInsideClient(Rect area,Rect client){return area.Width>0&&area.Height>0&&(long)area.Left>=client.Left-1L&&(long)area.Top>=client.Top-1L&&(long)area.Right<=client.Right+1L&&(long)area.Bottom<=client.Bottom+1L;}
    static int[] QtUiaCaptionRows(Rect band,int halfHeight){return new[]{band.Top+band.Height/2,band.Bottom-halfHeight-1,band.Top+halfHeight};}
    static bool QtUiaCaptionAvoids(Rect candidate,IEnumerable<Rect> excluded){foreach(Rect area in excluded)if(Intersects(candidate,area))return false;return true;}
    static QtUiaTitleGeometry QtReadUiaTitleGeometry(IntPtr window,uint pid,Rect capture,Action guard,long deadline){
        try{
            var cache=new CacheRequest();foreach(var property in new[]{AutomationElement.ClassNameProperty,AutomationElement.ControlTypeProperty,AutomationElement.BoundingRectangleProperty,AutomationElement.IsOffscreenProperty,AutomationElement.IsKeyboardFocusableProperty,AutomationElement.ProcessIdProperty})cache.Add(property);
            guard();Need(Now()<deadline,"QT_UIA_CAPTION_PROBE_TIMEOUT");var root=QtUiaCaptionNodeRead(AutomationElement.FromHandle(window).GetUpdatedCache(cache));
            Need(QtUiaCaptionContainer(root,true)&&!root.Offscreen&&root.Pid==pid&&QtUiaCaptionSameClient(root.Rect,capture),"QT_UIA_CAPTION_ROOT_INVALID");
            var walker=TreeWalker.RawViewWalker;QtUiaCaptionNode toolbar=null;int count=0;
            for(var child=walker.GetFirstChild(root.Element,cache);child!=null;child=walker.GetNextSibling(child,cache)){
                guard();Need(++count<=64&&Now()<deadline,"QT_UIA_CAPTION_SCAN_LIMIT");var parent=QtUiaCaptionNodeRead(child);if(parent.Class!="QWidget"||parent.Type!=ControlType.Group||parent.Offscreen||!Same(parent.Rect,root.Rect)||!QtUiaCaptionSameClient(parent.Rect,capture))continue;
                for(var nested=walker.GetFirstChild(child,cache);nested!=null;nested=walker.GetNextSibling(nested,cache)){guard();Need(++count<=64&&Now()<deadline,"QT_UIA_CAPTION_SCAN_LIMIT");var node=QtUiaCaptionNodeRead(nested);if(node.Class!="mmui::TitleBar"||node.Type!=ControlType.ToolBar||node.Offscreen)continue;Need(toolbar==null,"QT_UIA_CAPTION_AMBIGUOUS");toolbar=node;}
            }
            Need(toolbar!=null&&toolbar.Pid==pid&&!toolbar.Focusable&&Math.Abs((long)toolbar.Rect.Top-capture.Top)<=1&&Math.Abs((long)toolbar.Rect.Right-capture.Right)<=1&&toolbar.Rect.Left>capture.Left+160&&toolbar.Rect.Height>=20&&toolbar.Rect.Height<=80&&QtUiaCaptionInsideClient(toolbar.Rect,capture),"QT_UIA_CAPTION_TOOLBAR_INVALID");
            var result=new QtUiaTitleGeometry{Toolbar=toolbar.Rect,Band=new Rect(capture.Left,Math.Max(capture.Top,toolbar.Rect.Top),capture.Right,Math.Min(capture.Top+48,toolbar.Rect.Top+toolbar.Rect.Height/2))};var metadata=new List<string>();count=0;
            Action<QtUiaCaptionNode,Rect,int> scan=null;scan=delegate(QtUiaCaptionNode node,Rect clip,int depth){
                guard();Need(++count<=128&&depth<=12&&Now()<deadline,"QT_UIA_CAPTION_SCAN_LIMIT");if(node.Offscreen)return;
                Need(node.Pid==pid&&node.Rect.Width>0&&node.Rect.Height>0,"QT_UIA_CAPTION_METADATA_INVALID");Rect visible=QtUiaCaptionIntersection(clip,node.Rect);if(visible.Width<=0||visible.Height<=0)return;
                metadata.Add(node.Class+"|"+node.Type.Id+"|"+node.Runtime+"|"+node.Focusable+"|"+Json.Serialize(node.Rect.Report()));
                if(!QtUiaCaptionContainer(node,depth==0)){result.Excluded.Add(visible);return;}
                for(var child=walker.GetFirstChild(node.Element,cache);child!=null;child=walker.GetNextSibling(child,cache))scan(QtUiaCaptionNodeRead(child),visible,depth+1);
            };
            scan(root,result.Band,0);metadata.Sort(StringComparer.Ordinal);result.Metadata=toolbar.Runtime+"|"+Json.Serialize(toolbar.Rect.Report())+"|"+String.Join("\n",metadata.ToArray());guard();Need(Now()<=deadline,"QT_UIA_CAPTION_CHANGED");return result;
        }catch(Fault){throw;}catch{throw new Fault("QT_UIA_CAPTION_METADATA_UNAVAILABLE");}
    }
    static bool UiaCaptionClientRegionSafe(QtUiaTitleGeometry title,Rect area,Rect capture){return title!=null&&Contains(capture,area)&&Contains(title.Band,area)&&area.Right<=title.Toolbar.Left-16&&QtUiaCaptionAvoids(area,title.Excluded);}
    static bool UiaCaptionHitSet(int[] hits){if(hits==null||hits.Length!=5)return false;foreach(int hit in hits)if(hit!=hits[0]||hit!=1&&hit!=2)return false;return true;}
    static void ValidateUiaCaptionRegion(IntPtr window,uint pid,Rect capture,Rect area,Action guard,long deadline){
        Need(Contains(capture,area)&&FocusCoveredByDisplays(area,FocusDisplayRects()),"QT_UIA_CAPTION_METADATA_INVALID");
        Point[] points={new Point(area.Left+area.Width/2,area.Top+area.Height/2),new Point(area.Left,area.Top),new Point(area.Right-1,area.Top),new Point(area.Left,area.Bottom-1),new Point(area.Right-1,area.Bottom-1)};
        int[] hits=new int[5];
        for(int i=0;i<points.Length;i++){guard();long remaining=deadline-Now();Need(remaining>0,"QT_UIA_CAPTION_PROBE_TIMEOUT");UIntPtr result;
            Need(FocusSendMessageTimeout(window,0x84,UIntPtr.Zero,FocusCaptionCoordinates(points[i],"QT_UIA_CAPTION_METADATA_INVALID"),0x23,(uint)Math.Min(20,remaining),out result)!=IntPtr.Zero,"QT_UIA_CAPTION_PROBE_TIMEOUT");hits[i]=unchecked((int)result.ToUInt64());}
        Need(UiaCaptionHitSet(hits),"QT_UIA_CAPTION_CHANGED");
        if(hits[0]==1){var title=QtReadUiaTitleGeometry(window,pid,capture,guard,deadline);Need(UiaCaptionClientRegionSafe(title,area,capture),"QT_UIA_CAPTION_CHANGED");}
        guard();Need(Now()<=deadline&&FocusAreaOwned(area,window,pid),"QT_UIA_CAPTION_OBSCURED");
    }
    static int UiaCaptionSharedSelfTest(){int n=0;
        Need(UiaCaptionHitSet(new[]{1,1,1,1,1})&&UiaCaptionHitSet(new[]{2,2,2,2,2}),"TEST_UIA_CAPTION_HITSET");n++;
        foreach(var hits in new[]{new[]{1,1,2,1,1},new[]{2,2,13,2,2},new[]{1,1,0,1,1},new[]{1,1,1,1},null}){Need(!UiaCaptionHitSet(hits),"TEST_UIA_CAPTION_MIXED_OR_RESIZE_REJECTED");n++;}
        var title=new QtUiaTitleGeometry{Band=new Rect(0,0,1000,24),Toolbar=new Rect(800,0,1000,48)};Rect capture=new Rect(0,0,1000,700),area=new Rect(450,8,475,20);
        Need(UiaCaptionClientRegionSafe(title,area,capture),"TEST_UIA_CAPTION_CURRENT_METADATA_REGION");n++;
        title.Excluded.Add(new Rect(474,8,500,20));Need(!UiaCaptionClientRegionSafe(title,area,capture),"TEST_UIA_CAPTION_ONE_PIXEL_CONTROL_INTERSECTION");n++;title.Excluded.Clear();
        foreach(var candidate in new[]{new Rect(790,8,815,20),new Rect(450,20,475,32),new Rect(-1,8,24,20)}){Need(!UiaCaptionClientRegionSafe(title,candidate,capture),"TEST_UIA_CAPTION_UNSAFE_REGION");n++;}return n;
    }
}
