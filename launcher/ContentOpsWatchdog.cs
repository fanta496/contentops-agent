using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Threading;

internal static class ContentOpsWatchdog
{
    private const int DefaultPort = 17851;
    private static string Root;
    private static string Node;
    private static string ServerFile;
    private static int Port;
    private static string HealthUrl;
    private static Mutex InstanceMutex;

    private static void Main()
    {
        bool createdNew;
        string portScope = Environment.GetEnvironmentVariable("CONTENTOPS_PORT") ?? DefaultPort.ToString();
        InstanceMutex = new Mutex(true, @"Local\ContentOpsAgentV2Watchdog-" + portScope, out createdNew);
        if (!createdNew) { InstanceMutex.Dispose(); return; }
        try { Run(); }
        finally
        {
            try { InstanceMutex.ReleaseMutex(); } catch { }
            InstanceMutex.Dispose();
        }
    }

    private static void Run()
    {
        Root = AppDomain.CurrentDomain.BaseDirectory;
        Port = ResolvePort();
        HealthUrl = "http://127.0.0.1:" + Port + "/health";
        Node = Path.Combine(Root, "runtime", "node.exe");
        ServerFile = Path.Combine(Root, "server.cjs");
        string dataDirectory = Environment.GetEnvironmentVariable("CONTENTOPS_DATA_DIR");
        if (String.IsNullOrWhiteSpace(dataDirectory))
            dataDirectory = Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "ContentOpsAgentV2");
        if (!File.Exists(Node) || !File.Exists(ServerFile)) return;

        string installId = InstallationId(Root);
        string runningInstallId;
        if (TryGetHealthyInstallId(out runningInstallId))
        {
            if (!SameInstallId(runningInstallId, installId)) return;
        }
        else
        {
            if (IsPortOpen(Port)) return;
            StartServer(dataDirectory);
            Thread.Sleep(1500);
        }

        int consecutiveFailures = 0;
        while (true)
        {
            if (TryGetHealthyInstallId(out runningInstallId))
            {
                if (!SameInstallId(runningInstallId, installId)) return;
                consecutiveFailures = 0;
            }
            else
            {
                consecutiveFailures++;
                if (consecutiveFailures >= 3 && IsPortOpen(Port))
                {
                    // A listening socket is not proof that Node is responsive.
                    // Only recycle the PID recorded by this package's own lock
                    // file, and only when the lock root matches this package.
                    TryStopOwnedUnresponsiveServer(dataDirectory);
                    Thread.Sleep(1500);
                }
                if (consecutiveFailures >= 2 && !IsPortOpen(Port))
                {
                    StartServer(dataDirectory);
                    consecutiveFailures = 0;
                    Thread.Sleep(5000);
                }
            }
            Thread.Sleep(15000);
        }
    }

    private static void StartServer(string dataDirectory)
    {
        try
        {
            var start = new ProcessStartInfo
            {
                FileName = Node,
                Arguments = "\"" + ServerFile + "\"",
                WorkingDirectory = Root,
                UseShellExecute = false,
                CreateNoWindow = true,
                WindowStyle = ProcessWindowStyle.Hidden
            };
            start.EnvironmentVariables["CONTENTOPS_DATA_DIR"] = dataDirectory;
            start.EnvironmentVariables["CONTENTOPS_PORT"] = Port.ToString();
            string chromePath = Environment.GetEnvironmentVariable("CONTENTOPS_CHROME_PATH");
            if (!String.IsNullOrWhiteSpace(chromePath)) start.EnvironmentVariables["CONTENTOPS_CHROME_PATH"] = chromePath;
            Process.Start(start);
        }
        catch { }
    }

    private static void TryStopOwnedUnresponsiveServer(string dataDirectory)
    {
        try
        {
            string lockFile = Path.Combine(dataDirectory, "server.lock.json");
            if (!File.Exists(lockFile)) return;
            string json = File.ReadAllText(lockFile, Encoding.UTF8);
            string lockRoot = ReadJsonString(json, "root");
            int pid = ReadJsonInt(json, "pid");
            if (pid <= 0 || !SameDirectory(lockRoot, Root)) return;
            Process process = Process.GetProcessById(pid);
            string expectedNode = Path.GetFullPath(Node);
            string actualProcess = Path.GetFullPath(process.MainModule.FileName);
            if (!actualProcess.Equals(expectedNode, StringComparison.OrdinalIgnoreCase)) return;
            process.Kill();
            process.WaitForExit(5000);
        }
        catch { }
    }

    private static string ReadJsonString(string json, string name)
    {
        string marker = "\"" + name + "\":\"";
        int start = json.IndexOf(marker, StringComparison.Ordinal);
        if (start < 0) return String.Empty;
        start += marker.Length;
        int end = json.IndexOf('"', start);
        return end < 0 ? String.Empty : json.Substring(start, end - start).Replace("\\\\", "\\");
    }

    private static int ReadJsonInt(string json, string name)
    {
        string marker = "\"" + name + "\":";
        int start = json.IndexOf(marker, StringComparison.Ordinal);
        if (start < 0) return 0;
        start += marker.Length;
        int end = start;
        while (end < json.Length && Char.IsDigit(json[end])) end++;
        int value;
        return Int32.TryParse(json.Substring(start, end - start), out value) ? value : 0;
    }

    private static bool TryGetHealthyInstallId(out string runningInstallId)
    {
        runningInstallId = String.Empty;
        try
        {
            var request = (HttpWebRequest)WebRequest.Create(HealthUrl);
            request.Timeout = 1200;
            request.Proxy = null;
            using (var response = (HttpWebResponse)request.GetResponse())
            using (var reader = new StreamReader(response.GetResponseStream(), Encoding.UTF8))
            {
                string body = reader.ReadToEnd();
                if (response.StatusCode != HttpStatusCode.OK || !body.Contains("contentops-agent-v2")) return false;
                const string marker = "\"installId\":\"";
                int start = body.IndexOf(marker, StringComparison.Ordinal);
                if (start < 0) return false;
                start += marker.Length;
                int end = body.IndexOf('"', start);
                if (end < 0) return false;
                runningInstallId = body.Substring(start, end - start);
                return !String.IsNullOrWhiteSpace(runningInstallId);
            }
        }
        catch { return false; }
    }

    private static bool IsPortOpen(int port)
    {
        try
        {
            using (var client = new TcpClient())
            {
                var result = client.BeginConnect("127.0.0.1", port, null, null);
                try { return result.AsyncWaitHandle.WaitOne(800) && client.Connected; }
                finally { result.AsyncWaitHandle.Close(); }
            }
        }
        catch { return false; }
    }

    private static int ResolvePort()
    {
        int parsed;
        return Int32.TryParse(Environment.GetEnvironmentVariable("CONTENTOPS_PORT"), out parsed) && parsed >= 1025 && parsed <= 65535 ? parsed : DefaultPort;
    }

    private static bool SameInstallId(string left, string right)
    {
        return !String.IsNullOrWhiteSpace(left) && String.Equals(left, right, StringComparison.OrdinalIgnoreCase);
    }

    private static bool SameDirectory(string left, string right)
    {
        try
        {
            return Path.GetFullPath(left).TrimEnd('\\').Equals(Path.GetFullPath(right).TrimEnd('\\'), StringComparison.OrdinalIgnoreCase);
        }
        catch { return false; }
    }

    private static string InstallationId(string directory)
    {
        string normalized = Path.GetFullPath(directory).TrimEnd('\\', '/').ToLowerInvariant();
        using (var sha256 = SHA256.Create())
        {
            byte[] hash = sha256.ComputeHash(Encoding.UTF8.GetBytes(normalized));
            return BitConverter.ToString(hash).Replace("-", String.Empty).ToLowerInvariant();
        }
    }
}
