// Project-owned bounded render worker. All render COM calls and PCM ownership
// stay on its MTA thread; the UI guard thread only exchanges atomic commands.
using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Threading;

internal static partial class AudioRouteProbe
{
    // A successful request is paired once on the same worker on controlled exit.
    // Forced process termination cannot report successful restoration.
    // This requests timer precision; it does not guarantee a scheduling deadline.
    sealed class VoiceTimerPeriodLease : IDisposable
    {
        readonly Func<uint, uint> end;
        readonly int owner;
        bool disposed;
        internal bool Acquired, Restored;
        internal VoiceTimerPeriodLease(Func<uint, uint> begin, Func<uint, uint> finish)
        {
            owner = Thread.CurrentThread.ManagedThreadId;
            end = finish;
            Acquired = begin(1) == 0;
        }
        public void Dispose()
        {
            Check(Thread.CurrentThread.ManagedThreadId == owner, "AUDIO_TIMER_THREAD_OWNERSHIP");
            if (disposed)
                return;
            disposed = true;
            if (Acquired)
                Restored = end(1) == 0;
        }
    }
    interface IVoicePumpOutput : IDisposable
    {
        double DurationMs { get; }
        int Rate { get; }
        int TotalFrames { get; }
        uint Capacity { get; }
        uint Padding();
        void Write(int position, int frames);
        void Start();
        void Stop();
    }

    sealed class VoiceWasapiOutput : IVoicePumpOutput
    {
        IMMDeviceEnumerator enumerator;
        IMMDevice device;
        Stream output;
        byte[] pcm;
        readonly Func<bool> cancelled;
        readonly int owner;
        double duration;
        int total;
        bool disposed;
        void Active()
        {
            Check(!cancelled(), "AUDIO_PLAYBACK_CANCELLED");
        }
        void Owner()
        {
            Check(Thread.CurrentThread.ManagedThreadId == owner, "AUDIO_THREAD_OWNERSHIP");
        }
        public double DurationMs
        {
            get {
                return duration;
            }
        }
        public int Rate
        {
            get {
                return output.Format.Rate;
            }
        }
        public int TotalFrames
        {
            get {
                return total;
            }
        }
        public uint Capacity
        {
            get {
                return output.Frames;
            }
        }
        internal VoiceWasapiOutput(string renderId, string file, string sha256, Func<bool> isCancelled)
        {
            cancelled = isCancelled;
            owner = Thread.CurrentThread.ManagedThreadId;
            Wave wave = null;
            try
            {
                Active();
                wave = ReadWave(file);
                Check(wave.DurationMs > 0 && wave.DurationMs <= 8000, "AUDIO_WAV_DURATION_LIMIT");
                using (var hash = SHA256.Create()) Check(
                    BitConverter.ToString(hash.ComputeHash(wave.Data)).Replace("-", "").ToLowerInvariant() == sha256,
                    "AUDIO_WAV_HASH_MISMATCH");
                Active();
                enumerator = (IMMDeviceEnumerator) new MMDeviceEnumerator();
                Select(Enumerate(enumerator), renderId, 0);
                Hr(enumerator.GetDevice(renderId, out device));
                Check(Eligible(Describe(device, 0)), "AUDIO_ENDPOINT_CHANGED");
                Active();
                output = new Stream(device, true);
                Check(output.Format.Channels <= 2, "AUDIO_FORMAT_UNSUPPORTED");
                duration = wave.DurationMs;
                total = wave.OutputFrames(output.Format.Rate);
                // Prepare every sample before recording. The hot loop allocates no PCM buffers.
                pcm = new byte[checked(total * output.Format.Align)];
                for (int frame = 0; frame < total; frame++)
                {
                    if ((frame & 1023) == 0)
                        Active();
                    for (int channel = 0; channel < output.Format.Channels; channel++)
                        Encode(pcm, frame * output.Format.Align + channel * output.Format.Bytes,
                               wave.Resample(frame, output.Format.Rate, channel, output.Format.Channels),
                               output.Format);
                }
                Active();
            }
            catch
            {
                Dispose();
                throw;
            }
            finally
            {
                if (wave != null)
                    Array.Clear(wave.Data, 0, wave.Data.Length);
            }
        }
        public uint Padding()
        {
            Owner();
            uint padding;
            Hr(output.Client.GetCurrentPadding(out padding));
            Check(padding <= output.Frames, "AUDIO_BUFFER_INVALID");
            return padding;
        }
        public void Write(int position, int frames)
        {
            Owner();
            Active();
            IntPtr pointer;
            Hr(output.Render.GetBuffer((uint)frames, out pointer));
            bool copied = false;
            try
            {
                Active();
                Marshal.Copy(pcm, checked(position * output.Format.Align), pointer,
                             checked(frames * output.Format.Align));
                copied = true;
            }
            finally
            {
                Hr(output.Render.ReleaseBuffer((uint)frames, copied ? 0u : 2u));
            }
        }
        public void Start()
        {
            Owner();
            Active();
            output.Start();
        }
        public void Stop()
        {
            Owner();
            if (output != null)
            {
                output.Stop();
                Hr(output.Client.Reset());
            }
        }
        public void Dispose()
        {
            Owner();
            if (disposed)
                return;
            disposed = true;
            try
            {
                if (output != null)
                    output.Dispose();
            }
            finally
            {
                output = null;
                Release(device);
                Release(enumerator);
                device = null;
                enumerator = null;
                if (pcm != null)
                {
                    Array.Clear(pcm, 0, pcm.Length);
                    pcm = null;
                }
            }
        }
    }

    sealed class TimedVoiceAudioPump : IDisposable
    {
        readonly ManualResetEvent ready = new ManualResetEvent(false), startedSignal = new ManualResetEvent(false),
                                  finished = new ManualResetEvent(false);
        readonly Func<Func<bool>, IVoicePumpOutput> factory;
        readonly Func<VoiceTimerPeriodLease> timerFactory;
        readonly Thread thread;
        int cancelled, startRequested, started, completed, disposed, starvationCount, joined, outputStopped;
        int timerRequested, timerAcquired, timerRestored;
        Exception failure;
        double duration;
        long startedAt, drainedAt, stoppedAt, maxPumpGapTicks;
        static long Tick()
        {
            return unchecked((long)VoicePumpGetTickCount64());
        }
        bool Cancelled
        {
            get {
                return Interlocked.CompareExchange(ref cancelled, 0, 0) != 0;
            }
        }
        void Active()
        {
            Check(!Cancelled, "AUDIO_PLAYBACK_CANCELLED");
        }
        void ThrowFailure()
        {
            var error = Interlocked.CompareExchange(ref failure, null, null);
            if (error != null)
                throw error;
        }
        internal double DurationMs
        {
            get {
                return duration;
            }
        }
        internal long StartedAtMs
        {
            get {
                return Interlocked.Read(ref startedAt);
            }
        }
        internal long DrainedAtMs
        {
            get {
                return Interlocked.Read(ref drainedAt);
            }
        }
        internal bool CompletedSuccessfully
        {
            get {
                return Interlocked.CompareExchange(ref completed, 0, 0) != 0;
            }
        }
        internal TimedVoiceAudioPump(Func<Func<bool>, IVoicePumpOutput> createOutput,
                                     Func<VoiceTimerPeriodLease> createTimer)
        {
            factory = createOutput;
            timerFactory = createTimer;
            thread = new Thread(Run);
            thread.IsBackground = true;
            thread.SetApartmentState(ApartmentState.MTA);
            thread.Start();
            try
            {
                Check(ready.WaitOne(3000), "AUDIO_PRELOAD_TIMEOUT");
                ThrowFailure();
                Active();
            }
            catch
            {
                Cancel();
                StopAndJoin();
                DisposeSignals();
                throw;
            }
        }
        internal void Start()
        {
            Active();
            ThrowFailure();
            Check(Interlocked.CompareExchange(ref startRequested, 1, 0) == 0, "AUDIO_START_ALREADY_REQUESTED");
            Check(startedSignal.WaitOne(1000), "AUDIO_START_TIMEOUT");
            ThrowFailure();
            Active();
            Check(Interlocked.CompareExchange(ref started, 0, 0) != 0, "AUDIO_START_UNCONFIRMED");
        }
        internal bool Complete()
        {
            ThrowFailure();
            Active();
            return Interlocked.CompareExchange(ref completed, 0, 0) != 0;
        }
        // Called by low-level hooks: no COM, locks, handles, allocation or waiting.
        internal void Cancel()
        {
            Interlocked.Exchange(ref cancelled, 1);
        }
        internal void StopAndJoin()
        {
            if (Interlocked.CompareExchange(ref joined, 0, 0) != 0)
                return;
            if (!finished.WaitOne(0))
                Cancel();
            // Do not dispose a live render object from another thread. An unresponsive
            // driver ends this helper, leaving the parent's recording barrier unknown.
            if (!thread.Join(500))
            {
                Environment.Exit(125);
                throw new InvalidOperationException("AUDIO_THREAD_STOP_UNCONFIRMED");
            }
            Interlocked.Exchange(ref joined, 1);
        }
        void DisposeSignals()
        {
            if (Interlocked.Exchange(ref disposed, 1) == 0)
            {
                ready.Dispose();
                startedSignal.Dispose();
                finished.Dispose();
            }
        }
        public void Dispose()
        {
            StopAndJoin();
            DisposeSignals();
        }
        internal object Report()
        {
            return Result(
                "dedicatedThread", true, "pollIntervalMs", 5, "queuedAudioLimitMs", 20, "paddingStarvationCount",
                Interlocked.CompareExchange(ref starvationCount, 0, 0), "maxPumpGapMs",
                Math.Round(Interlocked.Read(ref maxPumpGapTicks) * 1000.0 / Stopwatch.Frequency, 3), "startToDrainMs",
                DrainedAtMs > 0 && StartedAtMs > 0 ? DrainedAtMs - StartedAtMs : 0, "drainToStopMs",
                Interlocked.Read(ref stoppedAt) > 0 && DrainedAtMs > 0 ? Interlocked.Read(ref stoppedAt) - DrainedAtMs
                                                                       : 0,
                "threadJoined", Interlocked.CompareExchange(ref joined, 0, 0) != 0, "outputStopped",
                Interlocked.CompareExchange(ref outputStopped, 0, 0) != 0, "timerPeriodMs", 1,
                "timerResolutionRequested", Interlocked.CompareExchange(ref timerRequested, 0, 0) != 0,
                "timerResolutionAcquired", Interlocked.CompareExchange(ref timerAcquired, 0, 0) != 0,
                "timerResolutionRestored", Interlocked.CompareExchange(ref timerRestored, 0, 0) != 0);
        }
        static int FillCount(int rate, uint capacity, uint padding, int remaining)
        {
            Check(padding <= capacity, "AUDIO_BUFFER_INVALID");
            int target = Math.Min((int)capacity, (int)Math.Floor(rate * 0.020));
            return Math.Max(0, Math.Min(target - (int)padding, remaining));
        }
        void Run()
        {
            IVoicePumpOutput output = null;
            VoiceTimerPeriodLease timer = null;
            bool drainComplete = false;
            int position = 0;
            try
            {
                Active();
                Interlocked.Exchange(ref timerRequested, 1);
                timer = timerFactory();
                if (timer.Acquired)
                    Interlocked.Exchange(ref timerAcquired, 1);
                Check(timer.Acquired, "AUDIO_TIMER_RESOLUTION_UNAVAILABLE");
                Active();
                output = factory(delegate { return Cancelled; });
                duration = output.DurationMs;
                Check(duration > 0 && duration <= 8000, "AUDIO_WAV_DURATION_LIMIT");
                Active();
                int prefill = FillCount(output.Rate, output.Capacity, output.Padding(), output.TotalFrames);
                if (prefill > 0)
                {
                    Active();
                    output.Write(0, prefill);
                    position = prefill;
                }
                ready.Set();
                while (Interlocked.CompareExchange(ref startRequested, 0, 0) == 0)
                {
                    Active();
                    Thread.Sleep(5);
                }
                Active();
                output.Start();
                Interlocked.Exchange(ref startedAt, Tick());
                Interlocked.Exchange(ref started, 1);
                startedSignal.Set();
                Active();
                long previous = Stopwatch.GetTimestamp();
                double budget = duration + 1500;
                for (;;)
                {
                    Active();
                    long tick = Stopwatch.GetTimestamp(), gap = tick - previous;
                    previous = tick;
                    if (gap > Interlocked.Read(ref maxPumpGapTicks))
                        Interlocked.Exchange(ref maxPumpGapTicks, gap);
                    Check(Tick() - StartedAtMs <= budget, "AUDIO_PLAYBACK_TIMEOUT");
                    uint padding = output.Padding();
                    if (position == output.TotalFrames && padding == 0)
                    {
                        Active();
                        Interlocked.Exchange(ref drainedAt, Tick());
                        drainComplete = true;
                        break;
                    }
                    if (padding == 0 && position < output.TotalFrames)
                        Interlocked.Increment(ref starvationCount);
                    int frames = FillCount(output.Rate, output.Capacity, padding, output.TotalFrames - position);
                    if (frames > 0)
                    {
                        Active();
                        output.Write(position, frames);
                        position += frames;
                    }
                    Active();
                    Thread.Sleep(5);
                }
            }
            catch (Exception error)
            {
                Interlocked.CompareExchange(ref failure, error, null);
            }
            finally
            {
                if (output != null)
                {
                    try
                    {
                        output.Stop();
                        Interlocked.Exchange(ref stoppedAt, Tick());
                        Interlocked.Exchange(ref outputStopped, 1);
                    }
                    catch (Exception error)
                    {
                        Interlocked.CompareExchange(ref failure, error, null);
                    }
                    try
                    {
                        output.Dispose();
                    }
                    catch (Exception error)
                    {
                        Interlocked.CompareExchange(ref failure, error, null);
                    }
                }
                if (timer != null)
                {
                    try
                    {
                        timer.Dispose();
                        if (timer.Restored)
                            Interlocked.Exchange(ref timerRestored, 1);
                        Check(!timer.Acquired || timer.Restored, "AUDIO_TIMER_RESTORE_FAILED");
                    }
                    catch (Exception error)
                    {
                        Interlocked.CompareExchange(ref failure, error, null);
                    }
                }
                if (drainComplete && !Cancelled && Interlocked.CompareExchange(ref failure, null, null) == null)
                    Interlocked.Exchange(ref completed, 1);
                ready.Set();
                startedSignal.Set();
                finished.Set();
            }
        }

        sealed class FixtureOutput : IVoicePumpOutput
        {
            internal int OwnerId, Starts, Writes, Stops, Disposals;
            internal bool LongRunning, FailWrite;
            uint queued;
            readonly Func<bool> cancelled;
            internal FixtureOutput(Func<bool> cancel)
            {
                cancelled = cancel;
                OwnerId = Thread.CurrentThread.ManagedThreadId;
                Check(Thread.CurrentThread.GetApartmentState() == ApartmentState.MTA, "AUDIO_FIXTURE_NOT_MTA");
            }
            void Owner()
            {
                Check(Thread.CurrentThread.ManagedThreadId == OwnerId, "AUDIO_FIXTURE_WRONG_THREAD");
            }
            public double DurationMs
            {
                get {
                    return LongRunning ? 8000 : 100;
                }
            }
            public int Rate
            {
                get {
                    return 48000;
                }
            }
            public int TotalFrames
            {
                get {
                    return LongRunning ? 384000 : 4800;
                }
            }
            public uint Capacity
            {
                get {
                    return 96000;
                }
            }
            public uint Padding()
            {
                Owner();
                if (Starts > 0)
                    queued = queued > 480 ? queued - 480 : 0;
                return queued;
            }
            public void Write(int position, int frames)
            {
                Owner();
                Check(!cancelled(), "AUDIO_PLAYBACK_CANCELLED");
                Check(queued + frames <= 960, "AUDIO_FIXTURE_QUEUE_LIMIT");
                Writes++;
                if (FailWrite && Writes > 1)
                    throw new Fault("AUDIO_FIXTURE_WRITE_FAILED");
                queued += (uint)frames;
            }
            public void Start()
            {
                Owner();
                Check(!cancelled(), "AUDIO_PLAYBACK_CANCELLED");
                Starts++;
            }
            public void Stop()
            {
                Owner();
                Stops++;
                queued = 0;
            }
            public void Dispose()
            {
                Owner();
                Disposals++;
            }
        }
        sealed class FixtureTimer
        {
            internal int Begins, Ends, OwnerId;
            internal bool BeginSucceeds = true, EndSucceeds = true;
            internal VoiceTimerPeriodLease Create()
            {
                return new VoiceTimerPeriodLease(
                    delegate(uint period) {
                        Check(period == 1, "AUDIO_FIXTURE_TIMER_PERIOD");
                        OwnerId = Thread.CurrentThread.ManagedThreadId;
                        Begins++;
                        return BeginSucceeds ? 0u : 97u;
                    },
                    delegate(uint period) {
                        Check(period == 1 && OwnerId == Thread.CurrentThread.ManagedThreadId,
                              "AUDIO_FIXTURE_TIMER_OWNER");
                        Ends++;
                        return EndSucceeds ? 0u : 97u;
                    });
            }
            internal void Paired()
            {
                Check(Begins == 1 && Ends == 1, "AUDIO_FIXTURE_TIMER_UNPAIRED");
            }
        }
        internal static int SyntheticTests()
        {
            int count = 0;
            Check(FillCount(48000, 96000, 0, 100000) == 960 && FillCount(48000, 96000, 960, 100000) == 0 &&
                      FillCount(48000, 96000, 480, 100000) == 480 && FillCount(48000, 96000, 0, 10) == 10,
                  "AUDIO_SMALL_QUEUE_TEST");
            count++;
            FixtureOutput fixture = null;
            int parent = Thread.CurrentThread.ManagedThreadId;
            var timer = new FixtureTimer();
            using (var pump = new TimedVoiceAudioPump(delegate(Func<bool> cancel) {
                       fixture = new FixtureOutput(cancel);
                       return fixture;
                   }, timer.Create))
            {
                pump.Start();
                Check(pump.finished.WaitOne(1500), "AUDIO_FIXTURE_PUMP_STALLED");
                Check(pump.Complete(), "AUDIO_FIXTURE_INCOMPLETE");
                pump.StopAndJoin();
                Check(fixture.OwnerId != parent && fixture.Starts == 1 && fixture.Stops == 1 &&
                          fixture.Disposals == 1 && pump.DrainedAtMs >= pump.StartedAtMs,
                      "AUDIO_FIXTURE_LIFECYCLE");
            }
            timer.Paired();
            count++;
            timer = new FixtureTimer();
            using (var pump = new TimedVoiceAudioPump(delegate(Func<bool> cancel) {
                       fixture = new FixtureOutput(cancel);
                       return fixture;
                   }, timer.Create))
            {
                pump.Cancel();
                Expect(pump.Start, "AUDIO_PLAYBACK_CANCELLED");
                pump.StopAndJoin();
                Check(fixture.Starts == 0 && fixture.Stops == 1 && fixture.Disposals == 1,
                      "AUDIO_FIXTURE_CANCEL_BEFORE_START");
            }
            timer.Paired();
            count++;
            timer = new FixtureTimer();
            using (var pump = new TimedVoiceAudioPump(delegate(Func<bool> cancel) {
                       fixture = new FixtureOutput(cancel) { LongRunning = true };
                       return fixture;
                   }, timer.Create))
            {
                pump.Start();
                pump.Cancel();
                pump.StopAndJoin();
                int writes = fixture.Writes;
                Thread.Sleep(10);
                Check(fixture.Starts == 1 && fixture.Stops == 1 && fixture.Disposals == 1 && fixture.Writes == writes,
                      "AUDIO_FIXTURE_CANCEL_JOIN");
                Expect(delegate { pump.Complete(); }, "AUDIO_PLAYBACK_CANCELLED");
            }
            timer.Paired();
            count++;
            timer = new FixtureTimer();
            Expect(delegate {
                new TimedVoiceAudioPump(
                    delegate(Func<bool> cancel) { throw new Fault("AUDIO_FIXTURE_PRELOAD_FAILED"); }, timer.Create);
            }, "AUDIO_FIXTURE_PRELOAD_FAILED");
            timer.Paired();
            count++;
            timer = new FixtureTimer();
            using (var pump = new TimedVoiceAudioPump(delegate(Func<bool> cancel) {
                       fixture = new FixtureOutput(cancel) { FailWrite = true };
                       return fixture;
                   }, timer.Create))
            {
                try
                {
                    pump.Start();
                }
                catch (Exception error)
                {
                    Check(error.Message == "AUDIO_FIXTURE_WRITE_FAILED", "AUDIO_FIXTURE_UNEXPECTED_ERROR");
                }
                Check(pump.finished.WaitOne(1000), "AUDIO_FIXTURE_PUMP_STALLED");
                pump.StopAndJoin();
                Expect(delegate { pump.Complete(); }, "AUDIO_FIXTURE_WRITE_FAILED");
                Check(fixture.Stops == 1 && fixture.Disposals == 1, "AUDIO_FIXTURE_FAILURE_CLEANUP");
            }
            timer.Paired();
            count++;
            timer = new FixtureTimer { BeginSucceeds = false };
            bool outputCreated = false;
            Expect(delegate {
                new TimedVoiceAudioPump(delegate(Func<bool> cancel) {
                    outputCreated = true;
                    return new FixtureOutput(cancel);
                }, timer.Create);
            }, "AUDIO_TIMER_RESOLUTION_UNAVAILABLE");
            Check(timer.Begins == 1 && timer.Ends == 0 && !outputCreated, "AUDIO_FIXTURE_TIMER_FAILURE");
            count++;
            timer = new FixtureTimer { EndSucceeds = false };
            using (var pump = new TimedVoiceAudioPump(delegate(Func<bool> cancel) { return new FixtureOutput(cancel); },
                                                      timer.Create))
            {
                try
                {
                    pump.Start();
                }
                catch (Exception error)
                {
                    Check(error.Message == "AUDIO_TIMER_RESTORE_FAILED", "AUDIO_FIXTURE_UNEXPECTED_ERROR");
                }
                Check(pump.finished.WaitOne(1000), "AUDIO_FIXTURE_PUMP_STALLED");
                pump.StopAndJoin();
                Expect(delegate { pump.Complete(); }, "AUDIO_TIMER_RESTORE_FAILED");
                Check(!pump.CompletedSuccessfully && pump.timerAcquired == 1 && pump.timerRestored == 0,
                      "AUDIO_FIXTURE_TIMER_RESTORE_EVIDENCE");
            }
            timer.Paired();
            count++;
            timer = new FixtureTimer();
            var lease = timer.Create();
            lease.Dispose();
            lease.Dispose();
            timer.Paired();
            count++;
            return count;
        }
    }
    [DllImport("kernel32.dll", EntryPoint = "GetTickCount64")]
    static extern ulong VoicePumpGetTickCount64();
    [DllImport("winmm.dll", EntryPoint = "timeBeginPeriod", ExactSpelling = true)]
    static extern uint VoiceTimeBeginPeriod(uint milliseconds);
    [DllImport("winmm.dll", EntryPoint = "timeEndPeriod", ExactSpelling = true)]
    static extern uint VoiceTimeEndPeriod(uint milliseconds);
}
