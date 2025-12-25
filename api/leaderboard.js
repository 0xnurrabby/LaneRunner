// Vercel Serverless Function: /api/leaderboard
// Server-side leaderboard aggregation to avoid mobile RPC limits.
//
// - Uses JSON-RPC directly (no heavy deps).
// - Uses RPC rotation + retries to reduce 429s.
// - Scans ONLY the minimal range required to serve a "weekly season" leaderboard:
//   current week + previous week.
//   (No all-time scan to keep this fast and avoid RPC limits.)
//
// Leaderboard display-name resolution priority:
// 1) Basename primary (xxxxx.base.eth) via Basenames L2Resolver reverse resolution
// 2) ENS primary (xxxxx.eth) via ensdata.net reverse lookup
// 3) Farcaster username -> xxxxx.farcaster.eth via Neynar bulk-by-address

const { keccak_256 } = require("js-sha3");

const CONTRACT = "0xB331328F506f2D35125e367A190e914B1b6830cF";

// Basenames: L2 Resolver (Base mainnet)
const BASENAME_L2_RESOLVER_ADDRESS = "0xC6d566A56A1aFf6508b41f6c90ff131615583BCD";
// name(bytes32) selector = bytes4(keccak256("name(bytes32)"))
const SELECTOR_NAME_BYTES32 = "0x691f3431";

// keccak256("ActionLogged(address,bytes32,uint256,bytes)")
const TOPIC0_ACTION_LOGGED =
  "0x9e3ed6e89b2d18ef01c7fca2e4c53051bc35b2bfbae65aee8c6079711dd4e929";

// bytes32("WEEKLY_ADD") right-padded to 32 bytes
const TOPIC2_ACTION_WEEKLY_ADD =
  "0x5745454b4c595f41444400000000000000000000000000000000000000000000";

// Public Base RPCs (avoid Alchemy free-tier block-range limits)
const RPCS = [
  "https://mainnet.base.org",
  "https://base.publicnode.com",
  "https://1rpc.io/base",
  "https://base.llamarpc.com"
];

// Many public RPCs enforce eth_getLogs max block span (often 10,000).
// Keep a small safety margin.
const MAX_BLOCK_SPAN = BigInt(process.env.LOGS_MAX_BLOCK_SPAN || 9900);
const LOGS_CONCURRENCY = Math.max(1, Math.min(4, parseInt(process.env.LOGS_CONCURRENCY || "2", 10) || 2));

function isGetLogsRangeError(e) {
  const msg = String(e?.rpcError?.message || e?.message || "").toLowerCase();
  return msg.includes("eth_getlogs") && msg.includes("limited") && msg.includes("blocks");
}

function isTooManyResultsError(e) {
  const msg = String(e?.rpcError?.message || e?.message || "").toLowerCase();
  return msg.includes("too many") || msg.includes("more than") || msg.includes("query returned") || msg.includes("response size");
}

async function getBlockByNumber(blockTag) {
  return await withRpcRotation((url) => rpcCall(url, "eth_getBlockByNumber", [blockTag, false]));
}

async function getLogsSafe(fromBlock, toBlock) {
  // Split ranges aggressively to satisfy provider limits and avoid "too many results" responses.
  const queue = [{ from: BigInt(fromBlock), to: BigInt(toBlock) }];
  const out = [];
  async function worker() {
    while (true) {
      const range = queue.pop();
      if (!range) return;
      const span = range.to - range.from;

      // Hard split on configured max span.
      if (span > MAX_BLOCK_SPAN) {
        const mid = range.from + (span / 2n);
        queue.push({ from: range.from, to: mid });
        queue.push({ from: mid + 1n, to: range.to });
        continue;
      }

      const filter = {
        address: CONTRACT,
        fromBlock: toHex(range.from),
        toBlock: toHex(range.to),
        topics: [TOPIC0_ACTION_LOGGED, null, TOPIC2_ACTION_WEEKLY_ADD]
      };

      try {
        const logs = await withRpcRotation((url) => rpcCall(url, "eth_getLogs", [filter]));
        if (Array.isArray(logs) && logs.length) out.push(...logs);
      } catch (e) {
        // If provider complains, split further.
        if ((isGetLogsRangeError(e) || isTooManyResultsError(e)) && range.from < range.to) {
          const mid = range.from + ((range.to - range.from) / 2n);
          queue.push({ from: range.from, to: mid });
          queue.push({ from: mid + 1n, to: range.to });
          continue;
        }
        throw e;
      }
    }
  }

  await Promise.all(Array.from({ length: LOGS_CONCURRENCY }, worker));
  return out;
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

async function rpcCall(url, method, params) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params })
  });

  const text = await res.text();

  if (!res.ok) {
    const err = new Error(`RPC HTTP ${res.status}: ${text.slice(0, 240)}`);
    err.httpStatus = res.status;
    err.bodyText = text;
    throw err;
  }

  let j;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error(`RPC bad JSON: ${text.slice(0, 240)}`);
  }

  if (j.error) {
    const err = new Error(`RPC error: ${JSON.stringify(j.error).slice(0, 240)}`);
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
        await sleep(350 + attempt * 150);
        continue;
      }

      if (status && status >= 500) {
        await sleep(250 + attempt * 120);
        continue;
      }

      if (attempt < 2) {
        await sleep(200);
        continue;
      }

      throw e;
    }
  }
  throw lastErr || new Error("RPC failed");
}

// --------------------------
// eth_getLogs safety helpers
// --------------------------

function isLogsRangeLimitError(e) {
  const msg = String(e?.message || "").toLowerCase();
  return msg.includes("eth_getlogs") && msg.includes("limited") && msg.includes("blocks");
}

function isTooManyResultsError(e) {
  const msg = String(e?.message || "").toLowerCase();
  return (
    msg.includes("too many results") ||
    msg.includes("more than") && msg.includes("results") ||
    msg.includes("response size")
  );
}

async function getBlockByNumber(tag) {
  // tag can be "latest" or a hex block number
  return await withRpcRotation((url) => rpcCall(url, "eth_getBlockByNumber", [tag, false]));
}

async function estimateAvgBlockTimeSeconds(latestBlockNum) {
  // Estimate using a short lookback to avoid extra RPC load.
  // If anything fails, fall back to Base's ~2s.
  try {
    const latest = await getBlockByNumber(toHex(latestBlockNum));
    const latestTs = BigInt(latest?.timestamp || "0x0");

    const back = latestBlockNum > 20000n ? latestBlockNum - 20000n : 0n;
    const older = await getBlockByNumber(toHex(back));
    const olderTs = BigInt(older?.timestamp || "0x0");

    const dt = Number(latestTs - olderTs);
    const db = Number(latestBlockNum - back);
    if (dt > 0 && db > 0) {
      const avg = dt / db;
      if (avg > 0.5 && avg < 10) return avg;
    }
  } catch {}
  return 2;
}

async function ethGetLogsChunked(baseFilter, fromBlock, toBlock) {
  const maxSpan = BigInt(process.env.LOGS_MAX_BLOCK_SPAN || "9900");
  const conc = Math.max(1, Math.min(4, parseInt(process.env.LOGS_CONCURRENCY || "2", 10) || 2));

  // Build initial ranges.
  const ranges = [];
  for (let f = fromBlock; f <= toBlock; ) {
    const t = f + maxSpan > toBlock ? toBlock : f + maxSpan;
    ranges.push({ f, t });
    f = t + 1n;
  }

  const out = [];
  let idx = 0;

  async function worker() {
    while (idx < ranges.length) {
      const i = idx++;
      const { f, t } = ranges[i];

      const filter = {
        ...baseFilter,
        fromBlock: toHex(f),
        toBlock: toHex(t)
      };

      try {
        const logs = await withRpcRotation((url) => rpcCall(url, "eth_getLogs", [filter]));
        if (Array.isArray(logs) && logs.length) out.push(...logs);
      } catch (e) {
        // Some RPCs still throw even within maxSpan (e.g., strict limits or too many results).
        // Split further and retry (down to single-block range), but keep it safe.
        if ((isLogsRangeLimitError(e) || isTooManyResultsError(e)) && t > f) {
          const mid = f + (t - f) / 2n;
          ranges.push({ f, t: mid });
          ranges.push({ f: mid + 1n, t });
          continue;
        }
        throw e;
      }
    }
  }

  await Promise.all(Array.from({ length: conc }, worker));
  return out;
}

// --------------------------
// Log decoding (existing)
// --------------------------

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

// Decode our payload bytes: abi.encode(uint256 points, uint256 weekStartMs, ...)
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

// --------------------------
// Farcaster names via Neynar (existing, lightly cleaned)
// --------------------------
async function fetchNamesFromNeynar(addresses) {
  const key = process.env.NEYNAR_API_KEY;
  if (!key) return new Map();

  const uniq = [...new Set((addresses || []).map((a) => String(a || "").toLowerCase()))].filter(Boolean);
  if (!uniq.length) return new Map();

  const out = new Map();
  const chunkSize = 200;

  for (let i = 0; i < uniq.length; i += chunkSize) {
    const chunk = uniq.slice(i, i + chunkSize);
    const url =
      "https://api.neynar.com/v2/farcaster/user/bulk-by-address?" +
      new URLSearchParams({
        addresses: chunk.join(","),
        address_types: "custody_address,verified_address"
      });

    const r = await fetch(url, { headers: { "x-api-key": key } });
    if (!r.ok) continue;

    const j = await r.json();
    for (const u of j?.users || []) {
      if (!u?.username) continue;

      const custody = u?.custody_address ? String(u.custody_address).toLowerCase() : null;
      if (custody) out.set(custody, u.username);

      for (const a of u?.verified_addresses?.eth_addresses || []) {
        out.set(String(a).toLowerCase(), u.username);
      }
    }
  }

  return out;
}

// --------------------------
// ENS primary via ensdata.net
// --------------------------
async function fetchEnsPrimaryFromEnsData(addresses) {
  const out = new Map();
  const uniq = [...new Set((addresses || []).map((a) => String(a || "").toLowerCase()))].filter(Boolean);
  if (!uniq.length) return out;

  const limit = 6;
  let idx = 0;

  async function worker() {
    while (idx < uniq.length) {
      const i = idx++;
      const addr = uniq[i];
      try {
        const r = await fetch(`https://api.ensdata.net/${addr}`, { headers: { accept: "application/json" } });
        if (!r.ok) continue;
        const j = await r.json();
        const ens = j?.ens_primary;
        if (typeof ens === "string" && ens.length) out.set(addr, ens);
      } catch {}
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, uniq.length) }, worker));
  return out;
}

// --------------------------
// Basename reverse resolution (onchain) - no external deps beyond js-sha3
// Implements the same reverse-node derivation as OnchainKit's convertReverseNodeToBytes()
// --------------------------
function keccakHexFromUtf8(str) {
  const h = keccak_256(str); // hex without 0x
  return "0x" + h;
}

function keccakHexFromBytes(hex) {
  const clean = hex.startsWith("0x") ? hex.slice(2) : hex;
  const bytes = Buffer.from(clean, "hex");
  const h = keccak_256(bytes);
  return "0x" + h;
}

// ENS namehash (EIP-137)
function namehash(name) {
  let node = Buffer.alloc(32, 0);
  const labels = (name || "").split(".").filter(Boolean);
  for (let i = labels.length - 1; i >= 0; i--) {
    const label = labels[i].toLowerCase();
    const labelHash = Buffer.from(keccak_256(label), "hex");
    node = Buffer.from(keccak_256(Buffer.concat([node, labelHash])), "hex");
  }
  return "0x" + node.toString("hex");
}

// chainId -> coinType string (same logic as OnchainKit)
function convertChainIdToCoinType(chainId) {
  const MAINNET_ID = 1;
  if (chainId === MAINNET_ID) return "addr";
  const cointype = (0x80000000 | chainId) >>> 0;
  return cointype.toString(16).toUpperCase();
}

// bytes32 concat (encodePacked(['bytes32','bytes32'],...))
function packBytes32x2(a, b) {
  const A = Buffer.from((a.startsWith("0x") ? a.slice(2) : a).padStart(64, "0"), "hex");
  const B = Buffer.from((b.startsWith("0x") ? b.slice(2) : b).padStart(64, "0"), "hex");
  return "0x" + Buffer.concat([A, B]).toString("hex");
}

function convertReverseNodeToBytes(address, chainId) {
  const addr = String(address || "").toLowerCase();
  if (!addr.startsWith("0x") || addr.length !== 42) return null;

  // keccak256(lowercaseHexAddressWithout0x) as UTF-8 (matches OnchainKit usage)
  const addressNode = keccakHexFromUtf8(addr.substring(2));

  const chainCoinType = convertChainIdToCoinType(chainId);
  const baseReverseNode = namehash(`${chainCoinType.toUpperCase()}.reverse`);

  const packed = packBytes32x2(baseReverseNode, addressNode);
  const addressReverseNode = keccakHexFromBytes(packed);
  return addressReverseNode;
}

function decodeAbiString(resultHex) {
  // result: 0x + 32(offset) + 32(len) + data...
  const hex = (resultHex || "").startsWith("0x") ? resultHex.slice(2) : (resultHex || "");
  if (hex.length < 128) return null;

  const offset = parseInt(hex.slice(0, 64), 16) * 2; // bytes -> hex chars
  if (!Number.isFinite(offset)) return null;
  if (hex.length < offset + 64) return null;

  const len = parseInt(hex.slice(offset, offset + 64), 16);
  if (!Number.isFinite(len) || len <= 0) return null;

  const start = offset + 64;
  const end = start + len * 2;
  if (hex.length < end) return null;

  const strBytes = Buffer.from(hex.slice(start, end), "hex");
  const s = strBytes.toString("utf8").trim();
  return s || null;
}

async function fetchBasenamesOnBase(addresses) {
  const out = new Map();
  const uniq = [...new Set((addresses || []).map((a) => String(a || "").toLowerCase()))].filter(Boolean);
  if (!uniq.length) return out;

  // Base mainnet chainId
  const CHAIN_ID = 8453;

  // Limit calls: resolve only the top entries; also concurrency limit
  const limit = 8;
  let idx = 0;

  async function worker() {
    while (idx < uniq.length) {
      const i = idx++;
      const addr = uniq[i];

      const node = convertReverseNodeToBytes(addr, CHAIN_ID);
      if (!node) continue;

      // eth_call to L2 resolver: name(bytes32)
      const data = SELECTOR_NAME_BYTES32 + node.slice(2).padStart(64, "0");
      const call = [
        {
          to: BASENAME_L2_RESOLVER_ADDRESS,
          data
        },
        "latest"
      ];

      try {
        const result = await withRpcRotation((url) => rpcCall(url, "eth_call", call));
        const name = decodeAbiString(result);

        if (name && name.endsWith(".base.eth")) out.set(addr, name);
      } catch {
        // ignore per-address failures
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, uniq.length) }, worker));
  return out;
}

// --------------------------
// Sorting helpers (existing)
// --------------------------
function sortMapToArray(map) {
  return [...map.entries()]
    .map(([addr, pts]) => ({ addr, pts }))
    .sort((a, b) => (a.pts === b.pts ? 0 : a.pts > b.pts ? -1 : 1));
}

module.exports = async function handler(req, res) {
  try {
    const now = Date.now();
    const weekStart = Number(req.query.weekStart || weekStartUtcMs(now));
    const prevWeekStart = weekStart - 7 * 24 * 60 * 60 * 1000;

    // Find a reasonable fromBlock that covers previous week start → now.
    // We estimate using block timestamps to avoid scanning unnecessary blocks.
    const latestBlock = await getBlockByNumber("latest");
    const latest = BigInt(latestBlock.number);
    const latestTs = BigInt(latestBlock.timestamp); // seconds

    // Estimate average seconds per block using a sample window.
    const SAMPLE = 20000n;
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

    // Add a buffer (in blocks) so we don't miss edge logs around week boundaries.
    const bufferBlocks = 8000;
    const lookbackBlocks = BigInt(Math.ceil(lookbackSec / secPerBlock) + bufferBlocks);
    const fromBlock = latest > lookbackBlocks ? latest - lookbackBlocks : 0n;

    // Scan logs safely (provider max span, too-many-results splitting).
    const logs = await getLogsSafe(fromBlock, latest);

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

    // Resolve display names for only the top N to keep this fast + cheap.
    const topAddrs = [
      ...weeklySorted.slice(0, 200).map((x) => x.addr),
      ...prevWeekSorted.slice(0, 200).map((x) => x.addr)
    ].map((a) => String(a).toLowerCase());

    const [basenameMap, ensMap, fcMap] = await Promise.all([
      fetchBasenamesOnBase(topAddrs),
      fetchEnsPrimaryFromEnsData(topAddrs),
      fetchNamesFromNeynar(topAddrs)
    ]);

    function pickName(addr) {
      const k = String(addr || "").toLowerCase();

      // 1) basename primary
      const bn = basenameMap.get(k);
      if (bn) return bn;

      // 2) ENS primary
      const ens = ensMap.get(k);
      if (ens) return ens;

      // 3) Farcaster username -> *.farcaster.eth
      const u = fcMap.get(k);
      if (u) return `${String(u).replace(/^@/, "")}.farcaster.eth`;

      return null;
    }

    const toJson = (arr) =>
      arr.slice(0, 200).map((x) => ({
        addr: x.addr,
        pts: x.pts.toString(),
        name: pickName(x.addr)
      }));

    // Cache at the edge so the leaderboard opens instantly for most users.
    // Refresh uses stale-while-revalidate to avoid blocking the UI.
    res.setHeader("cache-control", "s-maxage=300, stale-while-revalidate=1800");
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
