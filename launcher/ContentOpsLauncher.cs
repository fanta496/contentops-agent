using System;
using System.Diagnostics;
using System.IO;
using System.Net;
using System.Net.Sockets;
using System.Security.Cryptography;
using System.Text;
using System.Threading;
using System.Windows.Forms;
using System.Collections.Generic;
using Microsoft.Win32;

internal static class ContentOpsLauncher
{
    private const string AppUrl = "http://127.0.0.1:17851/";
    private const string HealthUrl = "http://127.0.0.1:17851/health";

    [STAThread]
    private static void Main()
    {
        try
        {
            string root = AppDomain.CurrentDomain.BaseDirectory;
            string serverFile = Path.Combine(root, "server.cjs");
            string bundledNode = Path.Combine(root, "runtime", "node.exe");
            string node = File.Exists(bundledNode) ? bundledNode : @"C:\Program Files\nodejs\node.exe";
            string watchdogFile = Path.Combine(root, "ContentOpsWatchdog-v2.exe");
            string dataDirectory = ResolveDataDirectory();

            if (!File.Exists(serverFile))
            {
                MessageBox.Show("没有找到 server.cjs，请把启动器放在完整项目文件夹内。", "图文爆款Agent", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }
            if (!File.Exists(node))
            {
                MessageBox.Show("启动前检查未通过：没有找到内置 Node 运行环境。\n\n期望文件：" + bundledNode + "\n请确认 ZIP 已完整解压，且从完整应用目录内启动。", "图文爆款Agent", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }
            string chromeDiagnostic;
            string chrome = ResolveChromePath(dataDirectory, out chromeDiagnostic);
            if (String.IsNullOrWhiteSpace(chrome))
            {
                MessageBox.Show(chromeDiagnostic, "图文爆款Agent · 首次环境检查", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }

            string installId = InstallationId(root);
            string runningInstallId;
            bool healthy = TryGetHealthyInstallId(out runningInstallId);
            Process startedWatchdog = null;
            if (healthy)
            {
                if (!SameInstallId(runningInstallId, installId))
                {
                    MessageBox.Show("本机 17851 端口已被另一套程序占用。为避免打开错误后台，本次不会继续启动。", "图文爆款Agent", MessageBoxButtons.OK, MessageBoxIcon.Error);
                    return;
                }
                if (File.Exists(watchdogFile))
                {
                    var monitor = new ProcessStartInfo
                    {
                        FileName = watchdogFile,
                        WorkingDirectory = root,
                        UseShellExecute = false,
                        CreateNoWindow = true,
                        WindowStyle = ProcessWindowStyle.Hidden
                    };
                    monitor.EnvironmentVariables["CONTENTOPS_DATA_DIR"] = dataDirectory;
                    monitor.EnvironmentVariables["CONTENTOPS_CHROME_PATH"] = chrome;
                    Process.Start(monitor);
                }
            }
            else if (IsPortOpen(17851))
            {
                MessageBox.Show("本机 17851 端口已被其他程序占用。请先关闭占用程序，再重新启动。", "图文爆款Agent", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }
            else if (File.Exists(watchdogFile))
            {
                var start = new ProcessStartInfo
                {
                    FileName = watchdogFile,
                    WorkingDirectory = root,
                    UseShellExecute = false,
                    CreateNoWindow = true,
                    WindowStyle = ProcessWindowStyle.Hidden
                };
                start.EnvironmentVariables["CONTENTOPS_DATA_DIR"] = dataDirectory;
                start.EnvironmentVariables["CONTENTOPS_CHROME_PATH"] = chrome;
                startedWatchdog = Process.Start(start);
            }
            else if (!IsHealthy())
            {
                var start = new ProcessStartInfo { FileName = node, Arguments = "\"" + serverFile + "\"", WorkingDirectory = root, UseShellExecute = false, CreateNoWindow = true, WindowStyle = ProcessWindowStyle.Hidden };
                start.EnvironmentVariables["CONTENTOPS_DATA_DIR"] = dataDirectory;
                start.EnvironmentVariables["CONTENTOPS_CHROME_PATH"] = chrome;
                Process.Start(start);
            }
            // The watchdog retries a failed server start after its first
            // health-check interval.  Ten seconds was shorter than that
            // recovery path, so the launcher could kill a healthy recovery
            // before it had a chance to bind the port.
            for (int i = 0; i < 180 && !IsHealthy(); i++) Thread.Sleep(200);

            if (!IsHealthy())
            {
                try { if (startedWatchdog != null && !startedWatchdog.HasExited) startedWatchdog.Kill(); } catch { }
                MessageBox.Show("后台服务没有成功启动，请检查本机 17851 端口。", "图文爆款Agent", MessageBoxButtons.OK, MessageBoxIcon.Error);
                return;
            }

            try
            {
                string profileOverride = Environment.GetEnvironmentVariable("CONTENTOPS_UI_PROFILE_DIR");
                string profile = !String.IsNullOrWhiteSpace(profileOverride)
                    ? profileOverride
                    : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "ContentOpsAgentV2", "ChromeProfile");
                Directory.CreateDirectory(profile);
                Process.Start(new ProcessStartInfo
                {
                    FileName = chrome,
                    Arguments = "--app=" + AppUrl + " --user-data-dir=\"" + profile + "\" --disable-features=Translate",
                    UseShellExecute = true
                });
            }
            catch (Exception error)
            {
                MessageBox.Show("后台已启动，但 Chrome 无法打开工作台。\n\nChrome：" + chrome + "\n原因：" + error.Message, "图文爆款Agent", MessageBoxButtons.OK, MessageBoxIcon.Error);
            }
        }
        catch (Exception error)
        {
            MessageBox.Show("启动失败：" + error.Message, "图文爆款Agent", MessageBoxButtons.OK, MessageBoxIcon.Error);
        }
    }

    private static string ResolveDataDirectory()
    {
        string configured = Environment.GetEnvironmentVariable("CONTENTOPS_DATA_DIR");
        return !String.IsNullOrWhiteSpace(configured)
            ? configured
            : Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ApplicationData), "ContentOpsAgentV2");
    }

    private static string ResolveChromePath(string dataDirectory, out string diagnostic)
    {
        var candidates = new List<string>();
        AddCandidate(candidates, Environment.GetEnvironmentVariable("CONTENTOPS_CHROME_PATH"));
        AddCandidate(candidates, ReadSavedChromePath(dataDirectory));
        AddCandidate(candidates, Registry.GetValue(@"HKEY_CURRENT_USER\Software\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe", "", null) as string);
        AddCandidate(candidates, Registry.GetValue(@"HKEY_LOCAL_MACHINE\Software\Microsoft\Windows\CurrentVersion\App Paths\chrome.exe", "", null) as string);
        AddCandidate(candidates, Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFiles), "Google", "Chrome", "Application", "chrome.exe"));
        AddCandidate(candidates, Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Google", "Chrome", "Application", "chrome.exe"));
        AddCandidate(candidates, Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData), "Google", "Chrome", "Application", "chrome.exe"));
        foreach (string candidate in candidates)
        {
            if (ValidateChrome(candidate))
            {
                SaveChromePath(dataDirectory, candidate);
                diagnostic = String.Empty;
                return candidate;
            }
        }

        using (var dialog = new OpenFileDialog())
        {
            dialog.Title = "首次环境检查：请选择 chrome.exe";
            dialog.Filter = "Chrome (chrome.exe)|chrome.exe|可执行文件 (*.exe)|*.exe";
            dialog.CheckFileExists = true;
            dialog.Multiselect = false;
            if (dialog.ShowDialog() == DialogResult.OK && ValidateChrome(dialog.FileName))
            {
                SaveChromePath(dataDirectory, dialog.FileName);
                diagnostic = String.Empty;
                return dialog.FileName;
            }
            if (dialog.FileName.Length > 0) MessageBox.Show("所选文件不是可用的 chrome.exe。请选择 Google Chrome 的 chrome.exe 文件。", "图文爆款Agent · 首次环境检查", MessageBoxButtons.OK, MessageBoxIcon.Warning);
        }
        diagnostic = "启动前检查未通过：未找到可用 Chrome。\n\n已检查：\n" + String.Join("\n", candidates.ToArray()) + "\n\n请重新启动后，在“首次环境检查”窗口中选择 chrome.exe。选择成功后会保存到本机配置，后续启动只做快速验证。";
        return String.Empty;
    }

    private static void AddCandidate(List<string> candidates, string candidate)
    {
        if (String.IsNullOrWhiteSpace(candidate)) return;
        string path = candidate.Trim().Trim('"');
        foreach (string existing in candidates) if (String.Equals(existing, path, StringComparison.OrdinalIgnoreCase)) return;
        candidates.Add(path);
    }

    private static bool ValidateChrome(string candidate)
    {
        try
        {
            if (String.IsNullOrWhiteSpace(candidate) || !Path.GetFileName(candidate).Equals("chrome.exe", StringComparison.OrdinalIgnoreCase) || !File.Exists(candidate)) return false;
            using (var stream = new FileStream(candidate, FileMode.Open, FileAccess.Read, FileShare.ReadWrite)) return stream.Length > 0;
        }
        catch { return false; }
    }

    private static string RuntimeConfigFile(string dataDirectory) { return Path.Combine(dataDirectory, "runtime-config.json"); }

    private static string ReadSavedChromePath(string dataDirectory)
    {
        try
        {
            string json = File.ReadAllText(RuntimeConfigFile(dataDirectory), Encoding.UTF8);
            const string marker = "\"chromePath\":\"";
            int start = json.IndexOf(marker, StringComparison.Ordinal);
            if (start < 0) return String.Empty;
            start += marker.Length;
            int end = json.IndexOf('"', start);
            return end < 0 ? String.Empty : json.Substring(start, end - start).Replace("\\\\", "\\");
        }
        catch { return String.Empty; }
    }

    private static void SaveChromePath(string dataDirectory, string chrome)
    {
        try
        {
            Directory.CreateDirectory(dataDirectory);
            string value = chrome.Replace("\\", "\\\\").Replace("\"", "\\\"");
            File.WriteAllText(RuntimeConfigFile(dataDirectory), "{\"chromePath\":\"" + value + "\"}", Encoding.UTF8);
        }
        catch { }
    }

    private static bool IsHealthy()
    {
        string installId;
        return TryGetHealthyInstallId(out installId) && SameInstallId(installId, InstallationId(AppDomain.CurrentDomain.BaseDirectory));
    }

    private static bool TryGetHealthyInstallId(out string runningInstallId)
    {
        runningInstallId = String.Empty;
        try
        {
            var request = (HttpWebRequest)WebRequest.Create(HealthUrl);
            request.Timeout = 800;
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
                try { return result.AsyncWaitHandle.WaitOne(300) && client.Connected; }
                finally { result.AsyncWaitHandle.Close(); }
            }
        }
        catch { return false; }
    }

    private static bool SameInstallId(string left, string right)
    {
        return !String.IsNullOrWhiteSpace(left) && String.Equals(left, right, StringComparison.OrdinalIgnoreCase);
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
