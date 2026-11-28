// Bounded native recording. Preview and verified Qt private-chat protocols are
// distinct. No microphone capture, default changes or automatic retry.
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
    sealed class VoiceTemplate
    {
        internal Rect Rect;
        internal string Hash;
    }
    sealed class VoiceRequest
    {
        internal Request Binding;
        internal string Id, WaveFile, WaveHash, RenderId, CaptureId;
        internal IntPtr RecordingFocus;
        internal Rect RecordStart, MousePark;
        internal bool MouseParkProvided;
        internal VoiceTemplate Cancel, Submit;
        internal VoiceTemplate Idle, TitleAnchor;
        internal VoiceAdaptivePlan Adaptive;
        internal VoiceUiaPlan Uia;
        internal bool AdaptiveBound;
        internal double AdaptiveCancelScore, AdaptiveSubmitScore;
        internal bool AllowCancel;
        internal VoiceReturnWindow FocusHandoff;
    }
    static VoiceRequest ParseVoice(Dictionary<string, object> value)
    {
        Need(value != null && Text(value, "action") == "timedVoicePreview" && Hex(Text(value, "id"), 64) &&
                 Hex(Text(value, "audioSha256"), 64),
             "VOICE_REQUEST_INVALID");
        var permit = Map(Get(value, "permission"));
        Need(Object.Equals(Get(permit, "recordPreview"), true) && Object.Equals(Get(permit, "playAudio"), true) &&
                 Object.Equals(Get(permit, "submitPreview"), true),
             "VOICE_PERMISSION_REQUIRED");
        var session = Map(Get(value, "session"));
        bool uncheckedDraft = session != null && Text(session, "draftPolicy") == "unchecked" &&
                              Object.Equals(Get(session, "emptyDraftConfirmed"), false) &&
                              Map(Get(value, "focusHandoff")) != null;
        Need(session != null && (uncheckedDraft || !session.ContainsKey("draftPolicy") &&
                                                       Object.Equals(Get(session, "emptyDraftConfirmed"), true)),
             "VOICE_EMPTY_DRAFT_CONFIRMATION_REQUIRED");
        // Reuse all process/window/short-session checks without claiming clipboard proof.
        var seed = Data("action", "verifyDraft", "permission",
                        Data("selectionCopy", true, "caretToEnd", true, "clipboardRestore", true), "expectedDraft",
                        "voice calibration only", "idleMs", Get(value, "idleMs"), "session", session);
        Request binding = Parse(seed);
        Need(binding.OperatorCalibrated, "VOICE_OPERATOR_CALIBRATION_REQUIRED");
        Need(binding.Expires - UtcMs() >= 16000, "VOICE_SESSION_BUDGET_EXCEEDED");
        var ui = Map(Get(session, "recordingUi"));
        Need(ui != null, "VOICE_TEMPLATE_INVALID");
        bool adaptive = ui.ContainsKey("adaptive"), uia = ui.ContainsKey("uia");
        Need(!(adaptive && uia) && ui.Count == (adaptive || uia ? 2 : 3) &&
                 (!(adaptive || uia) || !ui.ContainsKey("cancel") && !ui.ContainsKey("submit")),
             "VOICE_TEMPLATE_INVALID");
        var request = new VoiceRequest { Binding = binding,
                                         Id = Text(value, "id"),
                                         WaveFile = Text(value, "waveFile"),
                                         WaveHash = Text(value, "audioSha256"),
                                         RenderId = Text(value, "renderId"),
                                         CaptureId = Text(value, "captureId"),
                                         RecordingFocus = new IntPtr(DecimalString(Get(ui, "focusHwnd"))),
                                         RecordStart = ParseRect(Get(session, "recordStartRect")),
                                         MouseParkProvided = session.ContainsKey("mouseParkRect"),
                                         MousePark = uia && !session.ContainsKey("mouseParkRect")
                                                         ? new Rect()
                                                         : ParseRect(Get(session, "mouseParkRect")),
                                         AllowCancel = Object.Equals(Get(permit, "cancelOwnedRecording"), true) };
        if (uia)
        {
            request.Uia = ParseVoiceUia(Get(ui, "uia"));
            VoiceUiaDiagnostic = request.Uia;
        }
        else if (adaptive)
            request.Adaptive = ParseVoiceAdaptive(Get(ui, "adaptive"), binding, request.RecordStart, request.MousePark);
        else
        {
            request.Cancel = ParseTemplate(Get(ui, "cancel"), binding.Client);
            request.Submit = ParseTemplate(Get(ui, "submit"), binding.Client);
            Need(!Intersects(request.Cancel.Rect, request.Submit.Rect), "VOICE_TEMPLATE_INVALID");
        }
        Need(request.RecordingFocus != IntPtr.Zero && Contains(binding.Client, request.RecordStart) &&
                 request.RecordStart.Width >= 4 && request.RecordStart.Height >= 4,
             "VOICE_TEMPLATE_INVALID");
        // UIA directed clicks never park the system pointer. Missing is legal
        // only for UIA; an explicitly supplied legacy rectangle is still checked.
        if (!uia || request.MouseParkProvided)
            Need(Contains(binding.Client, request.MousePark) && request.MousePark.Width >= 2 &&
                     request.MousePark.Height >= 2 && request.MousePark.Width <= 128 &&
                     request.MousePark.Height <= 128 && !Intersects(request.MousePark, binding.Editor) &&
                     !Intersects(request.MousePark, request.RecordStart) &&
                     (adaptive || uia ||
                      !Intersects(request.MousePark, request.Cancel.Rect) &&
                          !Intersects(request.MousePark, request.Submit.Rect)),
                 "VOICE_MOUSE_PARK_INVALID");
        foreach (string endpoint in new[] { request.RenderId, request.CaptureId })
            Need(!String.IsNullOrEmpty(endpoint) && endpoint.Length <= 1024 &&
                     endpoint.IndexOfAny(new[] { '\0', '\r', '\n' }) < 0,
                 "VOICE_ENDPOINT_INVALID");
        Need(request.RenderId != request.CaptureId, "VOICE_ENDPOINT_INVALID");
        Need(!String.IsNullOrEmpty(request.WaveFile) && Path.IsPathRooted(request.WaveFile), "VOICE_WAV_INVALID");
        if (value.ContainsKey("focusHandoff"))
        {
            Need(Get(value, "focusHandoff") != null, "VOICE_FOCUS_HANDOFF_INVALID");
            request.FocusHandoff = ParseVoiceHandoff(Get(value, "focusHandoff"), binding);
        }
        Need(!uia || request.FocusHandoff != null, "VOICE_UIA_HANDOFF_REQUIRED");
        Need(request.FocusHandoff == null || request.FocusHandoff.Activation == null ||
                 request.FocusHandoff.Activation.UiaCaption == uia,
             "VOICE_UIA_FOCUS_MODE_REQUIRED");
        return request;
    }
    static VoiceRequest ParseVoiceSend(Dictionary<string, object> value)
    {
        Need(value != null && Text(value, "action") == "timedVoiceSend", "VOICE_REQUEST_INVALID");
        var session = Map(Get(value, "session"));
        var proof = Map(Get(session, "targetProof"));
        string target = Text(session, "target");
        bool group = target != null && target.EndsWith("@chatroom", StringComparison.Ordinal);
        Need(session != null && Number(Get(session, "version")) == 2 && !String.IsNullOrEmpty(target) &&
                 target.Length <= 256 && !System.Text.RegularExpressions.Regex.IsMatch(target, "[\\x00-\\x20\\x7f]") &&
                 proof != null &&
                 Text(proof, "kind") == (group ? "verified-qt-group-chat-v1" : "verified-qt-private-chat-v1") &&
                 (!group || Hex(Text(proof, "querySha256"), 64)) && Text(proof, "target") == target &&
                 Hex(Text(proof, "accountRef"), 64),
             "VOICE_TARGET_PROOF_INVALID");
        bool uia = Map(Get(Map(Get(session, "recordingUi")), "uia")) != null;
        VoiceUiaFingerprint conversation = null;
        VoiceTemplate titleAnchor = null;
        if (uia)
        {
            Need(!proof.ContainsKey("titleAnchor") && proof.Count == (group ? 5 : 4), "VOICE_TARGET_PROOF_INVALID");
            conversation = ParseVoiceUiaFingerprint(Get(proof, "conversationFingerprint"));
        }
        else
        {
            Need(!proof.ContainsKey("conversationFingerprint"), "VOICE_TARGET_PROOF_INVALID");
            var anchor = Map(Get(proof, "titleAnchor"));
            Need(anchor != null && anchor.Count == 2 && Hex(Text(anchor, "rgbaSha256"), 64),
                 "VOICE_TARGET_PROOF_INVALID");
            Rect title = ParseRect(Get(anchor, "rect")), client = ParseRect(Get(session, "clientRect")),
                 editor = ParseRect(Get(session, "editorRect"));
            Need(Contains(client, title) && title.Width <= 1024 && title.Height <= 256 && !Intersects(title, editor),
                 "VOICE_TARGET_PROOF_INVALID");
            titleAnchor = new VoiceTemplate { Rect = title, Hash = Text(anchor, "rgbaSha256") };
        }
        var permit = Map(Get(value, "permission"));
        Need(Object.Equals(Get(permit, "recordNativeVoice"), true) && Object.Equals(Get(permit, "playAudio"), true) &&
                 Object.Equals(Get(permit, "submitNativeVoice"), true) && Get(permit, "cancelOwnedRecording") is bool,
             "VOICE_PERMISSION_REQUIRED");
        // Reuse the common window/audio/layout parser only. The chat
        // identity is independently guarded by this production title anchor.
        var window = new Dictionary<string, object>(session);
        window["version"] = 1;
        window["target"] = "filehelper";
        window["editorFocusProof"] =
            Data("kind", "operator-calibrated-edit-region", "calibrationHash", Get(session, "calibrationHash"),
                 "lastInputTick", Get(session, "lastInputTick"));
        var common = new Dictionary<string, object>(value);
        common["action"] = "timedVoicePreview";
        common["session"] = window;
        common["permission"] = Data("recordPreview", true, "playAudio", true, "submitPreview", true,
                                    "cancelOwnedRecording", Get(permit, "cancelOwnedRecording"));
        VoiceRequest request = ParseVoice(common);
        if (uia)
            Need(SameVoiceUiaFingerprint(conversation, request.Uia.Conversation), "VOICE_TARGET_PROOF_INVALID");
        else
            request.TitleAnchor = titleAnchor;
        return request;
    }
}
