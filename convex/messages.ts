import { v } from "convex/values";
import { mutation, query, internalMutation, internalQuery } from "./_generated/server";

// Upload a file to Convex Storage
export const generateUploadUrl = mutation({
  args: {},
  handler: async (ctx) => {
    // Generate a short-lived upload URL
    return await ctx.storage.generateUploadUrl();
  },
});

// Schedule a new message
export const scheduleMessage = mutation({
  args: {
    title: v.string(),
    message_text: v.optional(v.string()),
    storage_id: v.optional(v.id("_storage")), // Convex Storage ID
    file_name: v.optional(v.string()), // Original filename
    scheduled_time: v.number(),
    recurring: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const messageId = await ctx.db.insert("scheduled_messages", {
      title: args.title,
      message_text: args.message_text,
      storage_id: args.storage_id,
      file_name: args.file_name,
      scheduled_time: args.scheduled_time,
      recurring: args.recurring,
      status: "pending",
      created_at: Date.now(),
    });
    return messageId;
  },
});

// List all scheduled messages
export const listScheduled = query({
  args: {},
  handler: async (ctx) => {
    const messages = await ctx.db
      .query("scheduled_messages")
      .filter((q) => q.neq(q.field("status"), "cancelled"))
      .order("desc")
      .collect();
    return messages;
  },
});

// Get pending messages that are due (internal only - called by cron)
export const getPendingMessages = internalQuery({
  args: {},
  handler: async (ctx) => {
    const now = Date.now();
    const messages = await ctx.db
      .query("scheduled_messages")
      .withIndex("by_status_and_time", (q) => 
        q.eq("status", "pending")
      )
      .filter((q) => q.lte(q.field("scheduled_time"), now))
      .collect();
    return messages;
  },
});

// Cancel a scheduled message
export const cancelMessage = mutation({
  args: {
    messageId: v.id("scheduled_messages"),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.messageId, {
      status: "cancelled",
    });
    return { success: true };
  },
});

// Mark message as sent (internal only)
export const markAsSent = internalMutation({
  args: {
    messageId: v.id("scheduled_messages"),
    recurring: v.optional(v.string()),
  },
  handler: async (ctx, args) => {
    const message = await ctx.db.get(args.messageId);
    if (!message) return;

    // If recurring, schedule next occurrence
    if (args.recurring) {
      const nextTime = calculateNextOccurrence(
        message.scheduled_time,
        args.recurring
      );
      
      await ctx.db.patch(args.messageId, {
        scheduled_time: nextTime,
        last_sent_at: Date.now(),
      });
    } else {
      // Mark as sent
      await ctx.db.patch(args.messageId, {
        status: "sent",
        last_sent_at: Date.now(),
      });
    }
  },
});

// Mark message as failed (internal only)
export const markAsFailed = internalMutation({
  args: {
    messageId: v.id("scheduled_messages"),
    error: v.string(),
  },
  handler: async (ctx, args) => {
    await ctx.db.patch(args.messageId, {
      status: "failed",
      error_message: args.error,
    });
  },
});

// Add to message history (internal only)
export const addToHistory = internalMutation({
  args: {
    title: v.string(),
    message_text: v.optional(v.string()),
    status: v.string(),
    direction: v.optional(v.string()),
    error_message: v.optional(v.string()),
    scheduled_message_id: v.optional(v.id("scheduled_messages")),
    telegram_message_id: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    await ctx.db.insert("message_history", {
      title: args.title,
      message_text: args.message_text,
      sent_at: Date.now(),
      status: args.status,
      direction: args.direction ?? "outbound",
      error_message: args.error_message,
      scheduled_message_id: args.scheduled_message_id,
      telegram_message_id: args.telegram_message_id,
    });
  },
});

// Public mutation called by the Telegram webhook to record an incoming
// message from the user. No auth — Telegram authenticates by virtue of
// reaching this URL (you can additionally verify a secret token header
// at the HTTP action layer).
export const recordIncoming = mutation({
  args: {
    text: v.string(),
    telegram_message_id: v.number(),
    sent_at: v.number(),
    reply_to_telegram_message_id: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const title =
      args.text.length > 60 ? args.text.slice(0, 57) + "..." : args.text;
    await ctx.db.insert("message_history", {
      title,
      message_text: args.text,
      sent_at: args.sent_at,
      status: "received",
      direction: "inbound",
      telegram_message_id: args.telegram_message_id,
      reply_to_telegram_message_id: args.reply_to_telegram_message_id,
    });
  },
});

// Inbound messages addressed to a specific agent. Match rule: either
//   (a) message text starts with `<agentId>` followed by a separator
//       (`:`, space, comma, `-`), or
//   (b) reply_to_telegram_message_id matches a `telegram_message_id` of
//       an outbound row whose message_text starts with `[<agentId>]`.
// Filtering is server-side so each agent only pulls its own traffic.
export const getInboundForAgent = query({
  args: { agentId: v.string(), since: v.number() },
  handler: async (ctx, args) => {
    const lowerId = args.agentId.toLowerCase();
    const inbound = await ctx.db
      .query("message_history")
      .withIndex("by_direction", (q) => q.eq("direction", "inbound"))
      .filter((q) => q.gt(q.field("sent_at"), args.since))
      .collect();

    if (inbound.length === 0) return [];

    // Outbound message_ids belonging to this agent (any time, all-time).
    // Cheap because the dataset is per-user.
    const outbound = await ctx.db
      .query("message_history")
      .withIndex("by_direction", (q) => q.eq("direction", "outbound"))
      .collect();
    const ourTgIds = new Set<number>();
    for (const o of outbound) {
      const text = (o.message_text ?? o.title ?? "").toLowerCase();
      if (text.startsWith(`[${lowerId}]`) && o.telegram_message_id != null) {
        ourTgIds.add(o.telegram_message_id);
      }
    }

    const matched = inbound.filter((m) => {
      if (
        m.reply_to_telegram_message_id != null &&
        ourTgIds.has(m.reply_to_telegram_message_id)
      ) {
        return true;
      }
      const text = (m.message_text ?? "").trimStart().toLowerCase();
      if (!text.startsWith(lowerId)) return false;
      // Require a separator after the id (or end of text). Dash is NOT a
      // separator because it's part of agent ids — otherwise `e-eve-eve`
      // would match `e-eve-eve-other`.
      const after = text.charAt(lowerId.length);
      return after === "" || /[\s:,;]/.test(after);
    });

    return matched.sort((a, b) => a.sent_at - b.sent_at);
  },
});

// Return inbound messages strictly newer than `since` (unix ms),
// oldest-first. Used by `telegram-wait` to poll for replies.
export const getInboundSince = query({
  args: { since: v.number() },
  handler: async (ctx, args) => {
    const rows = await ctx.db
      .query("message_history")
      .withIndex("by_direction", (q) => q.eq("direction", "inbound"))
      .filter((q) => q.gt(q.field("sent_at"), args.since))
      .collect();
    return rows.sort((a, b) => a.sent_at - b.sent_at);
  },
});

// View message history
export const viewHistory = query({
  args: {
    limit: v.optional(v.number()),
  },
  handler: async (ctx, args) => {
    const limit = args.limit || 50;
    const history = await ctx.db
      .query("message_history")
      .order("desc")
      .take(limit);
    return history;
  },
});

// Helper function to calculate next occurrence for recurring messages
function calculateNextOccurrence(lastTime: number, recurring: string): number {
  const intervals: { [key: string]: number } = {
    "every minute": 60 * 1000,
    "every 5 minutes": 5 * 60 * 1000,
    "every 30 minutes": 30 * 60 * 1000,
    "every hour": 60 * 60 * 1000,
    "every 2 hours": 2 * 60 * 60 * 1000,
    "every day": 24 * 60 * 60 * 1000,
    "daily": 24 * 60 * 60 * 1000,
    "every week": 7 * 24 * 60 * 60 * 1000,
    "weekly": 7 * 24 * 60 * 60 * 1000,
  };

  // Check for simple intervals
  const interval = intervals[recurring.toLowerCase()];
  if (interval) {
    return lastTime + interval;
  }

  // For more complex recurring (handled by chrono-node in client)
  // Just add 24 hours as fallback
  return lastTime + 24 * 60 * 60 * 1000;
}
