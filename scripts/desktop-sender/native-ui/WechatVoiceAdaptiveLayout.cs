// Fixed, version-bound recording controls. No image learning, process memory,
// UI automation or input in the matcher. A match only freezes pixel guards.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

internal static partial class WechatDraftProbe
{
    const string VoiceAdaptiveVersion = "4.2.0.53";
    // The scale-aware glyph corpus is inherited; its provenance/hash stays intact.
    const string VoiceAdaptiveTemplateVersion = "4.1.15.56";
    const string VoiceAdaptiveResource = "WechatVoiceAdaptiveTemplates";
    const string VoiceAdaptiveResourceHash = "16125b15249a50da30b104c38f12d398755848a3cf16b2a3124786c42483951d";
    sealed class VoiceAdaptivePlan
    {
        internal Rect Toolbar;
        internal string Version;
    }
    sealed class VoiceShape
    {
        internal string Kind;
        internal int Dpi, Width, Height;
        internal byte[] Gray;
    }
    sealed class VoiceShapeMatch
    {
        internal Rect Rect;
        internal double Score;
    }
    static List<VoiceShape> VoiceShapes;

    static VoiceAdaptivePlan ParseVoiceAdaptive(object value, Request binding, Rect record, Rect park)
    {
        var map = Map(value);
        Need(map != null && map.Count == 3 && Number(Get(map, "version")) == 1 &&
                 Text(map, "executableVersion") == VoiceAdaptiveVersion,
             "VOICE_ADAPTIVE_PLAN_INVALID");
        Rect toolbar = ParseRect(Get(map, "toolbarRect"));
        double s = binding.Dpi / 120.0;
        Need(binding.Dpi >= 96 && binding.Dpi <= 240 && Contains(binding.Client, toolbar) && toolbar.Width >= 120 * s &&
                 toolbar.Width <= binding.Client.Width && toolbar.Height >= 32 * s && toolbar.Height <= 120 * s &&
                 toolbar.Top >= binding.Client.Height * .45 && binding.Client.Bottom - toolbar.Bottom <= 40 * s &&
                 Contains(toolbar, record) && !Intersects(toolbar, park),
             "VOICE_ADAPTIVE_PLAN_INVALID");
        return new VoiceAdaptivePlan { Toolbar = toolbar, Version = VoiceAdaptiveVersion };
    }
    static List<VoiceShape> LoadVoiceShapes()
    {
        if (VoiceShapes != null)
            return VoiceShapes;
        byte[] raw;
        using (var stream = Assembly.GetExecutingAssembly().GetManifestResourceStream(VoiceAdaptiveResource))
        {
            Need(stream != null && stream.Length > 0 && stream.Length <= 131072, "VOICE_ADAPTIVE_TEMPLATE_INVALID");
            raw = new byte[(int)stream.Length];
            int done = 0;
            while (done < raw.Length)
            {
                int count = stream.Read(raw, done, raw.Length - done);
                Need(count > 0, "VOICE_ADAPTIVE_TEMPLATE_INVALID");
                done += count;
            }
        }
        Need(PixelHash(raw) == VoiceAdaptiveResourceHash, "VOICE_ADAPTIVE_TEMPLATE_INVALID");
        var map = Map(Json.DeserializeObject(Encoding.UTF8.GetString(raw)));
        Need(map != null && Number(Get(map, "version")) == 1 &&
                 Text(map, "executableVersion") == VoiceAdaptiveTemplateVersion,
             "VOICE_ADAPTIVE_TEMPLATE_INVALID");
        object[] rows = Get(map, "templates") as object[];
        Need(rows != null && rows.Length >= 2 && rows.Length <= 12, "VOICE_ADAPTIVE_TEMPLATE_INVALID");
        var shapes = new List<VoiceShape>();
        foreach (object row in rows)
        {
            var item = Map(row);
            string kind = Text(item, "kind");
            if (kind == "recordStart")
                continue;
            Need(kind == "cancel" || kind == "submit", "VOICE_ADAPTIVE_TEMPLATE_INVALID");
            int w = (int)Number(Get(item, "width")), h = (int)Number(Get(item, "height")),
                dpi = (int)Number(Get(item, "dpi"));
            Need(w >= 8 && h >= 8 && w <= 100 && h <= 100 && (dpi == 120 || dpi == 144),
                 "VOICE_ADAPTIVE_TEMPLATE_INVALID");
            byte[] data = Convert.FromBase64String(Text(item, "pixels"));
            Need(data.Length == w * h && PixelHash(data) == Text(item, "sha256"), "VOICE_ADAPTIVE_TEMPLATE_INVALID");
            shapes.Add(new VoiceShape { Kind = kind, Dpi = dpi, Width = w, Height = h, Gray = data });
        }
        Need(shapes.Exists(delegate(VoiceShape a) { return a.Kind == "cancel"; }) &&
                 shapes.Exists(delegate(VoiceShape a) { return a.Kind == "submit"; }),
             "VOICE_ADAPTIVE_TEMPLATE_INVALID");
        VoiceShapes = shapes;
        return shapes;
    }
    static byte[] VoiceBitmapRgba(Bitmap bitmap)
    {
        var result = new byte[bitmap.Width * bitmap.Height * 4];
        byte[] row = new byte[bitmap.Width * 4];
        BitmapData bits = bitmap.LockBits(new Rectangle(0, 0, bitmap.Width, bitmap.Height), ImageLockMode.ReadOnly,
                                          PixelFormat.Format32bppRgb);
        try
        {
            for (int y = 0; y < bitmap.Height; y++)
            {
                Marshal.Copy(IntPtr.Add(bits.Scan0, y * bits.Stride), row, 0, row.Length);
                VoiceRgbaRow(row, result, y * row.Length);
            }
        }
        finally
        {
            bitmap.UnlockBits(bits);
        }
        return result;
    }
    static byte[] VoiceGray(byte[] rgba)
    {
        byte[] gray = new byte[rgba.Length / 4];
        for (int i = 0; i < gray.Length; i++)
            gray[i] = (byte)((rgba[i * 4] * 299 + rgba[i * 4 + 1] * 587 + rgba[i * 4 + 2] * 114 + 500) / 1000);
        return gray;
    }
    static VoiceShape ResizeVoiceShape(VoiceShape input, int dpi, double delta)
    {
        int width = (int)Math.Round(input.Width * dpi / (double)input.Dpi * delta),
            height = (int)Math.Round(input.Height * dpi / (double)input.Dpi * delta);
        byte[] gray = new byte[width * height];
        for (int y = 0; y < height; y++)
            for (int x = 0; x < width; x++)
            {
                double sy = Math.Max(0, Math.Min(input.Height - 1, (y + .5) * input.Height / height - .5)),
                       sx = Math.Max(0, Math.Min(input.Width - 1, (x + .5) * input.Width / width - .5));
                int x0 = (int)sx, y0 = (int)sy, x1 = Math.Min(x0 + 1, input.Width - 1),
                    y1 = Math.Min(y0 + 1, input.Height - 1);
                double fx = sx - x0, fy = sy - y0;
                gray[y * width + x] = (byte)Math.Round(input.Gray[y0 * input.Width + x0] * (1 - fx) * (1 - fy) +
                                                       input.Gray[y0 * input.Width + x1] * fx * (1 - fy) +
                                                       input.Gray[y1 * input.Width + x0] * (1 - fx) * fy +
                                                       input.Gray[y1 * input.Width + x1] * fx * fy);
            }
        return new VoiceShape { Kind = input.Kind, Dpi = dpi, Width = width, Height = height, Gray = gray };
    }
    static double VoiceCorrelation(byte[] image, int width, int x, int y, VoiceShape shape, int step)
    {
        double sumA = 0, sumB = 0, aa = 0, bb = 0, ab = 0;
        int n = 0;
        for (int iy = 0; iy < shape.Height; iy += step)
            for (int ix = 0; ix < shape.Width; ix += step)
            {
                double a = image[(y + iy) * width + x + ix], b = shape.Gray[iy * shape.Width + ix];
                sumA += a;
                sumB += b;
                aa += a * a;
                bb += b * b;
                ab += a * b;
                n++;
            }
        double den = (aa - sumA * sumA / n) * (bb - sumB * sumB / n);
        return den > 1 ? (ab - sumA * sumB / n) / Math.Sqrt(den) : -1;
    }
    static void KeepVoiceMatch(List<VoiceShapeMatch> list, VoiceShapeMatch item)
    {
        for (int i = 0; i < list.Count; i++)
        {
            var r = list[i].Rect;
            if (Math.Abs((r.Left + r.Right - item.Rect.Left - item.Rect.Right) / 2.0) < item.Rect.Width * .6 &&
                Math.Abs((r.Top + r.Bottom - item.Rect.Top - item.Rect.Bottom) / 2.0) < item.Rect.Height * .6)
            {
                if (item.Score > list[i].Score)
                    list[i] = item;
                return;
            }
        }
        list.Add(item);
        list.Sort(delegate(VoiceShapeMatch a, VoiceShapeMatch b) { return b.Score.CompareTo(a.Score); });
        if (list.Count > 16)
            list.RemoveAt(list.Count - 1);
    }
    static VoiceShapeMatch FindVoiceShape(byte[] gray, int width, int height, int dpi, string kind,
                                          List<VoiceShape> shapes, Action guard)
    {
        var fine = new List<VoiceShapeMatch>();
        long deadline = Now() + 750;
        foreach (var source in shapes)
        {
            if (source.Kind != kind)
                continue;
            foreach (double delta in new[] { .97, 1.0, 1.03 })
            {
                guard();
                Need(Now() < deadline, "VOICE_ADAPTIVE_MATCH_TIMEOUT");
                var shape = ResizeVoiceShape(source, dpi, delta);
                if (shape.Width > width || shape.Height > height)
                    continue;
                var coarse = new List<VoiceShapeMatch>();
                for (int y = 0; y <= height - shape.Height; y += 2)
                {
                    if (y % 12 == 0)
                    {
                        guard();
                        Need(Now() < deadline, "VOICE_ADAPTIVE_MATCH_TIMEOUT");
                    }
                    for (int x = 0; x <= width - shape.Width; x += 2)
                    {
                        double score = VoiceCorrelation(gray, width, x, y, shape, 4);
                        if (score > .65)
                            KeepVoiceMatch(
                                coarse, new VoiceShapeMatch { Rect = new Rect(x, y, x + shape.Width, y + shape.Height),
                                                              Score = score });
                    }
                }
                foreach (var match in coarse)
                {
                    for (int y = Math.Max(0, match.Rect.Top - 2);
                         y <= Math.Min(height - shape.Height, match.Rect.Top + 2); y++)
                        for (int x = Math.Max(0, match.Rect.Left - 2);
                             x <= Math.Min(width - shape.Width, match.Rect.Left + 2); x++)
                        {
                            double score = VoiceCorrelation(gray, width, x, y, shape, 1);
                            if (score > .75)
                                KeepVoiceMatch(fine, new VoiceShapeMatch {
                                    Rect = new Rect(x, y, x + shape.Width, y + shape.Height), Score = score
                                });
                        }
                }
            }
        }
        guard();
        Need(fine.Count > 0, "VOICE_ADAPTIVE_CONTROL_UNCERTAIN");
        fine.Sort(delegate(VoiceShapeMatch a, VoiceShapeMatch b) { return b.Score.CompareTo(a.Score); });
        Need(fine[0].Score >= .89, "VOICE_ADAPTIVE_CONTROL_UNCERTAIN");
        Need(fine.Count == 1 || fine[0].Score - fine[1].Score >= .07, "VOICE_ADAPTIVE_CONTROL_AMBIGUOUS");
        return fine[0];
    }
    static void VoiceAdaptivePair(byte[] rgba, int width, int height, int dpi, Rect toolbar, List<VoiceShape> shapes,
                                  Action guard, out VoiceTemplate cancel, out VoiceTemplate submit,
                                  out double cancelScore, out double submitScore)
    {
        byte[] gray = VoiceGray(rgba);
        var a = FindVoiceShape(gray, width, height, dpi, "cancel", shapes, guard);
        var b = FindVoiceShape(gray, width, height, dpi, "submit", shapes, guard);
        double scale = dpi / 120.0;
        Need(a.Rect.Right + 30 * scale < b.Rect.Left && b.Rect.Right > width - 75 * scale &&
                 Math.Abs((a.Rect.Top + a.Rect.Bottom - b.Rect.Top - b.Rect.Bottom) / 2.0) < 10 * scale &&
                 !Intersects(a.Rect, b.Rect),
             "VOICE_ADAPTIVE_ROLES_UNCERTAIN");
        cancel = new VoiceTemplate { Rect = new Rect(toolbar.Left + a.Rect.Left, toolbar.Top + a.Rect.Top,
                                                     toolbar.Left + a.Rect.Right, toolbar.Top + a.Rect.Bottom),
                                     Hash = VoiceRgbaAreaHash(rgba, width, a.Rect) };
        submit = new VoiceTemplate { Rect = new Rect(toolbar.Left + b.Rect.Left, toolbar.Top + b.Rect.Top,
                                                     toolbar.Left + b.Rect.Right, toolbar.Top + b.Rect.Bottom),
                                     Hash = VoiceRgbaAreaHash(rgba, width, b.Rect) };
        cancelScore = a.Score;
        submitScore = b.Score;
    }
    static string VoiceRgbaAreaHash(byte[] rgba, int width, Rect rect)
    {
        byte[] pixels = new byte[rect.Width * rect.Height * 4];
        for (int y = 0; y < rect.Height; y++)
            Buffer.BlockCopy(rgba, ((rect.Top + y) * width + rect.Left) * 4, pixels, y * rect.Width * 4,
                             rect.Width * 4);
        return PixelHash(pixels);
    }
    static void BindVoiceAdaptive(VoiceRequest request, long revision)
    {
        if (request.Adaptive == null || request.Cancel != null)
            return;
        long started = Now();
        VoiceAdaptiveDiagnostic = Data("requested", true, "bound", false);
        VoiceGuard(request, revision, 2);
        NoKeysHeld();
        Rect area = request.Adaptive.Toolbar, screen = request.Binding.Capture;
        for (int y = area.Top; y < area.Bottom; y += 24)
            for (int x = area.Left; x < area.Right; x += 24)
                Need(Owned(WindowFromPoint(new Point(screen.Left + x, screen.Top + y)), request.Binding.Window,
                           request.Binding.Pid),
                     "VOICE_ADAPTIVE_OBSCURED");
        byte[] rgba;
        using (var image = new Bitmap(area.Width, area.Height, PixelFormat.Format32bppRgb))
        {
            using (var graphics = Graphics.FromImage(image))
                graphics.CopyFromScreen(screen.Left + area.Left, screen.Top + area.Top, 0, 0,
                                        new Size(area.Width, area.Height), CopyPixelOperation.SourceCopy);
            rgba = VoiceBitmapRgba(image);
        }
        VoiceTemplate cancel, submit;
        double a, b;
        VoiceAdaptivePair(rgba, area.Width, area.Height, (int)request.Binding.Dpi, area, LoadVoiceShapes(),
                          delegate { VoiceGuard(request, revision, 2); }, out cancel, out submit, out a, out b);
        VoiceGuard(request, revision, 2);
        NoKeysHeld();
        Need(!Intersects(cancel.Rect, request.MousePark) && !Intersects(submit.Rect, request.MousePark) &&
                 TemplateMatches(request, cancel) && TemplateMatches(request, submit),
             "VOICE_ADAPTIVE_CHANGED");
        // Only a complete pair commits. A failed/partial match leaves both null
        // so the existing error cleanup cannot click an unverified cancel.
        request.Cancel = cancel;
        request.Submit = submit;
        request.AdaptiveBound = true;
        request.AdaptiveCancelScore = a;
        request.AdaptiveSubmitScore = b;
        VoiceAdaptiveDiagnostic = Data("requested", true, "bound", true, "cancelScore", a, "submitScore", b,
                                       "elapsedMs", Now() - started, "pixelGuardsFixed", true);
    }
    static int VoiceAdaptiveSelfTest()
    {
        int checks = 0;
        var shapes = LoadVoiceShapes();
        Need(shapes.Count == 4, "TEST_ADAPTIVE_RESOURCES");
        checks++;
        var binding = new Request { Client = new Rect(0, 0, 1100, 800), Dpi = 120 };
        var record = new Rect(966, 741, 995, 775);
        var park = new Rect(450, 10, 490, 20);
        var valid = Data("version", 1, "executableVersion", VoiceAdaptiveVersion, "toolbarRect",
                         new Rect(389, 720, 1080, 781).Report());
        Need(ParseVoiceAdaptive(valid, binding, record, park).Toolbar.Top == 720, "TEST_ADAPTIVE_PARSE");
        checks++;
        foreach (string change in new[] { "version", "executableVersion", "extra", "outside", "top", "size", "record",
                                          "park" })
        {
            var item = new Dictionary<string, object>(valid);
            Rect start = record, mouse = park;
            if (change == "version")
                item["version"] = 2;
            else if (change == "executableVersion")
                item["executableVersion"] = "4.1.15.57";
            else if (change == "extra")
                item["template"] = new string('a', 64);
            else if (change == "outside")
                item["toolbarRect"] = new Rect(389, 720, 1101, 781).Report();
            else if (change == "top")
                item["toolbarRect"] = new Rect(389, 10, 1080, 71).Report();
            else if (change == "size")
                item["toolbarRect"] = new Rect(389, 600, 1080, 781).Report();
            else if (change == "record")
                start = new Rect(10, 10, 40, 40);
            else
                mouse = new Rect(400, 740, 420, 760);
            Expect(delegate { ParseVoiceAdaptive(item, binding, start, mouse); }, "VOICE_ADAPTIVE_PLAN_INVALID");
            checks++;
        }
        Need(!TemplateMatches(null, null) && !RecordingUi(new VoiceRequest()),
             "TEST_ADAPTIVE_UNBOUND_CANNOT_CANCEL_OR_SUBMIT");
        checks++;
        foreach (int dpi in new[] { 120, 144, 192 })
        {
            int width = 600, height = 90, top = 10;
            byte[] rgba = new byte[width * height * 4];
            for (int i = 0; i < rgba.Length; i += 4)
            {
                rgba[i] = rgba[i + 1] = rgba[i + 2] = 31;
                rgba[i + 3] = 255;
            }
            foreach (string kind in new[] { "cancel", "submit" })
            {
                var source = shapes.Find(delegate(VoiceShape s) { return s.Kind == kind && s.Dpi == 120; });
                var sample = ResizeVoiceShape(source, dpi, 1);
                int left = kind == "cancel" ? 240 : width - sample.Width - 10;
                for (int y = 0; y < sample.Height; y++)
                    for (int x = 0; x < sample.Width; x++)
                    {
                        int i = ((y + top) * width + x + left) * 4;
                        rgba[i] = rgba[i + 1] = rgba[i + 2] = sample.Gray[y * sample.Width + x];
                    }
            }
            VoiceTemplate a, b;
            double sa, sb;
            VoiceAdaptivePair(rgba, width, height, dpi, new Rect(0, 0, width, height), shapes, delegate {}, out a,
                              out b, out sa, out sb);
            Need(a.Rect.Right < b.Rect.Left && Hex(a.Hash, 64) && Hex(b.Hash, 64) && sa >= .89 && sb >= .89,
                 "TEST_ADAPTIVE_MATCH");
            checks++;
            byte[] swapped = (byte[])rgba.Clone();
            for (int y = 0; y < height; y++)
                for (int x = 0; x < width; x++)
                {
                    int to = (y * width + x) * 4, from = (y * width + width - 1 - x) * 4;
                    Buffer.BlockCopy(rgba, from, swapped, to, 4);
                }
            bool rejected = false;
            try
            {
                VoiceAdaptivePair(swapped, width, height, dpi, new Rect(0, 0, width, height), shapes, delegate {},
                                  out a, out b, out sa, out sb);
            }
            catch (Fault)
            {
                rejected = true;
            }
            Need(rejected, "TEST_ADAPTIVE_ROLE_REJECTION");
            checks++;
            var duplicate = ResizeVoiceShape(
                shapes.Find(delegate(VoiceShape shape) { return shape.Kind == "cancel" && shape.Dpi == 120; }), dpi, 1);
            for (int y = 0; y < duplicate.Height; y++)
                for (int x = 0; x < duplicate.Width; x++)
                {
                    int i = ((y + top) * width + x + 100) * 4;
                    rgba[i] = rgba[i + 1] = rgba[i + 2] = duplicate.Gray[y * duplicate.Width + x];
                }
            Expect(delegate {
                VoiceAdaptivePair(rgba, width, height, dpi, new Rect(0, 0, width, height), shapes, delegate {}, out a,
                                  out b, out sa, out sb);
            }, "VOICE_ADAPTIVE_CONTROL_AMBIGUOUS");
            checks++;
            bool stopped = false;
            try
            {
                VoiceAdaptivePair(rgba, width, height, dpi, new Rect(0, 0, width, height), shapes, delegate {
                    throw new Fault("DRAFT_HUMAN_ACTIVITY_CHANGED");
                }, out a, out b, out sa, out sb);
            }
            catch (Fault error)
            {
                stopped = error.Message == "DRAFT_HUMAN_ACTIVITY_CHANGED";
            }
            Need(stopped, "TEST_ADAPTIVE_ACTIVITY_REVOKES_MATCH");
            checks++;
        }
        return checks;
    }
    static int VoiceAdaptiveImageCheck(string[] args)
    {
        try
        {
            Need(args.Length == 7, "VOICE_ADAPTIVE_CHECK_ARGUMENTS");
            string file = Path.GetFullPath(args[1]);
            Need(Path.IsPathRooted(args[1]) && File.Exists(file) && new FileInfo(file).Length <= 16 * 1024 * 1024,
                 "VOICE_ADAPTIVE_CHECK_ARGUMENTS");
            int dpi = Int32.Parse(args[2]);
            Rect area =
                new Rect(Int32.Parse(args[3]), Int32.Parse(args[4]), Int32.Parse(args[5]), Int32.Parse(args[6]));
            VoiceTemplate cancel, submit;
            double a, b;
            using (var source = new Bitmap(file))
            {
                Need(source.Width <= 4096 && source.Height <= 4096 &&
                         Contains(new Rect(0, 0, source.Width, source.Height), area) && dpi >= 96 && dpi <= 240,
                     "VOICE_ADAPTIVE_CHECK_ARGUMENTS");
                using (var image = source.Clone(new Rectangle(area.Left, area.Top, area.Width, area.Height),
                                                PixelFormat.Format32bppRgb))
                {
                    byte[] rgba = VoiceBitmapRgba(image);
                    VoiceAdaptivePair(rgba, image.Width, image.Height, dpi, area, LoadVoiceShapes(), delegate {},
                                      out cancel, out submit, out a, out b);
                }
            }
            Write(Data("ok", true, "readOnly", true, "desktopAccessed", false, "inputSent", false, "recordingStarted",
                       false, "cancel", Data("rect", cancel.Rect.Report(), "rgbaSha256", cancel.Hash, "score", a),
                       "submit", Data("rect", submit.Rect.Report(), "rgbaSha256", submit.Hash, "score", b)));
            return 0;
        }
        catch (Exception error)
        {
            Write(Data("ok", false, "readOnly", true, "inputSent", false, "reason", VoiceSafeReason(error)));
            return 1;
        }
    }
}
