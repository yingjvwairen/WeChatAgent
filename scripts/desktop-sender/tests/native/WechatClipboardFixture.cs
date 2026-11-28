// Exercise the production allocation/publication functions with real HGLOBAL
// allocations and a fake clipboard sink. No clipboard or window APIs are called.
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
internal static partial class WechatDraftProbe
{
    internal static object ClipboardMemoryFixture()
    {
        int checks = 0;
        var source = new ClipboardState();
        string[] names = {
            "HTML Format", null, "Chromium internal source RFH token", "Chromium internal source URL", null,
            null,          null
        };
        uint[] ids = { 0xc001, 13, 0xc002, 0xc003, 16, 1, 7 };
        for (int i = 0; i < ids.Length; i++)
        {
            Need(ClipboardFormats.CanBackUp(ids[i], names[i]), "CLIPBOARD_MEMORY_SUPPORTED");
            source.Formats.Add(
                new ClipFormat { Id = ids[i],
                                 Bytes = i == 4 ? BitConverter.GetBytes(0x0409)
                                                : Encoding.UTF8.GetBytes("fixture-format-" + i + "-preserve-\0") });
            checks++;
        }
        var handles = QtAllocateClipboardBackup(source);
        var restored = new ClipboardState();
        int index = 0;
        try
        {
            QtPublishClipboardBackup(source, handles, delegate(uint id, IntPtr handle) {
                Need(id == ids[index], "CLIPBOARD_MEMORY_PRIORITY_ORDER");
                var expected = source.Formats[index++];
                Need(GlobalSize(handle).ToUInt64() >= (ulong)expected.Bytes.Length, "CLIPBOARD_MEMORY_SIZE");
                var memory = GlobalLock(handle);
                Need(memory != IntPtr.Zero, "CLIPBOARD_MEMORY_LOCK");
                var bytes = new byte[expected.Bytes.Length];
                try
                {
                    Marshal.Copy(memory, bytes, 0, bytes.Length);
                }
                finally
                {
                    GlobalUnlock(handle);
                }
                restored.Formats.Add(new ClipFormat { Id = id, Bytes = bytes });
                GlobalFree(handle);
                return new IntPtr(1);
            });
            Need(source.HasSamePayload(restored) &&
                     handles.TrueForAll(delegate(IntPtr handle) { return handle == IntPtr.Zero; }),
                 "CLIPBOARD_MEMORY_FULL_RESTORE");
            checks++;
            var exact = Map(QtRestorationReport(source, restored));
            Need(Object.Equals(Get(exact, "lossless"), true) &&
                     Object.Equals(Get(exact, "exactPayloadMatched"), true) && Number(Get(exact, "formatCount")) == 7 &&
                     Number(Get(exact, "byteLength")) == Number(Get(exact, "restoredByteLength")),
                 "CLIPBOARD_MEMORY_EXACT_REPORT");
            checks++;
            restored.Formats.Reverse();
            var reordered = Map(QtRestorationReport(source, restored));
            Need(Object.Equals(Get(reordered, "exactPayloadMatched"), true) &&
                     Object.Equals(Get(reordered, "lossless"), false) &&
                     Object.Equals(Get(reordered, "formatOrderMatched"), false),
                 "CLIPBOARD_MEMORY_PRIORITY_MISMATCH");
            restored.Formats.Reverse();
            checks++;
            restored.Formats[2].Bytes[0] ^= 1;
            Need(Object.Equals(Get(Map(QtRestorationReport(source, restored)), "exactPayloadMatched"), false),
                 "CLIPBOARD_MEMORY_PRIVATE_METADATA_BYTES_MUST_MATCH");
            checks++;
            Need(!Json.Serialize(exact).Contains("fixture-format-") && !Json.Serialize(exact).Contains("https:"),
                 "CLIPBOARD_MEMORY_RESTORE_REPORT_NO_CONTENT");
            checks++;
        }
        finally
        {
            foreach (var handle in handles)
                if (handle != IntPtr.Zero)
                    GlobalFree(handle);
        }
        // Publishing a later format may fail. Accepted handles are system-owned;
        // the caller still owns exactly the not-yet-published allocation suffix.
        handles = QtAllocateClipboardBackup(source);
        int accepted = 0;
        try
        {
            Expect(delegate {
                QtPublishClipboardBackup(source, handles, delegate(uint id, IntPtr handle) {
                    if (accepted == 3)
                        return IntPtr.Zero;
                    accepted++;
                    GlobalFree(handle);
                    return new IntPtr(1);
                });
            }, "DRAFT_CLIPBOARD_RESTORE_FAILED");
            for (int i = 0; i < handles.Count; i++)
                Need((handles[i] == IntPtr.Zero) == (i < 3), "CLIPBOARD_MEMORY_TRANSFER_OWNERSHIP");
            checks++;
        }
        finally
        {
            foreach (var handle in handles)
                if (handle != IntPtr.Zero)
                    GlobalFree(handle);
        }
        foreach (string name in new[] { "DataObject", "Ole Private Data", "Unknown Format" })
        {
            Need(!ClipboardFormats.CanBackUp(0xc005, name), "CLIPBOARD_MEMORY_OPAQUE_REFUSED");
            checks++;
        }
        var trace = new QtClipboardBackupTrace();
        var entry = trace.Format(0xc005, "DataObject", false);
        entry["state"] = "unsupported";
        entry["error"] = "DRAFT_CLIPBOARD_COMPLEX_FORMAT";
        trace.Failure = "DRAFT_CLIPBOARD_COMPLEX_FORMAT";
        Need(!Json.Serialize(trace.Report()).Contains("fixture-format-"), "CLIPBOARD_MEMORY_DIAGNOSTIC_NO_CONTENT");
        checks++;
        return Data("ok", true, "selfTest", true, "checks", checks, "realHglobal", true, "clipboardAccessed", false,
                    "interactiveClipboardModified", false, "uiAccessed", false, "inputSent", false, "formats", 7);
    }
}
internal static class WechatClipboardFixture
{
    [STAThread]
    static int Main(string[] args)
    {
        try
        {
            if (args.Length != 1 || args[0] != "--self-test")
                throw new Exception("CLIPBOARD_FIXTURE_ARGUMENTS");
            Console.WriteLine(new System.Web.Script.Serialization.JavaScriptSerializer().Serialize(
                WechatDraftProbe.ClipboardMemoryFixture()));
            return 0;
        }
        catch (Exception error)
        {
            Console.WriteLine(new System.Web.Script.Serialization.JavaScriptSerializer().Serialize(
                new { ok = false, error = error.Message, clipboardAccessed = false, inputSent = false }));
            return 1;
        }
    }
}
