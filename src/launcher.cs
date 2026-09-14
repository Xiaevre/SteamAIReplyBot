using System;
using System.Diagnostics;
using System.IO;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Text;

[assembly: AssemblyTitle("Steam Community Reply Assistant")]
[assembly: AssemblyDescription("Steam Community Reply Assistant")]
[assembly: AssemblyConfiguration("")]
[assembly: AssemblyCompany("SteamAIReplyBot")]
[assembly: AssemblyProduct("Steam AI Reply Bot")]
[assembly: AssemblyCopyright("Copyright © 2026 SteamAIReplyBot")]
[assembly: AssemblyTrademark("")]
[assembly: AssemblyCulture("")]
[assembly: ComVisible(false)]
[assembly: AssemblyVersion("1.0.0.0")]
[assembly: AssemblyFileVersion("1.0.0.0")]

namespace SteamAIReplyBotLauncher
{
    class Program
    {
        [DllImport("user32.dll")]
        static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        [DllImport("kernel32.dll")]
        static extern IntPtr GetConsoleWindow();

        const int SW_HIDE = 0;

        static void WriteStartupLog(string logsDir, string evt, string details)
        {
            try
            {
                if (!Directory.Exists(logsDir)) Directory.CreateDirectory(logsDir);
                string logFile = Path.Combine(logsDir, "startup.log");
                string line = string.Format("[{0:yyyy-MM-ddTHH:mm:ss.fffZ}] [{1}] {2}{3}", DateTime.UtcNow, evt, details, Environment.NewLine);
                File.AppendAllText(logFile, line, Encoding.UTF8);
            }
            catch { }
        }

        static int Main(string[] args)
        {
            Console.OutputEncoding = Encoding.UTF8;

            bool hasExplicitBackground = false;
            bool hasOtherArgs = false;

            foreach (string arg in args)
            {
                if (arg.Equals("--background", StringComparison.OrdinalIgnoreCase) ||
                    arg.Equals("-background", StringComparison.OrdinalIgnoreCase))
                {
                    hasExplicitBackground = true;
                }
                else
                {
                    hasOtherArgs = true;
                }
            }

            // Normal double-click has args.Length == 0 (no CLI args), or explicitly requested --background.
            // Any specific CLI commands (e.g. --status, --login, --diagnose-send, --service-status, --help, etc.)
            // will have hasOtherArgs == true and will keep isBackground = false to preserve interactive console output.
            bool isBackground = (args.Length == 0) || (hasExplicitBackground && !hasOtherArgs);

            if (isBackground)
            {
                IntPtr hWnd = GetConsoleWindow();
                if (hWnd != IntPtr.Zero)
                {
                    ShowWindow(hWnd, SW_HIDE);
                }
            }

            string baseDir = AppDomain.CurrentDomain.BaseDirectory;

            // 1. Locate Node executable (Priority: Bundled local runtime > System PATH > Developer fallback)
            string binNode = Path.Combine(baseDir, "bin", "node.exe");
            string localNode = Path.Combine(baseDir, "node.exe");
            string userProfile = Environment.GetFolderPath(Environment.SpecialFolder.UserProfile);
            string codexNode = Path.Combine(userProfile, @".cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe");

            string nodePath = "node";
            if (File.Exists(binNode))
            {
                nodePath = binNode;
            }
            else if (File.Exists(localNode))
            {
                nodePath = localNode;
            }
            else if (File.Exists(codexNode))
            {
                nodePath = codexNode;
            }

            // 2. Locate entry script (Priority: bootstrap.js > dist/index.js > index.js)
            string bootstrapPath = Path.Combine(baseDir, "bootstrap.js");
            string scriptPath = bootstrapPath;
            if (!File.Exists(bootstrapPath))
            {
                string distIndex = Path.Combine(baseDir, "dist", "index.js");
                if (File.Exists(distIndex))
                {
                    scriptPath = distIndex;
                }
                else
                {
                    scriptPath = Path.Combine(baseDir, "index.js");
                }
            }

            // 3. Assemble arguments
            StringBuilder argBuilder = new StringBuilder();
            argBuilder.Append("--preserve-symlinks --preserve-symlinks-main ");
            
            // Execute script directly without -e inline eval
            argBuilder.AppendFormat("\"{0}\" ", scriptPath);

            // Append user CLI arguments
            foreach (string arg in args)
            {
                if (arg.Contains(" "))
                {
                    argBuilder.AppendFormat("\"{0}\" ", arg);
                }
                else
                {
                    argBuilder.AppendFormat("{0} ", arg);
                }
            }

            // 4. Resolve Data Directory
            // Priority: STEAM_AI_REPLYBOT_DATA_DIR > STEAM_BOT_DATA_DIR > baseDir\data
            string envDataDir = Environment.GetEnvironmentVariable("STEAM_AI_REPLYBOT_DATA_DIR");
            if (string.IsNullOrEmpty(envDataDir))
            {
                envDataDir = Environment.GetEnvironmentVariable("STEAM_BOT_DATA_DIR");
            }

            string dataDir = string.IsNullOrEmpty(envDataDir) ? Path.Combine(baseDir, "data") : envDataDir;
            string playwrightTempDir = Path.Combine(dataDir, "playwright-temp");
            string cookiesDir = Path.Combine(dataDir, "cookies");
            string logsDir = Path.Combine(dataDir, "logs");
            string configDir = Path.Combine(dataDir, "config");

            try
            {
                if (!Directory.Exists(dataDir)) Directory.CreateDirectory(dataDir);
                if (!Directory.Exists(playwrightTempDir)) Directory.CreateDirectory(playwrightTempDir);
                if (!Directory.Exists(cookiesDir)) Directory.CreateDirectory(cookiesDir);
                if (!Directory.Exists(logsDir)) Directory.CreateDirectory(logsDir);
                if (!Directory.Exists(configDir)) Directory.CreateDirectory(configDir);

                // Strict write check (Requirement 3: Never silently switch)
                string testFile = Path.Combine(dataDir, ".write_test_" + Process.GetCurrentProcess().Id);
                File.WriteAllText(testFile, "ok", Encoding.UTF8);
                File.Delete(testFile);
            }
            catch (Exception ex)
            {
                if (!isBackground)
                {
                    Console.ForegroundColor = ConsoleColor.Red;
                    Console.WriteLine("[FATAL] Data directory is not writable: " + dataDir);
                    Console.WriteLine("Error: " + ex.Message);
                    Console.ResetColor();
                }
                WriteStartupLog(logsDir, "BOOT_DATA_DIR_NOT_WRITABLE", ex.Message);
                if (!isBackground && Environment.UserInteractive && !Console.IsInputRedirected)
                {
                    Console.WriteLine("[SteamAIReplyBot] 按任意键关闭窗口...");
                    Console.ReadKey();
                }
                return 1;
            }

            // Diagnostic display (only if not running in background)
            if (!isBackground)
            {
                Console.WriteLine("======================================================");
                Console.WriteLine("           Steam AI Reply Bot - 启动向导");
                Console.WriteLine("======================================================");
                Console.WriteLine("[Launcher] 正在启动 SteamAIReplyBot...");
                Console.WriteLine("[Launcher] 运行程序根目录: " + baseDir);
                Console.WriteLine("[Launcher] Node.js 运行时: " + nodePath);
                Console.WriteLine("[Launcher] 启动入口脚本:   " + scriptPath);
                Console.WriteLine("[Launcher] 工作目录:       " + baseDir);
                Console.WriteLine("[Launcher] 运行数据目录:   " + dataDir);
                Console.WriteLine("[Launcher] 启动参数:       " + (args.Length > 0 ? string.Join(" ", args) : "(无参数)"));
                Console.WriteLine("======================================================\n");
            }

            string debugLogFile = Path.Combine(logsDir, "launcher-debug.log");
            try
            {
                StringBuilder sb = new StringBuilder();
                sb.AppendLine("======================================================");
                sb.AppendLine(string.Format("[{0:yyyy-MM-ddTHH:mm:ss.fffZ}] SteamAIReplyBot Launcher Debug Session", DateTime.UtcNow));
                sb.AppendLine("======================================================");
                sb.AppendLine("Current EXE:         " + Process.GetCurrentProcess().MainModule.FileName);
                sb.AppendLine("BaseDir:             " + baseDir);
                sb.AppendLine("WorkingDirectory:    " + baseDir);
                sb.AppendLine("Node.exe Path:       " + nodePath);
                sb.AppendLine("Node.exe Exists:     " + File.Exists(nodePath));
                sb.AppendLine("Bootstrap Path:      " + scriptPath);
                sb.AppendLine("Bootstrap Exists:    " + File.Exists(scriptPath));
                sb.AppendLine("DataDir:             " + dataDir);
                sb.AppendLine("IsBackground:        " + isBackground);
                sb.AppendLine("Arguments:           " + argBuilder.ToString().Trim());
                File.AppendAllText(debugLogFile, sb.ToString(), Encoding.UTF8);
            }
            catch { }

            WriteStartupLog(logsDir, "BOOT_LAUNCHER_START", string.Format("baseDir={0} dataDir={1} nodePath={2} scriptPath={3} isBackground={4} args={5}", baseDir, dataDir, nodePath, scriptPath, isBackground, string.Join(" ", args)));

            // 5. Start process with redirected environment variables
            ProcessStartInfo psi = new ProcessStartInfo();
            psi.FileName = nodePath;
            psi.Arguments = argBuilder.ToString().Trim();
            psi.WorkingDirectory = baseDir;
            psi.UseShellExecute = false;

            if (isBackground)
            {
                psi.CreateNoWindow = true;
                psi.WindowStyle = ProcessWindowStyle.Hidden;
            }

            // Forward and configure environment variables
            psi.EnvironmentVariables["NODE_PATH"] = Path.Combine(baseDir, "node_modules");
            psi.EnvironmentVariables["STEAM_BOT_APP_ROOT"] = baseDir;
            psi.EnvironmentVariables["STEAM_AI_REPLYBOT_DATA_DIR"] = dataDir;
            psi.EnvironmentVariables["STEAM_BOT_DATA_DIR"] = dataDir;
            psi.EnvironmentVariables["TEMP"] = playwrightTempDir;
            psi.EnvironmentVariables["TMP"] = playwrightTempDir;
            psi.EnvironmentVariables["TMPDIR"] = playwrightTempDir;
            psi.EnvironmentVariables["PLAYWRIGHT_ARTIFACTS_PATH"] = playwrightTempDir;
            psi.EnvironmentVariables["PWTEST_SOCKETS_DIR"] = playwrightTempDir;

            try
            {
                using (Process proc = Process.Start(psi))
                {
                    try
                    {
                        File.AppendAllText(debugLogFile, string.Format("[{0:yyyy-MM-ddTHH:mm:ss.fffZ}] Process.Start SUCCESS: Child PID={1}\n", DateTime.UtcNow, proc != null ? proc.Id : 0), Encoding.UTF8);
                    }
                    catch { }

                    proc.WaitForExit();
                    int exitCode = proc.ExitCode;

                    try
                    {
                        File.AppendAllText(debugLogFile, string.Format("[{0:yyyy-MM-ddTHH:mm:ss.fffZ}] Process Exited: ExitCode={1}\n", DateTime.UtcNow, exitCode), Encoding.UTF8);
                    }
                    catch { }

                    WriteStartupLog(logsDir, "BOOT_LAUNCHER_EXIT", string.Format("exitCode={0}", exitCode));
                    if (!isBackground)
                    {
                        Console.WriteLine(string.Format("\n[Launcher] 子进程已退出 (退出码: {0})", exitCode));
                        if (exitCode != 0)
                        {
                            Console.ForegroundColor = ConsoleColor.Red;
                            Console.WriteLine(string.Format("[SteamAIReplyBot] ❌ 进程异常退出 (退出码: {0})。详细信息请检查: data/logs/launcher-debug.log", exitCode));
                            Console.ResetColor();
                        }
                        if (Environment.UserInteractive && !Console.IsInputRedirected)
                        {
                            Console.WriteLine("[SteamAIReplyBot] 按任意键关闭窗口...");
                            Console.ReadKey();
                        }
                    }
                    return exitCode;
                }
            }
            catch (Exception ex)
            {
                try
                {
                    File.AppendAllText(debugLogFile, string.Format("[{0:yyyy-MM-ddTHH:mm:ss.fffZ}] Process.Start FAILED: Exception={1}\n", DateTime.UtcNow, ex.ToString()), Encoding.UTF8);
                }
                catch { }

                WriteStartupLog(logsDir, "BOOT_LAUNCHER_EXCEPTION", ex.ToString());
                if (!isBackground)
                {
                    Console.ForegroundColor = ConsoleColor.Red;
                    Console.WriteLine("[Fatal Error] Failed to launch SteamAIReplyBot: " + ex.Message);
                    Console.ResetColor();
                    if (Environment.UserInteractive && !Console.IsInputRedirected)
                    {
                        Console.WriteLine("[SteamAIReplyBot] 按任意键关闭窗口...");
                        Console.ReadKey();
                    }
                }
                return 1;
            }
        }
    }
}
