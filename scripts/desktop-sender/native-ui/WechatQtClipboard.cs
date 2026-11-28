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
using System.Xml;

internal static partial class WechatDraftProbe
{
    sealed class QtClipboardOperation
    {
        internal bool? Restored { get; private set; }
        internal bool Replaced { get; private set; }
        internal object Restoration { get; private set; }
        internal string Stage { get; private set; }
        internal QtFrame Frame { get; private set; }
        internal void ObserveRestore(bool? value)
        {
            Restored = value;
        }
        internal void ObserveReplacement()
        {
            Replaced = true;
        }
        internal void RecordRestoration(object value)
        {
            Restoration = value;
        }
        internal void At(string stage)
        {
            Stage = stage;
        }
        internal void Bind(QtFrame frame)
        {
            Frame = frame;
        }
        internal object PopupMismatch(Exception error)
        {
            var observed = error.Data["QtPopupBindingMismatch"] as Dictionary<string, object>;
            if (observed == null)
                return null;
            var report = new Dictionary<string, object>(observed);
            report["pasteStage"] = Stage ?? "none";
            if (Object.Equals(error.Data["QtPopupUsePasteFrame"], true) && Frame != null &&
                Frame.PopupBounds.HasValue && Frame.PopupClient.HasValue)
            {
                report.Add("frameWindowRectInRoot", Frame.PopupBounds.Value.Report());
                report.Add("frameClientRect", Frame.PopupClient.Value.Report());
            }
            return report;
        }
    }

    static string QtFormatName(uint format)
    {
        if (format < 0xc000)
            return null;
        var name = new StringBuilder(129);
        return GetClipboardFormatName(format, name, name.Capacity) > 0 ? name.ToString() : null;
    }
    static object QtClipboardFormats(IntPtr owner)
    {
        Need(OpenClipboard(owner), "DRAFT_CLIPBOARD_BUSY");
        try
        {
            int total = CountClipboardFormats();
            uint format = 0;
            var entries = new List<object>();
            while ((format = EnumClipboardFormats(format)) != 0 && entries.Count < 32)
            {
                string name = QtFormatName(format);
                entries.Add(Data("id", format, "registeredName", name, "backupSupported",
                                 ClipboardFormats.CanBackUp(format, name)));
            }
            return Data("formats", entries, "total", total, "truncated", total > entries.Count, "payloadIncluded",
                        false, "clipboardModified", false, "inputSent", false);
        }
        finally
        {
            CloseClipboard();
        }
    }
    static bool QtOriginalClipboardBlocked(string code, bool restoring, bool attempted)
    {
        if (restoring || attempted)
            return false;
        return code == "DRAFT_CLIPBOARD_COMPLEX_FORMAT" || code == "DRAFT_CLIPBOARD_DATA_TOO_LARGE" ||
               code == "DRAFT_CLIPBOARD_DATA_UNAVAILABLE" || code == "DRAFT_CLIPBOARD_FORMAT_INVALID";
    }
    static bool QtAllowClipboardReplacement(Dictionary<string, object> request)
    {
        if (!request.ContainsKey("allowClipboardReplacement"))
            return false;
        string action = Text(request, "action");
        Need((action == "paste" || action == "pasteImage" || action == "pasteFile" || action == "pasteUiaImage" ||
              action == "pasteUiaFile") &&
                 Get(request, "allowClipboardReplacement") is bool,
             "QT_PASTE_POLICY_INVALID");
        return (bool)Get(request, "allowClipboardReplacement");
    }
    const int QtMaxClipboardBackupFormats = 32;
    sealed class QtClipboardBackupTrace
    {
        internal string Stage = "open", Phase = "original", Failure;
        internal int Total = -1;
        internal uint Before, After;
        internal bool OwnerStable, Complete;
        internal readonly List<object> Formats = new List<object>();
        internal Dictionary<string, object> Format(uint id, string name, bool bitmapCompanion)
        {
            var row = Data("id", id, "registeredName", name, "backupSupported",
                           ClipboardFormats.CanBackUp(id, name) || bitmapCompanion, "storage",
                           bitmapCompanion                        ? "synthesized-bitmap"
                           : ClipboardFormats.CanBackUp(id, name) ? "hglobal"
                                                                  : "unsupported",
                           "byteLength", null, "state", bitmapCompanion ? "companion" : "offered", "error", null);
            if (Formats.Count < 64)
                Formats.Add(row);
            return row;
        }
        internal object Report()
        {
            return Data("version", 1, "phase", Phase, "stage", Stage, "failure", Failure, "total", Total, "truncated",
                        Total > Formats.Count, "sequenceBefore", Before, "sequenceAfter", After, "ownerStable",
                        OwnerStable, "complete", Complete, "formats", Formats, "payloadIncluded", false,
                        "clipboardModified", false);
        }
    }
    static byte[] QtClipboardBackupBytes(uint format, int maximum, Dictionary<string, object> row)
    {
        row["state"] = "read";
        IntPtr handle = GetClipboardData(format);
        Need(handle != IntPtr.Zero, "DRAFT_CLIPBOARD_DATA_UNAVAILABLE");
        ulong size = GlobalSize(handle).ToUInt64();
        row["byteLength"] = size;
        Need(size > 0 && size <= (ulong)maximum, "DRAFT_CLIPBOARD_DATA_TOO_LARGE");
        IntPtr memory = GlobalLock(handle);
        Need(memory != IntPtr.Zero, "DRAFT_CLIPBOARD_DATA_UNAVAILABLE");
        var bytes = new byte[(int)size];
        try
        {
            Marshal.Copy(memory, bytes, 0, bytes.Length);
        }
        finally
        {
            GlobalUnlock(handle);
        }
        row["state"] = "copied";
        return bytes;
    }
    static object QtInspectClipboardBackup(IntPtr owner)
    {
        var trace = new QtClipboardBackupTrace();
        try
        {
            var original = QtReadOriginalClipboard(owner, false, false, trace);
            int bytes = 0;
            foreach (var format in original.Formats)
            {
                bytes += format.Bytes.Length;
                Array.Clear(format.Bytes, 0, format.Bytes.Length);
            }
            return Data("version", 1, "readOnly", true, "inputSent", false, "clipboardModified", false,
                        "backupComplete", trace.Complete, "byteLength", bytes, "clipboardBackup", trace.Report());
        }
        catch (Fault error)
        {
            return Data("version", 1, "readOnly", true, "inputSent", false, "clipboardModified", false,
                        "backupComplete", false, "code", error.Message, "clipboardBackup", trace.Report());
        }
    }
    static uint QtNextClipboardFormat(uint previous)
    {
        FocusClearLastError(0);
        uint next = EnumClipboardFormats(previous);
        if (next == 0)
            Need(Marshal.GetLastWin32Error() == 0, "DRAFT_CLIPBOARD_CHANGED");
        return next;
    }
    static int QtClipboardFormatCount()
    {
        FocusClearLastError(0);
        int count = CountClipboardFormats();
        if (count == 0)
        {
            // Win32 uses zero both for an empty clipboard and for a failed
            // count. A locked enumeration must independently reach its end.
            Need(Marshal.GetLastWin32Error() == 0 && QtNextClipboardFormat(0) == 0, "DRAFT_CLIPBOARD_CHANGED");
        }
        return count;
    }
    static ClipboardState QtOriginalClipboardBaseline(int count, uint sequence, IntPtr window, uint pid,
                                                      bool allowReplacement)
    {
        var state = new ClipboardState { Sequence = sequence, OwnerWindow = window, OwnerPid = pid };
        // An empty clipboard is fully representable, regardless of whether its
        // last owner still has a window. Never treat zero formats as a refusal.
        if (count > QtMaxClipboardBackupFormats && allowReplacement)
            state.ReplaceOnPaste = true;
        return state;
    }
    static void QtSelectBackupFormat(ClipboardState original, List<uint> formats, uint id, string name, bool canReplace)
    {
        if (formats.Count < QtMaxClipboardBackupFormats && ClipboardFormats.CanBackUp(id, name))
        {
            formats.Add(id);
            return;
        }
        Need(canReplace, "DRAFT_CLIPBOARD_COMPLEX_FORMAT");
        original.ReplaceOnPaste = true;
    }
    static bool QtIsImageClipboard(List<uint> formats, Dictionary<uint, Dictionary<string, object>> descriptions)
    {
        bool hasImage = false;
        foreach (uint id in formats)
        {
            string name = Text(descriptions[id], "registeredName");
            if (ClipboardFormats.IsImageFormat(id, name))
                hasImage = true;
            else if (!ClipboardFormats.IsClipboardPolicyFormat(id, name) && !ClipboardFormats.IsOleCompanion(id, name))
                return false;
        }
        return hasImage;
    }
    static List<uint> QtSelectClipboardBackupFormats(ClipboardState original, List<uint> formats,
                                                     Dictionary<uint, Dictionary<string, object>> descriptions,
                                                     bool restoring, bool canReplace)
    {
        // For an image-only clipboard, the raster formats can be published again
        // without recreating the source application's OLE object. Keep every
        // raster representation and clipboard policy flag in the backup.
        bool restoreImage = !restoring && QtIsImageClipboard(formats, descriptions);
        var selected = new List<uint>();
        foreach (uint id in formats)
        {
            var row = descriptions[id];
            string name = Text(row, "registeredName");
            if (restoreImage && ClipboardFormats.IsOleCompanion(id, name))
            {
                original.OmittedOleImageCompanions = true;
                row["state"] = "companion";
                continue;
            }
            try
            {
                QtSelectBackupFormat(original, selected, id, name, canReplace);
                if (!selected.Contains(id))
                    row["state"] = "omitted";
            }
            catch (Fault error)
            {
                row["state"] = "unsupported";
                row["error"] = error.Message;
                throw;
            }
        }
        return selected;
    }
    static ClipboardState QtReadOriginalClipboard(IntPtr owner, bool restoring = false, bool allowReplacement = false,
                                                  QtClipboardBackupTrace trace = null)
    {
        trace = trace ?? new QtClipboardBackupTrace();
        trace.Phase = restoring ? "restore" : "original";
        bool opened = false;
        try
        {
            Need(OpenClipboard(owner), "DRAFT_CLIPBOARD_BUSY");
            opened = true;
            bool canReplace = allowReplacement && !restoring && !InputAttempted;
            trace.Stage = "enumerate";
            int count = QtClipboardFormatCount();
            trace.Total = count;
            trace.Before = GetClipboardSequenceNumber();
            var result =
                QtOriginalClipboardBaseline(count, trace.Before, GetClipboardOwner(), ClipboardOwnerPid(), canReplace);
            if (count == 0)
            {
                trace.After = result.Sequence;
                trace.OwnerStable = true;
                trace.Complete = true;
                trace.Stage = "complete";
                return result;
            }
            // Inspect the offered types before requesting delayed data. Some image
            // editors offer a perfectly usable PNG/DIB alongside a private OLE handle.
            var formats = new List<uint>();
            var descriptions = new Dictionary<uint, Dictionary<string, object>>();
            uint format = 0;
            int seen = 0;
            while ((format = QtNextClipboardFormat(format)) != 0)
            {
                Need(++seen <= count && seen <= 512, "DRAFT_CLIPBOARD_CHANGED");
                string name = QtFormatName(format);
                bool bitmapCompanion = format == 2 && (IsClipboardFormatAvailable(8) || IsClipboardFormatAvailable(17));
                descriptions.Add(format, trace.Format(format, name, bitmapCompanion));
                // CF_BITMAP is a GDI handle, not GlobalAlloc memory. Its lossless
                // DIB companion is backed up; Windows regenerates the bitmap.
                if (bitmapCompanion)
                    continue;
                formats.Add(format);
            }
            Need(seen == count, "DRAFT_CLIPBOARD_CHANGED");
            Need(count > 0 && (count <= QtMaxClipboardBackupFormats || canReplace), "DRAFT_CLIPBOARD_COMPLEX_FORMAT");
            var selected = QtSelectClipboardBackupFormats(result, formats, descriptions, restoring, canReplace);
            trace.Stage = "read";
            int remaining = 64 * 1024 * 1024;
            foreach (uint id in selected)
            {
                var row = descriptions[id];
                try
                {
                    byte[] bytes = QtClipboardBackupBytes(id, Math.Min(remaining, 32 * 1024 * 1024), row);
                    Need(id != 16 || bytes.Length == 4, "DRAFT_CLIPBOARD_FORMAT_INVALID");
                    result.Formats.Add(new ClipFormat { Id = id, Bytes = bytes });
                    remaining -= bytes.Length;
                }
                catch (Fault error)
                {
                    row["state"] = "unavailable";
                    row["error"] = error.Message;
                    if (!canReplace || !QtOriginalClipboardBlocked(error.Message, false, false))
                        throw;
                    result.ReplaceOnPaste = true;
                }
            }
            trace.Stage = "verify";
            trace.OwnerStable = result.OwnerWindow == GetClipboardOwner() && result.OwnerPid == ClipboardOwnerPid();
            trace.After = GetClipboardSequenceNumber();
            Need(trace.OwnerStable && QtClipboardFormatCount() == count, "DRAFT_CLIPBOARD_CHANGED");
            // Resolving a synthesized format may update the sequence while this
            // process still holds the clipboard lock; no other writer can enter.
            result.Sequence = GetClipboardSequenceNumber();
            trace.After = result.Sequence;
            trace.Complete = !result.ReplaceOnPaste && !result.OmittedOleImageCompanions;
            trace.Stage = "complete";
            return result;
        }
        catch (Fault error)
        {
            trace.Failure = error.Message;
            error.Data["QtClipboardBackup"] = trace.Report();
            if (QtOriginalClipboardBlocked(error.Message, restoring, InputAttempted))
            {
                error.Data["QtOriginalClipboardBlocked"] = true;
            }
            throw;
        }
        finally
        {
            if (opened)
                CloseClipboard();
        }
    }
    static bool QtOriginalClipboardMatches(ClipboardState state, uint sequence, IntPtr window, uint pid)
    {
        return state.Sequence == sequence && state.OwnerWindow == window && state.OwnerPid == pid;
    }
    static bool QtOriginalClipboardStillCurrent(ClipboardState state)
    {
        return QtOriginalClipboardMatches(state, GetClipboardSequenceNumber(), GetClipboardOwner(),
                                          ClipboardOwnerPid());
    }
    static void QtClearOwnedForRestore(uint expected, uint expectedOwner, uint current, uint currentOwner,
                                       Func<bool> empty)
    {
        Need(current == expected && currentOwner == expectedOwner, "DRAFT_CLIPBOARD_CHANGED");
        Need(empty(), "DRAFT_CLIPBOARD_RESTORE_FAILED");
    }
    static List<IntPtr> QtAllocateClipboardBackup(ClipboardState original)
    {
        var handles = new List<IntPtr>();
        try
        {
            foreach (var format in original.Formats)
            {
                IntPtr handle = GlobalAlloc(0x42, new UIntPtr((uint)format.Bytes.Length));
                Need(handle != IntPtr.Zero, "DRAFT_CLIPBOARD_RESTORE_FAILED");
                handles.Add(handle);
                IntPtr memory = GlobalLock(handle);
                Need(memory != IntPtr.Zero, "DRAFT_CLIPBOARD_RESTORE_FAILED");
                try
                {
                    Marshal.Copy(format.Bytes, 0, memory, format.Bytes.Length);
                }
                finally
                {
                    GlobalUnlock(handle);
                }
            }
            return handles;
        }
        catch
        {
            foreach (IntPtr handle in handles)
                if (handle != IntPtr.Zero)
                    GlobalFree(handle);
            throw;
        }
    }
    static void QtPublishClipboardBackup(ClipboardState original, List<IntPtr> handles,
                                         Func<uint, IntPtr, IntPtr> publish)
    {
        Need(handles.Count == original.Formats.Count, "DRAFT_CLIPBOARD_RESTORE_FAILED");
        for (int index = 0; index < handles.Count; index++)
        {
            Need(publish(original.Formats[index].Id, handles[index]) != IntPtr.Zero, "DRAFT_CLIPBOARD_RESTORE_FAILED");
            handles[index] = IntPtr.Zero;
        }
    }
    static object QtRestorationReport(ClipboardState original, ClipboardState restored)
    {
        var formats = new List<object>();
        int bytes = 0, restoredBytes = 0;
        bool order = original.Formats.Count == restored.Formats.Count;
        bool exact = order;
        foreach (var item in restored.Formats)
            restoredBytes += item.Bytes.Length;
        for (int index = 0; index < original.Formats.Count; index++)
        {
            var item = original.Formats[index];
            bytes += item.Bytes.Length;
            var other = restored.Formats.Find(delegate(ClipFormat value) { return value.Id == item.Id; });
            bool same = item.Matches(other);
            exact &= same;
            if (index >= restored.Formats.Count || restored.Formats[index].Id != item.Id)
                order = false;
            formats.Add(Data("id", item.Id, "byteLength", item.Bytes.Length, "restoredByteLength",
                             other == null ? (object)null : other.Bytes.Length, "exactMatched", same));
        }
        return Data("version", 1, "lossless",
                    !original.ReplaceOnPaste && !original.OmittedOleImageCompanions && exact && order, "formatCount",
                    original.Formats.Count, "byteLength", bytes, "restoredFormatCount", restored.Formats.Count,
                    "restoredByteLength", restoredBytes, "exactPayloadMatched", exact, "formatOrderMatched", order,
                    "formats", formats);
    }
    static bool QtRestoreOriginalClipboard(QtClipboardOperation clipboard, IntPtr owner, ClipboardState original,
                                           uint sequence, uint expectedOwner)
    {
        var handles = QtAllocateClipboardBackup(original);
        try
        {
            // Clipboard listeners can hold a short read lock immediately after
            // the paste. Retry only that lock, never repeat the actual input.
            long deadline = Now() + 350;
            while (!OpenClipboard(owner))
            {
                Need(GetClipboardSequenceNumber() == sequence && ClipboardOwnerPid() == expectedOwner,
                     "DRAFT_CLIPBOARD_CHANGED");
                Need(Now() < deadline, "DRAFT_CLIPBOARD_BUSY");
                Thread.Sleep(5);
            }
            try
            {
                // Physical movement may stop keyboard actions, but restoring the
                // still-owned exact copy is safe. A newer clipboard is never touched.
                QtClearOwnedForRestore(sequence, expectedOwner, GetClipboardSequenceNumber(), ClipboardOwnerPid(),
                                       EmptyClipboard);
                if (original.Formats.Count == 0)
                {
                    bool empty = QtClipboardFormatCount() == 0;
                    if (empty)
                        clipboard.RecordRestoration(QtRestorationReport(original, new ClipboardState()));
                    return empty;
                }
                QtPublishClipboardBackup(original, handles, SetClipboardData);
                // All captured handles have been accepted while still locked.
                // Windows can synthesize additional types from a partial image.
                if (original.ReplaceOnPaste)
                    return GetClipboardOwner() == owner;
            }
            finally
            {
                CloseClipboard();
            }
            ClipboardState restored = QtReadOriginalClipboard(owner, true);
            clipboard.RecordRestoration(QtRestorationReport(original, restored));
            return restored.OwnerPid == GetCurrentProcessId() && original.HasSamePayload(restored);
        }
        finally
        {
            foreach (IntPtr handle in handles)
                if (handle != IntPtr.Zero)
                    GlobalFree(handle);
        }
    }
    static bool QtKeepPublishedPaste(ClipboardState original, bool search)
    {
        return original.ReplaceOnPaste && original.Formats.Count == 0 && !search;
    }
    static bool QtFinishPasteClipboard(QtClipboardOperation clipboard, IntPtr owner, ClipboardState original,
                                       bool changed, bool published, uint sequence, uint ownerPid, bool search = false)
    {
        if (changed && original.ReplaceOnPaste)
        {
            clipboard.ObserveRestore(false);
            // Restore usable representations even on an interrupted paste. If
            // none exist, remove our transient search text before the body can
            // take a new snapshot. A later user copy wins via the sequence guard.
            if (!QtKeepPublishedPaste(original, search))
            {
                Need(QtRestoreOriginalClipboard(clipboard, owner, original, sequence, ownerPid),
                     "DRAFT_CLIPBOARD_RESTORE_UNCONFIRMED");
            }
            else
            {
                Need(GetClipboardSequenceNumber() == sequence && ClipboardOwnerPid() == ownerPid,
                     "DRAFT_CLIPBOARD_CHANGED");
            }
            Need(published, "DRAFT_CLIPBOARD_PUBLICATION_UNCONFIRMED");
            clipboard.ObserveReplacement();
            return false;
        }
        bool restored = changed ? QtRestoreOriginalClipboard(clipboard, owner, original, sequence, ownerPid)
                                : QtOriginalClipboardStillCurrent(original);
        clipboard.ObserveRestore(restored);
        Need(restored, "DRAFT_CLIPBOARD_RESTORE_UNCONFIRMED");
        return true;
    }
}
