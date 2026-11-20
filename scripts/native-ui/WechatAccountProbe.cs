// Read-only process/database-handle evidence. No injection, memory inspection,
// UI automation or privilege escalation. This is not a desktop/chat identity gate.
// Even two matching scans are non-atomic: a process may retain stale databases,
// close/reuse handles or change accounts during/after observation. The maximum
// evidence age is a consumer freshness bound, never a login-validity guarantee.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Web.Script.Serialization;

static class WechatAccountProbe
{
    const uint QueryInformation = 0x0400, DuplicateHandles = 0x0040, Synchronize = 0x00100000;
    const uint FileReadAttributes = 0x80, ShareAll = 7, OpenExisting = 3, BackupSemantics = 0x02000000;
    const uint SameAccess = 2, FileTypeDisk = 1, FileTypeChar = 2, FileTypePipe = 3, WaitTimeout = 258;
    const int MaximumBytes = 16 * 1024 * 1024, MaximumHandles = 65536, DeadlineMs = 4000;
    static readonly IntPtr InvalidHandle = new IntPtr(-1);
    static readonly JavaScriptSerializer Json = new JavaScriptSerializer { MaxJsonLength = 32768, RecursionLimit = 16 };
    static readonly Regex CoreDatabase = new Regex(@"^(?:contact\\contact\.db|session\\session\.db|message\\message_[0-9]+\.db)(?:-wal|-shm)?$", RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
    sealed class Fault : Exception {
        internal readonly string Code, UnknownObjectClass; internal readonly uint? UnknownDeviceType;
        internal Fault(string code, uint? unknownDeviceType = null, string unknownObjectClass = null) : base(code) {
            Code = code; UnknownDeviceType = unknownDeviceType; UnknownObjectClass = unknownObjectClass;
        }
    }
    sealed class Config { internal int Pid; internal long Created; internal string Executable, AccountDirectory; }
    sealed class Scan {
        internal int Files, Disks, Databases, Devices, NamedDevices;
        // Kernel-normalized paths are compared exactly. Folding case could join
        // distinct account folders on a Windows case-sensitive directory.
        internal readonly HashSet<string> Roots = new HashSet<string>(StringComparer.Ordinal);
        internal readonly HashSet<string> DiskPaths = new HashSet<string>(StringComparer.Ordinal);
        internal readonly HashSet<string> DatabasePaths = new HashSet<string>(StringComparer.Ordinal);
        internal readonly HashSet<uint> DeviceTypes = new HashSet<uint>();
        internal readonly HashSet<string> DeviceNames = new HashSet<string>(StringComparer.Ordinal);
    }
    [StructLayout(LayoutKind.Sequential)] struct Entry {
        internal IntPtr Handle; internal UIntPtr HandleCount, PointerCount;
        internal uint GrantedAccess, ObjectTypeIndex, Attributes, Reserved;
    }
    [StructLayout(LayoutKind.Sequential)] struct FileTime {
        internal uint Low, High;
        internal long Value { get { return unchecked((long)(((ulong)High << 32) | Low)); } }
    }
    [StructLayout(LayoutKind.Sequential)] struct DeviceInfo {
        internal int Size; internal Guid ClassGuid; internal uint DeviceInstance; internal UIntPtr Reserved;
    }
    static readonly Guid MediaSetupClass = new Guid("4d36e96c-e325-11ce-bfc1-08002be10318");
    static readonly Regex KsEnumeratorName = new Regex(@"\A\\Device\\KSENUM#[0-9A-Fa-f]{8}\z", RegexOptions.CultureInvariant | RegexOptions.IgnoreCase);
    [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate int QueryProcess(IntPtr process, uint kind, IntPtr data, uint size, out uint required);
    [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate int QueryVolume(IntPtr file, IntPtr status, IntPtr data, uint size, uint kind);
    [UnmanagedFunctionPointer(CallingConvention.Winapi)] delegate int QueryObject(IntPtr handle, uint kind, IntPtr data, uint size, out uint required);

    static void Require(bool value, string code) { if (!value) throw new Fault(code); }
    static Dictionary<string, object> Data(params object[] values) {
        var result = new Dictionary<string, object>();
        for (int i = 0; i < values.Length; i += 2) result.Add((string)values[i], values[i + 1]);
        return result;
    }
    static Dictionary<string, object> Denied(string code, uint? unknownDeviceType = null, string unknownObjectClass = null) {
        var result = Data("ok", false, "reason", code, "complete", false, "processOpenedExpectedDatabase", false,
            "ready", false, "desktopAccountVerified", false, "targetVerified", false, "draftVerified", false, "inputSent", false);
        if (code == "UI_ACCOUNT_DEVICE_UNCLASSIFIED" && unknownDeviceType.HasValue) {
            result.Add("unknownDeviceType", unknownDeviceType.Value);
            result.Add("unknownDeviceTypeHex", "0x" + unknownDeviceType.Value.ToString("X8", CultureInfo.InvariantCulture));
            if (unknownObjectClass != null) result.Add("unknownObjectClass", unknownObjectClass);
        }
        return result;
    }
    static string LocalPath(string value) {
        Require(value != null && value.Length <= 32700 && Regex.IsMatch(value, @"^[A-Za-z]:[\\/]") && value.IndexOfAny(new char[] { '\0', '*', '?' }) < 0, "UI_ACCOUNT_PATH_INVALID");
        string result;
        try { result = Path.GetFullPath(value).TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar); }
        catch { throw new Fault("UI_ACCOUNT_PATH_INVALID"); }
        Require(result.Length > 3 && result.Substring(3).IndexOf(':') < 0, "UI_ACCOUNT_PATH_INVALID");
        foreach (string part in result.Substring(3).Split(Path.DirectorySeparatorChar)) Require(!part.EndsWith(".", StringComparison.Ordinal) && !part.EndsWith(" ", StringComparison.Ordinal), "UI_ACCOUNT_PATH_INVALID");
        return result;
    }
    static void NoLinks(string file) {
        string current = file;
        for (int count = 0; current != null; count++) {
            Require(count < 256, "UI_ACCOUNT_PATH_INVALID");
            FileAttributes attributes;
            try { attributes = File.GetAttributes(current); } catch { throw new Fault("UI_ACCOUNT_PATH_UNAVAILABLE"); }
            Require((attributes & FileAttributes.ReparsePoint) == 0, "UI_ACCOUNT_PATH_LINK_REFUSED");
            current = Path.GetDirectoryName(current);
        }
    }
    static Config ReadConfig(string file) {
        file = LocalPath(file); NoLinks(file);
        Require(File.Exists(file) && new FileInfo(file).Length <= 16384, "UI_ACCOUNT_CONFIG_INVALID");
        Dictionary<string, object> value;
        try { value = Json.DeserializeObject(File.ReadAllText(file, Encoding.UTF8)) as Dictionary<string, object>; }
        catch { throw new Fault("UI_ACCOUNT_CONFIG_INVALID"); }
        Require(value != null && value.Count == 5 && value.ContainsKey("version") && value.ContainsKey("processId") &&
            value.ContainsKey("processCreatedFileTimeUtc") && value.ContainsKey("executable") && value.ContainsKey("expectedAccountDirectory"), "UI_ACCOUNT_CONFIG_INVALID");
        Require(value["version"] is int && (int)value["version"] == 1 && value["processId"] is int && (int)value["processId"] > 0, "UI_ACCOUNT_CONFIG_INVALID");
        long created; string stamp = value["processCreatedFileTimeUtc"] as string;
        Require(stamp != null && Regex.IsMatch(stamp, @"^[1-9][0-9]{0,18}$") && Int64.TryParse(stamp, NumberStyles.None, CultureInfo.InvariantCulture, out created), "UI_ACCOUNT_CONFIG_INVALID");
        created = Int64.Parse(stamp, CultureInfo.InvariantCulture);
        return new Config { Pid = (int)value["processId"], Created = created, Executable = LocalPath(value["executable"] as string), AccountDirectory = LocalPath(value["expectedAccountDirectory"] as string) };
    }
    static QueryProcess Api() {
        Require(IntPtr.Size == 8 && Marshal.SizeOf(typeof(Entry)) == 40, "UI_ACCOUNT_ARCH_UNSUPPORTED");
        IntPtr address = GetProcAddress(GetModuleHandle("ntdll.dll"), "NtQueryInformationProcess");
        Require(address != IntPtr.Zero, "UI_ACCOUNT_QUERY_UNAVAILABLE");
        return (QueryProcess)Marshal.GetDelegateForFunctionPointer(address, typeof(QueryProcess));
    }
    static void SnapshotLength(uint required, int capacity, long count) {
        Require(required >= 16 && required <= capacity && count >= 0 && count <= MaximumHandles &&
            count <= (required - 16) / 40, "UI_ACCOUNT_SNAPSHOT_INVALID");
    }
    static List<Entry> Snapshot(IntPtr process, QueryProcess query) {
        int size = 65536;
        for (int attempt = 0; attempt < 3; attempt++) {
            IntPtr memory = Marshal.AllocHGlobal(size);
            try {
                uint required; int status = query(process, 51, memory, (uint)size, out required);
                if (status < 0) {
                    if (required > size && required <= MaximumBytes - 4096) { size = checked((int)required + 4096); continue; }
                    throw new Fault("UI_ACCOUNT_HANDLE_QUERY_FAILED");
                }
                Require(status == 0, "UI_ACCOUNT_HANDLE_QUERY_FAILED");
                Require(required >= 16 && required <= size, "UI_ACCOUNT_SNAPSHOT_INVALID");
                long count = Marshal.ReadInt64(memory);
                SnapshotLength(required, size, count);
                var result = new List<Entry>(); var handles = new HashSet<long>();
                for (int i = 0; i < count; i++) {
                    Entry entry = (Entry)Marshal.PtrToStructure(IntPtr.Add(memory, 16 + i * 40), typeof(Entry));
                    Require(entry.Handle.ToInt64() > 0 && entry.ObjectTypeIndex > 0 && handles.Add(entry.Handle.ToInt64()), "UI_ACCOUNT_SNAPSHOT_INVALID");
                    result.Add(entry);
                }
                result.Sort(delegate(Entry a, Entry b) { return a.Handle.ToInt64().CompareTo(b.Handle.ToInt64()); });
                return result;
            } finally { Marshal.FreeHGlobal(memory); }
        }
        throw new Fault("UI_ACCOUNT_SNAPSHOT_UNSTABLE");
    }
    static bool SameSnapshot(List<Entry> a, List<Entry> b) {
        if (a.Count != b.Count) return false;
        for (int i = 0; i < a.Count; i++) if (a[i].Handle != b[i].Handle || a[i].ObjectTypeIndex != b[i].ObjectTypeIndex ||
            a[i].GrantedAccess != b[i].GrantedAccess || a[i].Attributes != b[i].Attributes) return false;
        return true;
    }
    static string FinalPath(IntPtr file) {
        var name = new StringBuilder(32768);
        // A volume GUID avoids drive-letter aliases. Network/unknown volumes
        // that cannot supply a normalized path make this scan incomplete.
        uint length = GetFinalPathNameByHandle(file, name, (uint)name.Capacity, 1);
        Require(length > 0 && length < name.Capacity, "UI_ACCOUNT_PATH_QUERY_FAILED");
        string result = name.ToString().Replace('/', '\\').TrimEnd('\\');
        Require(result.StartsWith(@"\\?\Volume{", StringComparison.OrdinalIgnoreCase) && result.IndexOf('\0') < 0, "UI_ACCOUNT_PATH_QUERY_FAILED");
        return result;
    }
    static void Classify(string file, string expected, Scan scan) {
        const string marker = @"\db_storage\";
        int at = file.LastIndexOf(marker, StringComparison.OrdinalIgnoreCase);
        if (at < 0) return;
        string root = file.Substring(0, at), suffix = file.Substring(at + marker.Length);
        Require(root.Length > 0 && suffix.Length > 0, "UI_ACCOUNT_PATH_QUERY_FAILED");
        // Even an unfamiliar database family under a different account root
        // prevents a single-account claim. Positive evidence uses strict names.
        scan.Roots.Add(root);
        if (CoreDatabase.IsMatch(suffix)) {
            scan.DatabasePaths.Add(file);
            if (String.Equals(root, expected, StringComparison.Ordinal)) scan.Databases++;
        }
    }
    static Scan ScanPaths(IntPtr process, List<Entry> entries, uint fileType, string expected) {
        var scan = new Scan();
        foreach (Entry entry in entries) {
            if (entry.ObjectTypeIndex != fileType) continue;
            scan.Files++; IntPtr copy;
            if (!DuplicateHandle(process, entry.Handle, GetCurrentProcess(), out copy, 0, false, SameAccess)) {
                if (Marshal.GetLastWin32Error() == 6) return null;
                throw new Fault("UI_ACCOUNT_ENUMERATION_INCOMPLETE");
            }
            try {
                SetLastError(0);
                uint kind = GetFileType(copy); int error = Marshal.GetLastWin32Error();
                if (kind == FileTypeChar || kind == FileTypePipe) continue;
                if (kind == 0 && error == 0) {
                    string node; scan.DeviceTypes.Add(KnownNonFilesystemDevice(copy, out node)); scan.Devices++;
                    if (node.Length > 0) { scan.DeviceNames.Add(node); scan.NamedDevices++; }
                    continue;
                }
                Require(kind == FileTypeDisk, error == 0 ? "UI_ACCOUNT_FILE_TYPE_UNKNOWN" : "UI_ACCOUNT_FILE_TYPE_QUERY_FAILED");
                scan.Disks++; string path = FinalPath(copy); scan.DiskPaths.Add(path); Classify(path, expected, scan);
            } finally { Require(CloseHandle(copy), "UI_ACCOUNT_DUPLICATE_CLOSE_FAILED"); }
        }
        return scan;
    }
    static uint KnownNonFilesystemDevice(IntPtr file, out string namedNode) {
        namedNode = String.Empty;
        // FILE_FS_DEVICE_INFORMATION + IO_STATUS_BLOCK, x64 layout:
        // https://learn.microsoft.com/windows-hardware/drivers/ddi/wdm/ns-wdm-_file_fs_device_information
        // https://learn.microsoft.com/windows-hardware/drivers/ddi/ntifs/nf-ntifs-zwqueryvolumeinformationfile
        IntPtr address = GetProcAddress(GetModuleHandle("ntdll.dll"), "NtQueryVolumeInformationFile");
        Require(address != IntPtr.Zero, "UI_ACCOUNT_DEVICE_QUERY_UNAVAILABLE");
        var query = (QueryVolume)Marshal.GetDelegateForFunctionPointer(address, typeof(QueryVolume));
        IntPtr memory = Marshal.AllocHGlobal(24); bool release = true;
        try {
            for (int i = 0; i < 24; i++) Marshal.WriteByte(memory, i, 0);
            int status = query(file, memory, IntPtr.Add(memory, 16), 8, 4);
            // A pending I/O may still hold the buffer. Keep it until this bounded
            // helper exits; never use an asynchronously written stack structure.
            if (status == 259) { release = false; throw new Fault("UI_ACCOUNT_DEVICE_QUERY_PENDING"); }
            Require(status == 0 && Marshal.ReadInt64(memory) == 0 && Marshal.ReadInt64(memory, 8) == 8, "UI_ACCOUNT_DEVICE_QUERY_FAILED");
            uint device = unchecked((uint)Marshal.ReadInt32(memory, 16));
            // Microsoft-defined FILE_DEVICE_KSEC/FIPS/CRYPT_PROVIDER/CONSOLE.
            // These explicit non-filesystem classes cannot contain a database.
            // Every other UNKNOWN device remains an incomplete scan.
            if (!IsKnownNonFilesystemDevice(device)) {
                string name = ObjectName(file);
                if (!IsKnownNamedNonFilesystemDevice(device, name) && !PresentKsMediaDevice(device, name))
                    throw new Fault("UI_ACCOUNT_DEVICE_UNCLASSIFIED", device, ObjectNameClass(name));
                namedNode = name;
            }
            return device;
        } finally { if (release) Marshal.FreeHGlobal(memory); }
    }
    static bool IsKnownNamedNonFilesystemDevice(uint device, string name) {
        // Microsoft identifies the exact DeviceApi node as owned by
        // \Driver\DeviceApi, distinct from \FileSystem\Ntfs:
        // https://learn.microsoft.com/windows-hardware/drivers/debuggercmds/-processirps
        // A different type, case, prefix, suffix or child path is not accepted.
        // NSI is restricted to its exact network-device node. FILE_DEVICE_NETWORK
        // (0x12) is distinct from NETWORK_FILE_SYSTEM (0x14) and REDIRECTOR (0x28):
        // https://learn.microsoft.com/windows-hardware/drivers/kernel/specifying-device-types
        // Multimedia clients can hold the MMCSS scheduler device itself. Only
        // the bare control node is classified, never child paths on device type 0x22.
        return (device == 0x22 && (name == @"\Device\DeviceApi" || name == @"\Device\MMCSS")) || (device == 0x12 && name == @"\Device\Nsi");
    }
    // SetupAPI associates a physical device object name with its present PnP
    // devnode. A name prefix or FILE_DEVICE_UNKNOWN alone cannot prove this.
    // https://learn.microsoft.com/windows-hardware/drivers/install/devpkey-device-pdoname
    static bool IsKsMediaDevice(uint type, string name, Guid setupClass, string pdo, string service) {
        return type == 0x22 && KsEnumeratorName.IsMatch(name) && setupClass == MediaSetupClass &&
            String.Equals(name, pdo, StringComparison.Ordinal) && String.Equals(service, "MSKSSRV", StringComparison.OrdinalIgnoreCase);
    }
    static string DeviceProperty(IntPtr set, ref DeviceInfo device, uint property) {
        // SPDRP_PHYSICAL_DEVICE_OBJECT_NAME and SPDRP_SERVICE are REG_SZ.
        byte[] bytes = new byte[1024]; uint type, size;
        if (!SetupDiGetDeviceRegistryPropertyW(set, ref device, property, out type, bytes, (uint)bytes.Length, out size) ||
            type != 1 || size < 4 || size > bytes.Length || (size & 1) != 0) return null;
        string value = Encoding.Unicode.GetString(bytes, 0, (int)size);
        return value.IndexOf('\0') == value.Length - 1 ? value.Substring(0, value.Length - 1) : null;
    }
    static bool PresentKsMediaDevice(uint type, string name) {
        if (type != 0x22 || !KsEnumeratorName.IsMatch(name)) return false;
        Guid media = MediaSetupClass;
        IntPtr set = SetupDiGetClassDevsW(ref media, null, IntPtr.Zero, 2 /* DIGCF_PRESENT */);
        if (set == InvalidHandle) return false;
        try {
            for (uint index = 0; index < 256; index++) {
                var device = new DeviceInfo { Size = Marshal.SizeOf(typeof(DeviceInfo)) };
                if (!SetupDiEnumDeviceInfo(set, index, ref device)) break;
                string pdo = DeviceProperty(set, ref device, 14);
                if (pdo == name && IsKsMediaDevice(type, name, device.ClassGuid, pdo, DeviceProperty(set, ref device, 4))) return true;
            }
            return false;
        } finally { SetupDiDestroyDeviceInfoList(set); }
    }
    static string ObjectName(IntPtr file) {
        IntPtr address = GetProcAddress(GetModuleHandle("ntdll.dll"), "NtQueryObject");
        Require(address != IntPtr.Zero, "UI_ACCOUNT_OBJECT_QUERY_UNAVAILABLE");
        var query = (QueryObject)Marshal.GetDelegateForFunctionPointer(address, typeof(QueryObject));
        int size = 1024;
        for (int attempt = 0; attempt < 3; attempt++) {
            IntPtr memory = Marshal.AllocHGlobal(size);
            try {
                uint required; int status = query(file, 1, memory, (uint)size, out required);
                if (status != 0) {
                    if (required > size && required <= 65536) { size = (int)required; continue; }
                    throw new Fault("UI_ACCOUNT_OBJECT_QUERY_FAILED");
                }
                return DecodeObjectName(memory, required, size);
            } finally { Marshal.FreeHGlobal(memory); }
        }
        throw new Fault("UI_ACCOUNT_OBJECT_NAME_INVALID");
    }
    static string DecodeObjectName(IntPtr memory, uint required, int capacity) {
        Require(required >= 16 && required <= capacity, "UI_ACCOUNT_OBJECT_NAME_INVALID");
        int length = unchecked((ushort)Marshal.ReadInt16(memory));
        int maximum = unchecked((ushort)Marshal.ReadInt16(memory, 2));
        Require((length & 1) == 0 && (maximum & 1) == 0 && length <= maximum, "UI_ACCOUNT_OBJECT_NAME_INVALID");
        if (length == 0) return String.Empty;
        IntPtr pointer = Marshal.ReadIntPtr(memory, 8); long offset = pointer.ToInt64() - memory.ToInt64();
        Require(offset >= 16 && offset <= required && maximum <= required - offset, "UI_ACCOUNT_OBJECT_NAME_INVALID");
        string name = Marshal.PtrToStringUni(pointer, length / 2);
        Require(name != null && name.IndexOf('\0') < 0, "UI_ACCOUNT_OBJECT_NAME_INVALID");
        return name;
    }
    static string ObjectNameClass(string name) {
        // Diagnostic labels are a fixed vocabulary; never emit raw object names.
        if (String.Equals(name, @"\Device\Afd", StringComparison.OrdinalIgnoreCase)) return "afd-device-node";
        if (String.Equals(name, @"\Device\Afd\Endpoint", StringComparison.OrdinalIgnoreCase)) return "afd-endpoint";
        if (String.Equals(name, @"\Device\Afd\AsyncConnectHlp", StringComparison.OrdinalIgnoreCase)) return "afd-async-helper";
        if (String.Equals(name, @"\Device\ConDrv", StringComparison.OrdinalIgnoreCase)) return "console-driver-node";
        if (String.Equals(name, @"\Device\ConDrv\Connect", StringComparison.OrdinalIgnoreCase)) return "console-driver-connect";
        if (String.Equals(name, @"\Device\CNG", StringComparison.OrdinalIgnoreCase)) return "cng-device-node";
        if (String.Equals(name, @"\Device\KsecDD", StringComparison.OrdinalIgnoreCase)) return "ksec-device-node";
        if (String.Equals(name, @"\Device\Nsi", StringComparison.OrdinalIgnoreCase)) return "nsi-device-node";
        if (String.Equals(name, @"\Device\WMIDataDevice", StringComparison.OrdinalIgnoreCase)) return "wmi-data-device-node";
        foreach (string device in new string[] { "DxgKrnl", "DxgKrnlPipe", "Tcp", "Tcp6", "Udp", "Udp6", "Ip", "Ip6", "RawIp", "RawIp6", "Http", "Null", "MountPointManager", "Ndis", "NetBT_Tcpip", "NVIDIA0", "NVIDIA1", "Video0", "Video1", "NamedPipe" }) {
            if (String.Equals(name, @"\Device\" + device, StringComparison.OrdinalIgnoreCase)) return "known-name-" + device.ToLowerInvariant();
        }
        if (name.Length == 0) return "unnamed-object";
        if (name.StartsWith(@"\Device\", StringComparison.Ordinal) && name.IndexOf('\\', 8) < 0) {
            return "unclassified-device-node";
        }
        return "unclassified-object-path";
    }
    static bool IsKnownNonFilesystemDevice(uint device) { return device == 0x39 || device == 0x3a || device == 0x3f || device == 0x50; }
    static bool SameScan(Scan a, Scan b) {
        return a != null && b != null && a.Files == b.Files && a.Disks == b.Disks && a.Databases == b.Databases && a.Devices == b.Devices && a.NamedDevices == b.NamedDevices &&
            a.Roots.SetEquals(b.Roots) && a.DiskPaths.SetEquals(b.DiskPaths) && a.DatabasePaths.SetEquals(b.DatabasePaths) && a.DeviceTypes.SetEquals(b.DeviceTypes) && a.DeviceNames.SetEquals(b.DeviceNames);
    }
    static uint VerifyProcess(IntPtr process, Config config) {
        Require(GetProcessId(process) == (uint)config.Pid && WaitForSingleObject(process, 0) == WaitTimeout, "UI_ACCOUNT_PROCESS_CHANGED");
        FileTime created, exited, kernel, user;
        Require(GetProcessTimes(process, out created, out exited, out kernel, out user), "UI_ACCOUNT_PROCESS_QUERY_FAILED");
        Require(created.Value == config.Created, "UI_ACCOUNT_PROCESS_CHANGED");
        var executable = new StringBuilder(32768); uint length = (uint)executable.Capacity;
        Require(QueryFullProcessImageName(process, 0, executable, ref length), "UI_ACCOUNT_PROCESS_QUERY_FAILED");
        Require(String.Equals(LocalPath(executable.ToString()), config.Executable, StringComparison.Ordinal), "UI_ACCOUNT_EXECUTABLE_MISMATCH");
        uint actualSession = 0, ownSession = 0;
        Require(ProcessIdToSessionId((uint)config.Pid, out actualSession) && ProcessIdToSessionId(GetCurrentProcessId(), out ownSession), "UI_ACCOUNT_SESSION_UNAVAILABLE");
        Require(actualSession == ownSession, "UI_ACCOUNT_SESSION_MISMATCH");
        return actualSession;
    }
    static Dictionary<string, object> Probe(Config config) {
        QueryProcess query = Api(); NoLinks(config.Executable); NoLinks(config.AccountDirectory);
        Require(File.Exists(config.Executable) && Directory.Exists(config.AccountDirectory), "UI_ACCOUNT_PATH_UNAVAILABLE");
        IntPtr process = OpenProcess(QueryInformation | DuplicateHandles | Synchronize, false, (uint)config.Pid);
        Require(process != IntPtr.Zero, "UI_ACCOUNT_PROCESS_ACCESS_DENIED");
        IntPtr directory = InvalidHandle;
        try {
            uint session = VerifyProcess(process, config);
            directory = CreateFile(config.AccountDirectory, FileReadAttributes, ShareAll, IntPtr.Zero, OpenExisting, BackupSemantics, IntPtr.Zero);
            Require(directory != InvalidHandle, "UI_ACCOUNT_DIRECTORY_UNAVAILABLE");
            Require(GetFileType(directory) == FileTypeDisk, "UI_ACCOUNT_DIRECTORY_UNAVAILABLE");
            string expected = FinalPath(directory); uint fileType = 0;
            foreach (Entry entry in Snapshot(GetCurrentProcess(), query)) if (entry.Handle == directory) fileType = entry.ObjectTypeIndex;
            Require(fileType > 0, "UI_ACCOUNT_FILE_TYPE_UNAVAILABLE");
            for (int attempt = 0; attempt < 3; attempt++) {
                long started = Stopwatch.GetTimestamp(); List<Entry> before = Snapshot(process, query);
                Scan scan = ScanPaths(process, before, fileType, expected);
                List<Entry> between = Snapshot(process, query);
                if (scan == null || !SameSnapshot(before, between)) continue;
                // Handle values may be reused even when table metadata matches.
                // Two complete path scans improve stability but are not atomic.
                Scan repeated = ScanPaths(process, between, fileType, expected);
                if (!SameScan(scan, repeated) || !SameSnapshot(between, Snapshot(process, query))) continue;
                Require(FinalPath(directory) == expected, "UI_ACCOUNT_DIRECTORY_CHANGED");
                VerifyProcess(process, config);
                Require(scan.Roots.Count > 0, "UI_ACCOUNT_DATABASE_NOT_OBSERVED");
                Require(scan.Roots.Count == 1, "UI_ACCOUNT_MULTIPLE_DATABASE_ROOTS");
                Require(scan.Roots.Contains(expected), "UI_ACCOUNT_DATABASE_MISMATCH");
                Require(scan.Databases > 0, "UI_ACCOUNT_DATABASE_NOT_OBSERVED");
                return Data("ok", true, "proof", "process-open-database-v1", "complete", true, "processOpenedExpectedDatabase", true,
                    "ready", false, "desktopAccountVerified", false, "targetVerified", false, "draftVerified", false, "inputSent", false,
                    "processId", config.Pid, "processCreatedFileTimeUtc", config.Created.ToString(CultureInfo.InvariantCulture), "windowsSessionId", session,
                    "snapshotStartedQpc", started.ToString(CultureInfo.InvariantCulture), "snapshotCompletedQpc", Stopwatch.GetTimestamp().ToString(CultureInfo.InvariantCulture),
                    "qpcFrequency", Stopwatch.Frequency, "observedAtUtc", DateTime.UtcNow.ToString("o"), "maximumEvidenceAgeMs", 500,
                    "snapshotAtomic", false, "consistentPathScans", 2,
                    "handlesInspected", before.Count, "fileHandlesInspected", scan.Files, "diskHandlesInspected", scan.Disks,
                    "knownNonFilesystemDeviceHandles", scan.Devices,
                    "knownNamedNonFilesystemDeviceHandles", scan.NamedDevices,
                    "expectedDatabaseHandles", scan.Databases, "accountRootsObserved", scan.Roots.Count);
            }
            throw new Fault("UI_ACCOUNT_SNAPSHOT_UNSTABLE");
        } finally { if (directory != InvalidHandle) CloseHandle(directory); CloseHandle(process); }
    }
    static void Expect(Config config, string code, ref int checks) {
        try { Probe(config); } catch (Fault failure) { Require(failure.Code == code, "UI_ACCOUNT_SELFTEST_FAILED"); checks++; return; }
        throw new Fault("UI_ACCOUNT_SELFTEST_FAILED");
    }
    static void ExpectFault(Action action, string code, ref int checks) {
        try { action(); } catch (Fault failure) { Require(failure.Code == code, "UI_ACCOUNT_SELFTEST_FAILED"); checks++; return; }
        throw new Fault("UI_ACCOUNT_SELFTEST_FAILED");
    }
    static Dictionary<string, object> SelfTest() {
        int checks = 0; Api(); checks++;
        string root = Path.Combine(Path.GetTempPath(), "wechat-account-probe-selftest-" + Guid.NewGuid().ToString("N"));
        string expected = Path.Combine(root, "fixture_expected"), other = Path.Combine(root, "fixture_other");
        string first = Path.Combine(expected, @"db_storage\contact\contact.db"), second = Path.Combine(other, @"db_storage\message\message_0.db");
        Directory.CreateDirectory(Path.GetDirectoryName(first)); Directory.CreateDirectory(Path.GetDirectoryName(second));
        File.WriteAllText(first, "synthetic probe fixture"); File.WriteAllText(second, "synthetic probe fixture");
        try {
            FileTime created, exited, kernel, user; Require(GetProcessTimes(GetCurrentProcess(), out created, out exited, out kernel, out user), "UI_ACCOUNT_SELFTEST_FAILED");
            string exe = Process.GetCurrentProcess().MainModule.FileName;
            var config = new Config { Pid = (int)GetCurrentProcessId(), Created = created.Value, Executable = LocalPath(exe), AccountDirectory = LocalPath(expected) };
            using (var one = new FileStream(first, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete)) {
                string objectName = ObjectName(one.SafeFileHandle.DangerousGetHandle());
                Require(objectName.StartsWith(@"\Device\", StringComparison.Ordinal) && objectName.EndsWith(@"\db_storage\contact\contact.db", StringComparison.Ordinal), "UI_ACCOUNT_SELFTEST_FAILED"); checks++;
                var proof = Probe(config);
                Require((bool)proof["processOpenedExpectedDatabase"] && (bool)proof["complete"] && !(bool)proof["snapshotAtomic"] &&
                    (int)proof["consistentPathScans"] == 2 && !(bool)proof["ready"] && !(bool)proof["desktopAccountVerified"] &&
                    !(bool)proof["targetVerified"] && !(bool)proof["draftVerified"], "UI_ACCOUNT_SELFTEST_FAILED"); checks++;
                config.AccountDirectory = LocalPath(other); Expect(config, "UI_ACCOUNT_DATABASE_MISMATCH", ref checks); config.AccountDirectory = LocalPath(expected);
                using (var two = new FileStream(second, FileMode.Open, FileAccess.Read, FileShare.ReadWrite | FileShare.Delete)) Expect(config, "UI_ACCOUNT_MULTIPLE_DATABASE_ROOTS", ref checks);
                config.Created++; Expect(config, "UI_ACCOUNT_PROCESS_CHANGED", ref checks); config.Created--;
            }
            Expect(config, "UI_ACCOUNT_DATABASE_NOT_OBSERVED", ref checks);
            foreach (string name in new string[] { @"message\message_0.db", @"message\message_41.db-wal", @"contact\contact.db", @"session\session.db-shm" }) { Require(CoreDatabase.IsMatch(name), "UI_ACCOUNT_SELFTEST_FAILED"); checks++; }
            foreach (string name in new string[] { @"message\message_backup", @"message\message_1.db.extra", @"message\message_1.db\child", @"message\message_x.db" }) { Require(!CoreDatabase.IsMatch(name), "UI_ACCOUNT_SELFTEST_FAILED"); checks++; }
            foreach (uint type in new uint[] { 0x39, 0x3a, 0x3f, 0x50 }) { Require(IsKnownNonFilesystemDevice(type), "UI_ACCOUNT_SELFTEST_FAILED"); checks++; }
            foreach (uint type in new uint[] { 0, 2, 7, 8, 0x14, 0x22, 0x8000 }) { Require(!IsKnownNonFilesystemDevice(type), "UI_ACCOUNT_SELFTEST_FAILED"); checks++; }
            Require(IsKnownNamedNonFilesystemDevice(0x22, @"\Device\MMCSS") && !IsKnownNamedNonFilesystemDevice(0x22, @"\Device\MMCSS\x") && !IsKnownNamedNonFilesystemDevice(0x14, @"\Device\MMCSS"), "UI_ACCOUNT_SELFTEST_FAILED"); checks++;
            string pdo = @"\Device\KSENUM#00000abc";
            Require(IsKsMediaDevice(0x22, pdo, MediaSetupClass, pdo, "MSKSSRV"), "UI_ACCOUNT_SELFTEST_FAILED"); checks++;
            Require(!IsKsMediaDevice(0x22, pdo + @"\file.db", MediaSetupClass, pdo + @"\file.db", "MSKSSRV") &&
                !IsKsMediaDevice(0x22, pdo, Guid.Empty, pdo, "MSKSSRV") &&
                !IsKsMediaDevice(0x22, pdo, MediaSetupClass, pdo, "other") &&
                !IsKsMediaDevice(7, pdo, MediaSetupClass, pdo, "MSKSSRV") &&
                !IsKsMediaDevice(0x22, pdo, MediaSetupClass, pdo + "0", "MSKSSRV"), "UI_ACCOUNT_SELFTEST_FAILED"); checks++;
            Require(IsKnownNamedNonFilesystemDevice(0x22, @"\Device\DeviceApi") && IsKnownNamedNonFilesystemDevice(0x12, @"\Device\Nsi"), "UI_ACCOUNT_SELFTEST_FAILED"); checks++;
            foreach (string name in new string[] { @"\Device\DeviceApi\CMApi", @"\Device\DeviceApi\db_storage\contact\contact.db", @"\Device\DeviceApiOther", @"\Device\deviceapi", @"\Device\Other", @"\Device\Nsi", String.Empty }) {
                Require(!IsKnownNamedNonFilesystemDevice(0x22, name), "UI_ACCOUNT_SELFTEST_FAILED"); checks++;
            }
            foreach (uint type in new uint[] { 0, 7, 0x12, 0x14, 0x28 }) { Require(!IsKnownNamedNonFilesystemDevice(type, @"\Device\DeviceApi"), "UI_ACCOUNT_SELFTEST_FAILED"); checks++; }
            foreach (string name in new string[] { @"\Device\Nsi\child", @"\Device\nsi", @"\Device\Other" }) { Require(!IsKnownNamedNonFilesystemDevice(0x12, name), "UI_ACCOUNT_SELFTEST_FAILED"); checks++; }
            IntPtr objectBuffer = Marshal.AllocHGlobal(32);
            try {
                for (int i = 0; i < 32; i++) Marshal.WriteByte(objectBuffer, i, 0);
                Marshal.WriteInt16(objectBuffer, 0, 2); Marshal.WriteInt16(objectBuffer, 2, 2);
                Marshal.WriteIntPtr(objectBuffer, 8, IntPtr.Add(objectBuffer, 16)); Marshal.WriteInt16(objectBuffer, 16, (short)'X');
                Require(DecodeObjectName(objectBuffer, 18, 32) == "X", "UI_ACCOUNT_SELFTEST_FAILED"); checks++;
                ExpectFault(delegate() { DecodeObjectName(objectBuffer, 15, 32); }, "UI_ACCOUNT_OBJECT_NAME_INVALID", ref checks);
                ExpectFault(delegate() { DecodeObjectName(objectBuffer, 33, 32); }, "UI_ACCOUNT_OBJECT_NAME_INVALID", ref checks);
                ExpectFault(delegate() { DecodeObjectName(objectBuffer, 16, 32); }, "UI_ACCOUNT_OBJECT_NAME_INVALID", ref checks);
                Marshal.WriteInt16(objectBuffer, 0, 1);
                ExpectFault(delegate() { DecodeObjectName(objectBuffer, 18, 32); }, "UI_ACCOUNT_OBJECT_NAME_INVALID", ref checks);
                Marshal.WriteInt16(objectBuffer, 0, 2); Marshal.WriteIntPtr(objectBuffer, 8, IntPtr.Add(objectBuffer, 15));
                ExpectFault(delegate() { DecodeObjectName(objectBuffer, 18, 32); }, "UI_ACCOUNT_OBJECT_NAME_INVALID", ref checks);
                Marshal.WriteIntPtr(objectBuffer, 8, IntPtr.Add(objectBuffer, 32));
                ExpectFault(delegate() { DecodeObjectName(objectBuffer, 18, 32); }, "UI_ACCOUNT_OBJECT_NAME_INVALID", ref checks);
                Marshal.WriteIntPtr(objectBuffer, 8, IntPtr.Add(objectBuffer, 16)); Marshal.WriteInt16(objectBuffer, 16, 0);
                ExpectFault(delegate() { DecodeObjectName(objectBuffer, 18, 32); }, "UI_ACCOUNT_OBJECT_NAME_INVALID", ref checks);
            } finally { Marshal.FreeHGlobal(objectBuffer); }
            foreach (string name in new string[] { @"\Device\wxidSecret", @"\Device\dbStorage", @"\Device\LONG12345678901234567890", @"\Device\private\db_storage\contact\contact.db" }) {
                string label = ObjectNameClass(name); Require(label == "unclassified-device-node" || label == "unclassified-object-path", "UI_ACCOUNT_SELFTEST_FAILED"); checks++;
            }
            SnapshotLength(56, 65536, 1); SnapshotLength(16, 65536, 0); checks += 2;
            ExpectFault(delegate() { SnapshotLength(15, 65536, 0); }, "UI_ACCOUNT_SNAPSHOT_INVALID", ref checks);
            ExpectFault(delegate() { SnapshotLength(16, 65536, 1); }, "UI_ACCOUNT_SNAPSHOT_INVALID", ref checks);
            ExpectFault(delegate() { SnapshotLength(55, 65536, 1); }, "UI_ACCOUNT_SNAPSHOT_INVALID", ref checks);
            ExpectFault(delegate() { SnapshotLength(65537, 65536, 1); }, "UI_ACCOUNT_SNAPSHOT_INVALID", ref checks);
            ExpectFault(delegate() { SnapshotLength(56, 65536, -1); }, "UI_ACCOUNT_SNAPSHOT_INVALID", ref checks);
            var a = new Scan(); var b = new Scan();
            Classify(@"synthetic-one\db_storage\message\message_0.db", "synthetic-one", a);
            Classify(@"synthetic-one\db_storage\message\message_0.db", "synthetic-one", b);
            Require(SameScan(a, b), "UI_ACCOUNT_SELFTEST_FAILED"); checks++;
            b.DatabasePaths.Clear(); b.DatabasePaths.Add(@"synthetic-one\db_storage\message\message_1.db");
            Require(!SameScan(a, b), "UI_ACCOUNT_SELFTEST_FAILED"); checks++;
            b = new Scan(); Classify(@"synthetic-two\db_storage\message\message_0.db", "synthetic-one", b);
            Require(!SameScan(a, b), "UI_ACCOUNT_SELFTEST_FAILED"); checks++;
            b = new Scan(); Classify(@"SYNTHETIC-ONE\db_storage\message\message_0.db", "synthetic-one", b);
            Require(!SameScan(a, b) && b.Databases == 0, "UI_ACCOUNT_SELFTEST_FAILED"); checks++;
            var denied = Denied("UI_ACCOUNT_DEVICE_UNCLASSIFIED", 0x1234);
            Require(!(bool)denied["ok"] && !(bool)denied["complete"] && !(bool)denied["ready"] &&
                (uint)denied["unknownDeviceType"] == 0x1234 && (string)denied["unknownDeviceTypeHex"] == "0x00001234", "UI_ACCOUNT_SELFTEST_FAILED"); checks++;
            return Data("ok", true, "selfTest", true, "checks", checks, "syntheticOnly", true, "ready", false,
                "desktopAccountVerified", false, "targetVerified", false, "draftVerified", false, "inputSent", false, "processMemoryRead", false);
        } finally {
            Require(Path.GetDirectoryName(Path.GetFullPath(root)).TrimEnd('\\') == Path.GetFullPath(Path.GetTempPath()).TrimEnd('\\') &&
                Regex.IsMatch(Path.GetFileName(root), @"^wechat-account-probe-selftest-[a-f0-9]{32}$"), "UI_ACCOUNT_SELFTEST_CLEANUP_REFUSED");
            foreach (string file in new string[] { first, second }) { NoLinks(file); File.Delete(file); }
            foreach (string account in new string[] { expected, other }) {
                string storage = Path.Combine(account, "db_storage");
                foreach (string child in Directory.GetDirectories(storage)) { NoLinks(child); Directory.Delete(child, false); }
                Directory.Delete(storage, false); Directory.Delete(account, false);
            }
            Directory.Delete(root, false);
        }
    }
    static int Main(string[] args) {
        object result = null; string error = null, unknownObjectClass = null; uint? unknownDeviceType = null;
        var worker = new Thread(delegate() {
            try {
                if (args.Length == 1 && args[0] == "--self-test") result = SelfTest();
                else { Require(args.Length == 2 && args[0] == "--config", "UI_ACCOUNT_ARGUMENTS_INVALID"); result = Probe(ReadConfig(args[1])); }
            } catch (Fault failure) { error = failure.Code; unknownDeviceType = failure.UnknownDeviceType; unknownObjectClass = failure.UnknownObjectClass; }
            catch { error = "UI_ACCOUNT_PROBE_FAILED"; }
        });
        worker.IsBackground = true; worker.Start();
        if (!worker.Join(DeadlineMs)) { Console.WriteLine(Json.Serialize(Denied("UI_ACCOUNT_PROBE_TIMEOUT"))); Environment.Exit(1); return 1; }
        Console.WriteLine(Json.Serialize(error == null ? result : Denied(error, unknownDeviceType, unknownObjectClass))); return error == null ? 0 : 1;
    }
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern IntPtr GetModuleHandle(string name);
    [DllImport("setupapi.dll", CharSet = CharSet.Unicode, ExactSpelling = true)] static extern IntPtr SetupDiGetClassDevsW(ref Guid classGuid, string enumerator, IntPtr parent, uint flags);
    [DllImport("setupapi.dll", ExactSpelling = true)] static extern bool SetupDiEnumDeviceInfo(IntPtr set, uint index, ref DeviceInfo info);
    [DllImport("setupapi.dll", ExactSpelling = true)] static extern bool SetupDiGetDeviceRegistryPropertyW(IntPtr set, ref DeviceInfo info, uint property, out uint type, [Out] byte[] buffer, uint capacity, out uint size);
    [DllImport("setupapi.dll", ExactSpelling = true)] static extern bool SetupDiDestroyDeviceInfoList(IntPtr set);
    [DllImport("kernel32.dll", CharSet = CharSet.Ansi)] static extern IntPtr GetProcAddress(IntPtr module, string name);
    [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern uint GetCurrentProcessId();
    [DllImport("kernel32.dll")] static extern uint GetProcessId(IntPtr process);
    [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr handle, uint timeout);
    [DllImport("kernel32.dll")] static extern bool GetProcessTimes(IntPtr process, out FileTime created, out FileTime exited, out FileTime kernel, out FileTime user);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder name, ref uint size);
    [DllImport("kernel32.dll")] static extern bool ProcessIdToSessionId(uint pid, out uint session);
    [DllImport("kernel32.dll", SetLastError = true)] static extern bool DuplicateHandle(IntPtr source, IntPtr handle, IntPtr target, out IntPtr copy, uint access, bool inherit, uint flags);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
    [DllImport("kernel32.dll", SetLastError = true)] static extern uint GetFileType(IntPtr handle);
    [DllImport("kernel32.dll")] static extern void SetLastError(uint error);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern uint GetFinalPathNameByHandle(IntPtr handle, StringBuilder name, uint size, uint flags);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern IntPtr CreateFile(string file, uint access, uint share, IntPtr security, uint disposition, uint flags, IntPtr template);
}
