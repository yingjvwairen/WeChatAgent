// Local-only WASAPI diagnostic. No default-device playback/capture, settings changes, UI or audio files.
// --list is read-only; --probe requires exact IDs of the two named VB-CABLE endpoints.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Threading;
using System.Web.Script.Serialization;

internal static partial class AudioRouteProbe
{
    const string RenderName = "CABLE Input (VB-Audio Virtual Cable)";
    const string CaptureName = "CABLE Output (VB-Audio Virtual Cable)";
    const string AdapterName = "VB-Audio Virtual Cable";
    const double Amplitude = 0.025;
    static readonly Guid Pcm = new Guid("00000001-0000-0010-8000-00aa00389b71");
    static readonly Guid Float = new Guid("00000003-0000-0010-8000-00aa00389b71");
    static readonly Guid ClientGuid = new Guid("1cb9ad4c-dbfa-4c32-b178-c2f568a703b2");
    static readonly Guid RenderGuid = new Guid("f294acfc-3146-4483-a7bf-addca7c260e2");
    static readonly Guid CaptureGuid = new Guid("c8adbd64-e71e-48a0-a4de-185c395cd317");
    static readonly Guid SessionManagerGuid = new Guid("77aa99a0-1bd6-484f-8bc7-2c654c9a9b6f");
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 131072 };
    static int Finished;
    static bool AudioStarted;

    static Dictionary<string, object> Result(params object[] fields)
    {
        var value = new Dictionary<string, object>();
        for (int i = 0; i < fields.Length; i += 2)
            value.Add((string)fields[i], fields[i + 1]);
        return value;
    }
    sealed class Fault : Exception
    {
        public Fault(string code) : base(code)
        {
        }
    }
    static void Check(bool value, string code)
    {
        if (!value)
            throw new Fault(code);
    }
    static void Hr(int value)
    {
        if (value < 0)
            throw new Fault("AUDIO_API_FAILED");
    }
    static void Release(object value)
    {
        if (value != null && Marshal.IsComObject(value))
            Marshal.ReleaseComObject(value);
    }
    static void Emit(object value)
    {
        Console.WriteLine(Json.Serialize(value));
    }

    [MTAThread]
    static int Main(string[] args)
    {
        using (var watchdog = new Timer(delegate {
                   if (Interlocked.Exchange(ref Finished, 1) == 0)
                   {
                       Emit(Result("ok", false, "code", "AUDIO_TIMEOUT", "audioStarted", AudioStarted, "recordingSaved",
                                   false));
                       // Process exit also releases audio sessions if an audio driver call hangs.
                       Environment.Exit(2);
                   }
               }, null, args.Length > 0 && args[0] == "--play-wav" ? 70000 : 12000, Timeout.Infinite))
        {
            try
            {
                object result;
                if (args.Length == 1 && args[0] == "--self-test")
                    result = SelfTest();
                else if (args.Length == 0 || args.Length == 1 && args[0] == "--list")
                    result = List();
                else if (args.Length == 5 && args[0] == "--probe" && args[1] == "--render-id" &&
                         args[3] == "--capture-id")
                    result = Probe(args[2], args[4]);
                else if (args.Length == 3 && args[0] == "--play-test" && args[1] == "--render-id")
                    result = PlayTest(args[2]);
                else if (args.Length == 3 && args[0] == "--capture-sessions" && args[1] == "--pid")
                    result = CaptureSessions(ParsePid(args[2]));
                else if (args.Length == 5 && args[0] == "--play-wav" && args[1] == "--render-id" && args[3] == "--wav")
                    result = PlayWave(args[2], args[4]);
                else
                    throw new Fault("AUDIO_ARGUMENTS_INVALID");
                if (Interlocked.Exchange(ref Finished, 1) == 0)
                    Emit(result);
                var report = result as Dictionary<string, object>;
                if (report != null && report.ContainsKey("routeVerified") && !(bool)report["routeVerified"])
                    return 3;
                return 0;
            }
            catch (Fault error)
            {
                if (Interlocked.Exchange(ref Finished, 1) == 0)
                    Emit(Result("ok", false, "code", error.Message, "audioStarted", AudioStarted, "recordingSaved",
                                false));
                return 2;
            }
            catch
            {
                if (Interlocked.Exchange(ref Finished, 1) == 0)
                    Emit(Result("ok", false, "code", "AUDIO_DIAGNOSTIC_FAILED", "audioStarted", AudioStarted,
                                "recordingSaved", false));
                return 2;
            }
        }
    }

    sealed class Endpoint
    {
        public string Id, Name, Adapter;
        public int Flow;
        public object Report()
        {
            return Result("id", Id, "name", Name, "adapter", Adapter, "flow", Flow == 0 ? "render" : "capture",
                          "eligible", Eligible(this));
        }
    }
    static bool Eligible(Endpoint device)
    {
        return device != null &&
               String.Equals(device.Name, device.Flow == 0 ? RenderName : CaptureName, StringComparison.Ordinal) &&
               String.Equals(device.Adapter, AdapterName, StringComparison.Ordinal) &&
               (device.Flow == 0 || device.Flow == 1);
    }
    static Endpoint Select(List<Endpoint> devices, string id, int flow)
    {
        Check(!String.IsNullOrEmpty(id) && id.Length <= 1024 && id.IndexOf('\0') < 0, "AUDIO_ENDPOINT_ID_REQUIRED");
        Endpoint found = null;
        int eligible = 0;
        foreach (var device in devices)
        {
            if (device.Flow == flow && Eligible(device))
                eligible++;
            if (device.Id == id && device.Flow == flow)
            {
                Check(found == null, "AUDIO_ENDPOINT_AMBIGUOUS");
                found = device;
            }
        }
        Check(found != null && Eligible(found), "AUDIO_VIRTUAL_ENDPOINT_REQUIRED");
        Check(eligible == 1, "AUDIO_ENDPOINT_AMBIGUOUS");
        return found;
    }
    static List<Endpoint> Enumerate(IMMDeviceEnumerator enumerator, int firstFlow = 0, int lastFlow = 1)
    {
        var result = new List<Endpoint>();
        for (int flow = firstFlow; flow <= lastFlow; flow++)
        {
            IMMDeviceCollection collection = null;
            try
            {
                Hr(enumerator.EnumAudioEndpoints(flow, 1, out collection));
                uint count;
                Hr(collection.GetCount(out count));
                Check(count <= 128, "AUDIO_ENDPOINT_LIMIT");
                for (uint index = 0; index < count; index++)
                {
                    IMMDevice device = null;
                    try
                    {
                        Hr(collection.Item(index, out device));
                        result.Add(Describe(device, flow));
                    }
                    finally
                    {
                        Release(device);
                    }
                }
            }
            finally
            {
                Release(collection);
            }
        }
        return result;
    }
    static Endpoint Describe(IMMDevice device, int flow)
    {
        IntPtr pointer = IntPtr.Zero;
        IPropertyStore properties = null;
        try
        {
            Hr(device.GetId(out pointer));
            string id = Marshal.PtrToStringUni(pointer);
            Check(!String.IsNullOrEmpty(id) && id.Length <= 1024, "AUDIO_ENDPOINT_INVALID");
            Hr(device.OpenPropertyStore(0, out properties));
            string name = PropertyString(properties, "a45c254e-df1c-4efd-8020-67d146a850e0", 14);
            string adapter = PropertyString(properties, "026e516e-b814-414b-83cd-856d6fef4822", 2);
            return new Endpoint { Id = id, Name = name, Adapter = adapter, Flow = flow };
        }
        finally
        {
            if (pointer != IntPtr.Zero)
                Marshal.FreeCoTaskMem(pointer);
            Release(properties);
        }
    }
    static string PropertyString(IPropertyStore properties, string format, uint id)
    {
        var key = new PROPERTYKEY { format = new Guid(format), id = id };
        PROPVARIANT value;
        Hr(properties.GetValue(ref key, out value));
        try
        {
            Check(value.type == 31, "AUDIO_ENDPOINT_INVALID");
            string text = Marshal.PtrToStringUni(value.pointer);
            Check(!String.IsNullOrEmpty(text) && text.Length <= 512, "AUDIO_ENDPOINT_INVALID");
            return text;
        }
        finally
        {
            PropVariantClear(ref value);
        }
    }
    static object List()
    {
        var enumerator = (IMMDeviceEnumerator) new MMDeviceEnumerator();
        try
        {
            var reports = new List<object>();
            foreach (var device in Enumerate(enumerator))
                reports.Add(device.Report());
            return Result("ok", true, "mode", "list", "audioStarted", false, "recordingSaved", false, "devices",
                          reports, "defaultCapture",
                          Result("console", DefaultCapture(enumerator, 0), "multimedia", DefaultCapture(enumerator, 1),
                                 "communications", DefaultCapture(enumerator, 2)),
                          "defaultRender",
                          Result("console", DefaultEndpoint(enumerator, 0, 0), "multimedia",
                                 DefaultEndpoint(enumerator, 0, 1), "communications",
                                 DefaultEndpoint(enumerator, 0, 2)),
                          "defaultsUsedForAudio", false, "wechatCaptureSourceVerified", false);
        }
        finally
        {
            Release(enumerator);
        }
    }
    static object DefaultCapture(IMMDeviceEnumerator enumerator, int role)
    {
        return DefaultEndpoint(enumerator, 1, role);
    }
    static object DefaultEndpoint(IMMDeviceEnumerator enumerator, int flow, int role)
    {
        IMMDevice device = null;
        try
        {
            // Read identity only. A Windows default is not evidence of WeChat's selected input.
            int result = enumerator.GetDefaultAudioEndpoint(flow, role, out device);
            if (result == unchecked((int)0x80070490))
                return Result("available", false);
            Hr(result);
            return Result("available", true, "device", Describe(device, flow).Report());
        }
        finally
        {
            Release(device);
        }
    }
    static uint ParsePid(string text)
    {
        Check(!String.IsNullOrEmpty(text) && text.Length <= 10 && text[0] >= '1' && text[0] <= '9',
              "AUDIO_PID_INVALID");
        foreach (char value in text)
            Check(value >= '0' && value <= '9', "AUDIO_PID_INVALID");
        int pid;
        Check(Int32.TryParse(text, out pid) && pid > 0, "AUDIO_PID_INVALID");
        return (uint)pid;
    }
    static Dictionary<string, object> SessionReport(uint pid, List<object> matches, int examined, int unavailable)
    {
        return Result("ok", true, "mode", "capture-sessions", "metadataOnly", true, "targetPid", pid, "matches",
                      matches, "captureEndpointsExamined", examined, "unavailableQueries", unavailable,
                      "snapshotMayBeIncomplete", true, "absenceProvesNoCapture", false, "audioStarted", false,
                      "captureOpened", false, "recordingSaved", false, "systemSettingsChanged", false,
                      "audioSamplesVerified", false, "wechatVerified", false);
    }
    static object CaptureSessions(uint targetPid)
    {
        var enumerator = (IMMDeviceEnumerator) new MMDeviceEnumerator();
        var matches = new List<object>();
        int examined = 0, unavailable = 0;
        try
        {
            // Read only session metadata. Never activate IAudioClient or IAudioCaptureClient here.
            // Enumeration can miss a just-created or already-released session, so no match is inconclusive.
            foreach (var endpoint in Enumerate(enumerator, 1, 1))
            {
                IMMDevice device = null;
                IAudioSessionManager2 manager = null;
                IAudioSessionEnumerator sessions = null;
                try
                {
                    Hr(enumerator.GetDevice(endpoint.Id, out device));
                    object instance;
                    Guid guid = SessionManagerGuid;
                    Hr(device.Activate(ref guid, 23, IntPtr.Zero, out instance));
                    manager = (IAudioSessionManager2)instance;
                    Hr(manager.GetSessionEnumerator(out sessions));
                    int count;
                    Hr(sessions.GetCount(out count));
                    Check(count >= 0 && count <= 256, "AUDIO_SESSION_LIMIT");
                    examined++;
                    for (int index = 0; index < count; index++)
                    {
                        IAudioSessionControl control = null;
                        try
                        {
                            Hr(sessions.GetSession(index, out control));
                            var detail = (IAudioSessionControl2)control;
                            uint pid;
                            int ownership = detail.GetProcessId(out pid);
                            Hr(ownership);
                            if (pid != targetPid)
                                continue;
                            int state;
                            Hr(detail.GetState(out state));
                            Check(state >= 0 && state <= 2, "AUDIO_SESSION_STATE_INVALID");
                            Check(matches.Count < 256, "AUDIO_SESSION_LIMIT");
                            matches.Add(Result("pid", pid, "state",
                                               state == 0   ? "inactive"
                                               : state == 1 ? "active"
                                                            : "expired",
                                               "singleProcess", ownership == 0, "endpoint", endpoint.Report()));
                        }
                        catch (Fault)
                        {
                            unavailable++;
                        }
                        finally
                        {
                            Release(control);
                        }
                    }
                }
                catch (Fault)
                {
                    unavailable++;
                }
                finally
                {
                    Release(sessions);
                    Release(manager);
                    Release(device);
                }
            }
            return SessionReport(targetPid, matches, examined, unavailable);
        }
        finally
        {
            Release(enumerator);
        }
    }

    sealed class Format
    {
        public int Channels, Rate, Bytes, Align;
        public bool Floating;
        public object Report()
        {
            return Result("sampleRate", Rate, "channels", Channels, "bits", Bytes * 8, "encoding",
                          Floating ? "float" : "pcm");
        }
    }
    static Format ParseFormat(byte[] bytes)
    {
        Check(bytes.Length >= 18, "AUDIO_FORMAT_UNSUPPORTED");
        int tag = BitConverter.ToUInt16(bytes, 0), channels = BitConverter.ToUInt16(bytes, 2),
            rate = BitConverter.ToInt32(bytes, 4), align = BitConverter.ToUInt16(bytes, 12),
            bits = BitConverter.ToUInt16(bytes, 14);
        bool floating = tag == 3;
        if (tag == 65534)
        {
            Check(bytes.Length >= 40 && BitConverter.ToUInt16(bytes, 16) >= 22, "AUDIO_FORMAT_UNSUPPORTED");
            var sub = new byte[16];
            Buffer.BlockCopy(bytes, 24, sub, 0, 16);
            var guid = new Guid(sub);
            Check(guid == Pcm || guid == Float, "AUDIO_FORMAT_UNSUPPORTED");
            floating = guid == Float;
            Check(BitConverter.ToUInt16(bytes, 18) == bits, "AUDIO_FORMAT_UNSUPPORTED");
        }
        else
            Check(tag == 1 || tag == 3, "AUDIO_FORMAT_UNSUPPORTED");
        Check(channels >= 1 && channels <= 8 && rate >= 8000 && rate <= 192000 &&
                  (bits == 16 || bits == 24 || bits == 32) && (!floating || bits == 32),
              "AUDIO_FORMAT_UNSUPPORTED");
        Check(align == channels * bits / 8 && BitConverter.ToInt32(bytes, 8) == rate * align,
              "AUDIO_FORMAT_UNSUPPORTED");
        return new Format { Channels = channels, Rate = rate, Align = align, Bytes = bits / 8, Floating = floating };
    }
    sealed class Stream : IDisposable
    {
        public IAudioClient Client;
        public IAudioRenderClient Render;
        public IAudioCaptureClient Capture;
        public Format Format;
        public uint Frames;
        bool started;
        public Stream(IMMDevice device, bool render)
        {
            object value = null;
            IntPtr format = IntPtr.Zero;
            try
            {
                Guid guid = ClientGuid;
                Hr(device.Activate(ref guid, 23, IntPtr.Zero, out value));
                Client = (IAudioClient)value;
                Hr(Client.GetMixFormat(out format));
                int size = 18 + (ushort)Marshal.ReadInt16(format, 16);
                Check(size <= 256, "AUDIO_FORMAT_UNSUPPORTED");
                var bytes = new byte[size];
                Marshal.Copy(format, bytes, 0, size);
                Format = ParseFormat(bytes);
                Hr(Client.Initialize(0, 0, 1000000, 0, format, IntPtr.Zero));
                Hr(Client.GetBufferSize(out Frames));
                Check(Frames > 0 && Frames <= Format.Rate * 2, "AUDIO_BUFFER_LIMIT");
                guid = render ? RenderGuid : CaptureGuid;
                Hr(Client.GetService(ref guid, out value));
                if (render)
                    Render = (IAudioRenderClient)value;
                else
                    Capture = (IAudioCaptureClient)value;
            }
            catch
            {
                Dispose();
                throw;
            }
            finally
            {
                if (format != IntPtr.Zero)
                    Marshal.FreeCoTaskMem(format);
            }
        }
        public void Start()
        {
            Hr(Client.Start());
            started = true;
            AudioStarted = true;
        }
        public void Stop()
        {
            if (started)
            {
                Hr(Client.Stop());
                started = false;
            }
        }
        public void Dispose()
        {
            if (Client != null)
            {
                if (started)
                {
                    Client.Stop();
                    started = false;
                }
                Client.Reset();
            }
            Release(Capture);
            Capture = null;
            Release(Render);
            Render = null;
            Release(Client);
            Client = null;
        }
    }
    static double Tone(double seconds)
    {
        double local, frequency;
        if (seconds >= 0.20 && seconds < 0.70)
        {
            local = seconds - 0.20;
            frequency = 997;
        }
        else if (seconds >= 1.00 && seconds < 1.50)
        {
            local = seconds - 1.00;
            frequency = 1499;
        }
        else
            return 0;
        double ramp = Math.Min(1, Math.Min(local / 0.01, (0.5 - local) / 0.01));
        return Amplitude * Math.Max(0, ramp) * Math.Sin(2 * Math.PI * frequency * local);
    }
    static double PlayTone(double seconds)
    {
        double local, frequency;
        if (seconds >= 0.10 && seconds < 0.35)
        {
            local = seconds - 0.10;
            frequency = 997;
        }
        else if (seconds >= 0.65 && seconds < 0.90)
        {
            local = seconds - 0.65;
            frequency = 1499;
        }
        else
            return 0;
        double ramp = Math.Min(1, Math.Min(local / 0.01, (0.25 - local) / 0.01));
        return Amplitude * Math.Max(0, ramp) * Math.Sin(2 * Math.PI * frequency * local);
    }
    static void Encode(byte[] target, int offset, double value, Format format)
    {
        Check(!Double.IsNaN(value) && !Double.IsInfinity(value) && Math.Abs(value) <= 1, "AUDIO_SAMPLE_INVALID");
        if (format.Floating)
        {
            Buffer.BlockCopy(BitConverter.GetBytes((float)value), 0, target, offset, 4);
            return;
        }
        long scale = 1L << (format.Bytes * 8 - 1);
        long sample = (long)Math.Round(Math.Max(-1, Math.Min(1 - 1.0 / scale, value)) * scale);
        for (int i = 0; i < format.Bytes; i++)
            target[offset + i] = (byte)(sample >> (i * 8));
    }
    static double Decode(byte[] source, int offset, Format format)
    {
        if (format.Floating)
        {
            double value = BitConverter.ToSingle(source, offset);
            Check(!Double.IsNaN(value) && !Double.IsInfinity(value) && Math.Abs(value) <= 4, "AUDIO_SAMPLE_INVALID");
            return value;
        }
        int sample = 0;
        for (int i = 0; i < format.Bytes; i++)
            sample |= source[offset + i] << (i * 8);
        int shift = 32 - format.Bytes * 8;
        sample = (sample << shift) >> shift;
        return sample / (double)(1L << (format.Bytes * 8 - 1));
    }
    static int Fill(Stream stream, int position, int total)
    {
        return Fill(stream, position, total, Tone);
    }
    static int Fill(Stream stream, int position, int total, Func<double, double> signal)
    {
        uint padding;
        Hr(stream.Client.GetCurrentPadding(out padding));
        Check(padding <= stream.Frames, "AUDIO_BUFFER_INVALID");
        int count = Math.Min((int)(stream.Frames - padding), total - position);
        if (count <= 0)
            return position;
        var bytes = new byte[count * stream.Format.Align];
        for (int frame = 0; frame < count; frame++)
        {
            double value = signal((position + frame) / (double)stream.Format.Rate);
            for (int channel = 0; channel < stream.Format.Channels; channel++)
                Encode(bytes, frame * stream.Format.Align + channel * stream.Format.Bytes, value, stream.Format);
        }
        IntPtr buffer;
        Hr(stream.Render.GetBuffer((uint)count, out buffer));
        try
        {
            Marshal.Copy(bytes, 0, buffer, bytes.Length);
        }
        finally
        {
            Hr(stream.Render.ReleaseBuffer((uint)count, 0));
        }
        Array.Clear(bytes, 0, bytes.Length);
        return position + count;
    }
    sealed class Samples
    {
        public readonly List<double> Values = new List<double>();
        public long SilentFrames;
        public int Discontinuities;
    }
    static void Drain(Stream stream, Samples samples)
    {
        uint next;
        Hr(stream.Capture.GetNextPacketSize(out next));
        int packets = 0;
        while (next > 0)
        {
            Check(++packets <= 128, "AUDIO_CAPTURE_BACKLOG");
            IntPtr buffer;
            uint count, flags;
            ulong devicePosition, qpc;
            Hr(stream.Capture.GetBuffer(out buffer, out count, out flags, out devicePosition, out qpc));
            try
            {
                Check(count <= stream.Format.Rate * 2 && samples.Values.Count + count <= stream.Format.Rate * 6,
                      "AUDIO_CAPTURE_LIMIT");
                if ((flags & 1) != 0 && samples.Values.Count > 0)
                    samples.Discontinuities++;
                bool silent = (flags & 2) != 0;
                byte[] bytes = null;
                if (!silent)
                {
                    Check(buffer != IntPtr.Zero, "AUDIO_BUFFER_INVALID");
                    bytes = new byte[count * stream.Format.Align];
                    Marshal.Copy(buffer, bytes, 0, bytes.Length);
                }
                try
                {
                    for (int frame = 0; frame < count; frame++)
                    {
                        double sample = 0;
                        if (!silent)
                        {
                            // Use the first channel to avoid cancelling an inverted stereo pair.
                            sample = Decode(bytes, frame * stream.Format.Align, stream.Format);
                            for (int channel = 1; channel < stream.Format.Channels; channel++)
                                Decode(bytes, frame * stream.Format.Align + channel * stream.Format.Bytes,
                                       stream.Format);
                        }
                        samples.Values.Add(sample);
                    }
                    if (silent)
                        samples.SilentFrames += count;
                }
                finally
                {
                    if (bytes != null)
                        Array.Clear(bytes, 0, bytes.Length);
                }
            }
            finally
            {
                Hr(stream.Capture.ReleaseBuffer(count));
            }
            Hr(stream.Capture.GetNextPacketSize(out next));
        }
    }
    static double Rms(IList<double> data, int start, int count)
    {
        if (count == 0)
            return 0;
        double energy = 0;
        for (int i = 0; i < count; i++)
            energy += data[start + i] * data[start + i];
        return Math.Sqrt(energy / count);
    }
    static double Purity(IList<double> data, int start, int count, int rate, double frequency)
    {
        double real = 0, imaginary = 0, energy = 0;
        for (int i = 0; i < count; i++)
        {
            double value = data[start + i], angle = 2 * Math.PI * frequency * i / rate;
            real += value * Math.Cos(angle);
            imaginary += value * Math.Sin(angle);
            energy += value * value;
        }
        return energy < 1e-12 ? 0 : Math.Min(1, 2 * (real * real + imaginary * imaginary) / (count * energy));
    }
    static Dictionary<string, object> Analyze(IList<double> data, int rate, int baselineCount, int discontinuities)
    {
        int block = rate / 20, first = -1, second = -1, firstCount = 0, secondCount = 0;
        double peak = 0;
        for (int i = 0; i < data.Count; i++)
            peak = Math.Max(peak, Math.Abs(data[i]));
        for (int start = baselineCount; start + block <= data.Count; start += block)
        {
            double rms = Rms(data, start, block);
            if (rms < 0.002 || rms > 0.10)
                continue;
            if (Purity(data, start, block, rate, 997) > 0.85)
            {
                if (first < 0)
                    first = start;
                firstCount++;
            }
            if (Purity(data, start, block, rate, 1499) > 0.85)
            {
                if (second < 0)
                    second = start;
                secondCount++;
            }
        }
        double baseline = Rms(data, 0, baselineCount), duration = 1000.0 * data.Count / rate;
        bool passed = baselineCount >= rate / 10 && baseline < 0.001 && duration >= 2000 && duration <= 5500 &&
                      firstCount >= 6 && secondCount >= 6 && first >= 0 && second > first &&
                      (second - first) / (double)rate >= 0.60 && (second - first) / (double)rate <= 1.00 &&
                      peak < 0.25 && discontinuities == 0;
        return Result("passed", passed, "capturedMs", Math.Round(duration, 1), "baselineRms", Math.Round(baseline, 7),
                      "rms", Math.Round(Rms(data, 0, data.Count), 7), "peak", Math.Round(peak, 7), "tone997Windows",
                      firstCount, "tone1499Windows", secondCount, "discontinuities", discontinuities);
    }
    static object Probe(string renderId, string captureId)
    {
        using (var mutex = new Mutex(false, "Local\\WeChatAgent.AudioProbe.v1"))
        {
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
                Check(acquired, "AUDIO_PROBE_BUSY");
                return ProbeLocked(renderId, captureId);
            }
            finally
            {
                if (acquired)
                    mutex.ReleaseMutex();
            }
        }
    }
    static object PlayTest(string renderId)
    {
        using (var mutex = new Mutex(false, "Local\\WeChatAgent.AudioProbe.v1"))
        {
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
                Check(acquired, "AUDIO_PROBE_BUSY");
                return PlayTestLocked(renderId);
            }
            finally
            {
                if (acquired)
                    mutex.ReleaseMutex();
            }
        }
    }
    static object PlayTestLocked(string renderId)
    {
        var enumerator = (IMMDeviceEnumerator) new MMDeviceEnumerator();
        IMMDevice device = null;
        Stream output = null;
        Timer deadline = null;
        var clock = new Stopwatch();
        int playbackDone = 0;
        try
        {
            Endpoint endpoint = Select(Enumerate(enumerator), renderId, 0);
            Hr(enumerator.GetDevice(endpoint.Id, out device));
            Check(Eligible(Describe(device, 0)), "AUDIO_ENDPOINT_CHANGED");
            output = new Stream(device, true);
            Format format = output.Format;
            int total = format.Rate * 12 / 10, position = Fill(output, 0, total, PlayTone);
            clock.Start();
            // This process can queue at most 1.2 s of samples. The additional watchdog
            // closes a hung driver/session before the 2 s playback budget is exhausted.
            deadline = new Timer(delegate {
                if (Interlocked.Exchange(ref playbackDone, 1) == 0 && Interlocked.Exchange(ref Finished, 1) == 0)
                {
                    Emit(Result("ok", false, "mode", "play-test", "code", "AUDIO_PLAYBACK_TIMEOUT", "playbackComplete",
                                false, "elapsedMs", clock.ElapsedMilliseconds, "audioStarted", AudioStarted,
                                "captureOpened", false, "recordingSaved", false));
                    Environment.Exit(2);
                }
            }, null, 1800, Timeout.Infinite);
            output.Start();
            bool complete = false;
            while (clock.ElapsedMilliseconds < 1600)
            {
                position = Fill(output, position, total, PlayTone);
                uint padding;
                Hr(output.Client.GetCurrentPadding(out padding));
                if (position == total && padding == 0)
                {
                    complete = true;
                    break;
                }
                Thread.Sleep(5);
            }
            Check(complete, "AUDIO_PLAYBACK_INCOMPLETE");
            output.Stop();
            output.Dispose();
            output = null;
            clock.Stop();
            Interlocked.Exchange(ref playbackDone, 1);
            deadline.Dispose();
            deadline = null;
            return Result("ok", true, "mode", "play-test", "playbackComplete", true, "elapsedMs",
                          clock.ElapsedMilliseconds, "signalDurationMs", 1200, "amplitude", Amplitude, "frequencies",
                          new int[] { 997, 1499 }, "render", endpoint.Report(), "renderFormat", format.Report(),
                          "audioStarted", true, "captureOpened", false, "recordingSaved", false,
                          "systemSettingsChanged", false, "wechatVerified", false);
        }
        finally
        {
            // Keep the watchdog armed during cleanup: a Stop/Reset call may hang.
            if (output != null)
                output.Dispose();
            Interlocked.Exchange(ref playbackDone, 1);
            if (deadline != null)
                deadline.Dispose();
            Release(device);
            Release(enumerator);
        }
    }
    static object ProbeLocked(string renderId, string captureId)
    {
        var enumerator = (IMMDeviceEnumerator) new MMDeviceEnumerator();
        IMMDevice renderDevice = null, captureDevice = null;
        var samples = new Samples();
        try
        {
            var devices = Enumerate(enumerator);
            Endpoint render = Select(devices, renderId, 0), capture = Select(devices, captureId, 1);
            Check(render.Id != capture.Id, "AUDIO_ENDPOINT_INVALID");
            Hr(enumerator.GetDevice(render.Id, out renderDevice));
            Hr(enumerator.GetDevice(capture.Id, out captureDevice));
            Check(Eligible(Describe(renderDevice, 0)) && Eligible(Describe(captureDevice, 1)),
                  "AUDIO_ENDPOINT_CHANGED");
            using (var input = new Stream(captureDevice, false)) using (var output = new Stream(renderDevice, true))
            {
                input.Start();
                var clock = Stopwatch.StartNew();
                // A quiet baseline protects against mixing this diagnostic with existing routed audio.
                while (clock.ElapsedMilliseconds < 300)
                {
                    Drain(input, samples);
                    Thread.Sleep(5);
                }
                Drain(input, samples);
                int baseline = samples.Values.Count;
                Check(baseline >= input.Format.Rate / 10, "AUDIO_CAPTURE_NO_DATA");
                Check(Rms(samples.Values, 0, baseline) < 0.001, "AUDIO_CABLE_BUSY");
                int total = output.Format.Rate * 2, position = Fill(output, 0, total);
                output.Start();
                long started = clock.ElapsedMilliseconds;
                while (clock.ElapsedMilliseconds - started < 2600)
                {
                    position = Fill(output, position, total);
                    Drain(input, samples);
                    Thread.Sleep(5);
                }
                Drain(input, samples);
                output.Stop();
                input.Stop();
                Check(position == total, "AUDIO_RENDER_INCOMPLETE");
                var analysis = Analyze(samples.Values, input.Format.Rate, baseline, samples.Discontinuities);
                return Result(
                    "ok", true, "mode", "probe", "audioStarted", true, "recordingSaved", false, "systemSettingsChanged",
                    false, "render", render.Report(), "capture", capture.Report(), "renderFormat",
                    output.Format.Report(), "captureFormat", input.Format.Report(), "signal",
                    Result("durationMs", 2000, "amplitude", Amplitude, "frequencies", new int[] { 997, 1499 }),
                    "analysis", analysis, "routeVerified", (bool)analysis["passed"], "analyzedChannel", 1,
                    "wechatVerified", false);
            }
        }
        finally
        {
            for (int i = 0; i < samples.Values.Count; i++)
                samples.Values[i] = 0;
            samples.Values.Clear();
            Release(captureDevice);
            Release(renderDevice);
            Release(enumerator);
        }
    }
    static object SelfTest()
    {
        int checks = 0;
        Check(Marshal.SizeOf(typeof(PROPVARIANT)) == 24, "AUDIO_SELF_TEST_FAILED");
        checks++;
        var devices = new List<Endpoint> {
            new Endpoint { Id = "render-fixture", Name = RenderName, Adapter = AdapterName, Flow = 0 },
            new Endpoint { Id = "capture-fixture", Name = CaptureName, Adapter = AdapterName, Flow = 1 }
        };
        Check(Select(devices, "render-fixture", 0) == devices[0] && Select(devices, "capture-fixture", 1) == devices[1],
              "AUDIO_SELF_TEST_FAILED");
        checks++;
        Expect(delegate { Select(devices, "default", 0); }, "AUDIO_VIRTUAL_ENDPOINT_REQUIRED");
        checks++;
        devices.Add(new Endpoint { Id = "mic-fixture", Name = "Physical microphone", Flow = 1 });
        Expect(delegate { Select(devices, "mic-fixture", 1); }, "AUDIO_VIRTUAL_ENDPOINT_REQUIRED");
        checks++;
        devices.Add(new Endpoint { Id = "renamed-physical-fixture", Name = CaptureName, Adapter = "Physical hardware",
                                   Flow = 1 });
        Expect(delegate { Select(devices, "renamed-physical-fixture", 1); }, "AUDIO_VIRTUAL_ENDPOINT_REQUIRED");
        checks++;
        devices.Add(new Endpoint { Id = "duplicate-fixture", Name = RenderName, Adapter = AdapterName, Flow = 0 });
        Expect(delegate { Select(devices, "render-fixture", 0); }, "AUDIO_ENDPOINT_AMBIGUOUS");
        checks++;
        foreach (int width in new int[] { 2, 3, 4 })
        {
            var format = new Format { Channels = 2, Rate = 48000, Bytes = width, Align = width * 2, Floating = false };
            var data = new byte[8];
            foreach (double sample in new double[] { -1, -0.25, 0, 0.25, 0.999 })
            {
                Encode(data, 0, sample, format);
                Check(Math.Abs(Decode(data, 0, format) - sample) < 0.00004, "AUDIO_SELF_TEST_FAILED");
            }
            checks++;
        }
        var f = new Format { Channels = 1, Rate = 48000, Bytes = 4, Align = 4, Floating = true };
        var encoded = new byte[4];
        Encode(encoded, 0, 0.025, f);
        Check(Math.Abs(Decode(encoded, 0, f) - 0.025) < 1e-7, "AUDIO_SELF_TEST_FAILED");
        checks++;
        Expect(delegate { Encode(encoded, 0, Double.NaN, f); }, "AUDIO_SAMPLE_INVALID");
        checks++;
        Expect(delegate { ParseFormat(new byte[18]); }, "AUDIO_FORMAT_UNSUPPORTED");
        checks++;
        var wav = new byte[18];
        Buffer.BlockCopy(BitConverter.GetBytes((ushort)3), 0, wav, 0, 2);
        Buffer.BlockCopy(BitConverter.GetBytes((ushort)2), 0, wav, 2, 2);
        Buffer.BlockCopy(BitConverter.GetBytes(48000), 0, wav, 4, 4);
        Buffer.BlockCopy(BitConverter.GetBytes(384000), 0, wav, 8, 4);
        Buffer.BlockCopy(BitConverter.GetBytes((ushort)8), 0, wav, 12, 2);
        Buffer.BlockCopy(BitConverter.GetBytes((ushort)32), 0, wav, 14, 2);
        Check(ParseFormat(wav).Floating, "AUDIO_SELF_TEST_FAILED");
        checks++;
        var values = new List<double>();
        int rate = 48000, baseline = rate * 3 / 10;
        for (int i = 0; i < rate * 3; i++)
            values.Add(Tone(i / (double)rate - 0.35));
        Check((bool)Analyze(values, rate, baseline, 0)["passed"], "AUDIO_SELF_TEST_FAILED");
        checks++;
        Check(!(bool)Analyze(values, rate, baseline, 1)["passed"], "AUDIO_SELF_TEST_FAILED");
        checks++;
        for (int i = 0; i < values.Count; i++)
            values[i] = 0;
        Check(!(bool)Analyze(values, rate, baseline, 0)["passed"], "AUDIO_SELF_TEST_FAILED");
        checks++;
        for (int i = 0; i < values.Count; i++)
            values[i] = 0.025 * Math.Sin(2 * Math.PI * 997 * i / rate);
        Check(!(bool)Analyze(values, rate, baseline, 0)["passed"], "AUDIO_SELF_TEST_FAILED");
        checks++;
        int activeFirst = 0, activeSecond = 0;
        for (int i = 0; i < rate * 12 / 10; i++)
        {
            double seconds = i / (double)rate, sample = PlayTone(seconds);
            Check(Math.Abs(sample) <= Amplitude, "AUDIO_SELF_TEST_FAILED");
            if (seconds < 0.10 || seconds >= 0.35 && seconds < 0.65 || seconds >= 0.90)
                Check(sample == 0, "AUDIO_SELF_TEST_FAILED");
            if (sample != 0 && seconds < 0.35)
                activeFirst++;
            if (sample != 0 && seconds >= 0.65)
                activeSecond++;
        }
        Check(activeFirst > rate * 0.24 && activeSecond > rate * 0.24, "AUDIO_SELF_TEST_FAILED");
        checks++;
        Check(PlayTone(-1) == 0 && PlayTone(1.2) == 0 && PlayTone(2) == 0, "AUDIO_SELF_TEST_FAILED");
        checks++;
        Check(ParsePid("1") == 1 && ParsePid("2147483647") == 2147483647, "AUDIO_SELF_TEST_FAILED");
        checks++;
        foreach (string invalid in new string[] { "0", "-1", "+1", " 1", "1 ", "1.0", "001", "2147483648", "4294967295",
                                                  "1\n" })
            Expect(delegate { ParsePid(invalid); }, "AUDIO_PID_INVALID");
        checks++;
        var metadata = SessionReport(123, new List<object>(), 2, 0);
        Check((bool)metadata["metadataOnly"] && !(bool)metadata["captureOpened"] &&
                  !(bool)metadata["audioSamplesVerified"] && !(bool)metadata["absenceProvesNoCapture"] &&
                  (uint)metadata["targetPid"] == 123,
              "AUDIO_SELF_TEST_FAILED");
        checks++;
        checks += WaveSelfTest();
        return Result("ok", true, "selfTest", true, "checks", checks, "audioStarted", false, "devicesAccessed", false,
                      "recordingSaved", false);
    }
    static void Expect(Action action, string code)
    {
        try
        {
            action();
        }
        catch (Fault error)
        {
            if (error.Message == code)
                return;
        }
        throw new Fault("AUDIO_SELF_TEST_FAILED");
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROPERTYKEY
    {
        public Guid format;
        public uint id;
    }
    [StructLayout(LayoutKind.Explicit, Size = 24)]
    struct PROPVARIANT
    {
        [FieldOffset(0)]
        public ushort type;
        [FieldOffset(8)]
        public IntPtr pointer;
    }
    [DllImport("ole32.dll")]
    static extern int PropVariantClear(ref PROPVARIANT value);
    [ComImport, Guid("bcde0395-e52f-467c-8e3d-c4579291692e")]
    class MMDeviceEnumerator
    {
    }
    [ComImport, Guid("a95664d2-9614-4f35-a746-de8db63617e6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator
    {
        [PreserveSig]
        int EnumAudioEndpoints(int flow, uint mask, out IMMDeviceCollection devices);
        [PreserveSig]
        int GetDefaultAudioEndpoint(int flow, int role,
                                    out IMMDevice device); // Read-only identity reporting, never used to open audio.
        [PreserveSig]
        int GetDevice([MarshalAs(UnmanagedType.LPWStr)] string id, out IMMDevice device);
        [PreserveSig]
        int RegisterEndpointNotificationCallback(IntPtr client);
        [PreserveSig]
        int UnregisterEndpointNotificationCallback(IntPtr client);
    }
    [ComImport, Guid("0bd7a1be-7a1a-44db-8397-cc5392387b5e"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceCollection
    {
        [PreserveSig]
        int GetCount(out uint count);
        [PreserveSig]
        int Item(uint index, out IMMDevice device);
    }
    [ComImport, Guid("d666063f-1587-4e43-81f1-b948e807363f"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice
    {
        [PreserveSig]
        int Activate(ref Guid iid, uint context, IntPtr parameters,
                     [MarshalAs(UnmanagedType.IUnknown)] out object value);
        [PreserveSig]
        int OpenPropertyStore(uint access, out IPropertyStore properties);
        [PreserveSig]
        int GetId(out IntPtr id);
        [PreserveSig]
        int GetState(out uint state);
    }
    [ComImport, Guid("886d8eeb-8cf2-4446-8d02-cdba1dbdcf99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPropertyStore
    {
        [PreserveSig]
        int GetCount(out uint count);
        [PreserveSig]
        int GetAt(uint index, out PROPERTYKEY key);
        [PreserveSig]
        int GetValue(ref PROPERTYKEY key, out PROPVARIANT value);
        [PreserveSig]
        int SetValue(ref PROPERTYKEY key, ref PROPVARIANT value);
        [PreserveSig]
        int Commit();
    }
    [ComImport, Guid("1cb9ad4c-dbfa-4c32-b178-c2f568a703b2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioClient
    {
        [PreserveSig]
        int Initialize(int shareMode, uint flags, long duration, long periodicity, IntPtr format, IntPtr session);
        [PreserveSig]
        int GetBufferSize(out uint frames);
        [PreserveSig]
        int GetStreamLatency(out long latency);
        [PreserveSig]
        int GetCurrentPadding(out uint frames);
        [PreserveSig]
        int IsFormatSupported(int mode, IntPtr format, out IntPtr closest);
        [PreserveSig]
        int GetMixFormat(out IntPtr format);
        [PreserveSig]
        int GetDevicePeriod(out long normal, out long minimum);
        [PreserveSig]
        int Start();
        [PreserveSig]
        int Stop();
        [PreserveSig]
        int Reset();
        [PreserveSig]
        int SetEventHandle(IntPtr handle);
        [PreserveSig]
        int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object value);
    }
    [ComImport, Guid("f294acfc-3146-4483-a7bf-addca7c260e2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioRenderClient
    {
        [PreserveSig]
        int GetBuffer(uint frames, out IntPtr data);
        [PreserveSig]
        int ReleaseBuffer(uint frames, uint flags);
    }
    [ComImport, Guid("c8adbd64-e71e-48a0-a4de-185c395cd317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioCaptureClient
    {
        [PreserveSig]
        int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong position, out ulong qpc);
        [PreserveSig]
        int ReleaseBuffer(uint frames);
        [PreserveSig]
        int GetNextPacketSize(out uint frames);
    }
    [ComImport, Guid("77aa99a0-1bd6-484f-8bc7-2c654c9a9b6f"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionManager2
    {
        [PreserveSig]
        int GetAudioSessionControl(IntPtr sessionGuid, uint flags, out IAudioSessionControl control);
        [PreserveSig]
        int GetSimpleAudioVolume(IntPtr sessionGuid, uint flags, out IntPtr volume);
        [PreserveSig]
        int GetSessionEnumerator(out IAudioSessionEnumerator sessions);
        [PreserveSig]
        int RegisterSessionNotification(IntPtr callback);
        [PreserveSig]
        int UnregisterSessionNotification(IntPtr callback);
        [PreserveSig]
        int RegisterDuckNotification([MarshalAs(UnmanagedType.LPWStr)] string sessionId, IntPtr callback);
        [PreserveSig]
        int UnregisterDuckNotification(IntPtr callback);
    }
    [ComImport, Guid("e2f5bb11-0570-40ca-acdd-3aa01277dee8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionEnumerator
    {
        [PreserveSig]
        int GetCount(out int count);
        [PreserveSig]
        int GetSession(int index, out IAudioSessionControl session);
    }
    [ComImport, Guid("f4b1a599-7266-4319-a8ca-e70acb11e8cd"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionControl
    {
        [PreserveSig]
        int GetState(out int state);
        [PreserveSig]
        int GetDisplayName(out IntPtr name);
        [PreserveSig]
        int SetDisplayName(IntPtr name, IntPtr context);
        [PreserveSig]
        int GetIconPath(out IntPtr path);
        [PreserveSig]
        int SetIconPath(IntPtr path, IntPtr context);
        [PreserveSig]
        int GetGroupingParam(out Guid group);
        [PreserveSig]
        int SetGroupingParam(ref Guid group, IntPtr context);
        [PreserveSig]
        int RegisterAudioSessionNotification(IntPtr callback);
        [PreserveSig]
        int UnregisterAudioSessionNotification(IntPtr callback);
    }
    [ComImport, Guid("bfb7ff88-7239-4fc9-8fa2-07c950be9c6d"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionControl2
    {
        [PreserveSig]
        int GetState(out int state);
        [PreserveSig]
        int GetDisplayName(out IntPtr name);
        [PreserveSig]
        int SetDisplayName(IntPtr name, IntPtr context);
        [PreserveSig]
        int GetIconPath(out IntPtr path);
        [PreserveSig]
        int SetIconPath(IntPtr path, IntPtr context);
        [PreserveSig]
        int GetGroupingParam(out Guid group);
        [PreserveSig]
        int SetGroupingParam(ref Guid group, IntPtr context);
        [PreserveSig]
        int RegisterAudioSessionNotification(IntPtr callback);
        [PreserveSig]
        int UnregisterAudioSessionNotification(IntPtr callback);
        [PreserveSig]
        int GetSessionIdentifier(out IntPtr identifier);
        [PreserveSig]
        int GetSessionInstanceIdentifier(out IntPtr identifier);
        [PreserveSig]
        int GetProcessId(out uint pid);
        [PreserveSig]
        int IsSystemSoundsSession();
        [PreserveSig]
        int SetDuckingPreference([MarshalAs(UnmanagedType.Bool)] bool optOut);
    }
}
