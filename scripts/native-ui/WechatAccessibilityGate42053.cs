// Qt accessibility-gate discovery was informed by fanyuantaier/wechatauto-replica,
// wechatauto/accessibility.py (Apache-2.0):
// https://github.com/fanyuantaier/wechatauto-replica/blob/main/wechatauto/accessibility.py
// This profile supports only the exact 4.2.0.53 build below. The gate is
// WeChat-specific accessible-interface creation, not a public Qt isActive symbol. It does
// not inject code, patch instructions, activate windows or send user input.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Web.Script.Serialization;

internal static class WechatAccessibilityGate42053
{
    const string CoreHash = "ac6b174d98ee1b69e95c99a7a39c3197c8c167b7c6d32f5b72c7a7659c104825";
    const string Version = "4.2.0.53";
    const string Profile = "wechat-accessible-interface-creation-42053-v1";
    const uint PinnedGateRva = 0xb4aa448, PinnedInstructionRva = 0x861d22, PinnedLabelRva = 0x9143e18;
    const uint PinnedFunctionRva = 0x861d00;
    const uint PinnedImageSize = 204644352, PinnedTimestamp = 1794391333;
    const int PinnedFunctionSize = 1880;
    const string PinnedFunctionHash = "6877228c5910b8e787826874a3271c628122836772dd55e1e167fa12dde48c3f";
    const uint PinnedGetterRva = 0x862520, PinnedSetterRva = 0x862530;
    static readonly byte[] PinnedInstruction = { 0x48, 0x85, 0xc9, 0x0f, 0x84, 0xf7, 0x06, 0x00, 0x00, 0x80, 0x3d,
                                                 0x16, 0x87, 0xc4, 0x0a, 0x00, 0x0f, 0x84, 0xea, 0x06, 0x00, 0x00 };
    static readonly byte[] PinnedGetter = { 0x0f, 0xb6, 0x05, 0x21, 0x7f, 0xc4, 0x0a, 0xc3 };
    static readonly byte[] PinnedSetter = { 0x88, 0x0d, 0x12, 0x7f, 0xc4, 0x0a, 0xc3 };
    static readonly uint[] PinnedReferences = { 0x8613fd, 0x862d81, 0x862dca, 0x8631a5, 0x8631ee };
    const uint Execute = 0x20000000, Write = 0x80000000, Read = 0x40000000;
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 65536, RecursionLimit = 20 };
    static bool WriteAttempted;
    static int BytesWritten;
    sealed class Fault : Exception
    {
        internal Fault(string code) : base(code)
        {
        }
    }
    static void Need(bool value, string code)
    {
        if (!value)
            throw new Fault(code);
    }
    static Dictionary<string, object> Data(params object[] pairs)
    {
        var d = new Dictionary<string, object>();
        for (int i = 0; i < pairs.Length; i += 2)
            d.Add((string)pairs[i], pairs[i + 1]);
        return d;
    }
    static object Get(Dictionary<string, object> d, string k)
    {
        object v;
        return d != null && d.TryGetValue(k, out v) ? v : null;
    }
    static string Str(Dictionary<string, object> d, string k)
    {
        return Get(d, k) as string;
    }
    static string Id(long v)
    {
        return v.ToString(CultureInfo.InvariantCulture);
    }
    static long DecimalId(object v)
    {
        long n;
        string s = v as string;
        Need(s != null && s.Length <= 19 && Int64.TryParse(s, NumberStyles.None, CultureInfo.InvariantCulture, out n) &&
                 n > 0,
             "ACCESSIBILITY_ID_INVALID");
        return Int64.Parse(s, CultureInfo.InvariantCulture);
    }
    static long Num(object v)
    {
        Need(v is int || v is long || v is uint, "ACCESSIBILITY_NUMBER_INVALID");
        return Convert.ToInt64(v, CultureInfo.InvariantCulture);
    }
    static string Hash(byte[] bytes)
    {
        using (var s = SHA256.Create()) return BitConverter.ToString(s.ComputeHash(bytes))
            .Replace("-", "")
            .ToLowerInvariant();
    }
    static string Local(string p)
    {
        Need(!String.IsNullOrEmpty(p) && p.Length < 1024 && Path.IsPathRooted(p) && !p.StartsWith(@"\\") &&
                 p.IndexOfAny(new[] { '\0', '\r', '\n' }) < 0,
             "ACCESSIBILITY_PATH_INVALID");
        p = Path.GetFullPath(p);
        for (string at = p; !String.IsNullOrEmpty(at); at = Path.GetDirectoryName(at))
        {
            if (File.Exists(at) || Directory.Exists(at))
                Need((File.GetAttributes(at) & FileAttributes.ReparsePoint) == 0, "ACCESSIBILITY_LINK_REJECTED");
        }
        return p;
    }
    static bool SamePath(string a, string b)
    {
        return String.Equals(Path.GetFullPath(a), Path.GetFullPath(b), StringComparison.OrdinalIgnoreCase);
    }
    static byte[] ReadFile(string p, int max)
    {
        p = Local(p);
        var f = new FileInfo(p);
        Need(f.Exists && f.Length > 0 && f.Length <= max, "ACCESSIBILITY_FILE_INVALID");
        byte[] b = File.ReadAllBytes(p);
        Need(b.Length > 0 && b.Length <= max, "ACCESSIBILITY_FILE_INVALID");
        return b;
    }
    static Dictionary<string, object> Parse(byte[] b)
    {
        var d = Json.DeserializeObject(Encoding.UTF8.GetString(b).TrimStart('\uFEFF')) as Dictionary<string, object>;
        Need(d != null, "ACCESSIBILITY_JSON_INVALID");
        return d;
    }
    static void Range(byte[] b, long at, long length)
    {
        Need(at >= 0 && length >= 0 && at <= b.Length && length <= b.Length - at, "ACCESSIBILITY_PE_INVALID");
    }
    static ushort U16(byte[] b, long at)
    {
        Range(b, at, 2);
        return BitConverter.ToUInt16(b, (int)at);
    }
    static uint U32(byte[] b, long at)
    {
        Range(b, at, 4);
        return BitConverter.ToUInt32(b, (int)at);
    }
    sealed class Section
    {
        internal uint Rva, VirtualSize, Raw, RawSize, Flags;
        internal bool Contains(long r, int n)
        {
            return r >= Rva && r + n <= ((long)Rva + VirtualSize);
        }
    }
    sealed class Pe
    {
        internal uint ImageSize, Timestamp;
        internal List<Section> Sections = new List<Section>();
    }
    static Pe Header(byte[] b)
    {
        Need(U16(b, 0) == 0x5a4d, "ACCESSIBILITY_PE_INVALID");
        uint p = U32(b, 0x3c);
        Need(U32(b, p) == 0x4550 && U16(b, p + 4) == 0x8664, "ACCESSIBILITY_PE_INVALID");
        int n = U16(b, p + 6), optional = U16(b, p + 20);
        Need(n > 0 && n <= 96 && optional >= 112 && U16(b, p + 24) == 0x20b, "ACCESSIBILITY_PE_INVALID");
        Range(b, (long)p + 24, optional + (long)n * 40);
        var pe = new Pe { ImageSize = U32(b, p + 24 + 56), Timestamp = U32(b, p + 8) };
        Need(pe.ImageSize > 0 && pe.ImageSize <= 512 * 1024 * 1024, "ACCESSIBILITY_PE_INVALID");
        for (int i = 0; i < n; i++)
        {
            long a = (long)p + 24 + optional + i * 40;
            var s = new Section { VirtualSize = U32(b, a + 8), Rva = U32(b, a + 12), RawSize = U32(b, a + 16),
                                  Raw = U32(b, a + 20), Flags = U32(b, a + 36) };
            Range(b, s.Raw, s.RawSize);
            Need((long)s.Rva + s.VirtualSize <= pe.ImageSize, "ACCESSIBILITY_PE_INVALID");
            foreach (var old in pe.Sections)
                Need((long)s.Rva + s.VirtualSize <= old.Rva || (long)old.Rva + old.VirtualSize <= s.Rva,
                     "ACCESSIBILITY_PE_INVALID");
            pe.Sections.Add(s);
        }
        return pe;
    }
    static Section SectionAt(Pe pe, long r, int n)
    {
        Section found = null;
        foreach (var s in pe.Sections)
            if (s.Contains(r, n))
            {
                Need(found == null, "ACCESSIBILITY_PE_INVALID");
                found = s;
            }
        return found;
    }
    static int Offset(Pe pe, uint r, int n)
    {
        var s = SectionAt(pe, r, n);
        Need(s != null && (long)r - s.Rva + n <= s.RawSize, "ACCESSIBILITY_PE_INVALID");
        return checked((int)(s.Raw + r - s.Rva));
    }
    static bool Match(byte[] b, int at, byte[] p)
    {
        if (at < 0 || at > b.Length - p.Length)
            return false;
        for (int i = 0; i < p.Length; i++)
            if (b[at + i] != p[i])
                return false;
        return true;
    }
    sealed class Gate
    {
        internal Pe Pe;
        internal uint Rva, InstructionRva, CoreStringRva;
        internal List<uint> References = new List<uint>();
    }
    static Gate Locate(byte[] b)
    {
        var pe = Header(b);
        byte[] label = Encoding.ASCII.GetBytes("qt.accessibility.core\0");
        var labels = new List<uint>();
        foreach (var s in pe.Sections)
            if ((s.Flags & Read) != 0 && (s.Flags & (Write | Execute)) == 0)
                for (int i = 0; i + (long)label.Length <= s.RawSize; i++)
                    if (b[(int)s.Raw + i] == label[0] && Match(b, (int)s.Raw + i, label))
                        labels.Add(s.Rva + (uint)i);
        Need(labels.Count == 1, "ACCESSIBILITY_LABEL_AMBIGUOUS");
        uint labelRva = labels[0];
        var refs = new List<uint>();
        foreach (var s in pe.Sections)
            if ((s.Flags & Execute) != 0 && (s.Flags & Write) == 0)
                for (int i = 0; i + 7L <= s.RawSize; i++)
                {
                    int o = (int)s.Raw + i;
                    if (b[o] >= 0x40 && b[o] <= 0x4f && b[o + 1] == 0x8d && (b[o + 2] & 0xc7) == 5 &&
                        (long)s.Rva + i + 7 + BitConverter.ToInt32(b, o + 3) == labelRva)
                        refs.Add(s.Rva + (uint)i);
                }
        Need(refs.Count > 0, "ACCESSIBILITY_REFERENCE_MISSING");
        var candidates = new List<Gate>();
        foreach (var s in pe.Sections)
            if ((s.Flags & Execute) != 0 && (s.Flags & Write) == 0)
                for (int i = 0; i + 18L <= s.RawSize; i++)
                {
                    int o = (int)s.Raw + i;
                    if (b[o] != 0x48 || b[o + 1] != 0x85 || b[o + 2] != 0xc9 || b[o + 3] != 0x0f || b[o + 4] != 0x84 ||
                        b[o + 9] != 0x80 || b[o + 10] != 0x3d || b[o + 15] != 0 || b[o + 16] != 0x0f ||
                        b[o + 17] != 0x84)
                        continue;
                    uint code = s.Rva + (uint)i;
                    long target = (long)code + 16 + BitConverter.ToInt32(b, o + 11);
                    var data = SectionAt(pe, target, 1);
                    if (data == null || (data.Flags & (Read | Write)) != (Read | Write) || (data.Flags & Execute) != 0)
                        continue;
                    bool near = false;
                    foreach (uint r in refs)
                        if (Math.Abs((long)code - r) <= 0x20000)
                            near = true;
                    if (near)
                        candidates.Add(new Gate { Pe = pe, Rva = (uint)target, InstructionRva = code,
                                                  CoreStringRva = labelRva, References = refs });
                }
        Need(candidates.Count == 1, "ACCESSIBILITY_GATE_AMBIGUOUS");
        return candidates[0];
    }
    static void VerifyPinned(Gate gate, byte[] instruction)
    {
        Need(gate.Rva == PinnedGateRva && gate.InstructionRva == PinnedInstructionRva &&
                 gate.CoreStringRva == PinnedLabelRva && Equal(instruction, PinnedInstruction),
             "ACCESSIBILITY_GATE_FINGERPRINT_MISMATCH");
    }
    static void VerifyCodeBytes(byte[] actual, byte[] expected)
    {
        Need(Equal(actual, expected), "ACCESSIBILITY_GATE_FINGERPRINT_MISMATCH");
    }
    static void VerifyProfileCode(Pe pe, byte[] bytes)
    {
        VerifyCodeBytes(Slice(bytes, Offset(pe, PinnedGetterRva, PinnedGetter.Length), PinnedGetter.Length),
                        PinnedGetter);
        VerifyCodeBytes(Slice(bytes, Offset(pe, PinnedSetterRva, PinnedSetter.Length), PinnedSetter.Length),
                        PinnedSetter);
        Need(Hash(Slice(bytes, Offset(pe, PinnedFunctionRva, PinnedFunctionSize), PinnedFunctionSize)) ==
                 PinnedFunctionHash,
             "ACCESSIBILITY_GATE_FUNCTION_MISMATCH");
        // This exact function contains no PE base relocations; mapped bytes
        // therefore have the same fingerprint at every legitimate load base.
        uint header = U32(bytes, 0x3c), table = U32(bytes, header + 24 + 112 + 3 * 8),
             size = U32(bytes, header + 24 + 112 + 3 * 8 + 4);
        int found = 0;
        Need(size > 0 && size % 12 == 0, "ACCESSIBILITY_GATE_FUNCTION_MISMATCH");
        int at = Offset(pe, table, checked((int)size));
        for (int end = checked(at + (int)size); at < end; at += 12)
            if (U32(bytes, at) == PinnedFunctionRva && U32(bytes, at + 4) == PinnedFunctionRva + PinnedFunctionSize)
                found++;
        Need(found == 1, "ACCESSIBILITY_GATE_FUNCTION_MISMATCH");
    }
    static Gate LocatePinned(byte[] bytes)
    {
        var gate = Locate(bytes);
        Need(gate.Pe.ImageSize == PinnedImageSize && gate.Pe.Timestamp == PinnedTimestamp,
             "ACCESSIBILITY_GATE_IMAGE_MISMATCH");
        VerifyPinned(gate, Slice(bytes, Offset(gate.Pe, gate.InstructionRva, PinnedInstruction.Length),
                                 PinnedInstruction.Length));
        Need(gate.References.Count == PinnedReferences.Length, "ACCESSIBILITY_GATE_REFERENCES_CHANGED");
        for (int i = 0; i < PinnedReferences.Length; i++)
            Need(gate.References[i] == PinnedReferences[i], "ACCESSIBILITY_GATE_REFERENCES_CHANGED");
        VerifyProfileCode(gate.Pe, bytes);
        return gate;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct FileTime
    {
        internal uint Low, High;
        internal long Ticks
        {
            get {
                return ((long)High << 32) | Low;
            }
        }
    }
    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct ModuleEntry
    {
        internal uint Size, ModuleId, ProcessId, GlobalCount, ProcessCount;
        internal IntPtr Base;
        internal uint BaseSize;
        internal IntPtr Module;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 256)]
        internal string Name;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 260)]
        internal string Path;
    }
    [StructLayout(LayoutKind.Sequential)]
    struct MemoryInfo
    {
        internal IntPtr Base, AllocationBase;
        internal uint AllocationProtect;
        internal ushort PartitionId;
        internal UIntPtr RegionSize;
        internal uint State, Protect, Type;
    }
    sealed class Handle : IDisposable
    {
        internal IntPtr Value;
        internal Handle(IntPtr v)
        {
            Need(v != IntPtr.Zero && v != new IntPtr(-1), "ACCESSIBILITY_PROCESS_UNAVAILABLE");
            Value = v;
        }
        public void Dispose()
        {
            if (Value != IntPtr.Zero)
            {
                CloseHandle(Value);
                Value = IntPtr.Zero;
            }
        }
    }
    sealed class Binding
    {
        internal string ConfigPath, ConfigHash, Exe, ExeHash;
        internal IntPtr Window;
        internal uint Pid;
        internal long Created;
    }
    static Binding Config(Dictionary<string, object> request)
    {
        Need(Num(Get(request, "version")) == 1, "ACCESSIBILITY_REQUEST_INVALID");
        string path = Local(Str(request, "configPath"));
        byte[] bytes = ReadFile(path, 65536);
        var config = Parse(bytes);
        Need(Str(config, "backend") == "accessibility-gate" && Num(Get(config, "version")) == 1 &&
                 Str(config, "executableVersion") == Version,
             "ACCESSIBILITY_BUILD_UNSUPPORTED");
        string exe = Local(Str(config, "executable")), hash = Str(config, "executableSha256");
        Need(String.Equals(Path.GetFileName(exe), "Weixin.exe", StringComparison.OrdinalIgnoreCase) && hash != null &&
                 System.Text.RegularExpressions.Regex.IsMatch(hash, "^[a-f0-9]{64}$"),
             "ACCESSIBILITY_CONFIG_INVALID");
        Need(FileVersionInfo.GetVersionInfo(exe).FileVersion == Version &&
                 Hash(ReadFile(exe, 64 * 1024 * 1024)) == hash,
             "ACCESSIBILITY_EXECUTABLE_CHANGED");
        return new Binding { ConfigPath = path,
                             ConfigHash = Hash(bytes),
                             Exe = exe,
                             ExeHash = hash,
                             Pid = checked((uint)Num(Get(request, "pid"))),
                             Window = new IntPtr(DecimalId(Get(request, "hwnd"))) };
    }
    static uint WindowPid(Binding b)
    {
        Need(IsWindow(b.Window) && GetAncestor(b.Window, 2) == b.Window, "ACCESSIBILITY_WINDOW_CHANGED");
        var name = new StringBuilder(256);
        Need(GetClassName(b.Window, name, name.Capacity) > 0 && name.ToString() == "Qt51514QWindowIcon",
             "ACCESSIBILITY_WINDOW_CLASS_CHANGED");
        uint pid;
        Need(GetWindowThreadProcessId(b.Window, out pid) != 0 && pid > 0, "ACCESSIBILITY_WINDOW_CHANGED");
        return pid;
    }
    static long Created(IntPtr process)
    {
        FileTime c, e, k, u;
        Need(GetProcessTimes(process, out c, out e, out k, out u), "ACCESSIBILITY_PROCESS_UNAVAILABLE");
        return c.Ticks;
    }
    static void VerifyBinding(Binding b, IntPtr process)
    {
        Need(WindowPid(b) == b.Pid && Created(process) == b.Created && WaitForSingleObject(process, 0) == 258,
             "ACCESSIBILITY_BINDING_CHANGED");
        var p = new StringBuilder(32768);
        uint n = (uint)p.Capacity;
        Need(QueryFullProcessImageName(process, 0, p, ref n) && SamePath(p.ToString(), b.Exe),
             "ACCESSIBILITY_EXECUTABLE_CHANGED");
        uint session;
        Need(ProcessIdToSessionId(b.Pid, out session) && session == (uint)Process.GetCurrentProcess().SessionId,
             "ACCESSIBILITY_SESSION_CHANGED");
        Need(Hash(ReadFile(b.ConfigPath, 65536)) == b.ConfigHash, "ACCESSIBILITY_CONFIG_CHANGED");
    }
    static Dictionary<string, object> BindingData(Binding b)
    {
        return Data("hwnd", Id(b.Window.ToInt64()), "pid", b.Pid, "processCreatedFileTimeUtc", Id(b.Created),
                    "executable", b.Exe, "executableSha256", b.ExeHash, "executableVersion", Version, "configSha256",
                    b.ConfigHash, "coreSha256", CoreHash);
    }
    static void Expected(Dictionary<string, object> expected, Dictionary<string, object> actual)
    {
        Need(expected != null, "ACCESSIBILITY_PREPARED_REQUEST_REQUIRED");
        foreach (string key in actual.Keys)
            Need(Get(expected, key) != null &&
                     String.Equals(Convert.ToString(Get(expected, key), CultureInfo.InvariantCulture),
                                   Convert.ToString(actual[key], CultureInfo.InvariantCulture),
                                   StringComparison.Ordinal),
                 "ACCESSIBILITY_BINDING_CHANGED");
    }
    static ModuleEntry Core(uint pid)
    {
        using (var snapshot = new Handle(CreateToolhelp32Snapshot(0x18, pid)))
        {
            var entry = new ModuleEntry { Size = (uint)Marshal.SizeOf(typeof(ModuleEntry)) };
            Need(Module32First(snapshot.Value, ref entry), "ACCESSIBILITY_MODULES_UNAVAILABLE");
            var result = new ModuleEntry();
            int count = 0;
            do
            {
                if (String.Equals(entry.Name, "Weixin.dll", StringComparison.OrdinalIgnoreCase))
                {
                    result = entry;
                    count++;
                }
            } while (Module32Next(snapshot.Value, ref entry));
            Need(Marshal.GetLastWin32Error() == 18 && count == 1, "ACCESSIBILITY_CORE_AMBIGUOUS");
            return result;
        }
    }
    static byte[] Remote(IntPtr p, IntPtr a, int n)
    {
        var b = new byte[n];
        UIntPtr done;
        Need(ReadProcessMemory(p, a, b, (UIntPtr)n, out done) && done.ToUInt64() == (ulong)n,
             "ACCESSIBILITY_MEMORY_READ_FAILED");
        return b;
    }
    static IntPtr Address(ModuleEntry module, uint rva)
    {
        Need(rva < module.BaseSize, "ACCESSIBILITY_ADDRESS_INVALID");
        return new IntPtr(checked(module.Base.ToInt64() + rva));
    }
    static bool Equal(byte[] a, byte[] b)
    {
        if (a.Length != b.Length)
            return false;
        for (int i = 0; i < a.Length; i++)
            if (a[i] != b[i])
                return false;
        return true;
    }
    static byte[] Slice(byte[] b, int at, int n)
    {
        Range(b, at, n);
        var v = new byte[n];
        Buffer.BlockCopy(b, at, v, 0, n);
        return v;
    }
    static void VerifyMapped(IntPtr process, ModuleEntry module, Gate gate, byte[] bytes)
    {
        Need(module.BaseSize == gate.Pe.ImageSize, "ACCESSIBILITY_LOADED_IMAGE_CHANGED");
        byte[] dos = Remote(process, module.Base, 64);
        Need(Equal(dos, Slice(bytes, 0, 64)), "ACCESSIBILITY_LOADED_IMAGE_CHANGED");
        uint pe = U32(bytes, 0x3c);
        Need(Equal(Remote(process, Address(module, pe), 24), Slice(bytes, (int)pe, 24)),
             "ACCESSIBILITY_LOADED_IMAGE_CHANGED");
        Need(Equal(Remote(process, Address(module, gate.InstructionRva), PinnedInstruction.Length), PinnedInstruction),
             "ACCESSIBILITY_LOADED_CODE_CHANGED");
        foreach (uint r in gate.References)
            Need(Equal(Remote(process, Address(module, r), 7), Slice(bytes, Offset(gate.Pe, r, 7), 7)),
                 "ACCESSIBILITY_LOADED_CODE_CHANGED");
        Need(Equal(Remote(process, Address(module, gate.CoreStringRva), 22),
                   Slice(bytes, Offset(gate.Pe, gate.CoreStringRva, 22), 22)),
             "ACCESSIBILITY_LOADED_CODE_CHANGED");
        MemoryInfo m;
        Need(VirtualQueryEx(process, Address(module, gate.Rva), out m, (UIntPtr)Marshal.SizeOf(typeof(MemoryInfo))) !=
                 (UIntPtr)0,
             "ACCESSIBILITY_MEMORY_QUERY_FAILED");
        Need(Equal(Remote(process, Address(module, PinnedGetterRva), PinnedGetter.Length), PinnedGetter) &&
                 Equal(Remote(process, Address(module, PinnedSetterRva), PinnedSetter.Length), PinnedSetter),
             "ACCESSIBILITY_LOADED_CODE_CHANGED");
        Need(Hash(Remote(process, Address(module, PinnedFunctionRva), PinnedFunctionSize)) == PinnedFunctionHash,
             "ACCESSIBILITY_LOADED_CODE_CHANGED");
        VerifyPage(m, module.Base, Address(module, gate.Rva));
    }
    static void VerifyPage(MemoryInfo m, IntPtr image, IntPtr target)
    {
        Need(m.State == 0x1000 && m.Type == 0x1000000 && m.AllocationBase == image &&
                 (m.Protect == 0x04 || m.Protect == 0x08) && m.Base.ToInt64() <= target.ToInt64() &&
                 (ulong)(target.ToInt64() - m.Base.ToInt64()) < m.RegionSize.ToUInt64(),
             "ACCESSIBILITY_GATE_PAGE_REJECTED");
    }
    static void GateValue(byte v)
    {
        Need(v == 0 || v == 1, "ACCESSIBILITY_GATE_VALUE_INVALID");
    }
    static bool ShouldWrite(bool enable, byte before)
    {
        GateValue(before);
        return enable && before == 0;
    }
    static object Run(Dictionary<string, object> request, bool enable)
    {
        Binding b = Config(request);
        Need(b.Pid > 0 && WindowPid(b) == b.Pid, "ACCESSIBILITY_BINDING_CHANGED");
        if (enable)
            Need(Get(request, "expected") is Dictionary<string, object>, "ACCESSIBILITY_PREPARED_REQUEST_REQUIRED");
        const uint readAccess = 0x1000 | 0x0010 | 0x00100000;
        using (var process = new Handle(OpenProcess(readAccess, false, b.Pid)))
        {
            b.Created = Created(process.Value);
            VerifyBinding(b, process.Value);
            var binding = BindingData(b);
            if (enable)
                Expected(Get(request, "expected") as Dictionary<string, object>, binding);
            ModuleEntry module = Core(b.Pid);
            string core = Local(module.Path);
            Need(SamePath(core, Path.Combine(Path.GetDirectoryName(b.Exe), Version, "Weixin.dll")),
                 "ACCESSIBILITY_CORE_PATH_CHANGED");
            byte[] bytes = ReadFile(core, 256 * 1024 * 1024);
            Need(Hash(bytes) == CoreHash && FileVersionInfo.GetVersionInfo(core).FileVersion == Version,
                 "ACCESSIBILITY_CORE_HASH_MISMATCH");
            var gate = LocatePinned(bytes);
            VerifyMapped(process.Value, module, gate, bytes);
            byte before = Remote(process.Value, Address(module, gate.Rva), 1)[0];
            GateValue(before);
            bool acquired = false;
            using (var mutex = new Mutex(false, @"Local\WeChatAgent.AccessibilityGate." +
                                                    b.Pid.ToString(CultureInfo.InvariantCulture)))
            {
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
                    Need(acquired, "ACCESSIBILITY_GATE_BUSY");
                    VerifyBinding(b, process.Value);
                    if (enable)
                    {
                        Expected(Get(request, "expected") as Dictionary<string, object>, BindingData(b));
                        ModuleEntry current = Core(b.Pid);
                        Need(current.Base == module.Base && current.BaseSize == module.BaseSize &&
                                 SamePath(current.Path, module.Path),
                             "ACCESSIBILITY_LOADED_IMAGE_CHANGED");
                        VerifyMapped(process.Value, module, gate, bytes);
                        before = Remote(process.Value, Address(module, gate.Rva), 1)[0];
                        GateValue(before);
                        // Already enabled is a no-op, including no write-capable
                        // handle. Only a still-bound, inspected zero may change.
                        if (ShouldWrite(true, before))
                            using (var writer = new Handle(OpenProcess(readAccess | 0x0020 | 0x0008, false, b.Pid)))
                            {
                                VerifyBinding(b, writer.Value);
                                Expected(Get(request, "expected") as Dictionary<string, object>, BindingData(b));
                                VerifyMapped(writer.Value, module, gate, bytes);
                                before = Remote(writer.Value, Address(module, gate.Rva), 1)[0];
                                GateValue(before);
                                if (ShouldWrite(true, before))
                                {
                                    UIntPtr done;
                                    WriteAttempted = true;
                                    bool written = WriteProcessMemory(writer.Value, Address(module, gate.Rva),
                                                                      new byte[] { 1 }, (UIntPtr)1, out done);
                                    BytesWritten = checked((int)done.ToUInt64());
                                    Need(written && BytesWritten == 1, "ACCESSIBILITY_MEMORY_WRITE_FAILED");
                                }
                            }
                    }
                    byte after = Remote(process.Value, Address(module, gate.Rva), 1)[0];
                    GateValue(after);
                    if (enable)
                        Need(after == 1, "ACCESSIBILITY_GATE_READBACK_FAILED");
                    VerifyBinding(b, process.Value);
                    return Data("ok", true, "version", 1, "profile", Profile, "mode", enable ? "enable" : "inspect",
                                "binding", binding, "candidateRequest",
                                Data("version", 1, "configPath", b.ConfigPath, "hwnd", Id(b.Window.ToInt64()), "pid",
                                     b.Pid, "expected", binding),
                                "gateRva", gate.Rva, "gateEnabled", after == 1, "previousGateEnabled", before == 1,
                                "memoryWriteAttempted", WriteAttempted, "bytesWritten", BytesWritten, "inputSent",
                                false, "controlsVerified", false, "backgroundSendingVerified", false,
                                "publicQtIsActiveSymbol", false);
                }
                finally
                {
                    if (acquired)
                        mutex.ReleaseMutex();
                }
            }
        }
    }
    static void Put(byte[] b, int at, uint value)
    {
        Buffer.BlockCopy(BitConverter.GetBytes(value), 0, b, at, 4);
    }
    static byte[] Fixture()
    {
        var b = new byte[0x900];
        b[0] = 0x4d;
        b[1] = 0x5a;
        Put(b, 0x3c, 0x80);
        Put(b, 0x80, 0x4550);
        b[0x84] = 0x64;
        b[0x85] = 0x86;
        b[0x86] = 3;
        b[0x94] = 0xf0;
        b[0x98] = 0x0b;
        b[0x99] = 2;
        Put(b, 0xd0, 0x4000);
        for (int i = 0; i < 3; i++)
        {
            int s = 0x188 + i * 40;
            Put(b, s + 8, 0x200);
            Put(b, s + 12, (uint)(0x1000 + i * 0x1000));
            Put(b, s + 16, 0x200);
            Put(b, s + 20, (uint)(0x300 + i * 0x200));
            Put(b, s + 36, i == 0 ? Read | Execute : i == 1 ? Read : Read | Write);
        }
        byte[] label = Encoding.ASCII.GetBytes("qt.accessibility.core\0");
        Buffer.BlockCopy(label, 0, b, 0x500, label.Length);
        b[0x300] = 0x48;
        b[0x301] = 0x8d;
        b[0x302] = 0x0d;
        Put(b, 0x303, 0x2000 - 0x1007);
        byte[] pattern = { 0x48, 0x85, 0xc9, 0x0f, 0x84, 1, 0, 0, 0, 0x80, 0x3d, 0, 0, 0, 0, 0, 0x0f, 0x84 };
        Buffer.BlockCopy(pattern, 0, b, 0x320, 18);
        Put(b, 0x32b, 0x3000 - 0x1030);
        return b;
    }
    static void Reject(Action action, string code)
    {
        try
        {
            action();
        }
        catch (Fault f)
        {
            Need(f.Message == code, "ACCESSIBILITY_SELFTEST_FAILED");
            return;
        }
        throw new Fault("ACCESSIBILITY_SELFTEST_FAILED");
    }
    static object SelfTest()
    {
        var b = Fixture();
        var g = Locate(b);
        Need(g.Rva == 0x3000 && g.InstructionRva == 0x1020, "ACCESSIBILITY_SELFTEST_FAILED");
        var duplicate = (byte[])b.Clone();
        Buffer.BlockCopy(b, 0x320, duplicate, 0x360, 18);
        Put(duplicate, 0x36b, 0x3001 - 0x1070);
        Reject(() => Locate(duplicate), "ACCESSIBILITY_GATE_AMBIGUOUS");
        var executable = (byte[])b.Clone();
        Put(executable, 0x188 + 80 + 36, Read | Write | Execute);
        Reject(() => Locate(executable), "ACCESSIBILITY_GATE_AMBIGUOUS");
        var bad = (byte[])b.Clone();
        Put(bad, 0x3c, 0xfffffff0);
        Reject(() => Locate(bad), "ACCESSIBILITY_PE_INVALID");
        Reject(() => Locate(new byte[3]), "ACCESSIBILITY_PE_INVALID");
        var label = (byte[])b.Clone();
        label[0x500] = 0;
        Reject(() => Locate(label), "ACCESSIBILITY_LABEL_AMBIGUOUS");
        var outOfBounds = (byte[])b.Clone();
        Put(outOfBounds, 0x32b, 0x4000 - 0x1030);
        Reject(() => Locate(outOfBounds), "ACCESSIBILITY_GATE_AMBIGUOUS");
        GateValue(0);
        GateValue(1);
        Reject(() => GateValue(2), "ACCESSIBILITY_GATE_VALUE_INVALID");
        Expected(Data("pid", 1, "processCreatedFileTimeUtc", "2"), Data("pid", 1, "processCreatedFileTimeUtc", "2"));
        Reject(() => Expected(Data("pid", 1, "processCreatedFileTimeUtc", "2"),
                              Data("pid", 1, "processCreatedFileTimeUtc", "3")),
               "ACCESSIBILITY_BINDING_CHANGED");
        Reject(() => Expected(null, Data("pid", 1)), "ACCESSIBILITY_PREPARED_REQUEST_REQUIRED");
        var readonlyData = (byte[])b.Clone();
        Put(readonlyData, 0x188 + 80 + 36, Read);
        Reject(() => Locate(readonlyData), "ACCESSIBILITY_GATE_AMBIGUOUS");
        var writableCode = (byte[])b.Clone();
        Put(writableCode, 0x188 + 36, Read | Write | Execute);
        Reject(() => Locate(writableCode), "ACCESSIBILITY_REFERENCE_MISSING");
        var duplicateLabel = (byte[])b.Clone();
        Buffer.BlockCopy(b, 0x500, duplicateLabel, 0x540, 22);
        Reject(() => Locate(duplicateLabel), "ACCESSIBILITY_LABEL_AMBIGUOUS");
        var wrongRef = (byte[])b.Clone();
        Put(wrongRef, 0x303, 0x2100 - 0x1007);
        Reject(() => Locate(wrongRef), "ACCESSIBILITY_REFERENCE_MISSING");
        var opcode = (byte[])b.Clone();
        opcode[0x329] = 0x81;
        Reject(() => Locate(opcode), "ACCESSIBILITY_GATE_AMBIGUOUS");
        var overlapping = (byte[])b.Clone();
        Put(overlapping, 0x188 + 80 + 12, 0x2000);
        Reject(() => Locate(overlapping), "ACCESSIBILITY_PE_INVALID");
        var pinned =
            new Gate { Rva = PinnedGateRva, InstructionRva = PinnedInstructionRva, CoreStringRva = PinnedLabelRva };
        VerifyPinned(pinned, PinnedInstruction);
        Reject(() => VerifyPinned(g, PinnedInstruction), "ACCESSIBILITY_GATE_FINGERPRINT_MISMATCH");
        var changed = (byte[])PinnedInstruction.Clone();
        changed[5] ^= 1;
        Reject(() => VerifyPinned(pinned, changed), "ACCESSIBILITY_GATE_FINGERPRINT_MISMATCH");
        var page = new MemoryInfo { Base = new IntPtr(0x5000),
                                    AllocationBase = new IntPtr(0x1000),
                                    RegionSize = (UIntPtr)0x1000,
                                    State = 0x1000,
                                    Type = 0x1000000,
                                    Protect = 4 };
        VerifyPage(page, new IntPtr(0x1000), new IntPtr(0x5fff));
        Reject(() => VerifyPage(page, new IntPtr(0x2000), new IntPtr(0x5000)), "ACCESSIBILITY_GATE_PAGE_REJECTED");
        Reject(() => VerifyPage(page, new IntPtr(0x1000), new IntPtr(0x6000)), "ACCESSIBILITY_GATE_PAGE_REJECTED");
        foreach (uint flags in new uint[] { 2, 0x40, 0x80, 0x104 })
        {
            var rejected = page;
            rejected.Protect = flags;
            Reject(() => VerifyPage(rejected, new IntPtr(0x1000), new IntPtr(0x5000)),
                   "ACCESSIBILITY_GATE_PAGE_REJECTED");
        }
        var privatePage = page;
        privatePage.Type = 0x20000;
        Reject(() => VerifyPage(privatePage, new IntPtr(0x1000), new IntPtr(0x5000)),
               "ACCESSIBILITY_GATE_PAGE_REJECTED");
        var reservedPage = page;
        reservedPage.State = 0x2000;
        Reject(() => VerifyPage(reservedPage, new IntPtr(0x1000), new IntPtr(0x5000)),
               "ACCESSIBILITY_GATE_PAGE_REJECTED");

        Need(ShouldWrite(true, 0) && !ShouldWrite(true, 1) && !ShouldWrite(false, 0) && !ShouldWrite(false, 1),
             "ACCESSIBILITY_SELFTEST_FAILED");
        Reject(() => ShouldWrite(true, 2), "ACCESSIBILITY_GATE_VALUE_INVALID");
        VerifyCodeBytes(PinnedGetter, (byte[])PinnedGetter.Clone());
        VerifyCodeBytes(PinnedSetter, (byte[])PinnedSetter.Clone());
        var badGetter = (byte[])PinnedGetter.Clone();
        badGetter[0] ^= 1;
        Reject(() => VerifyCodeBytes(badGetter, PinnedGetter), "ACCESSIBILITY_GATE_FINGERPRINT_MISMATCH");
        var badSetter = (byte[])PinnedSetter.Clone();
        badSetter[badSetter.Length - 1] ^= 1;
        Reject(() => VerifyCodeBytes(badSetter, PinnedSetter), "ACCESSIBILITY_GATE_FINGERPRINT_MISMATCH");
        Need(PinnedInstruction.Length == 22 && PinnedGetter.Length == 8 && PinnedSetter.Length == 7,
             "ACCESSIBILITY_SELFTEST_FAILED");
        return Data("ok", true, "tests", 40, "profile", Profile, "processAccessed", false, "memoryWriteAttempted",
                    false, "inputSent", false);
    }
    static int Main(string[] args)
    {
        try
        {
            if (args.Length == 1 && args[0] == "--self-test")
            {
                Console.WriteLine(Json.Serialize(SelfTest()));
                return 0;
            }
            if (args.Length == 2 && args[0] == "--scan-file")
            {
                byte[] b = ReadFile(args[1], 256 * 1024 * 1024);
                Need(Hash(b) == CoreHash, "ACCESSIBILITY_CORE_HASH_MISMATCH");
                var g = LocatePinned(b);
                Console.WriteLine(Json.Serialize(
                    Data("ok", true, "profile", Profile, "functionSha256", PinnedFunctionHash, "processAccessed", false,
                         "controlsVerified", false, "coreSha256", CoreHash, "gateRva", g.Rva, "instructionRva",
                         g.InstructionRva, "coreStringRva", g.CoreStringRva, "referenceRvas", g.References, "inputSent",
                         false, "memoryWriteAttempted", false)));
                return 0;
            }
            bool enable = false, allow = false, mode = false;
            string request = null;
            for (int i = 0; i < args.Length; i++)
            {
                if (args[i] == "--inspect" || args[i] == "--enable")
                {
                    Need(!mode, "ACCESSIBILITY_ARGUMENT_INVALID");
                    mode = true;
                    enable = args[i] == "--enable";
                }
                else if (args[i] == "--allow-gate-write")
                {
                    Need(!allow, "ACCESSIBILITY_ARGUMENT_INVALID");
                    allow = true;
                }
                else if (args[i] == "--request")
                {
                    Need(request == null && i + 1 < args.Length, "ACCESSIBILITY_ARGUMENT_INVALID");
                    request = args[++i];
                }
                else
                    throw new Fault("ACCESSIBILITY_ARGUMENT_INVALID");
            }
            Need(mode && request != null && allow == enable, "ACCESSIBILITY_EXPLICIT_ENABLE_REQUIRED");
            Need(IntPtr.Size == 8, "ACCESSIBILITY_X64_REQUIRED");
            Console.WriteLine(Json.Serialize(Run(Parse(ReadFile(request, 65536)), enable)));
            return 0;
        }
        catch (Exception error)
        {
            string code = error is Fault ? error.Message : "ACCESSIBILITY_OPERATION_FAILED";
            Console.WriteLine(Json.Serialize(Data("ok", false, "code", code, "memoryWriteAttempted", WriteAttempted,
                                                  "bytesWritten", BytesWritten, "inputSent", false, "controlsVerified",
                                                  false, "backgroundSendingVerified", false)));
            return 1;
        }
    }
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr h);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint WaitForSingleObject(IntPtr h, uint ms);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool GetProcessTimes(IntPtr h, out FileTime c, out FileTime e, out FileTime k, out FileTime u);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool QueryFullProcessImageName(IntPtr h, uint flags, StringBuilder path, ref uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool ProcessIdToSessionId(uint pid, out uint session);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint pid);
    [DllImport("kernel32.dll", EntryPoint = "Module32FirstW", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool Module32First(IntPtr h, ref ModuleEntry m);
    [DllImport("kernel32.dll", EntryPoint = "Module32NextW", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool Module32Next(IntPtr h, ref ModuleEntry m);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool ReadProcessMemory(IntPtr h, IntPtr at, [Out] byte[] buffer, UIntPtr size, out UIntPtr done);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool WriteProcessMemory(IntPtr h, IntPtr at, byte[] buffer, UIntPtr size, out UIntPtr done);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern UIntPtr VirtualQueryEx(IntPtr h, IntPtr at, out MemoryInfo info, UIntPtr length);
    [DllImport("user32.dll")]
    static extern bool IsWindow(IntPtr h);
    [DllImport("user32.dll")]
    static extern IntPtr GetAncestor(IntPtr h, uint flags);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    static extern int GetClassName(IntPtr h, StringBuilder name, int size);
    [DllImport("user32.dll")]
    static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
}
