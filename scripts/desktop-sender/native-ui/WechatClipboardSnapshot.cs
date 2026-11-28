using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal sealed class ClipFormat
{
    internal uint Id;
    internal byte[] Bytes;
    internal bool Matches(ClipFormat other)
    {
        if (other == null || Id != other.Id || Bytes.Length != other.Bytes.Length)
            return false;
        for (int i = 0; i < Bytes.Length; i++)
            if (Bytes[i] != other.Bytes[i])
                return false;
        return true;
    }
}
internal sealed class ClipboardState
{
    internal uint Sequence, OwnerPid;
    internal IntPtr OwnerWindow;
    internal bool ProjectionOnly, ReplaceOnPaste;
    internal bool OmittedOleImageCompanions = false;
    internal readonly List<ClipFormat> Formats = new List<ClipFormat>();
    internal bool HasSamePayload(ClipboardState other)
    {
        if (Formats.Count != other.Formats.Count)
            return false;
        foreach (var item in Formats)
        {
            var candidate = other.Formats.Find(delegate(ClipFormat value) { return value.Id == item.Id; });
            if (!item.Matches(candidate))
                return false;
        }
        return true;
    }
}

internal static partial class WechatDraftProbe
{
    sealed class FormatTag
    {
        internal uint Id;
        internal string Name;
    }
    static uint ClipboardOwnerPid()
    {
        IntPtr owner = GetClipboardOwner();
        uint pid = 0;
        if (owner != IntPtr.Zero)
            GetWindowThreadProcessId(owner, out pid);
        return pid;
    }
    static object FormatDescription(uint id, string name)
    {
        return Data("id", id, "registeredName",
                    id >= 0xc000 && name != null ? (name.Length <= 128 ? name : name.Substring(0, 128)) : null);
    }
    static object CopyFormats(int total)
    {
        // Called only while the copy clipboard is locked; reads names, never payloads.
        var entries = new List<object>();
        uint format = 0;
        while (entries.Count < 16 && (format = EnumClipboardFormats(format)) != 0)
        {
            string name = null;
            if (format >= 0xc000)
            {
                var buffer = new StringBuilder(129);
                if (GetClipboardFormatName(format, buffer, buffer.Capacity) > 0)
                    name = buffer.ToString();
            }
            entries.Add(FormatDescription(format, name));
        }
        return Data("entries", entries, "total", total, "truncated", entries.Count < total, "payloadIncluded", false);
    }
    static void ValidateProjectionFormats(List<FormatTag> formats, bool operatorCalibrated, string expected)
    {
        Need(operatorCalibrated && !String.IsNullOrEmpty(expected), "DRAFT_PROJECTION_PERMISSION_REQUIRED");
        Need(formats.Count > 0 && formats.Count <= 16, "DRAFT_CLIPBOARD_COMPLEX_FORMAT");
        bool unicode = false;
        foreach (var item in formats)
        {
            Need(ClipboardFormats.IsTextFormat(item.Id) ||
                     (item.Id >= 0xc000 && ClipboardFormats.IsProjectionCompanion(item.Name)),
                 "DRAFT_CLIPBOARD_COMPLEX_FORMAT");
            if (item.Id == 13)
                unicode = true;
        }
        Need(unicode, "DRAFT_COPY_NOT_UNICODE_TEXT");
    }
    static byte[] ClipboardBytes(uint format, int maximum)
    {
        IntPtr handle = GetClipboardData(format);
        Need(handle != IntPtr.Zero, "DRAFT_CLIPBOARD_DATA_UNAVAILABLE");
        ulong length = GlobalSize(handle).ToUInt64();
        Need(length > 0 && length <= (ulong)maximum, "DRAFT_CLIPBOARD_DATA_TOO_LARGE");
        IntPtr memory = GlobalLock(handle);
        Need(memory != IntPtr.Zero, "DRAFT_CLIPBOARD_DATA_UNAVAILABLE");
        var bytes = new byte[(int)length];
        try
        {
            Marshal.Copy(memory, bytes, 0, bytes.Length);
        }
        finally
        {
            GlobalUnlock(handle);
        }
        return bytes;
    }
    static ClipboardState ReadProjectionClipboard(IntPtr owner, Request request, string expected = null)
    {
        if (expected == null)
            expected = request.ExpectedDraft;
        Need(OpenClipboard(owner), "DRAFT_CLIPBOARD_BUSY");
        try
        {
            var result = new ClipboardState { Sequence = GetClipboardSequenceNumber(), OwnerPid = ClipboardOwnerPid(),
                                              ProjectionOnly = true };
            Need(result.OwnerPid == request.Pid, "DRAFT_COPY_OWNER_MISMATCH");
            int count = CountClipboardFormats();
            CopyFormatDiagnostic = CopyFormats(count);
            Need(count > 0 && count <= 16, "DRAFT_CLIPBOARD_COMPLEX_FORMAT");
            var formats = new List<FormatTag>();
            uint id = 0;
            while ((id = EnumClipboardFormats(id)) != 0)
            {
                Need(formats.Count < 16, "DRAFT_CLIPBOARD_COMPLEX_FORMAT");
                string name = null;
                if (id >= 0xc000)
                {
                    var buffer = new StringBuilder(129);
                    if (GetClipboardFormatName(id, buffer, buffer.Capacity) > 0)
                        name = buffer.ToString();
                }
                formats.Add(new FormatTag { Id = id, Name = name });
            }
            Need(formats.Count == count, "DRAFT_CLIPBOARD_CHANGED");
            ValidateProjectionFormats(formats, request.OperatorCalibrated, expected);
            // OLE DataObject and all other companion payloads are deliberately excluded.
            result.Formats.Add(new ClipFormat { Id = 13, Bytes = ClipboardBytes(13, 131072) });
            Need(String.Equals(PlainText(result), expected, StringComparison.Ordinal), "DRAFT_TEXT_CONFLICT");
            var structure = new List<object>();
            foreach (var format in formats)
                if (format.Name == "WeChat_RichEdit_Format" || format.Name == "QQ_Unicode_RichEdit_Format")
                {
                    try
                    {
                        structure.Add(RichStructure(format.Name, ClipboardBytes(format.Id, 65536), expected));
                    }
                    catch (Fault)
                    {
                        structure.Add(Data("formatName", format.Name, "available", false, "payloadIncluded", false));
                    }
                }
            RichStructureDiagnostic = structure;
            Need(GetClipboardSequenceNumber() == result.Sequence && ClipboardOwnerPid() == request.Pid,
                 "DRAFT_CLIPBOARD_CHANGED");
            return result;
        }
        finally
        {
            CloseClipboard();
        }
    }
    static bool BytePrefix(byte[] bytes, byte[] pattern)
    {
        if (bytes.Length < pattern.Length)
            return false;
        for (int i = 0; i < pattern.Length; i++)
            if (bytes[i] != pattern[i])
                return false;
        return true;
    }
    static bool ContainsBytes(byte[] bytes, byte[] pattern)
    {
        if (pattern.Length == 0)
            return false;
        for (int start = 0; start <= bytes.Length - pattern.Length; start++)
        {
            bool equal = true;
            for (int i = 0; i < pattern.Length; i++)
                if (bytes[start + i] != pattern[i])
                {
                    equal = false;
                    break;
                }
            if (equal)
                return true;
        }
        return false;
    }
    static bool EncodedTextOnly(byte[] bytes, byte[] expected, int terminator)
    {
        if (bytes.Length != expected.Length && bytes.Length != expected.Length + terminator)
            return false;
        if (!BytePrefix(bytes, expected))
            return false;
        for (int i = expected.Length; i < bytes.Length; i++)
            if (bytes[i] != 0)
                return false;
        return true;
    }
    static object RichStructure(string name, byte[] bytes, string expected)
    {
        byte[] utf8 = Encoding.UTF8.GetBytes(expected), utf16 = Encoding.Unicode.GetBytes(expected);
        return Data("formatName", name, "available", true, "byteLength", bytes.Length, "utf8Bom",
                    BytePrefix(bytes, new byte[] { 0xef, 0xbb, 0xbf }), "utf16LEBom",
                    BytePrefix(bytes, new byte[] { 0xff, 0xfe }), "utf16BEBom",
                    BytePrefix(bytes, new byte[] { 0xfe, 0xff }), "containsExpectedUtf8", ContainsBytes(bytes, utf8),
                    "containsExpectedUtf16LE", ContainsBytes(bytes, utf16), "exactExpectedUtf8Bytes",
                    EncodedTextOnly(bytes, utf8, 1), "exactExpectedUtf16LEBytes", EncodedTextOnly(bytes, utf16, 2),
                    "payloadIncluded", false);
    }
    static ClipboardState ReadClipboard(IntPtr owner, bool requireText)
    {
        Need(OpenClipboard(owner), "DRAFT_CLIPBOARD_BUSY");
        try
        {
            var result = new ClipboardState { Sequence = GetClipboardSequenceNumber(), OwnerPid = ClipboardOwnerPid() };
            int count = CountClipboardFormats();
            if (requireText)
                CopyFormatDiagnostic = CopyFormats(count);
            Need(count >= 0 && count <= 4, "DRAFT_CLIPBOARD_COMPLEX_FORMAT");
            uint format = 0;
            int total = 0;
            while ((format = EnumClipboardFormats(format)) != 0)
            {
                Need(ClipboardFormats.IsTextFormat(format) && result.Formats.Count < 4,
                     "DRAFT_CLIPBOARD_COMPLEX_FORMAT");
                IntPtr handle = GetClipboardData(format);
                Need(handle != IntPtr.Zero, "DRAFT_CLIPBOARD_DATA_UNAVAILABLE");
                ulong length = GlobalSize(handle).ToUInt64();
                Need(length > 0 && length <= 131072, "DRAFT_CLIPBOARD_DATA_TOO_LARGE");
                total += checked((int)length);
                Need(total <= 262144, "DRAFT_CLIPBOARD_DATA_TOO_LARGE");
                IntPtr bytes = GlobalLock(handle);
                Need(bytes != IntPtr.Zero, "DRAFT_CLIPBOARD_DATA_UNAVAILABLE");
                byte[] copy = new byte[(int)length];
                try
                {
                    Marshal.Copy(bytes, copy, 0, copy.Length);
                }
                finally
                {
                    GlobalUnlock(handle);
                }
                Need(format != 16 || copy.Length == 4, "DRAFT_CLIPBOARD_FORMAT_INVALID");
                result.Formats.Add(new ClipFormat { Id = format, Bytes = copy });
            }
            Need(result.Formats.Count == count && GetClipboardSequenceNumber() == result.Sequence,
                 "DRAFT_CLIPBOARD_CHANGED");
            if (requireText)
                Need(result.Formats.Exists(delegate(ClipFormat item) { return item.Id == 13; }),
                     "DRAFT_COPY_NOT_UNICODE_TEXT");
            return result;
        }
        finally
        {
            CloseClipboard();
        }
    }
    static string DecodeUnicode(byte[] bytes)
    {
        Need(bytes != null && bytes.Length >= 2 && bytes.Length % 2 == 0, "DRAFT_COPY_TEXT_INVALID");
        int end = -1;
        for (int i = 0; i < bytes.Length; i += 2)
            if (bytes[i] == 0 && bytes[i + 1] == 0)
            {
                end = i;
                break;
            }
        Need(end >= 0 && end <= 32000, "DRAFT_COPY_TEXT_INVALID");
        try
        {
            return new UnicodeEncoding(false, false, true).GetString(bytes, 0, end);
        }
        catch
        {
            throw new Fault("DRAFT_COPY_TEXT_INVALID");
        }
    }
    static string PlainText(ClipboardState state)
    {
        foreach (var item in state.Formats)
            if (item.Id == 13)
                return DecodeUnicode(item.Bytes);
        throw new Fault("DRAFT_COPY_NOT_UNICODE_TEXT");
    }
    static string ValidateCopy(ClipboardState original, ClipboardState copied, uint expectedOwner, string expectedDraft)
    {
        Need(copied.Sequence != original.Sequence, "DRAFT_COPY_UNCHANGED");
        Need(copied.OwnerPid == expectedOwner, "DRAFT_COPY_OWNER_MISMATCH");
        Need(!copied.ProjectionOnly || !String.IsNullOrEmpty(expectedDraft), "DRAFT_EXPECTED_TEXT_REQUIRED");
        foreach (var item in copied.Formats)
            Need(ClipboardFormats.IsTextFormat(item.Id), "DRAFT_CLIPBOARD_COMPLEX_FORMAT");
        string text = PlainText(copied);
        Need(text.Length > 0, "DRAFT_EMPTY_COPY_UNVERIFIED");
        Need(expectedDraft == null || String.Equals(text, expectedDraft, StringComparison.Ordinal),
             "DRAFT_TEXT_CONFLICT");
        return text;
    }
    static bool RestoreClipboard(IntPtr owner, ClipboardState original, uint expectedSequence, uint expectedOwner,
                                 long revision)
    {
        uint sequence;
        return RestoreClipboard(owner, original, expectedSequence, expectedOwner, revision, out sequence);
    }
    static bool RestoreClipboard(IntPtr owner, ClipboardState original, uint expectedSequence, uint expectedOwner,
                                 long revision, out uint restoredSequence)
    {
        restoredSequence = 0;
        // Allocate everything before EmptyClipboard, so allocation failure preserves the copy.
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
            Need(OpenClipboard(owner), "DRAFT_CLIPBOARD_BUSY");
            try
            {
                Need(GetClipboardSequenceNumber() == expectedSequence && ClipboardOwnerPid() == expectedOwner &&
                         Interlocked.Read(ref Revision) == revision,
                     "DRAFT_CLIPBOARD_CHANGED");
                Need(EmptyClipboard(), "DRAFT_CLIPBOARD_RESTORE_FAILED");
                for (int i = 0; i < handles.Count; i++)
                {
                    Need(SetClipboardData(original.Formats[i].Id, handles[i]) != IntPtr.Zero,
                         "DRAFT_CLIPBOARD_RESTORE_FAILED");
                    handles[i] = IntPtr.Zero;
                }
            }
            finally
            {
                CloseClipboard();
            }
            ClipboardState restored = ReadClipboard(owner, false);
            bool matched = restored.OwnerPid == GetCurrentProcessId() && original.HasSamePayload(restored);
            if (matched)
                restoredSequence = restored.Sequence;
            return matched;
        }
        finally
        {
            foreach (IntPtr handle in handles)
                if (handle != IntPtr.Zero)
                    GlobalFree(handle);
        }
    }
}
