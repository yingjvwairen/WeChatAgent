using System.Threading;

internal sealed class RecordingAttempt
{
    long startedAt;
    internal long StartedAt
    {
        get {
            return Interlocked.Read(ref startedAt);
        }
    }
    internal long SubmittedAt { get; private set; }
    internal long EndedAt { get; private set; }
    internal bool Started { get; private set; }
    internal bool PossiblyActive
    {
        get {
            return Started && !Ended;
        }
    }
    internal bool SubmitAttempted { get; private set; }
    internal bool SubmitApplied { get; private set; }
    internal bool Ended { get; private set; }

    internal void Begin(long at)
    {
        if (Started)
            return;
        Interlocked.Exchange(ref startedAt, at);
        Started = true;
    }

    internal void BeginSubmit(long at)
    {
        if (SubmitAttempted)
            return;
        SubmittedAt = at;
        SubmitAttempted = true;
    }

    internal void ConfirmSubmitInput()
    {
        SubmitApplied = true;
    }

    internal void ObserveEnd(bool ended, long at)
    {
        if (!ended || Ended)
            return;
        EndedAt = at;
        Ended = true;
    }
}
