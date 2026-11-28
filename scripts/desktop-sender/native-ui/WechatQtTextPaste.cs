using System;
using System.Collections.Generic;
using System.Globalization;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static partial class WechatDraftProbe
{
    // Clipboard paste belongs only to this explicitly verified transaction.
    // Keep the general draft probe's ChordEvents allowlist unchanged.
    static Input[] QtPasteChord()
    {
        return new[] { Key(0x11, 0), Key(0x56, 0), Key(0x56, 2), Key(0x11, 2) };
    }
    static Input[] QtPasteInput(Dictionary<string, object> request, string scope)
    {
        if (!request.ContainsKey("replaceSearch"))
            return QtPasteChord();
        Need(scope == "search" && Object.Equals(Get(request, "replaceSearch"), true), "QT_SEARCH_PASTE_SCOPE_INVALID");
        // Both chords enter the same SendInput queue after the clipboard is
        // installed. No focus change or independent input token lies between
        // selection and paste; the existing full read-back proves completion.
        Input[] select = ChordEvents(0x41), paste = QtPasteChord(), events = new Input[select.Length + paste.Length];
        Array.Copy(select, 0, events, 0, select.Length);
        Array.Copy(paste, 0, events, select.Length, paste.Length);
        return events;
    }
    static void QtValidatePaste(string text, string expected, string scope, string searchKind = null)
    {
        Need((scope == "editor" || scope == "search") && !String.IsNullOrEmpty(text) && text.Length <= 16000 &&
                 text.IndexOf('\0') < 0 && !String.IsNullOrEmpty(expected) && expected.Length <= 16000 &&
                 expected.IndexOf('\0') < 0,
             "QT_PASTE_INVALID");
        Need(searchKind == null || (scope == "search" && (searchKind == "group-title" || searchKind == "private-name")),
             "QT_PASTE_SEARCH_INVALID");
        if (scope == "search")
            Need(text == expected &&
                     (searchKind == "group-title" || searchKind == "private-name"
                          ? text.Length <= 128 && text == text.Trim() &&
                                !text.EndsWith("@chatroom", StringComparison.Ordinal) &&
                                !System.Text.RegularExpressions.Regex.IsMatch(text, "[\\x00-\\x1f\\x7f]")
                          : System.Text.RegularExpressions.Regex.IsMatch(text, "^[A-Za-z0-9_-]{1,256}$")),
                 "QT_PASTE_SEARCH_INVALID");
    }
    static bool QtOwnPasteSnapshot(IntPtr owner, IntPtr observedOwner, uint pid, uint observedPid, bool published,
                                   uint[] formats, byte[] actual, byte[] expected)
    {
        if (owner == IntPtr.Zero || observedOwner != owner || pid == 0 || observedPid != pid || formats == null)
            return false;
        if (!published)
            return formats.Length == 0 && actual == null;
        if (formats.Length < 1 || formats.Length > 4 || actual == null || expected == null ||
            actual.Length != expected.Length)
            return false;
        bool unicode = false;
        var seen = new HashSet<uint>();
        foreach (uint format in formats)
        {
            if (!seen.Add(format) || (format != 1 && format != 7 && format != 13 && format != 16))
                return false;
            if (format == 13)
                unicode = true;
        }
        if (!unicode)
            return false;
        for (int index = 0; index < actual.Length; index++)
            if (actual[index] != expected[index])
                return false;
        return true;
    }
    // Windows may synthesize text formats and advance the sequence when a
    // newly written Unicode clipboard is closed. Reopen it and prove this is
    // still our exact HWND/PID/buffer, rather than accepting any newer sequence.
    static uint QtConfirmOwnPaste(IntPtr owner, uint pid, bool published, byte[] expected)
    {
        for (int attempt = 0; attempt < 2; attempt++)
        {
            uint observed;
            Need(OpenClipboard(owner), "DRAFT_CLIPBOARD_BUSY");
            try
            {
                IntPtr observedOwner = GetClipboardOwner();
                uint observedPid = ClipboardOwnerPid();
                observed = GetClipboardSequenceNumber();
                var formats = new List<uint>();
                uint format = 0;
                while ((format = EnumClipboardFormats(format)) != 0)
                {
                    Need(formats.Count < 4, "DRAFT_CLIPBOARD_CHANGED");
                    formats.Add(format);
                }
                byte[] actual = published ? ClipboardBytes(13, 131072) : null;
                Need(QtOwnPasteSnapshot(owner, observedOwner, pid, observedPid, published, formats.ToArray(), actual,
                                        expected),
                     "DRAFT_CLIPBOARD_CHANGED");
                Need(GetClipboardOwner() == owner && ClipboardOwnerPid() == pid &&
                         GetClipboardSequenceNumber() == observed,
                     "DRAFT_CLIPBOARD_CHANGED");
            }
            finally
            {
                CloseClipboard();
            }
            if (GetClipboardOwner() == owner && ClipboardOwnerPid() == pid && GetClipboardSequenceNumber() == observed)
                return observed;
        }
        throw new Fault("DRAFT_CLIPBOARD_CHANGED");
    }
    static void QtPutText(QtClipboardOperation clipboard, IntPtr owner, string text, ClipboardState previous,
                          ref bool changed, ref uint owned, ref uint ownerPid)
    {
        byte[] bytes = Encoding.Unicode.GetBytes(text + "\0");
        IntPtr handle = GlobalAlloc(0x42, new UIntPtr((uint)bytes.Length));
        Need(handle != IntPtr.Zero, "DRAFT_CLIPBOARD_RESTORE_FAILED");
        try
        {
            ulong allocated = GlobalSize(handle).ToUInt64();
            Need(allocated >= (ulong)bytes.Length && allocated <= 131072, "DRAFT_CLIPBOARD_RESTORE_FAILED");
            byte[] exact = new byte[(int)allocated];
            Array.Copy(bytes, exact, bytes.Length);
            IntPtr memory = GlobalLock(handle);
            Need(memory != IntPtr.Zero, "DRAFT_CLIPBOARD_RESTORE_FAILED");
            try
            {
                Marshal.Copy(exact, 0, memory, exact.Length);
            }
            finally
            {
                GlobalUnlock(handle);
            }
            bool published = false;
            Exception failure = null;
            try
            {
                Need(OpenClipboard(owner), "DRAFT_CLIPBOARD_BUSY");
                try
                {
                    Need(QtOriginalClipboardStillCurrent(previous), "DRAFT_CLIPBOARD_CHANGED");
                    Need(EmptyClipboard(), "DRAFT_CLIPBOARD_RESTORE_FAILED");
                    // Publish rollback ownership immediately after EmptyClipboard. A
                    // SetClipboardData failure must also restore our owned empty buffer.
                    changed = true;
                    owned = GetClipboardSequenceNumber();
                    ownerPid = GetCurrentProcessId();
                    clipboard.ObserveRestore(false);
                    Need(SetClipboardData(13, handle) != IntPtr.Zero, "DRAFT_CLIPBOARD_RESTORE_FAILED");
                    handle = IntPtr.Zero;
                    published = true;
                    owned = GetClipboardSequenceNumber();
                }
                finally
                {
                    CloseClipboard();
                }
            }
            catch (Exception error)
            {
                failure = error;
            }
            if (changed)
                owned = QtConfirmOwnPaste(owner, ownerPid, published, exact);
            if (failure != null)
                throw failure;
        }
        finally
        {
            if (handle != IntPtr.Zero)
                GlobalFree(handle);
        }
    }
    // Ctrl+A/C is queued after Ctrl+V. Its exact read-back proves the target
    // consumed the pasted text before the original clipboard is restored.
    static bool QtSearchPasteCompletionScope(string scope, string surface, QtFrame frame, QtPopupLease popup)
    {
        if (scope != "search" || surface != "observed-search" || frame == null || popup == null || !popup.Observed ||
            popup.Id != "search" || popup.Calibration == null || popup.Calibration.Kind != "search" ||
            popup.Window == IntPtr.Zero || popup.Root == null || frame.Binding == null ||
            frame.Binding.Window == IntPtr.Zero || frame.Binding.Window != popup.Root.Window ||
            frame.Revision != popup.Revision || !frame.PopupBounds.HasValue || !frame.PopupClient.HasValue ||
            frame.Anchors == null || frame.Anchors.Count != 1)
            return false;
        return Contains(frame.Binding.Client, frame.Anchors[0].Rect);
    }
    static bool QtSearchQueryClickEligible(string surface, QtFrame frame, QtPopupLease popup, Rect clicked,
                                           bool hitMain)
    {
        if (!hitMain || !QtSearchPasteCompletionScope("search", surface, frame, popup) ||
            !Same(clicked, frame.Anchors[0].Rect))
            return false;
        int top = popup.ObservedClientScreen.Top - frame.Binding.Capture.Top,
            left = popup.ObservedClientScreen.Left - frame.Binding.Capture.Left,
            right = popup.ObservedClientScreen.Right - frame.Binding.Capture.Left;
        // A full query anchor may extend under the result popup's top edge.
        // Only an actual root-owned click above that edge can establish this
        // extra local proof; a result-row click or overlapping rectangle alone
        // cannot. Full pixels/focus are checked again before and after input.
        return clicked.Width > 0 && clicked.Height > 0 && clicked.Left >= left && clicked.Right <= right &&
               clicked.Top + clicked.Height / 2 < top;
    }
    static void QtRevokeQueryClick(QtPopupLease popup)
    {
        if (popup == null)
            return;
        if (popup.QueryClick != null)
            popup.QueryClick.Consumed = true;
        popup.QueryClick = null;
    }
    static QtQueryClickProof QtTakeQueryClick(QtPopupLease popup)
    {
        if (popup == null)
            return null;
        var proof = popup.QueryClick;
        popup.QueryClick = null;
        if (proof == null || proof.Consumed)
            return null;
        proof.Consumed = true;
        return proof;
    }
    static bool QtSearchPasteCompletionEligible(string scope, string surface, QtFrame frame, QtPopupLease popup,
                                                QtQueryClickProof proof = null, long now = -1)
    {
        if (!QtSearchPasteCompletionScope(scope, surface, frame, popup))
            return false;
        // The query field is on the main window, above the causally observed
        // result popup. A result-row/profile anchor never receives this scope.
        Rect query = frame.Anchors[0].Rect;
        int resultTop = popup.ObservedClientScreen.Top - frame.Binding.Capture.Top;
        if (query.Bottom <= resultTop)
            return true;
        if (proof == null || !proof.Consumed || !Object.ReferenceEquals(proof.Popup, popup) || proof.Epoch != QtEpoch)
            return false;
        var queryClick = proof.Frame;
        if (queryClick == null || !QtSearchQueryClickEligible(surface, queryClick, popup, query, true) ||
            !Same(queryClick.Anchors[0].Rect, query) || queryClick.Revision != frame.Revision ||
            queryClick.Binding.Thread != frame.Binding.Thread || !QtSameBinding(queryClick.Binding, frame.Binding) ||
            !Same(queryClick.PopupBounds.Value, frame.PopupBounds.Value) ||
            !Same(queryClick.PopupClient.Value, frame.PopupClient.Value))
            return false;
        long age = (now < 0 ? UtcMs() : now) - queryClick.Issued;
        return age >= 0 && age <= 30000;
    }
    static void QtPasteCompletionStable(QtFrame frame, QtSearchPasteCompletion completion)
    {
        if (completion == null)
        {
            QtStable(frame);
            return;
        }
        var search = completion.Popup;
        if (!(Object.ReferenceEquals(QtPopup, search) &&
              QtSearchPasteCompletionEligible("search", QtSurface, frame, search, completion.QueryClick)))
            throw QtPopupBindingChanged(search, "paste-completion");
        Need(!Stopping && Interlocked.Read(ref Revision) == frame.Revision, "QT_HUMAN_ACTIVITY_CHANGED");
        // QtBound retains the original popup HWND/process/thread/owner/class,
        // style/DPI/position/width and main-window/focus/occlusion guards. Its
        // observed-search lease already permits only height changes inside the
        // root. The pre-input capture's old height is not a completion guard
        // for a query which this very paste is changing.
        Need(QtSameBinding(frame.Binding, QtBound()), "QT_BINDING_CHANGED");
        NoKeysHeld();
    }
    static void QtPasteCompletionPause(QtFrame frame, QtSearchPasteCompletion search, int milliseconds)
    {
        long end = Now() + milliseconds;
        while (Now() < end)
        {
            Thread.Sleep(10);
            QtPasteCompletionStable(frame, search);
        }
    }
    static bool QtPasteReadback(Dictionary<string, object> request)
    {
        if (!request.ContainsKey("readback"))
            return true;
        Need(Get(request, "readback") is bool, "QT_PASTE_INVALID");
        return (bool)Get(request, "readback");
    }
    static bool QtForegroundPasteOnly(Dictionary<string, object> request)
    {
        if (!request.ContainsKey("foregroundOnly"))
            return false;
        Need(Get(request, "foregroundOnly") is bool, "QT_PASTE_INVALID");
        return (bool)Get(request, "foregroundOnly");
    }
    // A return-focus lease is unnecessary when WeChat was already foreground.
    // QtGuard/QtBound still prove the actual foreground, idle input and exact
    // process/window binding before this explicit fast-paste mode is accepted.
    static bool QtFastPasteAuthorized(bool borrowed, bool foregroundOnly, bool parked, Binding binding, IntPtr root,
                                      uint pid, long created, string surface)
    {
        return borrowed || foregroundOnly && !parked && binding != null && root != IntPtr.Zero && pid > 0 &&
                               created > 0 && binding.Window == root && binding.Pid == pid &&
                               binding.Created == created && binding.FocusOwned &&
                               (surface == "main" || QtSearchSurface(surface));
    }
    static object QtInputProofPacket(QtEnterProof proof)
    {
        return Data("version", 1, "id", proof.Id, proof.Kind == "search" ? "querySha256" : "textSha256", proof.Digest);
    }
    static Input[] QtTypedTextEvents(string text, string newlineKey)
    {
        if (text != "\n")
            return TextEvents(text);
        Need(newlineKey == "Shift+Enter", "QT_NEWLINE_CALIBRATION_REQUIRED");
        return new[] { Key(0x10, 0), Key(0x0d, 0), Key(0x0d, 2), Key(0x10, 2) };
    }
    static bool QtTypedPrefixMatches(QtEnterProof proof, QtTextStepBinding step, string text, string expected,
                                     QtFrame frame, string proofId)
    {
        if (step == null || String.IsNullOrEmpty(text) || String.IsNullOrEmpty(expected) || expected.Length > 16000 ||
            !expected.EndsWith(text, StringComparison.Ordinal))
            return false;
        string prefix = expected.Substring(0, expected.Length - text.Length);
        if (prefix.Length == 0)
            return proofId == null;
        return proof != null && proof.InputOnly && QtSameTextStep(proof.Step, step) &&
               QtEnterProofMatches(proof, "text", proofId, QtHash(Encoding.UTF8.GetBytes(prefix)), frame, UtcMs());
    }
    // OCR shared mode types one grapheme while retaining only our own accepted
    // input prefix. Like fast paste this never reads or overwrites the draft.
    static object QtTypeText(Dictionary<string, object> request)
    {
        QtEmptyPhaseProof = null;
        QtRevokeQueryClick(QtPopup);
        QtFrame frame = QtGuard(request, true, false);
        Need(!frame.MetadataOnly, "QT_TYPED_TEXT_SCOPE_INVALID");
        string text = QtNormalizeText(Text(request, "text")), expected = QtNormalizeText(Text(request, "expectedText"));
        QtValidatePaste(text, expected, "editor", null);
        Input[] events = QtTypedTextEvents(text, Text(request, "newlineKey"));
        Need(QtFastPasteAuthorized(QtFocus.Active != null, QtForegroundPasteOnly(request), QtFocus.Parked != null,
                                   frame.Binding, QtRoot.Window, QtRoot.Pid, QtRoot.Created, QtSurface),
             "QT_FOCUS_LEASE_REQUIRED");
        var step = QtParseTextStep(Get(request, "stepBinding"));
        Rect header = ParseRect(Get(request, "headerRect")), editor = ParseRect(Get(request, "editorRect"));
        QtNeedTextAnchors(frame, header, editor);
        Need(QtTypedPrefixMatches(QtPendingEnter, step, text, expected, frame, Text(request, "textEnterProofId")),
             "QT_TYPED_TEXT_PREFIX_CHANGED");
        QtInputStable(frame);
        QtRevokeEnter();
        QtCurrent = null;
        SendEvents(events);
        var report = Data("performed", true, "attempted", true, "revision", frame.Revision, "typeApplied", true,
                          "readbackPerformed", false, "intendedText", expected, "clipboardAccessed", false,
                          "interrupted", false);
        try
        {
            QtInputStable(frame, false);
            QtAttachEnterProof(report, "text", expected, frame,
                               new List<QtAnchor> { new QtAnchor { Rect = header }, new QtAnchor { Rect = editor } },
                               step, true);
        }
        catch (Exception)
        {
            if (Stopping || Interlocked.Read(ref Revision) == frame.Revision)
                throw;
            var proof = new QtEnterProof { Id = Guid.NewGuid().ToString("N"),
                                           Kind = "text",
                                           Digest = QtHash(Encoding.UTF8.GetBytes(expected)),
                                           Epoch = QtEpoch,
                                           Frame = frame,
                                           Step = step,
                                           InputOnly = true,
                                           Paused = true };
            QtPendingEnter = proof;
            report["interrupted"] = true;
            report.Add("textEnterProof", QtInputProofPacket(proof));
        }
        return report;
    }
    static object QtPasteWithoutReadback(QtClipboardOperation clipboard, Dictionary<string, object> request,
                                         IntPtr owner)
    {
        var trace = new QtImagePasteTrace { Format = 13 };
        clipboard.ObserveRestore(true);
        try
        {
            QtRevokeEnter();
            QtEmptyPhaseProof = null;
            QtRevokeQueryClick(QtPopup);
            clipboard.ObserveRestore(true);
            trace.Stage = "frame";
            QtFrame frame = QtGuard(request, true, false);
            string text = QtNormalizeText(Text(request, "text")),
                   expected = QtNormalizeText(Text(request, "expectedText")), scope = Text(request, "scope");
            QtValidatePaste(text, expected, scope, Text(request, "searchKind"));
            Need(QtFastPasteAuthorized(QtFocus.Active != null, QtForegroundPasteOnly(request), QtFocus.Parked != null,
                                       frame.Binding, QtRoot.Window, QtRoot.Pid, QtRoot.Created, QtSurface),
                 "QT_FOCUS_LEASE_REQUIRED");
            var step = QtParseTextStep(Get(request, "stepBinding"));
            var anchors = new List<QtAnchor>();
            if (scope == "editor")
            {
                Rect header = ParseRect(Get(request, "headerRect")), editor = ParseRect(Get(request, "editorRect"));
                QtNeedTextAnchors(frame, header, editor);
                anchors.Add(new QtAnchor { Rect = header });
                anchors.Add(new QtAnchor { Rect = editor });
            }
            else
            {
                Need(QtSearchPasteCompletionScope(scope, QtSurface, frame, QtPopup), "QT_SEARCH_PASTE_SCOPE_INVALID");
                anchors.Add(new QtAnchor { Rect = frame.Anchors[0].Rect });
            }
            Input[] events = QtPasteInput(request, scope);
            trace.Stage = "original";
            ClipboardState original = QtReadOriginalClipboard(owner, false, QtAllowClipboardReplacement(request));
            uint owned = original.Sequence, ownerPid = GetCurrentProcessId();
            bool changed = false, published = false, restored = false, applied = false;
            byte[] bytes = Encoding.Unicode.GetBytes(text + "\0");
            IntPtr payload = GlobalAlloc(0x42, new UIntPtr((uint)bytes.Length));
            Need(payload != IntPtr.Zero, "DRAFT_CLIPBOARD_RESTORE_FAILED");
            QtImageRenderOwner renderer = null;
            try
            {
                IntPtr memory = GlobalLock(payload);
                Need(memory != IntPtr.Zero, "DRAFT_CLIPBOARD_RESTORE_FAILED");
                try
                {
                    Marshal.Copy(bytes, 0, memory, bytes.Length);
                }
                finally
                {
                    GlobalUnlock(payload);
                }
                renderer = new QtImageRenderOwner(owner, payload, 13, frame);
                payload = IntPtr.Zero;
                renderer.Attach();
                trace.Mark("before-publish", owner);
                QtInputStable(frame, false);
                Need(OpenClipboard(owner), "DRAFT_CLIPBOARD_BUSY");
                try
                {
                    Need(QtOriginalClipboardStillCurrent(original), "DRAFT_CLIPBOARD_CHANGED");
                    Need(EmptyClipboard(), "DRAFT_CLIPBOARD_RESTORE_FAILED");
                    changed = true;
                    clipboard.ObserveRestore(false);
                    owned = GetClipboardSequenceNumber();
                    SetClipboardData(13, IntPtr.Zero);
                    published = true;
                    trace.Mark("published", owner, true);
                }
                finally
                {
                    CloseClipboard();
                }
                trace.Mark("closed", owner);
                owned = QtConfirmDelayedImageOffer(renderer, owner, ownerPid, trace);
                QtInputStable(frame);
                trace.Mark("before-input", owner);
                renderer.Arm();
                QtCurrent = null;
                SendEvents(events);
                // A bound WeChat clipboard consumer proves handoff without reading
                // the search/editor text, and prevents early clipboard restoration.
                trace.Mark("consumer", owner);
                owned = QtWaitImageClipboardConsumer(renderer, owner, ownerPid);
                applied = true;
            }
            catch (Exception error)
            {
                trace.OperationFailure = error is Fault ? error.Message : "QT_OPERATION_FAILED";
                throw;
            }
            finally
            {
                try
                {
                    trace.Mark("restore", owner);
                    if (changed && renderer != null)
                        owned = QtImageCleanupSequence(renderer, owner, ownerPid, owned,
                                                       QtKeepPublishedPaste(original, scope == "search"));
                    restored = QtFinishPasteClipboard(clipboard, owner, original, changed, published, owned, ownerPid,
                                                      scope == "search");
                }
                catch (Exception error)
                {
                    trace.CleanupFailure = error is Fault ? error.Message : "QT_OPERATION_FAILED";
                    if (trace.OperationFailure == null)
                        throw;
                }
                finally
                {
                    if (renderer != null)
                        renderer.Dispose();
                    if (payload != IntPtr.Zero)
                        GlobalFree(payload);
                }
            }
            Need(applied, "QT_INPUT_UNCERTAIN");
            var report = Data("performed", true, "attempted", true, "revision", frame.Revision, "pasteApplied", true,
                              "readbackPerformed", false, "intendedText", expected, "clipboardRestored", restored,
                              "interrupted", false, "clipboardConsumerConfirmed", true);
            if (clipboard.Replaced)
                report.Add("clipboardReplaced", true);
            try
            {
                QtInputStable(frame, false);
                QtAttachEnterProof(report, scope == "search" ? "search" : "text", expected, frame, anchors, step, true);
            }
            catch (Exception)
            {
                if (scope != "editor" || Stopping || Interlocked.Read(ref Revision) == frame.Revision)
                    throw;
                // The paste was accepted before the user intervened. Preserve only
                // its intended prefix; resumption refocuses the original editor and
                // sends Enter without copying or pasting it again.
                var proof = new QtEnterProof { Id = Guid.NewGuid().ToString("N"),
                                               Kind = "text",
                                               Digest = QtHash(Encoding.UTF8.GetBytes(expected)),
                                               Epoch = QtEpoch,
                                               Frame = frame,
                                               Step = step,
                                               InputOnly = true,
                                               Paused = true };
                QtPendingEnter = proof;
                report["interrupted"] = true;
                report.Add("textEnterProof", QtInputProofPacket(proof));
            }
            return report;
        }
        catch (Exception error)
        {
            if (trace.OperationFailure == null)
                trace.OperationFailure = error is Fault ? error.Message : "QT_OPERATION_FAILED";
            error.Data["QtImageClipboard"] = trace.Report();
            throw;
        }
    }
    static object QtPaste(QtClipboardOperation clipboard, Dictionary<string, object> request, IntPtr owner)
    {
        if (!QtPasteReadback(request))
            return QtPasteWithoutReadback(clipboard, request, owner);
        QtRevokeEnter();
        QtEmptyPhaseProof = null;
        QtQueryClickProof queryClick = QtTakeQueryClick(QtPopup);
        clipboard.At("initial-guard");
        clipboard.ObserveRestore(true);
        QtFrame frame = QtGuard(request, true);
        string text = QtNormalizeText(Text(request, "text")), expected = QtNormalizeText(Text(request, "expectedText")),
               scope = Text(request, "scope");
        QtValidatePaste(text, expected, scope, Text(request, "searchKind"));
        clipboard.Bind(frame);
        clipboard.At("before-publish");
        Rect textHeader = new Rect(), textEditor = new Rect();
        bool textProof = scope == "editor" && request.ContainsKey("headerRect");
        var textStep = QtParseTextStep(Get(request, "stepBinding"));
        if (textProof)
        {
            textHeader = ParseRect(Get(request, "headerRect"));
            textEditor = ParseRect(Get(request, "editorRect"));
            QtNeedTextAnchors(frame, textHeader, textEditor);
        }
        Input[] pasteKeys = QtPasteInput(request, scope);
        QtSearchPasteCompletion completionSearch =
            QtSearchPasteCompletionEligible(scope, QtSurface, frame, QtPopup, queryClick)
                ? new QtSearchPasteCompletion { Popup = QtPopup, QueryClick = queryClick }
                : null;
        ClipboardState original = QtReadOriginalClipboard(owner, false, QtAllowClipboardReplacement(request));
        uint owned = original.Sequence, ownerPid = original.OwnerPid;
        bool changed = false, published = false, copied = false, copyStarted = false, restored = false;
        string actual = null;
        try
        {
            QtStable(frame);
            Need(GetClipboardSequenceNumber() == original.Sequence, "DRAFT_CLIPBOARD_CHANGED");
            clipboard.ObserveRestore(null);
            QtPutText(clipboard, owner, text, original, ref changed, ref owned, ref ownerPid);
            published = true;
            clipboard.At("before-paste");
            QtStable(frame);
            Need(GetClipboardSequenceNumber() == owned && ClipboardOwnerPid() == ownerPid, "DRAFT_CLIPBOARD_CHANGED");
            QtCurrent = null;
            clipboard.At("paste-settle");
            SendEvents(pasteKeys);
            QtPasteCompletionPause(frame, completionSearch, 120);
            Need(GetClipboardSequenceNumber() == owned && ClipboardOwnerPid() == ownerPid, "DRAFT_CLIPBOARD_CHANGED");
            clipboard.At("select-settle");
            SendEvents(ChordEvents(0x41));
            QtPasteCompletionPause(frame, completionSearch, 50);
            copyStarted = true;
            clipboard.At("copy-readback");
            SendEvents(ChordEvents(0x43));
            long end = Now() + 650;
            while (GetClipboardSequenceNumber() == owned && Now() < end)
                Thread.Sleep(15);
            uint after = GetClipboardSequenceNumber();
            if (after != owned && frame.Revision == Interlocked.Read(ref Revision))
            {
                owned = after;
                ownerPid = frame.Binding.Pid;
                copied = true;
            }
            QtPasteCompletionStable(frame, completionSearch);
            Need(copied && ClipboardOwnerPid() == frame.Binding.Pid, "QT_PASTE_READBACK_UNCONFIRMED");
            Need(OpenClipboard(owner), "DRAFT_CLIPBOARD_BUSY");
            try
            {
                int count = CountClipboardFormats();
                Need(count > 0 && count <= 16, "DRAFT_CLIPBOARD_COMPLEX_FORMAT");
                actual = QtNormalizeText(DecodeUnicode(ClipboardBytes(13, 131072)));
                Need(actual == expected, "QT_PASTE_TEXT_MISMATCH");
                bool wechat = false, qq = false, mime = false;
                uint format = 0;
                while ((format = EnumClipboardFormats(format)) != 0)
                {
                    string name = QtFormatName(format);
                    if (ClipboardFormats.IsTextFormat(format))
                        continue;
                    // Search's Qt clipboard also publishes OLE bookkeeping and
                    // sometimes the same rich-text companions as the editor.
                    // Validate these bytes by the identical plain-text parser;
                    // do not reject a verified query just for having companions.
                    Need(format >= 0xc000 && ClipboardFormats.IsProjectionCompanion(name), "QT_RICH_DRAFT_UNSUPPORTED");
                    if (name == "DataObject" || name == "Ole Private Data")
                        continue;
                    Need(QtPlainRichPayload(name, ClipboardBytes(format, 131072),
                                            DecodeUnicode(ClipboardBytes(13, 131072))),
                         "QT_RICH_DRAFT_UNSUPPORTED");
                    if (name == "WeChat_RichEdit_Format")
                        wechat = true;
                    else if (name == "QQ_Unicode_RichEdit_Format")
                        qq = true;
                    else if (name == "x-application-mimetype-xwechat")
                        mime = true;
                }
                Need(scope == "search" || wechat && qq && mime, "QT_RICH_DRAFT_UNSUPPORTED");
                Need(GetClipboardSequenceNumber() == owned && ClipboardOwnerPid() == ownerPid,
                     "DRAFT_CLIPBOARD_CHANGED");
            }
            finally
            {
                CloseClipboard();
            }
            clipboard.At("readback-verified");
            QtPasteCompletionStable(frame, completionSearch);
            clipboard.At("end-settle");
            SendEvents(ChordEvents(0x23));
            QtPasteCompletionPause(frame, completionSearch, 50);
        }
        finally
        {
            // On cancellation a queued copy can still complete. Wait for it
            // without injecting further input, then restore only our exact copy.
            if (copyStarted && !copied)
            {
                long end = Now() + 650;
                while (GetClipboardSequenceNumber() == owned && Now() < end)
                    Thread.Sleep(15);
                uint after = GetClipboardSequenceNumber();
                if (after != owned && frame.Revision == Interlocked.Read(ref Revision))
                {
                    owned = after;
                    ownerPid = frame.Binding.Pid;
                }
            }
            restored = QtFinishPasteClipboard(clipboard, owner, original, changed, published, owned, ownerPid,
                                              scope == "search");
        }
        clipboard.At(clipboard.Replaced ? "clipboard-replaced" : "clipboard-restored");
        QtPasteCompletionStable(frame, completionSearch);
        var report = Data("performed", true, "attempted", true, "revision", frame.Revision, "pasteVerified", true,
                          "clipboardRestored", restored, "draft", actual);
        if (clipboard.Replaced)
            report.Add("clipboardReplaced", true);
        if (request.ContainsKey("replaceSearch"))
            report.Add("searchReplaced", true);
        if (scope == "search" && Object.Equals(Get(request, "replaceSearch"), true) && completionSearch != null)
            QtAttachEnterProof(report, "search", actual, frame,
                               new List<QtAnchor> { new QtAnchor { Rect = frame.Anchors[0].Rect } });
        else if (textProof)
            QtAttachEnterProof(
                report, "text", actual, frame,
                new List<QtAnchor> { new QtAnchor { Rect = textHeader }, new QtAnchor { Rect = textEditor } },
                textStep);
        return report;
    }
}
