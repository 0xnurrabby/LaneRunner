// Vercel Serverless Function: /api/leaderboard
// Weekly "season" leaderboard (This week + Last week)
//
// Goal: make leaderboard OPEN FAST.
// - NO name resolution inside the API (no ENS/Neynar/Basename calls).
// - Only scans the minimum on-chain log window needed (previous week start → latest).
// - Uses RPC rotation + safe chunking for eth_getLogs 10k block range limits.
// - Adds short edge cache + in-memory cache (warm invocations return instantly).

const CONTRACT = "0xB331328F506f2D35125e367A190e914B1b6830cF";

// keccak256("ActionLogged(address,bytes32,uint256,bytes)")
const TOPIC0_ACTION_LOGGED =
  "0x9e3ed6e89b2d18ef01c7fca2e4c53051bc35b2bfbae65aee8c6079711dd4e929";

// bytes32("WEEKLY_ADD") right-padded to 32 bytes
const TOPIC2_ACTION_WEEKLY_ADD =
  "0x5745454b4c595f41444400000000000000000000000000000000000000000000";

// Public Base RPCs (rotated)
const RPCS = [
  "https://mainnet.base.org",
  "https://base.publicnode.com",
  "https://1rpc.io/base",
  "https://base.llamarpc.com"
];

// Many public RPCs enforce eth_getLogs max block span (often 10,000).
const MAX_BLOCK_SPAN = BigInt(process.env.LOGS_MAX_BLOCK_SPAN || 9900);
const LOGS_CONCURRENCY = Math.max(
  1,
  Math.min(6, parseInt(process.env.LOGS_CONCURRENCY || "4", 10) || 4)
);

// Quick in-memory cache (survives on warm serverless invocations)
// Keyed by weekStart. TTL is short by design.
const MEM_TTL_MS = Math.max(10_000, Math.min(120_000, parseInt(process.env.MEM_CACHE_TTL_MS || "45000", 10) || 45000));
let memCache = { key: null, at: 0, data: null, inFlight: null };

function weekStartUtcMs(now = Date.now()) {
  const d = new Date(now);
  const day = d.getUTCDay();
  const diffToMon = (day + 6) % 7;
  const mon = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - diffToMon, 0, 0, 0, 0));
  return mon.getTime();
}

function toHex(n) {
  const b = typeof n === "bigint" ? n : BigInt(n);
  return "0x" + b.toString(16);
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function isRateLimitish(status, bodyText) {
  const t = (bodyText || "").toLowerCase();
  return status === 429 || t.includes("rate limit") || t.includes("too many requests") || t.includes("over rate limit");
}

async function rpcCall(url, method, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });
  const text = await res.text();
  if (!res.ok) {
    const err = new Error(`RPC HTTP ${res.status}: ${text.slice(0, 200)}`);
    err.httpStatus = res.status;
    err.bodyText = text;
    throw err;
  }
  let j;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error(`RPC bad JSON: ${text.slice(0, 200)}`);
  }
  if (j.error) {
    const err = new Error(`RPC error: ${JSON.stringify(j.error).slice(0, 200)}`);
    err.rpcError = j.error;
    throw err;
  }
  return j.result;
}

async function withRpcRotation(fn) {
  let lastErr = null;
  for (let attempt = 0; attempt < 10; attempt++) {
    const url = RPCS[attempt % RPCS.length];
    try {
      return await fn(url);
    } catch (e) {
      lastErr = e;
      const status = e?.httpStatus;
      const bodyText = e?.bodyText || "";
      if (isRateLimitish(status, bodyText)) {
        await sleep(250 + attempt * 120);
        continue;
      }
      if (status && status >= 500) {
        await sleep(180 + attempt * 80);
        continue;
      }
      if (attempt < 2) {
        await sleep(120);
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

function isGetLogsRangeError(e) {
  const msg = String(e?.rpcError?.message || e?.message || "").toLowerCase();
  return msg.includes("eth_getlogs") && msg.includes("limited") && msg.includes("blocks");
}

function isTooManyResultsError(e) {
  const msg = String(e?.rpcError?.message || e?.message || "").toLowerCase();
  return msg.includes("too many") || msg.includes("more than") || msg.includes("query returned") || msg.includes("response size");
}

async function getLogsChunked(fromBlock, toBlock) {
  const baseFilter = {
    address: CONTRACT,
    topics: [TOPIC0_ACTION_LOGGED, null, TOPIC2_ACTION_WEEKLY_ADD]
  };

  // Build fixed-size ranges (faster than repeated halving for large windows).
  const ranges = [];
  for (let f = BigInt(fromBlock); f <= BigInt(toBlock); ) {
    const t = f + MAX_BLOCK_SPAN > BigInt(toBlock) ? BigInt(toBlock) : f + MAX_BLOCK_SPAN;
    ranges.push({ f, t });
    f = t + 1n;
  }

  const out = [];
  let idx = 0;

  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= ranges.length) return;
      const { f, t } = ranges[i];

      const filter = { ...baseFilter, fromBlock: toHex(f), toBlock: toHex(t) };

      try {
        const logs = await withRpcRotation((url) => rpcCall(url, "eth_getLogs", [filter]));
        if (Array.isArray(logs) && logs.length) out.push(...logs);
      } catch (e) {
        // If provider still complains, split this range further.
        if ((isGetLogsRangeError(e) || isTooManyResultsError(e)) && t > f) {
          const mid = f + (t - f) / 2n;
          // push back split ranges to the end
          ranges.push({ f, t: mid });
          ranges.push({ f: mid + 1n, t });
          continue;
        }
        throw e;
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(LOGS_CONCURRENCY, ranges.length) }, worker));
  return out;
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

async function computeWeeklySeason(weekStartMs) {
  const prevWeekStartMs = weekStartMs - 7 * 24 * 60 * 60 * 1000;

  // Find a reasonable fromBlock that covers previous week start → now.
  // Use block timestamps for a tighter estimate.
  const latestBlock = await getBlockByNumber("latest");
  const latest = BigInt(latestBlock.number);
  const latestTs = BigInt(latestBlock.timestamp); // seconds

  // Estimate avg seconds per block using a short lookback.
  const SAMPLE = 20_000n;
  const oldNum = latest > SAMPLE ? latest - SAMPLE : 0n;
  const oldBlock = await getBlockByNumber(toHex(oldNum));
  const oldTs = BigInt(oldBlock.timestamp);

  let secPerBlock = Number(latestTs - oldTs) / Math.max(1, Number(latest - oldNum));
  if (!Number.isFinite(secPerBlock) || secPerBlock <= 0.5 || secPerBlock > 10) secPerBlock = 2;

  const prevWeekStartSec = Math.floor(prevWeekStartMs / 1000);
  const latestSec = Number(latestTs);
  const lookbackSec = Math.max(0, latestSec - prevWeekStartSec);

  // Buffer so we don't miss edge logs.
  const bufferBlocks = 6000;
  const lookbackBlocks = BigInt(Math.ceil(lookbackSec / secPerBlock) + bufferBlocks);
  const fromBlock = latest > lookbackBlocks ? latest - lookbackBlocks : 0n;

  const logs = await getLogsChunked(fromBlock, latest);

  const weeklyMap = new Map();
  const prevWeekMap = new Map();
  const wkKey = BigInt(weekStartMs).toString();
  const prevKey = BigInt(prevWeekStartMs).toString();

  for (const l of logs) {
    const user = addrFromTopic(l.topics?.[1]);
    const payload = extractBytesParamFromLogData(l.data);
    const dec = decodePointsAndWeek(payload);
    if (!dec) continue;
    const weekKey = dec.week.toString();
    if (weekKey === wkKey) {
      weeklyMap.set(user, (weeklyMap.get(user) || 0n) + dec.points);
    } else if (weekKey === prevKey) {
      prevWeekMap.set(user, (prevWeekMap.get(user) || 0n) + dec.points);
    }
  }

  const weeklySorted = sortMapToArray(weeklyMap);
  const prevWeekSorted = sortMapToArray(prevWeekMap);

  const toJson = (arr) =>
    arr.slice(0, 200).map((x) => ({ addr: x.addr, pts: x.pts.toString(), name: null }));

  return {
    weekStart: weekStartMs,
    prevWeekStart: prevWeekStartMs,
    weeklySorted: toJson(weeklySorted),
    prevWeekSorted: toJson(prevWeekSorted)
  };
}

module.exports = async function handler(req, res) {
  try {
    const now = Date.now();
    const weekStart = Number(req.query.weekStart || weekStartUtcMs(now));
    const cacheKey = `w:${weekStart}`;

    // 1) Warm cache hit => instant response
    if (memCache.data && memCache.key === cacheKey && now - memCache.at < MEM_TTL_MS) {
      res.setHeader("cache-control", "s-maxage=60, stale-while-revalidate=600");
      return res.status(200).json(memCache.data);
    }

    // 2) Coalesce concurrent requests on warm instances
    if (memCache.inFlight && memCache.key === cacheKey) {
      const data = await memCache.inFlight;
      res.setHeader("cache-control", "s-maxage=60, stale-while-revalidate=600");
      return res.status(200).json(data);
    }

    memCache.key = cacheKey;
    memCache.inFlight = computeWeeklySeason(weekStart)
      .then((data) => {
        memCache.data = data;
        memCache.at = Date.now();
        return data;
      })
      .finally(() => {
        memCache.inFlight = null;
      });

    const data = await memCache.inFlight;
    res.setHeader("cache-control", "s-maxage=60, stale-while-revalidate=600");
    res.status(200).json(data);
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
};
