// Offline, read-only OCR of an explicitly supplied local image. No window,
// desktop capture, mouse, keyboard, clipboard, network, or account APIs are used.
using System;
using System.IO;
using System.Text;
using System.Linq;
using System.Drawing;
using System.Drawing.Imaging;
using System.Collections.Generic;
using System.Security.Cryptography;
using System.Threading;
using System.Threading.Tasks;
using System.Runtime.InteropServices;
using System.Web.Script.Serialization;
using Windows.Globalization;
using Windows.Graphics.Imaging;
using Windows.Media.Ocr;

class WechatVisualProbe
{
    const int MaxBytes = 16 * 1024 * 1024, MaxDimension = 4096, MaxWords = 4096;
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 1024 * 1024 };
    static Dictionary<string, object> Data(params object[] pairs)
    {
        var d = new Dictionary<string, object>();
        for (int i = 0; i < pairs.Length; i += 2)
            d[(string)pairs[i]] = pairs[i + 1];
        return d;
    }
    static Exception Fault(string code)
    {
        return new InvalidOperationException(code);
    }
    static int Main(string[] args)
    {
        Console.OutputEncoding = new UTF8Encoding(false);
        try
        {
            object result;
            if (args.Length == 0 || args.Length == 1 && args[0] == "--languages")
                result = Languages();
            else if (args.Length == 1 && args[0] == "--self-test")
                result = SelfTest();
            else if (args.Length == 1 && args[0] == "--fixture-test")
                result = FixtureTest().GetAwaiter().GetResult();
            else if ((args.Length == 2 || args.Length == 4) && args[0] == "--image" &&
                     (args.Length != 4 || args[2] == "--language"))
            {
                if (!Path.IsPathRooted(args[1]))
                    throw Fault("VISUAL_ABSOLUTE_PATH_REQUIRED");
                var file = new FileInfo(args[1]);
                if (!file.Exists || file.Length < 24 || file.Length > MaxBytes)
                    throw Fault("VISUAL_IMAGE_SIZE_INVALID");
                byte[] bytes;
                using (var input = new FileStream(file.FullName, FileMode.Open, FileAccess.Read, FileShare.Read))
                {
                    if (input.Length < 24 || input.Length > MaxBytes)
                        throw Fault("VISUAL_IMAGE_SIZE_INVALID");
                    bytes = new byte[(int)input.Length];
                    int read = 0;
                    while (read < bytes.Length)
                    {
                        int count = input.Read(bytes, read, bytes.Length - read);
                        if (count == 0)
                            throw Fault("VISUAL_IMAGE_CHANGED");
                        read += count;
                    }
                }
                result = Recognize(bytes, args.Length == 4 ? args[3] : null).GetAwaiter().GetResult();
            }
            else
                throw Fault("VISUAL_ARGUMENTS_INVALID");
            Console.WriteLine(Json.Serialize(result));
            return 0;
        }
        catch (Exception error)
        {
            string code = error.Message;
            if (!System.Text.RegularExpressions.Regex.IsMatch(code ?? "", "^VISUAL_[A-Z0-9_]{1,64}$"))
                code = error is OperationCanceledException ? "VISUAL_OCR_TIMEOUT" : "VISUAL_OCR_UNAVAILABLE";
            Console.WriteLine(Json.Serialize(Data("ok", false, "error", code, "readOnly", true, "inputSent", false)));
            return 1;
        }
    }
    static object Languages()
    {
        return Data("ok", true, "mode", "languages", "languages",
                    OcrEngine.AvailableRecognizerLanguages.Select(l => l.LanguageTag).ToArray(), "maxImageDimension",
                    Math.Min(MaxDimension, OcrEngine.MaxImageDimension), "readOnly", true, "inputSent", false);
    }
    static uint Big32(byte[] b, int i)
    {
        return ((uint)b[i] << 24) | ((uint)b[i + 1] << 16) | ((uint)b[i + 2] << 8) | b[i + 3];
    }
    static int Big16(byte[] b, int i)
    {
        return (b[i] << 8) | b[i + 1];
    }
    // Use the OS metadata's IAsyncOperation directly. The .NET Framework AsTask
    // facade expects an SDK Windows.winmd that is not installed on every PC.
    static async Task<T> Await<T>(Windows.Foundation.IAsyncOperation<T> operation, CancellationToken token)
    {
        try
        {
            while (operation.Status == Windows.Foundation.AsyncStatus.Started)
                await Task.Delay(10, token);
            token.ThrowIfCancellationRequested();
            return operation.GetResults();
        }
        catch (OperationCanceledException)
        {
            operation.Cancel();
            throw;
        }
        finally
        {
            operation.Close();
        }
    }
    static int[] Dimensions(byte[] bytes)
    {
        int w = 0, h = 0;
        if (bytes.Length >= 24 && bytes[0] == 137 && bytes[1] == 80 && bytes[2] == 78 && bytes[3] == 71 &&
            bytes[4] == 13 && bytes[5] == 10 && bytes[6] == 26 && bytes[7] == 10 && Big32(bytes, 8) == 13 &&
            Encoding.ASCII.GetString(bytes, 12, 4) == "IHDR")
        {
            uint width = Big32(bytes, 16), height = Big32(bytes, 20);
            if (width > MaxDimension || height > MaxDimension)
                throw Fault("VISUAL_IMAGE_DIMENSIONS_INVALID");
            w = (int)width;
            h = (int)height;
        }
        else if (bytes.Length >= 4 && bytes[0] == 255 && bytes[1] == 216)
        {
            int at = 2;
            while (at + 3 < bytes.Length)
            {
                if (bytes[at++] != 255)
                    throw Fault("VISUAL_IMAGE_FORMAT_INVALID");
                while (at < bytes.Length && bytes[at] == 255)
                    at++;
                if (at >= bytes.Length)
                    break;
                int marker = bytes[at++];
                if (marker == 217 || marker == 218)
                    break;
                if (marker == 1 || marker >= 208 && marker <= 215)
                    continue;
                if (at + 1 >= bytes.Length)
                    break;
                int length = Big16(bytes, at);
                if (length < 2 || at + length > bytes.Length)
                    throw Fault("VISUAL_IMAGE_FORMAT_INVALID");
                if ((marker >= 192 && marker <= 195) || (marker >= 197 && marker <= 199) ||
                    (marker >= 201 && marker <= 203) || (marker >= 205 && marker <= 207))
                {
                    if (length < 8)
                        throw Fault("VISUAL_IMAGE_FORMAT_INVALID");
                    h = Big16(bytes, at + 3);
                    w = Big16(bytes, at + 5);
                    break;
                }
                at += length;
            }
        }
        else
            throw Fault("VISUAL_IMAGE_FORMAT_INVALID");
        if (w < 1 || h < 1 || w > MaxDimension || h > MaxDimension || (long)w * h > 12 * 1024 * 1024)
            throw Fault("VISUAL_IMAGE_DIMENSIONS_INVALID");
        return new int[] { w, h };
    }
    static byte[] Prepare(byte[] bytes, int[] dimensions, out bool inverted)
    {
        using (var input = new MemoryStream(bytes, false)) using (
            var image = Image.FromStream(input, false, true)) using (var bitmap =
                                                                         new Bitmap(dimensions[0], dimensions[1],
                                                                                    PixelFormat.Format32bppArgb))
        {
            using (var drawing = Graphics.FromImage(bitmap))
            {
                drawing.Clear(Color.White);
                drawing.DrawImageUnscaled(image, 0, 0);
            }
            var locked = bitmap.LockBits(new Rectangle(0, 0, bitmap.Width, bitmap.Height), ImageLockMode.ReadWrite,
                                         PixelFormat.Format32bppArgb);
            try
            {
                if (locked.Stride < 0)
                    throw Fault("VISUAL_IMAGE_FORMAT_INVALID");
                int length = checked(Math.Abs(locked.Stride) * bitmap.Height);
                var pixels = new byte[length];
                Marshal.Copy(locked.Scan0, pixels, 0, length);
                double brightness = 0;
                int count = 0;
                for (int y = 0; y < bitmap.Height; y += Math.Max(1, bitmap.Height / 32))
                    for (int x = 0; x < bitmap.Width; x += Math.Max(1, bitmap.Width / 32))
                    {
                        int offset = y * Math.Abs(locked.Stride) + x * 4;
                        brightness += (pixels[offset] + pixels[offset + 1] + pixels[offset + 2]) / 3.0;
                        count++;
                    }
                inverted = brightness / Math.Max(1, count) < 128;
                if (inverted)
                {
                    for (int i = 0; i < length; i += 4)
                    {
                        pixels[i] = (byte)(255 - pixels[i]);
                        pixels[i + 1] = (byte)(255 - pixels[i + 1]);
                        pixels[i + 2] = (byte)(255 - pixels[i + 2]);
                    }
                    Marshal.Copy(pixels, 0, locked.Scan0, length);
                }
            }
            finally
            {
                bitmap.UnlockBits(locked);
            }
            if (!inverted)
                return bytes;
            using (var output = new MemoryStream())
            {
                bitmap.Save(output, ImageFormat.Png);
                return output.ToArray();
            }
        }
    }
    static async Task<object> Recognize(byte[] bytes, string requested)
    {
        int[] dimensions = Dimensions(bytes);
        if (dimensions[0] > OcrEngine.MaxImageDimension || dimensions[1] > OcrEngine.MaxImageDimension)
            throw Fault("VISUAL_IMAGE_DIMENSIONS_INVALID");
        OcrEngine engine;
        if (requested != null)
        {
            if (requested.Length > 40 ||
                !System.Text.RegularExpressions.Regex.IsMatch(requested, "^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8}){0,4}$"))
                throw Fault("VISUAL_LANGUAGE_INVALID");
            engine = OcrEngine.TryCreateFromLanguage(new Language(requested));
        }
        else
        {
            engine = OcrEngine.TryCreateFromLanguage(new Language("zh-Hans-CN"));
            if (engine == null)
                engine = OcrEngine.TryCreateFromUserProfileLanguages();
        }
        if (engine == null)
            throw Fault("VISUAL_LANGUAGE_UNAVAILABLE");
        bool inverted;
        byte[] prepared = Prepare(bytes, dimensions, out inverted);
        using (var timeout = new CancellationTokenSource(12000)) using (
            var stream = new Windows.Storage.Streams.InMemoryRandomAccessStream())
        {
            using (var writer = new Windows.Storage.Streams.DataWriter(stream))
            {
                writer.WriteBytes(prepared);
                await Await<uint>(writer.StoreAsync(), timeout.Token);
                writer.DetachStream();
            }
            stream.Seek(0);
            var decoder = await Await<BitmapDecoder>(BitmapDecoder.CreateAsync(stream), timeout.Token);
            if (decoder.PixelWidth != dimensions[0] || decoder.PixelHeight != dimensions[1])
                throw Fault("VISUAL_IMAGE_DIMENSIONS_INVALID");
            uint scale = (uint)Math.Max(
                1, Math.Min(3, Math.Min(Math.Min(MaxDimension / dimensions[0], MaxDimension / dimensions[1]),
                                        (int)Math.Sqrt(12.0 * 1024 * 1024 / ((long)dimensions[0] * dimensions[1])))));
            var transform = new BitmapTransform { ScaledWidth = (uint)dimensions[0] * scale,
                                                  ScaledHeight = (uint)dimensions[1] * scale,
                                                  InterpolationMode = BitmapInterpolationMode.Cubic };
            using (var bitmap = await Await<SoftwareBitmap>(
                       decoder.GetSoftwareBitmapAsync(BitmapPixelFormat.Bgra8, BitmapAlphaMode.Ignore, transform,
                                                      ExifOrientationMode.IgnoreExifOrientation,
                                                      ColorManagementMode.DoNotColorManage),
                       timeout.Token))
            {
                var result = await Await<OcrResult>(engine.RecognizeAsync(bitmap), timeout.Token);
                var words = new List<object>();
                int lineIndex = 0, totalChars = 0;
                foreach (var line in result.Lines)
                {
                    if (lineIndex >= 512)
                        throw Fault("VISUAL_OCR_RESULT_TOO_LARGE");
                    foreach (var word in line.Words)
                    {
                        totalChars += word.Text.Length;
                        if (words.Count >= MaxWords || word.Text.Length > 2048 || totalChars > 32768)
                            throw Fault("VISUAL_OCR_RESULT_TOO_LARGE");
                        var r = word.BoundingRect;
                        if (Double.IsNaN(r.X) || Double.IsNaN(r.Y) || r.X < 0 || r.Y < 0 || r.Width <= 0 ||
                            r.Height <= 0 || r.X + r.Width > (dimensions[0] + 1) * scale ||
                            r.Y + r.Height > (dimensions[1] + 1) * scale)
                            throw Fault("VISUAL_OCR_BOUNDS_INVALID");
                        words.Add(Data("text", word.Text, "line", lineIndex, "x", r.X / scale, "y", r.Y / scale,
                                       "width", r.Width / scale, "height", r.Height / scale));
                    }
                    lineIndex++;
                }
                string hash;
                using (var sha = SHA256.Create()) hash =
                    BitConverter.ToString(sha.ComputeHash(bytes)).Replace("-", "").ToLowerInvariant();
                return Data("ok", true, "mode", "ocr", "imageSha256", hash, "width", dimensions[0], "height",
                            dimensions[1], "recognitionScale", scale, "invertedForOcr", inverted, "language",
                            engine.RecognizerLanguage.LanguageTag, "textAngle", result.TextAngle, "words", words,
                            "readOnly", true, "inputSent", false);
            }
        }
    }
    static object SelfTest()
    {
        int checks = 0;
        byte[] header = new byte[24];
        Array.Copy(new byte[] { 137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 4, 0, 0, 0, 3, 0 },
                   header, 24);
        var size = Dimensions(header);
        if (size[0] != 1024 || size[1] != 768)
            throw Fault("VISUAL_SELF_TEST_FAILED");
        checks++;
        header[16] = 127;
        Expect(delegate { Dimensions(header); });
        checks++;
        Expect(delegate { Dimensions(new byte[] { 1, 2, 3, 4 }); });
        checks++;
        byte[] jpeg = new byte[] { 255, 216, 255, 192, 0, 8, 8, 3, 0, 4, 0, 1 };
        size = Dimensions(jpeg);
        if (size[0] != 1024 || size[1] != 768)
            throw Fault("VISUAL_SELF_TEST_FAILED");
        checks++;
        jpeg[4] = 127;
        Expect(delegate { Dimensions(jpeg); });
        checks++;
        return Data("ok", true, "selfTest", true, "checks", checks, "uiAccessed", false, "inputSent", false);
    }
    static void Expect(Action action)
    {
        try
        {
            action();
        }
        catch (InvalidOperationException)
        {
            return;
        }
        throw Fault("VISUAL_SELF_TEST_FAILED");
    }
    static async Task<object> FixtureTest()
    {
        // Only synthetic text is rendered; no desktop or application is read.
        byte[] bytes;
        using (var bitmap = new Bitmap(1200, 800)) using (var graphics = Graphics.FromImage(bitmap)) using (
            var font = new Font("Microsoft YaHei", 30, FontStyle.Regular,
                                GraphicsUnit.Pixel)) using (var memory = new MemoryStream())
        {
            graphics.Clear(Color.White);
            graphics.TextRenderingHint = System.Drawing.Text.TextRenderingHint.AntiAliasGridFit;
            graphics.DrawString("搜索", font, Brushes.Black, 70, 38);
            graphics.DrawString("文件传输助手", font, Brushes.Black, 430, 38);
            graphics.DrawString("离线识别测试", font, Brushes.Black, 430, 350);
            graphics.DrawString("发送", font, Brushes.Black, 1070, 730);
            bitmap.Save(memory, ImageFormat.Png);
            bytes = memory.ToArray();
        }
        var result = (Dictionary<string, object>)await Recognize(bytes, "zh-Hans-CN");
        var words = (List<object>)result["words"];
        string joined = String.Concat(words.Select(w => (string)((Dictionary<string, object>)w)["text"]).ToArray());
        bool found = joined.Contains("文件传输助手") && joined.Contains("搜索") && joined.Contains("发送");
        if (!found)
            throw Fault("VISUAL_FIXTURE_OCR_FAILED");
        return Data("ok", true, "fixtureTest", true, "language", result["language"], "matchedTitle", true,
                    "matchedSearch", true, "matchedSend", true, "uiAccessed", false, "inputSent", false);
    }
}
