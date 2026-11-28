// Shared pure focus safety primitives. Callers retain their own in-process
// lease, identity, revision, input authorization and audio-session guards.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;

internal static partial class WechatDraftProbe
{
    static List<Rect> FocusDisplayRects()
    {
        var result = new List<Rect>();
        foreach (Screen display in Screen.AllScreens)
        {
            Rectangle b = display.Bounds;
            result.Add(new Rect(b.Left, b.Top, b.Right, b.Bottom));
        }
        return result;
    }
    // Full client-window occlusion, never a few selected hit-test points.
    // No popup exceptions are accepted by the voice foreground path.
    static int FocusBlockingWindows(IntPtr target, Rect capture, string errorCode)
    {
        bool before = true, valid = true;
        int examined = 0, blocking = 0;
        bool enumerated = FocusEnumWindows(delegate(IntPtr window, IntPtr unused) {
            if (++examined >= 4096)
            {
                valid = false;
                return false;
            }
            if (window == target)
            {
                before = false;
                return true;
            }
            if (!before || !IsWindowVisible(window) || IsIconic(window))
                return true;
            int cloaked;
            if (DwmGetWindowAttribute(window, 14, out cloaked, 4) >= 0 && cloaked != 0)
                return true;
            Rect bounds;
            if (!FocusGetWindowRect(window, out bounds))
            {
                valid = false;
                return false;
            }
            if (!Intersects(bounds, capture))
                return true;
            long style = FocusGetWindowLongPtr(window, -20).ToInt64();
            uint key = 0, flags = 0;
            byte alpha = 255;
            bool zeroAlpha = (style & 0x80000) != 0 &&
                             FocusGetLayeredAttributes(window, out key, out alpha, out flags) && (flags & 2) != 0 &&
                             alpha == 0;
            if (!zeroAlpha)
                blocking++;
            return true;
        }, IntPtr.Zero);
        Need(enumerated && valid && !before, errorCode);
        return blocking;
    }
    delegate bool FocusEnumWindow(IntPtr window, IntPtr parameter);
    [DllImport("user32.dll", EntryPoint = "EnumWindows")]
    static extern bool FocusEnumWindows(FocusEnumWindow callback, IntPtr value);
    [DllImport("user32.dll", EntryPoint = "GetWindowRect")]
    static extern bool FocusGetWindowRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll", EntryPoint = "GetWindow")]
    static extern IntPtr FocusGetWindow(IntPtr window, uint command);
    [DllImport("user32.dll", EntryPoint = "GetLayeredWindowAttributes")]
    static extern bool FocusGetLayeredAttributes(IntPtr window, out uint key, out byte alpha, out uint flags);
    [DllImport("user32.dll", EntryPoint = "GetDoubleClickTime")]
    static extern uint FocusDoubleClickTime();
    [DllImport("user32.dll", EntryPoint = "MonitorFromPoint")]
    static extern IntPtr FocusMonitorFromPoint(Point point, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "SendMessageTimeoutW", SetLastError = true)]
    static extern IntPtr FocusSendMessageTimeout(IntPtr window, uint message, UIntPtr wparam, IntPtr lparam, uint flags,
                                                 uint timeout, out UIntPtr result);
    class FocusClickHistory
    {
        sealed class Click
        {
            internal Point Position;
            internal long At;
        }
        readonly object Gate = new object();
        readonly List<Click> Recent = new List<Click>();
        bool Overflowed;
        long OverflowAt;
        internal void Observe(uint message, Point point, long at)
        {
            if (message != 0x201 && message != 0x203)
                return;
            lock (Gate)
            {
                Recent.RemoveAll(delegate(Click click) { return at >= click.At && at - click.At > 5000; });
                if (Recent.Count == 64)
                {
                    Recent.RemoveAt(0);
                    Overflowed = true;
                    OverflowAt = Math.Max(OverflowAt, at);
                }
                Recent.Add(new Click { Position = point, At = at });
            }
        }
        internal bool Safe(Point next, long now, long started, long humanAt, uint doubleClick, int width, int height)
        {
            lock (Gate)
            {
                if (!FocusCaptionClickSafe(false, 0, new Point(), next, now, started, humanAt, doubleClick, width,
                                           height) ||
                    Overflowed && (now < OverflowAt || now - OverflowAt <= doubleClick))
                    return false;
                // Check every recent left click, not just the immediately preceding
                // window's click. Interleaved cross-process activation cannot hide
                // a still-recent click on this same caption.
                foreach (var click in Recent)
                    if (!FocusCaptionClickSafe(true, click.At, click.Position, next, now, started, humanAt, doubleClick,
                                               width, height))
                        return false;
                return true;
            }
        }
    }
    static bool FocusCaptionClickSafe(bool seen, long last, Point previous, Point next, long now, long started,
                                      long humanAt, uint interval, int width, int height)
    {
        if (interval < 1 || interval > 5000 || width < 1 || height < 1 || now < started || now - started <= interval ||
            now < humanAt || now - humanAt <= interval)
            return false;
        if (!seen)
            return true;
        if (now < last)
            return false;
        // Use the full system rectangle dimensions as a conservative distance,
        // not half-width assumptions about the platform's double-click box.
        return now - last > interval || Math.Abs((long)next.X - previous.X) > width ||
               Math.Abs((long)next.Y - previous.Y) > height;
    }
    static List<Point> FocusCaptionCandidates(Rect window, uint dpi)
    {
        var points = new List<Point>();
        foreach (int row in new[] { 8, 18, 28, 38 })
            foreach (double fraction in new[] { .30, .45, .60, .75 })
                points.Add(new Point(window.Left + (int)Math.Round(window.Width * fraction),
                                     window.Top + (int)Math.Round(row * dpi / 96.0)));
        return points;
    }
    static Point[] FocusCaptionPoints(Point center, uint dpi)
    {
        int span = Math.Max(3, (int)Math.Ceiling(3 * dpi / 96.0));
        return new[] { center, new Point(center.X - span, center.Y - span), new Point(center.X + span, center.Y - span),
                       new Point(center.X - span, center.Y + span), new Point(center.X + span, center.Y + span) };
    }
    static IntPtr FocusCaptionCoordinates(Point point, string errorCode)
    {
        Need(point.X >= Int16.MinValue && point.X <= Int16.MaxValue && point.Y >= Int16.MinValue &&
                 point.Y <= Int16.MaxValue,
             errorCode);
        return new IntPtr(unchecked((int)((ushort)point.X | ((uint)(ushort)point.Y << 16))));
    }
    static bool FocusCoveredByDisplays(Rect area, List<Rect> displays)
    {
        var remaining = new List<Rect> { area };
        foreach (Rect display in displays)
        {
            var next = new List<Rect>();
            foreach (Rect part in remaining)
            {
                int l = Math.Max(part.Left, display.Left), t = Math.Max(part.Top, display.Top),
                    r = Math.Min(part.Right, display.Right), b = Math.Min(part.Bottom, display.Bottom);
                if (l >= r || t >= b)
                {
                    next.Add(part);
                    continue;
                }
                if (part.Top < t)
                    next.Add(new Rect(part.Left, part.Top, part.Right, t));
                if (b < part.Bottom)
                    next.Add(new Rect(part.Left, b, part.Right, part.Bottom));
                if (part.Left < l)
                    next.Add(new Rect(part.Left, t, l, b));
                if (r < part.Right)
                    next.Add(new Rect(r, t, part.Right, b));
            }
            remaining = next;
            if (remaining.Count == 0)
                return true;
            if (remaining.Count > 128)
                return false;
        }
        return false;
    }
    sealed class FocusVisibilityObservation
    {
        internal bool RaiseAttempted, Confirmed;
        internal bool? RequestAccepted;
        internal int? InitialBlockingCount, LastBlockingCount;
        internal long ElapsedMs;
        internal string Reason = "guard-failed";
        internal object Report()
        {
            return Data("version", 1, "raiseAttempted", RaiseAttempted, "requestAccepted", RequestAccepted, "confirmed",
                        Confirmed, "initialBlockingCount", InitialBlockingCount, "lastBlockingCount", LastBlockingCount,
                        "elapsedMs", ElapsedMs, "reason", Reason);
        }
    }
    static FocusVisibilityObservation FocusConfirmVisibilityOnce(Action guard, Func<int> blocking, Func<bool> raise,
                                                                 Func<long> clock, Action<int> wait,
                                                                 bool priorRaise = false, bool? priorAccepted = null,
                                                                 string errorDataKey = "FocusVisibility")
    {
        var result = new FocusVisibilityObservation { RaiseAttempted = priorRaise, RequestAccepted = priorAccepted };
        long started = clock(), deadline = started + 250;
        try
        {
            guard();
            result.InitialBlockingCount = result.LastBlockingCount = blocking();
            guard();
            if (clock() > deadline)
            {
                result.Reason = "timeout";
                return result;
            }
            if (result.LastBlockingCount == 0)
            {
                result.Confirmed = true;
                result.Reason = "already-visible";
                return result;
            }
            guard();
            if (clock() > deadline)
            {
                result.Reason = "timeout";
                return result;
            }
            if (!result.RaiseAttempted)
            {
                result.RaiseAttempted = true;
                result.RequestAccepted = raise();
            }
            for (;;)
            {
                guard();
                if (clock() > deadline)
                {
                    result.Reason = "timeout";
                    return result;
                }
                result.LastBlockingCount = blocking();
                guard();
                if (clock() > deadline)
                {
                    result.Reason = "timeout";
                    return result;
                }
                if (result.LastBlockingCount == 0)
                {
                    result.Confirmed = true;
                    result.Reason = "raised-visible";
                    return result;
                }
                long remaining = deadline - clock();
                if (remaining <= 0)
                {
                    result.Reason = "timeout";
                    return result;
                }
                wait((int)Math.Min(10, remaining));
            }
        }
        catch (Exception error)
        {
            result.ElapsedMs = Math.Max(0, clock() - started);
            error.Data[errorDataKey] = result.Report();
            throw;
        }
        finally
        {
            result.ElapsedMs = Math.Max(0, clock() - started);
        }
    }
}
