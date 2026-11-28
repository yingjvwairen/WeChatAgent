// Capture lifecycle and timed playback, independent of window navigation.
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

internal static partial class AudioRouteProbe
{
    internal sealed class NativeVoiceAudio : IDisposable
    {
        IMMDeviceEnumerator enumerator;
        IAudioSessionControl boundCapture;
        TimedVoiceAudioPump pump;
        readonly string captureId;
        bool disposed;
        internal double DurationMs
        {
            get {
                return pump.DurationMs;
            }
        }
        internal long StartedAtMs
        {
            get {
                return pump.StartedAtMs;
            }
        }
        internal long DrainedAtMs
        {
            get {
                return pump.DrainedAtMs;
            }
        }
        internal bool PlaybackCompleted
        {
            get {
                return pump.CompletedSuccessfully;
            }
        }
        internal NativeVoiceAudio(string render, string capture, string file, string sha256)
        {
            captureId = capture;
            try
            {
                enumerator = (IMMDeviceEnumerator) new MMDeviceEnumerator();
                var devices = Enumerate(enumerator);
                Select(devices, captureId, 1);
                Select(devices, render, 0);
                CheckDefaults();
                pump = new TimedVoiceAudioPump(
                    delegate(Func<bool> cancelled) { return new VoiceWasapiOutput(render, file, sha256, cancelled); },
                    delegate { return new VoiceTimerPeriodLease(VoiceTimeBeginPeriod, VoiceTimeEndPeriod); });
            }
            catch
            {
                Dispose();
                throw;
            }
        }
        internal void CheckDefaults()
        {
            for (int role = 0; role < 3; role++)
            {
                IMMDevice current = null;
                try
                {
                    Hr(enumerator.GetDefaultAudioEndpoint(1, role, out current));
                    Endpoint endpoint = Describe(current, 1);
                    Check(endpoint.Id == captureId && Eligible(endpoint), "AUDIO_DEFAULT_CAPTURE_NOT_CABLE");
                }
                finally
                {
                    Release(current);
                }
            }
        }
        internal string ActiveSession(uint targetPid)
        {
            return QuerySession(targetPid, null);
        }
        internal void BindCapture(uint targetPid, string expected)
        {
            Check(boundCapture == null, "AUDIO_CAPTURE_ALREADY_BOUND");
            Check(QuerySession(targetPid, expected) == expected && boundCapture != null, "AUDIO_CAPTURE_BIND_FAILED");
        }
        internal bool BoundCaptureInactive()
        {
            if (boundCapture == null)
                return false;
            int state;
            Hr(((IAudioSessionControl2)boundCapture).GetState(out state));
            Check(state >= 0 && state <= 2, "AUDIO_SESSION_STATE_INVALID");
            return state == 0 || state == 2;
        }
        string QuerySession(uint targetPid, string binding)
        {
            string found = null;
            foreach (var endpoint in Enumerate(enumerator, 1, 1))
            {
                IMMDevice source = null;
                IAudioSessionManager2 manager = null;
                IAudioSessionEnumerator sessions = null;
                try
                {
                    Hr(enumerator.GetDevice(endpoint.Id, out source));
                    object instance;
                    Guid guid = SessionManagerGuid;
                    Hr(source.Activate(ref guid, 23, IntPtr.Zero, out instance));
                    manager = (IAudioSessionManager2)instance;
                    Hr(manager.GetSessionEnumerator(out sessions));
                    int count;
                    Hr(sessions.GetCount(out count));
                    Check(count >= 0 && count <= 256, "AUDIO_SESSION_LIMIT");
                    for (int i = 0; i < count; i++)
                    {
                        IAudioSessionControl current = null;
                        try
                        {
                            Hr(sessions.GetSession(i, out current));
                            var detail = (IAudioSessionControl2)current;
                            uint pid;
                            int owner = detail.GetProcessId(out pid);
                            Hr(owner);
                            if (pid != targetPid)
                                continue;
                            int state;
                            Hr(detail.GetState(out state));
                            Check(state >= 0 && state <= 2, "AUDIO_SESSION_STATE_INVALID");
                            if (state != 1)
                                continue;
                            Check(owner == 0 && endpoint.Id == captureId && Eligible(endpoint),
                                  "AUDIO_CAPTURE_ROUTE_MISMATCH");
                            Check(found == null, "AUDIO_CAPTURE_AMBIGUOUS");
                            IntPtr name = IntPtr.Zero;
                            try
                            {
                                Hr(detail.GetSessionInstanceIdentifier(out name));
                                found = Marshal.PtrToStringUni(name);
                                Check(!String.IsNullOrEmpty(found) && found.Length <= 2048, "AUDIO_SESSION_ID_INVALID");
                            }
                            finally
                            {
                                if (name != IntPtr.Zero)
                                    Marshal.FreeCoTaskMem(name);
                            }
                            if (binding != null && found == binding)
                            {
                                boundCapture = current;
                                current = null;
                            }
                        }
                        finally
                        {
                            Release(current);
                        }
                    }
                }
                finally
                {
                    Release(sessions);
                    Release(manager);
                    Release(source);
                }
            }
            return found;
        }
        internal void Start()
        {
            pump.Start();
        }
        internal bool Pump()
        {
            return pump.Complete();
        }
        internal void Cancel()
        {
            var current = pump;
            if (current != null)
                current.Cancel();
        }
        internal void StopOutput()
        {
            if (pump != null)
                pump.StopAndJoin();
        }
        internal object PumpReport()
        {
            return pump == null ? null : pump.Report();
        }
        public void Dispose()
        {
            if (disposed)
                return;
            disposed = true;
            if (pump != null)
                pump.Dispose();
            Release(boundCapture);
            boundCapture = null;
            Release(enumerator);
            enumerator = null;
        }
        internal static int SyntheticTests()
        {
            int count = WaveSelfTest();
            Wave value = ParseWave(FixtureWave(16000, 1, false, 16000));
            Check(value.DurationMs == 1000 && value.OutputFrames(48000) == 48000, "AUDIO_SELF_TEST_FAILED");
            count++;
            return count + TimedVoiceAudioPump.SyntheticTests();
        }
    }
}
