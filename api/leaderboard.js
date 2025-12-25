// Vercel Serverless Function: /api/leaderboard
// Fast weekly-season leaderboard for Base.
//
// Why this is fast:
// - Scans ONLY current week + previous week
// - Uses fixed chunking (<= 9,900 blocks) instead of repeated "halve" splitting
// - Higher, safe concurrency across multiple public RPCs
// - No external name-resolution calls (UI already shows full addresses / local mappings)

const CONTRACT = "0xB331328F506f2D35125e367A190e914B1b6830cF";

// keccak256("ActionLogged(address,bytes32,uint256,bytes)")
const TOPIC0_ACTION_LOGGED =
  "0x9e3ed6e89b2d18ef01c7fca2e4c53051bc35b2bfbae65aee8c6079711dd4e929";

// bytes32("WEEKLY_ADD") right-padded to 32 bytes
const TOPIC2_ACTION_WEEKLY_ADD =
  "0x5745454b4c595f41444400000000000000000000000000000000000000000000";

// Public Base RPCs
// You can override by setting BASE_RPC_URLS as a comma-separated list (recommended for reliability).
const DEFAULT_RPCS = [
  "https://mainnet.base.org",
  "https://base.publicnode.com",
  "https://1rpc.io/base",
  "https://base.llamarpc.com",
  // Often works without an API key, but may be rate-limited.
  "https://rpc.ankr.com/base"
];

const ENV_RPCS = (process.env.BASE_RPC_URLS || process.env.BASE_RPC_URL || "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);

const RPCS = ENV_RPCS.length ? ENV_RPCS : DEFAULT_RPCS;

// Per-RPC request timeout. Too long can stall the whole function; too short can cause retries.
const RPC_TIMEOUT_MS = Math.max(
  3000,
  Math.min(30000, parseInt(process.env.RPC_TIMEOUT_MS || "12000", 10) || 12000)
);

// Most public RPCs cap eth_getLogs span (often 10,000 blocks)
const MAX_BLOCK_SPAN = BigInt(process.env.LOGS_MAX_BLOCK_SPAN || "9900");

// Higher default concurrency makes weekly scans finish much quicker.
// Keep a safe cap so we don't hit 429s too hard.
const LOGS_CONCURRENCY = Math.max(
  1,
  Math.min(6, parseInt(process.env.LOGS_CONCURRENCY || "4", 10) || 4)
);

function toHex(n) {
  const b = typeof n === "bigint" ? n : BigInt(n);
  return "0x" + b.toString(16);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isRateLimitish(status, bodyText) {
  const t = (bodyText || "").toLowerCase();
  return (
    status === 429 ||
    t.includes("rate limit") ||
    t.includes("too many requests") ||
    t.includes("over rate limit")
  );
}

function isGetLogsSplitError(e) {
  const msg = String(e?.rpcError?.message || e?.message || "").toLowerCase();
  return (
    (msg.includes("eth_getlogs") && msg.includes("limited") && msg.includes("blocks")) ||
    msg.includes("too many results") ||
    (msg.includes("more than") && msg.includes("results")) ||
    msg.includes("response size")
  );
}

async function rpcCall(url, method, params) {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), RPC_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: controller.signal
    });

    const text = await res.text();

    if (!res.ok) {
      const err = new Error(`RPC HTTP ${res.status}: ${text.slice(0, 220)}`);
      err.httpStatus = res.status;
      err.bodyText = text;
      throw err;
    }

    let j;
    try {
      j = JSON.parse(text);
    } catch {
      throw new Error(`RPC bad JSON: ${text.slice(0, 220)}`);
    }

    if (j.error) {
      const err = new Error(`RPC error: ${JSON.stringify(j.error).slice(0, 220)}`);
      err.rpcError = j.error;
      throw err;
    }

    return j.result;
  } catch (e) {
    // Node fetch throws TypeError('fetch failed') for network errors.
    if (e?.name === "AbortError") {
      const err = new Error(`RPC timeout after ${RPC_TIMEOUT_MS}ms`);
      err.isTimeout = true;
      throw err;
    }
    if (e instanceof TypeError && String(e.message || "").toLowerCase().includes("fetch failed")) {
      e.isNetworkError = true;
    }
    throw e;
  } finally {
    clearTimeout(t);
  }
}

async function withRpcRotation(fn) {
  let lastErr = null;
  const n = Math.max(1, RPCS.length);
  // Randomize start so concurrent workers don't all hammer the same first RPC.
  const seed = Math.floor(Math.random() * n);
  const maxAttempts = Math.max(6, Math.min(14, n * 3));

  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const url = RPCS[(seed + attempt) % n];
    try {
      return await fn(url);
    } catch (e) {
      lastErr = e;
      const status = e?.httpStatus;
      const bodyText = e?.bodyText || "";

      // Backoff patterns
      if (isRateLimitish(status, bodyText)) {
        await sleep(240 + attempt * 140);
        continue;
      }
      if (status && status >= 500) {
        await sleep(200 + attempt * 120);
        continue;
      }
      if (e?.isNetworkError || e?.isTimeout) {
        await sleep(200 + attempt * 120);
        continue;
      }

      // A couple of quick retries for transient issues
      if (attempt < 2) {
        await sleep(150);
        continue;
      }
      throw e;
    }
  }
  throw lastErr || new Error("RPC failed");
}

async function getBlockByNumber(tag) {
  return await withRpcRotation((url) => rpcCall(url, "eth_getBlockByNumber", [tag, false]));
}

function weekStartUtcMs(now = Date.now()) {
  const d = new Date(now);
  const day = d.getUTCDay();
  const diffToMon = (day + 6) % 7;
  const mon = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - diffToMon, 0, 0, 0, 0)
  );
  return mon.getTime();
}

// Decode ActionLogged log data: (uint256 timestamp, bytes data)
function extractBytesParamFromLogData(logDataHex) {
  const hex = (logDataHex || "").startsWith("0x") ? logDataHex.slice(2) : (logDataHex || "");
  if (hex.length < 128) return "0x";

  const offset = BigInt("0x" + hex.slice(64, 128));
  const offsetHexIndex = Number(offset) * 2;
  if (hex.length < offsetHexIndex + 64) return "0x";

  const len = BigInt("0x" + hex.slice(offsetHexIndex, offsetHexIndex + 64));
  const bytesStart = offsetHexIndex + 64;
  const bytesEnd = bytesStart + Number(len) * 2;
  if (hex.length < bytesEnd) return "0x";

  return "0x" + hex.slice(bytesStart, bytesEnd);
}

// Decode our payload bytes: abi.encode(uint256 points, uint256 weekStartMs)
function decodePointsAndWeek(payloadHex) {
  const hex = payloadHex.startsWith("0x") ? payloadHex.slice(2) : payloadHex;
  if (hex.length < 128) return null;

  const points = BigInt("0x" + hex.slice(0, 64));
  const week = BigInt("0x" + hex.slice(64, 128));
  return { points, week };
}

function addrFromTopic(topic1) {
  const t = (topic1 || "").startsWith("0x") ? topic1.slice(2) : (topic1 || "");
  return "0x" + t.slice(t.length - 40);
}

function sortMapToArray(map) {
  return [...map.entries()]
    .map(([addr, pts]) => ({ addr, pts }))
    .sort((a, b) => (a.pts === b.pts ? 0 : a.pts > b.pts ? -1 : 1));
}

async function getLogsChunked(fromBlock, toBlock) {
  const baseFilter = {
    address: CONTRACT,
    topics: [TOPIC0_ACTION_LOGGED, null, TOPIC2_ACTION_WEEKLY_ADD]
  };

  const queue = [];
  for (let f = fromBlock; f <= toBlock; ) {
    const t = f + MAX_BLOCK_SPAN > toBlock ? toBlock : f + MAX_BLOCK_SPAN;
    queue.push({ f, t });
    f = t + 1n;
  }

  const out = [];
  let idx = 0;

  async function worker() {
    while (true) {
      const i = idx++;
      const r = queue[i];
      if (!r) return;

      const filter = {
        ...baseFilter,
        fromBlock: toHex(r.f),
        toBlock: toHex(r.t)
      };

      try {
        const logs = await withRpcRotation((url) => rpcCall(url, "eth_getLogs", [filter]));
        if (Array.isArray(logs) && logs.length) out.push(...logs);
      } catch (e) {
        // Some RPCs still fail even for < MAX_BLOCK_SPAN (too many results or stricter limits).
        // Split this range further and retry.
        if (isGetLogsSplitError(e) && r.t > r.f) {
          const mid = r.f + (r.t - r.f) / 2n;
          queue.push({ f: r.f, t: mid });
          queue.push({ f: mid + 1n, t: r.t });
          continue;
        }
        throw e;
      }
    }
  }

  const workers = Math.min(LOGS_CONCURRENCY, Math.max(1, queue.length));
  await Promise.all(Array.from({ length: workers }, worker));
  return out;
}

module.exports = async function handler(req, res) {
  try {
    const now = Date.now();
    const weekStart = Number(req.query.weekStart || weekStartUtcMs(now));
    const prevWeekStart = weekStart - 7 * 24 * 60 * 60 * 1000;

    // Estimate a minimal scan range using timestamps.
    const latestBlock = await getBlockByNumber("latest");
    const latest = BigInt(latestBlock.number);
    const latestTs = BigInt(latestBlock.timestamp); // seconds

    // Small lookback to estimate block time (keeps overhead tiny)
    const SAMPLE = 12000n;
    const oldNum = latest > SAMPLE ? latest - SAMPLE : 0n;
    const oldBlock = await getBlockByNumber(toHex(oldNum));
    const oldTs = BigInt(oldBlock.timestamp);

    const dt = Number(latestTs - oldTs);
    const dn = Number(latest - oldNum) || 1;
    let secPerBlock = dt / dn;
    if (!Number.isFinite(secPerBlock) || secPerBlock <= 0.5 || secPerBlock > 10) secPerBlock = 2;

    const prevWeekStartSec = Math.floor(prevWeekStart / 1000);
    const latestSec = Number(latestTs);
    const lookbackSec = Math.max(0, latestSec - prevWeekStartSec);

    // Buffer so we don't miss edge logs around week boundaries.
    // Base is ~2s per block, so 2,000 blocks is ~1.1h.
    const bufferBlocks = Number(process.env.LOGS_BUFFER_BLOCKS || 1200);
    const lookbackBlocks = BigInt(Math.ceil(lookbackSec / secPerBlock) + bufferBlocks);
    const fromBlock = latest > lookbackBlocks ? latest - lookbackBlocks : 0n;

    const logs = await getLogsChunked(fromBlock, latest);

    const weeklyMap = new Map();
    const prevWeekMap = new Map();
    const wkKey = BigInt(weekStart).toString();
    const prevKey = BigInt(prevWeekStart).toString();

    for (const l of logs) {
      const user = addrFromTopic(l.topics?.[1]);
      const payload = extractBytesParamFromLogData(l.data);
      const dec = decodePointsAndWeek(payload);
      if (!dec) continue;

      const points = dec.points;
      const weekKey = dec.week.toString();
      if (weekKey === wkKey) {
        weeklyMap.set(user, (weeklyMap.get(user) || 0n) + points);
      } else if (weekKey === prevKey) {
        prevWeekMap.set(user, (prevWeekMap.get(user) || 0n) + points);
      }
    }

    const weeklySorted = sortMapToArray(weeklyMap);
    const prevWeekSorted = sortMapToArray(prevWeekMap);

    // Return top 100 only (UI shows Top 100)
    const toJson = (arr) =>
      arr.slice(0, 100).map((x) => ({
        addr: x.addr,
        pts: x.pts.toString(),
        name: null
      }));

    // Cache at the edge so most users open instantly.
    res.setHeader("cache-control", "s-maxage=900, stale-while-revalidate=86400");
    res.status(200).json({
      weekStart,
      prevWeekStart,
      weeklySorted: toJson(weeklySorted),
      prevWeekSorted: toJson(prevWeekSorted)
    });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
};
