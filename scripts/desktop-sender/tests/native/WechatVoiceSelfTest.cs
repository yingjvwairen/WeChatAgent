// Synthetic recording and handoff tests; no application access.
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

internal static partial class WechatDraftProbe
{
    static int VoiceSelfTest()
    {
        int checks = 0;
        try
        {
            for (int flags = 0; flags < 32; flags++)
                Need(VoiceMayObserveSubmittedEnd((flags & 1) != 0, (flags & 2) != 0, (flags & 4) != 0, (flags & 8) != 0,
                                                 (flags & 16) != 0) == (flags == 31),
                     "TEST_SUBMITTED_END_REQUIRES_UIA_APPLIED_BOUND_AND_RETURNED");
            checks++;
            var template = Data("rect", new Rect(10, 10, 40, 40).Report(), "rgbaSha256", new string('a', 64));
            Need(ParseTemplate(template, new Rect(0, 0, 100, 100)).Rect.Width == 30, "TEST_TEMPLATE");
            checks++;
            Expect(delegate {
                ParseTemplate(Data("rect", new Rect(0, 0, 129, 20).Report(), "rgbaSha256", new string('a', 64)),
                              new Rect(0, 0, 200, 200));
            }, "VOICE_TEMPLATE_INVALID");
            checks++;
            Need(PixelHash(new byte[] { 255, 0, 0, 255 }) ==
                     "34aaa746c25a0f105c4316bbb1f009aa359f49582656ee97d73c58132d563423",
                 "TEST_PIXEL_HASH");
            checks++;
            byte[] rgbaRow = new byte[8];
            VoiceRgbaRow(new byte[] { 3, 2, 1, 0, 6, 5, 4, 0 }, rgbaRow, 0);
            Need(PixelHash(rgbaRow) == PixelHash(new byte[] { 1, 2, 3, 255, 4, 5, 6, 255 }), "TEST_BGRA_PIXEL_LAYOUT");
            checks++;
            Need(Own(1, 1, Marker) && !Own(1, 1, UIntPtr.Zero), "TEST_MOUSE_MARKER");
            checks++;
            Need(IntPtr.Size == 8 && Marshal.SizeOf(typeof(Input)) == 40 &&
                     Marshal.OffsetOf(typeof(Input), "Value").ToInt32() == 8 &&
                     Marshal.SizeOf(typeof(MouseInput)) == 32 &&
                     Marshal.OffsetOf(typeof(MouseInput), "Extra").ToInt32() == 24 &&
                     Marshal.SizeOf(typeof(MouseHookData)) == 32 &&
                     Marshal.OffsetOf(typeof(MouseHookData), "Extra").ToInt32() == 24 &&
                     Marshal.SizeOf(typeof(KeyboardHookData)) == 24 &&
                     Marshal.OffsetOf(typeof(KeyboardHookData), "Extra").ToInt32() == 16,
                 "TEST_INPUT_X64_LAYOUT");
            checks++;
            Input[] click = ClickEvents(10, 10, new Rect(0, 0, 100, 100));
            Need(click.Length == 3 && click[0].Value.Mouse.Flags == 0xc001 && click[1].Value.Mouse.Flags == 2 &&
                     click[2].Value.Mouse.Flags == 4,
                 "TEST_VOICE_CLICK_EVENTS");
            foreach (Input item in click)
                Need(item.Type == 0 && item.Value.Mouse.Extra.Equals(Marker), "TEST_VOICE_CLICK_MARKER");
            checks++;
            {
                var screen = new Rect(-1000, -200, 3000, 1600);
                foreach (Point p in new[] { new Point(-1000, 0), new Point(50, 600), new Point(2999, 1599) })
                {
                    var input = VoiceStartEvents(p, screen);
                    Need((long)input[0].Value.Mouse.X * screen.Width / 65536 + screen.Left == p.X &&
                             (long)input[0].Value.Mouse.Y * screen.Height / 65536 + screen.Top == p.Y,
                         "TEST_VOICE_START_EXACT_VIRTUAL_PIXEL");
                    foreach (Input item in input)
                        Need(item.Value.Mouse.Extra.Equals(Marker), "TEST_VOICE_START_MARKER");
                }
                checks++;
            }
            Need(VoiceStartKeysReleased(true, delegate(int key) { return key == 1; }) &&
                     !VoiceStartKeysReleased(false, delegate(int key) { return key == 1; }) &&
                     !VoiceStartKeysReleased(true, delegate(int key) { return key == 1 || key == 0x10; }),
                 "TEST_VOICE_OWN_DOWN_ONLY_KEY_EXCEPTION");
            checks++;
            Need(VoiceFailureFrameRequested("1") && !VoiceFailureFrameRequested(null) &&
                     !VoiceFailureFrameRequested("true") && !VoiceFailureFrameRequested("0"),
                 "TEST_VOICE_FAILURE_FRAME_REQUIRES_EXPLICIT_ACCEPTANCE_OPT_IN");
            checks++;
            {
                long time = 0;
                var sent = new List<int>();
                int marked = 0;
                uint count = VoiceStartGesture(
                    delegate(bool held) {}, delegate { marked++; },
                    delegate(int index) {
                        sent.Add(index);
                        return 1;
                    },
                    delegate { return true; }, delegate { return true; }, delegate(bool point, bool press) {},
                    delegate { Need(String.Join(",", sent) == "0,1", "TEST_VOICE_DIAGNOSTIC_BEFORE_UP"); },
                    delegate { return time; }, delegate(int ms) { time += ms; });
                Need(count == 3 && marked == 1 && time == 0 && String.Join(",", sent) == "0,1,2",
                     "TEST_VOICE_START_NO_FIXED_DELAY_OR_SECOND_CLICK");
                checks++;
            }
            {
                long time = 0;
                var sent = new List<int>();
                Expect(delegate {
                    VoiceStartGesture(
                        delegate(bool held) {
                            if (held)
                                throw new Fault("DRAFT_HUMAN_ACTIVITY_CHANGED");
                        },
                        delegate {},
                        delegate(int index) {
                            sent.Add(index);
                            return 1;
                        },
                        delegate { return true; }, delegate { return false; }, delegate(bool point, bool press) {},
                        delegate {}, delegate { return time; }, delegate(int ms) { time += ms; });
                }, "DRAFT_HUMAN_ACTIVITY_CHANGED");
                Need(String.Join(",", sent) == "0,1,2", "TEST_VOICE_START_INTERRUPTION_RELEASES_OWN_BUTTON");
                checks++;
            }
            {
                long time = 0;
                var sent = new List<int>();
                int marks = 0;
                Expect(delegate {
                    VoiceStartGesture(delegate(bool held) {}, delegate { marks++; },
                                      delegate(int index) {
                                          sent.Add(index);
                                          return 1;
                                      },
                                      delegate { return false; }, delegate { return false; },
                                      delegate(bool point, bool press) {}, delegate {}, delegate { return time; },
                                      delegate(int ms) { time += ms; });
                }, "VOICE_START_POINTER_UNCONFIRMED");
                Need(marks == 0 && String.Join(",", sent) == "0", "TEST_VOICE_START_NO_DOWN_BEFORE_VERIFIED_MOVE");
                checks++;
            }
            Input[] cancelKeys = VoiceCancelEvents();
            Need(cancelKeys.Length == 2 && cancelKeys[0].Type == 1 && cancelKeys[1].Type == 1 &&
                     cancelKeys[0].Value.Keyboard.Key == 0x1b && cancelKeys[1].Value.Keyboard.Key == 0x1b &&
                     cancelKeys[0].Value.Keyboard.Scan == 0 && cancelKeys[1].Value.Keyboard.Scan == 0 &&
                     cancelKeys[0].Value.Keyboard.Flags == 0 && cancelKeys[1].Value.Keyboard.Flags == 2 &&
                     cancelKeys[0].Value.Keyboard.Extra.Equals(Marker) &&
                     cancelKeys[1].Value.Keyboard.Extra.Equals(Marker),
                 "TEST_CANCEL_ONLY_ESC_DOWN_UP_WITH_OWN_MARKER");
            checks++;
            Need(Releases(cancelKeys, 0).Length == 0 && Releases(cancelKeys, 1).Length == 1 &&
                     Releases(cancelKeys, 1)[0].Value.Keyboard.Key == 0x1b &&
                     Releases(cancelKeys, 1)[0].Value.Keyboard.Flags == 2 &&
                     Releases(cancelKeys, 1)[0].Value.Keyboard.Extra.Equals(Marker),
                 "TEST_CANCEL_PARTIAL_ESC_PREFIX_ONLY_RELEASES_INSERTED_DOWN");
            checks++;
            Recording.Begin(1000);
            Need(!ObserveVoiceInput("mouse", 1, 1, Marker, 0x200, 1000) && VoiceHumanActivity == null,
                 "TEST_OWN_INPUT_DIAGNOSTIC_IGNORED");
            checks++;
            Need(ObserveVoiceInput("mouse", 1, 1, UIntPtr.Zero, 0x200, 1007) &&
                     ObserveVoiceInput("keyboard", 0, 0x10, UIntPtr.Zero, 0x100, 1050),
                 "TEST_EXTERNAL_INPUT_TRACKED");
            var activity = Map(VoiceActivityReport());
            Need(activity.Count == 7 && Text(activity, "kind") == "mouse" &&
                     Object.Equals(Get(activity, "injected"), true) &&
                     Object.Equals(Get(activity, "ownMarker"), false) &&
                     Object.Equals(Get(activity, "lower32Matches"), false) &&
                     Object.Equals(Get(activity, "markerIsZero"), true) && Number(Get(activity, "message")) == 0x200 &&
                     Number(Get(activity, "timeAfterRecordStartMs")) == 7,
                 "TEST_FIRST_INPUT_ONLY");
            checks++;
            VoiceHumanActivity = null;
            Recording = new RecordingAttempt();
            Need(ObserveVoiceInput("keyboard", 0, 0x10, Marker, 0x100, 1000),
                 "TEST_MARKER_WITHOUT_INJECTED_IS_EXTERNAL");
            activity = Map(VoiceActivityReport());
            Need(Object.Equals(Get(activity, "ownMarker"), true) && Object.Equals(Get(activity, "injected"), false) &&
                     Get(activity, "timeAfterRecordStartMs") == null,
                 "TEST_PRE_RECORD_DIAGNOSTIC");
            VoiceHumanActivity = null;
            checks++;
            Need(Marker.ToUInt64() > 0 && Marker.ToUInt64() <= UInt32.MaxValue &&
                     ObserveVoiceInput("mouse", 1, 1, new UIntPtr(0x100000000UL | Marker.ToUInt64()), 0x200, 1000),
                 "TEST_FOREIGN_HIGH_BITS_NOT_OWN");
            activity = Map(VoiceActivityReport());
            Need(Object.Equals(Get(activity, "lower32Matches"), true) &&
                     Object.Equals(Get(activity, "markerIsZero"), false) &&
                     Object.Equals(Get(activity, "ownMarker"), false),
                 "TEST_SAME_LOW_BITS_DIAGNOSTIC");
            VoiceHumanActivity = null;
            VoiceOwnMouseObserved = 0;
            checks++;
            var mouse =
                Data("action", "probeMouseMarker", "permission", Data("mouseMoveDiagnostic", true), "idleMs", 1000,
                     "session", Get(FixtureRequest(), "session"), "mouseTargetRect", new Rect(20, 20, 30, 30).Report());
            Need(ParseMouseDiagnostic(mouse).Binding.OperatorCalibrated, "TEST_MOUSE_DIAGNOSTIC_REQUEST");
            Map(Get(mouse, "permission"))["mouseMoveDiagnostic"] = false;
            Expect(delegate { ParseMouseDiagnostic(mouse); }, "VOICE_PERMISSION_REQUIRED");
            checks++;
            Recording.Begin(2000);
            var failed = Map(VoiceFailure(new Fault("VOICE_CAPTURE_NOT_READY")));
            Need(Object.Equals(Get(failed, "recordingPossible"), true) &&
                     Object.Equals(Get(failed, "deliveryConfirmed"), false),
                 "TEST_UNCERTAIN_RECORDING");
            Recording.BeginSubmit(2500);
            Recording.ObserveEnd(true, 3000);
            Recording.ObserveEnd(false, 3100);
            Need(Recording.Ended && !Recording.PossiblyActive && Recording.EndedAt == 3000,
                 "TEST_ENDED_RECORDING_STAYS_ENDED");
            Recording = new RecordingAttempt();
            checks++;
            Need(MayCancel(true, false, true, 2, 2) && !MayCancel(true, false, true, 2, 3) &&
                     !MayCancel(true, true, true, 2, 2) && !MayCancel(true, false, false, 2, 2) &&
                     !MayCancel(false, false, true, 2, 2),
                 "TEST_CANCEL_OWNERSHIP");
            checks++;
            bool clickMarked = false, clickInserted = false;
            Expect(delegate {
                VoiceDispatchClick(delegate { throw new Fault("DRAFT_HUMAN_ACTIVITY_CHANGED"); },
                                   delegate { clickMarked = true; },
                                   delegate {
                                       clickInserted = true;
                                       return 3;
                                   });
            }, "DRAFT_HUMAN_ACTIVITY_CHANGED");
            Need(!clickMarked && !clickInserted, "TEST_PRE_INPUT_INTERRUPTION_NOT_SUBMISSION_ATTEMPT");
            checks++;
            Expect(delegate {
                VoiceDispatchClick(delegate {}, delegate { clickMarked = true; },
                                   delegate {
                                       clickInserted = true;
                                       throw new Fault("VOICE_CLICK_UNCERTAIN");
                                   });
            }, "VOICE_CLICK_UNCERTAIN");
            Need(clickMarked && clickInserted, "TEST_UNKNOWN_SEND_IS_MARKED_BEFORE_NATIVE_CALL");
            checks++;
            foreach (string code in new[] { "DRAFT_HUMAN_ACTIVITY_CHANGED", "VOICE_BACKGROUND_WECHAT_ACTIVATED" })
            {
                for (int flags = 0; flags < 64; flags++)
                    Need(VoiceMayCancelInterrupted(code, (flags & 1) != 0, (flags & 2) != 0, (flags & 4) != 0,
                                                   (flags & 8) != 0, (flags & 16) != 0,
                                                   (flags & 32) != 0) == (flags == 13),
                         "TEST_INTERRUPTION_CANCEL_COMPLETE_PRE_SEND_BOUND_OWNERSHIP");
                checks++;
            }
            foreach (string code in new[] { "VOICE_RECORDING_END_UNCONFIRMED", "VOICE_CLICK_UNCERTAIN",
                                            "VOICE_CAPTURE_CHANGED", "VOICE_WINDOW_BINDING_CHANGED",
                                            "VOICE_PARENT_CLOSED", "VOICE_RECORDING_DEADLINE", null })
            {
                Need(!VoiceMayCancelInterrupted(code, true, false, true, true, false, false),
                     "TEST_NON_ACTIVITY_FAILURE_NEVER_NEW_CANCEL_LEASE");
                checks++;
            }
            Need(VoiceInterruptedFailureCode("AUDIO_PLAYBACK_CANCELLED", "DRAFT_HUMAN_ACTIVITY_CHANGED") ==
                         "DRAFT_HUMAN_ACTIVITY_CHANGED" &&
                     VoiceInterruptedFailureCode("AUDIO_PLAYBACK_CANCELLED", "VOICE_PARENT_CLOSED") ==
                         "AUDIO_PLAYBACK_CANCELLED" &&
                     VoiceInterruptedFailureCode("VOICE_CAPTURE_CHANGED", "DRAFT_HUMAN_ACTIVITY_CHANGED") ==
                         "VOICE_CAPTURE_CHANGED",
                 "TEST_PUMP_CANCEL_RACE_PRESERVES_ONLY_CONFIRMED_HUMAN_REASON");
            checks++;
            long cleanupClock = 0, lastCleanupInput = 0;
            bool cleanupKeys = false;
            int cleanupGuards = 0;
            VoiceWaitCancellationQuiet(100, 30, delegate { return cleanupClock; },
                                       delegate { return lastCleanupInput; }, delegate { return cleanupKeys; },
                                       delegate { cleanupGuards++; },
                                       delegate(int ms) {
                                           cleanupClock += ms;
                                           if (cleanupClock == 20)
                                           {
                                               lastCleanupInput = 20;
                                               cleanupKeys = true;
                                           }
                                       });
            Need(cleanupClock == 50 && cleanupGuards == 7,
                 "TEST_CANCEL_WAIT_QUIET_AFTER_LATEST_ACTIVITY_AND_RELEASED_KEYS");
            checks++;
            cleanupClock = 0;
            Expect(delegate {
                VoiceWaitCancellationQuiet(40, 30, delegate { return cleanupClock; }, delegate { return cleanupClock; },
                                           delegate { return true; }, delegate {},
                                           delegate(int ms) { cleanupClock += ms; });
            }, "VOICE_INTERRUPTION_CLEANUP_TIMEOUT");
            Need(cleanupClock == 40, "TEST_CANCEL_QUIET_WAIT_BOUNDED");
            checks++;
            cleanupClock = 100;
            int cleanupSleeps = 0;
            Expect(delegate {
                VoiceWaitCancellationQuiet(
                    200, 30, delegate { return cleanupClock; }, delegate { return 0; }, delegate { return true; },
                    delegate { throw new Fault("VOICE_CAPTURE_CHANGED"); }, delegate(int ms) { cleanupSleeps++; });
            }, "VOICE_CAPTURE_CHANGED");
            Need(cleanupSleeps == 0, "TEST_CANCEL_WAIT_REVALIDATES_BOUND_CAPTURE_BEFORE_INPUT");
            checks++;
            cleanupClock = 0;
            int endSamples = 0, endGuards = 0;
            bool ended = VoiceObserveCancelledCapture(delegate { endGuards++; },
                                                      delegate {
                                                          endSamples++;
                                                          return true;
                                                      },
                                                      delegate { return cleanupClock; },
                                                      delegate(int ms) { cleanupClock += ms; });
            Need(ended && endSamples == 2 && endGuards == 4 && cleanupClock == 40,
                 "TEST_ESC_END_USES_TWO_BOUND_INACTIVE_SAMPLES_WITHOUT_BUTTON_READ_OR_POINTER_MOVE");
            checks++;
            cleanupClock = 0;
            endSamples = 0;
            ended = VoiceObserveCancelledCapture(delegate {}, delegate { return ++endSamples != 2; },
                                                 delegate { return cleanupClock; },
                                                 delegate(int ms) { cleanupClock += ms; });
            Need(ended && endSamples == 4 && cleanupClock == 120, "TEST_ESC_ACTIVE_SAMPLE_RESETS_INACTIVE_OBSERVATION");
            checks++;
            cleanupClock = 0;
            ended =
                VoiceObserveCancelledCapture(delegate {}, delegate { return false; }, delegate { return cleanupClock; },
                                             delegate(int ms) { cleanupClock += ms; });
            Need(!ended && cleanupClock == 1000, "TEST_ESC_CANCEL_NOT_CONFIRMED_WHILE_BOUND_CAPTURE_ACTIVE");
            checks++;
            cleanupClock = 0;
            endSamples = endGuards = 0;
            Expect(delegate {
                VoiceObserveCancelledCapture(
                    delegate {
                        if (++endGuards == 2)
                            throw new Fault("DRAFT_HUMAN_ACTIVITY_CHANGED");
                    },
                    delegate {
                        endSamples++;
                        return true;
                    },
                    delegate { return cleanupClock; }, delegate(int ms) { cleanupClock += ms; });
            }, "DRAFT_HUMAN_ACTIVITY_CHANGED");
            Need(endSamples == 1 && cleanupClock == 0,
                 "TEST_ESC_END_LOSES_OBSERVATION_ON_REAL_ACTIVITY_WITHOUT_RETRYING_INPUT");
            checks++;
            int previousCancelled = VoiceCancelled, previousExternal = VoiceExternalStop;
            string previousStop = VoiceStopReason;
            StopVoice("DRAFT_HUMAN_ACTIVITY_CHANGED");
            Need(VoiceExternalStop == previousExternal, "TEST_HUMAN_INTERRUPT_NOT_EXTERNAL_SHUTDOWN");
            StopVoice("VOICE_PARENT_CLOSED");
            Need(VoiceExternalStop == 1, "TEST_PARENT_CLOSE_STOPS_NEW_CLEANUP_EVEN_AFTER_HUMAN");
            VoiceCancelled = previousCancelled;
            VoiceExternalStop = previousExternal;
            VoiceStopReason = previousStop;
            checks++;
            Need(EndEvidence(true, true, false, false) && !EndEvidence(false, true, false, false) &&
                     !EndEvidence(true, false, false, false) && !EndEvidence(true, true, true, false) &&
                     !EndEvidence(true, true, false, true),
                 "TEST_POSITIVE_END_EVIDENCE");
            checks++;
            long parkClock = 0;
            int parkSamples = 0, parkGuards = 0;
            string idleHash =
                VoiceWaitParkedIdle(delegate { parkGuards++; },
                                    delegate {
                                        parkSamples++;
                                        return "idle";
                                    },
                                    delegate { return parkClock; }, delegate(int ms) { parkClock += ms; });
            Need(idleHash == "idle" && parkSamples == 2 && parkGuards == 4 && parkClock == 20,
                 "TEST_SHARED_PARK_IDLE_READY_AFTER_TWO_REAL_SAMPLES_NOT_FIXED_200");
            checks++;
            parkClock = 0;
            parkSamples = 0;
            idleHash = VoiceWaitParkedIdle(delegate {}, delegate { return ++parkSamples == 1 ? "hover" : "idle"; },
                                           delegate { return parkClock; }, delegate(int ms) { parkClock += ms; });
            Need(idleHash == "idle" && parkSamples == 3 && parkClock == 40,
                 "TEST_SHARED_PARK_TRANSIENT_HOVER_NOT_FROZEN_AS_IDLE");
            checks++;
            parkClock = 0;
            parkSamples = 0;
            Expect(delegate {
                VoiceWaitParkedIdle(delegate {},
                                    delegate { return (++parkSamples).ToString(CultureInfo.InvariantCulture); },
                                    delegate { return parkClock; }, delegate(int ms) { parkClock += ms; });
            }, "VOICE_IDLE_CONTEXT_UNSTABLE");
            Need(parkClock == 200 && parkSamples == 11, "TEST_SHARED_PARK_UNSTABLE_IDLE_BOUNDED_BY_ORIGINAL_200");
            checks++;
            parkClock = 0;
            parkSamples = 0;
            Expect(delegate {
                VoiceWaitParkedIdle(delegate { throw new Fault("DRAFT_HUMAN_ACTIVITY_CHANGED"); },
                                    delegate {
                                        parkSamples++;
                                        return "idle";
                                    },
                                    delegate { return parkClock; }, delegate(int ms) { parkClock += ms; });
            }, "DRAFT_HUMAN_ACTIVITY_CHANGED");
            Need(parkClock == 0 && parkSamples == 0,
                 "TEST_SHARED_PARK_REAL_ACTIVITY_STOPS_BEFORE_BASELINE_OR_RECORDING");
            checks++;
            foreach (string reason in new[] { "VOICE_ADAPTIVE_CONTROL_UNCERTAIN", "VOICE_ADAPTIVE_ROLES_UNCERTAIN",
                                              "VOICE_ADAPTIVE_CHANGED" })
            {
                Need(VoiceMayWaitAdaptive(true, true, reason) && !VoiceMayWaitAdaptive(false, true, reason) &&
                         !VoiceMayWaitAdaptive(true, false, reason),
                     "TEST_SHARED_EARLY_ADAPTIVE_REOBSERVES_ONLY_UNCOMMITTED_TRANSIENT");
            }
            checks++;
            foreach (string reason in new[] { "VOICE_ADAPTIVE_CONTROL_AMBIGUOUS", "VOICE_ADAPTIVE_OBSCURED",
                                              "DRAFT_HUMAN_ACTIVITY_CHANGED", "VOICE_WINDOW_BINDING_CHANGED",
                                              "VOICE_CAPTURE_CHANGED", null })
                Need(!VoiceMayWaitAdaptive(true, true, reason),
                     "TEST_SHARED_EARLY_ADAPTIVE_NEVER_SWALLOWS_AMBIGUITY_OR_OWNERSHIP_CHANGE");
            checks++;
            var session = Map(Get(FixtureRequest(), "session"));
            session["emptyDraftConfirmed"] = true;
            session["recordStartRect"] = new Rect(710, 400, 750, 440).Report();
            session["mouseParkRect"] = new Rect(20, 20, 40, 40).Report();
            session["recordingUi"] =
                Data("focusHwnd", "100", "cancel",
                     Data("rect", new Rect(150, 450, 180, 480).Report(), "rgbaSha256", new string('d', 64)), "submit",
                     Data("rect", new Rect(600, 450, 630, 480).Report(), "rgbaSha256", new string('e', 64)));
            var voice = Data(
                "action", "timedVoicePreview", "id", new string('1', 64), "audioSha256", new string('2', 64),
                "waveFile", "C:\\fixture\\input.wav", "renderId", "fixture-render", "captureId", "fixture-capture",
                "idleMs", 1000, "session", session, "permission",
                Data("recordPreview", true, "playAudio", true, "submitPreview", true, "cancelOwnedRecording", true));
            Need(ParseVoice(voice).AllowCancel, "TEST_VOICE_REQUEST");
            checks++;
            object oldUi = session["recordingUi"], oldStart = session["recordStartRect"];
            session["recordStartRect"] = new Rect(710, 550, 740, 580).Report();
            session["recordingUi"] = Data("focusHwnd", "100", "adaptive",
                                          Data("version", 1, "executableVersion", VoiceAdaptiveVersion, "toolbarRect",
                                               new Rect(120, 535, 780, 590).Report()));
            var adaptiveRequest = ParseVoice(voice);
            Need(adaptiveRequest.Adaptive != null && adaptiveRequest.Cancel == null && adaptiveRequest.Submit == null &&
                     !adaptiveRequest.AdaptiveBound,
                 "TEST_ADAPTIVE_REQUEST_NOT_PREVERIFIED");
            checks++;
            Map(session["recordingUi"]) ["cancel"] = Get(Map(oldUi), "cancel");
            Expect(delegate { ParseVoice(voice); }, "VOICE_TEMPLATE_INVALID");
            checks++;
            session["recordingUi"] = oldUi;
            session["recordStartRect"] = oldStart;
            object legacyPark = session["mouseParkRect"];
            session.Remove("mouseParkRect");
            Expect(delegate { ParseVoice(voice); }, "DRAFT_RECT_INVALID");
            checks++;
            var uiaFingerprint = Data("version", 1, "scope", "chat-title-text-v1", "sha256", new string('a', 64),
                                      "headerRuntimeIdSha256", new string('b', 64), "titleRuntimeIdSha256",
                                      new string('c', 64), "textNodeCount", 1, "targetVerified", false);
            session["recordingUi"] =
                Data("focusHwnd", "100", "uia",
                     Data("version", 1, "executableVersion", "4.2.0.53", "conversationFingerprint", uiaFingerprint));
            voice["focusHandoff"] =
                Data("version", 1, "returnWindow", Data("hwnd", "200", "pid", 99, "processCreatedFileTimeUtc", "456"));
            var noPark = ParseVoice(voice);
            Need(noPark.Uia != null && !noPark.MouseParkProvided && noPark.MousePark.Width == 0 &&
                     noPark.FocusHandoff.Activation == null,
                 "TEST_VOICE_UIA_NO_PARK_OR_CAPTION_PLACEHOLDER");
            checks++;
            session["mouseParkRect"] = null;
            Expect(delegate { ParseVoice(voice); }, "DRAFT_RECT_INVALID");
            checks++;
            session["mouseParkRect"] = legacyPark;
            Need(ParseVoice(voice).MouseParkProvided, "TEST_VOICE_UIA_LEGACY_PARK_REMAINS_VALIDATED");
            checks++;
            session["mouseParkRect"] = oldStart;
            Expect(delegate { ParseVoice(voice); }, "VOICE_MOUSE_PARK_INVALID");
            checks++;
            session["recordingUi"] = oldUi;
            session["mouseParkRect"] = legacyPark;
            voice.Remove("focusHandoff");
            session["mouseParkRect"] = new Rect(150, 450, 180, 480).Report();
            Expect(delegate { ParseVoice(voice); }, "VOICE_MOUSE_PARK_INVALID");
            session["mouseParkRect"] = new Rect(20, 20, 40, 40).Report();
            checks++;
            Map(Get(voice, "permission"))["submitPreview"] = false;
            Expect(delegate { ParseVoice(voice); }, "VOICE_PERMISSION_REQUIRED");
            Map(Get(voice, "permission"))["submitPreview"] = true;
            checks++;
            session["emptyDraftConfirmed"] = false;
            Expect(delegate { ParseVoice(voice); }, "VOICE_EMPTY_DRAFT_CONFIRMATION_REQUIRED");
            session["emptyDraftConfirmed"] = true;
            checks++;
            session["draftPolicy"] = "unchecked";
            session["emptyDraftConfirmed"] = false;
            Expect(delegate { ParseVoice(voice); }, "VOICE_EMPTY_DRAFT_CONFIRMATION_REQUIRED");
            checks++;
            voice["focusHandoff"] =
                Data("version", 1, "returnWindow", Data("hwnd", "200", "pid", 99, "processCreatedFileTimeUtc", "456"));
            Need(ParseVoice(voice).FocusHandoff != null, "TEST_SHARED_UNCHECKED_DRAFT_IS_EXPLICIT_AND_ACCEPTED");
            checks++;
            session["emptyDraftConfirmed"] = true;
            Expect(delegate { ParseVoice(voice); }, "VOICE_EMPTY_DRAFT_CONFIRMATION_REQUIRED");
            checks++;
            session["emptyDraftConfirmed"] = false;
            session["draftPolicy"] = "verified";
            Expect(delegate { ParseVoice(voice); }, "VOICE_EMPTY_DRAFT_CONFIRMATION_REQUIRED");
            session.Remove("draftPolicy");
            voice.Remove("focusHandoff");
            session["emptyDraftConfirmed"] = true;
            checks++;
            session["expiresAtMs"] = UtcMs() + 10000;
            Expect(delegate { ParseVoice(voice); }, "VOICE_SESSION_BUDGET_EXCEEDED");
            checks++;
            session["expiresAtMs"] = UtcMs() + 25000;
            session["version"] = 2;
            session["target"] = "fixture-friend";
            session.Remove("editorFocusProof");
            session["targetProof"] = Data(
                "kind", "verified-qt-private-chat-v1", "target", "fixture-friend", "accountRef", new string('a', 64),
                "titleAnchor", Data("rect", new Rect(100, 10, 400, 50).Report(), "rgbaSha256", new string('b', 64)));
            voice["action"] = "timedVoiceSend";
            voice["permission"] = Data("recordNativeVoice", true, "playAudio", true, "submitNativeVoice", true,
                                       "cancelOwnedRecording", true);
            Need(ParseVoiceSend(voice).TitleAnchor.Rect.Width == 300, "TEST_PRIVATE_TARGET_ANCHOR");
            checks++;
            voice["focusHandoff"] =
                Data("version", 1, "returnWindow", Data("hwnd", "200", "pid", 99, "processCreatedFileTimeUtc", "456"));
            Need(ParseVoiceSend(voice).FocusHandoff.Pid == 99, "TEST_PRIVATE_HANDOFF_RETAINED");
            checks++;
            session["draftPolicy"] = "unchecked";
            session["emptyDraftConfirmed"] = false;
            Need(ParseVoiceSend(voice).TitleAnchor != null && ParseVoiceSend(voice).FocusHandoff != null,
                 "TEST_PRODUCTION_UNCHECKED_PRESERVES_TARGET_AND_HANDOFF");
            session.Remove("draftPolicy");
            session["emptyDraftConfirmed"] = true;
            voice.Remove("focusHandoff");
            checks++;
            session["target"] = "filehelper";
            Expect(delegate { ParseVoiceSend(voice); }, "VOICE_TARGET_PROOF_INVALID");
            Map(Get(session, "targetProof"))["target"] = "filehelper";
            Need(ParseVoiceSend(voice).TitleAnchor != null, "TEST_FILEHELPER_USES_REAL_TARGET_PROOF");
            session["target"] = "fixture-friend";
            Map(Get(session, "targetProof"))["target"] = "fixture-friend";
            checks++;
            Map(Get(session, "targetProof"))["target"] = "other";
            Expect(delegate { ParseVoiceSend(voice); }, "VOICE_TARGET_PROOF_INVALID");
            Map(Get(session, "targetProof"))["target"] = "fixture-friend";
            checks++;
            var groupProof = Map(Get(session, "targetProof"));
            session["target"] = "fixture-room@chatroom";
            groupProof["target"] = "fixture-room@chatroom";
            Expect(delegate { ParseVoiceSend(voice); }, "VOICE_TARGET_PROOF_INVALID");
            checks++;
            groupProof["kind"] = "verified-qt-group-chat-v1";
            Expect(delegate { ParseVoiceSend(voice); }, "VOICE_TARGET_PROOF_INVALID");
            checks++;
            groupProof["querySha256"] = new string('c', 64);
            Need(ParseVoiceSend(voice).TitleAnchor.Rect.Width == 300, "TEST_GROUP_TARGET_AND_QUERY_PROOF");
            checks++;
            session["target"] = "fixture-friend";
            groupProof["target"] = "fixture-friend";
            Expect(delegate { ParseVoiceSend(voice); }, "VOICE_TARGET_PROOF_INVALID");
            checks++;
            groupProof["kind"] = "verified-qt-private-chat-v1";
            groupProof.Remove("querySha256");
            Expect(delegate { ParseVoice(voice); }, "VOICE_REQUEST_INVALID");
            checks++;
            string warmNonce = new string('a', 64), warmId = new string('b', 32);
            var warmInit = Data("action", "warmVoiceMonitor", "version", 1, "nonce", warmNonce);
            Need(ParseVoiceWarmInit(warmInit) == warmNonce, "TEST_WARM_INIT");
            checks++;
            warmInit["extra"] = true;
            Expect(delegate { ParseVoiceWarmInit(warmInit); }, "VOICE_WARMUP_REQUEST_INVALID");
            warmInit.Remove("extra");
            warmInit["nonce"] = "short";
            Expect(delegate { ParseVoiceWarmInit(warmInit); }, "VOICE_WARMUP_REQUEST_INVALID");
            checks++;
            var warm = Data("action", "executeWarmVoice", "version", 1, "nonce", warmNonce, "monitorId", warmId, "mode",
                            "private-send", "request", voice);
            bool warmProduction = false;
            Need(Object.ReferenceEquals(ParseVoiceWarmExecution(warm, warmNonce, warmId, out warmProduction), voice) &&
                     warmProduction,
                 "TEST_WARM_EXECUTION_EXACT_PACKET");
            checks++;
            Expect(delegate { ParseVoiceWarmExecution(warm, new string('c', 64), warmId, out warmProduction); },
                   "VOICE_WARMUP_BINDING_INVALID");
            Expect(delegate { ParseVoiceWarmExecution(warm, warmNonce, new string('c', 32), out warmProduction); },
                   "VOICE_WARMUP_BINDING_INVALID");
            checks++;
            warm["mode"] = "private-once";
            Expect(delegate { ParseVoiceWarmExecution(warm, warmNonce, warmId, out warmProduction); },
                   "VOICE_WARMUP_MODE_INVALID");
            warm["mode"] = "private-send";
            warm["extra"] = true;
            Expect(delegate { ParseVoiceWarmExecution(warm, warmNonce, warmId, out warmProduction); },
                   "VOICE_WARMUP_BINDING_INVALID");
            checks++;
            long warmRevision = Interlocked.Read(ref Revision), warmActivity = Interlocked.Read(ref LastActivity);
            int warmCancelled = VoiceCancelled;
            VoiceWarmPhase = 1;
            Need(VoiceWarmCollect(true) && Interlocked.Read(ref Revision) == warmRevision,
                 "TEST_WARM_OWN_INPUT_IGNORED");
            Need(VoiceWarmCollect(false) && Interlocked.Read(ref Revision) == warmRevision + 1 &&
                     VoiceCancelled == warmCancelled && Gate == null,
                 "TEST_WARM_HUMAN_OBSERVES_WITHOUT_INPUT_LEASE_OR_CANCEL");
            checks++;
            Need(Interlocked.CompareExchange(ref VoiceWarmPhase, 2, 1) == 1 &&
                     Interlocked.CompareExchange(ref VoiceWarmPhase, 2, 1) == 2 && !VoiceWarmCollect(false) &&
                     Interlocked.Read(ref Revision) == warmRevision + 1,
                 "TEST_WARM_SINGLE_COMMIT_EXECUTION_NOT_COLLECT_ONLY");
            VoiceWarmPhase = 0;
            Interlocked.Exchange(ref Revision, warmRevision);
            Interlocked.Exchange(ref LastActivity, warmActivity);
            checks++;
            checks += VoiceFocusHandoffSelfTest();
            checks += VoiceFocusSafetySelfTest();
            checks += VoiceAdaptiveSelfTest();
            checks += VoiceUiaSelfTest();
            checks += WindowMessageInputSelfTest();
            checks += VoiceUiaPointerSelfTest();
            checks += AudioRouteProbe.NativeVoiceAudio.SyntheticTests();
            Write(Data("ok", true, "selfTest", true, "checks", checks, "uiAccessed", false, "devicesAccessed", false,
                       "audioStarted", false, "inputSent", false));
            return 0;
        }
        catch
        {
            Write(Data("ok", false, "selfTest", true, "checks", checks));
            return 1;
        }
    }
}
