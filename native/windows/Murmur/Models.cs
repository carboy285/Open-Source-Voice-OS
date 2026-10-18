using System;
using System.Collections.Generic;
using System.Linq;
using System.Text.Json.Nodes;

namespace Murmur
{
    internal static class Json
    {
        public static string Str(this JsonNode? node, string key, string fallback = "") =>
            node is JsonObject o && o[key] is JsonValue v && v.TryGetValue<string>(out var s) ? s : fallback;

        public static int Int(this JsonNode? node, string key, int fallback = 0) =>
            node is JsonObject o && o[key] is JsonValue v && v.TryGetValue<double>(out var d) ? (int)d : fallback;

        public static double Num(this JsonNode? node, string key, double fallback = 0) =>
            node is JsonObject o && o[key] is JsonValue v && v.TryGetValue<double>(out var d) ? d : fallback;

        public static bool Bool(this JsonNode? node, string key, bool fallback = false) =>
            node is JsonObject o && o[key] is JsonValue v && v.TryGetValue<bool>(out var b) ? b : fallback;

        public static string Text(JsonNode? value) => value switch
        {
            null => "",
            JsonArray array => string.Join(", ", array.Select(Text)),
            JsonValue v when v.TryGetValue<string>(out var s) => s,
            _ => value.ToJsonString(),
        };
    }

    public sealed class PreviewField
    {
        public string Key = "", Label = "", Type = "text";
        public JsonNode? Value;
        public string Text => Json.Text(Value);
        public bool IsList => Value is JsonArray;
    }

    /// <summary>An approval preview built by the core from the connector's own summary.</summary>
    public sealed class Preview
    {
        public string CallId = "", Tool = "", DisplayName = "", Icon = "", Verb = "Run", Summary = "";
        public List<PreviewField> Fields = new();
        public JsonObject Raw = new();
        public bool Destructive, Edited, Confirming;
        public List<string> Errors = new();
        public DateTime ExpiresAt;

        public static Preview? From(JsonNode? node)
        {
            if (node is not JsonObject o || o.Str("callId") == "") return null;
            return new Preview
            {
                CallId = o.Str("callId"),
                Tool = o.Str("tool"),
                DisplayName = o.Str("displayName", o.Str("tool")),
                Icon = o.Str("icon", "tool"),
                Verb = o.Str("verb", "Run"),
                Summary = o.Str("summary"),
                Fields = (o["fields"] as JsonArray ?? new JsonArray()).OfType<JsonObject>().Select(f => new PreviewField
                {
                    Key = f.Str("key"),
                    Label = f.Str("label"),
                    Type = f.Str("type", "text"),
                    Value = f["value"]?.DeepClone(),
                }).ToList(),
                Raw = o["raw"]?.DeepClone() as JsonObject ?? new JsonObject(),
                Destructive = o.Str("risk") == "destructive",
                Edited = o.Str("state") == "edited",
                Confirming = o.Str("stage") == "confirm",
                Errors = (o["errors"] as JsonArray ?? new JsonArray()).Select(e => Json.Text(e)).ToList(),
                ExpiresAt = DateTimeOffset.FromUnixTimeMilliseconds((long)o.Num("expiresAt")).LocalDateTime,
            };
        }
    }

    public sealed class TaskStep
    {
        public int Seq;
        public string Tool = "", InputSummary = "", ResultSummary = "", Approval = "auto";
    }

    public sealed class TaskInfo
    {
        public string Id = "", Status = "running", Reply = "";
        public string? CurrentStep, Transcript;
        public bool Long;
        public List<TaskStep> Steps = new();
        public DateTime StartedAt = DateTime.Now;
        public bool IsActive => Status == "running" || Status == "waiting_approval";

        public static TaskInfo From(JsonNode? node) => new()
        {
            Id = node.Str("taskId", node.Str("id")),
            Status = node.Str("status", "running"),
            Reply = node.Str("reply"),
            CurrentStep = node.Str("currentStep") is { Length: > 0 } step ? step : null,
            Transcript = node.Str("transcript") is { Length: > 0 } t ? t : null,
            Long = node.Bool("long"),
            Steps = ((node as JsonObject)?["steps"] as JsonArray ?? new JsonArray()).Select(s => new TaskStep
            {
                Seq = s.Int("seq"),
                Tool = s.Str("tool"),
                InputSummary = s.Str("inputSummary"),
                ResultSummary = s.Str("resultSummary"),
                Approval = s.Str("approval", "auto"),
            }).ToList(),
            StartedAt = node.Num("startedAt") > 0 ? DateTimeOffset.FromUnixTimeMilliseconds((long)node.Num("startedAt")).LocalDateTime : DateTime.Now,
        };
    }

    public sealed class ReportItem
    {
        public string Category = "", Label = "";
        public int Count;
    }

    public sealed class ConnectorInfo
    {
        public string Id = "", Name = "", Description = "", Icon = "", Auth = "none";
        public bool Skeleton, Enabled;
    }

    public enum ShellState { Starting, Idle, Listening, Transcribing, Cleaning, Inserting, Done, Error, Agent }

    public enum HotkeyAction { Dictate, Agent, Edit }

    /// <summary>Segoe Fluent Icons glyphs for connector icon ids.</summary>
    internal static class Glyphs
    {
        public static string For(string icon) => icon switch
        {
            "globe" => "",
            "folder" => "",
            "note" => "",
            "bell" => "",
            "mail" => "",
            "calendar" => "",
            "chat" => "",
            "doc" => "",
            "issue" => "",
            "cloud" => "",
            "mcp" => "",
            _ => "",
        };
    }
}
