using System;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace MyAgent.Desktop;

/// <summary>
/// Windows Job Object that auto-terminates assigned child processes when the
/// parent process (or the job handle) goes away. This protects against the
/// .NET host being force-killed (Task Manager, Stop-Process, crash) and
/// leaving orphaned Node.js children behind.
/// </summary>
internal sealed class ChildProcessJob : IDisposable
{
    private readonly IntPtr _handle;
    private bool _disposed;

    public ChildProcessJob()
    {
        _handle = CreateJobObject(IntPtr.Zero, null);
        if (_handle == IntPtr.Zero)
        {
            throw new InvalidOperationException(
                $"CreateJobObject failed: {Marshal.GetLastWin32Error()}");
        }

        var info = new JOBOBJECT_EXTENDED_LIMIT_INFORMATION
        {
            BasicLimitInformation = new JOBOBJECT_BASIC_LIMIT_INFORMATION
            {
                LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE,
            },
        };

        int length = Marshal.SizeOf<JOBOBJECT_EXTENDED_LIMIT_INFORMATION>();
        IntPtr buffer = Marshal.AllocHGlobal(length);
        try
        {
            Marshal.StructureToPtr(info, buffer, false);
            if (!SetInformationJobObject(
                    _handle,
                    JobObjectInfoType.ExtendedLimitInformation,
                    buffer,
                    (uint)length))
            {
                throw new InvalidOperationException(
                    $"SetInformationJobObject failed: {Marshal.GetLastWin32Error()}");
            }
        }
        finally
        {
            Marshal.FreeHGlobal(buffer);
        }
    }

    public void Assign(Process process)
    {
        if (!AssignProcessToJobObject(_handle, process.Handle))
        {
            throw new InvalidOperationException(
                $"AssignProcessToJobObject failed: {Marshal.GetLastWin32Error()}");
        }
    }

    public void Dispose()
    {
        if (_disposed) return;
        _disposed = true;
        if (_handle != IntPtr.Zero) CloseHandle(_handle);
    }

    // ---- P/Invoke ----

    private const uint JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE = 0x2000;

    private enum JobObjectInfoType
    {
        ExtendedLimitInformation = 9,
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public long PerProcessUserTimeLimit;
        public long PerJobUserTimeLimit;
        public uint LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public uint ActiveProcessLimit;
        public UIntPtr Affinity;
        public uint PriorityClass;
        public uint SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct IO_COUNTERS
    {
        public ulong ReadOperationCount;
        public ulong WriteOperationCount;
        public ulong OtherOperationCount;
        public ulong ReadTransferCount;
        public ulong WriteTransferCount;
        public ulong OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string? lpName);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(
        IntPtr hJob,
        JobObjectInfoType infoType,
        IntPtr lpJobObjectInfo,
        uint cbJobObjectInfoLength);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr hObject);
}
