// WAV playback extension for AudioRouteProbe. Only the selected VB-CABLE render
// endpoint is opened. No WeChat, microphone, default-device or volume operations.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Threading;

internal static partial class AudioRouteProbe
{
    const int MaxWaveBytes = 32 * 1024 * 1024;
    const int MaxWaveSeconds = 60;
    static readonly HashSet<int> WaveRates =
        new HashSet<int> { 8000, 11025, 16000, 22050, 24000, 32000, 44100, 48000, 88200, 96000 };
    sealed class Wave
    {
        public byte[] Data;
        public int Offset, Frames;
        public Format Format;
        public double DurationMs
        {
            get {
                return Frames * 1000.0 / Format.Rate;
            }
        }
        public double Sample(int frame, int channel)
        {
            return Decode(Data, Offset + frame * Format.Align + channel * Format.Bytes, Format);
        }
        public double Resample(int outputFrame, int outputRate, int channel, int outputChannels)
        {
            double position = outputFrame * (double)Format.Rate / outputRate;
            int left = Math.Min(Frames - 1, (int)position), right = Math.Min(Frames - 1, left + 1);
            double mix = position - left;
            if (Format.Channels == 2 && outputChannels == 1)
                return (Sample(left, 0) * (1 - mix) + Sample(right, 0) * mix + Sample(left, 1) * (1 - mix) +
                        Sample(right, 1) * mix) /
                       2;
            int sourceChannel = Format.Channels == 1 ? 0 : channel;
            return Sample(left, sourceChannel) * (1 - mix) + Sample(right, sourceChannel) * mix;
        }
        public int OutputFrames(int rate)
        {
            return (int)Math.Ceiling(Frames * (double)rate / Format.Rate);
        }
    }
    static bool Tag(byte[] bytes, int offset, string value)
    {
        if (offset < 0 || offset + 4 > bytes.Length)
            return false;
        for (int i = 0; i < 4; i++)
            if (bytes[offset + i] != (byte)value[i])
                return false;
        return true;
    }
    static Wave ParseWave(byte[] bytes)
    {
        Check(bytes != null && bytes.Length >= 44 && bytes.Length <= MaxWaveBytes && Tag(bytes, 0, "RIFF") &&
                  Tag(bytes, 8, "WAVE") && (ulong)BitConverter.ToUInt32(bytes, 4) + 8 == (ulong)bytes.Length,
              "AUDIO_WAV_INVALID");
        int offset = 12, dataOffset = -1, dataSize = 0;
        Format format = null;
        while (offset < bytes.Length)
        {
            Check(offset + 8 <= bytes.Length, "AUDIO_WAV_INVALID");
            uint size = BitConverter.ToUInt32(bytes, offset + 4);
            int begin = offset + 8;
            ulong end = (ulong)begin + size + (size & 1);
            Check(end <= (ulong)bytes.Length, "AUDIO_WAV_INVALID");
            if (Tag(bytes, offset, "fmt "))
            {
                Check(format == null && (size == 16 || size == 18), "AUDIO_WAV_INVALID");
                if (size == 18)
                    Check(BitConverter.ToUInt16(bytes, begin + 16) == 0, "AUDIO_WAV_INVALID");
                int tag = BitConverter.ToUInt16(bytes, begin), channels = BitConverter.ToUInt16(bytes, begin + 2),
                    rate = BitConverter.ToInt32(bytes, begin + 4), bits = BitConverter.ToUInt16(bytes, begin + 14);
                int align = BitConverter.ToUInt16(bytes, begin + 12), byteRate = BitConverter.ToInt32(bytes, begin + 8);
                Check((tag == 1 && bits == 16 || tag == 3 && bits == 32) && (channels == 1 || channels == 2) &&
                          WaveRates.Contains(rate) && align == channels * bits / 8 && byteRate == rate * align,
                      "AUDIO_WAV_FORMAT_UNSUPPORTED");
                format = new Format { Channels = channels, Rate = rate, Bytes = bits / 8, Align = align,
                                      Floating = tag == 3 };
            }
            else if (Tag(bytes, offset, "data"))
            {
                Check(dataOffset < 0 && size > 0, "AUDIO_WAV_INVALID");
                dataOffset = begin;
                dataSize = (int)size;
            }
            offset = (int)end;
        }
        Check(format != null && dataOffset >= 0 && dataSize % format.Align == 0, "AUDIO_WAV_INVALID");
        int frames = dataSize / format.Align;
        Check(frames > 0 && frames <= (long)format.Rate * MaxWaveSeconds, "AUDIO_WAV_DURATION_LIMIT");
        if (format.Floating)
            for (int i = dataOffset; i < dataOffset + dataSize; i += 4)
            {
                float value = BitConverter.ToSingle(bytes, i);
                Check(!Single.IsNaN(value) && !Single.IsInfinity(value) && Math.Abs(value) <= 1, "AUDIO_WAV_INVALID");
            }
        return new Wave { Data = bytes, Offset = dataOffset, Frames = frames, Format = format };
    }
    static Wave ReadWave(string file)
    {
        Check(!String.IsNullOrEmpty(file) && file.Length >= 3 && file.Length <= 4096 && Char.IsLetter(file[0]) &&
                  file[1] == ':' && (file[2] == '\\' || file[2] == '/') && Path.IsPathRooted(file),
              "AUDIO_WAV_PATH_INVALID");
        file = Path.GetFullPath(file);
        string current = file;
        while (!String.IsNullOrEmpty(current))
        {
            Check((File.GetAttributes(current) & FileAttributes.ReparsePoint) == 0, "AUDIO_WAV_PATH_INVALID");
            current = Path.GetDirectoryName(current);
        }
        using (var stream = new FileStream(file, FileMode.Open, FileAccess.Read, FileShare.Read))
        {
            Check(stream.Length >= 44 && stream.Length <= MaxWaveBytes, "AUDIO_WAV_INVALID");
            var bytes = new byte[(int)stream.Length];
            int position = 0;
            while (position < bytes.Length)
            {
                int count = stream.Read(bytes, position, bytes.Length - position);
                Check(count > 0, "AUDIO_WAV_INVALID");
                position += count;
            }
            try
            {
                return ParseWave(bytes);
            }
            catch
            {
                Array.Clear(bytes, 0, bytes.Length);
                throw;
            }
        }
    }
    sealed class PlaybackControl : IDisposable
    {
        readonly ManualResetEvent ready = new ManualResetEvent(false);
        int cancelled, started;
        public bool Cancelled
        {
            get {
                return Interlocked.CompareExchange(ref cancelled, 0, 0) != 0;
            }
        }
        public void Accept(string line)
        {
            if (line == "play" && Interlocked.CompareExchange(ref started, 1, 0) == 0 && !Cancelled)
                ready.Set();
            else
                Cancel();
        }
        public void Cancel()
        {
            Interlocked.Exchange(ref cancelled, 1);
            ready.Set();
        }
        public void AssertActive()
        {
            Check(!Cancelled, "AUDIO_PLAYBACK_CANCELLED");
        }
        public void WaitForStart()
        {
            Check(ready.WaitOne(3000), "AUDIO_CONTROL_REQUIRED");
            AssertActive();
        }
        public void Listen()
        {
            Check(Console.IsInputRedirected, "AUDIO_CONTROL_REQUIRED");
            var thread = new Thread(delegate() {
                try
                {
                    var line = new System.Text.StringBuilder();
                    int character;
                    while ((character = Console.In.Read()) != -1)
                    {
                        if (character == '\n')
                        {
                            Accept(line.ToString().TrimEnd('\r'));
                            line.Length = 0;
                            if (Cancelled)
                                return;
                        }
                        else
                        {
                            if (line.Length >= 16)
                            {
                                Cancel();
                                return;
                            }
                            line.Append((char)character);
                        }
                    }
                }
                catch
                { /* A broken parent pipe must stop playback. */
                }
                Cancel();
            });
            thread.IsBackground = true;
            thread.Start();
        }
        public void Dispose()
        {
            Cancel(); /* The background reader may still wait on the pipe until process exit. */
        }
    }
    static int FillWave(Stream stream, Wave wave, int position, int total, PlaybackControl control)
    {
        control.AssertActive();
        uint padding;
        Hr(stream.Client.GetCurrentPadding(out padding));
        Check(padding <= stream.Frames, "AUDIO_BUFFER_INVALID");
        int count = Math.Min((int)(stream.Frames - padding), total - position);
        if (count <= 0)
            return position;
        var bytes = new byte[count * stream.Format.Align];
        try
        {
            for (int frame = 0; frame < count; frame++)
                for (int channel = 0; channel < stream.Format.Channels; channel++)
                    Encode(bytes, frame * stream.Format.Align + channel * stream.Format.Bytes,
                           wave.Resample(position + frame, stream.Format.Rate, channel, stream.Format.Channels),
                           stream.Format);
            control.AssertActive();
            IntPtr buffer;
            Hr(stream.Render.GetBuffer((uint)count, out buffer));
            bool copied = false;
            try
            {
                control.AssertActive();
                Marshal.Copy(bytes, 0, buffer, bytes.Length);
                copied = true;
            }
            finally
            {
                Hr(stream.Render.ReleaseBuffer((uint)count, copied ? 0u : 2u));
            }
            return position + count;
        }
        finally
        {
            Array.Clear(bytes, 0, bytes.Length);
        }
    }
    static object PlayWave(string renderId, string file)
    {
        using (var control = new PlaybackControl())
        {
            control.Listen();
            Wave wave = null;
            try
            {
                wave = ReadWave(file);
                control.WaitForStart();
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
                        return PlayWaveLocked(renderId, wave, control);
                    }
                    finally
                    {
                        if (acquired)
                            mutex.ReleaseMutex();
                    }
                }
            }
            finally
            {
                if (wave != null)
                    Array.Clear(wave.Data, 0, wave.Data.Length);
            }
        }
    }
    static object PlayWaveLocked(string renderId, Wave wave, PlaybackControl control)
    {
        IMMDeviceEnumerator enumerator = null;
        IMMDevice device = null;
        Stream output = null;
        Timer deadline = null;
        int done = 0;
        var clock = new Stopwatch();
        try
        {
            control.AssertActive();
            enumerator = (IMMDeviceEnumerator) new MMDeviceEnumerator();
            Endpoint endpoint = Select(Enumerate(enumerator), renderId, 0);
            Hr(enumerator.GetDevice(endpoint.Id, out device));
            Check(Eligible(Describe(device, 0)), "AUDIO_ENDPOINT_CHANGED");
            control.AssertActive();
            output = new Stream(device, true);
            Format format = output.Format;
            Check(format.Channels <= 2, "AUDIO_FORMAT_UNSUPPORTED");
            int total = wave.OutputFrames(format.Rate), position = FillWave(output, wave, 0, total, control);
            clock.Start();
            int budget = (int)Math.Ceiling(wave.DurationMs) + 2000;
            deadline = new Timer(delegate {
                if (Interlocked.Exchange(ref done, 1) == 0 && Interlocked.Exchange(ref Finished, 1) == 0)
                {
                    Emit(Result("ok", false, "mode", "play-wav", "code", "AUDIO_PLAYBACK_TIMEOUT", "playbackComplete",
                                false, "audioStarted", AudioStarted, "elapsedMs", clock.ElapsedMilliseconds,
                                "recordingSaved", false));
                    Environment.Exit(2);
                }
            }, null, budget + 500, Timeout.Infinite);
            control.AssertActive();
            output.Start();
            bool complete = false;
            while (clock.ElapsedMilliseconds < budget)
            {
                control.AssertActive();
                position = FillWave(output, wave, position, total, control);
                uint padding;
                Hr(output.Client.GetCurrentPadding(out padding));
                if (position == total && padding == 0)
                {
                    complete = true;
                    break;
                }
                Thread.Sleep(5);
            }
            control.AssertActive();
            Check(complete, "AUDIO_PLAYBACK_INCOMPLETE");
            output.Stop();
            output.Dispose();
            output = null;
            clock.Stop();
            Interlocked.Exchange(ref done, 1);
            deadline.Dispose();
            deadline = null;
            return Result("ok", true, "mode", "play-wav", "playbackComplete", true, "elapsedMs",
                          clock.ElapsedMilliseconds, "durationMs", Math.Round(wave.DurationMs, 3), "sourceFormat",
                          wave.Format.Report(), "renderFormat", format.Report(), "outputFrames", total, "audioStarted",
                          true, "captureOpened", false, "recordingSaved", false, "systemSettingsChanged", false,
                          "wechatVerified", false);
        }
        finally
        {
            if (output != null)
                output.Dispose();
            Interlocked.Exchange(ref done, 1);
            if (deadline != null)
                deadline.Dispose();
            Release(device);
            Release(enumerator);
        }
    }
    static byte[] FixtureWave(int rate, int channels, bool floating, int frames)
    {
        int bytes = floating ? 4 : 2, align = channels * bytes;
        var result = new byte[44 + frames * align];
        foreach (var part in new[] { new object[] { 0, "RIFF" }, new object[] { 8, "WAVE" },
                                     new object[] { 12, "fmt " }, new object[] { 36, "data" } })
            Buffer.BlockCopy(System.Text.Encoding.ASCII.GetBytes((string)part[1]), 0, result, (int)part[0], 4);
        Buffer.BlockCopy(BitConverter.GetBytes(result.Length - 8), 0, result, 4, 4);
        Buffer.BlockCopy(BitConverter.GetBytes(16), 0, result, 16, 4);
        Buffer.BlockCopy(BitConverter.GetBytes((ushort)(floating ? 3 : 1)), 0, result, 20, 2);
        Buffer.BlockCopy(BitConverter.GetBytes((ushort)channels), 0, result, 22, 2);
        Buffer.BlockCopy(BitConverter.GetBytes(rate), 0, result, 24, 4);
        Buffer.BlockCopy(BitConverter.GetBytes(rate * align), 0, result, 28, 4);
        Buffer.BlockCopy(BitConverter.GetBytes((ushort)align), 0, result, 32, 2);
        Buffer.BlockCopy(BitConverter.GetBytes((ushort)(bytes * 8)), 0, result, 34, 2);
        Buffer.BlockCopy(BitConverter.GetBytes(frames * align), 0, result, 40, 4);
        return result;
    }
    static int WaveSelfTest()
    {
        int checks = 0;
        var bytes = FixtureWave(16000, 1, false, 1600);
        var wave = ParseWave(bytes);
        Check(wave.Frames == 1600 && wave.DurationMs == 100 && wave.OutputFrames(48000) == 4800,
              "AUDIO_SELF_TEST_FAILED");
        checks++;
        for (int i = 0; i < wave.Frames; i++)
            Encode(bytes, 44 + i * 2, 0.25 * Math.Sin(2 * Math.PI * 500 * i / 16000), wave.Format);
        for (int i = 0; i < 4700; i++)
            Check(Math.Abs(wave.Resample(i, 48000, 0, 2) - 0.25 * Math.Sin(2 * Math.PI * 500 * i / 48000)) < 0.002,
                  "AUDIO_SELF_TEST_FAILED");
        checks++;
        Check(wave.Resample(177, 48000, 0, 2) == wave.Resample(177, 48000, 1, 2), "AUDIO_SELF_TEST_FAILED");
        checks++;
        bytes = FixtureWave(48000, 2, true, 200);
        wave = ParseWave(bytes);
        for (int i = 0; i < 200; i++)
        {
            Encode(bytes, 44 + i * 8, 0.25, wave.Format);
            Encode(bytes, 48 + i * 8, -0.25, wave.Format);
        }
        Check(wave.Resample(12, 24000, 0, 1) == 0 && wave.Resample(12, 24000, 1, 2) == -0.25, "AUDIO_SELF_TEST_FAILED");
        checks++;
        Buffer.BlockCopy(BitConverter.GetBytes(Single.NaN), 0, bytes, 44, 4);
        Expect(delegate { ParseWave(bytes); }, "AUDIO_WAV_INVALID");
        checks++;
        bytes = FixtureWave(8000, 1, false, 8);
        bytes[4] = 0;
        Expect(delegate { ParseWave(bytes); }, "AUDIO_WAV_INVALID");
        checks++;
        bytes = FixtureWave(8000, 1, false, 8);
        bytes[40] = 255;
        Expect(delegate { ParseWave(bytes); }, "AUDIO_WAV_INVALID");
        checks++;
        bytes = FixtureWave(8000, 1, false, 8);
        bytes[34] = 24;
        Expect(delegate { ParseWave(bytes); }, "AUDIO_WAV_FORMAT_UNSUPPORTED");
        checks++;
        bytes = FixtureWave(8000, 1, false, 8000 * 60 + 1);
        Expect(delegate { ParseWave(bytes); }, "AUDIO_WAV_DURATION_LIMIT");
        checks++;
        using (var control = new PlaybackControl())
        {
            control.Accept("play");
            control.WaitForStart();
            control.Cancel();
            Expect(control.AssertActive, "AUDIO_PLAYBACK_CANCELLED");
        }
        checks++;
        using (var control = new PlaybackControl())
        {
            control.Cancel();
            control.Accept("play");
            Expect(control.WaitForStart, "AUDIO_PLAYBACK_CANCELLED");
        }
        checks++;
        using (var control = new PlaybackControl())
        {
            control.Accept("unexpected");
            Expect(control.WaitForStart, "AUDIO_PLAYBACK_CANCELLED");
        }
        checks++;
        return checks;
    }
}
