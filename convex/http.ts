import { httpRouter } from "convex/server";
import { httpAction } from "./_generated/server";
import { api } from "./_generated/api";

const http = httpRouter();

// Telegram webhook receiver. Telegram POSTs every update (incoming user
// message, edits, etc.) to this URL. We persist text messages from the
// configured user as "inbound" rows in message_history.
//
// Register this URL with Telegram via:
//   POST https://api.telegram.org/bot<TOKEN>/setWebhook
//   {"url": "https://<deployment>.convex.site/telegram-webhook",
//    "secret_token": "<TELEGRAM_WEBHOOK_SECRET>"}
//
// If TELEGRAM_WEBHOOK_SECRET is set as a Convex env var, we verify the
// X-Telegram-Bot-Api-Secret-Token header on each request.
http.route({
  path: "/telegram-webhook",
  method: "POST",
  handler: httpAction(async (ctx, request) => {
    const expectedSecret = process.env.TELEGRAM_WEBHOOK_SECRET;
    if (expectedSecret) {
      const got = request.headers.get("X-Telegram-Bot-Api-Secret-Token");
      if (got !== expectedSecret) {
        return new Response("forbidden", { status: 403 });
      }
    }

    let update: any;
    try {
      update = await request.json();
    } catch {
      return new Response("bad json", { status: 400 });
    }

    const message = update?.message ?? update?.edited_message;
    if (!message || typeof message.text !== "string") {
      // Non-text update (sticker, photo without caption, channel post, etc.)
      // — acknowledge so Telegram doesn't retry, but don't store.
      return new Response("ok", { status: 200 });
    }

    const expectedUserId = process.env.TELEGRAM_USER_ID;
    if (
      expectedUserId &&
      String(message.from?.id ?? "") !== String(expectedUserId)
    ) {
      // Someone else messaged the bot. Acknowledge without storing.
      return new Response("ok", { status: 200 });
    }

    const replyTo =
      typeof message.reply_to_message?.message_id === "number"
        ? message.reply_to_message.message_id
        : undefined;

    await ctx.runMutation(api.messages.recordIncoming, {
      text: message.text,
      telegram_message_id: message.message_id,
      sent_at:
        typeof message.date === "number" ? message.date * 1000 : Date.now(),
      reply_to_telegram_message_id: replyTo,
    });

    return new Response("ok", { status: 200 });
  }),
});

export default http;
