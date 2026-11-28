using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Automation;

internal static partial class WechatDraftProbe
{
    [DllImport("user32.dll", EntryPoint = "ChildWindowFromPointEx")]
    static extern IntPtr QtUiaChildAtPoint(IntPtr parent, Point point, uint flags);
    [DllImport("user32.dll", EntryPoint = "IsWindowEnabled")]
    static extern bool QtUiaWindowEnabled(IntPtr window);
    static bool QtUiaPointerRoleEligible(QtUiaRole role, string scope, Rect client)
    {
        return role != null && role.Node != null && Contains(client, role.Node.Rect) && role.Node.Rect.Width >= 2 &&
               role.Node.Rect.Height >= 2 &&
               (scope == "editor-focus" && role.Role == "editor" && role.Node.Type == ControlType.Edit &&
                    role.Node.Class == "mmui::ChatInputField" && role.Node.Id == "chat_input_field" ||
                scope == "image-submit" && role.Role == "send" && role.Node.Type == ControlType.Button &&
                    (role.Node.Class == "mmui::XButton" || role.Node.Class == "mmui::XOutlineButton"));
    }
    static bool QtUiaPointerBindingMatches(Binding expected, Binding actual)
    {
        return expected != null && actual != null && expected.Window == actual.Window && expected.Pid == actual.Pid &&
               expected.Created == actual.Created && expected.Thread == actual.Thread && expected.Dpi == actual.Dpi &&
               Same(expected.Client, actual.Client) && Same(expected.Capture, actual.Capture) && actual.FocusOwned;
    }
    static bool QtUiaPointerRecipientSame(Binding binding)
    {
        uint pid;
        Need(binding != null, "UIA_POINTER_TARGET_INVALID");
        if (!IsWindow(binding.Window) || GetWindowThreadProcessId(binding.Window, out pid) != binding.Thread ||
            pid != binding.Pid)
            return false;
        IntPtr process = OpenProcess(0x1000, false, pid);
        if (process == IntPtr.Zero)
            return false;
        try
        {
            FileTime created, exit, kernel, user;
            return GetProcessTimes(process, out created, out exit, out kernel, out user) &&
                   created.Value == binding.Created;
        }
        finally
        {
            CloseHandle(process);
        }
    }
    static void QtUiaPointerRoleCurrent(QtFrame frame, QtUiaRole role)
    {
        QtCheckUiaFrame(
            new QtFrame { Binding = frame.Binding, MetadataOnly = true, MetadataLease = QtFocus.Active,
                          UiaRoles = new List<QtUiaRole> { role },
                          Anchors = new List<QtAnchor> { new QtAnchor { Rect = role.Node.Rect, Hash = role.Hash } } });
        Need(role.Node.Element.Current.IsEnabled, "QT_UIA_CONTROL_DISABLED");
    }
    static void QtUiaPointerAfterInput(QtFrame frame)
    {
        QtCheckUiaControlLease(frame);
        Need(!Stopping && frame.Revision == Interlocked.Read(ref Revision), "QT_HUMAN_ACTIVITY_CHANGED");
        // Focusing an actual child HWND is allowed; the native root, process,
        // thread, geometry, session, foreground and owned focus stay bound.
        Need(QtUiaPointerBindingMatches(frame.Binding, QtBound(false)), "QT_BINDING_CHANGED");
        NoKeysHeld();
    }
    static void QtUiaPointerAwaitFocus(Func<bool> focused, Action guard, Func<long> now, Action<int> wait)
    {
        long start = now();
        for (;;)
        {
            guard();
            if (focused())
            {
                guard();
                return;
            }
            Need(now() >= start && now() - start < 650, "QT_UIA_EDITOR_FOCUS_UNCONFIRMED");
            wait(5);
        }
    }
    static object QtUiaPointerDelivery(string scope, int posted, bool cursorUnchanged, string completion)
    {
        Need(posted == 3 && cursorUnchanged &&
                 (scope == "editor-focus" && completion == "uia-focus" ||
                  scope == "image-submit" && completion == "receipt-pending"),
             "QT_UIA_POINTER_REPORT_INVALID");
        return Data("version", 1, "method", "window-message-v1", "scope", scope, "messagesPosted", posted,
                    "queueAccepted", true, "systemCursorMovementRequested", false, "cursorUnchanged", true,
                    "completion", completion);
    }
    static object QtUiaPointerClick(QtFrame frame, QtUiaRole role, string scope, Action consume)
    {
        Need(frame != null && frame.MetadataOnly && QtSurface == "main" && QtPopup == null && QtPendingPopup == null &&
                 QtUiaPointerRoleEligible(role, scope, frame.Binding.Client),
             "QT_UIA_POINTER_TARGET_INVALID");
        QtInputStable(frame, false);
        QtUiaPointerRoleCurrent(frame, role);
        if (scope == "editor-focus" && role.Node.Element.Current.HasKeyboardFocus)
        {
            consume();
            QtUiaPointerAfterInput(frame);
            Need(role.Node.Element.Current.HasKeyboardFocus, "QT_UIA_EDITOR_FOCUS_UNCONFIRMED");
            return null;
        }
        Point point = new Point(role.Node.Rect.Left + role.Node.Rect.Width / 2,
                                role.Node.Rect.Top + role.Node.Rect.Height / 2),
              cursor;
        Need(FocusGetCursorPos(out cursor), "QT_POINTER_UNAVAILABLE");
        Action beforeDown = delegate
        {
            QtInputStable(frame, false);
            Need(QtUiaWindowEnabled(frame.Binding.Window) &&
                     QtUiaChildAtPoint(frame.Binding.Window, point, 7) == frame.Binding.Window,
                 "QT_UIA_POINTER_NATIVE_CHILD_UNSUPPORTED");
            Point at;
            Need(FocusGetCursorPos(out at) && QtSamePoint(at, cursor), "QT_HUMAN_ACTIVITY_CHANGED");
        };
        beforeDown();
        consume();
        int posted = WindowMessageClick(frame.Binding.Window, point, beforeDown,
                                        delegate { return QtUiaPointerRecipientSame(frame.Binding); },
                                        delegate { InputAttempted = true; });
        if (scope == "editor-focus")
        {
            QtUiaPointerAwaitFocus(delegate { return role.Node.Element.Current.HasKeyboardFocus; },
                                   delegate { QtUiaPointerAfterInput(frame); }, Now, Thread.Sleep);
            QtUiaPointerRoleCurrent(frame, role);
        }
        QtUiaPointerAfterInput(frame);
        Point after;
        Need(FocusGetCursorPos(out after) && QtSamePoint(after, cursor), "QT_UIA_POINTER_POSITION_CHANGED");
        // For a submit this is an observation around queueing only; successful
        // message delivery remains the separate exact database receipt.
        return QtUiaPointerDelivery(scope, posted, true, scope == "editor-focus" ? "uia-focus" : "receipt-pending");
    }
    static int QtUiaPointerSelfTest()
    {
        int n = WindowMessageInputSelfTest();
        var client = new Rect(0, 0, 800, 600);
        var editor = new QtUiaRole { Role = "editor",
                                     Node = new QtUiaNode { Class = "mmui::ChatInputField", Id = "chat_input_field",
                                                            Type = ControlType.Edit, Enabled = true,
                                                            Rect = new Rect(200, 400, 780, 560) } };
        Need(QtUiaPointerRoleEligible(editor, "editor-focus", client) &&
                 !QtUiaPointerRoleEligible(editor, "image-submit", client),
             "QT_TEST_UIA_POINTER_EDITOR_SCOPE");
        n++;
        foreach (int change in new[] { 0, 1, 2, 3 })
        {
            string cls = editor.Node.Class, id = editor.Node.Id;
            ControlType type = editor.Node.Type;
            Rect rect = editor.Node.Rect;
            if (change == 0)
                editor.Node.Class = "other";
            if (change == 1)
                editor.Node.Id = "other";
            if (change == 2)
                editor.Node.Type = ControlType.Button;
            if (change == 3)
                editor.Node.Rect = new Rect(200, 400, 801, 560);
            Need(!QtUiaPointerRoleEligible(editor, "editor-focus", client),
                 "QT_TEST_UIA_POINTER_UNKNOWN_EDITOR_REFUSED");
            editor.Node.Class = cls;
            editor.Node.Id = id;
            editor.Node.Type = type;
            editor.Node.Rect = rect;
            n++;
        }
        var send = new QtUiaRole { Role = "send",
                                   Node = new QtUiaNode { Class = "mmui::XOutlineButton", Type = ControlType.Button,
                                                          Enabled = true, Rect = new Rect(700, 560, 780, 590) } };
        Need(QtUiaPointerRoleEligible(send, "image-submit", client) &&
                 !QtUiaPointerRoleEligible(send, "editor-focus", client),
             "QT_TEST_UIA_POINTER_SEND_SCOPE");
        n++;
        long clock = 0;
        int waits = 0;
        QtUiaPointerAwaitFocus(delegate { return true; }, delegate {}, delegate { return clock; },
                               delegate(int ms) {
                                   waits++;
                                   clock += ms;
                               });
        Need(waits == 0, "QT_TEST_UIA_POINTER_IMMEDIATE_FOCUS_ZERO_WAIT");
        n++;
        clock = 0;
        Expect(delegate {
            QtUiaPointerAwaitFocus(delegate { return false; }, delegate {}, delegate { return clock; },
                                   delegate(int ms) { clock += ms; });
        }, "QT_UIA_EDITOR_FOCUS_UNCONFIRMED");
        n++;
        clock = 0;
        Expect(delegate {
            QtUiaPointerAwaitFocus(delegate { return true; },
                                   delegate { throw new Fault("QT_HUMAN_ACTIVITY_CHANGED"); },
                                   delegate { return clock; }, delegate(int ms) { clock += ms; });
        }, "QT_HUMAN_ACTIVITY_CHANGED");
        n++;
        var report = Map(QtUiaPointerDelivery("image-submit", 3, true, "receipt-pending"));
        Need(report.Count == 8 && Text(report, "completion") == "receipt-pending" && !report.ContainsKey("submitted"),
             "QT_TEST_UIA_POINTER_QUEUE_NOT_SUBMIT_PROOF");
        n++;
        Expect(delegate { QtUiaPointerDelivery("image-submit", 2, true, "receipt-pending"); },
               "QT_UIA_POINTER_REPORT_INVALID");
        Expect(delegate { QtUiaPointerDelivery("editor-focus", 3, true, "receipt-pending"); },
               "QT_UIA_POINTER_REPORT_INVALID");
        n += 2;
        return n;
    }
}
