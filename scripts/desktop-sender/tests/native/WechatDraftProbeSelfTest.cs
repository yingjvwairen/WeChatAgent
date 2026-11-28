// Synthetic draft and input-contract tests; no application access.
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
using System.Web.Script.Serialization;
using System.Windows.Forms;

internal static partial class WechatDraftProbe
{
    static void Expect(Action action, string code)
    {
        try
        {
            action();
        }
        catch (Fault error)
        {
            Need(error.Message == code, "TEST_FAULT_CODE");
            return;
        }
        throw new Fault("TEST_EXPECTED_FAILURE");
    }
    static ClipboardState FixtureClip(uint sequence, uint owner, string text)
    {
        var state = new ClipboardState { Sequence = sequence, OwnerPid = owner };
        state.Formats.Add(new ClipFormat { Id = 13, Bytes = Encoding.Unicode.GetBytes(text + "\0") });
        return state;
    }
    static Dictionary<string, object> FixtureRequest()
    {
        long now = UtcMs();
        return Data("action", "verifyDraft", "permission",
                    Data("selectionCopy", true, "caretToEnd", true, "clipboardRestore", true), "expectedDraft",
                    "fixture text", "idleMs", 1000, "session",
                    Data("version", 1, "id", new string('a', 32), "calibrationHash", new string('b', 64),
                         "accountScopeHash", new string('c', 64), "target", "filehelper", "executable",
                         "C:\\fixture\\Weixin.exe", "hwnd", "100", "focusHwnd", "100", "pid", 42, "dpi", 96,
                         "lastInputTick", 10, "processCreatedFileTimeUtc", "12345", "issuedAtMs", now, "expiresAtMs",
                         now + 20000, "clientRect", new Rect(0, 0, 800, 600).Report(), "captureRect",
                         new Rect(100, 100, 900, 700).Report(), "editorRect", new Rect(100, 400, 700, 590).Report(),
                         "editorFocusProof",
                         Data("kind", "operator-calibrated-edit-region", "calibrationHash", new string('b', 64),
                              "lastInputTick", 10)));
    }
    static int SelfTest()
    {
        int checks = 0;
        try
        {
            Need(Marshal.SizeOf(typeof(GuiInfo)) == 72 && Marshal.SizeOf(typeof(Input)) == 40, "TEST_LAYOUT");
            checks++;
            Need(Own(0x10, 0x10, Marker) && !Own(0, 0x10, Marker) && !Own(0x10, 0x10, UIntPtr.Zero), "TEST_MARKER");
            checks++;
            ClipboardState original = FixtureClip(10, 1, "old"),
                           copied = FixtureClip(11, 42, "fixture\r\n\u4f60\u597d\uD83D\uDE00");
            Need(ValidateCopy(original, copied, 42, "fixture\r\n\u4f60\u597d\uD83D\uDE00") ==
                     "fixture\r\n\u4f60\u597d\uD83D\uDE00",
                 "TEST_EXACT_TEXT");
            checks++;
            Expect(delegate { ValidateCopy(original, FixtureClip(10, 42, "x"), 42, null); }, "DRAFT_COPY_UNCHANGED");
            checks++;
            Expect(delegate { ValidateCopy(original, FixtureClip(11, 7, "x"), 42, null); },
                   "DRAFT_COPY_OWNER_MISMATCH");
            checks++;
            Expect(delegate { ValidateCopy(original, FixtureClip(11, 42, ""), 42, null); },
                   "DRAFT_EMPTY_COPY_UNVERIFIED");
            checks++;
            Expect(delegate { ValidateCopy(original, FixtureClip(11, 42, "x"), 42, "y"); }, "DRAFT_TEXT_CONFLICT");
            checks++;
            copied.Formats.Add(new ClipFormat { Id = 0xc000, Bytes = new byte[] { 1 } });
            Expect(delegate { ValidateCopy(original, copied, 42, null); }, "DRAFT_CLIPBOARD_COMPLEX_FORMAT");
            checks++;
            Expect(delegate { DecodeUnicode(new byte[] { 0, 216, 0, 0 }); }, "DRAFT_COPY_TEXT_INVALID");
            checks++;
            Expect(delegate { DecodeUnicode(new byte[] { 65, 0 }); }, "DRAFT_COPY_TEXT_INVALID");
            checks++;
            Need(original.HasSamePayload(FixtureClip(99, 5, "old")) &&
                     !original.HasSamePayload(FixtureClip(10, 1, "new")),
                 "TEST_PRESERVATION");
            checks++;
            var request = Parse(FixtureRequest());
            Need(request.OperatorCalibrated && request.ExpectedDraft == "fixture text", "TEST_CALIBRATION");
            checks++;
            var missing = FixtureRequest();
            missing.Remove("expectedDraft");
            Expect(delegate { Parse(missing); }, "DRAFT_EXPECTED_TEXT_REQUIRED");
            checks++;
            var permission = FixtureRequest();
            Map(Get(permission, "permission"))["selectionCopy"] = false;
            Expect(delegate { Parse(permission); }, "DRAFT_ACTION_PERMISSION_REQUIRED");
            checks++;
            var proof = FixtureRequest();
            Map(Get(Map(Get(proof, "session")), "editorFocusProof"))["lastInputTick"] = 11;
            Expect(delegate { Parse(proof); }, "DRAFT_EDITOR_PROOF_INVALID");
            checks++;
            Expect(delegate { ValidateTime(request, request.Expires); }, "DRAFT_SESSION_EXPIRED");
            checks++;
            var rect = FixtureRequest();
            Map(Get(rect, "session"))["editorRect"] = new Rect(0, 0, 900, 800).Report();
            Expect(delegate { Parse(rect); }, "DRAFT_SESSION_INVALID");
            checks++;
            foreach (ushort key in new ushort[] { 0x41, 0x43, 0x23 })
            {
                var events = ChordEvents(key);
                Need(events.Length == 4 && events[0].Value.Keyboard.Key == 0x11 && events[3].Value.Keyboard.Flags == 2,
                     "TEST_CHORD");
                checks++;
            }
            Expect(delegate { ChordEvents(0x0d); }, "DRAFT_KEY_FORBIDDEN");
            checks++;
            var description = Map(FormatDescription(0xc000, new string('x', 200)));
            Need(Text(description, "registeredName").Length == 128 && description.Count == 2,
                 "TEST_FORMAT_DIAGNOSTIC_BOUND");
            checks++;
            Need(Get(Map(FormatDescription(13, "not a registered name")), "registeredName") == null,
                 "TEST_STANDARD_FORMAT_DIAGNOSTIC");
            checks++;
            var companions =
                new List<FormatTag> { new FormatTag { Id = 13 },
                                      new FormatTag { Id = 0xc001, Name = "DataObject" },
                                      new FormatTag { Id = 0xc002, Name = "WeChat_RichEdit_Format" },
                                      new FormatTag { Id = 0xc003, Name = "QQ_Unicode_RichEdit_Format" },
                                      new FormatTag { Id = 0xc004, Name = "x-application-mimetype-xwechat" },
                                      new FormatTag { Id = 0xc005, Name = "Ole Private Data" } };
            ValidateProjectionFormats(companions, true, "fixture text");
            checks++;
            Expect(delegate { ValidateProjectionFormats(companions, false, "fixture text"); },
                   "DRAFT_PROJECTION_PERMISSION_REQUIRED");
            checks++;
            Expect(delegate { ValidateProjectionFormats(companions, true, ""); },
                   "DRAFT_PROJECTION_PERMISSION_REQUIRED");
            checks++;
            companions.Add(new FormatTag { Id = 0xc099, Name = "HTML Format" });
            Expect(delegate { ValidateProjectionFormats(companions, true, "fixture text"); },
                   "DRAFT_CLIPBOARD_COMPLEX_FORMAT");
            checks++;
            var rich = Map(
                RichStructure("WeChat_RichEdit_Format", Encoding.Unicode.GetBytes("fixture text\0"), "fixture text"));
            Need(Object.Equals(Get(rich, "exactExpectedUtf16LEBytes"), true) &&
                     Object.Equals(Get(rich, "payloadIncluded"), false) &&
                     !Json.Serialize(rich).Contains("fixture text"),
                 "TEST_STRUCTURE_PRIVACY");
            checks++;
            foreach (string grapheme in new[] { " ", "\u4e2d", "\uD83D\uDE0A", "e\u0301",
                                                "\uD83D\uDC69\u200d\uD83D\uDCBB", "\uD83D\uDC4D\uD83C\uDFFD",
                                                "\uD83C\uDDE8\uD83C\uDDF3" })
            {
                var events = TextEvents(grapheme);
                Need(events.Length == grapheme.Length * 2 && events[0].Value.Keyboard.Flags == 4 &&
                         events[1].Value.Keyboard.Flags == 6,
                     "TEST_UNICODE_PAIRS");
                checks++;
            }
            foreach (string forbidden in new[] { "\n", "\r", "\t", "\0", "\u2028", "\u202e" })
            {
                Expect(delegate { TextEvents(forbidden); }, "DRAFT_APPEND_CONTROL_FORBIDDEN");
                checks++;
            }
            Expect(delegate { TextEvents("abc"); }, "DRAFT_APPEND_NOT_SINGLE_GRAPHEME");
            checks++;
            Expect(delegate { TextEvents("\uD800"); }, "DRAFT_APPEND_TEXT_INVALID");
            checks++;
            Expect(delegate { TextEvents("\u200d"); }, "DRAFT_APPEND_NOT_SINGLE_GRAPHEME");
            checks++;
            Input[] unicode = TextEvents("\uD83D\uDE0A"), releases = Releases(unicode, 3);
            Need(releases.Length == 2 && releases[0].Value.Keyboard.Scan == 0xde0a &&
                     releases[0].Value.Keyboard.Flags == 6 && releases[0].Value.Keyboard.Key == 0,
                 "TEST_UNICODE_RELEASE");
            checks++;
            var append = FixtureRequest();
            append["action"] = "appendPreview";
            append["appendGraphemes"] = new object[] { " ", "\u4e2d", "\u6587", "A", "\uD83D\uDE0A" };
            append["intervalMs"] = 300;
            Map(Get(append, "permission"))["appendPreview"] = true;
            Request appended = Parse(append);
            Need(appended.Graphemes.Length == 5 && appended.FinalDraft == "fixture text \u4e2d\u6587A\uD83D\uDE0A",
                 "TEST_APPEND_PARSE");
            checks++;
            Map(Get(append, "permission"))["appendPreview"] = false;
            Expect(delegate { Parse(append); }, "DRAFT_APPEND_PERMISSION_REQUIRED");
            Map(Get(append, "permission"))["appendPreview"] = true;
            checks++;
            Map(Get(append, "session")) ["expiresAtMs"] = UtcMs() + 500;
            Expect(delegate { Parse(append); }, "DRAFT_APPEND_BUDGET_EXCEEDED");
            checks++;
            TextVerified = true;
            GraphemesApplied = 5;
            var failed = Map(Failure(new Fault("DRAFT_HUMAN_ACTIVITY_CHANGED")));
            Need(Object.Equals(Get(failed, "textVerified"), false) &&
                     Object.Equals(Get(failed, "graphemesVerified"), 0),
                 "TEST_FAILURE_NOT_VERIFIED");
            TextVerified = false;
            GraphemesApplied = 0;
            checks++;
            var submit = FixtureRequest();
            submit["action"] = "submitPreview";
            Map(Get(submit, "permission"))["submitPreview"] = true;
            Map(Get(submit, "session"))["sendButtonRect"] = new Rect(710, 550, 790, 590).Report();
            Request submitted = Parse(submit);
            Need(submitted.SubmitPreview && !submitted.AppendPreview, "TEST_SUBMIT_PARSE");
            checks++;
            Map(Get(submit, "permission"))["submitPreview"] = false;
            Expect(delegate { Parse(submit); }, "DRAFT_SUBMIT_PERMISSION_REQUIRED");
            Map(Get(submit, "permission"))["submitPreview"] = true;
            checks++;
            submit["appendText"] = "x";
            Expect(delegate { Parse(submit); }, "DRAFT_ACTION_COMBINATION_FORBIDDEN");
            submit.Remove("appendText");
            checks++;
            Map(Get(submit, "permission"))["appendPreview"] = true;
            Expect(delegate { Parse(submit); }, "DRAFT_ACTION_COMBINATION_FORBIDDEN");
            Map(Get(submit, "permission")).Remove("appendPreview");
            checks++;
            Expect(delegate { ValidateButton(submitted.Client, submitted.Editor, new Rect(650, 550, 790, 590)); },
                   "DRAFT_SEND_BUTTON_INVALID");
            checks++;
            Expect(delegate { ValidateButton(submitted.Client, submitted.Editor, new Rect(710, 550, 810, 590)); },
                   "DRAFT_SEND_BUTTON_INVALID");
            checks++;
            Map(Get(submit, "session")) ["expiresAtMs"] = UtcMs() + 500;
            Expect(delegate { Parse(submit); }, "DRAFT_SUBMIT_BUDGET_EXCEEDED");
            checks++;
            Input[] click = ClickEvents(-500, 500, new Rect(-1000, 0, 1000, 1000));
            Need(click.Length == 3 && click[0].Type == 0 && click[0].Value.Mouse.Flags == 0xc001 &&
                     click[1].Value.Mouse.Flags == 2 && click[2].Value.Mouse.Flags == 4 &&
                     click[0].Value.Mouse.Extra.Equals(Marker) && click[1].Value.Mouse.Extra.Equals(Marker),
                 "TEST_CLICK_ONLY");
            checks++;
            Need(ClickReleases(0).Length == 0 && ClickReleases(1).Length == 0 && ClickReleases(2).Length == 1 &&
                     ClickReleases(2)[0].Value.Mouse.Flags == 4 && ClickReleases(3).Length == 0,
                 "TEST_CLICK_RELEASE");
            checks++;
            Expect(delegate { ClickEvents(10, 10, new Rect(0, 0, 10, 10)); }, "DRAFT_SCREEN_CHANGED");
            checks++;
            SubmitAttempted = true;
            var uncertain = Map(Failure(new Fault("DRAFT_SUBMIT_INPUT_UNCERTAIN")));
            Need(Object.Equals(Get(uncertain, "submitAttempted"), true) && Get(uncertain, "messageSent") == null &&
                     Object.Equals(Get(uncertain, "deliveryConfirmed"), false),
                 "TEST_SUBMIT_UNCERTAINTY");
            SubmitAttempted = false;
            checks++;
            Write(Data("ok", true, "selfTest", true, "checks", checks, "uiAccessed", false, "inputSent", false,
                       "clipboardAccessed", false));
            return 0;
        }
        catch
        {
            Write(Data("ok", false, "selfTest", true, "checks", checks));
            return 1;
        }
    }
}
