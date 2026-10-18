using System;
using System.Collections.Concurrent;
using System.Diagnostics;
using System.IO;
using System.Text;
using System.Text.Json.Nodes;
using System.Threading;
using System.Threading.Tasks;
using System.Windows.Threading;

namespace Murmur
{
    public sealed class CoreException : Exception
    {
        public CoreException(string message) : base(message) { }
    }

    /// <summary>
    /// Starts the bundled Node core and speaks newline-delimited JSON-RPC 2.0 with it, in both directions.
    /// Handlers and notifications run on the UI dispatcher.
    /// </summary>
    public sealed class CoreClient
    {
        private readonly Dispatcher dispatcher;
        private readonly ConcurrentDictionary<long, TaskCompletionSource<JsonNode?>> pending = new();
        private readonly ConcurrentDictionary<string, Func<JsonObject, Task<JsonNode?>>> handlers = new();
        private readonly object writeLock = new();
        private Process? process;
        private long nextId;

        public event Action<string, JsonObject>? Notification;
        public event Action<int>? Exited;

        public CoreClient(Dispatcher dispatcher)
        {
            this.dispatcher = dispatcher;
        }

        public bool IsRunning => process is { HasExited: false };

        public void Handle(string method, Func<JsonObject, Task<JsonNode?>> handler) => handlers[method] = handler;

        /// <summary>The installed layout (core\node.exe next to the app), or MURMUR_NODE / MURMUR_CORE for development.</summary>
        public static (string node, string script)? Locate()
        {
            var baseDir = AppContext.BaseDirectory;
            var node = Path.Combine(baseDir, "core", "node.exe");
            var script = Path.Combine(baseDir, "core", "murmur-core.mjs");
            if (File.Exists(node) && File.Exists(script)) return (node, script);
            var devScript = Environment.GetEnvironmentVariable("MURMUR_CORE");
            if (!string.IsNullOrEmpty(devScript)) return (Environment.GetEnvironmentVariable("MURMUR_NODE") ?? "node.exe", devScript);
            return null;
        }

        public void Start()
        {
            var location = Locate() ?? throw new CoreException("Murmur's engine was not found next to the app.");
            var info = new ProcessStartInfo(location.node)
            {
                UseShellExecute = false,
                RedirectStandardInput = true,
                RedirectStandardOutput = true,
                RedirectStandardError = false,
                CreateNoWindow = true,
                StandardOutputEncoding = new UTF8Encoding(false),
                StandardInputEncoding = new UTF8Encoding(false),
            };
            info.ArgumentList.Add("--disable-warning=ExperimentalWarning");
            info.ArgumentList.Add(location.script);
            info.ArgumentList.Add("daemon");
            var started = Process.Start(info) ?? throw new CoreException("Murmur's engine did not start.");
            started.EnableRaisingEvents = true;
            started.Exited += (_, _) =>
            {
                foreach (var entry in pending) entry.Value.TrySetException(new CoreException("Murmur's engine stopped."));
                pending.Clear();
                dispatcher.BeginInvoke(() => Exited?.Invoke(started.ExitCode));
            };
            process = started;
            var reader = new Thread(() => ReadLoop(started.StandardOutput)) { IsBackground = true, Name = "murmur-core-reader" };
            reader.Start();
        }

        public void Stop()
        {
            try
            {
                process?.StandardInput.Close();
                if (process is { HasExited: false } && !process.WaitForExit(1500)) process.Kill();
            }
            catch (InvalidOperationException) { }
            process = null;
        }

        public async Task<JsonNode?> Request(string method, JsonObject? parameters = null, int timeoutMs = 60000)
        {
            if (!IsRunning) throw new CoreException("Murmur's engine is not running.");
            var id = Interlocked.Increment(ref nextId);
            var tcs = new TaskCompletionSource<JsonNode?>(TaskCreationOptions.RunContinuationsAsynchronously);
            pending[id] = tcs;
            Write(new JsonObject { ["jsonrpc"] = "2.0", ["id"] = id, ["method"] = method, ["params"] = parameters ?? new JsonObject() });
            var finished = await Task.WhenAny(tcs.Task, Task.Delay(timeoutMs));
            if (finished != tcs.Task)
            {
                pending.TryRemove(id, out _);
                throw new CoreException(method + " took too long.");
            }
            return await tcs.Task;
        }

        /// <summary>Fire-and-forget request; errors are ignored.</summary>
        public void Send(string method, JsonObject? parameters = null) => _ = Request(method, parameters).ContinueWith(t => _ = t.Exception);

        private void Write(JsonObject message)
        {
            var line = message.ToJsonString();
            lock (writeLock)
            {
                if (process is null) return;
                process.StandardInput.Write(line);
                process.StandardInput.Write('\n');
                process.StandardInput.Flush();
            }
        }

        private void ReadLoop(StreamReader reader)
        {
            try
            {
                string? line;
                while ((line = reader.ReadLine()) != null)
                {
                    if (line.Length == 0) continue;
                    JsonObject? message;
                    try { message = JsonNode.Parse(line) as JsonObject; }
                    catch (System.Text.Json.JsonException) { continue; }
                    if (message != null) Dispatch(message);
                }
            }
            catch (IOException) { }
        }

        private void Dispatch(JsonObject message)
        {
            var method = message["method"]?.GetValue<string>();
            var idNode = message["id"];
            if (method != null)
            {
                var parameters = message["params"] as JsonObject ?? new JsonObject();
                if (idNode == null)
                {
                    dispatcher.BeginInvoke(() => Notification?.Invoke(method, parameters));
                    return;
                }
                var id = idNode.DeepClone();
                dispatcher.BeginInvoke(async () =>
                {
                    if (!handlers.TryGetValue(method, out var handler))
                    {
                        Write(new JsonObject { ["jsonrpc"] = "2.0", ["id"] = id, ["error"] = new JsonObject { ["code"] = -32601, ["message"] = "Unknown method " + method } });
                        return;
                    }
                    try
                    {
                        var result = await handler(parameters);
                        Write(new JsonObject { ["jsonrpc"] = "2.0", ["id"] = id.DeepClone(), ["result"] = result ?? JsonValue.Create((string?)null) });
                    }
                    catch (Exception error)
                    {
                        Write(new JsonObject { ["jsonrpc"] = "2.0", ["id"] = id.DeepClone(), ["error"] = new JsonObject { ["code"] = -32000, ["message"] = error.Message } });
                    }
                });
                return;
            }
            if (idNode == null || !long.TryParse(idNode.ToJsonString(), out var responseId)) return;
            if (!pending.TryRemove(responseId, out var tcs)) return;
            if (message["error"] is JsonObject error) tcs.TrySetException(new CoreException(error["message"]?.GetValue<string>() ?? "Error"));
            else tcs.TrySetResult(message["result"]?.DeepClone());
        }
    }
}
