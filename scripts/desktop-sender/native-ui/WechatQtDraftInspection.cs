using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Globalization;
using System.IO;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using System.Xml;

internal static partial class WechatDraftProbe
{
    sealed class QtEmptyPhaseLease
    {
        internal string Id, Epoch;
        internal Binding Binding;
        internal long Revision, Issued;
        internal Rect Editor;
        internal HashSet<string> Known;
        internal List<QtAnchor> OtherAnchors;
    }
    static QtEmptyPhaseLease QtEmptyPhaseProof;
    static string QtSchemaName(string name)
    {
        return name != null && System.Text.RegularExpressions.Regex.IsMatch(name, "^[A-Za-z_][A-Za-z0-9_.:-]{0,63}$")
                   ? name
                   : "unsupported-name";
    }
    static string QtUtf8Payload(byte[] bytes)
    {
        int length = bytes.Length;
        while (length > 0 && bytes[length - 1] == 0)
            length--;
        string value = new UTF8Encoding(false, true).GetString(bytes, 0, length);
        if (value.Length > 0 && value[0] == '\ufeff')
            value = value.Substring(1);
        return value;
    }
    static XmlDocument QtXml(string text)
    {
        var settings = new XmlReaderSettings { DtdProcessing = DtdProcessing.Prohibit, XmlResolver = null,
                                               MaxCharactersInDocument = 131072, MaxCharactersFromEntities = 0 };
        var document = new XmlDocument { XmlResolver = null, PreserveWhitespace = true };
        using (var reader = XmlReader.Create(new StringReader(text), settings)) document.Load(reader);
        return document;
    }
    static object QtDescribePayload(string format, byte[] bytes, string draft)
    {
        var result = Data("formatName", format, "payloadIncluded", false, "byteLength", bytes.Length, "exactUtf8Text",
                          EncodedTextOnly(bytes, Encoding.UTF8.GetBytes(draft), 1), "exactUtf16Text",
                          EncodedTextOnly(bytes, Encoding.Unicode.GetBytes(draft), 2));
        string text;
        try
        {
            text = QtUtf8Payload(bytes);
            result["validUtf8"] = true;
        }
        catch
        {
            result["validUtf8"] = false;
            return result;
        }
        result["textPlainMime"] = text == "text/plain";
        result["asciiDecimal10"] = System.Text.RegularExpressions.Regex.IsMatch(text, "^[0-9]{10}$");
        long timestamp;
        result["unixSecondsNearNow"] =
            Int64.TryParse(text, NumberStyles.None, CultureInfo.InvariantCulture, out timestamp) &&
            Math.Abs(UtcMs() / 1000 - timestamp) <= 10;
        string trimmed = text.TrimStart();
        result["startsWithXml"] = trimmed.StartsWith("<", StringComparison.Ordinal);
        result["startsWithJson"] =
            trimmed.StartsWith("{", StringComparison.Ordinal) || trimmed.StartsWith("[", StringComparison.Ordinal);
        if (!trimmed.StartsWith("<", StringComparison.Ordinal))
            return result;
        try
        {
            XmlDocument document = QtXml(text);
            var nodes = new List<object>();
            var pending = new Queue<XmlNode>();
            pending.Enqueue(document.DocumentElement);
            int total = 0;
            while (pending.Count > 0)
            {
                XmlNode node = pending.Dequeue();
                Need(++total <= 64, "QT_STRUCTURE_LIMIT");
                var attributes = new List<object>();
                if (node.Attributes != null)
                    foreach (XmlAttribute attribute in node.Attributes)
                    {
                        Need(attributes.Count < 16, "QT_STRUCTURE_LIMIT");
                        string value = attribute.Value;
                        attributes.Add(Data("name", QtSchemaName(attribute.Name), "empty", value.Length == 0, "zero",
                                            value == "0", "one", value == "1", "numeric",
                                            System.Text.RegularExpressions.Regex.IsMatch(value, "^[0-9]{1,20}$"),
                                            "matchesDraft", value == draft));
                    }
                var children = new List<string>();
                foreach (XmlNode child in node.ChildNodes)
                    if (child.NodeType == XmlNodeType.Element)
                    {
                        children.Add(QtSchemaName(child.Name));
                        pending.Enqueue(child);
                    }
                nodes.Add(Data("name", QtSchemaName(node.Name), "attributes", attributes, "children", children,
                               "textMatchesDraft", node.InnerText == draft, "textEmpty", node.InnerText.Length == 0,
                               "textWhitespace", String.IsNullOrWhiteSpace(node.InnerText)));
            }
            result["xmlParsed"] = true;
            result["root"] = QtSchemaName(document.DocumentElement.Name);
            result["nodes"] = nodes;
        }
        catch
        {
            result["xmlParsed"] = false;
        }
        return result;
    }
    static bool QtPlainRichPayload(string format, byte[] bytes, string draft)
    {
        try
        {
            // This companion is a numeric copy metadata token on this client,
            // not a MIME type or payload. Both independent rich documents below
            // must still describe only type=0 text matching CF_UNICODETEXT.
            string text = QtUtf8Payload(bytes);
            if (format == "x-application-mimetype-xwechat")
                return System.Text.RegularExpressions.Regex.IsMatch(text, "^[0-9]{10}$");
            string rootName = format == "WeChat_RichEdit_Format"       ? "WeChatRichEditFormat"
                              : format == "QQ_Unicode_RichEdit_Format" ? "QQRichEditFormat"
                                                                       : null;
            if (rootName == null || String.IsNullOrEmpty(draft))
                return false;
            XmlDocument document = QtXml(text);
            XmlElement root = document.DocumentElement;
            if (root == null || root.Name != rootName || root.NamespaceURI.Length != 0 || root.Attributes.Count != 0)
                return false;
            foreach (XmlNode node in document.ChildNodes)
                if (node != root && node.NodeType != XmlNodeType.XmlDeclaration &&
                    node.NodeType != XmlNodeType.Whitespace)
                    return false;
            var plain = new StringBuilder();
            int elements = 0;
            foreach (XmlNode element in root.ChildNodes)
            {
                if (element.NodeType != XmlNodeType.Element || element.Name != "EditElement" ||
                    element.NamespaceURI.Length != 0 || element.Attributes == null || element.Attributes.Count != 1 ||
                    element.Attributes["type"] == null || element.Attributes["type"].Value != "0" || ++elements > 4096)
                    return false;
                foreach (XmlNode part in element.ChildNodes)
                {
                    if (part.NodeType != XmlNodeType.Text && part.NodeType != XmlNodeType.CDATA &&
                        part.NodeType != XmlNodeType.Whitespace && part.NodeType != XmlNodeType.SignificantWhitespace)
                        return false;
                    plain.Append(part.Value);
                    if (plain.Length > 16000)
                        return false;
                }
            }
            return elements > 0 && String.Equals(plain.ToString(), draft, StringComparison.Ordinal);
        }
        catch
        {
            return false;
        }
    }
    static HashSet<string> QtEmptyTemplates(Dictionary<string, object> request)
    {
        string primary = Text(request, "emptyEditorSha256");
        Need(Hex(primary, 64), "QT_EMPTY_TEMPLATES_INVALID");
        var result = new HashSet<string>(StringComparer.Ordinal);
        result.Add(primary);
        if (request.ContainsKey("emptyEditorSha256s"))
        {
            object[] variants = Get(request, "emptyEditorSha256s") as object[];
            Need(variants != null && variants.Length >= 1 && variants.Length <= 4, "QT_EMPTY_TEMPLATES_INVALID");
            var unique = new HashSet<string>(StringComparer.Ordinal);
            foreach (object item in variants)
            {
                string value = item as string;
                Need(Hex(value, 64) && unique.Add(value), "QT_EMPTY_TEMPLATES_INVALID");
                result.Add(value);
            }
            Need(result.Count <= 4, "QT_EMPTY_TEMPLATES_INVALID");
        }
        return result;
    }
    // Scalar diagnostics only: never retain pixels/hashes or use elapsed values
    // in a decision. The observer clock is separate from the deadline clock so
    // instrumentation cannot change its reads, guards, samples or sleep calls.
    sealed class QtEmptyWaitTiming
    {
        readonly Func<long> Observe;
        readonly long Started;
        internal long Samples, GuardMs, CaptureMs, WaitMs, SettleMs;
        internal long? FirstMatchAfterMs;
        internal QtEmptyWaitTiming(Func<long> observe)
        {
            Observe = observe;
            Started = observe();
        }
        internal void Guard(Action action)
        {
            long start = Observe();
            try
            {
                action();
            }
            finally
            {
                GuardMs += Math.Max(0, Observe() - start);
            }
        }
        internal string Capture(Func<string> action)
        {
            long start = Observe();
            Samples++;
            try
            {
                return action();
            }
            finally
            {
                CaptureMs += Math.Max(0, Observe() - start);
            }
        }
        internal void Wait(Action<int> action, int milliseconds)
        {
            long start = Observe();
            try
            {
                action(milliseconds);
            }
            finally
            {
                WaitMs += Math.Max(0, Observe() - start);
            }
        }
        internal void Matched()
        {
            if (!FirstMatchAfterMs.HasValue)
                FirstMatchAfterMs = Math.Max(0, Observe() - Started);
        }
        internal object Report()
        {
            return Data("sampleCount", Samples, "firstMatchAfterMs", FirstMatchAfterMs, "guardMs", GuardMs, "captureMs",
                        CaptureMs, "waitMs", WaitMs, "settleMs", SettleMs);
        }
    }
    // Candidate samples must resolve to an exact complete known image. The
    // initial-copy caller may normalize only the strict caret below; unknown
    // pixels still use this same bounded observation, never a similarity score.
    static bool QtWaitEmptyTemplate(HashSet<string> expected, long deadline, Action guard, Func<string> sample,
                                    Func<long> now, Action<int> wait)
    {
        return QtWaitEmptyTemplate(expected, deadline, guard, sample, now, wait, null);
    }
    static bool QtWaitEmptyTemplate(HashSet<string> expected, long deadline, Action guard, Func<string> sample,
                                    Func<long> now, Action<int> wait, QtEmptyWaitTiming timing)
    {
        Action checkedGuard = guard;
        Func<string> capturedSample = sample;
        Action<int> measuredWait = wait;
        if (timing != null)
        {
            checkedGuard = delegate
            {
                timing.Guard(guard);
            };
            capturedSample = delegate
            {
                return timing.Capture(sample);
            };
            measuredWait = delegate(int milliseconds)
            {
                timing.Wait(wait, milliseconds);
            };
        }
        for (;;)
        {
            checkedGuard();
            if (now() >= deadline)
                return false;
            string actual = capturedSample();
            checkedGuard();
            if (now() > deadline)
                return false;
            if (expected.Contains(actual))
            {
                if (timing != null)
                    timing.Matched();
                return true;
            }
            long remaining = deadline - now();
            if (remaining <= 0)
                return false;
            measuredWait((int)Math.Min(25, remaining));
        }
    }
    // A transaction-local proof can only follow a successful empty Ctrl+A/C
    // check and confirmed clipboard restoration. It does not calibrate a new
    // persistent template or excuse any later input, identity or pixel change.
    static object QtIssueEmptyPhaseProof(QtFrame frame, Rect editor, HashSet<string> known)
    {
        if (QtSurface != "main" || QtPopup != null || QtPendingPopup != null)
            return null;
        // readDraft deliberately guards a stable header-only frame: its
        // separate whole-editor blank comparison already proved this exact
        // editor rectangle, without anchoring a blinking pre-copy caret.
        var other = new List<QtAnchor>();
        foreach (var anchor in frame.Anchors)
            if (!Intersects(anchor.Rect, editor))
                other.Add(new QtAnchor { Rect = anchor.Rect, Hash = anchor.Hash });
        if (other.Count == 0)
            return null;
        QtEmptyPhaseProof = new QtEmptyPhaseLease { Id = Guid.NewGuid().ToString("N"),
                                                    Epoch = QtEpoch,
                                                    Binding = frame.Binding,
                                                    Revision = frame.Revision,
                                                    Issued = Now(),
                                                    Editor = editor,
                                                    Known = new HashSet<string>(known, StringComparer.Ordinal),
                                                    OtherAnchors = other };
        var hashes = new List<string>(known);
        hashes.Sort(StringComparer.Ordinal);
        return Data("version", 1, "id", QtEmptyPhaseProof.Id, "editorRect", editor.Report(), "knownEmptySha256s",
                    hashes);
    }
    static bool QtEmptyPhaseBound(QtEmptyPhaseLease proof, string id, QtFrame frame, long now, string surface,
                                  bool popup)
    {
        if (proof == null || frame == null || id != proof.Id || proof.Epoch != QtEpoch || surface != "main" || popup ||
            now < proof.Issued || now - proof.Issued > 30000 || proof.Revision != frame.Revision ||
            !QtSameBinding(proof.Binding, frame.Binding) || proof.Binding.Thread != frame.Binding.Thread)
            return false;
        bool editor = false;
        foreach (var anchor in frame.Anchors)
            if (Same(anchor.Rect, proof.Editor))
                editor = true;
        if (!editor || proof.OtherAnchors == null || proof.OtherAnchors.Count == 0)
            return false;
        foreach (var saved in proof.OtherAnchors)
        {
            bool same = false;
            foreach (var anchor in frame.Anchors)
                if (Same(anchor.Rect, saved.Rect) && anchor.Hash == saved.Hash)
                    same = true;
            if (!same)
                return false;
        }
        return true;
    }
    static bool QtGreenCaret(byte[] pixels, int offset)
    {
        int r = pixels[offset], g = pixels[offset + 1], b = pixels[offset + 2];
        return pixels[offset + 3] == 255 && r <= 32 && g >= 120 && g <= 220 && b >= 64 && b <= 128 && g - b >= 40;
    }
    static object QtEmptyPhasePixels(byte[] pixels, Rect editor, uint dpi, HashSet<string> known)
    {
        int width = editor.Width, height = editor.Height;
        Need(width >= 100 && height >= 40 && width <= 4096 && height <= 4096 && dpi >= 96 && dpi <= 240 &&
                 pixels != null && pixels.Length == checked(width * height * 4) && known != null && known.Count > 0 &&
                 known.Count <= 4,
             "QT_EMPTY_PHASE_UNVERIFIED");
        for (int offset = 3; offset < pixels.Length; offset += 4)
            Need(pixels[offset] == 255, "QT_EMPTY_PHASE_UNVERIFIED");
        string actual = QtHash(pixels);
        if (known.Contains(actual))
            return Data("actualRgbaSha256", actual, "normalizedRgbaSha256", actual, "caretRemoved", false);
        int center = ((height / 2) * width + width / 2) * 4;
        byte red = pixels[center], green = pixels[center + 1], blue = pixels[center + 2];
        Need(Math.Max(red, Math.Max(green, blue)) - Math.Min(red, Math.Min(green, blue)) <= 3,
             "QT_EMPTY_PHASE_UNVERIFIED");
        for (int y = height / 2 - 1; y <= height / 2 + 1; y++)
            for (int x = width / 2 - 1; x <= width / 2 + 1; x++)
            {
                int at = (y * width + x) * 4;
                Need(pixels[at] == red && pixels[at + 1] == green && pixels[at + 2] == blue,
                     "QT_EMPTY_PHASE_UNVERIFIED");
            }
        int left = width, top = height, right = 0, bottom = 0, count = 0;
        for (int y = 0; y < height; y++)
            for (int x = 0; x < width; x++)
            {
                int at = (y * width + x) * 4;
                if (QtGreenCaret(pixels, at))
                {
                    left = Math.Min(left, x);
                    right = Math.Max(right, x + 1);
                    top = Math.Min(top, y);
                    bottom = Math.Max(bottom, y + 1);
                    count++;
                }
            }
        double scale = dpi / 96.0;
        Need(count > 0 && right - left <= Math.Ceiling(2 * scale) && bottom - top >= Math.Floor(8 * scale) &&
                 bottom - top <= Math.Ceiling(32 * scale) && left <= Math.Ceiling(40 * scale) &&
                 top <= Math.Ceiling(32 * scale) && count == (right - left) * (bottom - top),
             "QT_EMPTY_PHASE_UNVERIFIED");
        int first = (top * width + left) * 4;
        var normalized = (byte[])pixels.Clone();
        for (int y = top; y < bottom; y++)
            for (int x = left; x < right; x++)
            {
                int at = (y * width + x) * 4;
                Need(QtGreenCaret(pixels, at) && pixels[at] == pixels[first] && pixels[at + 1] == pixels[first + 1] &&
                         pixels[at + 2] == pixels[first + 2],
                     "QT_EMPTY_PHASE_UNVERIFIED");
                normalized[at] = red;
                normalized[at + 1] = green;
                normalized[at + 2] = blue;
            }
        string empty = QtHash(normalized);
        Need(known.Contains(empty), "QT_EMPTY_PHASE_UNVERIFIED");
        return Data("actualRgbaSha256", actual, "normalizedRgbaSha256", empty, "caretRemoved", true);
    }
    // Called only after the full asynchronous Ctrl+A/C observation completed
    // without a clipboard update. This is pixel evidence, not a phase proof:
    // the unchanged-clipboard guards and final restoration still have to pass.
    // Keep the original full-image fast path. Otherwise only a unique strict
    // caret can be removed, and every remaining pixel must match a known full
    // editor image. Do not learn a new template or mutate the captured pixels.
    static string QtInitialEmptyTemplate(byte[] pixels, Rect editor, uint dpi, HashSet<string> known,
                                         out bool caretNormalized)
    {
        caretNormalized = false;
        string actual = QtHash(pixels);
        if (known.Contains(actual))
            return actual;
        try
        {
            var candidate = Map(QtEmptyPhasePixels(pixels, editor, dpi, known));
            caretNormalized = Object.Equals(Get(candidate, "caretRemoved"), true);
            return Text(candidate, "normalizedRgbaSha256");
        }
        catch (Fault error)
        {
            if (error.Message != "QT_EMPTY_PHASE_UNVERIFIED")
                throw;
            return actual;
        }
    }
    static object QtInspectEmptyEditorPhase(Dictionary<string, object> request)
    {
        string id = Text(request, "emptyDraftPhaseProofId");
        Need(Hex(id, 32), "QT_EMPTY_PHASE_PROOF_INVALID");
        QtFrame frame = QtGuard(request, false);
        var proof = QtEmptyPhaseProof;
        Need(QtEmptyPhaseBound(proof, id, frame, Now(), QtSurface, QtPopup != null || QtPendingPopup != null),
             "QT_EMPTY_PHASE_PROOF_INVALID");
        QtStable(frame);
        var pixels = Map(
            QtEmptyPhasePixels(QtPixels(frame.Binding, proof.Editor), proof.Editor, frame.Binding.Dpi, proof.Known));
        string actual = Text(pixels, "actualRgbaSha256");
        bool matches = false;
        foreach (var anchor in frame.Anchors)
            if (Same(anchor.Rect, proof.Editor) && anchor.Hash == actual)
                matches = true;
        Need(matches, "QT_EMPTY_PHASE_CHANGED");
        // Re-read every supplied anchor, including the entire editor, after
        // normalization. A blink during this read fails closed, never retries.
        QtGuard(request, false);
        Need(Object.ReferenceEquals(proof, QtEmptyPhaseProof) &&
                 QtEmptyPhaseBound(proof, id, frame, Now(), QtSurface, QtPopup != null || QtPendingPopup != null),
             "QT_EMPTY_PHASE_PROOF_INVALID");
        QtStable(frame);
        return Data("version", 1, "emptyDraftPhaseVerified", true, "proofId", proof.Id, "actualRgbaSha256", actual,
                    "normalizedRgbaSha256", Text(pixels, "normalizedRgbaSha256"), "caretRemoved",
                    Get(pixels, "caretRemoved"), "revision", frame.Revision, "readOnly", true, "inputSent", false);
    }
    static object QtReadDraft(QtClipboardOperation clipboard, Dictionary<string, object> request, IntPtr owner)
    {
        QtRevokeEnter();
        QtEmptyPhaseProof = null;
        QtRevokeQueryClick(QtPopup);
        long measureStart = Now(), measureClipboard = 0, measureCopyStart = 0, measureCopyEnd = 0, measureReadEnd = 0;
        QtEmptyWaitTiming emptyTiming = null;
        bool emptyCaretNormalized = false;
        bool diagnostic = Text(request, "action") == "diagnoseDraftStructure";
        var structure = new List<object>();
        clipboard.ObserveRestore(true);
        QtFrame frame = QtGuard(request, true);
        Rect editor = ParseRect(Get(request, "editorRect"));
        Need(Contains(frame.Binding.Client, editor), "QT_REGION_INVALID");
        HashSet<string> emptyTemplates = QtEmptyTemplates(request);
        var textStep = QtParseTextStep(Get(request, "stepBinding"));
        if (request.ContainsKey("headerRect"))
            QtNeedDraftSource(frame, ParseRect(Get(request, "headerRect")), editor);
        QtCurrent = null;
        ClipboardState original = QtReadOriginalClipboard(owner);
        uint copied = 0;
        bool selected = false, copyStarted = false, copyObserved = false;
        string draft = null;
        bool empty = false, restored = false;
        measureClipboard = Now();
        try
        {
            QtStable(frame);
            Need(GetClipboardSequenceNumber() == original.Sequence, "DRAFT_CLIPBOARD_CHANGED");
            SendEvents(ChordEvents(0x41));
            selected = true;
            QtPause(frame, 50);
            Need(GetClipboardSequenceNumber() == original.Sequence, "DRAFT_CLIPBOARD_CHANGED");
            clipboard.ObserveRestore(null);
            copyStarted = true;
            SendEvents(ChordEvents(0x43));
            // Ctrl+C is asynchronous in Qt. Cancellation must still observe its
            // bounded completion so finally can restore the resulting clipboard.
            // This wait does not inject any input or relax the next action guard.
            measureCopyStart = Now();
            long end = Now() + 650;
            while (GetClipboardSequenceNumber() == original.Sequence && Now() < end)
                Thread.Sleep(15);
            measureCopyEnd = Now();
            copied = GetClipboardSequenceNumber();
            copyObserved = true;
            QtStable(frame);
            if (copied == original.Sequence)
            {
                // No clipboard update is not enough to prove an empty draft. The
                // operator-calibrated *entire editor* blank image must also match.
                SendEvents(ChordEvents(0x23));
                long emptyDeadline = Now() + 650;
                QtPause(frame, 50);
                selected = false;
                long emptySettleMs = Now() - (emptyDeadline - 650);
                emptyTiming = new QtEmptyWaitTiming(Now);
                emptyTiming.SettleMs = emptySettleMs;
                Need(QtWaitEmptyTemplate(
                         emptyTemplates, emptyDeadline,
                         delegate {
                             QtStable(frame);
                             Need(GetClipboardSequenceNumber() == original.Sequence, "DRAFT_CLIPBOARD_CHANGED");
                         },
                         delegate {
                             return QtInitialEmptyTemplate(QtPixels(frame.Binding, editor), editor, frame.Binding.Dpi,
                                                           emptyTemplates, out emptyCaretNormalized);
                         },
                         Now, Thread.Sleep, emptyTiming),
                     "QT_EMPTY_DRAFT_UNVERIFIED");
                empty = true;
                draft = "";
            }
            else
            {
                Need(ClipboardOwnerPid() == frame.Binding.Pid, "DRAFT_COPY_OWNER_MISMATCH");
                Need(OpenClipboard(owner), "DRAFT_CLIPBOARD_BUSY");
                try
                {
                    int count = CountClipboardFormats();
                    Need(count > 0 && count <= 16, "DRAFT_CLIPBOARD_COMPLEX_FORMAT");
                    uint id = 0;
                    bool unicode = false;
                    while ((id = EnumClipboardFormats(id)) != 0)
                    {
                        string name = null;
                        if (id >= 0xc000)
                        {
                            var buffer = new StringBuilder(129);
                            if (GetClipboardFormatName(id, buffer, buffer.Capacity) > 0)
                                name = buffer.ToString();
                        }
                        Need(ClipboardFormats.IsTextFormat(id) ||
                                 id >= 0xc000 && ClipboardFormats.IsProjectionCompanion(name),
                             "DRAFT_CLIPBOARD_COMPLEX_FORMAT");
                        if (id == 13)
                            unicode = true;
                    }
                    Need(unicode, "DRAFT_COPY_NOT_UNICODE_TEXT");
                    draft = DecodeUnicode(ClipboardBytes(13, 131072));
                    Need(draft.Length > 0 && draft.Length <= 16000, "QT_DRAFT_INVALID");
                    // A text projection must never hide an attachment that would
                    // also be sent. Accept companion payloads only when their
                    // complete bytes encode this exact plain text.
                    bool wechatText = false, qqText = false, plainMime = false;
                    id = 0;
                    while ((id = EnumClipboardFormats(id)) != 0)
                    {
                        if (id < 0xc000)
                            continue;
                        var name = new StringBuilder(129);
                        GetClipboardFormatName(id, name, name.Capacity);
                        string tag = name.ToString();
                        if (tag == "DataObject" || tag == "Ole Private Data")
                            continue;
                        byte[] payload = ClipboardBytes(id, 131072);
                        if (diagnostic)
                            structure.Add(QtDescribePayload(tag, payload, draft));
                        else
                        {
                            Need(QtPlainRichPayload(tag, payload, draft), "QT_RICH_DRAFT_UNSUPPORTED");
                            if (tag == "WeChat_RichEdit_Format")
                                wechatText = true;
                            else if (tag == "QQ_Unicode_RichEdit_Format")
                                qqText = true;
                            else if (tag == "x-application-mimetype-xwechat")
                                plainMime = true;
                        }
                    }
                    if (!diagnostic)
                        Need(wechatText && qqText && plainMime, "QT_RICH_DRAFT_UNSUPPORTED");
                    Need(GetClipboardSequenceNumber() == copied && ClipboardOwnerPid() == frame.Binding.Pid,
                         "DRAFT_CLIPBOARD_CHANGED");
                }
                finally
                {
                    CloseClipboard();
                }
            }
            QtStable(frame);
            if (selected)
            {
                SendEvents(ChordEvents(0x23));
                QtPause(frame, 50);
                selected = false;
            }
            measureReadEnd = Now();
        }
        finally
        {
            // After intervention leave selection and newer clipboard untouched.
            if (copyStarted && !copyObserved)
            {
                long end = Now() + 650;
                while (GetClipboardSequenceNumber() == original.Sequence && Now() < end)
                    Thread.Sleep(15);
                copied = GetClipboardSequenceNumber();
            }
            // A delayed Ctrl+C may complete during the bounded empty-image
            // sampling. Only adopt that exact WeChat-owned sequence while the
            // input revision is unchanged; a newer user clipboard is untouched.
            if (copyStarted && copyObserved && copied == original.Sequence &&
                frame.Revision == Interlocked.Read(ref Revision) && ClipboardOwnerPid() == frame.Binding.Pid)
            {
                uint late = GetClipboardSequenceNumber();
                if (late != original.Sequence)
                    copied = late;
            }
            if (copied != 0 && copied != original.Sequence)
            {
                restored = QtRestoreOriginalClipboard(clipboard, owner, original, copied, frame.Binding.Pid);
                clipboard.ObserveRestore(restored);
                Need(restored, "DRAFT_CLIPBOARD_RESTORE_UNCONFIRMED");
            }
            else
                restored = GetClipboardSequenceNumber() == original.Sequence;
            clipboard.ObserveRestore(restored);
        }
        QtStable(frame);
        if (diagnostic)
            return Data("diagnosticOnly", true, "payloadIncluded", false, "formats", structure, "draftVerified", false,
                        "richContentVerified", false, "clipboardRestored", restored, "revision", frame.Revision,
                        "inputSent", true, "textTyped", false, "submitted", false);
        var outcome =
            Data("draft", draft, "emptyTemplateMatched", empty, "emptyTemplateCaretNormalized", emptyCaretNormalized,
                 "draftVerified", true, "richContentVerified", true, "clipboardRestored", restored, "revision",
                 frame.Revision, "inputSent", true, "timingMs",
                 Data("guardAndClipboard", measureClipboard - measureStart, "selectAndCopy",
                      measureCopyStart - measureClipboard, "copyWait", measureCopyEnd - measureCopyStart,
                      "readVerification", measureReadEnd - measureCopyEnd, "restoreAndFinal", Now() - measureReadEnd,
                      "emptyTemplateCheck", emptyTiming == null ? null : emptyTiming.Report()));
        if (empty && draft == "" && restored)
        {
            object proof = QtIssueEmptyPhaseProof(frame, editor, emptyTemplates);
            if (proof != null)
                outcome.Add("emptyDraftPhaseProof", proof);
        }
        if (!empty && restored && draft != "" && request.ContainsKey("headerRect"))
        {
            Rect header = ParseRect(Get(request, "headerRect"));
            QtAttachEnterProof(outcome, "text", QtNormalizeText(draft), frame,
                               new List<QtAnchor> { new QtAnchor { Rect = header }, new QtAnchor { Rect = editor } },
                               textStep);
        }
        return outcome;
    }
}
