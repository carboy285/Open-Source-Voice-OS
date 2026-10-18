import type { ReminderStore } from "../reminders/scheduler.js";
import { filesConnector } from "./files.js";
import { obsidianConnector } from "./obsidian.js";
import { remindersConnector } from "./reminders.js";
import { appleConnectors, type NativeCall } from "./apple.js";
import { calendarConnector } from "./skeletons/calendar.js";
import { driveConnector } from "./skeletons/drive.js";
import { gmailConnector } from "./skeletons/gmail.js";
import { linearConnector } from "./skeletons/linear.js";
import { notionConnector } from "./skeletons/notion.js";
import { slackConnector } from "./skeletons/slack.js";
import type { Connector } from "./types.js";
import { webConnector } from "./web.js";
import { writingConnector, type InsertText } from "./writing.js";

/** Every built-in connector, in catalog order. */
export function builtinConnectors(reminders: ReminderStore, native?: NativeCall, insert?: InsertText): Connector[] {
  return [
    webConnector(),
    filesConnector(),
    obsidianConnector(),
    remindersConnector(reminders),
    ...(insert ? [writingConnector(insert)] : []),
    gmailConnector(),
    calendarConnector(),
    slackConnector(),
    notionConnector(),
    linearConnector(),
    driveConnector(),
    ...(native ? appleConnectors(native) : []),
  ];
}
