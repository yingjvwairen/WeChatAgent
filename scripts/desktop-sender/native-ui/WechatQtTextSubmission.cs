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
using System.Windows.Forms;
using System.Xml;

internal static partial class WechatDraftProbe
{
    sealed class QtTextStepBinding
    {
        internal string Delivery, Account, Target;
    }
    sealed class QtEnterProof
    {
        internal string Id, Kind, Digest, Epoch;
        internal QtFrame Frame;
        internal QtPopupLease Popup;
        internal QtTextStepBinding Step;
        internal bool Consumed, Paused, InputOnly;
    }
    static QtEnterProof QtPendingEnter;
    static void QtRevokeEnter()
    {
        if (QtPendingEnter != null)
            QtPendingEnter.Consumed = true;
        QtPendingEnter = null;
    }
    static void QtRequireCurrentEnterProof(QtEnterProof proof)
    {
        Need(Object.ReferenceEquals(QtPendingEnter, proof) && !proof.Consumed, "QT_TEXT_STEP_REVOKED");
        Need(!proof.Paused, "QT_TEXT_STEP_CHANGED");
    }
    static void QtPublishEnterProof(QtEnterProof proof, QtEnterProof expected = null)
    {
        if (expected != null)
        {
            QtRequireCurrentEnterProof(expected);
            Need(proof.Id == expected.Id && proof.Kind == expected.Kind && proof.Digest == expected.Digest &&
                     proof.Epoch == expected.Epoch && QtSameTextStep(proof.Step, expected.Step),
                 "QT_TEXT_STEP_CHANGED");
        }
        QtRevokeEnter();
        QtPendingEnter = proof;
    }
    static void QtPauseTextEnter()
    {
        if (QtPendingEnter != null && QtPendingEnter.Kind == "text" && QtPendingEnter.Step != null &&
            !QtPendingEnter.Consumed)
            QtPendingEnter.Paused = true;
        else
            QtRevokeEnter();
    }
    static QtTextStepBinding QtParseTextStep(object value)
    {
        if (value == null)
            return null;
        var map = Map(value);
        Need(map != null && map.Count == 4 && Number(Get(map, "version")) == 1, "QT_TEXT_STEP_INVALID");
        string delivery = Text(map, "deliveryId"), account = Text(map, "accountSha256"),
               target = Text(map, "targetSha256");
        Need(delivery != null && account != null && target != null &&
                 System.Text.RegularExpressions.Regex.IsMatch(delivery, "\\A[a-f0-9]{64}\\z") &&
                 System.Text.RegularExpressions.Regex.IsMatch(account, "\\A[a-f0-9]{64}\\z") &&
                 System.Text.RegularExpressions.Regex.IsMatch(target, "\\A[a-f0-9]{64}\\z"),
             "QT_TEXT_STEP_INVALID");
        return new QtTextStepBinding { Delivery = delivery, Account = account, Target = target };
    }
    static bool QtSameTextStep(QtTextStepBinding a, QtTextStepBinding b)
    {
        return a == null ? b == null
                         : b != null && a.Delivery == b.Delivery && a.Account == b.Account && a.Target == b.Target;
    }
    static void QtFinishEnterAttempt(QtEnterProof proof, bool retain, bool attempted)
    {
        if (proof != null)
        {
            if (retain && !attempted)
            {
                proof.Paused = true;
                QtPendingEnter = proof;
            }
            else
                proof.Consumed = true;
        }
    }
    static void QtNeedTextAnchors(QtFrame frame, Rect header, Rect editor)
    {
        Need(QtSurface == "main" && QtPopup == null && QtPendingPopup == null && frame.Anchors.Count == 2 &&
                 Same(frame.Anchors[0].Rect, header) && Same(frame.Anchors[1].Rect, editor) &&
                 Contains(frame.Binding.Client, header) && Contains(frame.Binding.Client, editor) &&
                 header.Bottom <= editor.Top,
             "QT_TEXT_ENTER_ANCHORS_REQUIRED");
    }
    static void QtNeedDraftSource(QtFrame frame, Rect header, Rect editor)
    {
        Need(QtSurface == "main" && QtPopup == null && QtPendingPopup == null &&
                 (frame.Anchors.Count == 1 || frame.Anchors.Count == 2) && Same(frame.Anchors[0].Rect, header) &&
                 (frame.Anchors.Count == 1 || Same(frame.Anchors[1].Rect, editor)) &&
                 Contains(frame.Binding.Client, header) && Contains(frame.Binding.Client, editor) &&
                 header.Bottom <= editor.Top,
             "QT_TEXT_ENTER_ANCHORS_REQUIRED");
    }
    // A one-use continuation binds either a completed readback or the explicit
    // unchecked paste intent. Neither permits repeating an attempted Enter.
    static void QtAttachEnterProof(Dictionary<string, object> report, string kind, string text, QtFrame source,
                                   List<QtAnchor> anchors, QtTextStepBinding step = null, bool inputOnly = false,
                                   QtEnterProof readbackProof = null)
    {
        QtCheckUiaControlLease(source);
        bool uiaHeader = QtUiaInputHeader(source, kind, inputOnly, QtFocus.Active);
        var savedPopup = QtPopup;
        var regions = new List<object>();
        foreach (var anchor in anchors)
            regions.Add(anchor.Rect.Report());
        var request = Data("surface", kind == "search" ? "observed-search" : "main", "regions", regions.ToArray(),
                           "image", false);
        if (kind == "search")
            request.Add("surfaceId", "search");
        var captured = source.MetadataOnly ? QtCaptureUiaControls(request, kind == "search" ? "search" : "control")
                                           : Map(QtCapture(request, !inputOnly));
        var current = QtCurrent;
        Need(current != null && current.Revision == source.Revision && QtSameBinding(current.Binding, source.Binding) &&
                 current.Binding.Thread == source.Binding.Thread && Object.ReferenceEquals(savedPopup, QtPopup),
             "QT_OBSERVATION_CHANGED");
        QtCheckUiaControlLease(source);
        if (kind == "text")
            Need(QtAttachTextHeaderMatches(source, current, inputOnly, QtFocus.Active), "QT_TEXT_ENTER_HEADER_CHANGED");
        if (uiaHeader)
            QtMarkUiaControlFrame(current, source.UiaControlLease, captured);
        var proof = new QtEnterProof { Id = readbackProof == null ? Guid.NewGuid().ToString("N") : readbackProof.Id,
                                       Kind = kind,
                                       Digest = QtHash(Encoding.UTF8.GetBytes(text)),
                                       Epoch = QtEpoch,
                                       Frame = current,
                                       Popup = QtPopup,
                                       Step = kind == "text" ? step : null,
                                       InputOnly = inputOnly };
        if (readbackProof != null)
            QtStable(current);
        QtPublishEnterProof(proof, readbackProof);
        report.Add("postPasteFrame", captured);
        report.Add(kind == "search" ? "searchEnterProof" : "textEnterProof",
                   Data("version", 1, "id", proof.Id, kind == "search" ? "querySha256" : "textSha256", proof.Digest));
    }
    static bool QtEnterCaret(Binding actual, Rect area, int? popupTop)
    {
        Rect caret = actual.CaretInClient;
        return actual.FocusOwned && actual.CaretOwned && actual.Focus == actual.Window &&
               actual.Caret == actual.Window && (actual.GuiFlags & 0x1f) == 1 && caret.Width > 0 && caret.Height > 0 &&
               Contains(area, caret) && (!popupTop.HasValue || caret.Bottom <= popupTop.Value);
    }
    static bool QtExplicitNoCaret(Binding value)
    {
        return value.Caret == IntPtr.Zero && !value.CaretOwned && value.GuiFlags == 0 &&
               Same(value.CaretInClient, new Rect(0, 0, 0, 0));
    }
    static bool QtTextEditorCaret(Binding value, Rect editor)
    {
        return value.CaretOwned && value.Caret == value.Window && (value.GuiFlags == 0 || value.GuiFlags == 1) &&
               value.CaretInClient.Width > 0 && value.CaretInClient.Height > 0 && Contains(editor, value.CaretInClient);
    }
    static bool QtTextEnterFocus(Binding source, Binding current, Rect editor)
    {
        if (source == null || current == null || source.Thread != current.Thread || !QtSameBinding(source, current) ||
            !source.FocusOwned || source.Focus != source.Window || !current.FocusOwned ||
            current.Focus != current.Window)
            return false;
        // GUI_CARETBLINKING describes visibility, not keyboard focus. Only the
        // immediately preceding full editor copy/readback proof permits this
        // path. An absent caret is accepted only as the same complete zero
        // tuple before/after; a visible query/foreign caret remains a refusal.
        if (!QtTextEditorCaret(source, editor) && !QtExplicitNoCaret(source))
            return false;
        return QtTextEditorCaret(current, editor) || QtExplicitNoCaret(source) && QtExplicitNoCaret(current);
    }
    static object QtEnterFocusSnapshot(Binding value, Rect area)
    {
        return Data(
            "focusOwned", value.FocusOwned, "focusIsRoot", value.Focus == value.Window, "caretOwned", value.CaretOwned,
            "caretIsRoot", value.Caret == value.Window, "caretAbsent", value.Caret == IntPtr.Zero, "caretRectEmpty",
            Same(value.CaretInClient, new Rect(0, 0, 0, 0)), "caretInside",
            value.CaretInClient.Width > 0 && value.CaretInClient.Height > 0 && Contains(area, value.CaretInClient),
            "guiFlags", value.GuiFlags);
    }
    static Exception QtEnterFocusRefusal(string kind, Binding source, Binding current, Rect area)
    {
        var error = new Fault("QT_ENTER_FOCUS_UNVERIFIED");
        error.Data["QtEnterFocus"] =
            Data("version", 1, "kind", kind, "proofVerified", true, "sameBinding", QtSameBinding(source, current),
                 "sameThread", source.Thread == current.Thread, "source", QtEnterFocusSnapshot(source, area), "current",
                 QtEnterFocusSnapshot(current, area));
        return error;
    }
    static object QtEnterFocusFailure(Exception error)
    {
        return error.Data.Contains("QtEnterFocus") ? error.Data["QtEnterFocus"] : null;
    }
    static bool QtEnterProofMatches(QtEnterProof proof, string kind, string proofId, string digest, QtFrame frame,
                                    long now)
    {
        if (proof == null || proof.Consumed || proof.Paused || proof.Kind != kind || proof.Id != proofId ||
            proof.Digest != digest || proof.Epoch != QtEpoch || proof.Frame == null || frame == null ||
            frame.Revision != proof.Frame.Revision || now < proof.Frame.Issued || now - proof.Frame.Issued > 30000 ||
            frame.Binding.Thread != proof.Frame.Binding.Thread || !QtSameBinding(frame.Binding, proof.Frame.Binding) ||
            frame.Anchors.Count != proof.Frame.Anchors.Count)
            return false;
        if ((proof.Frame.UiaControlFrame || frame.UiaControlFrame) &&
            (!proof.InputOnly || kind != "text" || !QtUiaControlLeaseMatches(proof.Frame, QtFocus.Active) ||
             !QtUiaControlLeaseMatches(frame, QtFocus.Active)))
            return false;
        for (int i = 0; i < frame.Anchors.Count; i++)
            if (!Same(frame.Anchors[i].Rect, proof.Frame.Anchors[i].Rect) ||
                !proof.InputOnly && frame.Anchors[i].Hash != proof.Frame.Anchors[i].Hash)
                return false;
        if (kind == "search")
            return QtSurface == "observed-search" && Object.ReferenceEquals(proof.Popup, QtPopup) &&
                   frame.PopupBounds.HasValue && proof.Frame.PopupBounds.HasValue && frame.PopupClient.HasValue &&
                   proof.Frame.PopupClient.HasValue &&
                   (proof.InputOnly || Same(frame.PopupBounds.Value, proof.Frame.PopupBounds.Value) &&
                                           Same(frame.PopupClient.Value, proof.Frame.PopupClient.Value)) &&
                   QtSearchPasteCompletionScope("search", QtSurface, frame, QtPopup);
        return kind == "text" && QtSurface == "main" && proof.Popup == null && QtPopup == null &&
               QtPendingPopup == null && frame.Anchors.Count == 2;
    }
    static object QtDedicatedEnter(Dictionary<string, object> request, string kind)
    {
        var proof = QtPendingEnter;
        QtEmptyPhaseProof = null;
        QtRevokeQueryClick(QtPopup);
        bool retain = false;
        try
        {
            var step = QtParseTextStep(Get(request, "stepBinding"));
            Need(kind != "text" || proof != null && !proof.Consumed, "QT_TEXT_STEP_UNAVAILABLE");
            Need(kind != "text" || proof != null && QtSameTextStep(proof.Step, step), "QT_TEXT_STEP_CHANGED");
            retain = kind == "text" && proof != null && proof.Step != null && !proof.Consumed &&
                     proof.Id == Text(request, "textEnterProofId") && proof.Digest == Text(request, "textSha256") &&
                     proof.Epoch == QtEpoch;
            QtFrame frame = QtGuard(request, true, proof == null || !proof.InputOnly);
            string digest = Text(request, kind == "search" ? "querySha256" : "textSha256"),
                   proofId = Text(request, kind == "search" ? "searchEnterProofId" : "textEnterProofId");
            Need(QtEnterProofMatches(proof, kind, proofId, digest, frame, UtcMs()), "QT_ENTER_PROOF_INVALID");
            Rect area = frame.Anchors[kind == "search" ? 0 : 1].Rect;
            if (kind == "text")
            {
                QtNeedTextAnchors(frame, ParseRect(Get(request, "headerRect")), ParseRect(Get(request, "editorRect")));
            }
            int? top = kind == "search" ? (int?)(QtPopup.ObservedClientScreen.Top - frame.Binding.Capture.Top) : null;
            if (proof.InputOnly)
                QtInputStable(frame);
            else
                QtStable(frame);
            Binding current = QtBound(!frame.MetadataOnly);
            bool focusValid = current.Thread == frame.Binding.Thread && QtSameBinding(frame.Binding, current) &&
                              (proof.InputOnly ? current.FocusOwned && current.Focus == current.Window
                                               : (kind == "text" ? QtTextEnterFocus(proof.Frame.Binding, current, area)
                                                                 : QtEnterCaret(current, area, top)));
            if (!focusValid)
                throw QtEnterFocusRefusal(kind, proof.Frame.Binding, current, area);
            if (kind == "text")
                QtVerifyQuote(request, frame);
            NoKeysHeld();
            Need(frame.Revision == Interlocked.Read(ref Revision), "QT_HUMAN_ACTIVITY_CHANGED");
            string sendKey = kind == "text" ? Text(request, "sendKey") : null;
            Need(sendKey == null || sendKey == "enter" || sendKey == "ctrl-enter", "QT_SEND_KEY_INVALID");
            Input[] inputs = sendKey == "ctrl-enter" ? new[] { Key(0x11, 0), Key(0x0d, 0), Key(0x0d, 2), Key(0x11, 2) }
                                                     : new[] { Key(0x0d, 0), Key(0x0d, 2) };
            QtRevokeEnter();
            QtCurrent = null;
            InputAttempted = true;
            uint accepted = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(Input)));
            if (accepted != inputs.Length)
            {
                var release = Releases(inputs, accepted);
                if (release.Length > 0)
                    SendInput((uint)release.Length, release, Marshal.SizeOf(typeof(Input)));
                throw new Fault("QT_INPUT_UNCERTAIN");
            }
            if (kind == "text")
            {
                QtActiveQuote = null;
                QtActiveOcrQuote = null;
            }
            var report = Data("performed", true, "attempted", true, "revision", frame.Revision,
                              kind == "search" ? "searchAccepted" : "submittedViaEnter", true);
            if (kind == "search")
            {
                string generation = QtMintUiaSearch(frame, proof.Popup);
                if (generation != null)
                    report.Add("searchGeneration", generation);
            }
            return report;
        }
        finally
        {
            if (retain && !proof.Consumed)
                QtFinishEnterAttempt(proof, true, InputAttempted);
            if (kind == "search" && proof != null && proof.Kind == "search" && !proof.Consumed)
                QtRevokeEnter();
        }
    }
    static bool QtTextResumeMatches(QtEnterProof proof, QtTextStepBinding step, string id, string digest, QtFrame frame,
                                    Rect header, Rect editor)
    {
        if (proof == null || proof.Kind != "text" || proof.Consumed || !proof.Paused || proof.Step == null ||
            !QtSameTextStep(proof.Step, step) || proof.Id != id || proof.Digest != digest || proof.Epoch != QtEpoch ||
            proof.Frame == null || frame == null || QtSurface != "main" || QtPopup != null || QtPendingPopup != null)
            return false;
        if ((proof.Frame.UiaControlFrame || frame.UiaControlFrame) &&
            (!proof.InputOnly || !QtUiaControlLeaseMatches(proof.Frame, QtFocus.Active) ||
             !QtUiaControlLeaseMatches(frame, QtFocus.Active)))
            return false;
        var a = proof.Frame.Binding;
        var b = frame.Binding;
        if (a.Window != b.Window || a.Pid != b.Pid || a.Created != b.Created || a.Thread != b.Thread ||
            a.Dpi != b.Dpi || !Same(a.Client, b.Client) || !Same(a.Capture, b.Capture) || frame.Anchors.Count != 2 ||
            proof.Frame.Anchors.Count != 2)
            return false;
        return Same(frame.Anchors[0].Rect, header) && Same(frame.Anchors[1].Rect, editor) &&
               Same(proof.Frame.Anchors[0].Rect, header) && Same(proof.Frame.Anchors[1].Rect, editor) &&
               frame.Anchors[0].Hash == proof.Frame.Anchors[0].Hash && Contains(b.Client, header) &&
               Contains(b.Client, editor) && header.Bottom <= editor.Top;
    }
    static object QtResumeTextEnterProof(Dictionary<string, object> request)
    {
        var proof = QtPendingEnter;
        Need(proof != null && !proof.Consumed, "QT_TEXT_STEP_UNAVAILABLE");
        QtFrame frame = QtGuard(request, true, !proof.InputOnly);
        Rect header = ParseRect(Get(request, "headerRect")), editor = ParseRect(Get(request, "editorRect"));
        var step = QtParseTextStep(Get(request, "stepBinding"));
        Need(QtTextResumeMatches(proof, step, Text(request, "textEnterProofId"), Text(request, "textSha256"), frame,
                                 header, editor),
             "QT_TEXT_STEP_CHANGED");
        // Operator-selected continuation: the completed paste is not repeated
        // or copied again. Re-focus this exact job's original editor, bind the
        // next Enter to a fresh frame/revision, and retain the original receipt
        // digest. This does not assert that a manually edited draft is unchanged.
        proof.Paused = true;
        Point center = new Point(frame.Binding.Capture.Left + editor.Left + editor.Width / 2,
                                 frame.Binding.Capture.Top + editor.Top + editor.Height / 2);
        Rect desktop = QtDesktopRect();
        Need(Contains(desktop, frame.Binding.Capture), "QT_TEXT_STEP_FOCUS_CHANGED");
        QtStable(frame);
        Need(Owned(WindowFromPoint(center), frame.Binding.Window, frame.Binding.Pid), "QT_TEXT_STEP_FOCUS_CHANGED");
        Input[] inputs = ClickEvents(center.X, center.Y, desktop);
        QtCurrent = null;
        InputAttempted = true;
        ObserveMouseIntent(0x201, center);
        uint accepted = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(Input)));
        if (accepted == inputs.Length)
            QtRememberPointer(center, frame.Revision);
        else if (accepted > 0 && QtFocus.Active != null)
        {
            QtFocus.Active.MarkPointerUncertain();
        }
        if (accepted != inputs.Length)
        {
            Input[] release = ClickReleases(accepted);
            if (release.Length > 0)
                SendInput((uint)release.Length, release, Marshal.SizeOf(typeof(Input)));
            throw new Fault("QT_INPUT_UNCERTAIN");
        }
        QtStable(frame);
        var captured =
            frame.MetadataOnly
                ? QtCaptureUiaControls(Data("surface", "main", "regions",
                                            new object[] { header.Report(), editor.Report() }, "image", false))
                : Map(QtCapture(Data("surface", "main", "regions", new object[] { header.Report(), editor.Report() },
                                     "image", false),
                                !proof.InputOnly));
        var current = QtCurrent;
        Need(current != null && current.Revision == frame.Revision && current.Binding.Thread == frame.Binding.Thread &&
                 QtSameBinding(current.Binding, frame.Binding) && current.Anchors[0].Hash == frame.Anchors[0].Hash,
             "QT_TEXT_STEP_CHANGED");
        if (QtUiaInputHeader(frame, "text", proof.InputOnly, QtFocus.Active))
            QtMarkUiaControlFrame(current, frame.UiaControlLease, captured);
        proof.Consumed = true;
        var next = new QtEnterProof { Id = proof.Id,   Kind = "text",     Digest = proof.Digest,      Epoch = QtEpoch,
                                      Frame = current, Step = proof.Step, InputOnly = proof.InputOnly };
        QtPendingEnter = next;
        return Data("performed", true, "attempted", true, "resumed", true, "revision", current.Revision,
                    "postPasteFrame", captured, "textEnterProof",
                    Data("version", 1, "id", next.Id, "textSha256", next.Digest));
    }
    static object QtEditorCommand(QtClipboardOperation clipboard, string action, Dictionary<string, object> request,
                                  IntPtr owner)
    {
        switch (action)
        {
        case "readDraft":
        case "diagnoseDraftStructure":
            return QtReadDraft(clipboard, request, owner);
        case "resumeTextEnterProof":
            return QtResumeTextEnterProof(request);
        case "paste":
            return QtPaste(clipboard, request, owner);
        case "pasteImage":
        case "pasteFile":
            return QtPasteImage(clipboard, request, owner, false, action == "pasteFile");
        case "submitOcrMedia":
            return QtSubmitOcrMedia(request);
        case "pasteUiaImage":
        case "pasteUiaFile":
            return QtPasteUiaImage(clipboard, request, owner, action == "pasteUiaFile");
        case "captureOcrFileDialog":
            return QtCaptureOcrFileDialog(request);
        case "submitFileDialog":
            return QtSubmitFileDialog(request);
        case "submitUiaImage":
            return QtSubmitUiaImage(request);
        case "resumeUiaImage":
            return QtResumeUiaImage(request);
        case "searchEnter":
        case "submitTextEnter":
            return QtDedicatedEnter(request, action == "searchEnter" ? "search" : "text");
        case "typeText":
            return QtTypeText(request);
        case "click":
        case "movePointer":
        case "chord":
        case "type":
            return QtAct(request, action);
        default:
            throw new Fault("QT_ACTION_INVALID");
        }
    }
}
