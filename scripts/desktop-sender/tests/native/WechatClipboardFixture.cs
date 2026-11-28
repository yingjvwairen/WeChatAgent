// Exercise the production allocation/publication functions with real HGLOBAL
// allocations and a fake clipboard sink. No clipboard or window APIs are called.
using System;
using System.Collections.Generic;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
internal static partial class WechatDraftProbe
{
    static ClipboardState ClipboardMemoryRoundTrip(ClipboardState source)
    {
        var handles = QtAllocateClipboardBackup(source);
        var restored = new ClipboardState();
        int index = 0;
        try
        {
            QtPublishClipboardBackup(source, handles, delegate(uint id, IntPtr handle) {
                var expected = source.Formats[index++];
                Need(id == expected.Id, "CLIPBOARD_MEMORY_PRIORITY_ORDER");
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
            return restored;
        }
        finally
        {
            foreach (var handle in handles)
                if (handle != IntPtr.Zero)
                    GlobalFree(handle);
        }
    }
    static int ClipboardOleImageFixture()
    {
        const uint dataObject = 0xc001, png = 0xc002, upload = 0xc003, history = 0xc004, olePrivate = 0xc005;
        var trace = new QtClipboardBackupTrace();
        var formats = new List<uint> { dataObject, png, upload, history, olePrivate, 8, 17 };
        var descriptions = new Dictionary<uint, Dictionary<string, object>> {
            { dataObject, trace.Format(dataObject, "DataObject", false) },
            { png, trace.Format(png, "PNG", false) },
            { upload, trace.Format(upload, "CanUploadToCloudClipboard", false) },
            { history, trace.Format(history, "CanIncludeInClipboardHistory", false) },
            { olePrivate, trace.Format(olePrivate, "Ole Private Data", false) },
            { 8, trace.Format(8, null, false) },
            { 17, trace.Format(17, null, false) }
        };
        var source = new ClipboardState();
        var selected = QtSelectClipboardBackupFormats(source, formats, descriptions, false, false);
        uint[] expected = { png, upload, history, 8, 17 };
        Need(selected.Count == expected.Length && source.OmittedOleImageCompanions && !source.ReplaceOnPaste &&
                 Text(descriptions[dataObject], "state") == "companion" &&
                 Text(descriptions[olePrivate], "state") == "companion",
             "CLIPBOARD_IMAGE_OLE_COMPANIONS");
        for (int index = 0; index < expected.Length; index++)
            Need(selected[index] == expected[index], "CLIPBOARD_IMAGE_FORMAT_ORDER");

        var pixel = Color.FromArgb(255, 23, 118, 215);
        byte[] pngBytes;
        using (var bitmap = new Bitmap(1, 1)) using (var stream = new MemoryStream())
        {
            bitmap.SetPixel(0, 0, pixel);
            bitmap.Save(stream, ImageFormat.Png);
            pngBytes = stream.ToArray();
        }
        // BITMAPINFOHEADER and BITMAPV5HEADER with a single 32-bit pixel.
        byte[] dib = new byte[44], dibV5 = new byte[128];
        dib[0] = 40;
        dib[4] = dib[8] = dib[12] = 1;
        dib[14] = 32;
        dib[20] = 4;
        dib[40] = pixel.B;
        dib[41] = pixel.G;
        dib[42] = pixel.R;
        Array.Copy(dib, dibV5, 40);
        dibV5[0] = 124;
        Array.Copy(dib, 40, dibV5, 124, 4);
        byte[][] payloads = { pngBytes, BitConverter.GetBytes(0), BitConverter.GetBytes(0), dib, dibV5 };
        for (int index = 0; index < selected.Count; index++)
            source.Formats.Add(new ClipFormat { Id = selected[index], Bytes = payloads[index] });
        var restored = ClipboardMemoryRoundTrip(source);
        using (var stream = new MemoryStream(restored.Formats[0].Bytes)) using (var bitmap = new Bitmap(stream))
            Need(bitmap.Size == new Size(1, 1) && bitmap.GetPixel(0, 0).ToArgb() == pixel.ToArgb(),
                 "CLIPBOARD_IMAGE_PIXELS_RESTORED");
        var report = Map(QtRestorationReport(source, restored));
        Need(Object.Equals(Get(report, "lossless"), false) && Object.Equals(Get(report, "exactPayloadMatched"), true) &&
                 Object.Equals(Get(report, "formatOrderMatched"), true),
             "CLIPBOARD_IMAGE_RESTORATION_REPORT");

        int checks = 4;
        foreach (var other in new Dictionary<uint, string> {
                     { 13, null }, { 15, null }, { 0xc006, "HTML Format" }, { 0xc007, "FileContents" }
                 })
        {
            var mixedFormats = new List<uint>(formats) { other.Key };
            var mixedDescriptions = new Dictionary<uint, Dictionary<string, object>>(
                descriptions) { { other.Key, trace.Format(other.Key, other.Value, false) } };
            Expect(delegate {
                QtSelectClipboardBackupFormats(new ClipboardState(), mixedFormats, mixedDescriptions, false, false);
            }, "DRAFT_CLIPBOARD_COMPLEX_FORMAT");
            checks++;
        }
        Expect(delegate {
            QtSelectClipboardBackupFormats(new ClipboardState(), new List<uint> { dataObject, upload, olePrivate },
                                           descriptions, false, false);
        }, "DRAFT_CLIPBOARD_COMPLEX_FORMAT");
        Expect(delegate { QtSelectClipboardBackupFormats(new ClipboardState(), formats, descriptions, true, false); },
               "DRAFT_CLIPBOARD_COMPLEX_FORMAT");
        return checks + 2;
    }
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
        var restored = ClipboardMemoryRoundTrip(source);
        checks++;
        var exact = Map(QtRestorationReport(source, restored));
        Need(Object.Equals(Get(exact, "lossless"), true) && Object.Equals(Get(exact, "exactPayloadMatched"), true) &&
                 Number(Get(exact, "formatCount")) == 7 &&
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
        // Publishing a later format may fail. Accepted handles are system-owned;
        // the caller still owns exactly the not-yet-published allocation suffix.
        var handles = QtAllocateClipboardBackup(source);
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
        checks += ClipboardOleImageFixture();
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
