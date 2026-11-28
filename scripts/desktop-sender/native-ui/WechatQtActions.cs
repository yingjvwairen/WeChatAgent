// Project-owned Qt transport. Every mutation consumes a fresh, native observation
// and checks process, desktop, geometry, focus, physical activity and pixel anchors.
// Higher-level account/contact identity is established by the local coordinator.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.Globalization;
using System.Linq;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using System.Xml;

internal static class WechatQtActions
{
    [STAThread]
    static int Main(string[] args)
    {
        AppContext.SetSwitch("Switch.System.IO.UseLegacyPathHandling", false);
        AppContext.SetSwitch("Switch.System.IO.BlockLongPaths", false);
        if (args.Length > 0 && args[0] == "--draft-probe")
            return WechatDraftProbe.Main(args.Skip(1).ToArray());
        return WechatDraftProbe.QtMain(args);
    }
}

internal static partial class WechatDraftProbe
{
    sealed class QtAnchor
    {
        internal Rect Rect;
        internal string Hash;
    }
    sealed class QtFrame
    {
        internal Binding Binding;
        internal string Token;
        internal long Revision, Issued;
        internal List<QtAnchor> Anchors;
        internal Rect? PopupBounds, PopupClient;
        internal bool NavigationOnly, UiaControlFrame, MetadataOnly;
        internal List<QtUiaRole> UiaRoles;
        internal QtFocusLease NavigationLease, UiaControlLease, MetadataLease;
    }
    static QtFrame QtCurrent;
    static string QtExecutable, QtFrames;
    static IntPtr QtWindow;
    static WindowIdentity QtRoot = new WindowIdentity(IntPtr.Zero, 0, 0);
    static bool QtEnableInput;
    static readonly string QtEpoch = Guid.NewGuid().ToString("N");
    static long QtCommandStarted;
    static readonly Queue<string> QtRequests = new Queue<string>();
    static bool QtInputEnded, QtInputFailed;
    static int QtExitCode;
    static string QtHash(byte[] bytes)
    {
        using (var sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(bytes))
            .Replace("-", "")
            .ToLowerInvariant();
    }
    static void QtRgbaRow(byte[] bgra, byte[] rgba, int offset)
    {
        for (int source = 0; source < bgra.Length; source += 4)
        {
            rgba[offset++] = bgra[source + 2];
            rgba[offset++] = bgra[source + 1];
            rgba[offset++] = bgra[source];
            rgba[offset++] = 255;
        }
    }
    static byte[] QtPixels(Binding binding, Rect region)
    {
        Need(Contains(binding.Client, region) && region.Width <= 4096 && region.Height <= 4096, "QT_REGION_INVALID");
        using (var bitmap = new Bitmap(region.Width, region.Height, PixelFormat.Format32bppArgb))
        {
            using (var graphic = Graphics.FromImage(bitmap))
                graphic.CopyFromScreen(binding.Capture.Left + region.Left, binding.Capture.Top + region.Top, 0, 0,
                                       new Size(region.Width, region.Height), CopyPixelOperation.SourceCopy);
            var bits = bitmap.LockBits(new Rectangle(0, 0, bitmap.Width, bitmap.Height), ImageLockMode.ReadOnly,
                                       PixelFormat.Format32bppArgb);
            try
            {
                byte[] bytes = new byte[checked(region.Width * region.Height * 4)],
                       rowBytes = new byte[region.Width * 4];
                for (int row = 0; row < region.Height; row++)
                {
                    Marshal.Copy(IntPtr.Add(bits.Scan0, row * bits.Stride), rowBytes, 0, rowBytes.Length);
                    QtRgbaRow(rowBytes, bytes, row * rowBytes.Length);
                }
                return bytes;
            }
            finally
            {
                bitmap.UnlockBits(bits);
            }
        }
    }
    static bool QtSameBinding(Binding a, Binding b)
    {
        return a.Window == b.Window && a.Pid == b.Pid && a.Created == b.Created && a.Dpi == b.Dpi &&
               Same(a.Client, b.Client) && Same(a.Capture, b.Capture) && a.Focus == b.Focus;
    }
    static void QtNeedAnchorPixels(string expected, string actual, string stage, int index)
    {
        if (expected != actual)
        {
            var error = new Fault("QT_PIXELS_CHANGED");
            error.Data["QtPixelMismatch"] = Data("stage", stage, "anchorIndex", index);
            throw error;
        }
    }
    static object QtPixelMismatch(Exception error)
    {
        return error.Data.Contains("QtPixelMismatch") ? error.Data["QtPixelMismatch"] : null;
    }
    static Dictionary<string, object> QtOverlapReport(Binding binding)
    {
        bool before = true;
        int blocking = 0, total = 0;
        var windows = new List<object>();
        EnumWindows(delegate(IntPtr hwnd, IntPtr unused) {
            if (hwnd == binding.Window)
            {
                before = false;
                return true;
            }
            if (!before || !IsWindowVisible(hwnd) || IsIconic(hwnd))
                return true;
            int cloaked;
            if (DwmGetWindowAttribute(hwnd, 14, out cloaked, 4) >= 0 && cloaked != 0)
                return true;
            Rect bounds;
            if (GetWindowRect(hwnd, out bounds) && Intersects(bounds, binding.Capture))
            {
                total++;
                long exStyle = GetWindowLongPtr(hwnd, -20).ToInt64(), style = GetWindowLongPtr(hwnd, -16).ToInt64();
                uint key = 0, flags = 0;
                byte alpha = 255;
                bool layered = (exStyle & 0x80000) != 0,
                     attributes = layered && GetLayeredWindowAttributes(hwnd, out key, out alpha, out flags);
                // WS_EX_TRANSPARENT controls hit testing/paint order, not visual
                // transparency. Ignore only a confirmed global zero-alpha layer.
                bool transparent = attributes && (flags & 2) != 0 && alpha == 0;
                bool calibrated = QtSearchSurface(QtSurface) && QtPopup != null && hwnd == QtPopup.Window &&
                                  binding.Window == QtPopup.Root.Window && QtPopupWindowMatches(hwnd, QtPopup);
                if (!transparent && !calibrated)
                    blocking++;
                if (windows.Count < 16)
                {
                    uint pid;
                    GetWindowThreadProcessId(hwnd, out pid);
                    var name = new StringBuilder(257);
                    GetClassName(hwnd, name, name.Capacity);
                    windows.Add(Data("className", name.ToString(), "pid", pid, "rect", bounds.Report(), "style", style,
                                     "extendedStyle", exStyle, "layered", layered, "layeredAttributesAvailable",
                                     attributes, "globalAlpha", attributes && (flags & 2) != 0 ? (object)alpha : null,
                                     "colorKeyEnabled", attributes && (flags & 1) != 0, "ignoredTransparent",
                                     transparent, "matchedCalibratedPopup", calibrated));
                }
            }
            return true;
        }, IntPtr.Zero);
        Need(!before, "QT_WINDOW_Z_ORDER_UNAVAILABLE");
        return Data("blockingCount", blocking, "overlappingCount", total, "windows", windows, "truncated",
                    total > windows.Count, "windowTitlesIncluded", false);
    }
    // This bounded comparison is diagnostic only. It neither changes the
    // overlap decision above nor grants a capture/input token.
    sealed class QtDiagnosticPreviousChain
    {
        internal List<IntPtr> Windows = new List<IntPtr>();
        internal string Reason;
        internal bool Complete;
    }
    static QtDiagnosticPreviousChain QtReadPreviousChain(IntPtr target, Func<IntPtr, IntPtr> previous,
                                                         Func<IntPtr, bool> valid, Func<long> clock, long deadline,
                                                         int limit)
    {
        var result = new QtDiagnosticPreviousChain();
        var seen = new HashSet<IntPtr> { target };
        IntPtr current = target;
        for (int index = 0; index < limit; index++)
        {
            if (clock() > deadline)
            {
                result.Reason = "deadline";
                return result;
            }
            if (!valid(current))
            {
                result.Reason = "window-unavailable";
                return result;
            }
            IntPtr above = previous(current);
            if (above == IntPtr.Zero)
            {
                result.Complete = true;
                result.Reason = "end";
                return result;
            }
            if (!seen.Add(above))
            {
                result.Reason = "cycle";
                return result;
            }
            if (!valid(above))
            {
                result.Reason = "window-unavailable";
                return result;
            }
            result.Windows.Add(above);
            current = above;
        }
        result.Reason = "limit";
        return result;
    }
    static Dictionary<string, object> QtAnonymousWindow(IntPtr window)
    {
        if (window == IntPtr.Zero || !IsWindow(window))
            return Data("available", false);
        uint pid;
        GetWindowThreadProcessId(window, out pid);
        var name = new StringBuilder(257);
        GetClassName(window, name, name.Capacity);
        Rect bounds;
        bool rectangle = GetWindowRect(window, out bounds);
        int cloaked;
        bool cloakKnown = DwmGetWindowAttribute(window, 14, out cloaked, 4) >= 0;
        long exStyle = GetWindowLongPtr(window, -20).ToInt64();
        return Data("available", true, "pid", pid, "className", name.ToString(), "rect",
                    rectangle ? (object)bounds.Report() : null, "visible", IsWindowVisible(window), "iconic",
                    IsIconic(window), "topmost", (exStyle & 8) != 0, "cloaked",
                    cloakKnown ? (object)(cloaked != 0) : null);
    }
    static List<Point> QtOcclusionRegionPoints(Rect rect)
    {
        return new List<Point> { new Point(rect.Left + rect.Width / 2, rect.Top + rect.Height / 2),
                                 new Point(rect.Left, rect.Top), new Point(rect.Right - 1, rect.Top),
                                 new Point(rect.Left, rect.Bottom - 1), new Point(rect.Right - 1, rect.Bottom - 1) };
    }
    static Dictionary<string, Rect> QtOcclusionRegions(object value, Rect client)
    {
        var result = new Dictionary<string, Rect>();
        if (value == null)
            return result;
        var map = Map(value);
        Need(map != null && map.Count <= 2, "QT_OCCLUSION_REGIONS_INVALID");
        foreach (var item in map)
        {
            Need(item.Key == "header" || item.Key == "editor", "QT_OCCLUSION_REGIONS_INVALID");
            Rect rect = ParseRect(item.Value);
            Need(Contains(client, rect), "QT_OCCLUSION_REGIONS_INVALID");
            result.Add(item.Key, rect);
        }
        return result;
    }
    static object QtOcclusionDiagnostics(Binding binding, object requestedRegions)
    {
        var regions = QtOcclusionRegions(requestedRegions, binding.Client);
        long started = Now(), deadline = started + 200, revision = Interlocked.Read(ref Revision);
        bool foregroundBefore = GetForegroundWindow() == binding.Window;
        var chain = QtReadPreviousChain(binding.Window, delegate(IntPtr window) { return GetWindow(window, 3); },
                                        IsWindow, Now, deadline, 16);
        var above = new List<object>();
        foreach (IntPtr window in chain.Windows)
        {
            if (Now() > deadline)
                break;
            var row = QtAnonymousWindow(window);
            Rect bounds;
            row.Add("overlapsBoundClient", GetWindowRect(window, out bounds) && Intersects(bounds, binding.Capture));
            row.Add("sameBoundProcess", Object.Equals(Get(row, "pid"), binding.Pid));
            above.Add(row);
        }
        var points = new List<object>();
        foreach (var region in regions)
        {
            foreach (Point point in QtOcclusionRegionPoints(region.Value))
            {
                if (Now() > deadline)
                    break;
                Point screen = new Point(binding.Capture.Left + point.X, binding.Capture.Top + point.Y);
                IntPtr hit = WindowFromPoint(screen), root = hit == IntPtr.Zero ? IntPtr.Zero : GetAncestor(hit, 2);
                points.Add(Data("region", region.Key, "clientX", point.X, "clientY", point.Y, "ownedByBoundWindow",
                                Owned(hit, binding.Window, binding.Pid), "rootIsBoundWindow", root == binding.Window,
                                "hit", QtAnonymousWindow(hit), "root", QtAnonymousWindow(root)));
            }
        }
        bool chainUnchanged = chain.Reason == "end" || chain.Reason == "limit";
        IntPtr current = binding.Window;
        foreach (IntPtr expected in chain.Windows)
        {
            if (Now() > deadline || !IsWindow(current) || !IsWindow(expected) || GetWindow(current, 3) != expected)
            {
                chainUnchanged = false;
                break;
            }
            current = expected;
        }
        if (chain.Complete && chainUnchanged)
            chainUnchanged = Now() <= deadline && GetWindow(current, 3) == IntPtr.Zero;
        bool bindingUnchanged = false;
        try
        {
            var identity = QtFocusWindow(binding.Window, QtExecutable);
            Rect client;
            Point origin = new Point(0, 0);
            bindingUnchanged = identity.Pid == binding.Pid && identity.Created == binding.Created &&
                               GetClientRect(binding.Window, out client) &&
                               ClientToScreen(binding.Window, ref origin) && Same(client, binding.Client) &&
                               origin.X == binding.Capture.Left && origin.Y == binding.Capture.Top &&
                               GetDpiForWindow(binding.Window) == binding.Dpi;
        }
        catch
        {
        }
        return Data("version", 1, "readOnly", true, "inputAuthorized", false, "windowTitlesIncluded", false,
                    "foregroundExactBefore", foregroundBefore, "foregroundExactAfter",
                    GetForegroundWindow() == binding.Window, "activityUnchanged",
                    revision == Interlocked.Read(ref Revision), "bindingUnchanged", bindingUnchanged,
                    "previousChainSource", "GW_HWNDPREV", "previousChainOrder", "nearest-above-first",
                    "previousChainComplete", chain.Complete, "previousChainReason", chain.Reason,
                    "previousChainUnchanged", chainUnchanged, "previousWindows", above, "pointHits", points,
                    "deadlineExceeded", Now() > deadline, "elapsedMs", Math.Max(0, Now() - started));
    }
    static void QtNoOverlap(Binding binding)
    {
        var report = QtOverlapReport(binding);
        Need(Number(Get(report, "blockingCount")) == 0, "QT_WINDOW_OBSCURED");
    }
    static Binding QtBound(bool requireUnobscured = true)
    {
        Need(!Stopping, "QT_STOPPING");
        QtValidateActivePopup();
        IntPtr candidate = QtWindow == IntPtr.Zero ? GetForegroundWindow() : QtWindow;
        Binding binding = Snapshot(candidate, QtExecutable);
        QtWindow = candidate;
        Need(binding.Client.Width <= 4096 && binding.Client.Height <= 4096 &&
                 (long)binding.Client.Width * binding.Client.Height <= 12000000,
             "QT_GEOMETRY_INVALID");
        Need(binding.FocusOwned && (binding.GuiFlags & 0x1e) == 0, "QT_FOCUS_UNAVAILABLE");
        if (requireUnobscured)
            QtNoOverlap(binding);
        return binding;
    }
    // Candidate screenshots carry no input token. Their subsequently located
    // regions are checked separately; unrelated animated messages need not be
    // frozen. The ordinary input capture still requires guarded anchors.
    static List<QtAnchor> QtLayoutAnchors(object value, object image, Rect client)
    {
        var values = value as object[];
        if (values != null && values.Length == 0 && Object.Equals(image, true))
            return new List<QtAnchor>();
        return QtParseAnchors(value, client);
    }
    static List<QtAnchor> QtParseAnchors(object value, Rect client)
    {
        object[] values = value as object[];
        Need(values != null && values.Length >= 1 && values.Length <= 8, "QT_ANCHORS_REQUIRED");
        var result = new List<QtAnchor>();
        long area = 0;
        foreach (object item in values)
        {
            Rect rect = ParseRect(item);
            Need(Contains(client, rect), "QT_REGION_INVALID");
            area += (long)rect.Width * rect.Height;
            Need(area <= 12000000, "QT_REGION_INVALID");
            result.Add(new QtAnchor { Rect = rect });
        }
        return result;
    }
    sealed class QtPopupCaptureSnapshot
    {
        internal readonly QtPopupLease Lease;
        internal readonly IntPtr Window;
        internal readonly Rect Bounds, Client, ClientScreen, Relative;
        internal readonly uint Dpi;
        internal readonly string Id, Kind, OwnerRelation;
        internal QtPopupCaptureSnapshot(QtPopupLease lease, Rect bounds, Rect client, Point origin, uint dpi)
        {
            Lease = lease;
            Window = lease.Window;
            Bounds = bounds;
            Client = client;
            Dpi = dpi;
            Id = lease.Id;
            Kind = lease.Calibration.Kind;
            OwnerRelation = lease.Calibration.OwnerRelation;
            ClientScreen = new Rect(origin.X, origin.Y, origin.X + client.Width, origin.Y + client.Height);
            Relative = new Rect(origin.X - lease.Root.Capture.Left, origin.Y - lease.Root.Capture.Top,
                                origin.X - lease.Root.Capture.Left + client.Width,
                                origin.Y - lease.Root.Capture.Top + client.Height);
        }
        internal Dictionary<string, object> Report()
        {
            return Data("surfaceId", Id, "kind", Kind, "hwnd", QtHandle(Window), "ownerRelation", OwnerRelation,
                        "stableObservations", 2, "geometryMode", "observed-v1", "windowRect", Bounds.Report(),
                        "clientRect", Client.Report(), "clientRectInRoot", Relative.Report(), "dpi", Dpi);
        }
    }
    static QtPopupCaptureSnapshot QtReadPopupCaptureSnapshot(QtPopupLease lease)
    {
        Need(lease != null && lease.Observed && Object.ReferenceEquals(lease, QtPopup), "QT_POPUP_BINDING_CHANGED");
        Rect bounds = new Rect(), client = new Rect();
        Point origin = new Point(0, 0);
        Need(GetWindowRect(lease.Window, out bounds) && GetClientRect(lease.Window, out client) &&
                 ClientToScreen(lease.Window, ref origin),
             "QT_POPUP_GEOMETRY_UNAVAILABLE");
        var result = new QtPopupCaptureSnapshot(lease, bounds, client, origin, GetDpiForWindow(lease.Window));
        Need(result.Dpi == lease.Root.Dpi &&
                 QtPopupGeometryAllowed(result.Bounds, result.Client, result.ClientScreen, lease,
                                        QtPopupOffscreenSearch(lease, result.Bounds)),
             "QT_POPUP_BINDING_CHANGED");
        return result;
    }
    static void QtNeedSamePopupCaptureSnapshot(QtPopupCaptureSnapshot before, QtPopupCaptureSnapshot after)
    {
        Need(before != null && after != null && Object.ReferenceEquals(before.Lease, after.Lease) &&
                 before.Window == after.Window && before.Dpi == after.Dpi && before.Id == after.Id &&
                 before.Kind == after.Kind && before.OwnerRelation == after.OwnerRelation &&
                 Same(before.Bounds, after.Bounds) && Same(before.Client, after.Client) &&
                 Same(before.ClientScreen, after.ClientScreen) && Same(before.Relative, after.Relative),
             "QT_POPUP_BINDING_CHANGED");
    }
    // Ownership begins only after this exact CreateNew succeeds. A refused
    // observation never hands its PNG to JavaScript, so it must dispose it here.
    sealed class QtOwnedCaptureImage : IDisposable
    {
        internal readonly string File;
        bool owned, returned;
        internal QtOwnedCaptureImage(string file)
        {
            File = file;
        }
        internal void Write(byte[] bytes)
        {
            using (var output = new FileStream(File, FileMode.CreateNew, FileAccess.Write, FileShare.None))
            {
                owned = true;
                output.Write(bytes, 0, bytes.Length);
            }
        }
        internal void Transfer()
        {
            returned = true;
        }
        public void Dispose()
        {
            if (owned && !returned)
            {
                try
                {
                    System.IO.File.Delete(File);
                }
                catch
                {
                }
            }
        }
    }
    static object QtCapture(Dictionary<string, object> request, bool stablePixels = true)
    {
        QtRejectFrameAuthority(request);
        QtCurrent = null;
        QtSelectSurface(Text(request, "surface"), Text(request, "surfaceId"));
        long revision = Interlocked.Read(ref Revision);
        Binding before = QtBound();
        var popupLease = QtPopup;
        var popupSnapshot = popupLease != null && popupLease.Observed ? QtReadPopupCaptureSnapshot(popupLease) : null;
        Dictionary<string, object> popup = popupLease == null ? null
                                           : popupSnapshot != null
                                               ? popupSnapshot.Report()
                                               : Data("surfaceId", popupLease.Id, "kind", popupLease.Calibration.Kind,
                                                      "hwnd", QtHandle(popupLease.Window), "ownerRelation",
                                                      popupLease.Calibration.OwnerRelation, "stableObservations", 2);
        object regions = Get(request, "regions");
        var regionValues = regions as object[];
        if (regionValues != null && regionValues.Length == 0)
        {
            Need(Object.Equals(Get(request, "image"), true) || popupSnapshot != null, "QT_ANCHORS_REQUIRED");
            Rect full = popupSnapshot != null && QtSearchSurface(QtSurface) ? popupSnapshot.Relative : before.Client;
            regions = new object[] { full.Report() };
        }
        var anchors = QtParseAnchors(regions, before.Client);
        Rect? popupBounds = null, popupClient = null;
        if (popupSnapshot != null)
        {
            popupBounds = popupSnapshot.Bounds;
            popupClient = popupSnapshot.Client;
        }
        var report = new List<object>();
        foreach (var anchor in anchors)
        {
            anchor.Hash = QtHash(QtPixels(before, anchor.Rect));
            report.Add(Data("rect", anchor.Rect.Report(), "rgbaSha256", anchor.Hash));
        }
        string file = null, sha = null;
        QtOwnedCaptureImage ownedImage = null;
        try
        {
            if (Object.Equals(Get(request, "image"), true))
            {
                file = Path.Combine(QtFrames, "qt-" + Guid.NewGuid().ToString("N") + ".png");
                ownedImage = new QtOwnedCaptureImage(file);
                using (var bitmap = new Bitmap(before.Client.Width, before.Client.Height, PixelFormat.Format32bppArgb))
                {
                    using (var graphic = Graphics.FromImage(bitmap))
                        graphic.CopyFromScreen(before.Capture.Left, before.Capture.Top, 0, 0,
                                               new Size(bitmap.Width, bitmap.Height), CopyPixelOperation.SourceCopy);
                    using (var memory = new MemoryStream())
                    {
                        bitmap.Save(memory, ImageFormat.Png);
                        byte[] bytes = memory.ToArray();
                        sha = QtHash(bytes);
                        ownedImage.Write(bytes);
                    }
                }
            }
            Binding after = QtBound();
            Need(QtSameBinding(before, after) && revision == Interlocked.Read(ref Revision), "QT_OBSERVATION_CHANGED");
            Need(Object.ReferenceEquals(popupLease, QtPopup), "QT_POPUP_BINDING_CHANGED");
            if (stablePixels && popupSnapshot != null)
                QtNeedSamePopupCaptureSnapshot(popupSnapshot, QtReadPopupCaptureSnapshot(popupLease));
            if (stablePixels)
                for (int index = 0; index < anchors.Count; index++)
                    QtNeedAnchorPixels(anchors[index].Hash, QtHash(QtPixels(after, anchors[index].Rect)), "capture",
                                       index);
            // Pixels are another observation boundary. Freeze every emitted popup
            // field to the original tuple, and reject geometry changing during the
            // final pixel reads instead of mixing a new height into the reply.
            if (stablePixels && popupSnapshot != null)
                QtNeedSamePopupCaptureSnapshot(popupSnapshot, QtReadPopupCaptureSnapshot(popupLease));
            QtCurrent = new QtFrame { Binding = after,          Token = Guid.NewGuid().ToString("N"),
                                      Revision = revision,      Issued = UtcMs(),
                                      Anchors = anchors,        PopupBounds = popupBounds,
                                      PopupClient = popupClient };
            var result =
                Data("binding", after.Report(), "executableVersion",
                     FileVersionInfo.GetVersionInfo(QtExecutable).FileVersion, "pixelFormat",
                     "rgba-row-major-opaque-v1", "token", QtCurrent.Token, "epoch", QtEpoch, "revision", revision,
                     "idleMs", Math.Max(0, Now() - Interlocked.Read(ref LastActivity)), "regions", report, "image",
                     file == null ? null : Data("file", file, "sha256", sha), "inputSent", false, "popup", popup);
            if (ownedImage != null)
                ownedImage.Transfer();
            return result;
        }
        finally
        {
            if (ownedImage != null)
                ownedImage.Dispose();
        }
    }
    static void QtFramePurpose(QtFrame frame, bool navigation)
    {
        Need(frame != null && frame.NavigationOnly == navigation, "QT_OBSERVATION_PURPOSE_INVALID");
    }
    static void QtRejectFrameAuthority(Dictionary<string, object> request)
    {
        Need(!request.ContainsKey("uiaControlFrame") && !request.ContainsKey("uiaControlLease"),
             "QT_UIA_CONTROL_FRAME_INVALID");
    }
    static bool QtUiaControlLeaseMatches(QtFrame frame, QtFocusLease lease)
    {
        return frame != null && frame.UiaControlFrame && !frame.NavigationOnly && frame.UiaControlLease != null &&
               Object.ReferenceEquals(frame.UiaControlLease, lease) && frame.Binding != null && lease.Wechat != null &&
               frame.Binding.Window == lease.Wechat.Window && frame.Binding.Pid == lease.Wechat.Pid &&
               frame.Binding.Created == lease.Wechat.Created && frame.Revision == lease.Revision;
    }
    static void QtCheckUiaControlLease(QtFrame frame)
    {
        if (frame != null && frame.UiaControlFrame)
            Need(QtUiaControlLeaseMatches(frame, QtFocus.Active) && QtFocus.Parked == null && QtSurface == "main" &&
                     QtPopup == null && QtPendingPopup == null,
                 "QT_UIA_CONTROL_FRAME_INVALID");
    }
    static bool QtUiaInputHeader(QtFrame frame, string kind, bool inputOnly, QtFocusLease lease)
    {
        return kind == "text" && inputOnly && QtUiaControlLeaseMatches(frame, lease);
    }
    static void QtMarkUiaControlFrame(QtFrame frame, QtFocusLease lease, Dictionary<string, object> report)
    {
        Need(frame != null && !frame.NavigationOnly && frame.Anchors != null &&
                 (frame.Anchors.Count == 2 || frame.MetadataOnly && frame.Anchors.Count == 3),
             "QT_UIA_CONTROL_FRAME_INVALID");
        frame.UiaControlFrame = true;
        frame.UiaControlLease = lease;
        Need(QtUiaControlLeaseMatches(frame, lease), "QT_UIA_CONTROL_FRAME_INVALID");
        report["uiaControlFrame"] = true;
    }
    static bool QtAttachTextHeaderMatches(QtFrame source, QtFrame current, bool inputOnly, QtFocusLease lease)
    {
        return current != null && source != null && current.Anchors.Count == 2 && source.Anchors.Count >= 1 &&
               Same(current.Anchors[0].Rect, source.Anchors[0].Rect) &&
               (current.Anchors[0].Hash == source.Anchors[0].Hash ||
                QtUiaInputHeader(source, "text", inputOnly, lease));
    }
    static void QtUiaNavigationContext()
    {
        Need(QtEnableInput && !Stopping && QtFocus.Active != null && QtFocus.Parked == null && QtSurface == "main" &&
                 QtPopup == null && QtPendingPopup == null,
             "QT_UIA_NAVIGATION_UNAVAILABLE");
        Need(QtFocus.Active.Revision == Interlocked.Read(ref Revision), "QT_HUMAN_ACTIVITY_CHANGED");
    }
    static bool QtNavigationLeaseMatches(QtFrame frame, QtFocusLease lease)
    {
        return frame != null && frame.NavigationOnly && frame.NavigationLease != null &&
               Object.ReferenceEquals(frame.NavigationLease, lease) && frame.Binding != null && lease.Wechat != null &&
               frame.Binding.Window == lease.Wechat.Window && frame.Binding.Pid == lease.Wechat.Pid &&
               frame.Binding.Created == lease.Wechat.Created;
    }
    static object QtCaptureUiaNavigation(Dictionary<string, object> request)
    {
        QtUiaNavigationContext();
        foreach (string key in request.Keys)
            Need(key == "id" || key == "action" || key == "surface" || key == "regions" || key == "image",
                 "QT_UIA_NAVIGATION_REQUEST_INVALID");
        var regions = Get(request, "regions") as object[];
        Need(Text(request, "surface") == "main" && Object.Equals(Get(request, "image"), false) && regions != null &&
                 regions.Length == 1,
             "QT_UIA_NAVIGATION_REQUEST_INVALID");
        var lease = QtFocus.Active;
        var result = QtCaptureUiaControls(request, "navigation");
        QtUiaNavigationContext();
        Need(Object.ReferenceEquals(lease, QtFocus.Active), "QT_UIA_NAVIGATION_UNAVAILABLE");
        QtCurrent.NavigationOnly = true;
        QtCurrent.NavigationLease = lease;
        Need(QtNavigationLeaseMatches(QtCurrent, lease), "QT_UIA_NAVIGATION_UNAVAILABLE");
        result.Add("navigationOnly", true);
        result.Add("baselinePixelStable", false);
        return result;
    }
    static object QtOpenUiaSearch(Dictionary<string, object> request)
    {
        QtUiaNavigationContext();
        foreach (string key in request.Keys)
            Need(key == "id" || key == "action" || key == "token" || key == "epoch" || key == "revision" ||
                     key == "idleMs" || key == "popupTransition",
                 "QT_UIA_NAVIGATION_REQUEST_INVALID");
        QtFramePurpose(QtCurrent, true);
        Need(QtNavigationLeaseMatches(QtCurrent, QtFocus.Active) && QtCurrent.Anchors.Count == 1 &&
                 !QtCurrent.PopupBounds.HasValue,
             "QT_UIA_NAVIGATION_UNAVAILABLE");
        var transition = Map(Get(request, "popupTransition"));
        Need(transition != null && Text(transition, "id") == "search", "QT_UIA_NAVIGATION_REQUEST_INVALID");
        var action = new Dictionary<string, object>(request);
        action["key"] = "Control+F";
        return QtAct(action, "chord", true);
    }
    static bool QtUiaEditorRegion(Rect editor, Rect header, Rect client)
    {
        return Contains(client, editor) && editor.Top >= client.Top + client.Height / 2 &&
               editor.Top >= header.Bottom && editor.Width >= 20 && editor.Height >= 12;
    }
    static object QtFocusUiaEditor(Dictionary<string, object> request)
    {
        QtUiaNavigationContext();
        foreach (string key in request.Keys)
            Need(key == "id" || key == "action" || key == "token" || key == "epoch" || key == "revision" ||
                     key == "idleMs" || key == "editorRect",
                 "QT_UIA_NAVIGATION_REQUEST_INVALID");
        QtFramePurpose(QtCurrent, true);
        var frame = QtCurrent;
        Need(QtNavigationLeaseMatches(frame, QtFocus.Active) && frame.Anchors.Count == 1 && !frame.PopupBounds.HasValue,
             "QT_UIA_NAVIGATION_UNAVAILABLE");
        Rect editor = ParseRect(Get(request, "editorRect")), header = frame.Anchors[0].Rect;
        Need(QtUiaEditorRegion(editor, header, frame.Binding.Client), "QT_UIA_EDITOR_REGION_INVALID");
        var action = new Dictionary<string, object>(request);
        action.Remove("editorRect");
        action["rect"] = editor.Report();
        var focused = Map(QtAct(action, "click", false, true));
        // This frame authorizes the ordinary input-only paste guards, not a
        // pixel-stability claim. The navigation token was consumed by QtAct.
        var captured = QtCaptureUiaControls(
            Data("surface", "main", "regions", new object[] { header.Report(), editor.Report() }, "image", false));
        QtMarkUiaControlFrame(QtCurrent, frame.NavigationLease, captured);
        QtCheckUiaControlLease(QtCurrent);
        QtUiaRole currentEditor = null;
        foreach (var role in QtCurrent.UiaRoles)
            if (role.Role == "editor")
                currentEditor = role;
        Need(currentEditor != null && currentEditor.Node.Element.Current.HasKeyboardFocus,
             "QT_UIA_EDITOR_FOCUS_UNCONFIRMED");
        bool reused = Object.Equals(Get(focused, "editorFocusReused"), true);
        captured.Add("navigationOnly", false);
        captured.Add("baselinePixelStable", false);
        return Data("performed", true, "attempted", !reused, "revision", captured["revision"], "editorFocused", true,
                    "inputSent", !reused, "editorFocusReused", reused, "postFocusFrame", captured, "pointerDelivery",
                    Get(focused, "pointerDelivery"));
    }
    static QtFrame QtGuard(Dictionary<string, object> request, bool idle, bool pixels = true, bool navigation = false)
    {
        QtRejectFrameAuthority(request);
        Need(QtEnableInput || !idle, "QT_INPUT_DISABLED");
        QtFrame frame = QtCurrent;
        Need(frame != null && Text(request, "token") == frame.Token && Text(request, "epoch") == QtEpoch,
             "QT_OBSERVATION_REQUIRED");
        QtFramePurpose(frame, navigation);
        QtCheckUiaControlLease(frame);
        Need(UtcMs() - frame.Issued >= 0 && UtcMs() - frame.Issued <= 30000, "QT_OBSERVATION_EXPIRED");
        Need(Number(Get(request, "revision")) == frame.Revision && Interlocked.Read(ref Revision) == frame.Revision,
             "QT_HUMAN_ACTIVITY_CHANGED");
        Binding actual = QtBound(!frame.MetadataOnly);
        Need(QtSameBinding(frame.Binding, actual), "QT_BINDING_CHANGED");
        if (frame.MetadataOnly)
            QtCheckUiaFrame(frame);
        else if (pixels)
        {
            QtFramePopupStable(frame);
            for (int index = 0; index < frame.Anchors.Count; index++)
                QtNeedAnchorPixels(frame.Anchors[index].Hash, QtHash(QtPixels(actual, frame.Anchors[index].Rect)),
                                   "guard", index);
        }
        Need(Interlocked.Read(ref Revision) == frame.Revision, "QT_HUMAN_ACTIVITY_CHANGED");
        NoKeysHeld();
        if (idle)
        {
            long minimum = Number(Get(request, "idleMs"));
            Need(minimum >= 0 && minimum <= 300000, "QT_IDLE_INVALID");
            QtRequireIdle(minimum);
        }
        return frame;
    }
    static void QtFramePopupStable(QtFrame frame)
    {
        if (frame.PopupBounds.HasValue)
        {
            Rect bounds, client;
            if (!(QtPopup != null && QtPopup.Observed && GetWindowRect(QtPopup.Window, out bounds) &&
                  GetClientRect(QtPopup.Window, out client) && Same(bounds, frame.PopupBounds.Value) &&
                  Same(client, frame.PopupClient.Value)))
                throw QtPopupBindingChanged(QtPopup, "frame", frame);
        }
    }
    static void QtStable(QtFrame frame)
    {
        QtCheckUiaControlLease(frame);
        Need(!Stopping && Interlocked.Read(ref Revision) == frame.Revision, "QT_HUMAN_ACTIVITY_CHANGED");
        Need(QtSameBinding(frame.Binding, QtBound(!frame.MetadataOnly)), "QT_BINDING_CHANGED");
        QtFramePopupStable(frame);
        QtCheckUiaFrame(frame);
        NoKeysHeld();
    }
    // Metadata does not require unobscured pixels. Read-only clipboard work
    // retains the native window/focus/activity guard without rewalking UIA;
    // actual input keeps fresh roles, and mouse input rechecks its hit point.
    static void QtInputStable(QtFrame frame, bool refreshControls = true)
    {
        QtCheckUiaControlLease(frame);
        Need(!Stopping && Interlocked.Read(ref Revision) == frame.Revision, "QT_HUMAN_ACTIVITY_CHANGED");
        Need(QtSameBinding(frame.Binding, QtBound(!frame.MetadataOnly)), "QT_BINDING_CHANGED");
        if (refreshControls)
            QtCheckUiaFrame(frame);
        Need(frame.Revision == Interlocked.Read(ref Revision), "QT_HUMAN_ACTIVITY_CHANGED");
        NoKeysHeld();
    }
    static Input[] QtChord(string key)
    {
        if (key == "Control+F")
            return new[] { Key(0x11, 0), Key(0x46, 0), Key(0x46, 2), Key(0x11, 2) };
        if (key == "Control+A")
            return ChordEvents(0x41);
        if (key == "Control+C")
            return ChordEvents(0x43);
        if (key == "Control+End")
            return ChordEvents(0x23);
        if (key == "Escape")
            return new[] { Key(0x1b, 0), Key(0x1b, 2) };
        // Generic Enter stays forbidden; dedicated actions require a one-use
        // proof of the complete text just read back by this native process.
        throw new Fault("QT_CHORD_FORBIDDEN");
    }
    static object QtAct(Dictionary<string, object> request, string action, bool uiaOpenSearch = false,
                        bool uiaEditor = false)
    {
        QtEmptyPhaseProof = null;
        QtRevokeQueryClick(QtPopup);
        if (uiaOpenSearch)
        {
            QtUiaNavigationContext();
            Need(action == "chord" && Text(request, "key") == "Control+F" &&
                     QtNavigationLeaseMatches(QtCurrent, QtFocus.Active),
                 "QT_UIA_NAVIGATION_UNAVAILABLE");
        }
        if (uiaEditor)
        {
            QtUiaNavigationContext();
            Need(!uiaOpenSearch && action == "click" && QtNavigationLeaseMatches(QtCurrent, QtFocus.Active) &&
                     Get(request, "popupTransition") == null && QtCurrent.Anchors.Count == 1 &&
                     QtUiaEditorRegion(ParseRect(Get(request, "rect")), QtCurrent.Anchors[0].Rect,
                                       QtCurrent.Binding.Client),
                 "QT_UIA_NAVIGATION_UNAVAILABLE");
        }
        bool navigation = uiaOpenSearch || uiaEditor;
        // Parking only moves the cursor. Its calibrated rectangle, hit test
        // and window/activity guards still apply while the caption repaints.
        QtFrame frame = QtGuard(request, true, !navigation && action != "movePointer", navigation);
        Input[] inputs;
        Point destination = new Point(0, 0);
        bool pointerAction = action == "click" || action == "movePointer";
        QtPopupLease queryClick = null,
                     pending = QtPreparePopupTransition(Get(request, "popupTransition"), frame, action,
                                                        Text(request, "key"), Get(request, "rect"));
        if (uiaEditor)
        {
            var editorRole = QtUiaResolveRoles(frame.Binding, new[] { "editor" })["editor"];
            Need(Same(editorRole.Node.Rect, ParseRect(Get(request, "rect"))), "QT_UIA_CONTROL_RECT_CHANGED");
            var delivery = QtUiaPointerClick(frame, editorRole, "editor-focus", delegate {
                QtRevokeEnter();
                QtCurrent = null;
            });
            return Data("performed", true, "attempted", delivery != null, "revision", frame.Revision,
                        "editorFocusReused", delivery == null, "pointerDelivery", delivery);
        }
        if (action == "type")
        {
            if (Text(request, "text") == "\n")
            {
                Need(Text(request, "newlineKey") == "Shift+Enter", "QT_NEWLINE_CALIBRATION_REQUIRED");
                inputs = new[] { Key(0x10, 0), Key(0x0d, 0), Key(0x0d, 2), Key(0x10, 2) };
            }
            else
                inputs = TextEvents(Text(request, "text"));
        }
        else if (action == "chord")
            inputs = QtChord(Text(request, "key"));
        else
        {
            Rect rect = ParseRect(Get(request, "rect"));
            Need(Contains(frame.Binding.Client, rect), "QT_REGION_INVALID");
            Point center = new Point(frame.Binding.Capture.Left + rect.Left + rect.Width / 2,
                                     frame.Binding.Capture.Top + rect.Top + rect.Height / 2);
            if (action == "movePointer")
            {
                bool anchored = false;
                foreach (var anchor in frame.Anchors)
                    if (Same(anchor.Rect, rect))
                        anchored = true;
                Need(QtCanParkPointer(QtSurface, rect, frame.Binding.Client.Width, anchored),
                     "QT_POINTER_PARK_INVALID");
            }
            IntPtr hit = WindowFromPoint(center);
            bool acceptedPopup = false;
            if (QtSearchSurface(QtSurface) && QtPopup != null && Owned(hit, QtPopup.Window, frame.Binding.Pid))
            {
                bool anchored = false;
                foreach (var anchor in frame.Anchors)
                    if (Contains(anchor.Rect, rect))
                        anchored = true;
                acceptedPopup =
                    anchored &&
                    Contains(QtPopup.Observed ? QtPopupClientInRoot(QtPopup) : QtPopup.Calibration.RelativeWindow,
                             rect) &&
                    QtPopupWindowMatches(QtPopup.Window, QtPopup);
            }
            Need(Owned(hit, frame.Binding.Window, frame.Binding.Pid) || acceptedPopup, "QT_CLICK_OBSCURED");
            if (action == "click" && QtSearchQueryClickEligible(QtSurface, frame, QtPopup, rect,
                                                                Owned(hit, frame.Binding.Window, frame.Binding.Pid)))
                queryClick = QtPopup;
            destination = center;
            inputs = action == "movePointer" ? QtPointerEvents(center, QtDesktopRect())
                                             : ClickEvents(center.X, center.Y, QtDesktopRect());
        }
        Need(!frame.MetadataOnly || navigation, "QT_UIA_ACTION_FORBIDDEN");
        QtStable(frame);
        if (frame.MetadataOnly && pointerAction)
            Need(Owned(WindowFromPoint(destination), frame.Binding.Window, frame.Binding.Pid), "QT_CLICK_OBSCURED");
        if (action != "movePointer")
            QtRevokeEnter();
        QtCurrent = null;
        InputAttempted = true;
        if (action == "click")
            ObserveMouseIntent(0x201, destination);
        uint accepted = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(Input)));
        if (accepted != inputs.Length)
        {
            QtPendingPopup = null;
            if (pointerAction && accepted > 0 && QtFocus.Active != null)
            {
                QtFocus.Active.MarkPointerUncertain();
            }
            Input[] release = action == "click" ? ClickReleases(accepted) : Releases(inputs, accepted);
            if (release.Length > 0)
                SendInput((uint)release.Length, release, Marshal.SizeOf(typeof(Input)));
            throw new Fault("QT_INPUT_UNCERTAIN");
        }
        if (pointerAction)
            QtRememberPointer(destination, frame.Revision);
        if (queryClick != null)
        {
            QtStable(frame);
            Need(Object.ReferenceEquals(queryClick, QtPopup), "QT_POPUP_BINDING_CHANGED");
            queryClick.QueryClick = new QtQueryClickProof { Popup = queryClick, Frame = frame, Epoch = QtEpoch };
        }
        if (action == "movePointer")
        {
            QtStable(frame);
            return Data("performed", true, "attempted", true, "revision", frame.Revision, "pointerParked", true,
                        "focusPreserved", true);
        }
        if (pending != null)
        {
            QtPendingPopup = pending;
            QtPopup = null;
        }
        return uiaOpenSearch ? Data("performed", true, "attempted", true, "revision", Interlocked.Read(ref Revision),
                                    "navigationOnly", true, "openedSearch", true, "baselinePixelStable", false)
                             : Data("performed", true, "attempted", true, "revision", Interlocked.Read(ref Revision));
    }
    static void QtPause(QtFrame frame, int milliseconds)
    {
        long end = Now() + milliseconds;
        while (Now() < end)
        {
            Thread.Sleep(10);
            QtStable(frame);
        }
    }
    static string QtNormalizeText(string value)
    {
        return value == null ? null : value.Replace("\r\n", "\n").Replace("\r", "\n");
    }
    // Read control messages independently of an in-flight copy. Stop prevents
    // subsequent keyboard input immediately; the worker still runs its finally
    // block and restores an unchanged owned clipboard before acknowledging exit.
    static void QtInputLoop()
    {
        try
        {
            var controlJson = new System.Web.Script.Serialization.JavaScriptSerializer();
            for (;;)
            {
                string line = QtReadBoundedLine();
                if (line == null)
                    break;
                var request = Map(controlJson.DeserializeObject(line));
                Need(request != null, "QT_REQUEST_INVALID");
                if (Text(request, "action") == "stop")
                    Stopping = true;
                lock (QtRequests)
                {
                    Need(QtRequests.Count < 2, "QT_REQUEST_QUEUE_FULL");
                    QtRequests.Enqueue(line);
                    Monitor.PulseAll(QtRequests);
                }
            }
        }
        catch
        {
            QtInputFailed = true;
        }
        finally
        {
            Stopping = true;
            lock (QtRequests)
            {
                QtInputEnded = true;
                Monitor.PulseAll(QtRequests);
            }
        }
    }
    static string QtNextRequest()
    {
        lock (QtRequests)
        {
            while (QtRequests.Count == 0 && !QtInputEnded)
                Monitor.Wait(QtRequests);
            if (QtInputFailed)
                throw new Fault("QT_INPUT_STREAM_INVALID");
            return QtRequests.Count > 0 ? QtRequests.Dequeue() : null;
        }
    }
    static object QtDispatch(QtClipboardOperation clipboard, string action, Dictionary<string, object> request,
                             IntPtr owner)
    {
        switch (action)
        {
        case "prepareQuoteHistory":
            return QtPrepareQuoteHistory(request);
        case "attachMessageQuote":
            return QtAttachQuote(request);
        case "checkClearMessageQuote":
            return QtCheckClearQuote(request);
        case "verifyOpenChatTitle":
            return QtVerifyOpenChatTitle(request);
        case "verifyMessageQuote": {
            var verifiedQuoteFrame = QtGuard(request, true, false);
            Need(Text(request, "quoteToken") != null, "QT_QUOTE_CHANGED");
            QtVerifyQuote(request, verifiedQuoteFrame);
            return Data("verified", true);
        }
        case "scrollOcrQuoteHistory":
            return QtScrollOcrQuoteHistory(request);
        case "openOcrQuoteMenu":
            return QtOpenOcrQuoteMenu(request);
        case "captureOcrQuoteMenu":
            return QtCaptureOcrQuoteMenu(request);
        case "chooseOcrQuoteMenu":
            return QtChooseOcrQuoteMenu(request);
        case "bindOcrQuotePreview":
            return QtBindOcrQuotePreview(request);
        case "inspectClipboard":
            return QtClipboardFormats(owner);
        case "inspectClipboardBackup":
            return QtInspectClipboardBackup(owner);
        case "inspectQuoteRows":
            return QtInspectQuoteRows(request);
        case "inspectLayout":
            return QtInspectLayout();
        case "warmUiaLocators":
            return QtWarmUiaLocators(request);
        case "inspectUiaFocusGeometry":
            return QtInspectUiaFocusGeometry(request);
        case "inspectTargetOcclusion": {
            var observed = Map(QtInspectLayout());
            var identity = Map(Get(observed, "binding"));
            Binding bound = new Binding { Window = new IntPtr(DecimalString(Get(identity, "hwnd"))),
                                          Capture = ParseRect(Get(identity, "captureRect")),
                                          Client = ParseRect(Get(identity, "clientRect")) };
            return Data("readOnly", true, "inputSent", false, "occlusion", QtOverlapReport(bound));
        }
        case "captureLayout":
            return QtCaptureLayout(request);
        case "captureLayoutHandoff":
            return QtCaptureLayoutHandoff(request);
        case "captureLayoutRaised":
            return QtCaptureLayoutRaised(request);
        case "inspectFocusHandoff":
            return QtInspectFocus(request);
        case "inspectFocusActivation":
            return QtInspectFocusActivation(request);
        case "inspectPopup":
            return QtInspectPopup(request);
        case "inspectEmptyEditorPhase":
            return QtInspectEmptyEditorPhase(request);
        case "beginFocusHandoff": {
            var expected = QtFocus.TakeInspection();
            return QtBeginFocus(request, expected == null ? (long?)null : expected.Revision, false, expected);
        }
        case "beginForegroundSession":
            return QtBeginForegroundSession(request, QtFocus.TakeInspection());
        case "parkFocusHandoff":
            return QtParkFocus();
        case "resumeFocusHandoff":
            return QtResumeFocus(request);
        case "transferFocusHandoff":
            return QtTransferFocus();
        case "restoreTransferredFocus":
            return QtRestoreTransferred(request);
        case "releaseFocusHandoff":
            return QtReleaseFocusHandoff();
        case "inspectOcclusion": {
            QtSelectSurface(Text(request, "surface"), Text(request, "surfaceId"));
            Binding bound = Snapshot(QtWindow, QtExecutable);
            var occlusion = QtOverlapReport(bound);
            occlusion.Add("diagnostics", QtOcclusionDiagnostics(bound, Get(request, "diagnosticRegions")));
            return Data("occlusion", occlusion, "binding", bound.Report(), "readOnly", true, "inputSent", false);
        }
        case "capture":
            return QtCapture(request);
        case "captureUiaControls":
            return QtCaptureUiaControls(request);
        case "captureUiaSearch":
            return QtCaptureUiaControls(request, "search");
        case "captureUiaNavigation":
            return QtCaptureUiaNavigation(request);
        case "openUiaSearch":
            return QtOpenUiaSearch(request);
        case "focusUiaEditor":
            return QtFocusUiaEditor(request);
        case "focusUiaReadyEditor":
            return QtFocusUiaReadyEditor(request);
        default:
            return QtEditorCommand(clipboard, action, request, owner);
        }
    }
    static void QtReadLoop(IntPtr owner)
    {
        try
        {
            for (;;)
            {
                string line = QtNextRequest();
                if (line == null)
                    break;
                object id = null;
                InputAttempted = false;
                var clipboard = new QtClipboardOperation();
                QtCommandStarted = Now();
                try
                {
                    Need(line.Length <= 65536, "QT_REQUEST_TOO_LARGE");
                    var request = Map(Json.DeserializeObject(line));
                    Need(request != null, "QT_REQUEST_INVALID");
                    id = Get(request, "id");
                    Number(id);
                    string action = Text(request, "action");
                    Need(!QtLayoutOnly || QtLayoutOnlyAction(action), "QT_LAYOUT_ONLY");
                    object result;
                    QtImageActionBoundary(action);
                    if (action == "releaseFocusHandoff" || action == "stop")
                    {
                        QtActiveQuote = null;
                        QtActiveOcrQuote = null;
                    }
                    if ((action == "paste" && Text(request, "scope") == "editor") || action == "typeText")
                        QtVerifyQuote(request, QtCurrent);
                    if (!QtUiaSearchReadOnlyAction(action) && action != "focusUiaReadyEditor")
                        QtRevokeUiaSearch();
                    if (action == "stop" || action == "transferFocusHandoff" || action == "restoreTransferredFocus")
                        QtRevokeEnter();
                    else if (action == "beginFocusHandoff" || action == "beginForegroundSession" ||
                             action == "parkFocusHandoff" || action == "resumeFocusHandoff" ||
                             action == "releaseFocusHandoff")
                        QtPauseTextEnter();
                    if (action == "stop")
                    {
                        QtReleaseFocusHandoff();
                        Write(Data("id", id, "ok", true, "result", Data("stopped", true)));
                        break;
                    }
                    result = QtDispatch(clipboard, action, request, owner);
                    if (clipboard.Restoration != null && result is Dictionary<string, object>)
                        Map(result)["clipboardRestoration"] = clipboard.Restoration;
                    Write(Data("id", id, "ok", true, "result", result));
                }
                catch (Exception error)
                {
                    QtCurrent = null;
                    Write(Data("id", id, "ok", false, "error",
                               Data("code", error is Fault ? error.Message : "QT_OPERATION_FAILED", "attempted",
                                    InputAttempted, "clipboardRestored", clipboard.Restored, "clipboardReplaced",
                                    clipboard.Replaced, "originalClipboardBlocked",
                                    error.Data["QtOriginalClipboardBlocked"], "focusConfirmation",
                                    FocusFailureDiagnostic(error), "focusVisibility", QtFocusVisibilityFailure(error),
                                    "focusRestoreOutcome", QtFocusRestoreFailure(error), "foregroundInterval",
                                    QtFocusTimingFailure(error), "visibilityRestoreOutcome",
                                    error.Data["QtVisibilityRestoreOutcome"], "raisedVisibilityInterval",
                                    error.Data["QtRaisedVisibilityInterval"], "pixelMismatch", QtPixelMismatch(error),
                                    "popupBindingMismatch", clipboard.PopupMismatch(error), "enterFocus",
                                    QtEnterFocusFailure(error), "clipboardBackup", error.Data["QtClipboardBackup"],
                                    "imageClipboard", error.Data["QtImageClipboard"], "uiaControlRect",
                                    error.Data["QtUiaControlRect"], "quoteMenuSelection",
                                    error.Data["QtQuoteMenuSelection"])));
                }
                finally
                {
                    QtCommandStarted = 0;
                }
            }
        }
        catch (Exception error)
        {
            QtExitCode = 1;
            Write(Data("id", null, "ok", false, "error",
                       Data("code", error is Fault ? error.Message : "QT_OPERATION_FAILED")));
        }
        finally
        {
            try
            {
                QtReleaseFocusHandoff();
            }
            catch
            {
                // Exiting the helper must still stop its dispatch thread.
            }
            Stopping = true;
            try
            {
                Dispatcher.BeginInvoke((Action)delegate { Application.ExitThread(); });
            }
            catch
            {
            }
        }
    }
    static string QtReadBoundedLine()
    {
        var value = new StringBuilder();
        int c;
        while ((c = Console.In.Read()) != -1)
        {
            if (c == '\n')
                return value.ToString();
            Need(value.Length < 65536, "QT_REQUEST_TOO_LARGE");
            value.Append((char)c);
        }
        Need(value.Length == 0, "QT_REQUEST_TRUNCATED");
        return null;
    }
    // Geometry only: no capture, input hooks, process memory, titles or focus
    // changes. Display positions can be negative on an extended desktop.
    static object QtDesktopLayout()
    {
        SetProcessDpiAwarenessContext(new IntPtr(-4));
        Desktop();
        var screens = new List<object>();
        foreach (Screen screen in Screen.AllScreens)
        {
            Rectangle b = screen.Bounds, w = screen.WorkingArea;
            screens.Add(Data("primary", screen.Primary, "bounds", new Rect(b.Left, b.Top, b.Right, b.Bottom).Report(),
                             "workArea", new Rect(w.Left, w.Top, w.Right, w.Bottom).Report()));
        }
        return Data("version", 1, "readOnly", true, "inputSent", false, "focusChanged", false, "virtualDesktop",
                    QtDesktopRect().Report(), "displays", screens);
    }
    static bool QtLayoutOnly;
    static bool QtLayoutOnlyAction(string action)
    {
        return action == "inspectLayout" || action == "captureLayout" || action == "captureLayoutHandoff" ||
               action == "captureLayoutRaised" || action == "stop";
    }
    internal static int QtMain(string[] args)
    {
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        if (args.Length == 1 && args[0] == "--self-test")
            return QtSelfTest();
        if (args.Length == 1 && args[0] == "--desktop-layout")
        {
            try
            {
                Write(QtDesktopLayout());
                return 0;
            }
            catch (Exception error)
            {
                Write(Data("ok", false, "code", error is Fault ? error.Message : "QT_DESKTOP_LAYOUT_FAILED"));
                return 1;
            }
        }
        try
        {
            Need(args.Length == 7 && args[0] == "--executable" && args[2] == "--hwnd" && args[4] == "--frames" &&
                     (args[6] == "--enable-input" || args[6] == "--read-only" || args[6] == "--layout-only"),
                 "QT_ARGUMENTS_INVALID");
            QtExecutable = Exe(args[1]);
            QtWindow = args[3] == "auto" ? IntPtr.Zero : new IntPtr(DecimalString(args[3]));
            QtFrames = Path.GetFullPath(args[5]);
            Need(Directory.Exists(QtFrames), "QT_FRAMES_REQUIRED");
            QtLayoutOnly = args[6] == "--layout-only";
            QtEnableInput = args[6] == "--enable-input" || QtLayoutOnly;
            SetProcessDpiAwarenessContext(new IntPtr(-4));
            if (QtEnableInput)
                Gate = Acquire("Local\\WeChatAgent.UiInput.v1");
            ActivityMonitorStarted = LastActivity = Now();
            QtCaptionClicks = new QtCaptionClickHistory();
            MouseObservationObserver = QtEnableInput ? QtCaptionObserver : null;
            using (var process = Process.GetCurrentProcess())
            {
                IntPtr module = GetModuleHandle(process.MainModule.ModuleName);
                KeyboardHook = SetWindowsHookEx(13, KeyboardCallback, module, 0);
                MouseHook = SetWindowsHookEx(14, MouseCallback, module, 0);
            }
            Need(KeyboardHook != IntPtr.Zero && MouseHook != IntPtr.Zero, "QT_ACTIVITY_MONITOR_UNAVAILABLE");
            Dispatcher = new Control();
            IntPtr owner = Dispatcher.Handle;
            using (var watchdog = new System.Threading.Timer(delegate {
                long started = Interlocked.Read(ref QtCommandStarted);
                if (started > 0 && Now() - started > 20000)
                    Environment.Exit(124);
            }, null, 1000, 1000))
            {
                var control = new Thread(QtInputLoop);
                control.IsBackground = true;
                control.SetApartmentState(ApartmentState.MTA);
                control.Start();
                var worker = new Thread(delegate() { QtReadLoop(owner); });
                worker.IsBackground = true;
                worker.SetApartmentState(ApartmentState.MTA);
                worker.Start();
                Application.Run();
            }
            return QtExitCode;
        }
        catch (Exception error)
        {
            Write(Data("id", null, "ok", false, "error",
                       Data("code", error is Fault ? error.Message : "QT_START_FAILED")));
            return 1;
        }
        finally
        {
            Stopping = true;
            MouseObservationObserver = null;
            if (KeyboardHook != IntPtr.Zero)
                UnhookWindowsHookEx(KeyboardHook);
            if (MouseHook != IntPtr.Zero)
                UnhookWindowsHookEx(MouseHook);
            if (Dispatcher != null)
                Dispatcher.Dispose();
            if (Gate != null)
            {
                try
                {
                    Gate.ReleaseMutex();
                }
                finally
                {
                    Gate.Dispose();
                }
            }
        }
    }
}
