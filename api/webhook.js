// Vercel Serverless Function: /api/webhook
// Handles Mini App notification webhooks (Base app / Farcaster).
// - Verifies events with Neynar when NEYNAR_API_KEY is set (recommended).
// - Saves notificationDetails (token+url) per (fid, appFid).
// - Responds fast (<10s) to avoid Base app activation failures.

const { parseWebhookEvent, verifyAppKeyWithNeynar } = require("@farcaster/miniapp-node");

// Optional KV store (Upstash preferred). Safe fallback if not configured.
let store = null;
try {
  // eslint-disable-next-line import/no-extraneous-dependencies
  const { Redis } = require("@upstash/redis");
  if (process.env.UPSTASH_REDIS_REST_URL && process.env.UPSTASH_REDIS_REST_TOKEN) {
    const redis = new Redis({
      url: process.env.UPSTASH_REDIS_REST_URL,
      token: process.env.UPSTASH_REDIS_REST_TOKEN,
    });
    store = {
      kind: "upstash",
      get: (k) => redis.get(k),
      set: (k, v, opts) => redis.set(k, v, opts),
      del: (k) => redis.del(k),
    };
  }
} catch (_) {
  // ignore
}

if (!store) {
  try {
    // eslint-disable-next-line import/no-extraneous-dependencies
    const kv = require("@vercel/kv").kv;
    if (kv && process.env.KV_REST_API_URL && process.env.KV_REST_API_TOKEN) {
      store = {
        kind: "vercel-kv",
        get: (k) => kv.get(k),
        set: (k, v, opts) => kv.set(k, v, opts),
        del: (k) => kv.del(k),
      };
    }
  } catch (_) {
    // ignore
  }
}

const KV_PREFIX = "lanerunner:notifs:v1";
const TTL_SECONDS = 60 * 60 * 24 * 60; // 60 days

function notifKey(fid, appFid) {
  return `${KV_PREFIX}:${fid}:${appFid}`;
}

async function readJsonBody(req) {
  // In Vercel/Next-style API routes, req.body is usually already parsed.
  if (req.body && typeof req.body === "object") return req.body;

  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const raw = Buffer.concat(chunks).toString("utf-8");
  return raw ? JSON.parse(raw) : {};
}

// In-memory fallback (works only per warm serverless instance)
function memStore() {
  // eslint-disable-next-line no-underscore-dangle
  globalThis.__LR_NOTIF_MEM__ = globalThis.__LR_NOTIF_MEM__ || {};
  // eslint-disable-next-line no-underscore-dangle
  return globalThis.__LR_NOTIF_MEM__;
}

async function setUserNotificationDetails(fid, appFid, notificationDetails) {
  const k = notifKey(fid, appFid);
  const v = {
    fid,
    appFid,
    url: notificationDetails.url,
    token: notificationDetails.token,
    updatedAt: Date.now(),
  };
  if (store) {
    await store.set(k, v, { ex: TTL_SECONDS });
  } else {
    memStore()[k] = v;
  }
}

async function deleteUserNotificationDetails(fid, appFid) {
  const k = notifKey(fid, appFid);
  if (store) {
    await store.del(k);
  } else {
    delete memStore()[k];
  }
}

module.exports = async (req, res) => {
  // Health / debug
  if (req.method !== "POST") {
    res.status(200).json({ ok: true });
    return;
  }

  let requestJson;
  try {
    requestJson = await readJsonBody(req);
  } catch (e) {
    res.status(400).json({ ok: false, error: "invalid_json" });
    return;
  }

  // Verify webhook events.
  // NOTE: For production security, you should set NEYNAR_API_KEY.
  const verifyFn = async (...args) => {
    if (!process.env.NEYNAR_API_KEY) return true; // best-effort fallback
    return verifyAppKeyWithNeynar(...args);
  };

  let data;
  try {
    data = await parseWebhookEvent(requestJson, verifyFn);
  } catch (e) {
    // If signature/appkey validation fails, return 401.
    // (Base app requires a successful response to activate tokens.)
    res.status(401).json({ ok: false, error: "invalid_signature" });
    return;
  }

  const fid = data.fid;
  const appFid = data.appFid;
  const event = data.event;

  try {
    switch (event.event) {
      case "miniapp_added":
      case "notifications_enabled":
        if (event.notificationDetails) {
          await setUserNotificationDetails(fid, appFid, event.notificationDetails);
        }
        break;
      case "miniapp_removed":
      case "notifications_disabled":
        await deleteUserNotificationDetails(fid, appFid);
        break;
      default:
        // ignore unknown event types
        break;
    }
  } catch (err) {
    // Still return 200 so Base app doesn't fail enabling due to storage hiccups.
    // Log for debugging.
    console.error("Webhook processing error:", err);
  }

  // Respond quickly.
  res.status(200).json({ ok: true });
};
