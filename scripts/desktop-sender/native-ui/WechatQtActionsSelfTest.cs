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
    sealed partial class QtFocusSession
    {
        // Some refusal tests deliberately arrange conflicting leases. Keep that
        // ability in synthetic checks, outside the command/ownership API.
        internal sealed class Fixture : IDisposable
        {
            readonly QtFocusSession owner;
            readonly QtFocusLease active, inspected;
            readonly ParkedSession parked;
            internal Fixture(QtFocusSession owner)
            {
                this.owner = owner;
                active = owner.Active;
                inspected = owner.Inspected;
                parked = owner.Parked;
            }

            internal void Arrange(QtFocusLease current, QtFocusLease suspended = null, long parkedAt = 0)
            {
                owner.Active = current;
                owner.Parked = suspended == null ? null : new ParkedSession(suspended, null, parkedAt);
            }

            public void Dispose()
            {
                owner.Active = active;
                owner.Inspected = inspected;
                owner.Parked = parked;
            }
        }
    }

    static int QtFocusOwnershipSelfTest()
    {
        var first = new QtFocusSession(delegate { return 123; });
        var second = new QtFocusSession(delegate { return 456; });
        var independent = new QtFocusLease();
        first.Acquire(independent);
        Need(second.Active == null && second.Parked == null, "QT_TEST_SESSION_OWNERS_ARE_INDEPENDENT");
        first.ParkAfterRestore(first.TakeActive(), new Binding());
        Need(first.Parked.At == 123 && second.Parked == null, "QT_TEST_SESSION_OWNS_ITS_CLOCK_AND_PARK");
        var previousClipboard = new QtClipboardOperation();
        previousClipboard.ObserveRestore(false);
        previousClipboard.ObserveReplacement();
        previousClipboard.RecordRestoration(Data("fixture", true));
        var nextClipboard = new QtClipboardOperation();
        var mismatch = new Fault("QT_POPUP_BINDING_CHANGED");
        mismatch.Data["QtPopupBindingMismatch"] = Data("version", 1);
        previousClipboard.At("before-paste");
        var firstReport = Map(previousClipboard.PopupMismatch(mismatch));
        var nextReport = Map(nextClipboard.PopupMismatch(mismatch));
        Need(Text(firstReport, "pasteStage") == "before-paste" && Text(nextReport, "pasteStage") == "none",
             "QT_TEST_CLIPBOARD_REPORT_SCOPE");

        Need(nextClipboard.Restored == null && !nextClipboard.Replaced && nextClipboard.Restoration == null &&
                 nextClipboard.Stage == null && nextClipboard.Frame == null,
             "QT_TEST_NEW_COMMAND_HAS_NO_PREVIOUS_CLIPBOARD_OBSERVATIONS");
        using (var fixture = new QtFocusSession.Fixture(QtFocus))
        {
            fixture.Arrange(null);
            var lease = new QtFocusLease();
            QtFocus.RememberInspection(lease);
            Need(Object.ReferenceEquals(QtFocus.TakeInspection(), lease) && QtFocus.TakeInspection() == null,
                 "QT_TEST_INSPECTION_CONSUMED_ONCE");
            QtFocus.Acquire(lease);
            Expect(delegate { QtFocus.Acquire(new QtFocusLease()); }, "QT_FOCUS_LEASE_UNAVAILABLE");
            Need(Object.ReferenceEquals(QtFocus.TakeActive(), lease) && QtFocus.TakeActive() == null,
                 "QT_TEST_ACTIVE_DETACHED_ONCE");
            var binding = new Binding();
            QtFocus.ParkAfterRestore(lease, binding);
            Need(Object.ReferenceEquals(QtFocus.Parked.Lease, lease) &&
                     Object.ReferenceEquals(QtFocus.Parked.Binding, binding),
                 "QT_TEST_PARKED_BINDING_OWNED_WITH_LEASE");
            Expect(delegate { QtFocus.Acquire(new QtFocusLease()); }, "QT_FOCUS_LEASE_UNAVAILABLE");
            QtFocus.DiscardParked();
            QtFocus.Acquire(lease);
            Need(Object.ReferenceEquals(QtFocus.TakeActive(), lease) && QtFocus.Parked == null,
                 "QT_TEST_NEW_ACQUISITION_AFTER_PARK_CLEARED");
            return 10;
        }
    }

    static int QtParkResumeSelfTest()
    {
        int checks = 0;
        bool enabled = QtEnableInput, stopping = Stopping, attempted = InputAttempted;
        var focus = new QtFocusSession.Fixture(QtFocus);
        string surface = QtSurface;
        var popup = QtPopup;
        try
        {
            for (int missing = 0; missing < 6; missing++)
            {
                QtEnableInput = true;
                Stopping = false;
                InputAttempted = false;
                focus.Arrange(missing == 2 ? null : new QtFocusLease(), missing == 3 ? new QtFocusLease() : null);
                QtSurface = "main";
                QtPopup = null;
                if (missing == 0)
                    QtEnableInput = false;
                if (missing == 1)
                    Stopping = true;
                if (missing == 4)
                    QtSurface = "profile";
                if (missing == 5)
                    QtPopup = new QtPopupLease();
                var before = QtFocus.Active;
                Expect(delegate { QtParkFocus(); }, "QT_FOCUS_PARK_UNAVAILABLE");
                Need(!InputAttempted && Object.ReferenceEquals(before, QtFocus.Active),
                     "QT_TEST_PARK_REFUSAL_NO_INPUT_OR_LEASE_LOSS");
                checks++;
            }
            for (int missing = 0; missing < 4; missing++)
            {
                QtEnableInput = true;
                Stopping = false;
                InputAttempted = false;
                focus.Arrange(missing == 2 ? new QtFocusLease() : null, missing == 3 ? null : new QtFocusLease());
                if (missing == 0)
                    QtEnableInput = false;
                if (missing == 1)
                    Stopping = true;
                var before = QtFocus.Parked;
                Expect(delegate { QtResumeFocus(Data()); }, "QT_FOCUS_PARK_UNAVAILABLE");
                Need(!InputAttempted && Object.ReferenceEquals(before, QtFocus.Parked),
                     "QT_TEST_RESUME_REFUSAL_NO_INPUT_OR_LEASE_LOSS");
                checks++;
            }
            QtEnableInput = true;
            Stopping = false;
            InputAttempted = false;
            var expired = new QtFocusLease { Revision = Interlocked.Read(ref Revision) };
            focus.Arrange(null, expired, Now() - 30001);
            Expect(delegate { QtResumeFocus(Data()); }, "QT_HUMAN_ACTIVITY_CHANGED");
            Need(!InputAttempted && QtFocus.Parked != null, "QT_TEST_EXPIRED_PARK_NO_INPUT");
            checks++;
            var changed = new QtFocusLease { Revision = Interlocked.Read(ref Revision) + 1 };
            focus.Arrange(null, changed, Now());
            Expect(delegate { QtResumeFocus(Data()); }, "QT_HUMAN_ACTIVITY_CHANGED");
            Need(!InputAttempted && QtFocus.Parked != null, "QT_TEST_CHANGED_PARK_NO_INPUT");
            checks++;
        }
        finally
        {
            QtEnableInput = enabled;
            Stopping = stopping;
            InputAttempted = attempted;
            focus.Dispose();
            QtSurface = surface;
            QtPopup = popup;
        }
        return checks;
    }
    static byte[] QtEmptyPhaseFixture(int width, int height)
    {
        var pixels = new byte[width * height * 4];
        for (int offset = 0; offset < pixels.Length; offset += 4)
        {
            pixels[offset] = 31;
            pixels[offset + 1] = 31;
            pixels[offset + 2] = 31;
            pixels[offset + 3] = 255;
        }
        pixels[0] = pixels[1] = pixels[2] = 48;
        return pixels;
    }
    static void QtCaretFixture(byte[] pixels, int width, int left, int top, int right, int bottom)
    {
        for (int y = top; y < bottom; y++)
            for (int x = left; x < right; x++)
            {
                int at = (y * width + x) * 4;
                pixels[at] = 0;
                pixels[at + 1] = 163;
                pixels[at + 2] = 97;
            }
    }
    static int QtEmptyPhaseSelfTest()
    {
        int checks = 0;
        Rect editor = new Rect(300, 400, 460, 500);
        byte[] blank = QtEmptyPhaseFixture(160, 100);
        string blankHash = QtHash(blank);
        var known = new HashSet<string>(StringComparer.Ordinal) { blankHash };
        var unchanged = Map(QtEmptyPhasePixels(blank, editor, 144, known));
        Need(Text(unchanged, "actualRgbaSha256") == blankHash && Text(unchanged, "normalizedRgbaSha256") == blankHash &&
                 Object.Equals(Get(unchanged, "caretRemoved"), false),
             "QT_TEST_EMPTY_PHASE_EXACT");
        checks++;
        foreach (uint dpi in new uint[] { 96, 120, 144, 192, 240 })
        {
            byte[] pixels = (byte[])blank.Clone();
            int width = (int)Math.Ceiling(2 * dpi / 96.0), height = (int)Math.Round(19 * dpi / 96.0);
            QtCaretFixture(pixels, 160, 15, 14, 15 + width, 14 + height);
            string before = QtHash(pixels);
            var matched = Map(QtEmptyPhasePixels(pixels, editor, dpi, known));
            Need(Text(matched, "actualRgbaSha256") == before && Text(matched, "normalizedRgbaSha256") == blankHash &&
                     Object.Equals(Get(matched, "caretRemoved"), true) && QtHash(pixels) == before,
                 "QT_TEST_EMPTY_PHASE_CARET_ONLY_SOURCE_UNCHANGED");
            checks++;
        }
        for (int variant = 0; variant < 9; variant++)
        {
            byte[] pixels = (byte[])blank.Clone();
            QtCaretFixture(pixels, 160, 15, 14, 18, 42);
            if (variant == 0)
                pixels[(20 * 160 + 16) * 4 + 1] = 31;
            else if (variant == 1)
                QtCaretFixture(pixels, 160, 25, 14, 28, 42);
            else if (variant == 2)
                QtCaretFixture(pixels, 160, 15, 14, 20, 42);
            else if (variant == 3)
                pixels[(80 * 160 + 100) * 4] = 90;
            else if (variant == 4)
                pixels[(20 * 160 + 16) * 4 + 2] = 96;
            else if (variant == 5)
                pixels[3] = 0;
            else if (variant == 6)
            {
                pixels = (byte[])blank.Clone();
                QtCaretFixture(pixels, 160, 100, 14, 103, 42);
            }
            else if (variant == 7)
            {
                pixels = (byte[])blank.Clone();
                QtCaretFixture(pixels, 160, 15, 55, 18, 83);
            }
            else
            {
                pixels[0] = pixels[1] = pixels[2] = 31;
            }
            Expect(delegate { QtEmptyPhasePixels(pixels, editor, 144, known); }, "QT_EMPTY_PHASE_UNVERIFIED");
            checks++;
        }
        var binding = new Binding { Window = new IntPtr(10),
                                    Pid = 20,
                                    Thread = 30,
                                    Created = 40,
                                    Dpi = 144,
                                    Focus = new IntPtr(10),
                                    Client = new Rect(0, 0, 800, 600),
                                    Capture = new Rect(100, 100, 900, 700) };
        var header = new QtAnchor { Rect = new Rect(300, 40, 700, 90), Hash = new string('b', 64) };
        var frame =
            new QtFrame { Binding = binding, Revision = 50,
                          Anchors = new List<QtAnchor> { header, new QtAnchor { Rect = editor, Hash = blankHash } } };
        var proof = new QtEmptyPhaseLease { Id = new string('a', 32),
                                            Epoch = QtEpoch,
                                            Binding = binding,
                                            Revision = 50,
                                            Issued = 100,
                                            Editor = editor,
                                            Known = known,
                                            OtherAnchors = new List<QtAnchor> { header } };
        var priorProof = QtEmptyPhaseProof;
        string priorSurface = QtSurface;
        var priorPopup = QtPopup;
        var priorPending = QtPendingPopup;
        try
        {
            QtSurface = "main";
            QtPopup = null;
            QtPendingPopup = null;
            var sourceFrame = new QtFrame { Binding = binding, Revision = 50, Anchors = new List<QtAnchor> { header } };
            var issued = Map(QtIssueEmptyPhaseProof(sourceFrame, editor, known));
            Need(issued != null && issued.Count == 4 && Same(ParseRect(Get(issued, "editorRect")), editor) &&
                     QtEmptyPhaseBound(QtEmptyPhaseProof, Text(issued, "id"), frame, Now(), "main", false),
                 "QT_TEST_HEADER_ONLY_COPY_SOURCE_ISSUES_BOUND_PROOF");
            checks++;
            Need(!QtEmptyPhaseBound(QtEmptyPhaseProof, Text(issued, "id"), sourceFrame, Now(), "main", false),
                 "QT_TEST_PHASE_INSPECTION_STILL_REQUIRES_FULL_EDITOR");
            checks++;
            sourceFrame.Anchors = new List<QtAnchor> { new QtAnchor { Rect = editor, Hash = blankHash } };
            Need(QtIssueEmptyPhaseProof(sourceFrame, editor, known) == null,
                 "QT_TEST_EMPTY_PHASE_REQUIRES_ORIGINAL_NONEDITOR_ANCHOR");
            checks++;
        }
        finally
        {
            QtEmptyPhaseProof = priorProof;
            QtSurface = priorSurface;
            QtPopup = priorPopup;
            QtPendingPopup = priorPending;
        }
        Need(QtEmptyPhaseBound(proof, proof.Id, frame, 100, "main", false) &&
                 QtEmptyPhaseBound(proof, proof.Id, frame, 30100, "main", false),
             "QT_TEST_EMPTY_PHASE_EXACT_TRANSACTION");
        checks++;
        Need(!QtEmptyPhaseBound(proof, new string('b', 32), frame, 100, "main", false) &&
                 !QtEmptyPhaseBound(proof, proof.Id, frame, 99, "main", false) &&
                 !QtEmptyPhaseBound(proof, proof.Id, frame, 30101, "main", false) &&
                 !QtEmptyPhaseBound(proof, proof.Id, frame, 100, "profile", false) &&
                 !QtEmptyPhaseBound(proof, proof.Id, frame, 100, "main", true),
             "QT_TEST_EMPTY_PHASE_ID_AGE_AND_SURFACE");
        checks++;
        frame.Revision = 51;
        Need(!QtEmptyPhaseBound(proof, proof.Id, frame, 100, "main", false), "QT_TEST_EMPTY_PHASE_ACTIVITY_REVOKES");
        frame.Revision = 50;
        checks++;
        proof.Epoch = "other";
        Need(!QtEmptyPhaseBound(proof, proof.Id, frame, 100, "main", false), "QT_TEST_EMPTY_PHASE_EPOCH_REVOKES");
        proof.Epoch = QtEpoch;
        checks++;
        frame.Anchors[0] = new QtAnchor { Rect = header.Rect, Hash = new string('c', 64) };
        Need(!QtEmptyPhaseBound(proof, proof.Id, frame, 100, "main", false), "QT_TEST_EMPTY_PHASE_HEADER_REVOKES");
        frame.Anchors[0] = header;
        checks++;
        frame.Anchors[1] = new QtAnchor { Rect = new Rect(301, 400, 460, 500), Hash = blankHash };
        Need(!QtEmptyPhaseBound(proof, proof.Id, frame, 100, "main", false),
             "QT_TEST_EMPTY_PHASE_FULL_EDITOR_REQUIRED");
        frame.Anchors[1] = new QtAnchor { Rect = editor, Hash = blankHash };
        checks++;
        for (int variant = 0; variant < 8; variant++)
        {
            var changed = new Binding { Window = binding.Window,   Pid = binding.Pid,        Thread = binding.Thread,
                                        Created = binding.Created, Dpi = binding.Dpi,        Focus = binding.Focus,
                                        Client = binding.Client,   Capture = binding.Capture };
            if (variant == 0)
                changed.Window = new IntPtr(11);
            else if (variant == 1)
                changed.Pid++;
            else if (variant == 2)
                changed.Thread++;
            else if (variant == 3)
                changed.Created++;
            else if (variant == 4)
                changed.Dpi++;
            else if (variant == 5)
                changed.Focus = new IntPtr(11);
            else if (variant == 6)
                changed.Client.Right++;
            else
                changed.Capture.Left++;
            frame.Binding = changed;
            Need(!QtEmptyPhaseBound(proof, proof.Id, frame, 100, "main", false),
                 "QT_TEST_EMPTY_PHASE_NATIVE_BINDING_REVOKES");
            checks++;
        }
        frame.Binding = binding;
        var savedProof = QtEmptyPhaseProof;
        bool enabled = QtEnableInput;
        try
        {
            QtEnableInput = false;
            foreach (string action in new string[] { "click", "movePointer", "chord", "type" })
            {
                QtEmptyPhaseProof = proof;
                Expect(delegate { QtAct(Data(), action); }, "QT_INPUT_DISABLED");
                Need(QtEmptyPhaseProof == null, "QT_TEST_OWN_INPUT_REVOKES_EMPTY_PHASE");
                checks++;
            }
            QtEmptyPhaseProof = proof;
            Expect(delegate { QtPaste(new QtClipboardOperation(), Data(), IntPtr.Zero); }, "QT_INPUT_DISABLED");
            Need(QtEmptyPhaseProof == null, "QT_TEST_PASTE_REVOKES_EMPTY_PHASE");
            checks++;
            QtEmptyPhaseProof = proof;
            Expect(delegate { QtReadDraft(new QtClipboardOperation(), Data(), IntPtr.Zero); }, "QT_INPUT_DISABLED");
            Need(QtEmptyPhaseProof == null, "QT_TEST_NEW_COPY_REVOKES_EMPTY_PHASE");
            checks++;
            QtEmptyPhaseProof = proof;
            Expect(delegate { QtTransferFocus(); }, "QT_FOCUS_LEASE_UNAVAILABLE");
            Need(QtEmptyPhaseProof == null, "QT_TEST_TRANSFER_REVOKES_EMPTY_PHASE");
            checks++;
        }
        finally
        {
            QtEmptyPhaseProof = savedProof;
            QtEnableInput = enabled;
        }
        return checks;
    }
    static int QtInitialEmptyTemplateSelfTest()
    {
        int count = 0;
        Rect editor = new Rect(300, 400, 460, 500);
        byte[] blank = QtEmptyPhaseFixture(160, 100);
        string blankHash = QtHash(blank);
        var known = new HashSet<string>(StringComparer.Ordinal) { blankHash };
        bool normalized;
        Need(QtInitialEmptyTemplate(blank, editor, 144, known, out normalized) == blankHash && !normalized,
             "QT_TEST_INITIAL_EMPTY_EXACT_PATH");
        count++;
        foreach (uint dpi in new uint[] { 96, 120, 144, 192, 240 })
        {
            byte[] pixels = (byte[])blank.Clone();
            QtCaretFixture(pixels, 160, 15, 14, 15 + (int)Math.Ceiling(2 * dpi / 96.0),
                           14 + (int)Math.Round(19 * dpi / 96.0));
            string original = QtHash(pixels);
            Need(QtInitialEmptyTemplate(pixels, editor, dpi, known, out normalized) == blankHash && normalized &&
                     QtHash(pixels) == original && known.Count == 1 && known.Contains(blankHash),
                 "QT_TEST_INITIAL_EMPTY_STRICT_CARET_NO_LEARNING");
            count++;
        }
        for (int variant = 0; variant < 11; variant++)
        {
            byte[] pixels = (byte[])blank.Clone();
            QtCaretFixture(pixels, 160, 15, 14, 18, 42);
            if (variant == 0)
                pixels[(20 * 160 + 16) * 4 + 1] = 31;
            else if (variant == 1)
                QtCaretFixture(pixels, 160, 25, 14, 28, 42);
            else if (variant == 2)
                QtCaretFixture(pixels, 160, 15, 14, 20, 42);
            else if (variant == 3)
                pixels[(80 * 160 + 100) * 4] = 90;
            else if (variant == 4)
                pixels[(20 * 160 + 16) * 4 + 2] = 96;
            else if (variant == 5)
                pixels[3] = 0;
            else if (variant == 6)
            {
                pixels = (byte[])blank.Clone();
                QtCaretFixture(pixels, 160, 100, 14, 103, 42);
            }
            else if (variant == 7)
            {
                pixels = (byte[])blank.Clone();
                QtCaretFixture(pixels, 160, 15, 55, 18, 83);
            }
            else if (variant == 8)
            {
                pixels[0] = pixels[1] = pixels[2] = 31;
            }
            else if (variant == 9)
            {
                pixels = (byte[])blank.Clone();
                QtCaretFixture(pixels, 160, 15, 14, 18, 19);
            }
            else
            {
                pixels = (byte[])blank.Clone();
                QtCaretFixture(pixels, 160, 15, 14, 18, 75);
            }
            string original = QtHash(pixels),
                   candidate = QtInitialEmptyTemplate(pixels, editor, 144, known, out normalized);
            Need(candidate == original && !known.Contains(candidate) && !normalized && QtHash(pixels) == original,
                 "QT_TEST_INITIAL_EMPTY_UNKNOWN_PIXELS_STAY_UNMATCHED");
            count++;
        }
        byte[] legal = (byte[])blank.Clone();
        QtCaretFixture(legal, 160, 15, 14, 18, 42);
        string legalHash = QtHash(legal);
        var unknown = new HashSet<string>(StringComparer.Ordinal) { new string('a', 64) };
        Need(QtInitialEmptyTemplate(legal, editor, 144, unknown, out normalized) == legalHash && !normalized &&
                 unknown.Count == 1,
             "QT_TEST_INITIAL_EMPTY_REQUIRES_KNOWN_NORMALIZED_FRAME");
        count++;
        long clock = 0;
        int guards = 0, samples = 0, waits = 0;
        bool sampledNormalized = false;
        Need(QtWaitEmptyTemplate(known, 650, delegate { guards++; },
                                 delegate {
                                     samples++;
                                     return QtInitialEmptyTemplate(legal, editor, 144, known, out sampledNormalized);
                                 },
                                 delegate { return clock; },
                                 delegate(int ms) {
                                     waits++;
                                     clock += ms;
                                 }) &&
                 sampledNormalized && guards == 2 && samples == 1 && waits == 0,
             "QT_TEST_INITIAL_EMPTY_MATCH_KEEPS_BOTH_GUARDS");
        count++;
        guards = 0;
        Expect(delegate {
            QtWaitEmptyTemplate(
                known, 650,
                delegate {
                    if (++guards == 2)
                        throw new Fault("DRAFT_CLIPBOARD_CHANGED");
                },
                delegate { return QtInitialEmptyTemplate(legal, editor, 144, known, out sampledNormalized); },
                delegate { return clock; }, delegate(int ms) { clock += ms; });
        }, "DRAFT_CLIPBOARD_CHANGED");
        count++;
        clock = 0;
        Need(!QtWaitEmptyTemplate(known, 650, delegate {},
                                  delegate {
                                      clock = 651;
                                      return QtInitialEmptyTemplate(legal, editor, 144, known, out sampledNormalized);
                                  },
                                  delegate { return clock; }, delegate(int ms) { clock += ms; }),
             "QT_TEST_INITIAL_EMPTY_LATE_NORMALIZED_FRAME_REJECTED");
        count++;
        clock = 0;
        samples = 0;
        Need(!QtWaitEmptyTemplate(known, 650, delegate {},
                                  delegate {
                                      samples++;
                                      return QtInitialEmptyTemplate(legal, editor, 144, unknown, out sampledNormalized);
                                  },
                                  delegate { return clock; }, delegate(int ms) { clock += ms; }) &&
                 clock == 650 && samples == 26,
             "QT_TEST_INITIAL_EMPTY_UNKNOWN_NORMALIZATION_BOUNDED");
        count++;
        return count;
    }
    static Dictionary<string, object> QtEmptyTimingFixture(int scenario, bool measured)
    {
        long clock = 1000, deadline = scenario == 3 ? 1000 : 1100;
        int samples = 0, guards = 0;
        var trace = new List<string>();
        var timing = measured ? new QtEmptyWaitTiming(delegate { return clock; }) : null;
        bool? result = null;
        string fault = null;
        try
        {
            result = QtWaitEmptyTemplate(new HashSet<string>(StringComparer.Ordinal) { new string('a', 64) }, deadline,
                                         delegate {
                                             trace.Add("guard");
                                             guards++;
                                             clock += 2;
                                             if (scenario == 5 && guards == 3)
                                                 throw new Fault("QT_HUMAN_ACTIVITY_CHANGED");
                                         },
                                         delegate {
                                             trace.Add("sample");
                                             samples++;
                                             clock += 3;
                                             if (scenario == 6)
                                                 throw new Fault("QT_CAPTURE_FIXTURE_FAILED");
                                             if (scenario == 4)
                                                 clock = deadline + 1;
                                             return scenario == 0 || scenario == 4 || scenario == 1 && samples == 3
                                                        ? new string('a', 64)
                                                        : new string('b', 64);
                                         },
                                         delegate {
                                             trace.Add("clock");
                                             return clock;
                                         },
                                         delegate(int milliseconds) {
                                             trace.Add("wait:" + milliseconds.ToString(CultureInfo.InvariantCulture));
                                             clock += milliseconds;
                                             if (scenario == 7)
                                                 throw new Fault("QT_WAIT_FIXTURE_FAILED");
                                         },
                                         timing);
        }
        catch (Fault error)
        {
            fault = error.Message;
        }
        return Data("result", result, "fault", fault, "clock", clock, "trace", trace, "sampleCount", samples,
                    "guardCount", guards, "timing", timing == null ? null : timing.Report());
    }
    static int QtEmptyTimingSelfTest()
    {
        int count = 0;
        for (int scenario = 0; scenario < 8; scenario++)
        {
            var plain = QtEmptyTimingFixture(scenario, false);
            var measured = QtEmptyTimingFixture(scenario, true);
            plain.Remove("timing");
            measured.Remove("timing");
            Need(Json.Serialize(plain) == Json.Serialize(measured),
                 "QT_TEST_EMPTY_TIMING_PRESERVES_ACTION_AND_CLOCK_TRACE");
            count++;
        }
        var immediate = Map(Get(QtEmptyTimingFixture(0, true), "timing"));
        Need(Number(Get(immediate, "sampleCount")) == 1 && Number(Get(immediate, "firstMatchAfterMs")) == 7 &&
                 Number(Get(immediate, "guardMs")) == 4 && Number(Get(immediate, "captureMs")) == 3 &&
                 Number(Get(immediate, "waitMs")) == 0,
             "QT_TEST_EMPTY_TIMING_IMMEDIATE_COMPONENTS");
        count++;
        var delayed = Map(Get(QtEmptyTimingFixture(1, true), "timing"));
        Need(Number(Get(delayed, "sampleCount")) == 3 && Number(Get(delayed, "firstMatchAfterMs")) == 71 &&
                 Number(Get(delayed, "guardMs")) == 12 && Number(Get(delayed, "captureMs")) == 9 &&
                 Number(Get(delayed, "waitMs")) == 50,
             "QT_TEST_EMPTY_TIMING_RETRY_COMPONENTS");
        count++;
        foreach (int scenario in new[] { 2, 3, 4, 5, 6, 7 })
            Need(Get(Map(Get(QtEmptyTimingFixture(scenario, true), "timing")), "firstMatchAfterMs") == null,
                 "QT_TEST_EMPTY_TIMING_FAILURE_HAS_NO_MATCH");
        count++;
        var expired = Map(Get(QtEmptyTimingFixture(3, true), "timing"));
        Need(Number(Get(expired, "sampleCount")) == 0 && Number(Get(expired, "guardMs")) == 2 &&
                 Number(Get(expired, "captureMs")) == 0 && Number(Get(expired, "waitMs")) == 0,
             "QT_TEST_EMPTY_TIMING_EXPIRED_STILL_GUARDS_WITHOUT_SAMPLE");
        count++;
        Need(immediate.Count == 6 && !Json.Serialize(immediate).Contains(new string('a', 64)) &&
                 !Json.Serialize(immediate).Contains(new string('b', 64)),
             "QT_TEST_EMPTY_TIMING_NUMBERS_ONLY");
        foreach (object value in immediate.Values)
            Need(value == null || value is long, "QT_TEST_EMPTY_TIMING_NO_PAYLOAD");
        count++;
        return count;
    }
    static int QtFocusRestoreDiagnosticSelfTest()
    {
        int count = 0;
        var epochLease = new QtFocusLease { Revision = 12 };
        Need(QtReturnActivityRevision(epochLease, 12) == 12, "QT_TEST_RETURN_PRESERVES_LEASE_ACTIVITY_EPOCH");
        Expect(delegate { QtReturnActivityRevision(epochLease, 13); }, "QT_HUMAN_ACTIVITY_CHANGED");
        count++;
        IntPtr zTarget = new IntPtr(1), zNear = new IntPtr(2), zFar = new IntPtr(3);
        Func<IntPtr, IntPtr> zPrevious = delegate(IntPtr window)
        {
            return window == zTarget ? zNear : window == zNear ? zFar : IntPtr.Zero;
        };
        var zChain = QtReadPreviousChain(zTarget, zPrevious, delegate(IntPtr window) { return true; },
                                         delegate { return 0; }, 200, 16);
        Need(zChain.Complete && zChain.Reason == "end" && zChain.Windows.Count == 2 && zChain.Windows[0] == zNear &&
                 zChain.Windows[1] == zFar,
             "QT_TEST_OCCLUSION_EXPLICIT_PREDECESSOR_ORDER");
        count++;
        zChain = QtReadPreviousChain(zTarget, delegate(IntPtr window) { return window == zTarget ? zNear : zTarget; },
                                     delegate(IntPtr window) { return true; }, delegate { return 0; }, 200, 16);
        Need(!zChain.Complete && zChain.Reason == "cycle" && zChain.Windows.Count == 1,
             "QT_TEST_OCCLUSION_DIAGNOSTIC_CYCLE_BOUND");
        count++;
        zChain = QtReadPreviousChain(zTarget, zPrevious, delegate(IntPtr window) { return window != zNear; },
                                     delegate { return 0; }, 200, 16);
        Need(!zChain.Complete && zChain.Reason == "window-unavailable" && zChain.Windows.Count == 0,
             "QT_TEST_OCCLUSION_DIAGNOSTIC_DESTROYED_WINDOW");
        count++;
        zChain = QtReadPreviousChain(zTarget, zPrevious, delegate(IntPtr window) { return true; },
                                     delegate { return 0; }, 200, 1);
        Need(!zChain.Complete && zChain.Reason == "limit" && zChain.Windows.Count == 1,
             "QT_TEST_OCCLUSION_DIAGNOSTIC_COUNT_BOUND");
        count++;
        int zCalls = 0;
        zChain = QtReadPreviousChain(zTarget,
                                     delegate(IntPtr window) {
                                         zCalls++;
                                         return zNear;
                                     },
                                     delegate(IntPtr window) { return true; }, delegate { return 201; }, 200, 16);
        Need(!zChain.Complete && zChain.Reason == "deadline" && zCalls == 0, "QT_TEST_OCCLUSION_DIAGNOSTIC_TIME_BOUND");
        count++;
        var zRegions = QtOcclusionRegions(
            Data("header", new Rect(20, 10, 200, 60).Report(), "editor", new Rect(20, 100, 200, 180).Report()),
            new Rect(0, 0, 220, 200));
        Need(zRegions.Count == 2 && QtOcclusionRegionPoints(zRegions["header"]).Count == 5,
             "QT_TEST_OCCLUSION_EXPLICIT_REGIONS_ONLY");
        Expect(delegate {
            QtOcclusionRegions(Data("private-title", new Rect(20, 10, 200, 60).Report()), new Rect(0, 0, 220, 200));
        }, "QT_OCCLUSION_REGIONS_INVALID");
        Expect(delegate {
            QtOcclusionRegions(Data("editor", new Rect(20, 100, 201, 180).Report()), new Rect(0, 0, 200, 200));
        }, "QT_OCCLUSION_REGIONS_INVALID");
        count++;
        Need(QtBeginActivityRevision(null, 12) == 12 && QtBeginActivityRevision(12, 12) == 12,
             "QT_TEST_BEGIN_AND_RESUME_EXPLICIT_EPOCH");
        Expect(delegate { QtBeginActivityRevision(12, 13); }, "QT_HUMAN_ACTIVITY_CHANGED");
        count++;
        Need(QtTransferredUnchanged(100, 100, 12, 12) && !QtTransferredUnchanged(100, 101, 12, 12) &&
                 !QtTransferredUnchanged(100, 100, 12, 13),
             "QT_TEST_TRANSFERRED_TOKEN_REQUIRES_BOTH_INPUT_TICK_AND_INITIAL_MONITOR_EPOCH");
        count++;
        Need(QtTransferredFresh(1000, 1000) && QtTransferredFresh(1000, 31000) && !QtTransferredFresh(1000, 31001) &&
                 !QtTransferredFresh(1000, 999) && !QtTransferredFresh(0, 1000),
             "QT_TEST_TRANSFERRED_TOKEN_EXPIRY_NOT_REBASED_BY_NEW_HELPER");
        count++;
        for (int flags = 0; flags < 16; flags++)
        {
            bool foreground = (flags & 1) != 0, identities = (flags & 2) != 0, activity = (flags & 4) != 0,
                 keys = (flags & 8) != 0;
            string reason = QtRestoreSkipReason(foreground, identities, activity, keys);
            Need((reason == "conditions-satisfied") == QtCanRestore(foreground, identities, activity, keys),
                 "QT_TEST_RESTORE_DIAGNOSTIC_PRESERVES_CONDITIONS");
            count++;
        }
        var absent = Map(QtRestoreFocus(null, false));
        var unavailable = Map(Get(absent, "focusRestoreOutcome"));
        Need(Text(unavailable, "reason") == "lease-absent" && unavailable.Count == 9 &&
                 Get(unavailable, "foregroundOwnedByWechat") == null && Get(unavailable, "activityUnchanged") == null,
             "QT_TEST_ABSENT_LEASE_IS_NOT_A_FALSE_ACTIVITY_CLAIM");
        count++;
        var skipped = QtRestoreOutcome("keys-held", false, true, true, true, true, false);
        var interval =
            Data("phase", "preparation", "durationMs", 78L, "includesContactNavigation", false, "complete", false);
        var report =
            Data("restored", false, "skipped", true, "focusRestoreOutcome", skipped, "foregroundInterval", interval);
        try
        {
            QtNeedParkRestored(report, null);
            throw new Fault("QT_TEST_PARK_SKIP_WAS_ACCEPTED");
        }
        catch (Fault error)
        {
            Need(error.Message == "QT_FOCUS_RETURN_UNCONFIRMED" &&
                     Json.Serialize(QtFocusRestoreFailure(error)) == Json.Serialize(skipped) &&
                     Object.Equals(Get(Map(QtFocusTimingFailure(error)), "complete"), false),
                 "QT_TEST_PARK_SKIP_PRESERVES_ORIGIN_AND_TIMING");
        }
        count++;
        var restored = QtRestoreOutcome("restored", true, false, true, true, true, true);
        var complete =
            Data("phase", "preparation", "durationMs", 78L, "includesContactNavigation", false, "complete", true);
        var restoredReport =
            Data("restored", true, "skipped", false, "focusRestoreOutcome", restored, "foregroundInterval", complete);
        try
        {
            QtNeedParkRestored(restoredReport, false);
            throw new Fault("QT_TEST_PARK_ACTIVITY_WAS_ACCEPTED");
        }
        catch (Fault error)
        {
            var origin = Map(QtFocusRestoreFailure(error));
            Need(error.Message == "QT_FOCUS_RETURN_UNCONFIRMED" && Text(origin, "reason") == "park-activity-changed" &&
                     Object.Equals(Get(origin, "restored"), true) &&
                     Object.Equals(Get(origin, "parkRevisionUnchanged"), false) &&
                     Object.Equals(Get(Map(QtFocusTimingFailure(error)), "complete"), false),
                 "QT_TEST_PARK_POST_RETURN_ACTIVITY_PRESERVES_RETURN_SUCCESS");
        }
        count++;
        Need(Text(restored, "reason") == "restored" && Get(restored, "parkRevisionUnchanged") == null &&
                 Object.Equals(Get(complete, "complete"), true),
             "QT_TEST_PARK_DIAGNOSTIC_DOES_NOT_MUTATE_ORIGIN");
        count++;
        bool attempted = InputAttempted;
        QtNeedParkRestored(restoredReport, true);
        Need(InputAttempted == attempted, "QT_TEST_RESTORE_DIAGNOSTIC_NO_INPUT");
        count++;
        var partial = QtRestoreOutcome("identity-check-failed", null, false, true, null, true, null);
        Need(Get(partial, "restored") == null && Get(partial, "identitiesUnchanged") == null &&
                 Get(partial, "keysReleased") == null,
             "QT_TEST_UNCOMPLETED_CHECKS_REMAIN_UNKNOWN");
        foreach (var item in partial)
            Need(item.Key == "reason"    ? item.Value is string
                 : item.Key == "version" ? Object.Equals(item.Value, 1)
                                         : item.Value == null || item.Value is bool,
                 "QT_TEST_RESTORE_DIAGNOSTIC_NO_IDENTITIES_OR_TEXT");
        count++;
        return count;
    }
    static int QtCaptureSnapshotSelfTest()
    {
        int count = 0;
        Func<QtPopupLease> lease = delegate
        {
            return new QtPopupLease { Id = "search",
                                      Window = new IntPtr(21),
                                      Observed = true,
                                      Calibration = new QtPopupCalibration { Kind = "search",
                                                                             OwnerRelation = "same-thread-unowned" },
                                      Root = new Binding { Dpi = 120, Capture = new Rect(900, 100, 1676, 836) },
                                      ObservedBounds = new Rect(960, 179, 1420, 299),
                                      ObservedClient = new Rect(0, 0, 460, 120),
                                      ObservedClientScreen = new Rect(960, 179, 1420, 299) };
        };
        var originalLease = lease();
        var original = new QtPopupCaptureSnapshot(originalLease, new Rect(960, 179, 1420, 579),
                                                  new Rect(0, 0, 460, 400), new Point(960, 179), 120);
        Func<QtPopupCaptureSnapshot> same = delegate
        {
            return new QtPopupCaptureSnapshot(originalLease, new Rect(960, 179, 1420, 579), new Rect(0, 0, 460, 400),
                                              new Point(960, 179), 120);
        };
        QtNeedSamePopupCaptureSnapshot(original, same());
        Need(QtPopupGeometryAllowed(original.Bounds, original.Client, original.ClientScreen, originalLease),
             "QT_TEST_CAPTURE_SNAPSHOT_INITIAL_GEOMETRY");
        count++;
        var expanded = new QtPopupCaptureSnapshot(originalLease, new Rect(960, 179, 1420, 662),
                                                  new Rect(0, 0, 460, 483), new Point(960, 179), 120);
        Need(QtPopupGeometryAllowed(expanded.Bounds, expanded.Client, expanded.ClientScreen, originalLease),
             "QT_TEST_CAPTURE_SNAPSHOT_LATER_HEIGHT_INDIVIDUALLY_ALLOWED");
        Expect(delegate { QtNeedSamePopupCaptureSnapshot(original, expanded); }, "QT_POPUP_BINDING_CHANGED");
        count++;
        // Reproduce the reported 400px window/client with a later 483px
        // clientRectInRoot: one frozen tuple is used for both anchor and reply.
        var report = original.Report();
        Rect reportedClient = ParseRect(Get(report, "clientRect")),
             reportedRelative = ParseRect(Get(report, "clientRectInRoot"));
        Need(reportedClient.Height == 400 && reportedRelative.Height == 400 &&
                 Same(reportedRelative, original.Relative) &&
                 Same(ParseRect(Get(report, "windowRect")), original.Bounds),
             "QT_TEST_CAPTURE_REPORT_CANNOT_MIX_LATER_HEIGHT");
        count++;
        for (int change = 0; change < 10; change++)
        {
            QtPopupLease currentLease = originalLease;
            Rect bounds = original.Bounds, client = original.Client;
            Point origin = new Point(960, 179);
            uint dpi = 120;
            if (change == 0)
                bounds.Bottom++;
            else if (change == 1)
                client.Bottom++;
            else if (change == 2)
                origin.Y++;
            else if (change == 3)
                dpi = 144;
            else if (change == 4)
                currentLease = lease();
            else if (change == 5)
                originalLease.Window = new IntPtr(22);
            else if (change == 6)
                originalLease.Id = "profile";
            else if (change == 7)
                originalLease.Calibration.Kind = "profile";
            else if (change == 8)
                originalLease.Calibration.OwnerRelation = "root-owned";
            else
                originalLease.Root.Capture.Left++;
            var changed = new QtPopupCaptureSnapshot(currentLease, bounds, client, origin, dpi);
            Expect(delegate { QtNeedSamePopupCaptureSnapshot(original, changed); }, "QT_POPUP_BINDING_CHANGED");
            count++;
            // The emitted result cannot query the now-mutated lease either.
            var frozen = original.Report();
            Need(Text(frozen, "surfaceId") == "search" && Text(frozen, "kind") == "search" &&
                     Text(frozen, "hwnd") == "21" && Number(Get(frozen, "dpi")) == 120 &&
                     Same(ParseRect(Get(frozen, "clientRectInRoot")), original.Relative),
                 "QT_TEST_CAPTURE_REPORT_USES_IMMUTABLE_FIELDS");
            originalLease.Window = new IntPtr(21);
            originalLease.Id = "search";
            originalLease.Calibration.Kind = "search";
            originalLease.Calibration.OwnerRelation = "same-thread-unowned";
            originalLease.Root.Capture = new Rect(900, 100, 1676, 836);
        }
        string directory = Path.Combine(Path.GetTempPath(), "wechatagent-qt-capture-" + Guid.NewGuid().ToString("N"));
        Directory.CreateDirectory(directory);
        string failed = Path.Combine(directory, "failed.png"), success = Path.Combine(directory, "success.png"),
               existing = Path.Combine(directory, "existing.png"), partial = Path.Combine(directory, "partial.png"),
               uncreated = Path.Combine(directory, "uncreated.png");
        try
        {
            Expect(delegate{using(var image=new QtOwnedCaptureImage(failed)){image.Write(new byte[]{1,2,3});QtNeedSamePopupCaptureSnapshot(original,expanded);
        }
    },"QT_POPUP_BINDING_CHANGED");
    Need(!File.Exists(failed), "QT_TEST_CAPTURE_REFUSAL_REMOVES_OWNED_IMAGE");
    count++;
    using (var image = new QtOwnedCaptureImage(success))
    {
        image.Write(new byte[] { 1, 2, 3 });
        image.Transfer();
    }
    Need(File.Exists(success) && QtHash(File.ReadAllBytes(success)) == QtHash(new byte[] { 1, 2, 3 }),
         "QT_TEST_CAPTURE_SUCCESS_RETURNS_OWNED_IMAGE");
    count++;
    File.WriteAllBytes(existing, new byte[] { 7, 8, 9 });
    bool collision = false;
    try
    {
        using (var image = new QtOwnedCaptureImage(existing))
        {
            image.Write(new byte[] { 1, 2, 3 });
        }
    }
    catch (IOException)
    {
        collision = true;
    }
    Need(collision && QtHash(File.ReadAllBytes(existing)) == QtHash(new byte[] { 7, 8, 9 }),
         "QT_TEST_CAPTURE_CREATE_NEW_FAILURE_NEVER_DELETES_EXISTING");
    count++;
    bool writeFailed = false;
    try
    {
        using (var image = new QtOwnedCaptureImage(partial))
        {
            image.Write(null);
        }
    }
    catch (NullReferenceException)
    {
        writeFailed = true;
    }
    Need(writeFailed && !File.Exists(partial), "QT_TEST_CAPTURE_WRITE_FAILURE_REMOVES_ONLY_OWN_CREATED_FILE");
    count++;
    using (var image = new QtOwnedCaptureImage(uncreated))
    {
    }
    Need(!File.Exists(uncreated) && File.Exists(existing) && File.Exists(success),
         "QT_TEST_CAPTURE_NO_DIRECTORY_SCAN_OR_UNCREATED_DELETE");
    count++;
}
finally
{
    foreach (string file in new[] { failed, success, existing, partial, uncreated })
        if (File.Exists(file))
            File.Delete(file);
    Directory.Delete(directory);
}
return count;
}
static int QtEnterSelfTest()
{
    int count = 0;
    string savedSurface = QtSurface;
    var savedPopup = QtPopup;
    var savedPending = QtPendingPopup;
    var savedEnter = QtPendingEnter;
    try
    {
        Func<Binding> binding = delegate
        {
            return new Binding { Window = new IntPtr(20),
                                 Pid = 30,
                                 Created = 40,
                                 Thread = 50,
                                 Dpi = 120,
                                 Focus = new IntPtr(20),
                                 Caret = new IntPtr(20),
                                 FocusOwned = true,
                                 CaretOwned = true,
                                 GuiFlags = 1,
                                 CaretInClient = new Rect(125, 60, 127, 62),
                                 Client = new Rect(0, 0, 800, 600),
                                 Capture = new Rect(900, 100, 1700, 700) };
        };
        Rect query = new Rect(91, 53, 261, 87);
        var popup = new QtPopupLease {
            Id = "search",    Observed = true,         Calibration = new QtPopupCalibration { Kind = "search" },
            Root = binding(), Window = new IntPtr(21), Revision = 7
        };
        QtPopup = popup;
        QtPendingPopup = null;
        QtSurface = "observed-search";
        Func<QtFrame> frame = delegate
        {
            return new QtFrame { Binding = binding(),
                                 Revision = 7,
                                 Issued = 1000,
                                 PopupBounds = new Rect(960, 179, 1420, 299),
                                 PopupClient = new Rect(0, 0, 460, 120),
                                 Anchors =
                                     new List<QtAnchor> { new QtAnchor { Rect = query, Hash = new string('a', 64) } } };
        };
        Func<QtEnterProof> proof = delegate
        {
            return new QtEnterProof { Id = "fixture",  Kind = "search", Digest = new string('b', 64),
                                      Epoch = QtEpoch, Frame = frame(), Popup = popup };
        };
        Need(QtEnterProofMatches(proof(), "search", "fixture", new string('b', 64), frame(), 1001) &&
                 QtEnterCaret(binding(), query, 79),
             "QT_TEST_ENTER_SEARCH_PROOF_AND_ACTUAL_CARET");
        count++;
        for (int change = 0; change < 12; change++)
        {
            var p = proof();
            var f = frame();
            long now = 1001;
            string digest = new string('b', 64), name = "fixture", kind = "search";
            if (change == 0)
                p.Consumed = true;
            if (change == 1)
                p.Epoch = "other";
            if (change == 2)
                f.Revision++;
            if (change == 3)
                f.Binding.Thread++;
            if (change == 4)
                f.Binding.Focus = new IntPtr(99);
            if (change == 5)
                f.Anchors[0].Hash = new string('c', 64);
            if (change == 6)
                f.Anchors[0].Rect = new Rect(92, 53, 261, 87);
            if (change == 7)
                now = 31001;
            if (change == 8)
                now = 999;
            if (change == 9)
                digest = new string('d', 64);
            if (change == 10)
                name = "other";
            if (change == 11)
                kind = "text";
            Need(!QtEnterProofMatches(p, kind, name, digest, f, now), "QT_TEST_ENTER_CHANGED_PROOF_REFUSED");
            count++;
        }
        var prior = proof();
        QtPopup = new QtPopupLease();
        Need(!QtEnterProofMatches(prior, "search", "fixture", new string('b', 64), frame(), 1001),
             "QT_TEST_ENTER_REOPENED_LEASE_REFUSED");
        QtPopup = popup;
        count++;
        var resized = frame();
        resized.PopupBounds = new Rect(960, 179, 1420, 579);
        resized.PopupClient = new Rect(0, 0, 460, 400);
        Need(!QtEnterProofMatches(proof(), "search", "fixture", new string('b', 64), resized, 1001),
             "QT_TEST_ENTER_POSTPASTE_POPUP_CHANGED_REFUSED");
        count++;
        for (int change = 0; change < 8; change++)
        {
            var b = binding();
            if (change == 0)
                b.Caret = IntPtr.Zero;
            if (change == 1)
                b.CaretOwned = false;
            if (change == 2)
                b.FocusOwned = false;
            if (change == 3)
                b.Focus = new IntPtr(99);
            if (change == 4)
                b.GuiFlags = 0;
            if (change == 5)
                b.CaretInClient = new Rect(125, 78, 127, 80);
            if (change == 6)
                b.CaretInClient = new Rect(90, 60, 92, 62);
            if (change == 7)
                b.CaretInClient = new Rect(125, 60, 125, 62);
            Need(!QtEnterCaret(b, query, 79), "QT_TEST_ENTER_INVALID_CARET_REFUSED");
            count++;
        }
        QtSurface = "main";
        QtPopup = null;
        var textFrame = frame();
        textFrame.Anchors =
            new List<QtAnchor> { new QtAnchor { Rect = new Rect(300, 20, 780, 70), Hash = new string('a', 64) },
                                 new QtAnchor { Rect = new Rect(300, 400, 780, 550), Hash = new string('b', 64) } };
        var textProof = new QtEnterProof { Id = "text", Kind = "text", Digest = new string('c', 64), Epoch = QtEpoch,
                                           Frame = textFrame };
        QtNeedTextAnchors(textFrame, textFrame.Anchors[0].Rect, textFrame.Anchors[1].Rect);
        Need(QtEnterProofMatches(textProof, "text", "text", new string('c', 64), textFrame, 1001),
             "QT_TEST_ENTER_VERIFIED_TEXT_ONLY");
        count++;
        var copied = frame();
        copied.Anchors =
            new List<QtAnchor> { new QtAnchor { Rect = textFrame.Anchors[0].Rect, Hash = textFrame.Anchors[0].Hash },
                                 new QtAnchor { Rect = textFrame.Anchors[1].Rect, Hash = textFrame.Anchors[1].Hash } };
        Need(QtEnterProofMatches(textProof, "text", "text", new string('c', 64), copied, 1001),
             "QT_TEST_ENTER_FRESH_SAME_PIXELS_ALLOWED");
        count++;
        copied.Anchors[1].Hash = new string('d', 64);
        Need(!QtEnterProofMatches(textProof, "text", "text", new string('c', 64), copied, 1001),
             "QT_TEST_ENTER_CHANGED_DRAFT_PIXELS_REFUSED");
        count++;
        textProof.InputOnly = true;
        Need(QtEnterProofMatches(textProof, "text", "text", new string('c', 64), copied, 1001),
             "QT_TEST_UNCHECKED_PASTE_NO_BODY_PIXEL_RECHECK");
        count++;
        copied.Revision++;
        Need(!QtEnterProofMatches(textProof, "text", "text", new string('c', 64), copied, 1001),
             "QT_TEST_UNCHECKED_PASTE_HUMAN_INTERRUPT_STILL_STOPS");
        copied.Revision--;
        count++;
        copied.Binding.Window = new IntPtr(99);
        Need(!QtEnterProofMatches(textProof, "text", "text", new string('c', 64), copied, 1001),
             "QT_TEST_UNCHECKED_PASTE_STAYS_IN_ORIGINAL_WINDOW");
        copied.Binding.Window = textFrame.Binding.Window;
        count++;
        textProof.Consumed = true;
        Need(!QtEnterProofMatches(textProof, "text", "text", new string('c', 64), copied, 1001),
             "QT_TEST_UNCHECKED_PASTE_CANNOT_REPEAT_ENTER");
        textProof.Consumed = false;
        textProof.InputOnly = false;
        count++;
        copied.Anchors[1].Hash = textFrame.Anchors[1].Hash;
        copied.Anchors[0].Hash = new string('d', 64);
        Need(!QtEnterProofMatches(textProof, "text", "text", new string('c', 64), copied, 1001),
             "QT_TEST_ENTER_CHANGED_CHAT_HEADER_REFUSED");
        count++;
        var editorBinding = binding();
        editorBinding.CaretInClient = new Rect(320, 420, 322, 422);
        Need(QtEnterCaret(editorBinding, textFrame.Anchors[1].Rect, null) &&
                 !QtEnterCaret(binding(), textFrame.Anchors[1].Rect, null),
             "QT_TEST_ENTER_EDITOR_CARET_NOT_SEARCH_CARET");
        count++;
        Rect editor = textFrame.Anchors[1].Rect;
        Func<Binding> editorFocus = delegate
        {
            var b = binding();
            b.CaretInClient = new Rect(320, 420, 322, 422);
            return b;
        };
        Func<Binding> absentFocus = delegate
        {
            var b = binding();
            b.Caret = IntPtr.Zero;
            b.CaretOwned = false;
            b.GuiFlags = 0;
            b.CaretInClient = new Rect(0, 0, 0, 0);
            return b;
        };
        var hidden = editorFocus();
        hidden.GuiFlags = 0;
        Need(QtTextEnterFocus(editorFocus(), hidden, editor) && QtTextEnterFocus(hidden, editorFocus(), editor),
             "QT_TEST_TEXT_ENTER_CARET_VISIBILITY_NOT_FOCUS");
        count++;
        Need(QtTextEnterFocus(absentFocus(), absentFocus(), editor) &&
                 QtTextEnterFocus(absentFocus(), editorFocus(), editor),
             "QT_TEST_TEXT_ENTER_PROVEN_ZERO_CARET_TUPLE");
        count++;
        Need(!QtTextEnterFocus(editorFocus(), absentFocus(), editor), "QT_TEST_TEXT_ENTER_NEWLY_ABSENT_CARET_REFUSED");
        count++;
        for (int change = 0; change < 13; change++)
        {
            var beforeFocus = absentFocus();
            var afterFocus = absentFocus();
            if (change == 0)
                beforeFocus.FocusOwned = false;
            if (change == 1)
                afterFocus.FocusOwned = false;
            if (change == 2)
                afterFocus.Focus = new IntPtr(99);
            if (change == 3)
                afterFocus.Thread++;
            if (change == 4)
                afterFocus.Pid++;
            if (change == 5)
                afterFocus.GuiFlags = 1;
            if (change == 6)
                afterFocus.CaretOwned = true;
            if (change == 7)
                afterFocus.CaretInClient = new Rect(0, 0, 1, 0);
            if (change == 8)
                afterFocus.Caret = new IntPtr(99);
            if (change == 9)
                beforeFocus.GuiFlags = 4;
            if (change == 10)
                beforeFocus.CaretInClient = query;
            if (change == 11)
                afterFocus.GuiFlags = 2;
            if (change == 12)
                beforeFocus.Caret = new IntPtr(99);
            Need(!QtTextEnterFocus(beforeFocus, afterFocus, editor), "QT_TEST_TEXT_ENTER_CONTRADICTORY_FOCUS_REFUSED");
            count++;
        }
        Need(!QtTextEnterFocus(editorFocus(), binding(), editor) && !QtTextEnterFocus(binding(), editorFocus(), editor),
             "QT_TEST_TEXT_ENTER_QUERY_CARET_REFUSED");
        count++;
        for (uint flag = 2; flag <= 16; flag *= 2)
        {
            var menu = editorFocus();
            menu.GuiFlags = flag;
            Need(!QtTextEnterFocus(editorFocus(), menu, editor), "QT_TEST_TEXT_ENTER_MENU_OR_MOVE_REFUSED");
            count++;
        }
        var diagnostic = Map(QtEnterFocusFailure(QtEnterFocusRefusal("text", editorFocus(), binding(), editor)));
        Need(diagnostic.Count == 7 && Object.Equals(diagnostic["proofVerified"], true) &&
                 Map(diagnostic["source"]).Count == 8 && Map(diagnostic["current"]).Count == 8 &&
                 !diagnostic.ContainsKey("text") && !Map(diagnostic["source"]).ContainsKey("hwnd"),
             "QT_TEST_TEXT_ENTER_ANONYMOUS_DIAGNOSTIC");
        count++;
        Expect(delegate { QtNeedTextAnchors(textFrame, textFrame.Anchors[1].Rect, textFrame.Anchors[0].Rect); },
               "QT_TEXT_ENTER_ANCHORS_REQUIRED");
        count++;
        var draftSource = frame();
        draftSource.Anchors = new List<QtAnchor> { textFrame.Anchors[0] };
        QtNeedDraftSource(draftSource, textFrame.Anchors[0].Rect, textFrame.Anchors[1].Rect);
        count++;
        Expect(delegate { QtNeedTextAnchors(draftSource, textFrame.Anchors[0].Rect, textFrame.Anchors[1].Rect); },
               "QT_TEXT_ENTER_ANCHORS_REQUIRED");
        count++;
        Expect(delegate { QtNeedDraftSource(draftSource, new Rect(301, 20, 780, 70), textFrame.Anchors[1].Rect); },
               "QT_TEXT_ENTER_ANCHORS_REQUIRED");
        count++;
        QtSurface = "observed-search";
        Expect(delegate { QtNeedDraftSource(draftSource, textFrame.Anchors[0].Rect, textFrame.Anchors[1].Rect); },
               "QT_TEXT_ENTER_ANCHORS_REQUIRED");
        QtSurface = "main";
        count++;
        Need(QtHash(Encoding.UTF8.GetBytes(QtNormalizeText("a\r\nb\rc"))) == QtHash(Encoding.UTF8.GetBytes("a\nb\nc")),
             "QT_TEST_ENTER_RECOVERED_CRLF_DIGEST_NORMALIZED");
        count++;
        var stepPacket = Data("version", 1, "deliveryId", new string('a', 64), "accountSha256", new string('b', 64),
                              "targetSha256", new string('c', 64));
        var step = QtParseTextStep(stepPacket);
        Need(QtSameTextStep(step, QtParseTextStep(stepPacket)) && QtSameTextStep(null, null) &&
                 !QtSameTextStep(step, null),
             "QT_TEST_TEXT_STEP_EXACT_BINDING");
        count++;
        Need(QtTypedTextEvents("\u597d", null).Length == 2 && QtTypedTextEvents("\ud83d\ude0a", null).Length == 4 &&
                 QtTypedTextEvents("\ud83d\udc69\u200d\ud83d\udcbb", null).Length == 10,
             "QT_TEST_TYPED_GRAPHEME_EVENTS");
        count++;
        var newline = QtTypedTextEvents("\n", "Shift+Enter");
        Need(newline.Length == 4 && newline[0].Value.Keyboard.Key == 0x10 && newline[1].Value.Keyboard.Key == 0x0d &&
                 newline[2].Value.Keyboard.Flags == 2 && newline[3].Value.Keyboard.Flags == 2,
             "QT_TEST_TYPED_NEWLINE_NOT_SUBMIT");
        count++;
        Expect(delegate { QtTypedTextEvents("\n", null); }, "QT_NEWLINE_CALIBRATION_REQUIRED");
        count++;
        Expect(delegate { QtTypedTextEvents("ab", null); }, "DRAFT_APPEND_NOT_SINGLE_GRAPHEME");
        count++;
        var typedFrame = new QtFrame { Binding = textFrame.Binding, Revision = textFrame.Revision, Issued = UtcMs(),
                                       Anchors = textFrame.Anchors };
        var typedProof =
            new QtEnterProof { Id = "typed",    Kind = "text",      Digest = QtHash(Encoding.UTF8.GetBytes("\u4f60")),
                               Epoch = QtEpoch, Frame = typedFrame, Step = step,
                               InputOnly = true };
        Need(QtTypedPrefixMatches(null, step, "\u4f60", "\u4f60", typedFrame, null) &&
                 QtTypedPrefixMatches(typedProof, step, "\u597d", "\u4f60\u597d", typedFrame, "typed"),
             "QT_TEST_TYPED_PREFIX_CONTINUATION");
        count++;
        Need(!QtTypedPrefixMatches(null, step, "\u597d", "\u4f60\u597d", typedFrame, null) &&
                 !QtTypedPrefixMatches(typedProof, step, "\u597d", "\u4ed6\u597d", typedFrame, "typed") &&
                 !QtTypedPrefixMatches(typedProof, step, "\u597d", "\u4f60\u597d", typedFrame, "other"),
             "QT_TEST_TYPED_PREFIX_NOT_FORGED");
        count++;
        typedProof.Paused = true;
        Need(!QtTypedPrefixMatches(typedProof, step, "\u597d", "\u4f60\u597d", typedFrame, "typed"),
             "QT_TEST_TYPED_PAUSE_NEEDS_RESUME");
        count++;
        var readFrame = new QtFrame { Binding = typedFrame.Binding, Revision = typedFrame.Revision,
                                      Anchors = new List<QtAnchor> { typedFrame.Anchors[0] } };
        var typedRequest = Data("textEnterProofId", typedProof.Id, "textSha256", typedProof.Digest);
        typedProof.Paused = false;
        QtPendingEnter = typedProof;
        var beforeReadback =
            QtRequireDraftReadbackProof(typedRequest, readFrame, typedFrame.Anchors[0].Rect, editor, step);
        var verified = new QtEnterProof { Id = typedProof.Id, Kind = "text",      Digest = typedProof.Digest,
                                          Epoch = QtEpoch,    Frame = typedFrame, Step = step };
        Need(Object.ReferenceEquals(beforeReadback, typedProof), "QT_TEST_READBACK_REQUIRES_ORIGINAL_PROOF");
        count++;
        bool savedInput = QtEnableInput;
        try
        {
            QtEnableInput = false;
            Expect(delegate { QtAct(Data(), "movePointer"); }, "QT_INPUT_DISABLED");
            Expect(delegate { QtReadDraft(new QtClipboardOperation(), Data(), IntPtr.Zero); }, "QT_INPUT_DISABLED");
            Expect(delegate { QtPaste(new QtClipboardOperation(), Data(), IntPtr.Zero); }, "QT_INPUT_DISABLED");
            Expect(delegate { QtPasteWithoutReadback(new QtClipboardOperation(), Data(), IntPtr.Zero); },
                   "QT_INPUT_DISABLED");
            Need(Object.ReferenceEquals(QtPendingEnter, beforeReadback) && !beforeReadback.Consumed,
                 "QT_TEST_REFUSED_NONMUTATING_ACTIONS_KEEP_PROOF");
            count++;
        }
        finally
        {
            QtEnableInput = savedInput;
        }
        QtPublishEnterProof(verified, beforeReadback);
        Need(Object.ReferenceEquals(QtPendingEnter, verified) && verified.Id == beforeReadback.Id &&
                 beforeReadback.Consumed && !verified.Consumed && !verified.InputOnly,
             "QT_TEST_VERIFIED_READBACK_COMMITS_SAME_PROOF_ID");
        count++;
        var interruptedReadback =
            QtRequireDraftReadbackProof(typedRequest, readFrame, typedFrame.Anchors[0].Rect, editor, step);
        var staleResult = new QtEnterProof { Id = verified.Id, Kind = "text",      Digest = verified.Digest,
                                             Epoch = QtEpoch,  Frame = typedFrame, Step = step };
        QtRevokeEnter();
        Expect(delegate { QtPublishEnterProof(staleResult, interruptedReadback); }, "QT_TEXT_STEP_REVOKED");
        Need(QtPendingEnter == null, "QT_TEST_READBACK_CANNOT_REVIVE_REVOKED_PROOF");
        count += 2;
        QtPendingEnter = proof();
        var other = QtPendingEnter;
        Expect(delegate { QtPublishEnterProof(staleResult, interruptedReadback); }, "QT_TEXT_STEP_REVOKED");
        Need(Object.ReferenceEquals(QtPendingEnter, other) && !other.Consumed,
             "QT_TEST_READBACK_CANNOT_REPLACE_NEW_PROOF");
        count += 2;
        for (int change = 0; change < 5; change++)
        {
            var invalid = new Dictionary<string, object>(stepPacket);
            if (change == 0)
                invalid["version"] = 2;
            if (change == 1)
                invalid["deliveryId"] = "plain job";
            if (change == 2)
                invalid["accountSha256"] = new string('B', 64);
            if (change == 3)
                invalid.Remove("targetSha256");
            if (change == 4)
                invalid.Add("allowSend", true);
            Expect(delegate { QtParseTextStep(invalid); }, "QT_TEXT_STEP_INVALID");
            count++;
        }
        Func<QtEnterProof> pausedProof = delegate
        {
            return new QtEnterProof { Id = "paused",   Kind = "text",     Digest = new string('c', 64),
                                      Epoch = QtEpoch, Frame = textFrame, Step = QtParseTextStep(stepPacket),
                                      Paused = true };
        };
        Func<QtFrame> resumedFrame = delegate
        {
            return new QtFrame { Binding = editorFocus(), Revision = 107, Issued = 90000,
                                 Anchors = new List<QtAnchor> { new QtAnchor { Rect = textFrame.Anchors[0].Rect,
                                                                               Hash = textFrame.Anchors[0].Hash },
                                                                new QtAnchor { Rect = editor,
                                                                               Hash = new string('f', 64) } } };
        };
        Need(QtTextResumeMatches(pausedProof(), step, "paused", new string('c', 64), resumedFrame(),
                                 textFrame.Anchors[0].Rect, editor),
             "QT_TEST_TEXT_STEP_CONTINUES_NEW_REVISION_WITHOUT_READING_DRAFT");
        count++;
        for (int change = 0; change < 16; change++)
        {
            var p = pausedProof();
            var f = resumedFrame();
            var s = QtParseTextStep(stepPacket);
            string name = "paused", d = new string('c', 64);
            Rect h = textFrame.Anchors[0].Rect, e = editor;
            if (change == 0)
                p.Consumed = true;
            if (change == 1)
                p.Paused = false;
            if (change == 2)
                p.Kind = "search";
            if (change == 3)
                s.Delivery = new string('d', 64);
            if (change == 4)
                s.Account = new string('d', 64);
            if (change == 5)
                s.Target = new string('d', 64);
            if (change == 6)
                f.Binding.Window = new IntPtr(99);
            if (change == 7)
                f.Binding.Pid++;
            if (change == 8)
                f.Binding.Thread++;
            if (change == 9)
                f.Binding.Created++;
            if (change == 10)
                f.Binding.Dpi++;
            if (change == 11)
                f.Anchors[0].Hash = new string('d', 64);
            if (change == 12)
                name = "other";
            if (change == 13)
                d = new string('d', 64);
            if (change == 14)
                e = new Rect(301, 400, 780, 550);
            if (change == 15)
                f.Binding.Capture = new Rect(901, 100, 1701, 700);
            Need(!QtTextResumeMatches(p, s, name, d, f, h, e), "QT_TEST_TEXT_STEP_CHANGED_CONTEXT_REFUSED");
            count++;
        }
        QtPendingEnter = pausedProof();
        QtPendingEnter.Paused = false;
        QtPauseTextEnter();
        Need(QtPendingEnter.Paused && !QtPendingEnter.Consumed, "QT_TEST_TEXT_FOCUS_HANDOFF_PAUSES_PROOF");
        count++;
        var noStep = pausedProof();
        noStep.Step = null;
        QtPendingEnter = noStep;
        QtPauseTextEnter();
        Need(QtPendingEnter == null && noStep.Consumed, "QT_TEST_LEGACY_PROOF_NOT_RESUMABLE");
        count++;
        var searchProof = pausedProof();
        searchProof.Kind = "search";
        QtPendingEnter = searchProof;
        QtPauseTextEnter();
        Need(QtPendingEnter == null && searchProof.Consumed, "QT_TEST_SEARCH_INTERRUPTION_RESTARTS_SEARCH");
        count++;
        var refusal = pausedProof();
        QtPendingEnter = null;
        QtFinishEnterAttempt(refusal, true, false);
        Need(Object.ReferenceEquals(QtPendingEnter, refusal) && refusal.Paused && !refusal.Consumed,
             "QT_TEST_DEFINITE_PREINPUT_ENTER_REFUSAL_RETAINED");
        count++;
        var attemptedProof = pausedProof();
        QtPendingEnter = null;
        QtFinishEnterAttempt(attemptedProof, true, true);
        Need(attemptedProof.Consumed && QtPendingEnter == null, "QT_TEST_UNKNOWN_ENTER_CANNOT_RESUME");
        count++;
        var enteredProof = pausedProof();
        QtPendingEnter = null;
        QtFinishEnterAttempt(enteredProof, false, true);
        Need(enteredProof.Consumed && QtPendingEnter == null, "QT_TEST_PERFORMED_ENTER_SINGLE_USE");
        count++;
        Need(!QtEnterProofMatches(pausedProof(), "text", "paused", new string('c', 64), textFrame, 1001),
             "QT_TEST_PAUSED_PROOF_NEVER_DIRECT_ENTER_AUTHORITY");
        count++;
        QtPendingEnter = textProof;
        QtRevokeEnter();
        Need(QtPendingEnter == null && textProof.Consumed &&
                 !QtEnterProofMatches(textProof, "text", "text", new string('c', 64), textFrame, 1001),
             "QT_TEST_ENTER_SINGLE_USE_REVOKED");
        count++;
        Expect(delegate { QtChord("Enter"); }, "QT_CHORD_FORBIDDEN");
        count++;
    }
    finally
    {
        QtSurface = savedSurface;
        QtPopup = savedPopup;
        QtPendingPopup = savedPending;
        QtPendingEnter = savedEnter;
    }
    return count;
}
static int QtUiaNavigationSelfTest()
{
    int checks = 0;
    var lease = new QtFocusLease { Wechat = new WindowIdentity(new IntPtr(42), 7, 123),
                                   Revision = Interlocked.Read(ref Revision) };
    var frame = new QtFrame { Binding = new Binding { Window = new IntPtr(42), Pid = 7, Created = 123 },
                              NavigationOnly = true, NavigationLease = lease };
    Need(QtNavigationLeaseMatches(frame, lease), "QT_TEST_UIA_LEASE_MATCH");
    checks++;
    QtFramePurpose(frame, true);
    Expect(delegate { QtFramePurpose(frame, false); }, "QT_OBSERVATION_PURPOSE_INVALID");
    checks++;
    var ordinary = new QtFrame();
    QtFramePurpose(ordinary, false);
    Expect(delegate { QtFramePurpose(ordinary, true); }, "QT_OBSERVATION_PURPOSE_INVALID");
    checks++;
    Need(!QtNavigationLeaseMatches(frame, new QtFocusLease { Wechat = lease.Wechat }) &&
             !QtNavigationLeaseMatches(ordinary, lease),
         "QT_TEST_UIA_LEASE_EXACT_OWNER");
    checks++;
    foreach (int field in new[] { 0, 1, 2 })
    {
        var changed = new QtFrame { NavigationOnly = true, NavigationLease = lease,
                                    Binding = new Binding { Window = new IntPtr(field == 0 ? 43 : 42),
                                                            Pid = (uint)(field == 1 ? 8 : 7),
                                                            Created = field == 2 ? 124 : 123 } };
        Need(!QtNavigationLeaseMatches(changed, lease), "QT_TEST_UIA_BINDING_CHANGED");
        checks++;
    }
    bool enabled = QtEnableInput, stopping = Stopping, attempted = InputAttempted;
    var focus = new QtFocusSession.Fixture(QtFocus);
    var popup = QtPopup;
    var pending = QtPendingPopup;
    string surface = QtSurface;
    var current = QtCurrent;
    try
    {
        for (int invalid = 0; invalid < 7; invalid++)
        {
            QtEnableInput = true;
            Stopping = false;
            InputAttempted = false;
            focus.Arrange(invalid == 2 ? null : lease, invalid == 3 ? lease : null);
            QtPopup = null;
            QtPendingPopup = null;
            QtSurface = "main";
            QtCurrent = frame;
            if (invalid == 0)
                QtEnableInput = false;
            if (invalid == 1)
                Stopping = true;
            if (invalid == 4)
                QtPopup = new QtPopupLease();
            if (invalid == 5)
                QtPendingPopup = new QtPopupLease();
            if (invalid == 6)
                QtSurface = "search";
            Expect(delegate { QtCaptureUiaNavigation(Data()); }, "QT_UIA_NAVIGATION_UNAVAILABLE");
            Need(!InputAttempted, "QT_TEST_UIA_CAPTURE_REFUSAL_NO_INPUT");
            checks++;
        }
        QtEnableInput = true;
        Stopping = false;
        InputAttempted = false;
        focus.Arrange(lease);
        QtPopup = null;
        QtPendingPopup = null;
        QtSurface = "main";
        QtCurrent = frame;
        foreach (var request in new[] { Data("surface", "main", "image", true, "regions", new object[] { Data() }),
                                        Data("surface", "search", "image", false, "regions", new object[] { Data() }),
                                        Data("surface", "main", "image", false, "regions", new object[0]),
                                        Data("surface", "main", "image", false, "regions", new object[] { Data() },
                                             "allowInput", true) })
        {
            Expect(delegate { QtCaptureUiaNavigation(request); }, "QT_UIA_NAVIGATION_REQUEST_INVALID");
            Need(!InputAttempted, "QT_TEST_UIA_INVALID_CAPTURE_NO_INPUT");
            checks++;
        }
        frame.Anchors = new List<QtAnchor> { new QtAnchor() };
        foreach (var request in new[] { Data("key", "Enter"), Data("rect", Data()),
                                        Data("popupTransition", Data("id", "profile")) })
        {
            Expect(delegate { QtOpenUiaSearch(request); }, "QT_UIA_NAVIGATION_REQUEST_INVALID");
            Need(!InputAttempted, "QT_TEST_UIA_INVALID_ACTION_NO_INPUT");
            checks++;
        }
        foreach (var request in new[] { Data("key", "Enter"), Data("rect", Data()),
                                        Data("popupTransition", Data("id", "search")) })
        {
            Expect(delegate { QtFocusUiaEditor(request); }, "QT_UIA_NAVIGATION_REQUEST_INVALID");
            Need(!InputAttempted, "QT_TEST_UIA_INVALID_EDITOR_NO_INPUT");
            checks++;
        }
        QtCurrent = ordinary;
        Expect(delegate { QtOpenUiaSearch(Data()); }, "QT_OBSERVATION_PURPOSE_INVALID");
        checks++;
        Expect(delegate { QtFocusUiaEditor(Data()); }, "QT_OBSERVATION_PURPOSE_INVALID");
        checks++;
        var client = new Rect(0, 0, 1080, 1848);
        var header = new Rect(385, 48, 1073, 120);
        Need(QtUiaEditorRegion(new Rect(385, 1550, 1073, 1800), header, client), "QT_TEST_UIA_EDITOR_REGION");
        checks++;
        foreach (var rect in new[] { new Rect(385, 48, 1073, 120), new Rect(385, 900, 1073, 1000),
                                     new Rect(-1, 1550, 1073, 1800), new Rect(385, 1550, 1081, 1800),
                                     new Rect(385, 1550, 390, 1800), new Rect(385, 1550, 1073, 1551) })
        {
            Need(!QtUiaEditorRegion(rect, header, client), "QT_TEST_UIA_EDITOR_REGION_REJECT");
            checks++;
        }
    }
    finally
    {
        QtEnableInput = enabled;
        Stopping = stopping;
        InputAttempted = attempted;
        focus.Dispose();
        QtPopup = popup;
        QtPendingPopup = pending;
        QtSurface = surface;
        QtCurrent = current;
    }
    return checks;
}
static int QtUiaControlFrameSelfTest()
{
    int n = 0;
    var focus = new QtFocusSession.Fixture(QtFocus);
    var savedPopup = QtPopup;
    var savedPending = QtPendingPopup;
    string savedSurface = QtSurface;
    try
    {
        var lease = new QtFocusLease { Wechat = new WindowIdentity(new IntPtr(42), 7, 123), Revision = 5 };
        focus.Arrange(lease);
        QtPopup = null;
        QtPendingPopup = null;
        QtSurface = "main";
        Func<string, QtFrame> frame = delegate(string hash)
        {
            return new QtFrame {
                Binding = new Binding { Window = new IntPtr(42), Pid = 7, Created = 123, Thread = 8,
                                        Client = new Rect(0, 0, 800, 600), Capture = new Rect(0, 0, 800, 600) },
                Revision = 5, Issued = 1,
                Anchors =
                    new List<QtAnchor> { new QtAnchor { Rect = new Rect(300, 10, 780, 60), Hash = hash },
                                         new QtAnchor { Rect = new Rect(300, 450, 780, 550), Hash = "editor" } }
            };
        };
        var source = frame("before");
        var current = frame("after");
        var report = Data();
        Need(!source.UiaControlFrame && !QtUiaInputHeader(source, "text", true, lease),
             "QT_TEST_UIA_ORDINARY_FRAME_UNMARKED");
        n++;
        QtMarkUiaControlFrame(source, lease, report);
        Need(Object.Equals(Get(report, "uiaControlFrame"), true) && QtUiaInputHeader(source, "text", true, lease),
             "QT_TEST_UIA_CONTROL_INTERNAL_SOURCE");
        n++;
        Need(QtAttachTextHeaderMatches(source, current, true, lease) &&
                 !QtAttachTextHeaderMatches(source, current, false, lease),
             "QT_TEST_UIA_ONLY_INPUT_HEADER_ANIMATION");
        n++;
        Need(!QtAttachTextHeaderMatches(frame("before"), current, true, lease) &&
                 !QtUiaInputHeader(source, "search", true, lease),
             "QT_TEST_UIA_ORDINARY_AND_SEARCH_NOT_DOWNGRADED");
        n++;
        source.NavigationOnly = true;
        Need(!QtUiaInputHeader(source, "text", true, lease), "QT_TEST_UIA_NAVIGATION_NOT_INPUT_AUTHORITY");
        source.NavigationOnly = false;
        n++;
        foreach (var request in new[] { Data("uiaControlFrame", true), Data("uiaControlFrame", false),
                                        Data("uiaControlLease", Data()) })
        {
            Expect(delegate { QtRejectFrameAuthority(request); }, "QT_UIA_CONTROL_FRAME_INVALID");
            n++;
        }
        QtRejectFrameAuthority(Data());
        n++;
        QtMarkUiaControlFrame(current, lease, Data());
        var proof = new QtEnterProof { Id = "fixture",  Kind = "text",  Digest = "digest",
                                       Epoch = QtEpoch, Frame = source, InputOnly = true };
        Need(QtEnterProofMatches(proof, "text", "fixture", "digest", current, 2),
             "QT_TEST_UIA_PROOF_RETAINS_INTERNAL_SOURCE");
        n++;
        Need(!QtEnterProofMatches(proof, "text", "fixture", "digest", frame("after"), 2),
             "QT_TEST_UIA_PROOF_CANNOT_STRIP_SOURCE");
        n++;
        focus.Arrange(null);
        Expect(delegate { QtCheckUiaControlLease(source); }, "QT_UIA_CONTROL_FRAME_INVALID");
        Need(!QtEnterProofMatches(proof, "text", "fixture", "digest", current, 2),
             "QT_TEST_UIA_CLEARED_LEASE_PROOF_REFUSED");
        n++;
        focus.Arrange(new QtFocusLease { Wechat = lease.Wechat, Revision = lease.Revision });
        Expect(delegate { QtCheckUiaControlLease(source); }, "QT_UIA_CONTROL_FRAME_INVALID");
        Need(!QtAttachTextHeaderMatches(source, current, true, QtFocus.Active) &&
                 !QtEnterProofMatches(proof, "text", "fixture", "digest", current, 2),
             "QT_TEST_UIA_REPLACED_LEASE_REFUSED");
        n++;
        focus.Arrange(lease, lease);
        Expect(delegate { QtCheckUiaControlLease(source); }, "QT_UIA_CONTROL_FRAME_INVALID");
        focus.Arrange(lease);
        n++;
        foreach (int changed in new[] { 0, 1, 2, 3 })
        {
            var invalid = frame("before");
            invalid.UiaControlFrame = true;
            invalid.UiaControlLease = lease;
            if (changed == 0)
                invalid.Binding.Window = new IntPtr(43);
            if (changed == 1)
                invalid.Binding.Pid = 8;
            if (changed == 2)
                invalid.Binding.Created = 124;
            if (changed == 3)
                invalid.Revision = 6;
            Need(!QtUiaControlLeaseMatches(invalid, lease), "QT_TEST_UIA_CONTROL_BINDING_CHANGED");
            n++;
        }
        current.Anchors[0].Rect = new Rect(301, 10, 780, 60);
        Need(!QtAttachTextHeaderMatches(source, current, true, lease), "QT_TEST_UIA_HEADER_REGION_STILL_EXACT");
        n++;
    }
    finally
    {
        focus.Dispose();
        QtPopup = savedPopup;
        QtPendingPopup = savedPending;
        QtSurface = savedSurface;
    }
    return n;
}
static int QtSelfTest()
{
    int count = 0;
    try
    {
        count += QtForegroundSessionSelfTest();
        count += QtUiaControlFrameSelfTest();
        count += QtUiaGeometrySelfTest();
        count += QtUiaControlsSelfTest();
        count += QtUiaPointerSelfTest();
        count += QtUiaNavigationSelfTest();
        count += QtImageSelfTest();
        count += QtEnterSelfTest();
        count += QtQuoteSelfTest();
        count += QtCaptureSnapshotSelfTest();
        count += QtLayoutHandoffSelfTest();
        count += QtLayoutRaisedSelfTest();
        count += QtReturnCaptionSelfTest();
        foreach (string action in new[] { "paste", "typeText", "click", "chord", "submitTextEnter",
                                          "attachMessageQuote", "beginFocusHandoff", "inspectClipboard" })
        {
            Need(!QtLayoutOnlyAction(action), "QT_TEST_LAYOUT_ONLY_DENIES_CHAT_ACTIONS");
            count++;
        }
        foreach (string action in new[] { "inspectLayout", "captureLayout", "captureLayoutHandoff",
                                          "captureLayoutRaised", "stop" })
        {
            Need(QtLayoutOnlyAction(action), "QT_TEST_LAYOUT_ONLY_CAPTURE_AND_CLEANUP");
            count++;
        }
        count += QtFocusRestoreDiagnosticSelfTest();
        count += QtEmptyTimingSelfTest();
        count += QtInitialEmptyTemplateSelfTest();
        count += QtEmptyPhaseSelfTest();
        var timingLease = new QtFocusLease { ForegroundStarted = Now() - 50, IncludesContactNavigation = true };
        var timingSuccess = Map(QtFocusRestoreReport(Data("restored", true, "skipped", false), timingLease, true));
        var timingComplete = Map(Get(timingSuccess, "foregroundInterval"));
        Need(Object.Equals(Get(timingComplete, "complete"), true) &&
                 Text(timingComplete, "phase") == "contact-navigation" &&
                 Number(Get(timingComplete, "durationMs")) >= 50,
             "QT_TEST_FOCUS_SUCCESS_COMPLETE_TIMING");
        count++;
        var timingSkipped = Map(QtFocusRestoreReport(Data("restored", false, "skipped", true), timingLease, false));
        Need(Object.Equals(Get(Map(Get(timingSkipped, "foregroundInterval")), "complete"), false) &&
                 Object.Equals(Get(timingSkipped, "skipped"), true),
             "QT_TEST_SKIPPED_FOCUS_TIMING_INCOMPLETE");
        count++;
        var timingError = new Fault("QT_FOCUS_RETURN_UNCONFIRMED");
        QtMarkFocusTimingFailure(timingError, timingLease);
        var timingFailed = Map(QtFocusTimingFailure(timingError));
        Need(Object.Equals(Get(timingFailed, "complete"), false) &&
                 Text(timingFailed, "phase") == "contact-navigation" &&
                 timingError.Message == "QT_FOCUS_RETURN_UNCONFIRMED",
             "QT_TEST_FOCUS_EXCEPTION_TIMING_INCOMPLETE");
        count++;
        Need(QtForegroundInterval(null, false) == null && QtForegroundInterval(new QtFocusLease(), false) == null &&
                 !Map(QtFocusRestoreReport(Data("restored", false, "skipped", true), null, false))
                      .ContainsKey("foregroundInterval"),
             "QT_TEST_NO_LEASE_NO_INVENTED_TIMING");
        count++;
        var untimedError = new Fault("QT_FOCUS_RETURN_UNCONFIRMED");
        QtMarkFocusTimingFailure(untimedError, new QtFocusLease());
        Need(QtFocusTimingFailure(untimedError) == null, "QT_TEST_UNTIMED_ERROR_NO_INVENTED_TIMING");
        count++;
        count += QtFocusOwnershipSelfTest();
        count += QtParkResumeSelfTest();
        count += FocusConfirmationSelfTest();
        count += QtFocusVisibilitySelfTest();
        var popupFixture =
            Data("version", 1, "kind", "profile", "className", "QtFixtureWindow", "ownerRelation",
                 "same-thread-unowned", "ownerDepth", 0, "windowRect", new Rect(-20, 40, 280, 340).Report(),
                 "clientWidth", 300, "clientHeight", 300, "style", unchecked((int)0x80000000), "extendedStyle", 128);
        var parsedPopup = QtParsePopupCalibration(popupFixture);
        Need(parsedPopup.OwnerDepth == 0 && parsedPopup.RelativeWindow.Left == -20 && parsedPopup.ClientWidth == 300,
             "QT_TEST_EXACT_POPUP_CALIBRATION");
        count++;
        popupFixture["ownerRelation"] = "same-process";
        Expect(delegate { QtParsePopupCalibration(popupFixture); }, "QT_POPUP_CALIBRATION_INVALID");
        popupFixture["ownerRelation"] = "same-thread-unowned";
        count++;
        popupFixture["ownerDepth"] = 1;
        Expect(delegate { QtParsePopupCalibration(popupFixture); }, "QT_POPUP_CALIBRATION_INVALID");
        popupFixture["ownerDepth"] = 0;
        count++;
        popupFixture["className"] = "";
        Expect(delegate { QtParsePopupCalibration(popupFixture); }, "QT_POPUP_CALIBRATION_INVALID");
        popupFixture["className"] = "QtFixtureWindow";
        count++;
        popupFixture["unexpected"] = true;
        Expect(delegate { QtParsePopupCalibration(popupFixture); }, "QT_POPUP_CALIBRATION_INVALID");
        popupFixture.Remove("unexpected");
        count++;
        QtNeedAnchorPixels("same", "same", "guard", 0);
        try
        {
            QtNeedAnchorPixels("old", "new", "guard", 1);
            throw new Fault("QT_TEST_PIXEL_MISMATCH_REQUIRED");
        }
        catch (Fault error)
        {
            var mismatch = Map(QtPixelMismatch(error));
            Need(error.Message == "QT_PIXELS_CHANGED" && mismatch != null && mismatch.Count == 2 &&
                     Text(mismatch, "stage") == "guard" && Number(Get(mismatch, "anchorIndex")) == 1,
                 "QT_TEST_PIXEL_MISMATCH_ANONYMOUS");
        }
        count++;
        var observedFixture =
            Data("version", 1, "kind", "profile", "className", "QtFixtureWindow", "ownerRelation",
                 "same-thread-unowned", "ownerDepth", 0, "style", unchecked((int)0x80000000), "extendedStyle", 128);
        Need(QtParsePopupCalibration(observedFixture, true).ClassName == "QtFixtureWindow",
             "QT_TEST_OBSERVED_IDENTITY_ONLY");
        Expect(delegate { QtParsePopupCalibration(observedFixture); }, "QT_POPUP_CALIBRATION_INVALID");
        count++;
        observedFixture["windowRect"] = new Rect(0, 0, 100, 100).Report();
        Expect(delegate { QtParsePopupCalibration(observedFixture, true); }, "QT_POPUP_CALIBRATION_INVALID");
        observedFixture.Remove("windowRect");
        count++;
        Need(QtCoveredByDisplays(new Rect(90, 10, 110, 90),
                                 new List<Rect> { new Rect(0, 0, 100, 100), new Rect(100, 0, 200, 100) }) &&
                 !QtCoveredByDisplays(new Rect(90, 10, 120, 90),
                                      new List<Rect> { new Rect(0, 0, 100, 100), new Rect(110, 0, 200, 100) }),
             "QT_TEST_OBSERVED_DISPLAY_GAPS_REFUSED");
        count++;
        {
            var root = new Binding { Window = new IntPtr(42), Pid = 7, Created = 123, Client = new Rect(0, 0, 800, 600),
                                     Capture = new Rect(2000, 100, 2800, 700) };
            var focus = new QtFocusLease { UiaMode = true, Wechat = root.Identity };
            var frame =
                new QtFrame { Binding = root, MetadataOnly = true, NavigationOnly = true, NavigationLease = focus };
            var search = new QtPopupCalibration { Kind = "search" };
            Need(QtPopupUsesUiaSearch(frame, focus, true, "search", search),
                 "QT_TEST_OFFSCREEN_SEARCH_NATIVE_UIA_NAVIGATION_REQUIRED");
            count++;
            foreach (int change in new[] { 0, 1, 2, 3, 4, 5, 6 })
            {
                frame.MetadataOnly = change != 0;
                frame.NavigationOnly = change != 1;
                focus.UiaMode = change != 2;
                frame.NavigationLease = change == 3 ? new QtFocusLease() : focus;
                Need(!QtPopupUsesUiaSearch(frame, focus, change != 4, change == 5 ? "profile" : "search",
                                           change == 6 ? new QtPopupCalibration { Kind = "profile" } : search),
                     "QT_TEST_OFFSCREEN_SEARCH_NO_CALLER_AUTHORITY");
                count++;
            }
            frame.MetadataOnly = true;
            frame.NavigationOnly = true;
            focus.UiaMode = true;
            frame.NavigationLease = focus;
            var popup = new QtPopupLease { Id = "search", Observed = true, UiaSearch = true, Root = root,
                                           Calibration = search };
            var bounds = new Rect(2100, 150, 2400, 450);
            var client = new Rect(0, 0, 300, 300);
            var displays = new List<Rect> { new Rect(0, 0, 1920, 1080) };
            Need(QtPopupDisplayAllowed(popup, bounds, displays) &&
                     QtPopupGeometryAllowed(bounds, client, bounds, popup),
                 "QT_TEST_OFFSCREEN_SEARCH_METADATA_WITH_BOUND_GEOMETRY");
            count++;
            Need(!QtPopupGeometryAllowed(new Rect(1800, 150, 2100, 450), client, new Rect(1800, 150, 2100, 450), popup),
                 "QT_TEST_OFFSCREEN_SEARCH_STILL_INSIDE_BOUND_ROOT");
            count++;
            int waited = 0;
            QtPopupObservationPause(popup, delegate(int ms) { waited += ms; });
            Need(waited == 0, "QT_TEST_UIA_SEARCH_NO_FIXED_REPAINT_WAIT");
            count++;
            popup.UiaSearch = false;
            Need(!QtPopupDisplayAllowed(popup, bounds, displays), "QT_TEST_OCR_SEARCH_RETAINS_DISPLAY_GUARD");
            QtPopupObservationPause(popup, delegate(int ms) { waited += ms; });
            Need(waited == 35, "QT_TEST_OCR_SEARCH_RETAINS_OBSERVATION_WAIT");
            count += 2;
            popup.UiaSearch = true;
            popup.Calibration.Kind = "profile";
            Need(!QtPopupDisplayAllowed(popup, bounds, displays), "QT_TEST_PROFILE_CANNOT_ADOPT_UIA_SEARCH_SCOPE");
            count++;
            popup.Calibration.Kind = "search";
            popup.Observed = false;
            Need(!QtPopupDisplayAllowed(popup, bounds, displays), "QT_TEST_CALIBRATED_SEARCH_CANNOT_ADOPT_UIA_SCOPE");
            count++;
            popup.Observed = true;
            popup.Calibration.ClassName = "Qt51514QWindowToolSaveBits";
            popup.Calibration.OwnerRelation = "root-owned";
            popup.Calibration.OwnerDepth = 1;
            Need(QtPopupOffscreenScope(popup, true, true) && !QtPopupOffscreenScope(popup, false, true) &&
                     !QtPopupOffscreenScope(popup, true, false),
                 "QT_TEST_POPUP_BOTH_ROOT_AND_SEARCH_MUST_BE_OFFSCREEN");
            count++;
            foreach (int changed in new[] { 0, 1, 2, 3 })
            {
                popup.UiaSearch = changed != 0;
                popup.Calibration.ClassName = changed == 1 ? "unknown" : "Qt51514QWindowToolSaveBits";
                popup.Calibration.OwnerRelation = changed == 2 ? "same-thread-unowned" : "root-owned";
                popup.Calibration.OwnerDepth = changed == 3 ? 2 : 1;
                Need(!QtPopupOffscreenScope(popup, true, true), "QT_TEST_OFFSCREEN_POPUP_EXACT_NATIVE_SCOPE");
                count++;
            }
            popup.UiaSearch = true;
            popup.Calibration.ClassName = "Qt51514QWindowToolSaveBits";
            popup.Calibration.OwnerRelation = "root-owned";
            popup.Calibration.OwnerDepth = 1;
            Rect actualRoot = new Rect(3715, 610, 4790, 1297), driftedPopup = new Rect(4223, 588, 4683, 708),
                 driftedClient = new Rect(0, 0, 460, 120);
            popup.Root.Client = new Rect(0, 0, 1075, 687);
            popup.Root.Capture = actualRoot;
            Need(!QtPopupGeometryAllowed(driftedPopup, driftedClient, driftedPopup, popup) &&
                     QtPopupGeometryAllowed(driftedPopup, driftedClient, driftedPopup, popup, true),
                 "QT_TEST_OFFSCREEN_POPUP_MEASURED_DETACHED_GEOMETRY_ONLY_NATIVE_SCOPE");
            count++;
            popup.Window = new IntPtr(22);
            popup.ObservedBounds = driftedPopup;
            popup.ObservedClient = driftedClient;
            popup.ObservedClientScreen = driftedPopup;
            Rect moved = new Rect(4200, 610, 4660, 1010), expanded = new Rect(0, 0, 460, 400);
            Need(QtPopupGeometryAllowed(moved, expanded, moved, popup, true),
                 "QT_TEST_OFFSCREEN_POPUP_QT_POSITION_AND_HEIGHT_FOLLOW_WITHOUT_MOVING");
            count++;
            Need(!QtPopupGeometryAllowed(new Rect(4200, 610, 4661, 1010), expanded, moved, popup, true) &&
                     !QtPopupGeometryAllowed(new Rect(4200, 609, 4660, 1010), expanded, moved, popup, true),
                 "QT_TEST_OFFSCREEN_POPUP_WIDTH_AND_MARGINS_STILL_BOUND");
            count++;
            Need(QtPopupOutsideDisplays(actualRoot, displays) &&
                     !QtPopupOutsideDisplays(new Rect(1910, 10, 2000, 100), displays) &&
                     !QtPopupOutsideDisplays(actualRoot, new List<Rect>()),
                 "QT_TEST_OFFSCREEN_POPUP_DISPLAY_INTERSECTION_REFUSED");
            count++;
            Need(!QtPopupShapeAllowed(driftedPopup, driftedClient, new Rect(4223, 588, 4684, 708)),
                 "QT_TEST_OFFSCREEN_POPUP_PRESERVES_CLIENT_CONTAINMENT");
            count++;
        }
        var observedLease = new QtPopupLease { Observed = true,
                                               Calibration = QtParsePopupCalibration(observedFixture, true),
                                               Root = new Binding { Capture = new Rect(0, 0, 800, 600) },
                                               Window = new IntPtr(4),
                                               ObservedBounds = new Rect(100, 100, 400, 400),
                                               ObservedClient = new Rect(0, 0, 300, 300),
                                               ObservedClientScreen = new Rect(100, 100, 400, 400) };
        Need(QtPopupGeometryAllowed(new Rect(100, 100, 400, 400), new Rect(0, 0, 300, 300),
                                    new Rect(100, 100, 400, 400), observedLease) &&
                 !QtPopupGeometryAllowed(new Rect(101, 100, 401, 400), new Rect(0, 0, 300, 300),
                                         new Rect(101, 100, 401, 400), observedLease),
             "QT_TEST_OBSERVED_PROFILE_GEOMETRY_FROZEN");
        count++;
        observedLease.Calibration.Kind = "search";
        Need(QtPopupGeometryAllowed(new Rect(100, 100, 400, 450), new Rect(0, 0, 300, 350),
                                    new Rect(100, 100, 400, 450), observedLease) &&
                 !QtPopupGeometryAllowed(new Rect(100, 100, 401, 450), new Rect(0, 0, 301, 350),
                                         new Rect(100, 100, 401, 450), observedLease) &&
                 !QtPopupGeometryAllowed(new Rect(100, 100, 400, 650), new Rect(0, 0, 300, 550),
                                         new Rect(100, 100, 400, 650), observedLease),
             "QT_TEST_OBSERVED_SEARCH_ONLY_HEIGHT_CAN_VARY_WITHIN_ROOT");
        count++;
        {
            var searchRoot = new Binding { Window = new IntPtr(20), Client = new Rect(0, 0, 800, 600),
                                           Capture = new Rect(900, 0, 1700, 600) };
            var searchPopup = new QtPopupLease { Id = "search",
                                                 Observed = true,
                                                 Calibration = new QtPopupCalibration { Kind = "search" },
                                                 Root = searchRoot,
                                                 Window = new IntPtr(21),
                                                 Revision = 7,
                                                 ObservedClientScreen = new Rect(1000, 100, 1300, 400) };
            var queryAnchor = new QtAnchor { Rect = new Rect(110, 20, 380, 60), Hash = new string('a', 64) };
            var searchFrame =
                new QtFrame { Binding = searchRoot, Revision = 7, PopupBounds = new Rect(1000, 100, 1300, 400),
                              PopupClient = new Rect(0, 0, 300, 300), Anchors = new List<QtAnchor> { queryAnchor } };
            Need(QtSearchPasteCompletionEligible("search", "observed-search", searchFrame, searchPopup),
                 "QT_TEST_SEARCH_PASTE_COMPLETION_SCOPE");
            count++;
            Need(!QtSearchPasteCompletionEligible("editor", "observed-search", searchFrame, searchPopup) &&
                     !QtSearchPasteCompletionEligible("search", "observed-profile", searchFrame, searchPopup) &&
                     !QtSearchPasteCompletionEligible("search", "calibrated-search", searchFrame, searchPopup),
                 "QT_TEST_SEARCH_PASTE_COMPLETION_EXCLUDES_OTHER_SCOPES");
            count++;
            queryAnchor.Rect = new Rect(110, 110, 380, 160);
            Need(!QtSearchPasteCompletionEligible("search", "observed-search", searchFrame, searchPopup),
                 "QT_TEST_SEARCH_PASTE_COMPLETION_EXCLUDES_RESULT_ROWS");
            queryAnchor.Rect = new Rect(110, 20, 380, 60);
            count++;
            searchFrame.Anchors.Add(new QtAnchor { Rect = new Rect(110, 110, 380, 160) });
            Need(!QtSearchPasteCompletionEligible("search", "observed-search", searchFrame, searchPopup),
                 "QT_TEST_SEARCH_PASTE_COMPLETION_SINGLE_QUERY_ANCHOR");
            searchFrame.Anchors.RemoveAt(1);
            count++;
            searchFrame.Revision = 8;
            Need(!QtSearchPasteCompletionEligible("search", "observed-search", searchFrame, searchPopup),
                 "QT_TEST_SEARCH_PASTE_COMPLETION_ORIGINAL_REVISION");
            searchFrame.Revision = 7;
            count++;
            searchPopup.Root = new Binding { Window = new IntPtr(22) };
            Need(!QtSearchPasteCompletionEligible("search", "observed-search", searchFrame, searchPopup),
                 "QT_TEST_SEARCH_PASTE_COMPLETION_ORIGINAL_ROOT");
            searchPopup.Root = searchRoot;
            count++;
            searchFrame.PopupBounds = null;
            Need(!QtSearchPasteCompletionEligible("search", "observed-search", searchFrame, searchPopup),
                 "QT_TEST_SEARCH_PASTE_COMPLETION_CAPTURE_GEOMETRY_REQUIRED");
            searchFrame.PopupBounds = new Rect(1000, 100, 1300, 400);
            count++;
            searchPopup.Calibration.Kind = "profile";
            Need(!QtSearchPasteCompletionEligible("search", "observed-search", searchFrame, searchPopup),
                 "QT_TEST_SEARCH_PASTE_COMPLETION_EXCLUDES_PROFILE");
            searchPopup.Calibration.Kind = "search";
            count++;
            var savedPopup = QtPopup;
            try
            {
                QtPopup = new QtPopupLease();
                Expect(delegate {
                    QtPasteCompletionStable(searchFrame, new QtSearchPasteCompletion { Popup = searchPopup });
                }, "QT_POPUP_BINDING_CHANGED");
                Need(!InputAttempted, "QT_TEST_SEARCH_PASTE_CHANGED_LEASE_NO_INPUT");
            }
            finally
            {
                QtPopup = savedPopup;
            }
            count++;
        }
        {
            // Anonymous geometry from the actual 120 -> 400 search result
            // expansion. The query anchor overlaps the popup's top by 8px,
            // while its real, root-owned click center remains above it.
            Func<Binding> binding = delegate
            {
                return new Binding { Window = new IntPtr(20),
                                     Pid = 30,
                                     Created = 40,
                                     Thread = 50,
                                     Dpi = 120,
                                     Focus = new IntPtr(20),
                                     FocusOwned = true,
                                     Client = new Rect(0, 0, 800, 600),
                                     Capture = new Rect(900, 100, 1700, 700) };
            };
            var popup = new QtPopupLease { Id = "search",
                                           Observed = true,
                                           Calibration = new QtPopupCalibration { Kind = "search" },
                                           Root = binding(),
                                           Window = new IntPtr(21),
                                           Revision = 7,
                                           ObservedBounds = new Rect(960, 179, 1420, 299),
                                           ObservedClient = new Rect(0, 0, 460, 120),
                                           ObservedClientScreen = new Rect(960, 179, 1420, 299) };
            Rect query = new Rect(91, 53, 261, 87);
            Func<QtFrame> capture = delegate
            {
                return new QtFrame { Binding = binding(),
                                     Revision = 7,
                                     Issued = 1000,
                                     PopupBounds = popup.ObservedBounds,
                                     PopupClient = popup.ObservedClient,
                                     Anchors = new List<QtAnchor> { new QtAnchor { Rect = query,
                                                                                   Hash = new string('a', 64) } } };
            };
            QtFrame clicked = capture(), fresh = capture();
            Need(QtSearchQueryClickEligible("observed-search", clicked, popup, query, true) &&
                     !QtSearchQueryClickEligible("observed-search", clicked, popup, query, false) &&
                     !QtSearchQueryClickEligible("observed-profile", clicked, popup, query, true),
                 "QT_TEST_PARTIAL_QUERY_REQUIRES_ROOT_OWNED_OBSERVED_CLICK");
            count++;
            var boundary = capture();
            boundary.Anchors[0].Rect = new Rect(91, 70, 261, 88);
            Need(!QtSearchQueryClickEligible("observed-search", boundary, popup, boundary.Anchors[0].Rect, true) &&
                     !QtSearchQueryClickEligible("observed-search", clicked, popup, new Rect(92, 53, 261, 87), true),
                 "QT_TEST_QUERY_CENTER_AT_RESULTS_AND_DIFFERENT_ANCHOR_REFUSED");
            count++;
            Need(!QtSearchPasteCompletionEligible("search", "observed-search", fresh, popup),
                 "QT_TEST_PARTIAL_QUERY_CANNOT_SKIP_FROZEN_HEIGHT_WITHOUT_CLICK");
            count++;
            var proof = new QtQueryClickProof { Popup = popup, Frame = clicked, Epoch = QtEpoch };
            popup.QueryClick = proof;
            Need(!QtSearchPasteCompletionEligible("search", "observed-search", fresh, popup, proof, 1001),
                 "QT_TEST_QUERY_PROOF_NOT_USABLE_BEFORE_SINGLE_CONSUMPTION");
            var consumed = QtTakeQueryClick(popup);
            Need(Object.ReferenceEquals(consumed, proof) && proof.Consumed && popup.QueryClick == null &&
                     QtSearchPasteCompletionEligible("search", "observed-search", fresh, popup, proof, 1001),
                 "QT_TEST_PARTIAL_QUERY_SINGLE_CONSUMED_CLICK_PROOF");
            count++;
            Need(QtTakeQueryClick(popup) == null, "QT_TEST_QUERY_CLICK_SECOND_PASTE_HAS_NO_PROOF");
            popup.QueryClick = proof;
            Need(QtTakeQueryClick(popup) == null, "QT_TEST_QUERY_CLICK_CONSUMED_PROOF_CANNOT_BE_REINSERTED");
            count++;
            foreach (int change in new[] { 0, 1, 2, 3, 4, 5, 6, 7, 8 })
            {
                var altered = capture();
                var p = new QtQueryClickProof { Popup = popup, Frame = clicked, Epoch = QtEpoch, Consumed = true };
                long now = 1001;
                if (change == 0)
                    p.Popup = new QtPopupLease();
                if (change == 1)
                    p.Epoch = "other";
                if (change == 2)
                    altered.Binding.Focus = new IntPtr(99);
                if (change == 3)
                    altered.Binding.Thread++;
                if (change == 4)
                    altered.Revision++;
                if (change == 5)
                    altered.Anchors[0].Rect = new Rect(92, 53, 261, 87);
                if (change == 6)
                    now = 31001;
                if (change == 7)
                    now = 999;
                if (change == 8)
                    altered.PopupBounds = new Rect(960, 179, 1420, 579);
                Need(!QtSearchPasteCompletionEligible("search", "observed-search", altered, popup, p, now),
                     "QT_TEST_QUERY_COMPLETION_IDENTITY_EPOCH_FOCUS_RECT_AGE_FROZEN");
                count++;
            }
            popup.QueryClick = new QtQueryClickProof { Popup = popup, Frame = clicked, Epoch = QtEpoch };
            var revoked = popup.QueryClick;
            QtRevokeQueryClick(popup);
            Need(popup.QueryClick == null && revoked.Consumed && QtTakeQueryClick(popup) == null,
                 "QT_TEST_OTHER_INPUT_REVOKES_QUERY_CLICK");
            count++;
            Need(QtPopupGeometryAllowed(new Rect(960, 179, 1420, 579), new Rect(0, 0, 460, 400),
                                        new Rect(960, 179, 1420, 579), popup) &&
                     !QtPopupGeometryAllowed(new Rect(960, 179, 1421, 579), new Rect(0, 0, 461, 400),
                                             new Rect(960, 179, 1421, 579), popup) &&
                     !QtPopupGeometryAllowed(new Rect(960, 180, 1420, 580), new Rect(0, 0, 460, 400),
                                             new Rect(960, 180, 1420, 580), popup),
                 "QT_TEST_ACTUAL_SEARCH_120_TO_400_ONLY_HEIGHT_ALLOWED");
            count++;
        }
        for (int guards = 0; guards < 256; guards++)
            Need(QtPopupCausalEligible((guards & 1) != 0, (guards & 2) != 0, (guards & 4) != 0, (guards & 8) != 0,
                                       (guards & 16) != 0, (guards & 32) != 0, (guards & 64) != 0,
                                       (guards & 128) != 0) == (guards == 191),
                 "QT_TEST_POPUP_EVERY_GUARD_REQUIRED");
        count++;
        Need(QtPopupTriggerMatches("search", "search", "chord", "Control+F", false) &&
                 QtPopupTriggerMatches("self", "profile", "click", null, true) &&
                 QtPopupTriggerMatches("profile", "profile", "click", null, true),
             "QT_TEST_POPUP_CALIBRATED_TRIGGER");
        count++;
        Need(!QtPopupTriggerMatches("search", "search", "type", null, true) &&
                 !QtPopupTriggerMatches("search", "profile", "chord", "Control+F", true) &&
                 !QtPopupTriggerMatches("self", "profile", "click", null, false) &&
                 !QtPopupTriggerMatches("profile", "profile", "chord", "Escape", true),
             "QT_TEST_POPUP_UNRELATED_ACTION_REFUSED");
        count++;
        Need(QtDiagnosticOwners(new IntPtr(1), delegate(IntPtr window) {
                 return new IntPtr(window.ToInt64() == 1 ? 2 : 1);
             }).Count == 2, "QT_TEST_DIAGNOSTIC_OWNER_CYCLE_BOUNDED");
        count++;
        Need(QtDiagnosticOwners(new IntPtr(1), delegate(IntPtr window) {
                 return new IntPtr(window.ToInt64() + 1);
             }).Count == 16, "QT_TEST_DIAGNOSTIC_OWNER_DEPTH_BOUNDED");
        count++;
        Need(QtDiagnosticHitRects(null, new Rect(0, 0, 800, 600)).Count == 0, "QT_TEST_DIAGNOSTIC_NO_HITS");
        count++;
        Expect(delegate {
            QtDiagnosticHitRects(new object[] { new Rect(700, 500, 900, 650).Report() }, new Rect(0, 0, 800, 600));
        }, "QT_DIAGNOSTIC_REGIONS_INVALID");
        count++;
        Input[] pasteChord = QtPasteChord();
        Need(pasteChord.Length == 4, "QT_TEST_PASTE_CHORD_LENGTH");
        ushort[] pasteKeys = new ushort[] { 0x11, 0x56, 0x56, 0x11 };
        uint[] pasteFlags = new uint[] { 0, 0, 2, 2 };
        for (int index = 0; index < 4; index++)
        {
            KeyInput keyboard = pasteChord[index].Value.Keyboard;
            Need(pasteChord[index].Type == 1 && keyboard.Key == pasteKeys[index] && keyboard.Scan == 0 &&
                     keyboard.Flags == pasteFlags[index] && keyboard.Extra.Equals(Marker),
                 "QT_TEST_PASTE_CHORD_LAYOUT");
        }
        count++;
        Input[] searchPaste = QtPasteInput(Data("replaceSearch", true), "search");
        Need(searchPaste.Length == 8, "QT_TEST_SEARCH_PASTE_ONE_QUEUE");
        ushort[] searchKeys = new ushort[] { 0x11, 0x41, 0x41, 0x11, 0x11, 0x56, 0x56, 0x11 };
        uint[] searchFlags = new uint[] { 0, 0, 2, 2, 0, 0, 2, 2 };
        for (int index = 0; index < searchPaste.Length; index++)
        {
            KeyInput keyboard = searchPaste[index].Value.Keyboard;
            Need(searchPaste[index].Type == 1 && keyboard.Key == searchKeys[index] && keyboard.Scan == 0 &&
                     keyboard.Flags == searchFlags[index] && keyboard.Extra.Equals(Marker),
                 "QT_TEST_SEARCH_PASTE_ORDER_AND_MARKER");
        }
        count++;
        Need(QtPasteInput(Data(), "editor").Length == 4 && QtPasteInput(Data(), "search").Length == 4,
             "QT_TEST_LEGACY_PASTE_UNCHANGED");
        count++;
        Need(QtPasteReadback(Data()) && QtPasteReadback(Data("readback", true)) &&
                 !QtPasteReadback(Data("readback", false)),
             "QT_TEST_UNCHECKED_PASTE_EXPLICIT_MODE");
        count++;
        Expect(delegate { QtPasteReadback(Data("readback", "false")); }, "QT_PASTE_INVALID");
        count++;
        Need(!QtForegroundPasteOnly(Data()) && !QtForegroundPasteOnly(Data("foregroundOnly", false)) &&
                 QtForegroundPasteOnly(Data("foregroundOnly", true)),
             "QT_TEST_FOREGROUND_FAST_PASTE_REQUIRES_EXPLICIT_MODE");
        count++;
        Expect(delegate { QtForegroundPasteOnly(Data("foregroundOnly", "true")); }, "QT_PASTE_INVALID");
        count++;
        {
            var root = new IntPtr(100);
            var binding = new Binding { Window = root, Pid = 42, Created = 123, FocusOwned = true };
            foreach (string surface in new[] { "main", "calibrated-search", "observed-search" })
            {
                Need(QtFastPasteAuthorized(false, true, false, binding, root, 42, 123, surface),
                     "QT_TEST_ALREADY_FOREGROUND_FAST_PASTE_MAIN_AND_BOUND_SEARCH");
                count++;
            }
            foreach (string change in new[] { "implicit", "parked", "window", "pid", "created", "focus", "surface",
                                              "missing-binding", "missing-root" })
            {
                var current = new Binding { Window = root, Pid = 42, Created = 123, FocusOwned = true };
                if (change == "window")
                    current.Window = new IntPtr(101);
                if (change == "pid")
                    current.Pid++;
                if (change == "created")
                    current.Created++;
                if (change == "focus")
                    current.FocusOwned = false;
                Need(!QtFastPasteAuthorized(false, change != "implicit", change == "parked",
                                            change == "missing-binding" ? null : current,
                                            change == "missing-root" ? IntPtr.Zero : root, 42, 123,
                                            change == "surface" ? "owned-profile" : "main"),
                     "QT_TEST_FOREGROUND_FAST_PASTE_CANNOT_REPLACE_ROOT_FOCUS_OR_PARKED_LEASE_GUARDS");
                count++;
            }
            Need(QtFastPasteAuthorized(true, false, false, binding, root, 42, 123, "main"),
                 "QT_TEST_BORROWED_FAST_PASTE_BACKWARD_COMPATIBLE");
            count++;
        }
        bool beforeSearchIntent = InputAttempted;
        InputAttempted = false;
        Expect(delegate { QtPasteInput(Data("replaceSearch", true), "editor"); }, "QT_SEARCH_PASTE_SCOPE_INVALID");
        Expect(delegate { QtPasteInput(Data("replaceSearch", false), "search"); }, "QT_SEARCH_PASTE_SCOPE_INVALID");
        Need(!InputAttempted, "QT_TEST_SEARCH_PASTE_INVALID_NOT_ATTEMPTED");
        InputAttempted = beforeSearchIntent;
        count++;
        bool priorAttempted = InputAttempted;
        InputAttempted = false;
        Expect(delegate { ChordEvents(0x56); }, "DRAFT_KEY_FORBIDDEN");
        Need(!InputAttempted, "QT_TEST_CHORD_CONSTRUCTION_NOT_INPUT");
        InputAttempted = priorAttempted;
        count++;
        Need(QtIdleReason(1032, 1000, 1000, 0, 1000) == "QT_ACTIVITY_WARMUP" &&
                 QtIdleReason(1999, 1000, 1000, 0, 1000) == "QT_ACTIVITY_WARMUP",
             "QT_TEST_STARTUP_IS_WARMUP");
        count++;
        Need(QtIdleReason(2000, 1000, 1000, 0, 1000) == null && QtIdleReason(2657, 1000, 1000, 0, 1000) == null,
             "QT_TEST_WARMUP_COMPLETE");
        count++;
        Need(QtIdleReason(1500, 1499, 1000, 1, 1000) == "QT_USER_ACTIVE" &&
                 QtIdleReason(3000, 2999, 1000, 1, 1000) == "QT_USER_ACTIVE" &&
                 QtIdleReason(4000, 3000, 1000, 1, 1000) == null,
             "QT_TEST_REAL_ACTIVITY_STILL_GUARDED");
        count++;
        Need(QtIdleReason(3000, 2999, 1000, 0, 1000) != "QT_ACTIVITY_WARMUP", "QT_TEST_WARMUP_ONLY_DURING_STARTUP");
        count++;
        Need(QtIdleReason(1500, 1499, 1000, 0, 0) == "QT_ACTIVITY_WARMUP", "QT_TEST_ZERO_IDLE_MONITOR_WARMUP");
        count++;
        Need(QtIdleReason(3000, 3000, 1000, 1, 0) == null && QtIdleReason(3000, 3000, 1000, 1, 1) == "QT_USER_ACTIVE",
             "QT_TEST_ZERO_IDLE_NO_EXTRA_DELAY");
        count++;
        Need(QtLayoutIdle(120000, 118000, 119990, 0, 2000) && QtLayoutIdle(120000, 90000, 119990, 0, 30000),
             "QT_TEST_COLD_LAYOUT_USES_REAL_SESSION_IDLE");
        Need(!QtLayoutIdle(120000, 118001, 119990, 0, 2000) && !QtLayoutIdle(120000, 115000, 119999, 1, 2000) &&
                 QtLayoutIdle(120000, 118000, 118000, 1, 2000),
             "QT_TEST_LAYOUT_REQUIRES_BOTH_SYSTEM_AND_OBSERVED_IDLE");
        Need(QtLayoutIdle((long)UInt32.MaxValue + 1000, UInt32.MaxValue - 1000, 0, 0, 2000) &&
                 !QtLayoutIdle(120000, 120001, 0, 0, 0),
             "QT_TEST_LAYOUT_IDLE_HANDLES_TICK_WRAP_AND_REFUSES_FUTURE_INPUT");
        count += 3;
        var observed = new ActivityCounters();
        observed.Observe(true, 0x100, 0, 0x10, UIntPtr.Zero);
        observed.Observe(false, 0x200, 0, 1, UIntPtr.Zero);
        observed.Observe(false, 0x201, 1, 1, UIntPtr.Zero);
        observed.Observe(false, 0x20a, 0, 1, UIntPtr.Zero);
        observed.Observe(false, 0x20e, 0, 1, UIntPtr.Zero);
        observed.Observe(false, 0x999, 0, 1, UIntPtr.Zero);
        observed.Observe(true, 0x100, 0x10, 0x10, Marker);
        observed.Observe(false, 0x200, 1, 1, Marker);
        var totals = Map(observed.Report());
        Need(totals.Count == 11 && Number(Get(totals, "keyboard")) == 1 && Number(Get(totals, "mouseMove")) == 1 &&
                 Number(Get(totals, "mouseButton")) == 1 && Number(Get(totals, "mouseWheel")) == 2 &&
                 Number(Get(totals, "mouseOther")) == 1 && Number(Get(totals, "nonInjected")) == 5 &&
                 Number(Get(totals, "foreignInjected")) == 1 && Number(Get(totals, "ownInjected")) == 2,
             "QT_TEST_ANONYMOUS_ACTIVITY_COUNTS");
        count++;
        var positions = new ActivityCounters();
        positions.Observe(false, 0x200, 0, 1, UIntPtr.Zero, 7319, -2391);
        positions.Observe(false, 0x200, 0, 1, UIntPtr.Zero, 7319, -2391);
        positions.Observe(false, 0x200, 0, 1, UIntPtr.Zero, 7320, -2391);
        positions.Observe(false, 0x200, 1, 1, Marker, 100, 100);
        positions.Observe(false, 0x200, 0, 1, UIntPtr.Zero, 7320, -2391);
        var positionReport = Map(positions.Report());
        Need(Number(Get(positionReport, "mouseMove")) == 4 &&
                 Number(Get(positionReport, "firstPositionMouseMove")) == 1 &&
                 Number(Get(positionReport, "samePositionMouseMove")) == 2 &&
                 Number(Get(positionReport, "changedPositionMouseMove")) == 1 &&
                 Number(Get(positionReport, "nonInjected")) == 4 && !Json.Serialize(positionReport).Contains("7319") &&
                 !Json.Serialize(positionReport).Contains("2391"),
             "QT_TEST_POSITION_COUNTS_WITHOUT_COORDINATES");
        count++;
        long revisionBefore = Revision, lastBefore = LastActivity;
        ActivityMonitorStarted = LastActivity = Now();
        var inspection = Map(QtFocusInspectionResult(false, "QT_USER_ACTIVE"));
        Need(inspection.Count == 9 && Number(Get(inspection, "idleMsObserved")) >= 0 &&
                 Number(Get(inspection, "monitorUptimeMs")) >= 0 &&
                 Number(Get(inspection, "activityRevision")) == revisionBefore &&
                 Map(Get(inspection, "inputActivityCounts")).Count == 11 && Revision == revisionBefore,
             "QT_TEST_READ_ONLY_ACTIVITY_DIAGNOSTICS");
        LastActivity = lastBefore;
        ActivityMonitorStarted = 0;
        count++;
        var identity = new WindowIdentity(new IntPtr(100), 42, 123);
        Need(WindowIdentity.Same(identity, QtParseFocus(identity.Report())), "QT_TEST_FOCUS_IDENTITY");
        count++;
        Need(!WindowIdentity.Same(identity, new WindowIdentity(identity.Window, 42, 124)), "QT_TEST_FOCUS_REUSE");
        count++;
        for (int flags = 0; flags < 16; flags++)
            Need(QtCanRestore((flags & 1) != 0, (flags & 2) != 0, (flags & 4) != 0, (flags & 8) != 0) == (flags == 15),
                 "QT_TEST_FOCUS_RESTORE_GUARDS");
        count++;
        Point ownPoint = new Point(-500, 50), userPoint = new Point(-499, 50);
        for (int flags = 0; flags < 256; flags++)
            Need(QtCanRestorePointer((flags & 1) != 0, (flags & 2) != 0, (flags & 4) != 0, (flags & 8) != 0,
                                     (flags & 16) != 0, (flags & 32) != 0, (flags & 64) != 0, (flags & 128) != 0,
                                     ownPoint, ownPoint) == (flags == 255),
                 "QT_TEST_POINTER_RESTORE_EVERY_GUARD");
        count++;
        Need(!QtCanRestorePointer(true, true, true, true, true, true, true, true, userPoint, ownPoint),
             "QT_TEST_POINTER_USER_MOVE_NOT_OVERWRITTEN");
        count++;
        Need(QtNearPoint(ownPoint, userPoint) && !QtSamePoint(ownPoint, userPoint),
             "QT_TEST_POINTER_INJECTION_TOLERANCE_NOT_RETURN_TOLERANCE");
        count++;
        var pointerEvents = QtPointerEvents(ownPoint, new Rect(-1000, 0, 1000, 1000));
        Need(pointerEvents.Length == 1 && pointerEvents[0].Type == 0 && pointerEvents[0].Value.Mouse.Flags == 0xc001 &&
                 pointerEvents[0].Value.Mouse.Data == 0 && pointerEvents[0].Value.Mouse.Extra.Equals(Marker),
             "QT_TEST_POINTER_NO_CLICK_OR_KEY");
        count++;
        Expect(delegate { QtPointerEvents(new Point(1000, 0), new Rect(-1000, 0, 1000, 1000)); },
               "DRAFT_SCREEN_CHANGED");
        count++;
        Rect parkRect = new Rect(400, 8, 500, 22);
        Need(QtCanParkPointer("main", parkRect, 800, true) && !QtCanParkPointer("main", parkRect, 800, false) &&
                 !QtCanParkPointer("calibrated-search", parkRect, 800, true) &&
                 !QtCanParkPointer("main", new Rect(400, 450, 500, 470), 800, true),
             "QT_TEST_PARK_EXACT_MAIN_TITLE_ANCHOR");
        count++;
        QtValidatePaste("hello\nworld", "hello\nworld", "editor");
        QtValidatePaste("target_A", "target_A", "search");
        count += 2;
        QtValidatePaste("桌面自动化示例讨论组", "桌面自动化示例讨论组", "search", "group-title");
        count++;
        QtValidatePaste("联系人备注", "联系人备注", "search", "private-name");
        count++;
        foreach (string invalid in new[] { " 名称", "名称 ", "名\n称", "name@chatroom", new string('名', 129) })
        {
            Expect(delegate { QtValidatePaste(invalid, invalid, "search", "private-name"); },
                   "QT_PASTE_SEARCH_INVALID");
            count++;
        }
        Expect(delegate { QtValidatePaste("联系人", "联系人", "editor", "private-name"); }, "QT_PASTE_SEARCH_INVALID");
        count++;
        Expect(delegate { QtValidatePaste("中文群", "中文群", "search"); }, "QT_PASTE_SEARCH_INVALID");
        Expect(delegate { QtValidatePaste("room@chatroom", "room@chatroom", "search", "group-title"); },
               "QT_PASTE_SEARCH_INVALID");
        Expect(delegate { QtValidatePaste("群\n名", "群\n名", "search", "group-title"); }, "QT_PASTE_SEARCH_INVALID");
        Expect(delegate { QtValidatePaste("群名", "群名", "editor", "group-title"); }, "QT_PASTE_SEARCH_INVALID");
        count += 4;
        Expect(delegate { QtValidatePaste("a\0b", "ab", "editor"); }, "QT_PASTE_INVALID");
        Expect(delegate { QtValidatePaste("a\nb", "a\nb", "search"); }, "QT_PASTE_SEARCH_INVALID");
        count += 2;
        byte[] ownText = Encoding.Unicode.GetBytes("private fixture\0");
        IntPtr ownWindow = new IntPtr(321);
        Need(QtOwnPasteSnapshot(ownWindow, ownWindow, 42, 42, true, new uint[] { 13 }, ownText, ownText) &&
                 QtOwnPasteSnapshot(ownWindow, ownWindow, 42, 42, true, new uint[] { 13, 16, 1, 7 }, ownText, ownText),
             "QT_TEST_POST_CLOSE_SYNTHESIZED_TEXT");
        count++;
        Need(!QtOwnPasteSnapshot(ownWindow, new IntPtr(322), 42, 42, true, new uint[] { 13 }, ownText, ownText) &&
                 !QtOwnPasteSnapshot(ownWindow, ownWindow, 42, 99, true, new uint[] { 13 }, ownText, ownText),
             "QT_TEST_FOREIGN_COPY_SAME_TEXT_REJECTED");
        count++;
        Need(!QtOwnPasteSnapshot(ownWindow, ownWindow, 42, 42, true, new uint[] { 13 },
                                 Encoding.Unicode.GetBytes("new user text\0"), ownText) &&
                 !QtOwnPasteSnapshot(ownWindow, ownWindow, 42, 42, true, new uint[] { 13, 0xc001 }, ownText, ownText),
             "QT_TEST_REPLACED_OR_AUGMENTED_CLIPBOARD_REJECTED");
        count++;
        Need(QtOwnPasteSnapshot(ownWindow, ownWindow, 42, 42, false, new uint[0], null, ownText) &&
                 !QtOwnPasteSnapshot(ownWindow, ownWindow, 42, 42, false, new uint[] { 13 }, ownText, ownText),
             "QT_TEST_SET_FAILURE_ONLY_OWN_EMPTY_ROLLBACK");
        count++;
        byte[] appended = new byte[ownText.Length + 2];
        Array.Copy(ownText, appended, ownText.Length);
        Need(!QtOwnPasteSnapshot(ownWindow, ownWindow, 42, 42, true, new uint[] { 13 }, appended, ownText),
             "QT_TEST_OWN_BUFFER_LENGTH_EXACT");
        count++;
        string emptyA = new string('a', 64), emptyB = new string('b', 64);
        var emptyRequest = Data("emptyEditorSha256", emptyA);
        Need(QtEmptyTemplates(emptyRequest).Count == 1, "QT_TEST_LEGACY_EMPTY_TEMPLATE");
        count++;
        emptyRequest["emptyEditorSha256s"] = new object[] { emptyA, emptyB };
        var emptyHashes = QtEmptyTemplates(emptyRequest);
        Need(emptyHashes.Count == 2 && emptyHashes.Contains(emptyA) && emptyHashes.Contains(emptyB),
             "QT_TEST_EMPTY_VARIANTS_EXACT");
        count++;
        foreach (object invalid in new object[] {
                     new object[0], new object[] { emptyB, emptyB }, new object[] { "invalid" },
                     new object[] { emptyB, new string('c', 64), new string('d', 64), new string('e', 64) }
                 })
        {
            emptyRequest["emptyEditorSha256s"] = invalid;
            Expect(delegate { QtEmptyTemplates(emptyRequest); }, "QT_EMPTY_TEMPLATES_INVALID");
            count++;
        }
        long emptyClock = 0;
        int emptySamples = 0, emptyGuards = 0;
        bool emptyMatched =
            QtWaitEmptyTemplate(emptyHashes, 650, delegate { emptyGuards++; },
                                delegate {
                                    emptySamples++;
                                    return emptyClock >= 100 ? emptyB : new string('c', 64);
                                },
                                delegate { return emptyClock; }, delegate(int ms) { emptyClock += ms; });
        Need(emptyMatched && emptyClock == 100 && emptySamples == 5 && emptyGuards == 10,
             "QT_TEST_EMPTY_BLINK_VARIANT_GUARDED");
        count++;
        emptyClock = 0;
        emptySamples = 0;
        Need(!QtWaitEmptyTemplate(emptyHashes, 650, delegate {},
                                  delegate {
                                      emptySamples++;
                                      return new string('c', 64);
                                  },
                                  delegate { return emptyClock; }, delegate(int ms) { emptyClock += ms; }) &&
                 emptyClock == 650 && emptySamples == 26,
             "QT_TEST_UNKNOWN_IMAGE_BOUNDED_REFUSAL");
        count++;
        emptyClock = 0;
        emptyGuards = 0;
        Expect(delegate {
            QtWaitEmptyTemplate(emptyHashes, 650,
                                delegate {
                                    if (++emptyGuards == 3)
                                        throw new Fault("QT_HUMAN_ACTIVITY_CHANGED");
                                },
                                delegate { return new string('c', 64); }, delegate { return emptyClock; },
                                delegate(int ms) { emptyClock += ms; });
        }, "QT_HUMAN_ACTIVITY_CHANGED");
        count++;
        emptyClock = 0;
        Need(!QtWaitEmptyTemplate(emptyHashes, 650, delegate {},
                                  delegate {
                                      emptyClock = 651;
                                      return emptyA;
                                  },
                                  delegate { return emptyClock; }, delegate(int ms) { emptyClock += ms; }),
             "QT_TEST_LATE_EMPTY_SAMPLE_REFUSED");
        count++;
        foreach (string key in new[] { "Control+F", "Control+A", "Control+C", "Control+End", "Escape" })
        {
            Need(QtChord(key).Length >= 2, "QT_TEST_CHORD");
            count++;
        }
        Expect(delegate { QtChord("Enter"); }, "QT_CHORD_FORBIDDEN");
        count++;
        Expect(delegate { QtParseAnchors(new object[0], new Rect(0, 0, 800, 600)); }, "QT_ANCHORS_REQUIRED");
        count++;
        Need(QtLayoutAnchors(new object[0], true, new Rect(0, 0, 800, 600)).Count == 0, "QT_TEST_LAYOUT_IMAGE_ONLY");
        count++;
        Expect(delegate { QtLayoutAnchors(new object[0], false, new Rect(0, 0, 800, 600)); }, "QT_ANCHORS_REQUIRED");
        count++;
        Expect(delegate { QtLayoutAnchors(null, true, new Rect(0, 0, 800, 600)); }, "QT_ANCHORS_REQUIRED");
        count++;
        Expect(delegate {
            QtParseAnchors(new object[] { new Rect(0, 0, 900, 600).Report() }, new Rect(0, 0, 800, 600));
        }, "QT_REGION_INVALID");
        count++;
        var anchors = QtParseAnchors(new object[] { new Rect(1, 1, 100, 100).Report() }, new Rect(0, 0, 800, 600));
        Need(anchors.Count == 1, "QT_TEST_ANCHOR");
        count++;
        Need(QtHash(new byte[] { 1, 2, 3 }) == "039058c6f2c0cb492c533b0a4d14ef77cc0f78abccced5287d84a1a2011cfb81",
             "QT_TEST_HASH");
        count++;
        byte[] colors = new byte[8];
        QtRgbaRow(new byte[] { 3, 2, 1, 0, 6, 5, 4, 20 }, colors, 0);
        Need(QtHash(colors) == QtHash(new byte[] { 1, 2, 3, 255, 4, 5, 6, 255 }), "QT_TEST_RGBA_COMPATIBILITY");
        count++;
        foreach (uint format in new uint[] { 1, 7, 8, 13, 15, 16, 17 })
        {
            Need(ClipboardFormats.CanBackUp(format, null), "QT_TEST_STANDARD_HGLOBAL");
            count++;
        }
        foreach (string format in new[] { "HTML Format", "Rich Text Format", "PNG", "image/png",
                                          "Chromium internal source RFH token", "Chromium internal source URL",
                                          "Chromium Web Custom MIME Data Format", "CanIncludeInClipboardHistory",
                                          "CanUploadToCloudClipboard" })
        {
            Need(ClipboardFormats.CanBackUp(0xc001, format), "QT_TEST_REGISTERED_HGLOBAL");
            count++;
        }
        foreach (string action in new[] { "paste", "pasteImage", "pasteUiaImage", "pasteUiaFile" })
        {
            Need(!QtAllowClipboardReplacement(Data("action", action)) &&
                     !QtAllowClipboardReplacement(Data("action", action, "allowClipboardReplacement", false)) &&
                     QtAllowClipboardReplacement(Data("action", action, "allowClipboardReplacement", true)),
                 "QT_TEST_EXPLICIT_PASTE_REPLACEMENT_POLICY");
            Expect(delegate {
                QtAllowClipboardReplacement(Data("action", action, "allowClipboardReplacement", "true"));
            }, "QT_PASTE_POLICY_INVALID");
            count++;
            foreach (IntPtr window in new[] { IntPtr.Zero, new IntPtr(700) })
            {
                uint pid = window == IntPtr.Zero ? 0u : 42u;
                var original = QtOriginalClipboardBaseline(
                    0, 31, window, pid,
                    QtAllowClipboardReplacement(Data("action", action, "allowClipboardReplacement", true)));
                Need(!original.ReplaceOnPaste && original.Formats.Count == 0 &&
                         QtOriginalClipboardMatches(original, 31, window, pid) &&
                         !QtOriginalClipboardMatches(original, 32, window, pid),
                     "QT_TEST_KNOWN_EMPTY_ALWAYS_RESTORED");
                count++;
                int cleared = 0;
                Func<bool> clear = delegate
                {
                    cleared++;
                    return true;
                };
                Expect(delegate { QtClearOwnedForRestore(32, 7, 33, 7, clear); }, "DRAFT_CLIPBOARD_CHANGED");
                Expect(delegate { QtClearOwnedForRestore(32, 7, 32, 8, clear); }, "DRAFT_CLIPBOARD_CHANGED");
                Need(cleared == 0, "QT_TEST_LATER_COPY_NEVER_CLEARED");
                QtClearOwnedForRestore(32, 7, 32, 7, clear);
                Need(cleared == 1, "QT_TEST_TEMPORARY_CONTENT_CLEARED_ON_EMPTY_RESTORE");
                count++;
            }
        }
        Expect(delegate {
            QtAllowClipboardReplacement(Data("action", "readDraft", "allowClipboardReplacement", true));
        }, "QT_PASTE_POLICY_INVALID");
        count++;
        foreach (string code in new[] { "DRAFT_CLIPBOARD_COMPLEX_FORMAT", "DRAFT_CLIPBOARD_DATA_TOO_LARGE",
                                        "DRAFT_CLIPBOARD_DATA_UNAVAILABLE", "DRAFT_CLIPBOARD_FORMAT_INVALID" })
        {
            Need(QtOriginalClipboardBlocked(code, false, false) && !QtOriginalClipboardBlocked(code, true, false) &&
                     !QtOriginalClipboardBlocked(code, false, true),
                 "QT_TEST_ONLY_ORIGINAL_CLIPBOARD_IS_REPLACEABLE");
            count++;
        }
        Need(!QtOriginalClipboardBlocked("DRAFT_CLIPBOARD_CHANGED", false, false) &&
                 !QtOriginalClipboardBlocked("DRAFT_CLIPBOARD_RESTORE_UNCONFIRMED", false, false),
             "QT_TEST_NO_UNCERTAIN_CLIPBOARD_REPLACEMENT");
        count++;
        foreach (string format in new[] { "DataObject", "Ole Private Data", "Unknown Format" })
        {
            Need(!ClipboardFormats.CanBackUp(0xc001, format), "QT_TEST_POINTER_REJECTED");
            count++;
        }
        foreach (bool opaqueFirst in new[] { false, true })
        {
            var selected = new List<uint>();
            var source = new ClipboardState();
            if (opaqueFirst)
                QtSelectBackupFormat(source, selected, 0xc001, "DataObject", true);
            QtSelectBackupFormat(source, selected, 8, null, true);
            if (!opaqueFirst)
                QtSelectBackupFormat(source, selected, 0xc001, "DataObject", true);
            QtSelectBackupFormat(source, selected, 0xc002, "PNG", true);
            Need(source.ReplaceOnPaste && selected.Count == 2 && selected[0] == 8 && selected[1] == 0xc002,
                 "QT_TEST_PRIVATE_COMPANION_KEEPS_ORIGINAL_IMAGE");
            count++;
            Need(!QtKeepPublishedPaste(source, true) && QtKeepPublishedPaste(source, false),
                 "QT_TEST_OPAQUE_ORIGINAL_NEVER_KEEPS_SEARCH");
            count++;
            source.Formats.Add(new ClipFormat { Id = 8, Bytes = new byte[] { 1 } });
            Need(!QtKeepPublishedPaste(source, true) && !QtKeepPublishedPaste(source, false),
                 "QT_TEST_IMAGE_RESTORED_AFTER_SEARCH_AND_BODY");
            count++;
            Expect(delegate {
                QtSelectBackupFormat(new ClipboardState(), new List<uint>(), 0xc001, "DataObject", false);
            }, "DRAFT_CLIPBOARD_COMPLEX_FORMAT");
            count++;
        }
        foreach (uint format in new uint[] { 2, 3, 9, 14 })
        {
            Need(!ClipboardFormats.CanBackUp(format, null), "QT_TEST_GDI_HANDLE_REJECTED");
            count++;
        }
        var structure = Map(QtDescribePayload(
            "fixture", Encoding.UTF8.GetBytes("<root flag=\"0\"><text><![CDATA[PRIVATE FIXTURE]]></text></root>"),
            "PRIVATE FIXTURE"));
        Need(Object.Equals(Get(structure, "xmlParsed"), true) && Text(structure, "root") == "root" &&
                 !Json.Serialize(structure).Contains("PRIVATE FIXTURE"),
             "QT_TEST_STRUCTURE_PRIVACY");
        count++;
        var external = Map(QtDescribePayload(
            "fixture",
            Encoding.UTF8.GetBytes(
                "<!DOCTYPE root [<!ENTITY payload SYSTEM 'file:///C:/private'>]><root>&payload;</root>"),
            "fixture"));
        Need(Object.Equals(Get(external, "xmlParsed"), false), "QT_TEST_XML_ENTITY_REFUSED");
        count++;
        foreach (string format in new[] { "WeChat_RichEdit_Format", "QQ_Unicode_RichEdit_Format" })
        {
            string rootName = format == "WeChat_RichEdit_Format" ? "WeChatRichEditFormat" : "QQRichEditFormat";
            Func<string, byte[]> wrap = delegate(string body)
            {
                return Encoding.UTF8.GetBytes("<" + rootName + ">" + body + "</" + rootName + ">\0");
            };
            Need(QtPlainRichPayload(format, wrap("<EditElement type=\"0\"><![CDATA[\u6d4b]]></EditElement>"), "\u6d4b"),
                 "QT_TEST_REAL_TEXT_STRUCTURE");
            count++;
            Need(QtPlainRichPayload(format,
                                    wrap("<EditElement type=\"0\">a&amp;&lt;</EditElement><EditElement " +
                                         "type=\"0\"><![CDATA[\n\uD83D\uDE0A]]></EditElement>"),
                                    "a&<\n\uD83D\uDE0A"),
                 "QT_TEST_RICH_TEXT_JOIN");
            count++;
            foreach (string body in new[] { "<EditElement type=\"1\">x</EditElement>",
                                            "<EditElement type=\"0\" path=\"hidden\">x</EditElement>",
                                            "<EditElement type=\"0\"><image/>x</EditElement>",
                                            "<EditElement type=\"0\">x</EditElement><EditElement type=\"2\"/>",
                                            "<EditElement type=\"0\">x</EditElement><!-- hidden -->",
                                            "<EditElement type=\"0\">other</EditElement>" })
            {
                Need(!QtPlainRichPayload(format, wrap(body), "x"), "QT_TEST_ATTACHMENT_OR_UNKNOWN_REJECTED");
                count++;
            }
        }
        Need(QtPlainRichPayload("x-application-mimetype-xwechat", Encoding.UTF8.GetBytes("1234567890\0"), "x") &&
                 !QtPlainRichPayload("x-application-mimetype-xwechat", Encoding.UTF8.GetBytes("image/png"), "x") &&
                 !QtPlainRichPayload("x-application-mimetype-xwechat", Encoding.UTF8.GetBytes("12345abcd0"), "x"),
             "QT_TEST_COPY_METADATA_ONLY");
        count++;
        var a = new Binding { Window = new IntPtr(100),
                              Pid = 5,
                              Created = 6,
                              Dpi = 96,
                              Focus = new IntPtr(100),
                              Client = new Rect(0, 0, 800, 600),
                              Capture = new Rect(1, 2, 801, 602) };
        var b = new Binding { Window = a.Window, Pid = a.Pid,       Created = a.Created, Dpi = a.Dpi,
                              Focus = a.Focus,   Client = a.Client, Capture = a.Capture };
        Need(QtSameBinding(a, b), "QT_TEST_BINDING");
        count++;
        b.Created++;
        Need(!QtSameBinding(a, b), "QT_TEST_PROCESS_REUSE");
        count++;
        Write(Data("ok", true, "selfTest", true, "checks", count, "uiAccessed", false, "inputSent", false,
                   "clipboardAccessed", false));
        return 0;
    }
    catch (Exception error)
    {
        Write(Data("ok", false, "selfTest", true, "checks", count, "reason",
                   error is Fault ? error.Message : "QT_SELFTEST_FAILED", "exceptionType", error.GetType().Name));
        return 1;
    }
}
}
