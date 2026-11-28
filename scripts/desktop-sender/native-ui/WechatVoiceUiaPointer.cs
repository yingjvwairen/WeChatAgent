using System;
using System.Collections;
using System.Threading;

internal static partial class WechatDraftProbe
{
    static int VoiceUiaPointerMessages;
    static Exception VoiceUiaPointerFailure(Exception error)
    {
        if (!(error is Fault) || !error.Message.StartsWith("UIA_POINTER_", StringComparison.Ordinal))
            return error;
        var mapped = new Fault("VOICE_" + error.Message);
        foreach (DictionaryEntry item in error.Data)
            mapped.Data[item.Key] = item.Value;
        return mapped;
    }
    static int VoiceUiaDispatchPointer(Func<Action, int> dispatch, Action guard, Action mark)
    {
        try
        {
            int posted = dispatch(delegate {
                guard();
                mark();
            });
            VoiceUiaPointerMessages += posted;
            return posted;
        }
        catch (Exception error)
        {
            var partial = Map(error.Data["WindowMessageInput"]);
            object count = Get(partial, "messagesPosted");
            if (count is int && (int)count >= 0 && (int)count <= 3)
                VoiceUiaPointerMessages += (int)count;
            Exception mapped = VoiceUiaPointerFailure(error);
            if (Object.ReferenceEquals(mapped, error))
                throw;
            throw mapped;
        }
    }
    static bool VoiceUiaPointerRecipient(VoiceRequest request, uint thread)
    {
        try
        {
            uint pid = 0;
            Need(IsWindow(request.Binding.Window) &&
                     GetWindowThreadProcessId(request.Binding.Window, out pid) == thread && pid == request.Binding.Pid,
                 "VOICE_UIA_POINTER_TARGET_CHANGED");
            IntPtr process = OpenProcess(0x1000, false, pid);
            if (process == IntPtr.Zero)
                return false;
            try
            {
                FileTime start, exit, kernel, user;
                return GetProcessTimes(process, out start, out exit, out kernel, out user) &&
                       start.Value == request.Binding.Created;
            }
            finally
            {
                CloseHandle(process);
            }
        }
        catch
        {
            return false;
        }
    }
    static void VoiceMarkBackgroundSubmission(VoiceHandoffState state, VoiceBackgroundSubmission submission, long at)
    {
        InputAttempted = true;
        if (!submission.Attempted)
        {
            submission.Attempted = true;
            Recording.BeginSubmit(at);
            Interlocked.Exchange(ref state.Phase, 7);
        }
    }
    static bool VoiceAutoReturnEligible(bool applied, bool foregroundOwned, bool identityUnchanged,
                                        bool activityUnchanged, bool keysReleased, bool attempted)
    {
        return applied && foregroundOwned && identityUnchanged && activityUnchanged && keysReleased && !attempted;
    }
    static void VoiceWaitSubmittedPointerRelease(Action guard, Func<bool> released, Func<long> clock, Action<int> wait)
    {
        long end = clock() + 150;
        for (;;)
        {
            guard();
            if (released())
            {
                guard();
                return;
            }
            Need(clock() < end, "VOICE_POST_SUBMIT_MOUSE_CAPTURE_HELD");
            wait(2);
        }
    }
    static bool VoiceCompleteBackgroundSubmission(Func<bool> observeEnd, Action markEnded, Action releasePointer,
                                                  Action restoreFocus)
    {
        if (!observeEnd())
            return false;
        // Preserve the actual recorder outcome even if focus restoration fails.
        markEnded();
        releasePointer();
        restoreFocus();
        return true;
    }
    static IntPtr VoiceObserveSubmittedForeground(VoiceRequest request)
    {
        var state = VoiceHandoff;
        var submission = state == null ? null : state.BackgroundSubmit;
        Need(submission != null && submission.Applied && Recording.SubmitApplied,
             "VOICE_BACKGROUND_SUBMIT_UNAVAILABLE");
        VoiceActive();
        VoiceBoundWindowGuard(request);
        IntPtr foreground = GetForegroundWindow();
        if (foreground != submission.ForegroundBefore)
            submission.ForegroundUnchanged = false;
        if (!VoiceWindowProcess(foreground, request.Binding.Pid))
            return foreground;
        Need(foreground == request.Binding.Window, "VOICE_BACKGROUND_WINDOW_CHANGED");
        if (!submission.AutoActivated)
        {
            submission.AutoActivated = true;
            state.SubmitStarted = Now();
            if (state.BackgroundEnded == 0)
                state.BackgroundEnded = state.SubmitStarted;
        }
        submission.AutoReturnActivityUnchanged = Interlocked.Read(ref Revision) == submission.Revision;
        bool sameReturn = VoiceSameReturn(submission.ReturnBefore, VoiceReadReturnWindow(submission.ForegroundBefore));
        if (!VoiceAutoReturnEligible(submission.Applied, true, sameReturn, submission.AutoReturnActivityUnchanged,
                                     VoiceKeysReleased(), submission.AutoReturnAttempted))
        {
            if (!submission.AutoReturnActivityUnchanged || !VoiceKeysReleased())
                state.ReturnSkippedForHumanInput = true;
            throw new Fault("VOICE_POST_SUBMIT_FOCUS_UNCONFIRMED");
        }
        VoiceValidateReturn(submission.ReturnBefore, request.Binding);
        // Queued UP and the recorder teardown can each activate the window.
        // Observe both without returning focus until the bound recorder ends.
        return foreground;
    }
    static void VoiceReturnSubmittedForeground(VoiceRequest request)
    {
        IntPtr foreground = VoiceObserveSubmittedForeground(request);
        var state = VoiceHandoff;
        var submission = state.BackgroundSubmit;
        Need(submission.Confirmed && Recording.Ended && !Recording.PossiblyActive, "VOICE_RECORDING_END_UNCONFIRMED");
        if (foreground != request.Binding.Window)
            return;
        VoiceFocusTransitionGuard(request, submission.ReturnBefore, submission.Revision, true);
        VoiceSourceThreadGuard(request);
        Need(VoiceAutoReturnEligible(
                 submission.Applied, true,
                 VoiceSameReturn(submission.ReturnBefore, VoiceReadReturnWindow(submission.ForegroundBefore)),
                 Interlocked.Read(ref Revision) == submission.Revision, VoiceKeysReleased(),
                 submission.AutoReturnAttempted),
             "VOICE_POST_SUBMIT_FOCUS_UNCONFIRMED");
        submission.AutoReturnAttempted = true;
        state.FinalReturnAttempted = true;
        Interlocked.Exchange(ref state.Phase, 5);
        try
        {
            var confirmation = ConfirmFocusOnce(
                request.Binding.Window, submission.ReturnBefore.Window,
                delegate {
                    return VoiceActivateReturnOnce(request, submission.ReturnBefore, null, null, submission.Revision,
                                                   true);
                },
                delegate {
                    VoiceFocusTransitionGuard(request, submission.ReturnBefore, submission.Revision, true);
                    VoiceSourceThreadGuard(request);
                },
                GetForegroundWindow, Now, Thread.Sleep);
            submission.AutoReturnConfirmed = confirmation.Confirmed;
            state.FinalReturnConfirmed = confirmation.Confirmed;
            if (confirmation.Confirmed)
                state.SubmitEnded = Now();
            NeedFocusConfirmed(confirmation, "VOICE_POST_SUBMIT_FOCUS_UNCONFIRMED");
        }
        finally
        {
            Interlocked.Exchange(ref state.Phase, 7);
        }
    }
    static void VoiceUiaPointerClick(VoiceRequest request, long revision, Rect rect, int phase, Action mark,
                                     bool allowStopped)
    {
        Need(request.Uia != null && Contains(request.Binding.Client, rect), "VOICE_UIA_CLICK_ROLE_CHANGED");
        VoiceUiaConversationAndClickGuard(request, rect, phase);
        Point saved;
        Need(FocusGetCursorPos(out saved), "VOICE_POINTER_UNAVAILABLE");
        uint pid, thread = GetWindowThreadProcessId(request.Binding.Window, out pid);
        Need(thread != 0 && pid == request.Binding.Pid, "VOICE_UIA_POINTER_TARGET_CHANGED");
        Action guard = delegate
        {
            VoiceGuard(request, revision, phase, allowStopped);
            NoKeysHeld();
            Point current;
            Need(GetForegroundWindow() == request.Binding.Window && FocusGetCursorPos(out current) &&
                     current.X == saved.X && current.Y == saved.Y,
                 "DRAFT_HUMAN_ACTIVITY_CHANGED");
        };
        guard();
        VoiceUiaDispatchPointer(delegate(Action beforeDown) {
            return WindowMessageClick(
                request.Binding.Window, new Point(rect.Left + rect.Width / 2, rect.Top + rect.Height / 2), beforeDown,
                delegate { return VoiceUiaPointerRecipient(request, thread); }, delegate { InputAttempted = true; });
        }, guard, mark);
        // The existing recorder-ready/audio-start and recorder-ended checks
        // acknowledge the state transition. Queue acceptance never does.
        Point after;
        Need(Interlocked.Read(ref Revision) == revision && FocusGetCursorPos(out after) && after.X == saved.X &&
                 after.Y == saved.Y,
             "DRAFT_HUMAN_ACTIVITY_CHANGED");
    }
    static void VoiceUiaSubmitInBackground(VoiceRequest request, AudioRouteProbe.NativeVoiceAudio audio)
    {
        var state = VoiceHandoff;
        string capture = VoiceCaptureInstance, recorder = request.Uia == null ? null : request.Uia.Recorder;
        Need(state != null && VoiceMaySubmitInBackground(
                                  request.Uia != null, state.InitialReturnConfirmed, state.BackgroundEntered,
                                  Interlocked.CompareExchange(ref state.Phase, 0, 0),
                                  VoiceCaptureVerified && capture != null, recorder != null, Recording.SubmitAttempted),
             "VOICE_BACKGROUND_SUBMIT_UNAVAILABLE");
        var submission =
            new VoiceBackgroundSubmission { ForegroundBefore = GetForegroundWindow(), ForegroundUnchanged = true,
                                            Revision = Interlocked.Read(ref Revision) };
        submission.ReturnBefore = VoiceReadReturnWindow(submission.ForegroundBefore);
        VoiceValidateReturn(submission.ReturnBefore, request.Binding);
        state.BackgroundSubmit = submission;
        Rect rect = request.Submit.Rect;
        Need(Contains(request.Binding.Client, rect), "VOICE_UIA_CLICK_ROLE_CHANGED");
        uint pid, thread = GetWindowThreadProcessId(request.Binding.Window, out pid);
        Need(thread != 0 && pid == request.Binding.Pid, "VOICE_UIA_POINTER_TARGET_CHANGED");
        Action guard = delegate
        {
            if (GetForegroundWindow() != submission.ForegroundBefore)
                submission.ForegroundUnchanged = false;
            int phase = Interlocked.CompareExchange(ref state.Phase, 0, 0);
            Need(Object.ReferenceEquals(state, VoiceHandoff) &&
                     Object.ReferenceEquals(submission, state.BackgroundSubmit) && (phase == 1 || phase == 7) &&
                     VoiceCaptureInstance == capture && request.Uia.Recorder == recorder,
                 "VOICE_BACKGROUND_SUBMIT_UNAVAILABLE");
            VoiceBackgroundGuard(request, audio);
        };
        // UIA reads bind the original page, title, recorder runtime and enabled
        // submit role. No foreground/focus claim or physical input is needed.
        guard();
        VoiceUiaConversationAndClickGuard(request, rect, 1);
        guard();
        try
        {
            VoiceUiaDispatchPointer(
                delegate(Action beforeDown) {
                    return WindowMessageClick(
                        request.Binding.Window, new Point(rect.Left + rect.Width / 2, rect.Top + rect.Height / 2),
                        beforeDown, delegate { return VoiceUiaPointerRecipient(request, thread); },
                        delegate { VoiceMarkBackgroundSubmission(state, submission, Now()); });
                },
                delegate {
                    guard();
                    VoiceUiaConversationAndClickGuard(request, rect, 1);
                    guard();
                },
                delegate {});
            submission.Applied = true;
            Recording.ConfirmSubmitInput();
            // Only observe here: Qt may activate again while tearing down the
            // recorder. The bound-session/idle observer owns the single return.
            VoiceObserveSubmittedForeground(request);
        }
        finally
        {
            submission.ForegroundUnchanged = submission.ForegroundUnchanged &&
                                             GetForegroundWindow() == submission.ForegroundBefore &&
                                             !VoiceWindowProcess(GetForegroundWindow(), request.Binding.Pid);
        }
    }
    static int VoiceUiaPointerSelfTest()
    {
        int checks = 0, saved = VoiceUiaPointerMessages;
        bool oldInput = InputAttempted;
        var previousAttempt = Recording;
        Recording = new RecordingAttempt();
        try
        {
            for (int flags = 0; flags < 64; flags++)
                Need(VoiceAutoReturnEligible((flags & 1) != 0, (flags & 2) != 0, (flags & 4) != 0, (flags & 8) != 0,
                                             (flags & 16) != 0, (flags & 32) != 0) == (flags == 31),
                     "VOICE_TEST_AUTO_RETURN_ONLY_OWN_SUBMIT_UNCHANGED_IDENTITY_ACTIVITY_ONE_ATTEMPT");
            checks++;
            {
                long time = 0;
                int captureGuards = 0;
                VoiceWaitSubmittedPointerRelease(delegate { captureGuards++; }, delegate { return time >= 6; },
                                                 delegate { return time; }, delegate(int ms) { time += ms; });
                Need(time == 6 && captureGuards >= 4, "VOICE_TEST_POST_SUBMIT_WAIT_ONLY_UNTIL_OWN_CAPTURE_RELEASED");
                checks++;
            }
            {
                long time = 0;
                Expect(delegate {
                    VoiceWaitSubmittedPointerRelease(delegate {}, delegate { return false; }, delegate { return time; },
                                                     delegate(int ms) { time += ms; });
                }, "VOICE_POST_SUBMIT_MOUSE_CAPTURE_HELD");
                Need(time == 150, "VOICE_TEST_POST_SUBMIT_CAPTURE_WAIT_BOUNDED");
                checks++;
            }
            {
                int reads = 0;
                Expect(delegate {
                    VoiceWaitSubmittedPointerRelease(delegate { throw new Fault("DRAFT_HUMAN_ACTIVITY_CHANGED"); },
                                                     delegate {
                                                         reads++;
                                                         return true;
                                                     },
                                                     delegate { return 0; }, delegate(int ms) {});
                }, "DRAFT_HUMAN_ACTIVITY_CHANGED");
                Need(reads == 0, "VOICE_TEST_POST_SUBMIT_WAIT_DOES_NOT_OVERRIDE_HUMAN_ACTIVITY");
                checks++;
            }
            {
                long time = 0;
                int activations = 0, returns = 0;
                bool ended = false, upReleased = false;
                bool complete = VoiceCompleteBackgroundSubmission(
                    delegate {
                        return VoiceObserveUiaEnd(
                            delegate {
                                if (time == 0 || time == 40)
                                    activations++;
                                Need(returns == 0, "VOICE_TEST_NO_EARLY_AUTO_RETURN");
                            },
                            delegate { return time >= 80; }, delegate { return time >= 120; },
                            delegate { return time; }, delegate(int ms) { time += ms; });
                    },
                    delegate { ended = true; },
                    delegate {
                        Need(ended, "VOICE_TEST_END_BEFORE_UP_RELEASE");
                        upReleased = true;
                    },
                    delegate {
                        Need(ended && upReleased, "VOICE_TEST_AUTO_RETURN_REQUIRES_END_AND_UP");
                        returns++;
                    });
                Need(complete && activations >= 2 && returns == 1,
                     "VOICE_TEST_REPEATED_QT_ACTIVATION_DURING_TEARDOWN_ONE_FINAL_RETURN");
                checks++;
            }
            {
                bool ended = false;
                int returns = 0;
                Expect(delegate {
                    VoiceCompleteBackgroundSubmission(delegate { return true; }, delegate { ended = true; },
                                                      delegate { throw new Fault("DRAFT_HUMAN_ACTIVITY_CHANGED"); },
                                                      delegate { returns++; });
                }, "DRAFT_HUMAN_ACTIVITY_CHANGED");
                Need(ended && returns == 0, "VOICE_TEST_POST_END_INTERRUPTION_PRESERVES_ENDED_WITHOUT_STEALING_FOCUS");
                checks++;
            }
            {
                bool endMarked = false;
                int returns = 0;
                Need(!VoiceCompleteBackgroundSubmission(delegate { return false; }, delegate { endMarked = true; },
                                                        delegate { throw new Exception("must not inspect"); },
                                                        delegate { returns++; }) &&
                         !endMarked && returns == 0,
                     "VOICE_TEST_UNCONFIRMED_RECORDER_NEVER_RETURNS_FOCUS_AS_COMPLETE");
                checks++;
            }
            var backgroundState = new VoiceHandoffState { Phase = 1 };
            var background = new VoiceBackgroundSubmission();
            int backgroundCalls = 0;
            Expect(delegate {
                WindowMessageClickCore(new Point(1, 2),
                                       delegate(uint message, UIntPtr flags, IntPtr position) {
                                           backgroundCalls++;
                                           return false;
                                       },
                                       delegate {}, delegate { return true; },
                                       delegate { VoiceMarkBackgroundSubmission(backgroundState, background, 123); });
            }, "UIA_POINTER_QUEUE_REJECTED");
            Need(backgroundCalls == 1 && background.Attempted && !background.Applied && !background.Confirmed &&
                     Recording.SubmitAttempted && Recording.SubmittedAt == 123 && backgroundState.Phase == 7,
                 "VOICE_TEST_BACKGROUND_FIRST_QUEUE_FAILURE_RETAINS_UNCERTAIN_ATTEMPT_WITHOUT_RETRY");
            checks++;
            VoiceMarkBackgroundSubmission(backgroundState, background, 456);
            Need(Recording.SubmittedAt == 123, "VOICE_TEST_BACKGROUND_MARK_PRESERVES_FIRST_ATTEMPT");
            checks++;
            VoiceUiaPointerMessages = 0;
            bool marked = false;
            var interrupted = new Fault("DRAFT_HUMAN_ACTIVITY_CHANGED");
            try
            {
                VoiceUiaDispatchPointer(
                    delegate(Action beforeDown) {
                        return WindowMessageClickCore(new Point(1, 2),
                                                      delegate(uint message, UIntPtr flags, IntPtr position) {
                                                          Need(!marked, "VOICE_TEST_POINTER_NOT_MARKED_BEFORE_GUARD");
                                                          return true;
                                                      },
                                                      beforeDown, delegate { return true; }, delegate {});
                    },
                    delegate { throw interrupted; }, delegate { marked = true; });
                throw new Exception("missing failure");
            }
            catch (Fault error)
            {
                Need(Object.ReferenceEquals(error, interrupted) && !marked && VoiceUiaPointerMessages == 1 &&
                         Number(Get(Map(error.Data["WindowMessageInput"]), "messagesPosted")) == 1,
                     "VOICE_TEST_POINTER_PRE_DOWN_INTERRUPTION_COUNTED_NOT_SUBMITTED");
            }
            checks++;
            for (int failure = 0; failure < 3; failure++)
            {
                int calls = 0, stop = failure, before = VoiceUiaPointerMessages;
                marked = false;
                try
                {
                    VoiceUiaDispatchPointer(
                        delegate(Action beforeDown) {
                            return WindowMessageClickCore(new Point(1, 2),
                                                          delegate(uint message, UIntPtr flags, IntPtr position) {
                                                              Need(marked == (message != 0x200),
                                                                   "VOICE_TEST_POINTER_MARK_ONLY_AFTER_GUARD");
                                                              return calls++ != stop;
                                                          },
                                                          beforeDown, delegate { return true; }, delegate {});
                        },
                        delegate {}, delegate { marked = true; });
                    throw new Exception("missing failure");
                }
                catch (Fault error)
                {
                    var partial = Map(error.Data["WindowMessageInput"]);
                    Need(error.Message == "VOICE_UIA_POINTER_QUEUE_REJECTED" &&
                             VoiceSafeReason(error) == error.Message && calls == stop + 1 &&
                             VoiceUiaPointerMessages - before == stop && marked == (stop > 0) &&
                             Number(Get(partial, "messagesPosted")) == stop &&
                             Object.Equals(Get(partial, "unpairedDownQueued"), stop == 2) &&
                             Object.Equals(Get(partial, "retryAllowed"), false),
                         "VOICE_TEST_POINTER_PARTIAL_COUNT_AND_ERROR_DATA_PRESERVED");
                }
                checks++;
            }
            int initial = VoiceUiaPointerMessages, guards = 0, marks = 0;
            int posted = VoiceUiaDispatchPointer(
                delegate(Action beforeDown) {
                    return WindowMessageClickCore(
                        new Point(1, 2), delegate(uint message, UIntPtr flags, IntPtr position) { return true; },
                        beforeDown, delegate { return true; }, delegate {});
                },
                delegate { guards++; },
                delegate {
                    Need(guards == 1, "VOICE_TEST_POINTER_MARK_REQUIRES_GUARD");
                    marks++;
                });
            Need(posted == 3 && VoiceUiaPointerMessages == initial + 3 && guards == 1 && marks == 1,
                 "VOICE_TEST_POINTER_SUCCESS_COUNTED_ONCE");
            checks++;
            var source = new Fault("UIA_POINTER_RELEASE_TARGET_CHANGED");
            object detail = Data("fixture", true);
            source.Data["WindowMessageInput"] = detail;
            source.Data["extra"] = 7;
            var mapped = VoiceUiaPointerFailure(source);
            Need(mapped.Message == "VOICE_UIA_POINTER_RELEASE_TARGET_CHANGED" &&
                     Object.ReferenceEquals(mapped.Data["WindowMessageInput"], detail) &&
                     Object.Equals(mapped.Data["extra"], 7),
                 "VOICE_TEST_POINTER_MAPPING_PRESERVES_ALL_DATA");
            checks++;
            return checks;
        }
        finally
        {
            VoiceUiaPointerMessages = saved;
            InputAttempted = oldInput;
            Recording = previousAttempt;
        }
    }
}
