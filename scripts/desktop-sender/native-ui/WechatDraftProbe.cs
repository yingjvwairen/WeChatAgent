// Project-owned draft verifier and explicitly permitted bounded development actions.
// No Enter, paste, draft clearing, automatic retry, or delivery claims.
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
    static readonly JavaScriptSerializer Json =
        new JavaScriptSerializer { MaxJsonLength = 131072, RecursionLimit = 20 };
    // Use a nonzero 32-bit value so the entire marker survives mouse input
    // paths that preserve only 32 bits. Own still requires full exact equality.
    static readonly UIntPtr Marker = new UIntPtr(0x52465431U);
    static readonly HookProc KeyboardCallback = OnKeyboard, MouseCallback = OnMouse;
    static IntPtr KeyboardHook, MouseHook;
    // Optional in-process observer installed only by the Qt host. Other probes
    // leave it null; it cannot suppress input or change activity classification.
    static volatile Action<uint, Point> MouseObservationObserver;
    static void ObserveMouseIntent(uint message, Point point)
    {
        var observer = MouseObservationObserver;
        if (observer != null)
            try
            {
                observer(message, point);
            }
            catch
            {
                MouseObservationObserver = null;
            }
    }
    static long Revision, LastActivity, ActivityMonitorStarted;
    // Anonymous totals only: never report key codes, characters, mouse coordinates,
    // window titles, or individual event records. The previous mouse position is
    // kept only in memory to count unchanged positions. Input guards are unchanged.
    sealed class ActivityCounters
    {
        internal long Keyboard, MouseMove, MouseButton, MouseWheel, MouseOther, NonInjected, ForeignInjected,
            OwnInjected;
        internal long SamePositionMouseMove, ChangedPositionMouseMove, FirstPositionMouseMove;
        bool HasMousePosition;
        int LastMouseX, LastMouseY;
        internal void Observe(bool keyboard, uint message, uint flags, uint injectedMask, UIntPtr marker,
                              int mouseX = 0, int mouseY = 0)
        {
            if (Own(flags, injectedMask, marker))
            {
                Interlocked.Increment(ref OwnInjected);
                return;
            }
            if ((flags & injectedMask) != 0)
                Interlocked.Increment(ref ForeignInjected);
            else
                Interlocked.Increment(ref NonInjected);
            if (keyboard)
                Interlocked.Increment(ref Keyboard);
            else if (message == 0x200)
            {
                Interlocked.Increment(ref MouseMove);
                if (!HasMousePosition)
                    Interlocked.Increment(ref FirstPositionMouseMove);
                else if (mouseX == LastMouseX && mouseY == LastMouseY)
                    Interlocked.Increment(ref SamePositionMouseMove);
                else
                    Interlocked.Increment(ref ChangedPositionMouseMove);
                LastMouseX = mouseX;
                LastMouseY = mouseY;
                HasMousePosition = true;
            }
            else if (message == 0x20a || message == 0x20e)
                Interlocked.Increment(ref MouseWheel);
            else if ((message >= 0x201 && message <= 0x209) || (message >= 0x20b && message <= 0x20d))
                Interlocked.Increment(ref MouseButton);
            else
                Interlocked.Increment(ref MouseOther);
        }
        internal object Report()
        {
            return Data("keyboard", Interlocked.Read(ref Keyboard), "mouseMove", Interlocked.Read(ref MouseMove),
                        "mouseButton", Interlocked.Read(ref MouseButton), "mouseWheel",
                        Interlocked.Read(ref MouseWheel), "mouseOther", Interlocked.Read(ref MouseOther), "nonInjected",
                        Interlocked.Read(ref NonInjected), "foreignInjected", Interlocked.Read(ref ForeignInjected),
                        "ownInjected", Interlocked.Read(ref OwnInjected), "samePositionMouseMove",
                        Interlocked.Read(ref SamePositionMouseMove), "changedPositionMouseMove",
                        Interlocked.Read(ref ChangedPositionMouseMove), "firstPositionMouseMove",
                        Interlocked.Read(ref FirstPositionMouseMove));
        }
    }
    static readonly ActivityCounters ActivityObserved = new ActivityCounters();
    static volatile bool Stopping;
    static bool InputAttempted, CaretApplied, ClipboardRestored;
    static bool TextInputAttempted, TextVerified;
    static bool SubmitAttempted, SubmitInputApplied;
    static int GraphemesApplied;
    static object CopyFormatDiagnostic;
    static object RichStructureDiagnostic;
    static Control Dispatcher;
    static Mutex Gate;
    static Request Active;
    static int ExitCode;
    sealed class Fault : Exception
    {
        internal Fault(string code) : base(code)
        {
        }
    }
    static void Need(bool value, string code)
    {
        if (!value)
            throw new Fault(code);
    }
    static Dictionary<string, object> Data(params object[] pairs)
    {
        var result = new Dictionary<string, object>();
        for (int i = 0; i < pairs.Length; i += 2)
            result.Add((string)pairs[i], pairs[i + 1]);
        return result;
    }
    static Dictionary<string, object> Map(object value)
    {
        return value as Dictionary<string, object>;
    }
    static object Get(Dictionary<string, object> value, string key)
    {
        object result;
        return value != null && value.TryGetValue(key, out result) ? result : null;
    }
    static string Text(Dictionary<string, object> value, string key)
    {
        return Get(value, key) as string;
    }
    static long Number(object value)
    {
        try
        {
            Need(value != null && !(value is bool) && !(value is string), "DRAFT_REQUEST_INVALID");
            decimal n = Convert.ToDecimal(value, CultureInfo.InvariantCulture);
            Need(n >= -2147483648M && n <= 9007199254740991M && Decimal.Truncate(n) == n, "DRAFT_REQUEST_INVALID");
            return (long)n;
        }
        catch (Fault)
        {
            throw;
        }
        catch
        {
            throw new Fault("DRAFT_REQUEST_INVALID");
        }
    }
    static long DecimalString(object value)
    {
        long result;
        Need(value is string &&
                 Int64.TryParse((string)value, NumberStyles.None, CultureInfo.InvariantCulture, out result),
             "DRAFT_REQUEST_INVALID");
        return Int64.Parse((string)value, CultureInfo.InvariantCulture);
    }
    static bool Hex(string value, int length)
    {
        if (value == null || value.Length != length)
            return false;
        foreach (char c in value)
            if (!((c >= '0' && c <= '9') || (c >= 'a' && c <= 'f')))
                return false;
        return true;
    }
    static long Now()
    {
        return unchecked((long)GetTickCount64());
    }
    static long UtcMs()
    {
        return (DateTime.UtcNow.Ticks - 621355968000000000L) / 10000;
    }
    static void Write(object result)
    {
        Console.WriteLine(Json.Serialize(result));
        Console.Out.Flush();
    }
    static string Exe(string value)
    {
        Need(!String.IsNullOrEmpty(value) && value.Length < 32760 && value.Length > 3 && Char.IsLetter(value[0]) &&
                 value[1] == ':' && (value[2] == '\\' || value[2] == '/') &&
                 value.IndexOfAny(new[] { '\0', '\r', '\n' }) < 0,
             "DRAFT_EXECUTABLE_INVALID");
        string file = Path.GetFullPath(value);
        Need(String.Equals(Path.GetFileName(file), "Weixin.exe", StringComparison.OrdinalIgnoreCase) ||
                 String.Equals(Path.GetFileName(file), "WeChat.exe", StringComparison.OrdinalIgnoreCase),
             "DRAFT_EXECUTABLE_INVALID");
        return file;
    }

    [STAThread]
    internal static int Main(string[] args)
    {
        Console.InputEncoding = new UTF8Encoding(false);
        Console.OutputEncoding = new UTF8Encoding(false);
        if (args.Length == 1 && args[0] == "--self-test")
            return SelfTest();
        using (var watchdog =
                   new System.Threading.Timer(delegate { Environment.Exit(124); }, null, 10000, Timeout.Infinite))
        {
            try
            {
                if (args.Length == 5 && args[0] == "--inspect" && args[1] == "--executable" && args[3] == "--hwnd")
                {
                    string executable = Exe(args[2]);
                    long handle = DecimalString(args[4]);
                    Need(handle > 0, "DRAFT_REQUEST_INVALID");
                    SetProcessDpiAwarenessContext(new IntPtr(-4));
                    var snapshot = Snapshot(new IntPtr(handle), executable);
                    Write(Data("ok", true, "mode", "inspect", "binding", snapshot.Report(), "inputSent", false,
                               "clipboardAccessed", false));
                    return 0;
                }
                Need(args.Length == 1 && (args[0] == "--verify-draft" || args[0] == "--append-preview" ||
                                          args[0] == "--private-action"),
                     "DRAFT_ARGUMENTS_INVALID");
                string line = ReadLine();
                Active = Parse(Map(Json.DeserializeObject(line)));
                Need(Active.AppendPreview == (args[0] == "--append-preview"), "DRAFT_ACTION_PERMISSION_REQUIRED");
                Need(Active.SubmitPreview == (args[0] == "--private-action"), "DRAFT_ACTION_PERMISSION_REQUIRED");
                SetProcessDpiAwarenessContext(new IntPtr(-4));
                Gate = Acquire("Local\\WeChatAgent.UiInput.v1");
                ActivityMonitorStarted = LastActivity = Now();
                using (var process = Process.GetCurrentProcess())
                {
                    IntPtr module = GetModuleHandle(process.MainModule.ModuleName);
                    KeyboardHook = SetWindowsHookEx(13, KeyboardCallback, module, 0);
                    MouseHook = SetWindowsHookEx(14, MouseCallback, module, 0);
                }
                Need(KeyboardHook != IntPtr.Zero && MouseHook != IntPtr.Zero, "DRAFT_ACTIVITY_MONITOR_UNAVAILABLE");
                Dispatcher = new Control();
                var handleOwner = Dispatcher.Handle;
                var worker = new Thread(delegate() {
                    try
                    {
                        Write(VerifyDraft(Active, handleOwner));
                    }
                    catch (Exception error)
                    {
                        ExitCode = 1;
                        Write(Failure(error));
                    }
                    finally
                    {
                        Stopping = true;
                        try
                        {
                            Dispatcher.BeginInvoke((Action)delegate { Application.ExitThread(); });
                        }
                        catch
                        {
                        }
                    }
                });
                worker.IsBackground = true;
                worker.SetApartmentState(ApartmentState.MTA);
                worker.Start();
                Application.Run();
                return ExitCode;
            }
            catch (Exception error)
            {
                Write(Failure(error));
                return 1;
            }
            finally
            {
                Stopping = true;
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
    static object Failure(Exception error)
    {
        return Data("ok", false, "reason", error is Fault ? error.Message : "DRAFT_PROBE_FAILED", "draft", null,
                    "draftVerified", false, "inputAttempted", InputAttempted, "textInputAttempted", TextInputAttempted,
                    "textVerified", false, "graphemesApplied", GraphemesApplied, "graphemesVerified", 0,
                    "unattendedReady", false, "caretToEndInputApplied", CaretApplied, "caretAtEndVerified", false,
                    "clipboardRestored", ClipboardRestored, "messageSent", SubmitAttempted ? (object)null : false,
                    "copyFormats", CopyFormatDiagnostic, "submitAttempted", SubmitAttempted, "sendInputAttempted",
                    SubmitAttempted, "submitInputApplied", SubmitInputApplied, "deliveryConfirmed", false);
    }
    static string ReadLine()
    {
        var text = new StringBuilder();
        int c;
        while ((c = Console.In.Read()) != -1 && c != '\n')
        {
            Need(text.Length < 65536, "DRAFT_REQUEST_TOO_LARGE");
            text.Append((char)c);
        }
        Need(c == '\n', "DRAFT_REQUEST_INVALID");
        return text.ToString();
    }
    static Mutex Acquire(string name)
    {
        var mutex = new Mutex(false, name);
        bool acquired = false;
        try
        {
            try
            {
                acquired = mutex.WaitOne(0);
            }
            catch (AbandonedMutexException)
            {
                acquired = true;
            }
            Need(acquired, "DRAFT_INPUT_ALREADY_OWNED");
            return mutex;
        }
        catch
        {
            mutex.Dispose();
            throw;
        }
    }

    sealed class Request
    {
        internal string Executable, SessionId, CalibrationHash, AccountScopeHash, ExpectedDraft, FinalDraft;
        internal IntPtr Window, Focus;
        internal uint Pid, Dpi, InputTick;
        internal long Created, Issued, Expires;
        internal int Idle, Interval;
        internal bool OperatorCalibrated, AppendPreview, SubmitPreview;
        internal string[] Graphemes;
        internal Rect Client, Capture, Editor, SendButton;
    }
    static Rect ParseRect(object value)
    {
        var obj = Map(value);
        Need(obj != null && obj.Count == 4, "DRAFT_RECT_INVALID");
        long l = Number(Get(obj, "left")), t = Number(Get(obj, "top")), r = Number(Get(obj, "right")),
             b = Number(Get(obj, "bottom"));
        Need(l >= -32768 && t >= -32768 && r <= 32768 && b <= 32768 && r > l && b > t && r - l <= 8192 && b - t <= 8192,
             "DRAFT_RECT_INVALID");
        return new Rect((int)l, (int)t, (int)r, (int)b);
    }
    static Request Parse(Dictionary<string, object> value)
    {
        Need(value != null && (Text(value, "action") == "verifyDraft" || Text(value, "action") == "appendPreview" ||
                               Text(value, "action") == "submitPreview"),
             "DRAFT_REQUEST_INVALID");
        var permit = Map(Get(value, "permission"));
        Need(Object.Equals(Get(permit, "selectionCopy"), true) && Object.Equals(Get(permit, "caretToEnd"), true) &&
                 Object.Equals(Get(permit, "clipboardRestore"), true),
             "DRAFT_ACTION_PERMISSION_REQUIRED");
        var session = Map(Get(value, "session"));
        Need(session != null && Number(Get(session, "version")) == 1 && Text(session, "target") == "filehelper" &&
                 Hex(Text(session, "id"), 32) && Hex(Text(session, "calibrationHash"), 64) &&
                 Hex(Text(session, "accountScopeHash"), 64),
             "DRAFT_SESSION_INVALID");
        var result = new Request { Executable = Exe(Text(session, "executable")),
                                   SessionId = Text(session, "id"),
                                   CalibrationHash = Text(session, "calibrationHash"),
                                   AccountScopeHash = Text(session, "accountScopeHash"),
                                   Window = new IntPtr(DecimalString(Get(session, "hwnd"))),
                                   Focus = new IntPtr(DecimalString(Get(session, "focusHwnd"))),
                                   Created = DecimalString(Get(session, "processCreatedFileTimeUtc")),
                                   Pid = checked((uint)Number(Get(session, "pid"))),
                                   Dpi = checked((uint)Number(Get(session, "dpi"))),
                                   InputTick = checked((uint)Number(Get(session, "lastInputTick"))),
                                   Issued = Number(Get(session, "issuedAtMs")),
                                   Expires = Number(Get(session, "expiresAtMs")),
                                   Idle = checked((int)Number(Get(value, "idleMs"))),
                                   Client = ParseRect(Get(session, "clientRect")),
                                   Capture = ParseRect(Get(session, "captureRect")),
                                   Editor = ParseRect(Get(session, "editorRect")) };
        Need(result.Window != IntPtr.Zero && result.Focus != IntPtr.Zero && result.Pid > 0 && result.Created > 0 &&
                 result.Dpi >= 48 && result.Dpi <= 768 && result.Idle >= 0 && result.Idle <= 300000 &&
                 result.Client.Left == 0 && result.Client.Top == 0 && result.Client.Width == result.Capture.Width &&
                 result.Client.Height == result.Capture.Height && Contains(result.Client, result.Editor),
             "DRAFT_SESSION_INVALID");
        result.ExpectedDraft = Text(value, "expectedDraft");
        if (Get(session, "editorFocusProof") != null)
        {
            var proof = Map(Get(session, "editorFocusProof"));
            Need(proof != null && proof.Count == 3 && Text(proof, "kind") == "operator-calibrated-edit-region" &&
                     Text(proof, "calibrationHash") == result.CalibrationHash &&
                     Number(Get(proof, "lastInputTick")) == result.InputTick,
                 "DRAFT_EDITOR_PROOF_INVALID");
            Need(!String.IsNullOrEmpty(result.ExpectedDraft) && result.ExpectedDraft.Length <= 16000 &&
                     result.ExpectedDraft.IndexOf('\0') < 0,
                 "DRAFT_EXPECTED_TEXT_REQUIRED");
            result.OperatorCalibrated = true;
        }
        if (Text(value, "action") == "appendPreview")
        {
            Need(!Object.Equals(Get(permit, "submitPreview"), true), "DRAFT_ACTION_COMBINATION_FORBIDDEN");
            Need(Object.Equals(Get(permit, "appendPreview"), true) && result.OperatorCalibrated,
                 "DRAFT_APPEND_PERMISSION_REQUIRED");
            result.AppendPreview = true;
            result.Interval = checked((int)Number(Get(value, "intervalMs")));
            object[] values = Get(value, "appendGraphemes") as object[];
            Need(values != null && values.Length >= 1 && values.Length <= 16, "DRAFT_APPEND_LIMIT_INVALID");
            result.Graphemes = new string[values.Length];
            var appended = new StringBuilder();
            for (int i = 0; i < values.Length; i++)
            {
                string grapheme = values[i] as string;
                TextEvents(grapheme);
                result.Graphemes[i] = grapheme;
                appended.Append(grapheme);
            }
            Need(result.Interval >= 120 && result.Interval <= 500 &&
                     result.Idle + (values.Length - 1) * result.Interval + 2000 <= 8000,
                 "DRAFT_APPEND_BUDGET_EXCEEDED");
            result.FinalDraft = result.ExpectedDraft + appended;
            Need(result.FinalDraft.Length <= 16000, "DRAFT_APPEND_LIMIT_INVALID");
        }
        if (Text(value, "action") == "submitPreview")
        {
            Need(Object.Equals(Get(permit, "submitPreview"), true) && result.OperatorCalibrated &&
                     !String.IsNullOrEmpty(result.ExpectedDraft),
                 "DRAFT_SUBMIT_PERMISSION_REQUIRED");
            Need(!Object.Equals(Get(permit, "appendPreview"), true) && Get(value, "appendGraphemes") == null &&
                     Get(value, "appendText") == null,
                 "DRAFT_ACTION_COMBINATION_FORBIDDEN");
            result.SubmitPreview = true;
            result.SendButton = ParseRect(Get(session, "sendButtonRect"));
            ValidateButton(result.Client, result.Editor, result.SendButton);
            Need(result.Idle + 2000 <= 8000 && result.Expires - UtcMs() >= result.Idle + 2000,
                 "DRAFT_SUBMIT_BUDGET_EXCEEDED");
        }
        ValidateTime(result, UtcMs());
        if (result.AppendPreview)
            Need(result.Expires - UtcMs() >= result.Idle + (result.Graphemes.Length - 1) * result.Interval + 2000,
                 "DRAFT_APPEND_BUDGET_EXCEEDED");
        return result;
    }
    static void ValidateTime(Request request, long now)
    {
        Need(request.Issued <= now && request.Issued >= now - 30000 && request.Expires > now &&
                 request.Expires > request.Issued && request.Expires - request.Issued <= 30000,
             "DRAFT_SESSION_EXPIRED");
    }

    static Binding Guard(Request request, long revision, bool checkInputTick)
    {
        Need(!Stopping, "DRAFT_STOPPING");
        ValidateTime(request, UtcMs());
        Need(Interlocked.Read(ref Revision) == revision, "DRAFT_HUMAN_ACTIVITY_CHANGED");
        Binding state = Snapshot(request.Window, request.Executable);
        Need(state.Pid == request.Pid && state.Created == request.Created && state.Dpi == request.Dpi &&
                 Same(state.Client, request.Client) && Same(state.Capture, request.Capture),
             "DRAFT_WINDOW_BINDING_CHANGED");
        Need(state.FocusOwned && state.Focus == request.Focus, "DRAFT_EDITOR_FOCUS_CHANGED");
        Need((state.GuiFlags & 0x1e) == 0, "DRAFT_MENU_OR_MOVE_ACTIVE");
        Need(request.OperatorCalibrated ||
                 (state.CaretOwned && state.CaretInClient.Height > 0 && state.CaretInClient.Width >= 0 &&
                  Contains(request.Editor, state.CaretInClient)),
             "DRAFT_EDITOR_CARET_UNAVAILABLE");
        Need(!checkInputTick || state.InputTick == request.InputTick, "DRAFT_CALIBRATION_ACTIVITY_CHANGED");
        Need(Interlocked.Read(ref Revision) == revision, "DRAFT_HUMAN_ACTIVITY_CHANGED");
        return state;
    }
    static void NoKeysHeld()
    {
        for (int key = 1; key < 256; key++)
            Need((GetAsyncKeyState(key) & 0x8000) == 0, "DRAFT_KEYS_HELD");
    }
    static object VerifyDraft(Request request, IntPtr owner)
    {
        long revision = Interlocked.Read(ref Revision);
        Guard(request, revision, true);
        NoKeysHeld();
        while (Now() - Interlocked.Read(ref LastActivity) < request.Idle)
        {
            Thread.Sleep(15);
            Guard(request, revision, true);
        }
        NoKeysHeld();
        ClipboardState original = ReadClipboard(owner, false);
        uint copiedSequence = 0, clipboardBaselineSequence = original.Sequence;
        string draft = null;
        bool selected = false;
        Exception failure = null;
        try
        {
            Guard(request, revision, true);
            NoKeysHeld();
            Need(GetClipboardSequenceNumber() == original.Sequence, "DRAFT_CLIPBOARD_CHANGED");
            Chord(request, revision, 0x41);
            selected = true;
            Thread.Sleep(50);
            Guard(request, revision, false);
            Need(GetClipboardSequenceNumber() == original.Sequence, "DRAFT_CLIPBOARD_CHANGED");
            Chord(request, revision, 0x43);
            long until = Now() + 1000;
            while (GetClipboardSequenceNumber() == original.Sequence && Now() < until)
            {
                Thread.Sleep(15);
                Guard(request, revision, false);
            }
            Guard(request, revision, false);
            copiedSequence = GetClipboardSequenceNumber();
            Need(copiedSequence != original.Sequence, "DRAFT_COPY_UNCHANGED");
            Need(ClipboardOwnerPid() == request.Pid, "DRAFT_COPY_OWNER_MISMATCH");
            ClipboardState copied =
                request.OperatorCalibrated ? ReadProjectionClipboard(owner, request) : ReadClipboard(owner, true);
            Need(copied.Sequence == copiedSequence && copied.OwnerPid == request.Pid, "DRAFT_CLIPBOARD_CHANGED");
            draft = ValidateCopy(original, copied, request.Pid, request.ExpectedDraft);
            Guard(request, revision, false);
            if (request.AppendPreview)
            {
                uint restoredSequence;
                ClipboardRestored =
                    RestoreClipboard(owner, original, copiedSequence, request.Pid, revision, out restoredSequence);
                Need(ClipboardRestored, "DRAFT_CLIPBOARD_RESTORE_UNCONFIRMED");
                clipboardBaselineSequence = restoredSequence;
                copiedSequence = 0;
                Chord(request, revision, 0x23);
                WaitGuarded(request, revision, 50);
                CaretApplied = true;
                for (int index = 0; index < request.Graphemes.Length; index++)
                {
                    if (index > 0)
                        WaitGuarded(request, revision, request.Interval);
                    Guard(request, revision, false);
                    NoKeysHeld();
                    Need(GetClipboardSequenceNumber() == clipboardBaselineSequence, "DRAFT_CLIPBOARD_CHANGED");
                    // Count accepted input batches; only final exact-copy evidence verifies display.
                    TextInputAttempted = true;
                    SendEvents(TextEvents(request.Graphemes[index]));
                    GraphemesApplied++;
                    Guard(request, revision, false);
                }
                WaitGuarded(request, revision, 100);
                Need(GetClipboardSequenceNumber() == clipboardBaselineSequence, "DRAFT_CLIPBOARD_CHANGED");
                uint previousCopy = clipboardBaselineSequence;
                Chord(request, revision, 0x41);
                WaitGuarded(request, revision, 50);
                Need(GetClipboardSequenceNumber() == previousCopy, "DRAFT_CLIPBOARD_CHANGED");
                Chord(request, revision, 0x43);
                long finalUntil = Now() + 1000;
                while (GetClipboardSequenceNumber() == previousCopy && Now() < finalUntil)
                    WaitGuarded(request, revision, 15);
                Guard(request, revision, false);
                uint finalSequence = GetClipboardSequenceNumber();
                Need(finalSequence != previousCopy, "DRAFT_FINAL_COPY_UNCHANGED");
                copiedSequence = finalSequence;
                ClipboardRestored = false;
                Need(ClipboardOwnerPid() == request.Pid, "DRAFT_COPY_OWNER_MISMATCH");
                ClipboardState finalCopy = ReadProjectionClipboard(owner, request, request.FinalDraft);
                Need(finalCopy.Sequence == copiedSequence && finalCopy.OwnerPid == request.Pid,
                     "DRAFT_CLIPBOARD_CHANGED");
                draft = ValidateCopy(original, finalCopy, request.Pid, request.FinalDraft);
                Guard(request, revision, false);
                TextVerified = true;
            }
        }
        catch (Exception error)
        {
            failure = error;
        }
        finally
        {
            // Never move the caret or overwrite a newer clipboard after user intervention.
            if (selected && failure == null)
            {
                try
                {
                    Guard(request, revision, false);
                    NoKeysHeld();
                    Chord(request, revision, 0x23);
                    Thread.Sleep(30);
                    Guard(request, revision, false);
                    CaretApplied = true;
                }
                catch (Exception error)
                {
                    if (failure == null)
                        failure = error;
                }
            }
            if (copiedSequence != 0 && copiedSequence != original.Sequence)
            {
                try
                {
                    Guard(request, revision, false);
                    ClipboardRestored = RestoreClipboard(owner, original, copiedSequence, request.Pid, revision);
                }
                catch (Exception error)
                {
                    if (failure == null)
                        failure = error;
                }
            }
            else
                ClipboardRestored = GetClipboardSequenceNumber() == clipboardBaselineSequence;
        }
        if (failure != null)
            throw failure;
        Need(ClipboardRestored, "DRAFT_CLIPBOARD_RESTORE_UNCONFIRMED");
        Guard(request, revision, false);
        if (request.SubmitPreview)
            SubmitOnce(request, revision);
        return Data("ok", true, "mode",
                    request.SubmitPreview   ? "submitDraftPreview"
                    : request.AppendPreview ? "appendDraftPreview"
                                            : "verifyDraft",
                    "sessionId", request.SessionId, "calibrationHash", request.CalibrationHash, "draft", draft,
                    "draftVerified", true, "copySequence", copiedSequence, "copyOwnerPid", request.Pid, "plainTextOnly",
                    !request.OperatorCalibrated, "textProjectionOnly", request.OperatorCalibrated,
                    "richContentVerified", false, "copyFormats", CopyFormatDiagnostic, "richStructure",
                    RichStructureDiagnostic, "activityRevision", revision, "caretToEndInputApplied", CaretApplied,
                    "caretAtEndVerified", false, "clipboardRestored", ClipboardRestored, "inputAttempted",
                    InputAttempted, "messageSent", SubmitAttempted ? (object)null : false, "accountVerified", false,
                    "targetVerified", false, "editorFocusEvidence",
                    request.OperatorCalibrated ? "operator-calibrated-edit-region" : "native-caret-in-editor-region",
                    "nativeCaretVerified", !request.OperatorCalibrated, "expectedDraftMatched",
                    request.ExpectedDraft != null, "unattendedReady", false, "textInputAttempted", TextInputAttempted,
                    "textVerified", TextVerified, "graphemesApplied", GraphemesApplied, "graphemesVerified",
                    TextVerified ? GraphemesApplied : 0, "submitAttempted", SubmitAttempted, "sendInputAttempted",
                    SubmitAttempted, "submitInputApplied", SubmitInputApplied, "deliveryConfirmed", false);
    }
    static bool Intersects(Rect left, Rect right)
    {
        return left.Left < right.Right && right.Left < left.Right && left.Top < right.Bottom && right.Top < left.Bottom;
    }
    static void ValidateButton(Rect client, Rect editor, Rect button)
    {
        Need(Contains(client, button) && !Intersects(editor, button) && button.Width >= 4 && button.Height >= 4,
             "DRAFT_SEND_BUTTON_INVALID");
    }
    static Input Mouse(int x, int y, uint flags)
    {
        return new Input { Type = 0, Value = new InputUnion { Mouse = new MouseInput { X = x, Y = y, Flags = flags,
                                                                                       Extra = Marker } } };
    }
    static Input[] ClickEvents(int x, int y, Rect desktop)
    {
        Need(desktop.Width >= 2 && desktop.Height >= 2 && x >= desktop.Left && x < desktop.Right && y >= desktop.Top &&
                 y < desktop.Bottom,
             "DRAFT_SCREEN_CHANGED");
        int absoluteX = (int)(((long)x - desktop.Left) * 65535 / (desktop.Width - 1)),
            absoluteY = (int)(((long)y - desktop.Top) * 65535 / (desktop.Height - 1));
        return new[] { Mouse(absoluteX, absoluteY, 0xc001), Mouse(0, 0, 2), Mouse(0, 0, 4) };
    }
    static Input[] ClickReleases(uint accepted)
    {
        return accepted == 2 ? new[] { Mouse(0, 0, 4) } : new Input[0];
    }
    static void SubmitOnce(Request request, long revision)
    {
        Need(request.SubmitPreview && !SubmitAttempted, "DRAFT_SUBMIT_ALREADY_ATTEMPTED");
        Guard(request, revision, false);
        NoKeysHeld();
        ValidateButton(request.Client, request.Editor, request.SendButton);
        Point center = new Point(request.Capture.Left + request.SendButton.Left + request.SendButton.Width / 2,
                                 request.Capture.Top + request.SendButton.Top + request.SendButton.Height / 2);
        Need(Owned(WindowFromPoint(center), request.Window, request.Pid), "DRAFT_SEND_BUTTON_OBSCURED");
        int left = GetSystemMetrics(76), top = GetSystemMetrics(77), width = GetSystemMetrics(78),
            height = GetSystemMetrics(79);
        Input[] events = ClickEvents(center.X, center.Y, new Rect(left, top, left + width, top + height));
        Guard(request, revision, false);
        NoKeysHeld();
        Need(Owned(WindowFromPoint(center), request.Window, request.Pid) && GetForegroundWindow() == request.Window &&
                 Interlocked.Read(ref Revision) == revision,
             "DRAFT_SEND_BUTTON_CHANGED");
        // Persist the uncertain boundary before entering SendInput. Never retry, even on zero.
        SubmitAttempted = true;
        InputAttempted = true;
        uint applied = SendInput((uint)events.Length, events, Marshal.SizeOf(typeof(Input)));
        if (applied != events.Length)
        {
            Input[] releases = ClickReleases(applied);
            if (releases.Length > 0)
                SendInput((uint)releases.Length, releases, Marshal.SizeOf(typeof(Input)));
            throw new Fault("DRAFT_SUBMIT_INPUT_UNCERTAIN");
        }
        SubmitInputApplied = true;
    }
    static void WaitGuarded(Request request, long revision, int milliseconds)
    {
        long end = Now() + milliseconds;
        for (;;)
        {
            long remaining = end - Now();
            if (remaining <= 0)
                break;
            Thread.Sleep((int)Math.Min(15, remaining));
            Guard(request, revision, false);
        }
    }
    static Input Key(ushort key, uint flags)
    {
        return Key(key, 0, flags);
    }
    static Input Key(ushort key, ushort scan, uint flags)
    {
        return new Input { Type = 1,
                           Value = new InputUnion { Keyboard = new KeyInput { Key = key, Scan = scan, Flags = flags,
                                                                              Extra = Marker } } };
    }
    static Input[] ChordEvents(ushort key)
    {
        Need(key == 0x41 || key == 0x43 || key == 0x23, "DRAFT_KEY_FORBIDDEN");
        return new[] { Key(0x11, 0), Key(key, 0), Key(key, 2), Key(0x11, 2) };
    }
    static void Chord(Request request, long revision, ushort key)
    {
        Guard(request, revision, false);
        NoKeysHeld();
        SendEvents(ChordEvents(key));
    }
    static Input[] Releases(Input[] events, uint inserted)
    {
        var release = new List<Input>();
        for (int i = (int)Math.Min(inserted, (uint)events.Length) - 1; i >= 0; i--)
        {
            var key = events[i].Value.Keyboard;
            if ((key.Flags & 2) == 0)
                release.Add(Key(key.Key, key.Scan, key.Flags | 2));
        }
        return release.ToArray();
    }
    static void SendEvents(Input[] events)
    {
        InputAttempted = true;
        uint sent = SendInput((uint)events.Length, events, Marshal.SizeOf(typeof(Input)));
        if (sent != events.Length)
        {
            Input[] release = Releases(events, sent);
            if (release.Length > 0)
                SendInput((uint)release.Length, release, Marshal.SizeOf(typeof(Input)));
            throw new Fault("DRAFT_INPUT_INCOMPLETE");
        }
    }
    // Same UTF-16 SendInput pairs and extended-grapheme boundary used by WechatUiHost.
    // This preview intentionally excludes that host's newline chord path.
    static Input[] TextEvents(string text)
    {
        Need(!String.IsNullOrEmpty(text) && text.Length <= 64, "DRAFT_APPEND_TEXT_INVALID");
        for (int i = 0; i < text.Length; i++)
        {
            Need(!Char.IsControl(text[i]) && text[i] != '\u2028' && text[i] != '\u2029',
                 "DRAFT_APPEND_CONTROL_FORBIDDEN");
            Need(CharUnicodeInfo.GetUnicodeCategory(text, i) != UnicodeCategory.Format || text[i] == '\u200d',
                 "DRAFT_APPEND_CONTROL_FORBIDDEN");
            if (Char.IsHighSurrogate(text[i]))
            {
                Need(i + 1 < text.Length && Char.IsLowSurrogate(text[i + 1]), "DRAFT_APPEND_TEXT_INVALID");
                i++;
            }
            else
                Need(!Char.IsLowSurrogate(text[i]), "DRAFT_APPEND_TEXT_INVALID");
        }
        int elements = new StringInfo(text).LengthInTextElements;
        Need(text.IndexOf('\u200d') < 0 || EmojiSequence(text), "DRAFT_APPEND_NOT_SINGLE_GRAPHEME");
        Need(elements == 1 || RegionalPair(text) || EmojiSequence(text), "DRAFT_APPEND_NOT_SINGLE_GRAPHEME");
        var events = new List<Input>();
        foreach (char character in text)
        {
            events.Add(Key(0, character, 4));
            events.Add(Key(0, character, 6));
        }
        return events.ToArray();
    }
    static bool RegionalPair(string text)
    {
        return text.Length == 4 && Char.ConvertToUtf32(text, 0) >= 0x1f1e6 && Char.ConvertToUtf32(text, 0) <= 0x1f1ff &&
               Char.ConvertToUtf32(text, 2) >= 0x1f1e6 && Char.ConvertToUtf32(text, 2) <= 0x1f1ff;
    }
    static bool EmojiSequence(string text)
    {
        foreach (string part in text.Split('\u200d'))
        {
            if (part.Length == 0)
                return false;
            int first = Char.ConvertToUtf32(part, 0);
            if (!((first >= 0x1f000 && first <= 0x1faff) || (first >= 0x2600 && first <= 0x27bf)))
                return false;
            string remainder = part;
            if (part.Length >= 4)
            {
                int offset = Char.IsLowSurrogate(part[part.Length - 1]) ? part.Length - 2 : part.Length - 1;
                int last = Char.ConvertToUtf32(part, offset);
                if (last >= 0x1f3fb && last <= 0x1f3ff)
                    remainder = part.Substring(0, offset);
            }
            if (new StringInfo(remainder).LengthInTextElements != 1)
                return false;
        }
        return true;
    }
    static void Human()
    {
        Interlocked.Exchange(ref LastActivity, Now());
        Interlocked.Increment(ref Revision);
    }
    static bool Own(uint flags, uint injected, UIntPtr marker)
    {
        return (flags & injected) != 0 && marker.Equals(Marker);
    }
    [Serializable]
    sealed class FocusConfirmation
    {
        internal bool Attempted, Accepted, Confirmed;
        internal long ElapsedMs;
        internal string Reason = "guard-failed";
        internal object Activation;
        internal object Report()
        {
            var report = Data("attempted", Attempted, "accepted", Accepted, "confirmed", Confirmed, "elapsedMs",
                              ElapsedMs, "reason", Reason);
            if (Activation != null)
                report.Add("activation", Activation);
            return report;
        }
    }
    [ThreadStatic]
    static Dictionary<string, object> FocusActivationDiagnostic;
    sealed class FocusActivation
    {
        internal Rect Rect;
        internal string Hash;
        internal bool BlankCaption, UiaCaption;
        internal object Report()
        {
            return UiaCaption     ? Data("rect", Rect.Report(), "mode", "uia-caption-v1")
                   : BlankCaption ? Data("rect", Rect.Report(), "mode", "blank-caption-v1")
                                  : Data("rect", Rect.Report(), "rgbaSha256", Hash);
        }
    }
    static bool FocusActivationGeometry(Rect rect, int width)
    {
        return rect.Left >= 160 && rect.Top >= 0 && rect.Right <= width - 160 && rect.Bottom <= 48 &&
               rect.Width >= 20 && rect.Width <= 200 && rect.Height >= 8 && rect.Height <= 40;
    }
    static FocusActivation ParseFocusActivation(object value, int width)
    {
        if (value == null)
            return null;
        var data = Map(value);
        Need(data != null && data.Count == 2, "DRAFT_FOCUS_CALIBRATION_INVALID");
        Rect rect = ParseRect(Get(data, "rect"));
        string hash = Text(data, "rgbaSha256");
        bool blank = Text(data, "mode") == "blank-caption-v1", uia = Text(data, "mode") == "uia-caption-v1";
        Need(FocusActivationGeometry(rect, width) && (blank || uia || Hex(hash, 64)),
             "DRAFT_FOCUS_CALIBRATION_INVALID");
        return new FocusActivation { Rect = rect, Hash = hash, BlankCaption = blank, UiaCaption = uia };
    }
    static bool FocusUsesUia(FocusActivation calibration, Action<Rect> semanticGuard)
    {
        bool requested = calibration != null && calibration.UiaCaption;
        Need(requested == (semanticGuard != null), "DRAFT_FOCUS_UIA_VERIFIER_REQUIRED");
        return requested;
    }
    static bool FocusTryRequest(Func<bool> request, Func<bool> calibratedClick, Func<bool> alreadyTarget = null)
    {
        return request() || alreadyTarget != null && alreadyTarget() || calibratedClick != null && calibratedClick();
    }
    // A denied API request may already have been followed by the intended
    // foreground transition. This is only permission to skip a pending click;
    // ConfirmFocusOnce still performs its two guarded target observations.
    static bool FocusTargetBeforeClick(IntPtr source, IntPtr target, Action guard, Func<IntPtr> foreground,
                                       Dictionary<string, object> diagnostic = null)
    {
        guard();
        IntPtr current = foreground();
        if (diagnostic != null)
            diagnostic["foregroundAfter"] = current == target        ? "target"
                                            : current == source      ? "source"
                                            : current == IntPtr.Zero ? "none"
                                                                     : "other";
        if (current == target)
        {
            if (diagnostic != null)
                diagnostic["alreadyTargetWithoutClick"] = true;
            return true;
        }
        Need(current == source, "DRAFT_FOCUS_SOURCE_CHANGED");
        return false;
    }
    static void FocusThreadReady(uint thread, Dictionary<string, object> diagnostic = null, string flagsKey = null)
    {
        Need(thread != 0 &&
                 String.Equals(ObjectName(GetThreadDesktop(thread)), "Default", StringComparison.OrdinalIgnoreCase),
             "DRAFT_DESKTOP_UNAVAILABLE");
        var info = new GuiInfo { Size = (uint)Marshal.SizeOf(typeof(GuiInfo)) };
        Need(GetGUIThreadInfo(thread, ref info), "DRAFT_FOCUS_UNAVAILABLE");
        uint flags = info.Flags & 0x1e;
        if (diagnostic != null)
            diagnostic[flagsKey] = flags;
        Need(flags == 0, "DRAFT_MENU_OR_MOVE_ACTIVE");
    }
    static long? FocusInputIdleMilliseconds(long now, uint inputTick)
    {
        uint elapsed = unchecked((uint)now - inputTick);
        return elapsed <= Int32.MaxValue ? (long?)elapsed : null;
    }
    // No attached input queues: SetForegroundWindow can block synchronously
    // when queues are linked. Use verified caption input as the physical fallback.
    static bool ActivateForegroundOnce(IntPtr source, IntPtr target, Action guard, FocusActivation calibration = null,
                                       Action<Rect> semanticGuard = null)
    {
        FocusUsesUia(calibration, semanticGuard);
        guard();
        Desktop();
        NoKeysHeld();
        uint sourcePid, targetPid;
        uint own = GetCurrentThreadId(), from = GetWindowThreadProcessId(source, out sourcePid),
             to = GetWindowThreadProcessId(target, out targetPid);
        Need(own != 0 && from != 0 && to != 0 && GetForegroundWindow() == source, "DRAFT_FOCUS_SOURCE_CHANGED");
        var diagnostic =
            Data("currentThreadId", own, "sourceThreadId", from, "targetThreadId", to, "attachmentNeeded", false,
                 "attached", false, "detached", false, "attachError", 0, "detachError", 0, "foregroundLastError", 0,
                 "foregroundLastErrorInformational", true, "foregroundAfter", "not-requested",
                 "calibratedClickAttempted", false, "calibratedClickApplied", false, "pointerRestored", false);
        FocusActivationDiagnostic = diagnostic;
        FocusThreadReady(from, diagnostic, "sourceMenuOrMoveFlags");
        FocusThreadReady(to, diagnostic, "targetMenuOrMoveFlags");
        Action validate = delegate
        {
            guard();
            Desktop();
            NoKeysHeld();
            uint a, b;
            Need(GetWindowThreadProcessId(source, out a) == from && a == sourcePid &&
                     GetWindowThreadProcessId(target, out b) == to && b == targetPid,
                 "DRAFT_FOCUS_THREAD_CHANGED");
            FocusThreadReady(from, diagnostic, "sourceMenuOrMoveFlags");
            FocusThreadReady(to, diagnostic, "targetMenuOrMoveFlags");
        };
        return FocusTryRequest(
            delegate {
                diagnostic["callerWasForegroundProcess"] = sourcePid == GetCurrentProcessId();
                var input = new LastInput { Size = (uint)Marshal.SizeOf(typeof(LastInput)) };
                if (GetLastInputInfo(ref input))
                    diagnostic["sessionIdleMs"] = FocusInputIdleMilliseconds(Now(), input.Time);
                uint timeout;
                if (FocusGetSystemParameter(0x2000, 0, out timeout, 0))
                    diagnostic["foregroundLockTimeoutMs"] = timeout;
                validate();
                Need(GetForegroundWindow() == source, "DRAFT_FOCUS_SOURCE_CHANGED");
                FocusClearLastError(0);
                bool accepted = FocusSetForegroundWindow(target);
                diagnostic["foregroundRequestAccepted"] = accepted;
                diagnostic["foregroundLastError"] = Marshal.GetLastWin32Error();
                IntPtr after = GetForegroundWindow();
                diagnostic["foregroundAfter"] = after == target        ? "target"
                                                : after == source      ? "source"
                                                : after == IntPtr.Zero ? "none"
                                                                       : "other";
                diagnostic["foregroundAfterRequest"] = diagnostic["foregroundAfter"];
                return accepted;
            },
            calibration == null ? (Func<bool>)null
                                : delegate {
                                      return FocusCalibratedClick(source, target, targetPid, calibration, validate,
                                                                  diagnostic, semanticGuard);
                                  },
            delegate { return FocusTargetBeforeClick(source, target, validate, GetForegroundWindow, diagnostic); });
    }
    static bool FocusBlankCaption(byte[] pixels)
    {
        if (pixels == null || pixels.Length < 4 || pixels.Length % 4 != 0)
            return false;
        // The automatic locator chooses an empty title-bar patch. Re-observe
        // its actual inactive colour; it need not match the active theme.
        for (int i = 0; i < pixels.Length; i += 4)
        {
            if (pixels[i + 3] != 255 || Math.Abs(pixels[i] - pixels[0]) > 3 ||
                Math.Abs(pixels[i + 1] - pixels[1]) > 3 || Math.Abs(pixels[i + 2] - pixels[2]) > 3)
                return false;
        }
        return true;
    }
    static string FocusPixels(Rect screen)
    {
        return FocusPixels(screen, false);
    }
    static string FocusPixels(Rect screen, bool blankCaption)
    {
        using (var bitmap = new Bitmap(screen.Width, screen.Height, PixelFormat.Format32bppArgb))
        {
            using (var graphics = Graphics.FromImage(bitmap)) graphics.CopyFromScreen(
                screen.Left, screen.Top, 0, 0, new Size(screen.Width, screen.Height), CopyPixelOperation.SourceCopy);
            var bits = bitmap.LockBits(new Rectangle(0, 0, bitmap.Width, bitmap.Height), ImageLockMode.ReadOnly,
                                       PixelFormat.Format32bppArgb);
            try
            {
                byte[] bytes = new byte[screen.Width * screen.Height * 4], row = new byte[screen.Width * 4];
                int offset = 0;
                for (int y = 0; y < screen.Height; y++)
                {
                    Marshal.Copy(IntPtr.Add(bits.Scan0, y * bits.Stride), row, 0, row.Length);
                    for (int x = 0; x < row.Length; x += 4)
                    {
                        bytes[offset++] = row[x + 2];
                        bytes[offset++] = row[x + 1];
                        bytes[offset++] = row[x];
                        bytes[offset++] = 255;
                    }
                }
                if (blankCaption && !FocusBlankCaption(bytes))
                    return null;
                using (var sha = SHA256.Create()) return BitConverter.ToString(sha.ComputeHash(bytes))
                    .Replace("-", "")
                    .ToLowerInvariant();
            }
            finally
            {
                bitmap.UnlockBits(bits);
            }
        }
    }
    static bool FocusAreaOwned(Rect area, IntPtr target, uint pid)
    {
        return Owned(WindowFromPoint(new Point(area.Left + area.Width / 2, area.Top + area.Height / 2)), target, pid) &&
               Owned(WindowFromPoint(new Point(area.Left, area.Top)), target, pid) &&
               Owned(WindowFromPoint(new Point(area.Right - 1, area.Top)), target, pid) &&
               Owned(WindowFromPoint(new Point(area.Left, area.Bottom - 1)), target, pid) &&
               Owned(WindowFromPoint(new Point(area.Right - 1, area.Bottom - 1)), target, pid);
    }
    // Windows can keep the foreground window above a no-activate HWND_TOP
    // request. Temporarily expose only the already observed blank caption;
    // remove our topmost flag even when input/activity guards subsequently fail.
    static bool FocusRemoveTemporaryTopmost(Func<bool> alive, Func<bool> topmost, Func<bool> remove, Func<long> clock,
                                            Action<int> wait)
    {
        if (!alive())
            return true;
        // HWND_TOPMOST may still be queued: always enqueue its reversal for
        // this live window, even when the style bit has not appeared yet.
        long deadline = clock() + 80;
        if (!remove())
            return false;
        wait(20);
        for (;;)
        {
            if (!alive())
                return true;
            if (clock() > deadline)
                return false;
            if (!topmost())
            {
                wait(5);
                if (!alive())
                    return true;
                if (clock() <= deadline && !topmost())
                    return true;
            }
            if (clock() >= deadline)
                return false;
            wait(5);
        }
    }
    static bool FocusOriginalWindowAlive(FocusOrderAnchor identity)
    {
        if (!IsWindow(identity.Window))
            return false;
        uint pid;
        uint thread = GetWindowThreadProcessId(identity.Window, out pid);
        if (pid != identity.Pid || thread != identity.Thread)
            return false;
        IntPtr process = OpenProcess(0x1000, false, pid);
        Need(process != IntPtr.Zero, "DRAFT_FOCUS_PROCESS_UNVERIFIED");
        try
        {
            FileTime start, exit, kernel, user;
            Need(GetProcessTimes(process, out start, out exit, out kernel, out user), "DRAFT_FOCUS_PROCESS_UNVERIFIED");
            return start.Value == identity.Created;
        }
        finally
        {
            CloseHandle(process);
        }
    }
    // Keep the user's foreground and all intervening windows in their own
    // order. If raising WeChat fails to expose its caption, only WeChat can
    // be repositioned during rollback, behind its original predecessor.
    sealed class FocusOrderAnchor
    {
        internal IntPtr Window;
        internal uint Pid, Thread;
        internal long Created;
    }
    static FocusOrderAnchor FocusReadOrderAnchor(IntPtr window)
    {
        uint pid;
        uint thread = GetWindowThreadProcessId(window, out pid);
        Need(thread != 0 && pid != 0 && (FocusGetWindowLongPtr(window, -20).ToInt64() & 8) == 0,
             "DRAFT_FOCUS_SOURCE_CHANGED");
        IntPtr process = OpenProcess(0x1000, false, pid);
        Need(process != IntPtr.Zero, "DRAFT_FOCUS_SOURCE_CHANGED");
        try
        {
            FileTime start, exit, kernel, user;
            Need(GetProcessTimes(process, out start, out exit, out kernel, out user), "DRAFT_FOCUS_SOURCE_CHANGED");
            return new FocusOrderAnchor { Window = window, Pid = pid, Thread = thread, Created = start.Value };
        }
        finally
        {
            CloseHandle(process);
        }
    }
    static FocusOrderAnchor FocusCapturePredecessor(IntPtr target)
    {
        IntPtr at = FocusZOrderWindow(target, 3);
        for (int i = 0; at != IntPtr.Zero && i < 4096; i++, at = FocusZOrderWindow(at, 3))
        {
            if (!IsWindowVisible(at) || IsIconic(at) || FocusZOrderWindow(at, 4) == target ||
                (FocusGetWindowLongPtr(at, -20).ToInt64() & 8) != 0)
                continue;
            int cloaked;
            if (DwmGetWindowAttribute(at, 14, out cloaked, 4) >= 0 && cloaked != 0)
                continue;
            return FocusReadOrderAnchor(at);
        }
        return null;
    }
    static Dictionary<string, object> FocusUndoCaptionRaise(IntPtr target, IntPtr source, FocusOrderAnchor predecessor,
                                                            bool raised, bool clicked, bool originalAbove, Action guard)
    {
        Action check = delegate
        {
            guard();
            Need(predecessor != null, "DRAFT_FOCUS_SOURCE_CHANGED");
            var current = FocusReadOrderAnchor(predecessor.Window);
            Need(current.Pid == predecessor.Pid && current.Thread == predecessor.Thread &&
                     current.Created == predecessor.Created,
                 "DRAFT_FOCUS_SOURCE_CHANGED");
        };
        return FocusRestoreCaptionOrder(target, source, predecessor == null ? IntPtr.Zero : predecessor.Window, raised,
                                        clicked, originalAbove, check,
                                        FocusWindowAbove, delegate(IntPtr window, IntPtr after) {
                                            return FocusSetWindowPos(window, after, 0, 0, 0, 0, 0x4213);
                                        }, Now, Thread.Sleep);
    }
    static Dictionary<string, object> FocusRestoreCaptionOrder(IntPtr target, IntPtr source, IntPtr predecessor,
                                                               bool raised, bool clicked, bool originalAbove,
                                                               Action guard, Func<IntPtr, IntPtr, bool> above,
                                                               Func<IntPtr, IntPtr, bool> position, Func<long> clock,
                                                               Action<int> wait)
    {
        return FocusRestoreUnclickedRaise(
            raised, clicked, predecessor != IntPtr.Zero, guard,
            delegate { return (!originalAbove || above(source, target)) && above(predecessor, target); },
            delegate {
                guard();
                return position(target, predecessor);
            },
            clock, wait);
    }
    // SendInput may return before its move/down/up have settled. Wait briefly
    // for our click position and released buttons; never follow a user's move.
    static bool FocusRestoreClickPointer(bool applied, Action guard, Func<bool> atClick, Func<bool> restore,
                                         Func<bool> atSaved, Func<long> clock, Action<int> wait)
    {
        if (!applied)
            return false;
        long deadline = clock() + 40;
        bool requested = false;
        try
        {
            for (;;)
            {
                try
                {
                    guard();
                    if (clock() > deadline)
                        return false;
                    if (requested)
                    {
                        if (atSaved())
                        {
                            guard();
                            return clock() <= deadline && atSaved();
                        }
                    }
                    else if (atClick())
                    {
                        guard();
                        if (clock() > deadline || !atClick() || !restore())
                            return false;
                        requested = true;
                        continue;
                    }
                }
                catch (Fault error)
                {
                    if (error.Message != "DRAFT_KEYS_HELD" || requested)
                        throw;
                }
                long remaining = deadline - clock();
                if (remaining <= 0)
                    return false;
                wait((int)Math.Min(5, remaining));
            }
        }
        catch
        {
            return false;
        }
    }
    static bool FocusWindowAbove(IntPtr above, IntPtr below)
    {
        if (above == IntPtr.Zero || below == IntPtr.Zero || above == below)
            return false;
        IntPtr current = above;
        for (int count = 0; count < 4096; count++)
        {
            current = FocusZOrderWindow(current, 2);
            if (current == below)
                return true;
            if (current == IntPtr.Zero || current == above)
                return false;
        }
        return false;
    }
    // Undo only our no-activate raise, never a click or a user's window switch.
    // The original source must have been above this target before our request.
    static Dictionary<string, object> FocusRestoreUnclickedRaise(bool raised, bool clicked, bool sourceOriginallyAbove,
                                                                 Action guard, Func<bool> sourceAbove,
                                                                 Func<bool> raiseSource, Func<long> clock,
                                                                 Action<int> wait)
    {
        var report = Data("attempted", false, "accepted", null, "confirmed", false, "reason",
                          !raised                  ? "no-raise"
                          : clicked                ? "click-attempted"
                          : !sourceOriginallyAbove ? "original-order-preserved"
                                                   : "guard-pending");
        if (!raised || clicked || !sourceOriginallyAbove)
            return report;
        try
        {
            long deadline = clock() + 150;
            guard();
            bool above = sourceAbove();
            guard();
            if (clock() >= deadline)
            {
                report["reason"] = "restore-timeout";
                return report;
            }
            if (!above)
            {
                report["attempted"] = true;
                report["accepted"] = raiseSource();
                guard();
            }
            for (;;)
            {
                guard();
                if (clock() >= deadline)
                {
                    report["reason"] = "restore-timeout";
                    return report;
                }
                if (sourceAbove())
                {
                    wait(20);
                    guard();
                    if (clock() <= deadline && sourceAbove())
                    {
                        guard();
                        if (clock() <= deadline)
                        {
                            report["confirmed"] = true;
                            report["reason"] = "source-order-restored";
                            return report;
                        }
                    }
                }
                if (clock() >= deadline)
                {
                    report["reason"] = "restore-timeout";
                    return report;
                }
                wait(10);
            }
        }
        catch
        {
            report["reason"] = "source-activity-or-binding-changed";
            return report;
        }
    }
    static bool FocusCalibratedClick(IntPtr source, IntPtr target, uint pid, FocusActivation calibration, Action guard,
                                     Dictionary<string, object> diagnostic, Action<Rect> semanticGuard = null)
    {
        bool uia = FocusUsesUia(calibration, semanticGuard);
        if (FocusTargetBeforeClick(source, target, guard, GetForegroundWindow, diagnostic))
            return true;
        Rect client;
        Point origin = new Point(0, 0), saved = new Point(0, 0);
        Need(GetClientRect(target, out client) && ClientToScreen(target, ref origin) &&
                 FocusActivationGeometry(calibration.Rect, client.Width) && FocusGetCursorPos(out saved),
             "DRAFT_FOCUS_CALIBRATION_INVALID");
        Need((FocusGetWindowLongPtr(target, -20).ToInt64() & 8) == 0, "DRAFT_FOCUS_TOPMOST_REFUSED");
        Rect area = new Rect(origin.X + calibration.Rect.Left, origin.Y + calibration.Rect.Top,
                             origin.X + calibration.Rect.Right, origin.Y + calibration.Rect.Bottom),
             desktop = new Rect(GetSystemMetrics(76), GetSystemMetrics(77), GetSystemMetrics(76) + GetSystemMetrics(78),
                                GetSystemMetrics(77) + GetSystemMetrics(79));
        Need(Contains(desktop, area), "DRAFT_SCREEN_CHANGED");
        uint dpi = GetDpiForWindow(target);
        long revision = Interlocked.Read(ref Revision);
        Point center = new Point(area.Left + area.Width / 2, area.Top + area.Height / 2);
        Action stable = delegate
        {
            guard();
            Rect current;
            Point start = new Point(0, 0);
            Need(GetClientRect(target, out current) && ClientToScreen(target, ref start) && Same(current, client) &&
                     start.X == origin.X && start.Y == origin.Y && GetDpiForWindow(target) == dpi,
                 "DRAFT_FOCUS_GEOMETRY_CHANGED");
            Need(Interlocked.Read(ref Revision) == revision, "DRAFT_HUMAN_ACTIVITY_CHANGED");
        };
        Rect sourceClient;
        Point sourceOrigin = new Point(0, 0);
        Need(GetClientRect(source, out sourceClient) && ClientToScreen(source, ref sourceOrigin),
             "DRAFT_FOCUS_GEOMETRY_CHANGED");
        bool sourceOriginallyAbove = FocusWindowAbove(source, target), raiseAttempted = false, clickAttempted = false,
             temporaryTopmost = false;
        FocusOrderAnchor predecessor = null;
        FocusOrderAnchor targetIdentity = FocusReadOrderAnchor(target);
        Action removeTopmost = delegate
        {
            if (!temporaryTopmost)
                return;
            bool removed = FocusRemoveTemporaryTopmost(
                delegate { return FocusOriginalWindowAlive(targetIdentity); },
                delegate { return (FocusGetWindowLongPtr(target, -20).ToInt64() & 8) != 0; },
                delegate { return FocusSetWindowPos(target, new IntPtr(-2), 0, 0, 0, 0, 0x4213); }, Now, Thread.Sleep);
            diagnostic["temporaryTopmostRestored"] = removed;
            Need(removed, "DRAFT_FOCUS_TOPMOST_RESTORE_UNCONFIRMED");
            temporaryTopmost = false;
        };
        Action cleanupGuard = delegate
        {
            stable();
            Rect currentSource;
            Point currentOrigin = new Point(0, 0);
            Need(GetForegroundWindow() == source && GetClientRect(source, out currentSource) &&
                     Same(currentSource, sourceClient) && ClientToScreen(source, ref currentOrigin) &&
                     currentOrigin.X == sourceOrigin.X && currentOrigin.Y == sourceOrigin.Y,
                 "DRAFT_FOCUS_SOURCE_CHANGED");
        };
        try
        {
            if (FocusTargetBeforeClick(source, target, stable, GetForegroundWindow, diagnostic))
                return true;
            if (!FocusAreaOwned(area, target, pid))
            {
                predecessor = FocusCapturePredecessor(target);
                if (FocusTargetBeforeClick(source, target, stable, GetForegroundWindow, diagnostic))
                    return true;
                raiseAttempted = true;
                diagnostic["calibratedRaiseAttempted"] = true;
                bool raised = FocusSetWindowPos(target, IntPtr.Zero, 0, 0, 0, 0, 0x4213);
                diagnostic["calibratedRaiseAccepted"] = raised;
                Need(raised, "DRAFT_FOCUS_RAISE_FAILED");
            }
            if (calibration.BlankCaption && !FocusAreaOwned(area, target, pid))
            {
                if (FocusTargetBeforeClick(source, target, stable, GetForegroundWindow, diagnostic))
                    return true;
                temporaryTopmost = true;
                diagnostic["temporaryTopmostAttempted"] = true;
                bool raised = FocusSetWindowPos(target, new IntPtr(-1), 0, 0, 0, 0, 0x4213);
                diagnostic["temporaryTopmostAccepted"] = raised;
                Need(raised, "DRAFT_FOCUS_RAISE_FAILED");
            }
            long deadline = Now() + (uia ? 700 : 250);
            string expected = calibration.Hash;
            diagnostic["allPointsOwned"] = false;
            if (uia)
            {
                diagnostic["uiaCaptionActivation"] = true;
                diagnostic["pixelsRead"] = false;
            }
            else
            {
                diagnostic["expectedRgbaSha256"] = expected;
                diagnostic["actualRgbaSha256"] = null;
                diagnostic["automaticBlankCaption"] = calibration.BlankCaption;
            }
            for (;;)
            {
                if (FocusTargetBeforeClick(source, target, stable, GetForegroundWindow, diagnostic))
                    return true;
                bool visible = FocusAreaOwned(area, target, pid);
                diagnostic["allPointsOwned"] = visible;
                string pixels = !uia && visible ? FocusPixels(area, calibration.BlankCaption) : null;
                if (!uia)
                    diagnostic["actualRgbaSha256"] = pixels;
                if (uia && visible)
                    break;
                if (visible && pixels != null && (calibration.BlankCaption || pixels == expected))
                {
                    Thread.Sleep(20);
                    if (FocusTargetBeforeClick(source, target, stable, GetForegroundWindow, diagnostic))
                        return true;
                    if (FocusAreaOwned(area, target, pid) && FocusPixels(area, calibration.BlankCaption) == pixels)
                    {
                        expected = pixels;
                        break;
                    }
                }
                Need(Now() < deadline, uia ? "DRAFT_FOCUS_UIA_OBSCURED" : "DRAFT_FOCUS_PIXELS_UNVERIFIED");
                Thread.Sleep(10);
            }
            bool applied = false;
            try
            {
                if (FocusTargetBeforeClick(source, target, stable, GetForegroundWindow, diagnostic))
                    return true;
                if (uia)
                {
                    semanticGuard(area);
                    stable();
                    Need(Now() <= deadline, "DRAFT_FOCUS_UIA_TIMEOUT");
                }
                Need(FocusAreaOwned(area, target, pid) &&
                         (uia || FocusPixels(area, calibration.BlankCaption) == expected),
                     "DRAFT_FOCUS_CLICK_CHANGED");
                Input[] inputs = ClickEvents(center.X, center.Y, desktop);
                if (FocusTargetBeforeClick(source, target, stable, GetForegroundWindow, diagnostic))
                    return true;
                Need(FocusAreaOwned(area, target, pid), "DRAFT_FOCUS_CLICK_CHANGED");
                clickAttempted = true;
                InputAttempted = true;
                diagnostic["calibratedClickAttempted"] = true;
                ObserveMouseIntent(0x201, center);
                uint count = SendInput((uint)inputs.Length, inputs, Marshal.SizeOf(typeof(Input)));
                applied = count == inputs.Length;
                diagnostic["calibratedClickApplied"] = applied;
                if (!applied)
                {
                    Input[] releases = ClickReleases(count);
                    if (releases.Length > 0)
                        SendInput((uint)releases.Length, releases, Marshal.SizeOf(typeof(Input)));
                    throw new Fault("DRAFT_FOCUS_CLICK_UNCERTAIN");
                }
                return true;
            }
            finally
            {
                // Only undo our pointer move while the physical input revision and
                // exact click position remain ours; never overwrite resumed input.
                diagnostic["pointerRestored"] = FocusRestoreClickPointer(
                    applied,
                    delegate {
                        stable();
                        IntPtr foreground = GetForegroundWindow();
                        Need(foreground == source || foreground == target, "DRAFT_FOCUS_SOURCE_CHANGED");
                    },
                    delegate {
                        Point cursor;
                        return FocusGetCursorPos(out cursor) && Math.Abs(cursor.X - center.X) <= 1 &&
                               Math.Abs(cursor.Y - center.Y) <= 1;
                    },
                    delegate {
                        Input move = ClickEvents(saved.X, saved.Y, desktop)[0];
                        return SendInput(1, new[] { move }, Marshal.SizeOf(typeof(Input))) == 1;
                    },
                    delegate {
                        Point cursor;
                        return FocusGetCursorPos(out cursor) && Math.Abs(cursor.X - saved.X) <= 1 &&
                               Math.Abs(cursor.Y - saved.Y) <= 1;
                    },
                    Now, Thread.Sleep);
            }
        }
        catch
        {
            removeTopmost();
            diagnostic["raiseCleanup"] = FocusUndoCaptionRaise(target, source, predecessor, raiseAttempted,
                                                               clickAttempted, sourceOriginallyAbove, cleanupGuard);
            throw;
        }
        finally
        {
            removeTopmost();
        }
    }
    static FocusConfirmation ConfirmFocusOnce(IntPtr source, IntPtr target, Func<bool> activate, Action guard,
                                              Func<IntPtr> foreground, Func<long> clock, Action<int> wait,
                                              Action finish = null)
    {
        var result = new FocusConfirmation();
        long started = clock(), deadline = started + 500;
        FocusActivationDiagnostic = null;
        try
        {
            guard();
            if (foreground() != source)
            {
                result.Reason = "foreground-changed";
                return result;
            }
            if (clock() > deadline)
            {
                result.Reason = "timeout";
                return result;
            }
            result.Attempted = true;
            result.Accepted = activate();
            if (!result.Accepted)
            {
                result.Reason = "request-rejected";
                return result;
            }
            for (;;)
            {
                guard();
                if (clock() > deadline)
                {
                    result.Reason = "timeout";
                    return result;
                }
                IntPtr current = foreground();
                if (current == target)
                {
                    guard();
                    current = foreground();
                    if (clock() > deadline)
                    {
                        result.Reason = "timeout";
                        return result;
                    }
                    if (current == target)
                    {
                        result.Confirmed = true;
                        result.Reason = "confirmed";
                        return result;
                    }
                }
                if (current != source && current != IntPtr.Zero)
                {
                    result.Reason = "foreground-changed";
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
            error.Data["focusConfirmation"] = result;
            throw;
        }
        finally
        {
            result.ElapsedMs = Math.Max(0, clock() - started);
            result.Activation = FocusActivationDiagnostic;
            FocusActivationDiagnostic = null;
            try
            {
                if (finish != null)
                    finish();
            }
            catch (Exception error)
            {
                error.Data["focusConfirmation"] = result;
                throw;
            }
        }
    }
    static void NeedFocusConfirmed(FocusConfirmation result, string code)
    {
        if (!result.Confirmed)
        {
            var error = new Fault(code);
            error.Data["focusConfirmation"] = result;
            throw error;
        }
    }
    static object FocusFailureDiagnostic(Exception error)
    {
        var result = error.Data["focusConfirmation"] as FocusConfirmation;
        return result == null ? null : result.Report();
    }
    static int FocusConfirmationSelfTest()
    {
        int checks = 0, calls = 0;
        long clock = 0;
        IntPtr source = new IntPtr(1), target = new IntPtr(2), third = new IntPtr(3);
        Func<bool> accept = delegate
        {
            calls++;
            return true;
        };
        Action guard = delegate {};
        Action<int> wait = delegate(int ms)
        {
            clock += ms;
        };
        bool exposureRestored = false;
        var result = ConfirmFocusOnce(source, target, accept, guard,
                                      delegate { return clock == 0   ? source
                                                        : clock < 30 ? IntPtr.Zero
                                                                     : target; },
                                      delegate { return clock; }, wait,
                                      delegate {
                                          Need(clock == 30, "TEST_FOCUS_EXPOSURE_LASTS_UNTIL_TARGET_CONFIRMED");
                                          exposureRestored = true;
                                      });
        Need(result.Confirmed && result.Accepted && calls == 1 && result.ElapsedMs == 30 && exposureRestored,
             "TEST_FOCUS_ASYNC_CONFIRM");
        checks++;
        calls = 0;
        clock = 0;
        exposureRestored = false;
        result = ConfirmFocusOnce(source, target, accept, guard, delegate { return source; },
                                  delegate { return clock; }, wait, delegate { exposureRestored = true; });
        Need(!result.Confirmed && result.Reason == "timeout" && calls == 1 && clock == 500 && exposureRestored,
             "TEST_FOCUS_WAIT_BOUNDED");
        checks++;
        calls = 0;
        clock = 0;
        int foregroundReads = 0;
        result = ConfirmFocusOnce(source, target, accept, guard,
                                  delegate { return ++foregroundReads == 2 ? target : source; },
                                  delegate { return clock; }, wait);
        Need(!result.Confirmed && result.Reason == "timeout" && calls == 1,
             "TEST_FOCUS_BRIEF_TRANSITION_DOES_NOT_GRANT_INPUT");
        checks++;
        calls = 0;
        clock = 0;
        result = ConfirmFocusOnce(source, target,
                                  delegate {
                                      calls++;
                                      return false;
                                  },
                                  guard, delegate { return source; }, delegate { return clock; }, wait);
        Need(!result.Accepted && !result.Confirmed && calls == 1 && clock == 0 && result.Reason == "request-rejected",
             "TEST_FOCUS_DENIAL_NO_RETRY");
        checks++;
        calls = 0;
        clock = 0;
        result = ConfirmFocusOnce(source, target, accept, guard, delegate { return clock == 0 ? source : third; },
                                  delegate { return clock; }, wait);
        Need(!result.Confirmed && calls == 1 && clock == 10 && result.Reason == "foreground-changed",
             "TEST_FOCUS_THIRD_WINDOW_STOPS");
        checks++;
        calls = 0;
        clock = 0;
        result = ConfirmFocusOnce(source, target, accept, guard, delegate { return third; }, delegate { return clock; },
                                  wait);
        Need(!result.Attempted && calls == 0, "TEST_FOCUS_SOURCE_CHANGED_NO_REQUEST");
        checks++;
        calls = 0;
        clock = 0;
        result = ConfirmFocusOnce(source, target, accept,
                                  delegate {
                                      if (calls > 0)
                                          clock = 501;
                                  },
                                  delegate { return calls == 0 ? source : target; }, delegate { return clock; }, wait);
        Need(!result.Confirmed && calls == 1 && result.Reason == "timeout",
             "TEST_FOCUS_SLOW_GUARD_CANNOT_CONFIRM_LATE");
        checks++;
        foreach (string code in new[] { "DRAFT_HUMAN_ACTIVITY_CHANGED", "DRAFT_KEYS_HELD", "DRAFT_PROCESS_CHANGED",
                                        "DRAFT_STOPPING" })
        {
            calls = 0;
            clock = 0;
            try
            {
                ConfirmFocusOnce(source, target, accept,
                                 delegate {
                                     if (clock >= 10)
                                         throw new Fault(code);
                                 },
                                 delegate { return source; }, delegate { return clock; }, wait);
                throw new Fault("TEST_FOCUS_GUARD_REQUIRED");
            }
            catch (Fault error)
            {
                Need(error.Message == code && calls == 1 && clock == 10 &&
                         Object.Equals(Get(Map(FocusFailureDiagnostic(error)), "accepted"), true),
                     "TEST_FOCUS_GUARD_PRESERVED");
            }
            checks++;
        }
        calls = 0;
        clock = 0;
        int guardCalls = 0;
        Expect(delegate {
            ConfirmFocusOnce(source, target, accept,
                             delegate {
                                 if (++guardCalls == 3)
                                     throw new Fault("DRAFT_HUMAN_ACTIVITY_CHANGED");
                             },
                             delegate { return calls == 0 ? source : target; }, delegate { return clock; }, wait);
        }, "DRAFT_HUMAN_ACTIVITY_CHANGED");
        Need(calls == 1, "TEST_FOCUS_FINAL_GUARD");
        checks++;
        int requests = 0, clicks = 0;
        Need(FocusTryRequest(
                 delegate {
                     requests++;
                     return true;
                 },
                 delegate {
                     clicks++;
                     return true;
                 }) &&
                 requests == 1 && clicks == 0,
             "TEST_FOCUS_ACCEPTED_NO_CLICK");
        checks++;
        requests = clicks = 0;
        Need(FocusTryRequest(
                 delegate {
                     requests++;
                     return false;
                 },
                 delegate {
                     clicks++;
                     return true;
                 }) &&
                 requests == 1 && clicks == 1,
             "TEST_FOCUS_ONE_CALIBRATED_CLICK");
        checks++;
        requests = clicks = 0;
        Need(!FocusTryRequest(delegate {
            requests++;
            return false;
        }, null) && requests == 1 && clicks == 0, "TEST_FOCUS_LEGACY_NO_CLICK");
        checks++;
        requests = clicks = 0;
        Need(!FocusTryRequest(
                 delegate {
                     requests++;
                     return false;
                 },
                 delegate {
                     clicks++;
                     return false;
                 }) &&
                 requests == 1 && clicks == 1,
             "TEST_FOCUS_CLICK_NO_RETRY");
        checks++;
        var observed = Data("calibratedClickAttempted", false);
        requests = clicks = 0;
        Need(FocusTryRequest(
                 delegate {
                     requests++;
                     return false;
                 },
                 delegate {
                     clicks++;
                     return true;
                 },
                 delegate {
                     return FocusTargetBeforeClick(source, target, guard, delegate { return target; }, observed);
                 }) &&
                 requests == 1 && clicks == 0 && Object.Equals(Get(observed, "foregroundAfter"), "target") &&
                 Object.Equals(Get(observed, "alreadyTargetWithoutClick"), true) &&
                 Object.Equals(Get(observed, "calibratedClickAttempted"), false),
             "TEST_FOCUS_DENIED_BUT_TARGET_SKIPS_CLICK");
        checks++;
        observed = Data();
        requests = clicks = 0;
        Need(FocusTryRequest(
                 delegate {
                     requests++;
                     return false;
                 },
                 delegate {
                     clicks++;
                     return true;
                 },
                 delegate {
                     return FocusTargetBeforeClick(source, target, guard, delegate { return source; }, observed);
                 }) &&
                 requests == 1 && clicks == 1 && Object.Equals(Get(observed, "foregroundAfter"), "source") &&
                 !observed.ContainsKey("alreadyTargetWithoutClick"),
             "TEST_FOCUS_DENIED_SOURCE_USES_ORIGINAL_SINGLE_FALLBACK");
        checks++;
        observed = Data();
        requests = clicks = 0;
        Expect(delegate {
            FocusTryRequest(
                delegate {
                    requests++;
                    return false;
                },
                delegate {
                    clicks++;
                    return true;
                },
                delegate {
                    return FocusTargetBeforeClick(source, target, guard, delegate { return third; }, observed);
                });
        }, "DRAFT_FOCUS_SOURCE_CHANGED");
        Need(requests == 1 && clicks == 0 && Object.Equals(Get(observed, "foregroundAfter"), "other"),
             "TEST_FOCUS_DENIED_THIRD_WINDOW_NEVER_CLICKS");
        checks++;
        requests = clicks = 0;
        int reads = 0;
        Expect(delegate {
            FocusTryRequest(
                delegate {
                    requests++;
                    return false;
                },
                delegate {
                    clicks++;
                    return true;
                },
                delegate {
                    return FocusTargetBeforeClick(source, target,
                                                  delegate { throw new Fault("DRAFT_HUMAN_ACTIVITY_CHANGED"); },
                                                  delegate {
                                                      reads++;
                                                      return target;
                                                  });
                });
        }, "DRAFT_HUMAN_ACTIVITY_CHANGED");
        Need(requests == 1 && clicks == 0 && reads == 0, "TEST_FOCUS_ALREADY_TARGET_CANNOT_BYPASS_FRESH_GUARD");
        checks++;
        int phaseGuards = 0;
        observed = Data();
        Need(FocusTargetBeforeClick(source, target, delegate { phaseGuards++; }, delegate { return source; },
                                    observed) == false &&
                 FocusTargetBeforeClick(source, target, delegate { phaseGuards++; }, delegate { return target; },
                                        observed) &&
                 phaseGuards == 2 && Object.Equals(Get(observed, "alreadyTargetWithoutClick"), true),
             "TEST_FOCUS_PENDING_FALLBACK_RECHECKS_BEFORE_CLICK");
        checks++;
        requests = clicks = reads = guardCalls = 0;
        clock = 0;
        IntPtr current = source;
        Action completeGuard = delegate
        {
            guardCalls++;
        };
        result = ConfirmFocusOnce(source, target,
                                  delegate {
                                      return FocusTryRequest(
                                          delegate {
                                              requests++;
                                              current = target;
                                              return false;
                                          },
                                          delegate {
                                              clicks++;
                                              return true;
                                          },
                                          delegate {
                                              return FocusTargetBeforeClick(source, target, completeGuard, delegate {
                                                  reads++;
                                                  return current;
                                              });
                                          });
                                  },
                                  completeGuard,
                                  delegate {
                                      reads++;
                                      return current;
                                  },
                                  delegate { return clock; }, wait);
        Need(result.Accepted && result.Confirmed && requests == 1 && clicks == 0 && reads == 4 && guardCalls == 4,
             "TEST_FOCUS_ALREADY_TARGET_STILL_REQUIRES_EXISTING_DOUBLE_CONFIRMATION");
        checks++;
        Need(ParseFocusActivation(null, 1100) == null &&
                 ParseFocusActivation(
                     Data("rect", new Rect(550, 8, 650, 22).Report(), "rgbaSha256", new string('a', 64)), 1100)
                         .Rect.Width == 100,
             "TEST_FOCUS_CALIBRATION_PARSE");
        checks++;
        Need(ParseFocusActivation(Data("rect", new Rect(550, 8, 650, 22).Report(), "mode", "blank-caption-v1"), 1100)
                 .BlankCaption,
             "TEST_FOCUS_AUTOMATIC_CAPTION_PARSE");
        checks++;
        var uiaActivation =
            ParseFocusActivation(Data("rect", new Rect(550, 8, 650, 22).Report(), "mode", "uia-caption-v1"), 1100);
        Need(uiaActivation.UiaCaption && !uiaActivation.BlankCaption &&
                 Text(Map(uiaActivation.Report()), "mode") == "uia-caption-v1",
             "TEST_FOCUS_UIA_CAPTION_PARSE");
        checks++;
        Need(FocusUsesUia(uiaActivation, delegate(Rect area) {}) && !FocusUsesUia(null, null),
             "TEST_FOCUS_UIA_NATIVE_VALIDATOR");
        checks++;
        Expect(delegate { FocusUsesUia(uiaActivation, null); }, "DRAFT_FOCUS_UIA_VERIFIER_REQUIRED");
        checks++;
        Expect(delegate { FocusUsesUia(new FocusActivation { BlankCaption = true }, delegate(Rect area) {}); },
               "DRAFT_FOCUS_UIA_VERIFIER_REQUIRED");
        checks++;
        Expect(delegate {
            ParseFocusActivation(Data("rect", new Rect(550, 8, 650, 22).Report(), "mode", "unknown"), 1100);
        }, "DRAFT_FOCUS_CALIBRATION_INVALID");
        checks++;
        Need(FocusBlankCaption(new byte[] { 240, 240, 240, 255, 243, 239, 241, 255 }) &&
                 !FocusBlankCaption(new byte[] { 240, 240, 240, 255, 236, 240, 240, 255 }) &&
                 !FocusBlankCaption(new byte[] { 240, 240, 240, 255, 240, 240, 240, 0 }) &&
                 !FocusBlankCaption(new byte[0]),
             "TEST_FOCUS_AUTOMATIC_CAPTION_REJECTS_CONTENT");
        checks++;
        foreach (string scenario in new[] { "already-clear", "destroyed", "delayed-clear", "removal-denied" })
        {
            long elapsed = 0;
            int removals = 0;
            bool alive = scenario != "destroyed";
            bool removed = FocusRemoveTemporaryTopmost(
                delegate { return alive; },
                delegate { return scenario != "already-clear" && (scenario != "delayed-clear" || elapsed < 10); },
                delegate {
                    removals++;
                    return scenario != "removal-denied";
                },
                delegate { return elapsed; }, delegate(int ms) { elapsed += ms; });
            Need(removed == (scenario != "removal-denied") && removals == (scenario == "destroyed" ? 0 : 1) &&
                     elapsed <= 80,
                 "TEST_FOCUS_TEMPORARY_TOPMOST_CLEANUP_OBSERVED_AND_BOUNDED");
            checks++;
        }
        {
            long elapsed = 0;
            bool reverseQueued = false;
            int reversals = 0;
            bool removed = FocusRemoveTemporaryTopmost(
                delegate { return true; }, delegate { return elapsed >= 5 && (!reverseQueued || elapsed < 10); },
                delegate {
                    reverseQueued = true;
                    reversals++;
                    return true;
                },
                delegate { return elapsed; }, delegate(int ms) { elapsed += ms; });
            Need(removed && reverseQueued && reversals == 1 && elapsed >= 10,
                 "TEST_FOCUS_QUEUED_TOPMOST_REVERSED_WHILE_INITIAL_STYLE_IS_FALSE");
            checks++;
        }
        for (int flags = 0; flags < 8; flags++)
        {
            int cleanupCalls = 0;
            long cleanupTime = 0;
            bool eligible = (flags & 1) != 0 && (flags & 2) == 0 && (flags & 4) != 0;
            var cleanup = FocusRestoreUnclickedRaise(
                (flags & 1) != 0, (flags & 2) != 0, (flags & 4) != 0, delegate { cleanupCalls++; },
                delegate { return true; }, delegate { throw new Fault("TEST_UNEXPECTED_RAISE"); },
                delegate { return cleanupTime; }, delegate(int ms) { cleanupTime += ms; });
            Need(Object.Equals(Get(cleanup, "confirmed"), eligible) &&
                     !Object.Equals(Get(cleanup, "attempted"), true) &&
                     (eligible ? cleanupCalls > 0 : cleanupCalls == 0),
                 "TEST_RAISE_CLEANUP_ONLY_UNCLICKED_OWN_ORDER_CHANGE");
            checks++;
        }
        foreach (string boundary in new[] { "own-marker", "real-activity", "third-window", "binding-changed" })
        {
            int cleanupRaises = 0;
            long cleanupTime = 0;
            bool restoredOrder = false;
            long currentRevision = boundary == "real-activity" ? 1 : 0;
            IntPtr currentForeground = boundary == "third-window" ? third : source;
            Action cleanupGuard = delegate
            {
                Need(currentRevision == 0, "DRAFT_HUMAN_ACTIVITY_CHANGED");
                Need(currentForeground == source && boundary != "binding-changed", "DRAFT_FOCUS_SOURCE_CHANGED");
            };
            var cleanup =
                FocusRestoreUnclickedRaise(true, false, true, cleanupGuard, delegate { return restoredOrder; },
                                           delegate {
                                               cleanupRaises++;
                                               restoredOrder = true;
                                               return true;
                                           },
                                           delegate { return cleanupTime; }, delegate(int ms) { cleanupTime += ms; });
            Need(cleanupRaises == (boundary == "own-marker" ? 1 : 0) &&
                     Object.Equals(Get(cleanup, "confirmed"), boundary == "own-marker"),
                 "TEST_RAISE_CLEANUP_OWN_INPUT_ALLOWED_REAL_ACTIVITY_OR_THIRD_WINDOW_REFUSED");
            checks++;
        }
        foreach (string completion in new[] { "timeout", "changed-after-request", "denied-but-observed" })
        {
            int cleanupRaises = 0;
            long cleanupTime = 0;
            bool restoredOrder = false, changed = false;
            var cleanup = FocusRestoreUnclickedRaise(
                true, false, true, delegate { Need(!changed, "DRAFT_HUMAN_ACTIVITY_CHANGED"); },
                delegate { return restoredOrder; },
                delegate {
                    cleanupRaises++;
                    changed = completion == "changed-after-request";
                    restoredOrder = completion == "denied-but-observed";
                    return completion != "denied-but-observed";
                },
                delegate { return cleanupTime; }, delegate(int ms) { cleanupTime += ms; });
            Need(cleanupRaises == 1 && Object.Equals(Get(cleanup, "attempted"), true) &&
                     Object.Equals(Get(cleanup, "confirmed"), completion == "denied-but-observed") &&
                     cleanupTime <= 150,
                 "TEST_RAISE_CLEANUP_ONE_BOUNDED_OBSERVED_RESTORE_WITHOUT_FOCUS_RETRY");
            checks++;
        }
        {
            int cleanupRaises = 0;
            long cleanupTime = 0;
            var cleanup = FocusRestoreUnclickedRaise(
                true, false, true, delegate { cleanupTime += 151; }, delegate { return false; },
                delegate {
                    cleanupRaises++;
                    return true;
                },
                delegate { return cleanupTime; }, delegate(int ms) { cleanupTime += ms; });
            Need(cleanupRaises == 0 && !Object.Equals(Get(cleanup, "confirmed"), true) &&
                     Text(cleanup, "reason") == "restore-timeout",
                 "TEST_RAISE_CLEANUP_SLOW_GUARD_CANNOT_ISSUE_LATE_REQUEST");
            checks++;
        }
        {
            // WeChat was raised over two unrelated windows. Only move it
            // back; both the foreground and the intervening window stay put.
            var order = new List<IntPtr> { target, source, third };
            long elapsed = 0;
            int moves = 0;
            var cleanup = FocusRestoreCaptionOrder(
                target, source, third, true, false, true, delegate {},
                delegate(IntPtr a, IntPtr b) { return order.IndexOf(a) < order.IndexOf(b); },
                delegate(IntPtr window, IntPtr after) {
                    Need(window == target && after == third, "TEST_CAPTION_MOVED_WRONG_WINDOW");
                    moves++;
                    order.Remove(window);
                    order.Insert(order.IndexOf(after) + 1, window);
                    return true;
                },
                delegate { return elapsed; }, delegate(int ms) { elapsed += ms; });
            Need(moves == 1 && Object.Equals(Get(cleanup, "confirmed"), true) && order[0] == source &&
                     order[1] == third && order[2] == target,
                 "TEST_CAPTION_PRESERVE_INTERVENING_WINDOW");
            checks++;
        }
        {
            int pointerObservations = 0;
            Need(!FocusRestoreClickPointer(false, delegate { pointerObservations++; },
                                           delegate {
                                               pointerObservations++;
                                               return true;
                                           },
                                           delegate {
                                               pointerObservations++;
                                               return true;
                                           },
                                           delegate {
                                               pointerObservations++;
                                               return true;
                                           },
                                           delegate { return 0; }, delegate(int ms) { pointerObservations++; }) &&
                     pointerObservations == 0,
                 "TEST_CAPTION_POINTER_INCOMPLETE_CLICK_NEVER_RESTORES");
            checks++;
        }
        foreach (bool held in new[] { false, true })
        {
            long pointerTime = 0, restoreAt = -1;
            int restores = 0;
            bool restored =
                FocusRestoreClickPointer(true,
                                         delegate {
                                             if (held && pointerTime < 10)
                                                 throw new Fault("DRAFT_KEYS_HELD");
                                         },
                                         delegate { return pointerTime >= 10; },
                                         delegate {
                                             restores++;
                                             restoreAt = pointerTime;
                                             return true;
                                         },
                                         delegate { return restoreAt >= 0 && pointerTime >= restoreAt + 5; },
                                         delegate { return pointerTime; }, delegate(int ms) { pointerTime += ms; });
            Need(restored && restores == 1 && pointerTime == 15,
                 "TEST_CAPTION_POINTER_WAITS_FOR_OWN_CLICK_AND_OBSERVES_RETURN");
            checks++;
        }
        foreach (string boundary in new[] { "activity", "foreground", "binding", "final-guard", "position-changed" })
        {
            long pointerTime = 0;
            int restores = 0, guards = 0, positions = 0;
            bool restored = FocusRestoreClickPointer(
                true,
                delegate {
                    guards++;
                    if (boundary == "activity" && pointerTime >= 5 || boundary == "foreground" ||
                        boundary == "binding" || boundary == "final-guard" && guards == 2)
                        throw new Fault(boundary == "activity" ? "DRAFT_HUMAN_ACTIVITY_CHANGED"
                                                               : "DRAFT_FOCUS_SOURCE_CHANGED");
                },
                delegate {
                    positions++;
                    return boundary == "activity" ? pointerTime >= 10
                                                  : boundary != "position-changed" || positions == 1;
                },
                delegate {
                    restores++;
                    return true;
                },
                delegate { return true; }, delegate { return pointerTime; }, delegate(int ms) { pointerTime += ms; });
            Need(!restored && restores == 0 && pointerTime <= 5,
                 "TEST_CAPTION_POINTER_CHANGED_ACTIVITY_BINDING_OR_FINAL_POSITION_NEVER_OVERWRITTEN");
            checks++;
        }
        foreach (string completion in new[] { "position-timeout", "held-timeout", "return-timeout", "request-rejected",
                                              "slow-guard" })
        {
            long pointerTime = 0;
            int restores = 0;
            bool restored = FocusRestoreClickPointer(true,
                                                     delegate {
                                                         if (completion == "held-timeout")
                                                             throw new Fault("DRAFT_KEYS_HELD");
                                                         if (completion == "slow-guard")
                                                             pointerTime = 41;
                                                     },
                                                     delegate { return completion != "position-timeout"; },
                                                     delegate {
                                                         restores++;
                                                         return completion != "request-rejected";
                                                     },
                                                     delegate { return false; }, delegate { return pointerTime; },
                                                     delegate(int ms) {
                                                         Need(ms > 0 && ms <= 5, "TEST_CAPTION_POINTER_WAIT_BOUNDED");
                                                         pointerTime += ms;
                                                     });
            Need(!restored &&
                     restores == (completion == "return-timeout" || completion == "request-rejected" ? 1 : 0) &&
                     pointerTime <= 41,
                 "TEST_CAPTION_POINTER_ONE_REQUEST_WITH_SHORT_BOUNDED_OBSERVATION");
            checks++;
        }
        foreach (Rect invalid in new[] { new Rect(0, 8, 100, 22), new Rect(550, 0, 650, 49), new Rect(550, 8, 560, 22),
                                         new Rect(550, 8, 650, 12), new Rect(850, 8, 1000, 22) })
        {
            Expect(delegate {
                ParseFocusActivation(Data("rect", invalid.Report(), "rgbaSha256", new string('a', 64)), 1100);
            }, "DRAFT_FOCUS_CALIBRATION_INVALID");
            checks++;
        }
        return checks;
    }
    static IntPtr OnKeyboard(int code, IntPtr message, IntPtr data)
    {
        if (code >= 0)
        {
            var item = (KeyboardHookData)Marshal.PtrToStructure(data, typeof(KeyboardHookData));
            ActivityObserved.Observe(true, unchecked((uint)message.ToInt64()), item.Flags, 0x10, item.Extra);
            if (!Own(item.Flags, 0x10, item.Extra))
                Human();
        }
        return CallNextHookEx(KeyboardHook, code, message, data);
    }
    static IntPtr OnMouse(int code, IntPtr message, IntPtr data)
    {
        if (code >= 0)
        {
            var item = (MouseHookData)Marshal.PtrToStructure(data, typeof(MouseHookData));
            ActivityObserved.Observe(false, unchecked((uint)message.ToInt64()), item.Flags, 1, item.Extra, item.Point.X,
                                     item.Point.Y);
            if (!Own(item.Flags, 1, item.Extra))
                Human();
            var observer = MouseObservationObserver;
            if (observer != null)
                try
                {
                    observer(unchecked((uint)message.ToInt64()), item.Point);
                }
                catch
                {
                    MouseObservationObserver = null;
                }
        }
        return CallNextHookEx(MouseHook, code, message, data);
    }
    delegate IntPtr HookProc(int code, IntPtr message, IntPtr data);
    [StructLayout(LayoutKind.Sequential)]
    struct KeyboardHookData
    {
        internal uint Key, Scan, Flags, Time;
        internal UIntPtr Extra;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct MouseHookData
    {
        internal Point Point;
        internal uint Data, Flags, Time;
        internal UIntPtr Extra;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct KeyInput
    {
        internal ushort Key, Scan;
        internal uint Flags, Time;
        internal UIntPtr Extra;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct MouseInput
    {
        internal int X, Y;
        internal uint Data, Flags, Time;
        internal UIntPtr Extra;
    }
    [StructLayout(LayoutKind.Explicit)]
    struct InputUnion
    {
        [FieldOffset(0)]
        internal KeyInput Keyboard;
        [FieldOffset(0)]
        internal MouseInput Mouse;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct Input
    {
        internal uint Type;
        internal InputUnion Value;
    }
    [DllImport("user32.dll")]
    static extern short GetAsyncKeyState(int key);
    [DllImport("user32.dll")]
    static extern IntPtr WindowFromPoint(Point point);
    [DllImport("user32.dll")]
    static extern int GetSystemMetrics(int index);
    [DllImport("user32.dll", SetLastError = true)]
    static extern uint SendInput(uint count, Input[] inputs, int size);
    [DllImport("user32.dll")]
    static extern bool OpenClipboard(IntPtr owner);
    [DllImport("user32.dll")]
    static extern bool CloseClipboard();
    [DllImport("user32.dll")]
    static extern bool EmptyClipboard();
    [DllImport("user32.dll")]
    static extern uint GetClipboardSequenceNumber();
    [DllImport("user32.dll")]
    static extern IntPtr GetClipboardOwner();
    [DllImport("user32.dll", SetLastError = true)]
    static extern int CountClipboardFormats();
    [DllImport("user32.dll", SetLastError = true)]
    static extern uint EnumClipboardFormats(uint previous);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int GetClipboardFormatName(uint format, StringBuilder name, int maximum);
    [DllImport("user32.dll")]
    static extern IntPtr GetClipboardData(uint format);
    [DllImport("user32.dll")]
    static extern IntPtr SetClipboardData(uint format, IntPtr handle);
    [DllImport("kernel32.dll")]
    static extern UIntPtr GlobalSize(IntPtr memory);
    [DllImport("kernel32.dll")]
    static extern IntPtr GlobalLock(IntPtr memory);
    [DllImport("kernel32.dll")]
    static extern bool GlobalUnlock(IntPtr memory);
    [DllImport("kernel32.dll")]
    static extern IntPtr GlobalAlloc(uint flags, UIntPtr bytes);
    [DllImport("kernel32.dll")]
    static extern IntPtr GlobalFree(IntPtr memory);
    [DllImport("user32.dll")]
    static extern bool SetProcessDpiAwarenessContext(IntPtr value);
    [DllImport("user32.dll")]
    static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")]
    static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")]
    static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")]
    static extern IntPtr GetAncestor(IntPtr window, uint flags);
    [DllImport("user32.dll")]
    static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")]
    static extern IntPtr GetLastActivePopup(IntPtr window);
    [DllImport("user32.dll")]
    static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll", EntryPoint = "SetForegroundWindow", SetLastError = true)]
    static extern bool FocusSetForegroundWindow(IntPtr window);
    [DllImport("user32.dll", EntryPoint = "SystemParametersInfoW")]
    static extern bool FocusGetSystemParameter(uint action, uint parameter, out uint value, uint flags);
    [DllImport("user32.dll", EntryPoint = "SetWindowPos", SetLastError = true)]
    static extern bool FocusSetWindowPos(IntPtr window, IntPtr after, int x, int y, int width, int height, uint flags);
    [DllImport("user32.dll", EntryPoint = "GetWindow")]
    static extern IntPtr FocusZOrderWindow(IntPtr window, uint command);
    [DllImport("user32.dll", EntryPoint = "GetCursorPos")]
    static extern bool FocusGetCursorPos(out Point point);
    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtrW")]
    static extern IntPtr FocusGetWindowLongPtr(IntPtr window, int index);
    [DllImport("kernel32.dll", EntryPoint = "SetLastError")]
    static extern void FocusClearLastError(uint error);
    [DllImport("user32.dll")]
    static extern bool GetGUIThreadInfo(uint thread, ref GuiInfo info);
    [DllImport("user32.dll")]
    static extern bool GetClientRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")]
    static extern bool ClientToScreen(IntPtr window, ref Point point);
    [DllImport("user32.dll")]
    static extern uint GetDpiForWindow(IntPtr window);
    [DllImport("user32.dll")]
    static extern bool GetLastInputInfo(ref LastInput input);
    [DllImport("user32.dll")]
    static extern IntPtr GetProcessWindowStation();
    [DllImport("user32.dll")]
    static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
    [DllImport("user32.dll")]
    static extern bool CloseDesktop(IntPtr desktop);
    [DllImport("user32.dll")]
    static extern IntPtr GetThreadDesktop(uint thread);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern bool GetUserObjectInformation(IntPtr obj, int index, StringBuilder data, uint length,
                                                out uint required);
    [DllImport("user32.dll", SetLastError = true)]
    static extern IntPtr SetWindowsHookEx(int id, HookProc callback, IntPtr module, uint thread);
    [DllImport("user32.dll")]
    static extern bool UnhookWindowsHookEx(IntPtr hook);
    [DllImport("user32.dll")]
    static extern IntPtr CallNextHookEx(IntPtr hook, int code, IntPtr message, IntPtr data);
    [DllImport("kernel32.dll")]
    static extern ulong GetTickCount64();
    [DllImport("kernel32.dll")]
    static extern uint GetCurrentThreadId();
    [DllImport("kernel32.dll")]
    static extern uint GetCurrentProcessId();
    [DllImport("kernel32.dll")]
    static extern bool ProcessIdToSessionId(uint pid, out uint session);
    [DllImport("kernel32.dll")]
    static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")]
    static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder path, ref int size);
    [DllImport("kernel32.dll")]
    static extern bool GetProcessTimes(IntPtr process, out FileTime created, out FileTime exit, out FileTime kernel,
                                       out FileTime user);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)]
    static extern IntPtr GetModuleHandle(string name);
    [DllImport("dwmapi.dll")]
    static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out int value, int size);
}
