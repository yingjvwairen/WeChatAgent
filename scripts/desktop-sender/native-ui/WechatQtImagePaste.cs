using System;
using System.IO;
using System.Text;
using System.Globalization;
using System.Drawing;
using System.Drawing.Imaging;
using System.Runtime.InteropServices;
using System.Collections.Generic;
using System.Threading;
using System.Windows.Forms;
using System.Windows.Automation;

internal static partial class WechatDraftProbe
{
    // Failure diagnostics contain stages and anonymous clipboard metadata only.
    // No GetClipboardData call is permitted here: that would request rendering.
    sealed class QtImagePasteTrace
    {
        internal string Stage = "source", OperationFailure, CleanupFailure;
        internal uint Format;
        internal readonly List<object> States = new List<object>();
        internal void Mark(string stage, IntPtr owner, bool clipboardOpen = false)
        {
            Stage = stage;
            var formats = new List<uint>();
            if (clipboardOpen)
            {
                uint format = 0;
                while ((format = EnumClipboardFormats(format)) != 0 && formats.Count < 8)
                    formats.Add(format);
            }
            States.Add(Data("stage", stage, "sequence", GetClipboardSequenceNumber(), "ownerMatched",
                            GetClipboardOwner() == owner, "formats", clipboardOpen ? (object)formats : null));
        }
        internal object Report()
        {
            return Data("version", 1, "stage", Stage, "format", Format, "operationFailure", OperationFailure,
                        "cleanupFailure", CleanupFailure, "states", States);
        }
    }
    // Delayed rendering provides a real consumer signal. WM_RENDERFORMAT is
    // sent while GetClipboardData's caller owns the clipboard lock; successful
    // re-opening after this callback proves that caller has released it. Win32
    // forbids use of that clipboard handle after CloseClipboard. This proves
    // data handoff only, never editor import or message delivery.
    sealed class QtImageRenderOwner : NativeWindow, IDisposable
    {
        internal readonly object Sync = new object();
        internal readonly ManualResetEvent Completed = new ManualResetEvent(false);
        internal IntPtr Owner, Payload;
        internal uint Format, PublishedSequence, RenderedSequence, Pid;
        internal long Created, Revision, Started, RenderedAt;
        internal IntPtr Wechat;
        internal bool Entered, Rendered, Detached, ProbePending, ProbeObserved;
        internal string Failure;
        internal QtImageRenderOwner(IntPtr owner, IntPtr payload, uint format, QtFrame frame)
        {
            Owner = owner;
            Payload = payload;
            Format = format;
            Pid = frame.Binding.Pid;
            Created = frame.Binding.Created;
            Wechat = frame.Binding.Window;
            Revision = frame.Revision;
            Started = Now();
        }
        internal void Attach()
        {
            Dispatcher.Invoke((Action)delegate { AssignHandle(Owner); });
        }
        internal void Arm()
        {
            lock (Sync)
            {
                Need(!Detached && !Rendered && Failure == null && PublishedSequence > 0,
                     "QT_IMAGE_RENDER_STATE_INVALID");
                Entered = true;
            }
        }
        protected override void WndProc(ref Message message)
        {
            if (message.Msg == 0x305)
            {
                try
                {
                    lock (Sync)
                    {
                        uint pid = 0;
                        IntPtr requester = GetOpenClipboardWindow();
                        if (requester != IntPtr.Zero)
                            GetWindowThreadProcessId(requester, out pid);
                        if (ProbePending && !Entered && !Rendered && !Detached && pid == GetCurrentProcessId() &&
                            unchecked((uint)message.WParam.ToInt64()) == Format)
                        {
                            ProbeObserved = true;
                            return;
                        }
                        if (!QtImageRenderEligible(Entered, Rendered, Detached, Format,
                                                   unchecked((uint)message.WParam.ToInt64()), Pid, pid))
                            return;
                        Need(!Stopping && Now() >= Started && Now() - Started <= 1500 &&
                                 Interlocked.Read(ref WechatDraftProbe.Revision) == Revision,
                             "QT_IMAGE_RENDER_BINDING_CHANGED");
                        var identity = QtFocusWindow(Wechat, QtExecutable, true);
                        Need(identity.Pid == Pid && identity.Created == Created && GetClipboardOwner() == Owner &&
                                 GetClipboardSequenceNumber() == PublishedSequence,
                             "QT_IMAGE_RENDER_BINDING_CHANGED");
                        Need(Payload != IntPtr.Zero && SetClipboardData(Format, Payload) != IntPtr.Zero,
                             "QT_IMAGE_CLIPBOARD_FAILED");
                        Payload = IntPtr.Zero;
                        RenderedSequence = GetClipboardSequenceNumber();
                        RenderedAt = Now();
                        Rendered = true;
                        Completed.Set();
                    }
                }
                catch (Exception error)
                {
                    lock (Sync)
                    {
                        Failure = error is Fault ? error.Message : "QT_IMAGE_RENDER_FAILED";
                        Completed.Set();
                    }
                }
                finally
                {
                    message.Result = IntPtr.Zero;
                }
                return;
            }
            base.WndProc(ref message);
        }
        public void Dispose()
        {
            lock (Sync)
            {
                Detached = true;
            }
            Dispatcher.Invoke((Action)delegate { ReleaseHandle(); });
            lock (Sync)
            {
                if (Payload != IntPtr.Zero)
                {
                    GlobalFree(Payload);
                    Payload = IntPtr.Zero;
                }
            }
            Completed.Dispose();
        }
    }
    [DllImport("user32.dll")]
    static extern IntPtr GetOpenClipboardWindow();
    static uint QtConfirmDelayedImageOffer(QtImageRenderOwner renderer, IntPtr owner, uint ownerPid,
                                           QtImagePasteTrace trace = null)
    {
        // CloseClipboard synthesizes bitmap companions and advances sequence.
        // A self-request deliberately returns no data: observing our callback
        // proves the offered format is still ours without rendering it early.
        Need(OpenClipboard(owner), "DRAFT_CLIPBOARD_BUSY");
        try
        {
            if (trace != null)
                trace.Mark("offer", owner, true);
            Need(GetClipboardOwner() == owner && ClipboardOwnerPid() == ownerPid, "DRAFT_CLIPBOARD_CHANGED");
            uint format = 0;
            int count = 0;
            bool offered = false;
            while ((format = EnumClipboardFormats(format)) != 0)
            {
                Need(++count <= 4 && (renderer.Format == 13 ? format == 1 || format == 7 || format == 13 || format == 16
                                      : renderer.Format == 15 ? format == 15
                                                              : format == 2 || format == 8 || format == 17),
                     "DRAFT_CLIPBOARD_CHANGED");
                offered |= format == renderer.Format;
            }
            Need(offered, "DRAFT_CLIPBOARD_CHANGED");
            if (renderer.Format == 13)
            {
                // Asking for our own delayed Unicode text and returning null
                // can invalidate Windows' synthesized CF_TEXT/CF_OEMTEXT offer.
                // Ownership and the locked published format are sufficient to
                // validate publication; only WeChat may establish consumption.
                lock (renderer.Sync)
                {
                    Need(!renderer.Entered && !renderer.Rendered && renderer.Payload != IntPtr.Zero &&
                             GetClipboardOwner() == owner,
                         "DRAFT_CLIPBOARD_CHANGED");
                    renderer.PublishedSequence = GetClipboardSequenceNumber();
                    return renderer.PublishedSequence;
                }
            }
            lock (renderer.Sync)
            {
                Need(!renderer.Entered && !renderer.Rendered && renderer.Payload != IntPtr.Zero,
                     "QT_IMAGE_RENDER_STATE_INVALID");
                renderer.ProbePending = true;
                renderer.ProbeObserved = false;
            }
            IntPtr data;
            try
            {
                data = GetClipboardData(renderer.Format);
            }
            finally
            {
                lock (renderer.Sync)
                {
                    renderer.ProbePending = false;
                }
            }
            lock (renderer.Sync)
            {
                Need(data == IntPtr.Zero && renderer.ProbeObserved && !renderer.Rendered &&
                         renderer.Payload != IntPtr.Zero && GetClipboardOwner() == owner,
                     "DRAFT_CLIPBOARD_CHANGED");
                renderer.PublishedSequence = GetClipboardSequenceNumber();
                return renderer.PublishedSequence;
            }
        }
        finally
        {
            CloseClipboard();
        }
    }
    static bool QtImageRenderEligible(bool entered, bool rendered, bool detached, uint offered, uint requested,
                                      uint expectedPid, uint actualPid)
    {
        return entered && !rendered && !detached && (offered == 8 || offered == 13 || offered == 15) &&
               requested == offered && expectedPid > 0 && actualPid == expectedPid;
    }
    static uint QtImageConsumerCore(Func<bool> rendered, Func<uint?> release, Action guard, Func<long> now,
                                    Action<int> wait)
    {
        long started = now(), deadline = started + 650;
        bool consumed = false;
        for (;;)
        {
            guard();
            Need(now() >= started, "QT_IMAGE_CLIPBOARD_CLOCK_CHANGED");
            if (!consumed)
                consumed = rendered();
            if (consumed)
            {
                uint? sequence = release();
                if (sequence.HasValue)
                    return sequence.Value;
            }
            Need(now() < deadline,
                 consumed ? "QT_IMAGE_CLIPBOARD_RELEASE_UNCONFIRMED" : "QT_IMAGE_CLIPBOARD_CONSUMPTION_UNCONFIRMED");
            wait(consumed ? 1 : 5);
        }
    }
    static uint QtWaitImageClipboardConsumer(QtImageRenderOwner renderer, IntPtr owner, uint ownerPid)
    {
        // Acquire the lock after the actual target's GetClipboardData call has
        // returned and its owner released the clipboard. Never infer this from
        // SendInput success, WM_NULL, elapsed time or a foreign reader.
        return QtImageConsumerCore(delegate{lock(renderer.Sync){if(renderer.Failure!=null)throw new Fault(renderer.Failure);return renderer.Rendered;
    }
}
, delegate
{
    if (!OpenClipboard(owner))
        return null;
    try
    {
        lock (renderer.Sync)
        {
            Need(renderer.Rendered && renderer.Payload == IntPtr.Zero && GetClipboardOwner() == owner &&
                     ClipboardOwnerPid() == ownerPid,
                 "DRAFT_CLIPBOARD_CHANGED");
            return (uint?)GetClipboardSequenceNumber();
        }
    }
    finally
    {
        CloseClipboard();
    }
}
, delegate
{
    Need(GetClipboardOwner() == owner && ClipboardOwnerPid() == ownerPid, "DRAFT_CLIPBOARD_CHANGED");
}
, Now, delegate(int ms)
{
    if (ms == 5)
        renderer.Completed.WaitOne(ms);
    else
        Thread.Sleep(ms);
});
}
static uint QtImageCleanupSequence(QtImageRenderOwner renderer, IntPtr owner, uint ownerPid, uint expected,
                                   bool materialize = false)
{
    // A failed or partial input is never retried. Stop granting renders,
    // then give an in-flight reader a bounded chance to release its lock
    // so even refusal can restore our original clipboard safely.
    lock (renderer.Sync)
    {
        renderer.Detached = true;
    }
    long deadline = Now() + 650;
    for (;;)
    {
        Need(GetClipboardOwner() == owner && ClipboardOwnerPid() == ownerPid, "DRAFT_CLIPBOARD_CHANGED");
        if (OpenClipboard(owner))
        {
            try
            {
                lock (renderer.Sync)
                {
                    uint current = GetClipboardSequenceNumber();
                    Need(GetClipboardOwner() == owner &&
                             (current == expected || (renderer.Rendered && current == renderer.RenderedSequence)),
                         "DRAFT_CLIPBOARD_CHANGED");
                    if (materialize && !renderer.Rendered)
                    {
                        // We are about to detach this delayed-render handler. Give
                        // the system the actual bytes, even on cancellation. This
                        // transfer is not evidence that WeChat consumed anything.
                        Need(renderer.Payload != IntPtr.Zero &&
                                 SetClipboardData(renderer.Format, renderer.Payload) != IntPtr.Zero,
                             "QT_IMAGE_CLIPBOARD_FAILED");
                        renderer.Payload = IntPtr.Zero;
                    }
                    return GetClipboardSequenceNumber();
                }
            }
            finally
            {
                CloseClipboard();
            }
        }
        Need(Now() < deadline, "QT_IMAGE_CLIPBOARD_RELEASE_UNCONFIRMED");
        Thread.Sleep(1);
    }
}
sealed class QtImageProof
{
    internal string Id, Epoch, Digest, Format, FilePath, FileDelivery, QuoteToken;
    internal QtFrame Frame;
    internal QtFocusLease Lease;
    internal Rect Header, Editor, Send;
    internal long Issued;
    internal bool Consumed, Paused;
}
static QtImageProof QtPendingImage;
static bool QtImagePasteUnconfirmed;
static void QtRevokeImage()
{
    if (QtPendingImage != null)
        QtPendingImage.Consumed = true;
    QtPendingImage = null;
}
static void QtImageActionBoundary(string action)
{
    if (action != "captureOcrFileDialog" && action != "submitFileDialog")
        QtPendingFileDialog = null;
    if (action == "releaseFocusHandoff")
    {
        var proof = QtPendingImage;
        if (proof != null && !proof.Consumed && !proof.Paused && Object.ReferenceEquals(proof.Lease, QtFocus.Active) &&
            proof.Frame.Revision == Interlocked.Read(ref Revision))
            proof.Paused = true;
        else
            QtRevokeImage();
        return;
    }
    if (action == "pasteUiaFile" || action == "pasteUiaImage" || action == "submitUiaImage" ||
        action == "resumeUiaImage" || action == "inspectLayout" || action == "inspectFocusHandoff" ||
        action == "inspectUiaFocusGeometry" || action == "inspectTargetOcclusion" || action == "inspectOcclusion" ||
        action == "inspectClipboard")
        return;
    if (action == "beginFocusHandoff" && QtPendingImage != null && QtPendingImage.Paused)
        return;
    QtRevokeImage();
}
static void QtImageKeys(Dictionary<string, object> request, params string[] allowed)
{
    foreach (string key in request.Keys)
    {
        bool valid = key == "id" || key == "action";
        foreach (string item in allowed)
            if (key == item)
                valid = true;
        Need(valid, "QT_UIA_IMAGE_REQUEST_INVALID");
    }
}
static bool QtImageProofMatches(QtImageProof proof, string id, string digest, QtFrame frame, QtFocusLease lease,
                                long now, bool paused)
{
    return proof != null && !proof.Consumed && proof.Paused == paused && proof.Id == id && proof.Digest == digest &&
           proof.Epoch == QtEpoch && proof.Frame != null && proof.Frame.MetadataOnly && proof.Frame.UiaControlFrame &&
           now >= proof.Issued && now - proof.Issued <= 30000 && frame != null && frame.MetadataOnly &&
           frame.Binding != null && proof.Frame.Binding.Thread == frame.Binding.Thread &&
           QtSameBinding(proof.Frame.Binding, frame.Binding) && proof.Frame.Revision == frame.Revision &&
           (paused || Object.ReferenceEquals(proof.Frame, frame) && Object.ReferenceEquals(proof.Lease, lease) &&
                          QtUiaControlLeaseMatches(frame, lease));
}
static object QtImageProofPacket(QtImageProof proof)
{
    return Data("version", 1, "id", proof.Id, "imageSha256", proof.Digest, "imageFormat", proof.Format);
}
static Dictionary<string, object> QtImageControls(Rect header, Rect editor, Rect send)
{
    return QtCaptureUiaControls(Data("surface", "main", "regions",
                                     new object[] { header.Report(), editor.Report(), send.Report() }, "image", false),
                                "image");
}
static Dictionary<string, object> QtImageControlsAfterPaste(QtFrame source, ref Rect header, ref Rect editor,
                                                            ref Rect send)
{
    Need(source != null && source.MetadataOnly && source.UiaRoles != null && QtFocus.Active == source.UiaControlLease,
         "QT_UIA_IMAGE_BINDING_CHANGED");
    var found = QtUiaResolveRoles(source.Binding, new[] { "header", "editor", "send" });
    foreach (var old in source.UiaRoles)
        Need(found.ContainsKey(old.Role) && QtUiaSameControl(old.Node, found[old.Role].Node, source.Binding.Pid),
             "QT_UIA_IMAGE_BINDING_CHANGED");
    Need(Same(header, found["header"].Node.Rect), "QT_UIA_IMAGE_BINDING_CHANGED");
    // An inline attachment legitimately grows this very editor upward.
    // Accept its current exact bounds only after our proved clipboard paste,
    // retaining the same native editor, ancestry, page and focus lease.
    header = found["header"].Node.Rect;
    editor = found["editor"].Node.Rect;
    send = found["send"].Node.Rect;
    return QtImageControls(header, editor, send);
}
static Dictionary<string, object> QtFileConversation(QtUiaRole header, Binding binding, List<string> titleParts = null)
{
    var cache = QtUiaControlCache();
    var names = QtUiaControlCache();
    names.Add(AutomationElement.NameProperty);
    var walker = TreeWalker.RawViewWalker;
    QtUiaNode title = null;
    var texts = new List<QtUiaNode>();
    int visited = 0;
    long deadline = Now() + 700;
    Action<QtUiaNode, int> walk = null;
    walk = delegate(QtUiaNode node, int depth)
    {
        Need(++visited <= 64 && depth <= 24 && Now() <= deadline, "QT_FILE_TITLE_SCAN_LIMIT");
        Need(node.Pid == binding.Pid, "QT_FILE_TITLE_CHANGED");
        if (node.Offscreen)
            return;
        if (node.Class == "mmui::XHBoxView" && node.Type == ControlType.Text &&
            (QtUiaAncestor(node, "mmui::ChatTitleBarChatSingleView") != null ||
             QtUiaAncestor(node, "mmui::ChatTitleBarChatRoomView") != null))
        {
            Need(title == null, "QT_FILE_TITLE_AMBIGUOUS");
            title = node;
        }
        for (var child = walker.GetFirstChild(node.Element, cache); child != null;
             child = walker.GetNextSibling(child, cache))
        {
            var next = QtUiaReadControl(child, node, binding);
            if (Object.ReferenceEquals(node, title) && !next.Offscreen && next.Class == "mmui::XTextView" &&
                next.Type == ControlType.Text)
                texts.Add(next);
            walk(next, depth + 1);
        }
    };
    walk(header.Node, 0);
    Need(title != null && texts.Count >= 1 && texts.Count <= 4, "QT_FILE_TITLE_UNAVAILABLE");
    var digest = new StringBuilder("chat-title-text-v1\n");
    int total = 0;
    foreach (var node in texts)
    {
        var live = node.Element.GetUpdatedCache(names);
        var current = QtUiaReadControl(live, node.Parent, binding);
        Need(QtUiaSameControl(node, current, binding.Pid), "QT_FILE_TITLE_CHANGED");
        string value = live.Cached.Name;
        Need(value != null && value.Length > 0 && value.Length <= 256 && value.IndexOf('\0') < 0 &&
                 (total += value.Length) <= 512,
             "QT_FILE_TITLE_UNAVAILABLE");
        if (titleParts != null)
            titleParts.Add(value);
        digest.Append(value.Length.ToString(CultureInfo.InvariantCulture)).Append(':').Append(value).Append('\n');
    }
    return Data("version", 1, "scope", "chat-title-text-v1", "sha256", QtFileHash(digest.ToString()),
                "headerRuntimeIdSha256", QtFileHash(header.Node.Runtime), "titleRuntimeIdSha256",
                QtFileHash(title.Runtime), "textNodeCount", texts.Count, "targetVerified", false);
}
static string QtFileHash(string value)
{
    return QtHash(Encoding.UTF8.GetBytes(value));
}
static void QtFileRequireWritableEditor(QtUiaRole role)
{
    object pattern;
    var editor = role.Node.Element;
    Need(editor.TryGetCurrentPattern(ValuePattern.Pattern, out pattern) && pattern is ValuePattern &&
             !((ValuePattern)pattern).Current.IsReadOnly,
         "QT_FILE_VALUE_READ_ONLY");
}
static object QtPasteUiaImage(QtClipboardOperation clipboard, Dictionary<string, object> request, IntPtr owner,
                              bool ordinaryFile = false)
{
    if (ordinaryFile)
        QtImageKeys(request, "token", "epoch", "revision", "idleMs", "headerRect", "editorRect", "sendRect",
                    "imagePath", "imageSha256", "deliveryId", "titleSha256", "allowClipboardReplacement");
    else
        QtImageKeys(request, "token", "epoch", "revision", "idleMs", "headerRect", "editorRect", "sendRect",
                    "imagePath", "imageSha256", "allowClipboardReplacement", "quoteToken", "stepBinding");
    Need(!QtImagePasteUnconfirmed && (QtPendingImage == null || QtPendingImage.Consumed), "QT_UIA_IMAGE_PENDING");
    var source = QtCurrent;
    var lease = QtFocus.Active;
    Need(source != null && source.MetadataOnly && QtUiaControlLeaseMatches(source, lease),
         "QT_UIA_IMAGE_SOURCE_REQUIRED");
    Rect header = ParseRect(Get(request, "headerRect")), editor = ParseRect(Get(request, "editorRect")),
         send = ParseRect(Get(request, "sendRect"));
    Need(Contains(source.Binding.Client, send) && send.Top >= editor.Top, "QT_UIA_IMAGE_SEND_REGION_INVALID");
    QtFileDialog dialog = null;
    if (ordinaryFile)
    {
        var roles = QtUiaResolveRoles(source.Binding, new[] { "editor", "send", "header" });
        QtFileRequireWritableEditor(roles["editor"]);
        Need(roles["editor"].Node.Element.Current.HasKeyboardFocus, "QT_FILE_DRAFT_PRESENT");
        dialog = QtPrepareFileDialog(source, request, roles["header"]);
    }
    var report = Map(QtPasteImage(clipboard, request, owner, true, ordinaryFile));
    if (ordinaryFile)
    {
        long deadline = Now() + 900;
        for (;;)
        {
            if (GetForegroundWindow() != source.Binding.Window)
            {
                QtCaptureFileDialog(dialog);
                report.Add("fileDialogProof", QtFileDialogProof(dialog));
                return report;
            }
            QtInputStable(source, false);
            if (QtInlineFileStaged(source.Binding, dialog.Name))
                break;
            Need(Now() < deadline, "QT_FILE_STAGING_UNCONFIRMED");
            Thread.Sleep(10);
        }
    }
    var captured = QtImageControlsAfterPaste(source, ref header, ref editor, ref send);
    var frame = QtCurrent;
    Need(Object.ReferenceEquals(lease, QtFocus.Active) && frame.MetadataOnly &&
             QtUiaControlLeaseMatches(frame, lease) && source.Binding.Thread == frame.Binding.Thread &&
             QtSameBinding(source.Binding, frame.Binding) && source.Revision == frame.Revision,
         "QT_UIA_IMAGE_BINDING_CHANGED");
    var proof = new QtImageProof { Id = Guid.NewGuid().ToString("N"),
                                   Epoch = QtEpoch,
                                   Digest = Text(request, "imageSha256"),
                                   QuoteToken = Text(request, "quoteToken"),
                                   Format = Text(report, "imageFormat"),
                                   Frame = frame,
                                   Lease = lease,
                                   Header = header,
                                   Editor = editor,
                                   Send = send,
                                   Issued = UtcMs() };
    if (ordinaryFile)
    {
        proof.FilePath = dialog.Path;
        proof.FileDelivery = dialog.Delivery;
    }
    QtPendingImage = proof;
    QtImagePasteUnconfirmed = false;
    report.Add("imagePasteProof", QtImageProofPacket(proof));
    report.Add("postPasteFrame", captured);
    return report;
}

sealed class QtFileDialog
{
    internal QtFrame Source;
    internal QtFocusLease Lease;
    internal QtUiaRole Header;
    internal readonly HashSet<IntPtr> Visible = new HashSet<IntPtr>();
    internal IntPtr Window;
    internal string Name, TitleDigest, TargetDigest, Digest, Id, ButtonId, Path, Delivery, Pixels;
    internal Rect Capture;
    internal long Issued;
}
static QtFileDialog QtPendingFileDialog;
static QtFileDialog QtPrepareFileDialog(QtFrame source, Dictionary<string, object> request, QtUiaRole header = null)
{
    string path = Text(request, "imagePath");
    var dialog =
        new QtFileDialog { Source = source,
                           Lease = QtFocus.Active,
                           Name = Path.GetFileName(path),
                           Digest = Text(request, "imageSha256"),
                           Path = path,
                           Delivery = Text(request, "deliveryId"),
                           Header = header,
                           TargetDigest = request.ContainsKey("titleSha256") ? Text(request, "titleSha256") : null };
    if (header != null)
    {
        var titles = new List<string>();
        dialog.TitleDigest = Text(QtFileConversation(header, source.Binding, titles), "sha256");
        Need(titles.Exists(label => QtFileHash(label) == dialog.TargetDigest), "QT_FILE_DIALOG_TARGET_CHANGED");
    }
    int count = 0;
    EnumWindows(delegate(IntPtr hwnd, IntPtr unused) {
        if (IsWindowVisible(hwnd))
            dialog.Visible.Add(hwnd);
        return ++count < 4096;
    }, IntPtr.Zero);
    Need(count < 4096, "QT_FILE_WINDOW_ENUMERATION_FAILED");
    return dialog;
}
static void QtCaptureFileDialog(QtFileDialog dialog)
{
    dialog.Window = GetForegroundWindow();
    QtGuardFileDialog(dialog);
    if (dialog.Header != null)
    {
        long deadline = Now() + 700;
        for (;;)
        {
            try
            {
                QtFileConfirmButton(dialog);
                break;
            }
            catch (Fault error)
            {
                if (error.Message != "QT_FILE_DIALOG_UNVERIFIED" || Now() >= deadline)
                    throw;
                Thread.Sleep(15);
            }
        }
    }
    dialog.Id = Guid.NewGuid().ToString("N");
    dialog.Issued = Now();
    QtPendingFileDialog = dialog;
    QtImagePasteUnconfirmed = false;
}
static object QtFileDialogProof(QtFileDialog dialog)
{
    return Data("id", dialog.Id, "sha256", dialog.Digest);
}
static bool QtInlineFileStaged(Binding binding, string name)
{
    var roles = QtUiaResolveRoles(binding, new[] { "editor", "send" });
    var editor = roles["editor"].Node.Element;
    object pattern;
    if (!roles["send"].Node.Element.Current.IsEnabled || !editor.TryGetCurrentPattern(TextPattern.Pattern, out pattern))
        return false;
    var content = ((TextPattern)pattern).DocumentRange;
    // The editor was empty immediately before WeChat consumed this single
    // file. Accept only one inline object or the expected file label.
    string text = content.GetText(512).Trim();
    var children = content.GetChildren();
    return text == "\ufffc" || text == name || text == "[文件]" + name ||
           children.Length == 1 && children[0].Current.Name == name;
}
static void QtGuardFileDialog(QtFileDialog dialog)
{
    var binding = dialog.Source.Binding;
    uint pid;
    Need(!Stopping && Object.ReferenceEquals(dialog.Lease, QtFocus.Active) &&
             Interlocked.Read(ref Revision) == dialog.Source.Revision,
         "QT_FILE_DIALOG_CHANGED");
    Desktop();
    NoKeysHeld();
    Need(GetForegroundWindow() == dialog.Window && IsWindowVisible(dialog.Window) &&
             !dialog.Visible.Contains(dialog.Window) && GetWindow(dialog.Window, 4) == binding.Window &&
             GetWindowThreadProcessId(dialog.Window, out pid) == binding.Thread && pid == binding.Pid &&
             QtUiaPointerRecipientSame(binding) && GetDpiForWindow(dialog.Window) == binding.Dpi,
         "QT_FILE_DIALOG_OWNER_CHANGED");
    Rect client;
    Point origin = new Point(0, 0);
    Need(GetClientRect(binding.Window, out client) && Same(client, binding.Client) &&
             ClientToScreen(binding.Window, ref origin) && origin.X == binding.Capture.Left &&
             origin.Y == binding.Capture.Top,
         "QT_FILE_DIALOG_OWNER_CHANGED");
}
static InvokePattern QtFileConfirmButton(QtFileDialog dialog)
{
    QtGuardFileDialog(dialog);
    Need(!String.IsNullOrEmpty(dialog.TargetDigest) &&
             (dialog.Header == null ||
              Text(QtFileConversation(dialog.Header, dialog.Source.Binding), "sha256") == dialog.TitleDigest),
         "QT_FILE_DIALOG_TARGET_CHANGED");
    var root = AutomationElement.FromHandle(dialog.Window);
    var walker = TreeWalker.RawViewWalker;
    bool file = false, target = false;
    int visited = 0;
    long deadline = Now() + 600;
    AutomationElement button = null;
    Action<AutomationElement, int> scan = null;
    scan = delegate(AutomationElement item, int depth)
    {
        Need(++visited <= 256 && depth <= 32 && Now() <= deadline, "QT_FILE_DIALOG_SCAN_LIMIT");
        var info = item.Current;
        Need(info.ProcessId == dialog.Source.Binding.Pid, "QT_FILE_DIALOG_OWNER_CHANGED");
        if (info.IsOffscreen)
            return;
        if (info.ControlType == ControlType.Text || info.ControlType == ControlType.ListItem)
        {
            string label = info.Name;
            if (label == dialog.Name)
                file = true;
            else if (!String.IsNullOrEmpty(label) && QtFileHash(label) == dialog.TargetDigest)
                target = true;
        }
        if (info.ControlType == ControlType.Button && QtUiaSendText(info.Name) && info.IsEnabled)
        {
            Need(button == null, "QT_FILE_DIALOG_AMBIGUOUS");
            button = item;
        }
        for (var child = walker.GetFirstChild(item); child != null; child = walker.GetNextSibling(child))
            scan(child, depth + 1);
    };
    scan(root, 0);
    Need(file && target && button != null, "QT_FILE_DIALOG_UNVERIFIED");
    string runtime = String.Join(",", button.GetRuntimeId());
    Need(dialog.ButtonId == null || dialog.ButtonId == runtime, "QT_FILE_DIALOG_CHANGED");
    dialog.ButtonId = runtime;
    object invoke;
    Need(button.TryGetCurrentPattern(InvokePattern.Pattern, out invoke) && invoke is InvokePattern,
         "QT_FILE_DIALOG_BUTTON_UNAVAILABLE");
    QtGuardFileDialog(dialog);
    return (InvokePattern)invoke;
}
static QtFileDialog QtFileDialogRequest(Dictionary<string, object> request)
{
    var dialog = QtPendingFileDialog;
    Need(QtEnableInput && dialog != null && dialog.Id == Text(request, "proofId") &&
             dialog.Digest == Text(request, "sha256") && Now() - dialog.Issued <= 30000,
         "QT_FILE_DIALOG_PROOF_INVALID");
    QtGuardFileDialog(dialog);
    return dialog;
}
static Rect QtOcrFileDialogArea(QtFileDialog dialog)
{
    QtGuardFileDialog(dialog);
    Rect client = default(Rect);
    Point origin = new Point(0, 0);
    Need(dialog.Header == null && GetClientRect(dialog.Window, out client) && ClientToScreen(dialog.Window, ref origin),
         "QT_FILE_DIALOG_UNVERIFIED");
    int inset = (int)Math.Ceiling(7 * dialog.Source.Binding.Dpi / 96.0);
    var bounds =
        new Rect(origin.X + inset, origin.Y + inset, origin.X + client.Width - inset, origin.Y + client.Height - inset);
    Need(bounds.Width >= 100 && bounds.Width <= 1400 && bounds.Height >= 80 && bounds.Height <= 1200 &&
             Contains(QtDesktopRect(), bounds) && FocusAreaOwned(bounds, dialog.Window, dialog.Source.Binding.Pid),
         "QT_FILE_DIALOG_UNVERIFIED");
    return bounds;
}
static object QtCaptureOcrFileDialog(Dictionary<string, object> request)
{
    QtImageKeys(request, "proofId", "sha256");
    var dialog = QtFileDialogRequest(request);
    var area = QtOcrFileDialogArea(dialog);
    string pixels = FocusPixels(area);
    using (var bitmap = new Bitmap(area.Width, area.Height, PixelFormat.Format32bppArgb)) using (var memory =
                                                                                                     new MemoryStream())
    {
        using (var graphics = Graphics.FromImage(bitmap))
            graphics.CopyFromScreen(area.Left, area.Top, 0, 0, bitmap.Size, CopyPixelOperation.SourceCopy);
        bitmap.Save(memory, ImageFormat.Png);
        byte[] bytes = memory.ToArray();
        Need(Same(area, QtOcrFileDialogArea(dialog)) && pixels == FocusPixels(area), "QT_FILE_DIALOG_CHANGED");
        string file = Path.Combine(QtFrames, "qt-" + Guid.NewGuid().ToString("N") + ".png");
        using (var output = new QtOwnedCaptureImage(file))
        {
            output.Write(bytes);
            dialog.Capture = area;
            dialog.Pixels = pixels;
            output.Transfer();
            return Data("width", area.Width, "height", area.Height, "image",
                        Data("file", file, "sha256", QtHash(bytes)));
        }
    }
}
static bool QtFileDialogButtonInside(Rect capture, Rect label)
{
    return Contains(new Rect(0, 0, capture.Width, capture.Height), label) && label.Width >= 4 && label.Height >= 4;
}
static void QtClickOcrFileDialog(QtFileDialog dialog, Rect label)
{
    var area = QtOcrFileDialogArea(dialog);
    Need(dialog.Pixels != null && Same(area, dialog.Capture) && QtFileDialogButtonInside(area, label) &&
             FocusPixels(area) == dialog.Pixels,
         "QT_FILE_DIALOG_CHANGED");
    Point point = QtOcrQuoteCenter(QtQuoteScreenRect(label, area));
    var events = ClickEvents(point.X, point.Y, QtDesktopRect());
    QtGuardFileDialog(dialog);
    Need(Owned(WindowFromPoint(point), dialog.Window, dialog.Source.Binding.Pid), "QT_FILE_DIALOG_OWNER_CHANGED");
    InputAttempted = true;
    QtCurrent = null;
    uint done = SendInput(3, events, Marshal.SizeOf(typeof(Input)));
    if (done == 2)
        SendInput(1, new[] { Mouse(0, 0, 4) }, Marshal.SizeOf(typeof(Input)));
    Need(done == 3, "QT_FILE_DIALOG_SUBMIT_UNCERTAIN");
    QtRememberPointer(point, dialog.Source.Revision);
}
static object QtSubmitFileDialog(Dictionary<string, object> request)
{
    QtImageKeys(request, "proofId", "sha256", "buttonRect");
    var dialog = QtFileDialogRequest(request);
    QtPendingFileDialog = null;
    using (QtOpenStagedFile(dialog.Path, dialog.Delivery, dialog.Digest))
    {
        if (dialog.Header == null)
            QtClickOcrFileDialog(dialog, ParseRect(Get(request, "buttonRect")));
        else
        {
            Need(!request.ContainsKey("buttonRect"), "QT_FILE_DIALOG_PROOF_INVALID");
            var invoke = QtFileConfirmButton(dialog);
            InputAttempted = true;
            invoke.Invoke();
        }
    }
    long deadline = Now() + 500;
    while (IsWindowVisible(dialog.Window) && Now() < deadline)
        Thread.Sleep(15);
    return Data("performed", true, "attempted", true, "inputQueued", true, "dialogClosed",
                !IsWindowVisible(dialog.Window), "revision", dialog.Source.Revision);
}
static object QtSubmitUiaImage(Dictionary<string, object> request)
{
    QtImageKeys(request, "token", "epoch", "revision", "idleMs", "imagePasteProofId", "imageSha256", "quoteToken",
                "stepBinding");
    var proof = QtPendingImage;
    var frame = QtCurrent;
    Need(!QtImagePasteUnconfirmed &&
             QtImageProofMatches(proof, Text(request, "imagePasteProofId"), Text(request, "imageSha256"), frame,
                                 QtFocus.Active, UtcMs(), false) &&
             Text(request, "quoteToken") == proof.QuoteToken,
         "QT_UIA_IMAGE_PROOF_INVALID");
    QtGuard(request, true, false);
    Need(frame.Anchors.Count == 3 && Same(frame.Anchors[0].Rect, proof.Header) &&
             Same(frame.Anchors[1].Rect, proof.Editor) && Same(frame.Anchors[2].Rect, proof.Send),
         "QT_UIA_IMAGE_PROOF_INVALID");
    QtUiaRole sendRole = null;
    foreach (var role in frame.UiaRoles)
        if (role.Role == "send")
            sendRole = role;
    Need(sendRole != null && Same(sendRole.Node.Rect, proof.Send), "QT_UIA_IMAGE_PROOF_INVALID");
    object delivery;
    using (var staged = proof.Format == "file" ? QtOpenStagedFile(proof.FilePath, proof.FileDelivery, proof.Digest)
                                               : null) delivery =
        QtUiaPointerClick(frame, sendRole, "image-submit", delegate {
            Need(Object.ReferenceEquals(proof, QtPendingImage) && !proof.Consumed, "QT_UIA_IMAGE_PROOF_INVALID");
            if (proof.Format != "file")
                QtVerifyQuote(request, frame);
            proof.Consumed = true;
            QtCurrent = null;
        });
    bool released = proof.Format == "static" && QtUiaStaticDraftCleared(frame, sendRole);
    return Data("performed", true, "attempted", true, "submitted", false, "inputQueued", true, "submissionConfirmed",
                false, "revision", frame.Revision, "pointerDelivery", delivery, "inputReleased", released);
}
static bool QtUiaStaticDraftCleared(QtFrame frame, QtUiaRole sendRole)
{
    var header = frame.UiaRoles.Find(role => role.Role == "header");
    long deadline = Now() + 350;
    try
    {
        do
        {
            QtUiaPointerAfterInput(frame);
            var roles = QtUiaResolveRoles(frame.Binding, new[] { "header", "editor", "send" });
            if (header == null || !QtUiaRoleObservationMatches(header, roles["header"].Node, true) ||
                !QtUiaRoleObservationMatches(sendRole, roles["send"].Node, false))
                return false;
            object pattern;
            var editor = roles["editor"].Node.Element;
            if (!roles["send"].Node.Element.Current.IsEnabled &&
                editor.TryGetCurrentPattern(TextPattern.Pattern, out pattern))
            {
                var document = ((TextPattern)pattern).DocumentRange;
                bool empty = document.GetChildren().Length == 0 && document.GetText(2).Trim().Length == 0;
                QtUiaPointerAfterInput(frame);
                if (empty)
                    return true;
            }
            Thread.Sleep(15);
        } while (Now() < deadline);
    }
    catch (Fault)
    {
        return false;
    }
    catch (ElementNotAvailableException)
    {
        return false;
    }
    catch (InvalidOperationException)
    {
        return false;
    }
    catch (COMException)
    {
        return false;
    }
    return false;
}
static object QtResumeUiaImage(Dictionary<string, object> request)
{
    QtImageKeys(request, "epoch", "revision", "idleMs", "imagePasteProofId", "imageSha256");
    var proof = QtPendingImage;
    Need(!QtImagePasteUnconfirmed && proof != null && Text(request, "epoch") == QtEpoch &&
             Number(Get(request, "revision")) == proof.Frame.Revision &&
             Interlocked.Read(ref Revision) == proof.Frame.Revision,
         "QT_UIA_IMAGE_PROOF_INVALID");
    QtUiaNavigationContext();
    Need(QtImageProofMatches(proof, Text(request, "imagePasteProofId"), Text(request, "imageSha256"), proof.Frame,
                             QtFocus.Active, UtcMs(), true),
         "QT_UIA_IMAGE_PROOF_INVALID");
    Binding actual = QtBound(false);
    Need(actual.Thread == proof.Frame.Binding.Thread && QtSameBinding(actual, proof.Frame.Binding),
         "QT_UIA_IMAGE_BINDING_CHANGED");
    long idle = Number(Get(request, "idleMs"));
    Need(idle >= 0 && idle <= 300000, "QT_IDLE_INVALID");
    QtRequireIdle(idle);
    var lease = QtFocus.Active;
    var captured = QtImageControls(proof.Header, proof.Editor, proof.Send);
    var frame = QtCurrent;
    Need(Object.ReferenceEquals(proof, QtPendingImage) && Object.ReferenceEquals(lease, QtFocus.Active) &&
             frame.Revision == proof.Frame.Revision && frame.Binding.Thread == proof.Frame.Binding.Thread &&
             QtSameBinding(frame.Binding, proof.Frame.Binding),
         "QT_UIA_IMAGE_BINDING_CHANGED");
    proof.Frame = frame;
    proof.Lease = lease;
    proof.Paused = false;
    return Data("resumed", true, "readOnly", true, "inputSent", false, "focusChanged", false, "clipboardAccessed",
                false, "imagePasteProof", QtImageProofPacket(proof), "frame", captured);
}
static int QtUiaImageProofSelfTest()
{
    int n = 0;
    var saved = QtPendingImage;
    var focus = new QtFocusSession.Fixture(QtFocus);
    long revision = Interlocked.Read(ref Revision);
    var binding = new Binding { Window = new IntPtr(42),
                                Pid = 7,
                                Thread = 8,
                                Created = 123,
                                Dpi = 96,
                                Client = new Rect(0, 0, 800, 600),
                                Capture = new Rect(10, 20, 810, 620),
                                Focus = new IntPtr(42) };
    var lease = new QtFocusLease { Wechat = binding.Identity, Revision = revision };
    var frame = new QtFrame { Binding = binding, Revision = revision, MetadataOnly = true, UiaControlFrame = true,
                              UiaControlLease = lease };
    var proof = new QtImageProof { Id = "fixture",    Epoch = QtEpoch, Digest = new string('a', 64),
                                   Format = "static", Frame = frame,   Lease = lease,
                                   Issued = 1000 };
    Need(QtImageProofMatches(proof, proof.Id, proof.Digest, frame, lease, 1000, false),
         "QT_TEST_IMAGE_OWN_NATIVE_PROOF");
    n++;
    foreach (int changed in new[] { 0, 1, 2, 3, 4, 5, 6, 7 })
    {
        string id = proof.Id, digest = proof.Digest;
        long now = 1000;
        QtFocusLease currentLease = lease;
        QtFrame current = frame;
        if (changed == 0)
            id = "other";
        if (changed == 1)
            digest = new string('b', 64);
        if (changed == 2)
            now = 999;
        if (changed == 3)
            now = 31001;
        if (changed == 4)
            currentLease = new QtFocusLease { Wechat = lease.Wechat, Revision = revision };
        if (changed == 5)
            proof.Consumed = true;
        if (changed == 6)
            proof.Paused = true;
        if (changed == 7)
            frame.MetadataOnly = false;
        Need(!QtImageProofMatches(proof, id, digest, current, currentLease, now, false),
             "QT_TEST_IMAGE_STALE_OR_FORGED_PROOF_REFUSED");
        n++;
        proof.Consumed = false;
        proof.Paused = false;
        frame.MetadataOnly = true;
    }
    try
    {
        QtPendingImage = proof;
        focus.Arrange(lease);
        QtImageActionBoundary("releaseFocusHandoff");
        Need(proof.Paused && !proof.Consumed, "QT_TEST_IMAGE_RELEASE_PAUSES_PROOF");
        n++;
        QtImageActionBoundary("inspectLayout");
        QtImageActionBoundary("beginFocusHandoff");
        Need(Object.ReferenceEquals(QtPendingImage, proof), "QT_TEST_IMAGE_RESUME_READONLY_BOUNDARY");
        n++;
        Need(QtImageProofMatches(proof, proof.Id, proof.Digest, frame, new QtFocusLease(), 1001, true),
             "QT_TEST_IMAGE_PAUSED_PROOF_NEEDS_SEPARATE_REBIND");
        n++;
        QtImageActionBoundary("paste");
        Need(QtPendingImage == null && proof.Consumed, "QT_TEST_IMAGE_OTHER_INPUT_REVOKES_PROOF");
        n++;
        foreach (string key in new[] { "uiaControlFrame", "uiaControlLease", "rect", "attachmentLoaded", "authorized" })
        {
            Expect(delegate { QtImageKeys(Data(key, true), "imagePasteProofId"); }, "QT_UIA_IMAGE_REQUEST_INVALID");
            n++;
        }
    }
    finally
    {
        QtPendingImage = saved;
        focus.Dispose();
    }
    return n;
}
static int QtImageSelfTest()
{
    int count = QtUiaImageProofSelfTest(), width, height;
    string folder = Path.Combine(Path.GetTempPath(), "wechat-image-selftest-" + Guid.NewGuid().ToString("N"));
    Directory.CreateDirectory(folder);
    try
    {
        byte[] readyPixels = new byte[400 * 4], neutralPixels = new byte[400 * 4];
        for (int i = 0; i < 400; i++)
        {
            readyPixels[i * 4] = 7;
            readyPixels[i * 4 + 1] = 193;
            readyPixels[i * 4 + 2] = 96;
            readyPixels[i * 4 + 3] = 255;
            neutralPixels[i * 4] = neutralPixels[i * 4 + 1] = neutralPixels[i * 4 + 2] = 48;
            neutralPixels[i * 4 + 3] = 255;
        }
        Need(QtOcrMediaGreen(readyPixels) && !QtOcrMediaNeutral(readyPixels) && QtOcrMediaNeutral(neutralPixels) &&
                 !QtOcrMediaGreen(neutralPixels),
             "QT_TEST_MEDIA_SEND_ENABLE_CONSUME_COLORS");
        count++;
        Need(!QtOcrMediaGreen(new byte[4 * 20]), "QT_TEST_MEDIA_SEND_MINIMUM_SUPPORT");
        var dialogArea = new Rect(40, 50, 340, 260);
        Need(QtFileDialogButtonInside(dialogArea, new Rect(150, 170, 230, 184)) &&
                 !QtFileDialogButtonInside(dialogArea, new Rect(290, 170, 301, 184)) &&
                 !QtFileDialogButtonInside(dialogArea, new Rect(150, 170, 150, 184)),
             "QT_TEST_FILE_DIALOG_BUTTON_BOUNDS");
        count++;
        foreach (uint format in new uint[] { 8, 13, 15 })
        {
            Need(QtImageRenderEligible(true, false, false, format, format, 42, 42),
                 "QT_TEST_IMAGE_RENDER_EXACT_TARGET_FORMAT");
            count++;
        }
        for (int changed = 0; changed < 7; changed++)
        {
            Need(!QtImageRenderEligible(changed != 0, changed == 1, changed == 2, changed == 3 ? 1u : 8u,
                                        changed == 4 ? 15u : 8u, changed == 5 ? 0u : 42u, changed == 6 ? 43u : 42u),
                 "QT_TEST_IMAGE_RENDER_REJECTS_FOREIGN_EARLY_REUSED");
            count++;
        }
        long clock = 0;
        int checks = 0, releases = 0, waits = 0;
        uint observed = QtImageConsumerCore(
            delegate {
                checks++;
                return true;
            },
            delegate {
                releases++;
                return 23u;
            },
            delegate {}, delegate { return clock; },
            delegate(int ms) {
                waits++;
                clock += ms;
            });
        Need(observed == 23 && checks == 1 && releases == 1 && waits == 0,
             "QT_TEST_IMAGE_RENDER_IMMEDIATE_NO_FIXED_WAIT");
        count++;
        clock = 0;
        checks = 0;
        releases = 0;
        observed = QtImageConsumerCore(delegate { return ++checks >= 3; },
                                       delegate { return ++releases >= 3 ? (uint?)24 : null; }, delegate {},
                                       delegate { return clock; }, delegate(int ms) { clock += ms; });
        Need(observed == 24 && clock == 12 && checks == 3 && releases == 3,
             "QT_TEST_IMAGE_RENDER_AND_RELEASE_INDEPENDENT");
        count++;
        clock = 0;
        Expect(delegate {
            QtImageConsumerCore(delegate { return false; },
                                delegate { throw new Exception("must not release before consumer"); }, delegate {},
                                delegate { return clock; }, delegate(int ms) { clock += ms; });
        }, "QT_IMAGE_CLIPBOARD_CONSUMPTION_UNCONFIRMED");
        count++;
        clock = 0;
        Expect(delegate {
            QtImageConsumerCore(delegate { return true; }, delegate { return null; }, delegate {},
                                delegate { return clock; }, delegate(int ms) { clock += ms; });
        }, "QT_IMAGE_CLIPBOARD_RELEASE_UNCONFIRMED");
        count++;
        clock = 0;
        Expect(delegate {
            QtImageConsumerCore(delegate { return false; }, delegate { return null; },
                                delegate {
                                    if (clock > 0)
                                        throw new Fault("DRAFT_CLIPBOARD_CHANGED");
                                },
                                delegate { return clock; }, delegate(int ms) { clock += ms; });
        }, "DRAFT_CLIPBOARD_CHANGED");
        count++;
        string png = Path.Combine(folder, "transparent.png"), jpeg = Path.Combine(folder, "photo.jpg"),
               bad = Path.Combine(folder, "bad.png");
        string stage = Path.Combine(folder, new string('a', 64)),
               longFile = Path.Combine(stage, new string('x', 176) + ".txt");
        Directory.CreateDirectory(stage);
        byte[] sample = { 42 };
        File.WriteAllBytes(QtLocalFilePath(longFile), sample);
        try
        {
            using (var held = QtOpenStagedFileInDirectory(longFile, stage, QtHash(sample)))
            {
                Need(held.Length == sample.Length && longFile.Length >= 260, "QT_TEST_LONG_STAGED_FILE");
                byte[] longDrop = QtFileDrop(longFile);
                Need(Encoding.Unicode.GetString(longDrop, 20, longDrop.Length - 20) == @"\\?\" + longFile + "\0\0",
                     "QT_TEST_LONG_DROP_NAME");
            }
        }
        finally
        {
            File.Delete(QtLocalFilePath(longFile));
        }
        count++;
        using (var bitmap = new Bitmap(3, 2, PixelFormat.Format32bppArgb))
        {
            using (var graphics = Graphics.FromImage(bitmap)) graphics.Clear(Color.Transparent);
            bitmap.Save(png, ImageFormat.Png);
            bitmap.Save(jpeg, ImageFormat.Jpeg);
        }
        byte[] bytes = File.ReadAllBytes(png), dib = QtImageDib(png, QtHash(bytes), out width, out height);
        Need(width == 3 && height == 2 && BitConverter.ToInt32(dib, 0) == 40 && BitConverter.ToInt16(dib, 14) == 24 &&
                 dib[40] == 255 && dib[41] == 255 && dib[42] == 255,
             "QT_TEST_IMAGE_DIB_ALPHA_WHITE");
        count++;
        QtImageDib(jpeg, QtHash(File.ReadAllBytes(jpeg)), out width, out height);
        Need(width == 3 && height == 2, "QT_TEST_IMAGE_JPEG");
        count++;
        Expect(delegate { QtImageDib(png, new string('0', 64), out width, out height); }, "QT_IMAGE_HASH_MISMATCH");
        count++;
        Expect(delegate { QtImageDib("relative.png", new string('0', 64), out width, out height); },
               "QT_IMAGE_PATH_INVALID");
        count++;
        byte[] animated = new byte[bytes.Length + 12];
        Array.Copy(bytes, 0, animated, 0, 33);
        animated[37] = 97;
        animated[38] = 99;
        animated[39] = 84;
        animated[40] = 76;
        Array.Copy(bytes, 33, animated, 45, bytes.Length - 33);
        File.WriteAllBytes(bad, animated);
        Expect(delegate { QtImageDib(bad, QtHash(animated), out width, out height); },
               "QT_IMAGE_ANIMATION_UNSUPPORTED");
        count++;
        byte[] invalid = (byte[])bytes.Clone();
        invalid[4] = 0;
        File.WriteAllBytes(bad, invalid);
        Expect(delegate { QtImageDib(bad, QtHash(invalid), out width, out height); }, "QT_IMAGE_FORMAT_UNSUPPORTED");
        count++;
        using (var large = new Bitmap(4097, 1))
        {
            large.Save(bad, ImageFormat.Png);
        }
        Expect(delegate { QtImageDib(bad, QtHash(File.ReadAllBytes(bad)), out width, out height); },
               "QT_IMAGE_DIMENSIONS_INVALID");
        count++;
        using (var large = new Bitmap(2001, 2000))
        {
            large.Save(bad, ImageFormat.Png);
        }
        Expect(delegate { QtImageDib(bad, QtHash(File.ReadAllBytes(bad)), out width, out height); },
               "QT_IMAGE_DIMENSIONS_INVALID");
        count++;
        byte[] gif = Convert.FromBase64String("R0lGODlhAQABAIAAAAAAAP///ywAAAAAAQABAAACAkQBADs=");
        int frames;
        string gifPath = Path.Combine(folder, "animation.gif");
        byte[] drop = QtGifFileDrop(gifPath, gif, out width, out height, out frames);
        Need(width == 1 && height == 1 && frames == 1 && BitConverter.ToInt32(drop, 0) == 20 &&
                 BitConverter.ToInt32(drop, 16) == 1 &&
                 System.Text.Encoding.Unicode.GetString(drop, 20, drop.Length - 20) == gifPath + "\0\0",
             "QT_TEST_GIF_FILE_DROP");
        count++;
        var two = new List<byte>();
        for (int i = 0; i < 19; i++)
            two.Add(gif[i]);
        for (int frame = 0; frame < 2; frame++)
        {
            two.AddRange(new byte[] { 0x21, 0xf9, 4, 0, 10, 0, 0, 0 });
            for (int i = 19; i < gif.Length - 1; i++)
                two.Add(gif[i]);
        }
        two.Add(0x3b);
        QtGifFileDrop(gifPath, two.ToArray(), out width, out height, out frames);
        Need(frames == 2, "QT_TEST_GIF_FRAMES_PRESERVED");
        count++;
        Expect(delegate { QtGifFileDrop(bad, gif, out width, out height, out frames); }, "QT_IMAGE_FORMAT_INVALID");
        count++;
        var truncated = (byte[])gif.Clone();
        truncated[truncated.Length - 1] = 0;
        Expect(delegate { QtGifFileDrop(gifPath, truncated, out width, out height, out frames); },
               "QT_IMAGE_FORMAT_INVALID");
        count++;
        var enormous = (byte[])gif.Clone();
        enormous[6] = 1;
        enormous[7] = 32;
        Expect(delegate { QtGifFileDrop(gifPath, enormous, out width, out height, out frames); },
               "QT_IMAGE_DIMENSIONS_INVALID");
        count++;
        var many = new List<byte>(gif);
        many.RemoveAt(many.Count - 1);
        for (int frame = 1; frame < 201; frame++)
            for (int i = 19; i < gif.Length - 1; i++)
                many.Add(gif[i]);
        many.Add(0x3b);
        Expect(delegate { QtGifFileDrop(gifPath, many.ToArray(), out width, out height, out frames); },
               "QT_IMAGE_ANIMATION_LIMIT");
        count++;
        return count;
    }
    finally
    {
        Need(Path.GetDirectoryName(Path.GetFullPath(folder))
                     .TrimEnd('\\')
                     .Equals(Path.GetFullPath(Path.GetTempPath()).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase) &&
                 Path.GetFileName(folder).StartsWith("wechat-image-selftest-", StringComparison.Ordinal),
             "QT_TEST_IMAGE_CLEANUP_PATH");
        Directory.Delete(folder, true);
    }
}
[DllImport("user32.dll")]
static extern bool IsClipboardFormatAvailable(uint format);
static uint QtConfirmOwnFileDrop(IntPtr owner, uint pid, byte[] expected)
{
    Need(OpenClipboard(owner), "DRAFT_CLIPBOARD_BUSY");
    uint sequence;
    try
    {
        Need(GetClipboardOwner() == owner && ClipboardOwnerPid() == pid && CountClipboardFormats() == 1 &&
                 IsClipboardFormatAvailable(15),
             "DRAFT_CLIPBOARD_CHANGED");
        byte[] actual = ClipboardBytes(15, 32768);
        Need(actual.Length >= expected.Length && actual.Length <= expected.Length + 16, "DRAFT_CLIPBOARD_CHANGED");
        for (int i = 0; i < expected.Length; i++)
            Need(actual[i] == expected[i], "DRAFT_CLIPBOARD_CHANGED");
        for (int i = expected.Length; i < actual.Length; i++)
            Need(actual[i] == 0, "DRAFT_CLIPBOARD_CHANGED");
        sequence = GetClipboardSequenceNumber();
    }
    finally
    {
        CloseClipboard();
    }
    Need(GetClipboardSequenceNumber() == sequence && GetClipboardOwner() == owner && ClipboardOwnerPid() == pid,
         "DRAFT_CLIPBOARD_CHANGED");
    return sequence;
}
static byte[] QtGifFileDrop(string full, byte[] bytes, out int width, out int height, out int frames)
{
    Need(bytes.Length >= 13 && (System.Text.Encoding.ASCII.GetString(bytes, 0, 6) == "GIF87a" ||
                                System.Text.Encoding.ASCII.GetString(bytes, 0, 6) == "GIF89a"),
         "QT_IMAGE_FORMAT_INVALID");
    Need(Path.GetExtension(full).Equals(".gif", StringComparison.OrdinalIgnoreCase), "QT_IMAGE_FORMAT_INVALID");
    // Bound dimensions and total frame canvases before asking GDI+ to
    // decode. The JS admission parser additionally verifies LZW contents.
    width = bytes[6] | bytes[7] << 8;
    height = bytes[8] | bytes[9] << 8;
    frames = 0;
    Need(width > 0 && height > 0 && width <= 4096 && height <= 4096 && (long)width * height <= 4000000,
         "QT_IMAGE_DIMENSIONS_INVALID");
    int offset = 13;
    QtGifSkip(bytes, ref offset, (bytes[10] & 128) != 0 ? 3 * (1 << ((bytes[10] & 7) + 1)) : 0);
    for (;;)
    {
        Need(offset < bytes.Length, "QT_IMAGE_FORMAT_INVALID");
        int marker = bytes[offset++];
        if (marker == 0x3b)
        {
            Need(offset == bytes.Length && frames > 0, "QT_IMAGE_FORMAT_INVALID");
            break;
        }
        if (marker == 0x21)
        {
            QtGifSkip(bytes, ref offset, 1);
            QtGifBlocks(bytes, ref offset);
            continue;
        }
        Need(marker == 0x2c, "QT_IMAGE_FORMAT_INVALID");
        int start = offset;
        QtGifSkip(bytes, ref offset, 9);
        int left = bytes[start] | bytes[start + 1] << 8, top = bytes[start + 2] | bytes[start + 3] << 8,
            w = bytes[start + 4] | bytes[start + 5] << 8, h = bytes[start + 6] | bytes[start + 7] << 8;
        Need(w > 0 && h > 0 && left + w <= width && top + h <= height, "QT_IMAGE_FORMAT_INVALID");
        frames++;
        Need(frames <= 200 && (long)width * height * frames <= 80000000, "QT_IMAGE_ANIMATION_LIMIT");
        QtGifSkip(bytes, ref offset, (bytes[start + 8] & 128) != 0 ? 3 * (1 << ((bytes[start + 8] & 7) + 1)) : 0);
        QtGifSkip(bytes, ref offset, 1);
        QtGifBlocks(bytes, ref offset);
    }
    using (var source = new MemoryStream(bytes)) using (var image = Image.FromStream(source, true, true))
    {
        Need(width == image.Width && height == image.Height && frames == image.GetFrameCount(FrameDimension.Time),
             "QT_IMAGE_FORMAT_INVALID");
    }
    // CF_HDROP contains a DROPFILES header followed by a double-null UTF-16
    // filename list. The original GIF reaches WeChat without rasterization.
    return QtFileDrop(full);
}
static string QtLocalFilePath(string full)
{
    return full.Length >= 248 && !full.StartsWith(@"\\?\", StringComparison.Ordinal) ? @"\\?\" + full : full;
}
static byte[] QtFileDrop(string full)
{
    byte[] names = System.Text.Encoding.Unicode.GetBytes(QtLocalFilePath(Path.GetFullPath(full)) + "\0\0");
    Need(names.Length <= 32748, "QT_IMAGE_PATH_INVALID");
    byte[] payload = new byte[20 + names.Length];
    Array.Copy(BitConverter.GetBytes(20), 0, payload, 0, 4);
    Array.Copy(BitConverter.GetBytes(1), 0, payload, 16, 4);
    Array.Copy(names, 0, payload, 20, names.Length);
    return payload;
}
static void QtGifSkip(byte[] bytes, ref int offset, int count)
{
    Need(count >= 0 && offset <= bytes.Length - count, "QT_IMAGE_FORMAT_INVALID");
    offset += count;
}
static void QtGifBlocks(byte[] bytes, ref int offset)
{
    for (;;)
    {
        Need(offset < bytes.Length, "QT_IMAGE_FORMAT_INVALID");
        int n = bytes[offset++];
        if (n == 0)
            return;
        QtGifSkip(bytes, ref offset, n);
    }
}
static uint QtConfirmOwnImage(IntPtr owner, uint pid, byte[] expected)
{
    for (int attempt = 0; attempt < 2; attempt++)
    {
        uint sequence;
        Need(OpenClipboard(owner), "DRAFT_CLIPBOARD_BUSY");
        try
        {
            Need(GetClipboardOwner() == owner && ClipboardOwnerPid() == pid, "DRAFT_CLIPBOARD_CHANGED");
            uint format = 0;
            int count = 0;
            while ((format = EnumClipboardFormats(format)) != 0)
            {
                Need(++count <= 3 && (format == 2 || format == 8 || format == 17), "DRAFT_CLIPBOARD_CHANGED");
            }
            byte[] actual = ClipboardBytes(8, 32 * 1024 * 1024);
            Need(actual.Length >= expected.Length && actual.Length <= expected.Length + 16, "DRAFT_CLIPBOARD_CHANGED");
            for (int i = 0; i < expected.Length; i++)
                Need(actual[i] == expected[i], "DRAFT_CLIPBOARD_CHANGED");
            for (int i = expected.Length; i < actual.Length; i++)
                Need(actual[i] == 0, "DRAFT_CLIPBOARD_CHANGED");
            sequence = GetClipboardSequenceNumber();
            Need(GetClipboardOwner() == owner && ClipboardOwnerPid() == pid, "DRAFT_CLIPBOARD_CHANGED");
        }
        finally
        {
            CloseClipboard();
        }
        if (GetClipboardSequenceNumber() == sequence && GetClipboardOwner() == owner && ClipboardOwnerPid() == pid)
            return sequence;
    }
    throw new Fault("DRAFT_CLIPBOARD_CHANGED");
}
static FileStream QtOpenStagedFile(string file, string delivery, string expected)
{
    Need(delivery != null && System.Text.RegularExpressions.Regex.IsMatch(delivery, @"\A[a-f0-9]{64}\z"),
         "QT_FILE_DELIVERY_INVALID");
    string directory =
        Path.GetFullPath(Path.Combine(AppDomain.CurrentDomain.BaseDirectory, @"..\files\outgoing", delivery));
    return QtOpenStagedFileInDirectory(file, directory, expected);
}
static FileStream QtOpenStagedFileInDirectory(string file, string directory, string expected)
{
    Need(Path.IsPathRooted(file) &&
             String.Equals(Path.GetDirectoryName(Path.GetFullPath(file)), directory,
                           StringComparison.OrdinalIgnoreCase) &&
             file.IndexOf(':', 2) < 0,
         "QT_FILE_PATH_INVALID");
    for (string at = Path.GetFullPath(file); at != null; at = Path.GetDirectoryName(at))
        Need((File.GetAttributes(QtLocalFilePath(at)) & FileAttributes.ReparsePoint) == 0, "QT_FILE_LINK_REFUSED");
    var input = new FileStream(QtLocalFilePath(Path.GetFullPath(file)), FileMode.Open, FileAccess.Read, FileShare.Read);
    try
    {
        Need(input.Length <= 50L * 1024 * 1024, "QT_FILE_SIZE_INVALID");
        using (var sha = System.Security.Cryptography.SHA256.Create())
            Need(BitConverter.ToString(sha.ComputeHash(input)).Replace("-", "").ToLowerInvariant() == expected,
                 "QT_FILE_HASH_MISMATCH");
        return input;
    }
    catch
    {
        input.Dispose();
        throw;
    }
}
static byte[] QtReadImageBytes(string path, string expected)
{
    Need(!String.IsNullOrEmpty(path) && Path.IsPathRooted(path) && !path.StartsWith(@"\\"), "QT_IMAGE_PATH_INVALID");
    string full = Path.GetFullPath(path);
    for (string at = full; !String.IsNullOrEmpty(at); at = Path.GetDirectoryName(at))
    {
        Need((File.GetAttributes(QtLocalFilePath(at)) & FileAttributes.ReparsePoint) == 0, "QT_IMAGE_LINK_REFUSED");
        if (Path.GetDirectoryName(at) == at)
            break;
    }
    byte[] bytes;
    using (var input = new FileStream(QtLocalFilePath(full), FileMode.Open, FileAccess.Read, FileShare.Read))
    {
        Need(input.Length > 0 && input.Length <= 20 * 1024 * 1024, "QT_IMAGE_SIZE_INVALID");
        bytes = new byte[(int)input.Length];
        int offset = 0;
        while (offset < bytes.Length)
        {
            int got = input.Read(bytes, offset, bytes.Length - offset);
            Need(got > 0, "QT_IMAGE_READ_FAILED");
            offset += got;
        }
    }
    Need(expected != null && expected.Length == 64 && QtHash(bytes) == expected, "QT_IMAGE_HASH_MISMATCH");
    return bytes;
}
static byte[] QtImageDib(string path, string expected, out int width, out int height)
{
    byte[] bytes = QtReadImageBytes(path, expected);
    bool png = bytes.Length > 8 && bytes[0] == 137 && bytes[1] == 80 && bytes[2] == 78 && bytes[3] == 71 &&
               bytes[4] == 13 && bytes[5] == 10 && bytes[6] == 26 && bytes[7] == 10;
    bool jpeg = bytes.Length > 3 && bytes[0] == 255 && bytes[1] == 216 && bytes[2] == 255;
    Need(png || jpeg, "QT_IMAGE_FORMAT_UNSUPPORTED");
    // APNG is not a static PNG. Never silently drop animation frames.
    if (png)
    {
        int offset = 8;
        while (offset + 12 <= bytes.Length)
        {
            long n = ((long)bytes[offset] << 24) | ((long)bytes[offset + 1] << 16) | ((long)bytes[offset + 2] << 8) |
                     bytes[offset + 3];
            Need(n >= 0 && n <= bytes.Length - offset - 12, "QT_IMAGE_FORMAT_INVALID");
            Need(!(bytes[offset + 4] == 97 && bytes[offset + 5] == 99 && bytes[offset + 6] == 84 &&
                   bytes[offset + 7] == 76),
                 "QT_IMAGE_ANIMATION_UNSUPPORTED");
            offset += (int)n + 12;
        }
    }
    using (var source = new MemoryStream(bytes)) using (var image = Image.FromStream(source, true, true))
    {
        width = image.Width;
        height = image.Height;
        Need(width > 0 && height > 0 && width <= 4096 && height <= 4096 && (long)width * height <= 4000000,
             "QT_IMAGE_DIMENSIONS_INVALID");
        using (var bitmap = new Bitmap(width, height, PixelFormat.Format24bppRgb))
        {
            using (var graphics = Graphics.FromImage(bitmap))
            {
                graphics.Clear(Color.White);
                graphics.DrawImage(image, 0, 0, width, height);
            }
            using (var buffer = new MemoryStream())
            {
                bitmap.Save(buffer, ImageFormat.Bmp);
                byte[] bmp = buffer.ToArray();
                Need(bmp.Length > 54 && bmp[0] == 66 && bmp[1] == 77, "QT_IMAGE_DIB_INVALID");
                byte[] dib = new byte[bmp.Length - 14];
                Array.Copy(bmp, 14, dib, 0, dib.Length);
                return dib;
            }
        }
    }
}
static bool QtOcrMediaGreen(byte[] pixels)
{
    int green = 0;
    for (int at = 0; at < pixels.Length; at += 4)
    {
        int r = pixels[at], g = pixels[at + 1], b = pixels[at + 2];
        if (g > 110 && g - r > 35 && g - b > 15)
            green++;
    }
    return green >= 30 && green > pixels.Length / 4 * .2;
}
static bool QtOcrMediaNeutral(byte[] pixels)
{
    int neutral = 0;
    for (int at = 0; at < pixels.Length; at += 4)
    {
        int r = pixels[at], g = pixels[at + 1], b = pixels[at + 2];
        if (Math.Max(r, Math.Max(g, b)) - Math.Min(r, Math.Min(g, b)) <= 12)
            neutral++;
    }
    return !QtOcrMediaGreen(pixels) && neutral > pixels.Length / 4 * .85;
}
static void QtWaitOcrMediaSend(QtFrame frame, Rect send, bool ready, QtFileDialog dialog = null)
{
    Need(!frame.MetadataOnly && Contains(frame.Binding.Client, send) && frame.Anchors.Count >= 1,
         "QT_MEDIA_SEND_REGION_INVALID");
    long deadline = Now() + 1500;
    for (;;)
    {
        if (dialog != null && GetForegroundWindow() != frame.Binding.Window)
        {
            QtCaptureFileDialog(dialog);
            return;
        }
        try
        {
            QtStable(frame);
            var header = frame.Anchors[0];
            QtNeedAnchorPixels(header.Hash, QtHash(QtPixels(frame.Binding, header.Rect)), "media-header", 0);
            byte[] pixels = QtPixels(frame.Binding, send);
            if (ready ? QtOcrMediaGreen(pixels) : QtOcrMediaNeutral(pixels))
                return;
        }
        catch (Fault)
        {
            if (dialog == null || GetForegroundWindow() == frame.Binding.Window)
                throw;
            QtCaptureFileDialog(dialog);
            return;
        }
        Need(Now() < deadline, ready ? "QT_MEDIA_IMPORT_UNCONFIRMED" : "QT_MEDIA_SUBMIT_UNCONFIRMED");
        Thread.Sleep(5);
    }
}
static object QtSubmitOcrMedia(Dictionary<string, object> request)
{
    var frame = QtGuard(request, true, false);
    Rect send = ParseRect(Get(request, "rect"));
    QtWaitOcrMediaSend(frame, send, true);
    QtVerifyQuote(request, frame);
    var report = Map(QtAct(request, "click"));
    QtWaitOcrMediaSend(frame, send, false);
    report.Add("controlConsumed", true);
    return report;
}
static object QtPasteImage(QtClipboardOperation clipboard, Dictionary<string, object> request, IntPtr owner,
                           bool uia = false, bool ordinaryFile = false)
{
    QtImagePasteTrace trace = uia ? new QtImagePasteTrace() : null;
    try
    {
        string file = Text(request, "imagePath"), expected = Text(request, "imageSha256");
        using (var staged = ordinaryFile ? QtOpenStagedFile(file, Text(request, "deliveryId"), expected) : null)
        {
            byte[] source = ordinaryFile ? new byte[0] : QtReadImageBytes(file, expected);
            bool gif = source.Length >= 6 && source[0] == 71 && source[1] == 73 && source[2] == 70;
            int width = 0, height = 0, frames = 1;
            byte[] dib = ordinaryFile ? QtFileDrop(file)
                         : gif        ? QtGifFileDrop(file, source, out width, out height, out frames)
                                      : QtImageDib(file, expected, out width, out height);
            uint format = ordinaryFile || gif ? 15u : 8u;
            if (trace != null)
            {
                trace.Format = format;
                trace.Stage = "frame";
            }
            QtRevokeEnter();
            QtEmptyPhaseProof = null;
            QtRevokeQueryClick(QtPopup);
            clipboard.ObserveRestore(true);
            QtFrame frame = QtGuard(request, true, false);
            if (!ordinaryFile)
                QtVerifyQuote(request, frame);
            Need(frame.MetadataOnly == uia && (!uia || QtUiaControlLeaseMatches(frame, QtFocus.Active)),
                 "QT_UIA_IMAGE_SOURCE_REQUIRED");
            Need(QtSurface == "main" && QtFastPasteAuthorized(QtFocus.Active != null, QtForegroundPasteOnly(request),
                                                              QtFocus.Parked != null, frame.Binding, QtRoot.Window,
                                                              QtRoot.Pid, QtRoot.Created, QtSurface),
                 "QT_FOCUS_LEASE_REQUIRED");
            QtNeedTextAnchors(frame, ParseRect(Get(request, "headerRect")), ParseRect(Get(request, "editorRect")));
            var dialog = !uia && ordinaryFile ? QtPrepareFileDialog(frame, request) : null;
            if (trace != null)
                trace.Stage = "original";
            ClipboardState original = QtReadOriginalClipboard(owner, false, QtAllowClipboardReplacement(request));
            uint owned = original.Sequence, ownerPid = GetCurrentProcessId();
            bool changed = false, published = false, restored = false, entered = false;
            QtImageRenderOwner renderer = null;
            object consumption = null;
            string consumptionFailure = null;
            IntPtr handle = GlobalAlloc(0x42, new UIntPtr((uint)dib.Length));
            Need(handle != IntPtr.Zero, "QT_IMAGE_CLIPBOARD_FAILED");
            try
            {
                IntPtr memory = GlobalLock(handle);
                Need(memory != IntPtr.Zero, "QT_IMAGE_CLIPBOARD_FAILED");
                try
                {
                    Marshal.Copy(dib, 0, memory, dib.Length);
                }
                finally
                {
                    GlobalUnlock(handle);
                }
                renderer = new QtImageRenderOwner(owner, handle, format, frame);
                handle = IntPtr.Zero;
                renderer.Attach();
                if (trace != null)
                    trace.Mark("before-publish", owner);
                QtInputStable(frame, false);
                Need(OpenClipboard(owner), "DRAFT_CLIPBOARD_BUSY");
                try
                {
                    Need(QtOriginalClipboardStillCurrent(original), "DRAFT_CLIPBOARD_CHANGED");
                    Need(EmptyClipboard(), "QT_IMAGE_CLIPBOARD_FAILED");
                    changed = true;
                    owned = GetClipboardSequenceNumber();
                    clipboard.ObserveRestore(false);
                    SetClipboardData(format, IntPtr.Zero);
                    Need(IsClipboardFormatAvailable(format) && GetClipboardOwner() == owner,
                         "QT_IMAGE_CLIPBOARD_FAILED");
                    owned = GetClipboardSequenceNumber();
                    lock (renderer.Sync)
                    {
                        renderer.PublishedSequence = owned;
                    }
                    published = true;
                    if (trace != null)
                        trace.Mark("published", owner, true);
                }
                finally
                {
                    CloseClipboard();
                }
                if (trace != null)
                    trace.Mark("closed", owner);
                // Reading delayed data here would consume our own offer and erase
                // the only evidence that the actual WeChat process requested it.
                owned = QtConfirmDelayedImageOffer(renderer, owner, ownerPid);
                QtInputStable(frame);
                if (trace != null)
                    trace.Mark("before-input", owner);
                Need(GetClipboardSequenceNumber() == owned && ClipboardOwnerPid() == ownerPid,
                     "DRAFT_CLIPBOARD_CHANGED");
                QtCurrent = null;
                entered = true;
                if (uia)
                    QtImagePasteUnconfirmed = true;
                renderer.Arm();
                SendEvents(QtPasteChord());
            }
            catch (Exception error)
            {
                if (trace != null)
                    trace.OperationFailure = error is Fault ? error.Message : "QT_OPERATION_FAILED";
                throw;
            }
            finally
            {
                try
                {
                    if (entered)
                    {
                        if (trace != null)
                            trace.Mark("consumer", owner);
                        try
                        {
                            owned = QtWaitImageClipboardConsumer(renderer, owner, ownerPid);
                            owned = format == 15 ? QtConfirmOwnFileDrop(owner, ownerPid, dib)
                                                 : QtConfirmOwnImage(owner, ownerPid, dib);
                            consumption = Data("version", 1, "method", "target-delayed-render-v1", "format", format,
                                               "consumerProcessMatched", true, "clipboardReleased", true, "elapsedMs",
                                               Math.Max(0, Now() - renderer.Started));
                        }
                        catch (Exception error)
                        {
                            consumptionFailure =
                                error is Fault ? error.Message : "QT_IMAGE_CLIPBOARD_CONSUMPTION_UNCONFIRMED";
                            owned = QtImageCleanupSequence(renderer, owner, ownerPid, owned,
                                                           QtKeepPublishedPaste(original, false));
                        }
                    }
                    else if (published && QtKeepPublishedPaste(original, false))
                        owned = QtImageCleanupSequence(renderer, owner, ownerPid, owned, true);
                    if (handle != IntPtr.Zero)
                    {
                        GlobalFree(handle);
                        handle = IntPtr.Zero;
                    }
                    if (trace != null)
                        trace.Mark("restore", owner);
                    restored = QtFinishPasteClipboard(clipboard, owner, original, changed, published, owned, ownerPid);
                    if (consumptionFailure != null)
                        throw new Fault(consumptionFailure);
                }
                catch (Exception error)
                {
                    if (trace != null)
                        trace.CleanupFailure = error is Fault ? error.Message : "QT_OPERATION_FAILED";
                    throw;
                }
                finally
                {
                    if (renderer != null)
                        renderer.Dispose();
                    if (handle != IntPtr.Zero)
                        GlobalFree(handle);
                }
            }
            if (!uia)
                QtWaitOcrMediaSend(frame, ParseRect(Get(request, "sendRect")), true, dialog);
            var report = Data("performed", true, "attempted", true, "pasteApplied", true, "imageWidth", width,
                              "imageHeight", height, "imageFormat",
                              ordinaryFile ? "file"
                              : gif        ? "gif"
                                           : "static",
                              "imageFrames", frames, "originalFilePasted", ordinaryFile || gif, "clipboardRestored",
                              restored, "readbackPerformed", false, "messageSent", false, "revision", frame.Revision);
            if (clipboard.Replaced)
                report.Add("clipboardReplaced", true);
            if (consumption != null)
                report.Add("imageConsumption", consumption);
            if (dialog != null && dialog.Id != null)
                report.Add("fileDialogProof", QtFileDialogProof(dialog));
            return report;
        }
    }
    catch (Exception error)
    {
        if (trace != null)
            error.Data["QtImageClipboard"] = trace.Report();
        throw;
    }
}
}
