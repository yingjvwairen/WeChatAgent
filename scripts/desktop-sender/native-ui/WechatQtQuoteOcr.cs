using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;

internal static partial class WechatDraftProbe
{
    sealed class QtOcrQuote
    {
        internal string Token, MenuPixels, PreviewPixels;
        internal QtTextStepBinding Step;
        internal QtFrame Start;
        internal IntPtr Menu;
        internal Rect MenuWindow, MenuBounds, Editor, Preview;
        internal bool Chosen, Bound;
        internal long Started;
    }
    static QtOcrQuote QtActiveOcrQuote;
    static Rect QtQuoteScreenRect(Rect r, Rect origin)
    {
        return new Rect(r.Left + origin.Left, r.Top + origin.Top, r.Right + origin.Left, r.Bottom + origin.Top);
    }
    static Point QtOcrQuoteCenter(Rect r)
    {
        return new Point(r.Left + r.Width / 2, r.Top + r.Height / 2);
    }
    static List<IntPtr> QtOcrQuotePopups(Binding b)
    {
        var list = new List<IntPtr>();
        bool ok = FocusEnumWindows(delegate(IntPtr w, IntPtr unused) {
            if (w != b.Window && IsWindowVisible(w) && !IsIconic(w) && QtOwnedPopup(w, b.Window))
            {
                int cloaked;
                if (DwmGetWindowAttribute(w, 14, out cloaked, 4) < 0 || cloaked == 0)
                    list.Add(w);
            }
            return list.Count < 32;
        }, IntPtr.Zero);
        Need(ok, "QT_QUOTE_MENU_AMBIGUOUS");
        return list;
    }
    static QtOcrQuote QtOcrQuoteRequest(Dictionary<string, object> request, bool allowMenu)
    {
        var q = QtActiveOcrQuote;
        Need(QtEnableInput && q != null && !q.Bound && Now() - q.Started <= 30000 &&
                 Text(request, "ocrQuoteId") == q.Token && QtFocus.Active != null,
             "QT_QUOTE_CHANGED");
        QtQuoteGuardWindow(q.Start, allowMenu);
        return q;
    }
    static void QtOcrQuoteClick(QtOcrQuote q, Rect area, IntPtr window, bool right)
    {
        Point pt = QtOcrQuoteCenter(area);
        QtQuoteGuardWindow(q.Start, !right);
        Need(FocusAreaOwned(area, window, q.Start.Binding.Pid), "QT_QUOTE_SOURCE_OBSCURED");
        var events = ClickEvents(pt.X, pt.Y, QtDesktopRect());
        if (right)
        {
            events[1] = Mouse(0, 0, 8);
            events[2] = Mouse(0, 0, 16);
        }
        QtQuoteGuardWindow(q.Start, !right);
        Need(Owned(WindowFromPoint(pt), window, q.Start.Binding.Pid), "QT_QUOTE_SOURCE_OBSCURED");
        InputAttempted = true;
        QtCurrent = null;
        uint done = SendInput(3, events, Marshal.SizeOf(typeof(Input)));
        if (done == 2)
            SendInput(1, new[] { Mouse(0, 0, right ? 16u : 4u) }, Marshal.SizeOf(typeof(Input)));
        Need(done == 3, "QT_QUOTE_MENU_UNCONFIRMED");
        QtRememberPointer(pt, q.Start.Revision);
    }
    static object QtOpenOcrQuoteMenu(Dictionary<string, object> request)
    {
        var frame = QtGuard(request, true);
        var step = QtParseTextStep(Get(request, "stepBinding"));
        Need(step != null && QtSurface == "main" && QtFocus.Active != null && QtPopup == null &&
                 QtPendingPopup == null && QtActiveOcrQuote == null && !frame.MetadataOnly && frame.Anchors.Count == 3,
             "QT_QUOTE_REQUEST_INVALID");
        Rect history = frame.Anchors[1].Rect, editor = frame.Anchors[2].Rect,
             line = ParseRect(Get(request, "lineRect"));
        Need(history.Top >= frame.Anchors[0].Rect.Bottom && history.Bottom <= editor.Top && Contains(history, line) &&
                 line.Width > 0 && line.Height > 0,
             "QT_QUOTE_REQUEST_INVALID");
        Need(QtOcrQuotePopups(frame.Binding).Count == 0, "QT_QUOTE_MENU_AMBIGUOUS");
        var q = new QtOcrQuote { Start = frame, Started = Now(), Step = step, Editor = editor,
                                 Token = Guid.NewGuid().ToString("N") };
        QtActiveOcrQuote = q;
        QtStable(frame);
        QtOcrQuoteClick(q, QtQuoteScreenRect(line, frame.Binding.Capture), frame.Binding.Window, true);
        return Data("ocrQuoteId", q.Token);
    }
    static object QtScrollOcrQuoteHistory(Dictionary<string, object> request)
    {
        var frame = QtGuard(request, true);
        Need(QtSurface == "main" && QtFocus.Active != null && QtPopup == null && QtPendingPopup == null &&
                 QtActiveOcrQuote == null && !frame.MetadataOnly && frame.Anchors.Count == 3 &&
                 QtParseTextStep(Get(request, "stepBinding")) != null,
             "QT_QUOTE_REQUEST_INVALID");
        Rect history = frame.Anchors[1].Rect;
        Need(history.Top >= frame.Anchors[0].Rect.Bottom && history.Bottom <= frame.Anchors[2].Rect.Top &&
                 history.Width >= 60 && history.Height >= 60 && QtOcrQuotePopups(frame.Binding).Count == 0,
             "QT_QUOTE_SOURCE_NOT_VISIBLE");
        Point point = QtOcrQuoteCenter(QtQuoteScreenRect(history, frame.Binding.Capture));
        var move = QtPointerEvents(point, QtDesktopRect())[0];
        var wheel = Mouse(0, 0, 0x0800);
        wheel.Value.Mouse.Data = 360;
        QtStable(frame);
        QtQuoteGuardWindow(frame, false);
        Need(Owned(WindowFromPoint(point), frame.Binding.Window, frame.Binding.Pid), "QT_QUOTE_SOURCE_OBSCURED");
        QtCurrent = null;
        InputAttempted = true;
        Need(SendInput(2, new[] { move, wheel }, Marshal.SizeOf(typeof(Input))) == 2, "QT_QUOTE_SCROLL_UNCONFIRMED");
        QtRememberPointer(point, frame.Revision);
        return Data("scrolled", true);
    }
    static void QtOcrQuoteMenuStable(QtOcrQuote q)
    {
        QtQuoteGuardWindow(q.Start, true);
        Rect bounds;
        var windows = QtOcrQuotePopups(q.Start.Binding);
        Need(windows.Count == 1 && windows[0] == q.Menu && GetWindowRect(q.Menu, out bounds) &&
                 Same(q.MenuWindow, bounds) && FocusAreaOwned(q.MenuBounds, q.Menu, q.Start.Binding.Pid),
             "QT_QUOTE_MENU_UNCONFIRMED");
    }
    static object QtCaptureOcrQuoteMenu(Dictionary<string, object> request)
    {
        var q = QtOcrQuoteRequest(request, true);
        Need(q.Menu == IntPtr.Zero && !q.Chosen, "QT_QUOTE_CHANGED");
        var popups = QtOcrQuotePopups(q.Start.Binding);
        if (popups.Count == 0)
            return Data("ready", false);
        Need(popups.Count == 1, "QT_QUOTE_MENU_AMBIGUOUS");
        q.Menu = popups[0];
        Rect b;
        Need(GetWindowRect(q.Menu, out b) && b.Width >= 40 && b.Width <= 900 && b.Height >= 40 && b.Height <= 1800 &&
                 Contains(QtDesktopRect(), b),
             "QT_QUOTE_MENU_UNAVAILABLE");
        // Translucent shadows and rounded corners can belong to the underlying window.
        q.MenuWindow = b;
        int inset = (int)Math.Ceiling(7 * q.Start.Binding.Dpi / 96.0);
        b = new Rect(b.Left + inset, b.Top + inset, b.Right - inset, b.Bottom - inset);
        q.MenuBounds = b;
        QtOcrQuoteMenuStable(q);
        string before = FocusPixels(b);
        using (var bitmap = new Bitmap(b.Width, b.Height, PixelFormat.Format32bppArgb)) using (var memory =
                                                                                                   new MemoryStream())
        {
            using (var g = Graphics.FromImage(bitmap))
                g.CopyFromScreen(b.Left, b.Top, 0, 0, bitmap.Size, CopyPixelOperation.SourceCopy);
            bitmap.Save(memory, ImageFormat.Png);
            byte[] bytes = memory.ToArray();
            QtOcrQuoteMenuStable(q);
            if (FocusPixels(b) != before)
            {
                q.Menu = IntPtr.Zero;
                return Data("ready", false);
            }
            q.MenuPixels = before;
            string file = Path.Combine(QtFrames, "qt-" + Guid.NewGuid().ToString("N") + ".png");
            using (var output = new QtOwnedCaptureImage(file))
            {
                output.Write(bytes);
                output.Transfer();
                return Data("ready", true, "width", b.Width, "height", b.Height, "image",
                            Data("file", file, "sha256", QtHash(bytes)));
            }
        }
    }
    static object QtChooseOcrQuoteMenu(Dictionary<string, object> request)
    {
        var q = QtOcrQuoteRequest(request, true);
        Rect row = ParseRect(Get(request, "lineRect"));
        Need(!q.Chosen && q.MenuPixels != null &&
                 Contains(new Rect(0, 0, q.MenuBounds.Width, q.MenuBounds.Height), row) && row.Width > 0 &&
                 row.Height > 0,
             "QT_QUOTE_MENU_UNCONFIRMED");
        QtOcrQuoteMenuStable(q);
        Need(FocusPixels(q.MenuBounds) == q.MenuPixels, "QT_QUOTE_MENU_UNCONFIRMED");
        q.Chosen = true;
        QtOcrQuoteClick(q, QtQuoteScreenRect(row, q.MenuBounds), q.Menu, false);
        return Data("chosen", true);
    }
    static object QtBindOcrQuotePreview(Dictionary<string, object> request)
    {
        var q = QtOcrQuoteRequest(request, false);
        var frame = QtGuard(request, true);
        Rect line = ParseRect(Get(request, "lineRect"));
        Need(q.Chosen && frame.Revision == q.Start.Revision &&
                 QtUiaLocatorBindingMatches(frame.Binding, q.Start.Binding) && frame.Anchors.Count == 2 &&
                 Same(frame.Anchors[1].Rect, q.Editor) && frame.Anchors[0].Hash == q.Start.Anchors[0].Hash &&
                 frame.Anchors[1].Hash != q.Start.Anchors[2].Hash && Contains(q.Editor, line) && line.Width > 0 &&
                 line.Height > 0 && QtOcrQuotePopups(frame.Binding).Count == 0,
             "QT_QUOTE_PREVIEW_UNVERIFIED");
        q.Preview = line;
        q.PreviewPixels = QtHash(QtPixels(frame.Binding, line));
        q.Bound = true;
        return Data("attached", true, "quoteToken", q.Token, "editorRect", q.Editor.Report());
    }
    static bool QtVerifyOcrQuote(Dictionary<string, object> request, QtFrame frame)
    {
        var q = QtActiveOcrQuote;
        if (q == null)
            return false;
        Need(q.Bound, "QT_QUOTE_PREVIEW_UNVERIFIED");
        Need(frame != null && q.Token == Text(request, "quoteToken") &&
                 QtSameTextStep(q.Step, QtParseTextStep(Get(request, "stepBinding"))) &&
                 frame.Revision == q.Start.Revision && QtUiaLocatorBindingMatches(frame.Binding, q.Start.Binding),
             "QT_QUOTE_CHANGED");
        QtQuoteGuardWindow(frame, false);
        Need(QtHash(QtPixels(frame.Binding, q.Start.Anchors[0].Rect)) == q.Start.Anchors[0].Hash &&
                 QtHash(QtPixels(frame.Binding, q.Preview)) == q.PreviewPixels,
             "QT_QUOTE_PREVIEW_UNVERIFIED");
        QtQuoteGuardWindow(frame, false);
        return true;
    }
}
