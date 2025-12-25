// Vercel Serverless Function: /api/leaderboard
// Server-side leaderboard aggregation to avoid mobile RPC limits.
//
// - Uses JSON-RPC directly (no heavy deps).
// - Uses RPC rotation + retries to reduce 429s.
// - Scans a recent block window based on the current + previous week (so “Last week” works).
//
// IMPORTANT PERF NOTE
// The first version of this endpoint attempted to resolve ENS + Basenames by doing
// *hundreds* of per-address RPC/HTTP calls. On free/serverless environments this often
// times out or hits rate limits, causing the Mini App UI to show: {"error":"Fetch failed"}.
//
// This version keeps name resolution lightweight and optional:
// - By default, it only tries Farcaster usernames via Neynar (single bulk request) when
//   NEYNAR_API_KEY is provided.
// - If name resolution is missing/unavailable, the client will still render addresses.

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

// Public Base RPCs (rotate to reduce rate limits / intermittent outages)
// NOTE: keep this list to public endpoints without requiring secrets.
const RPCS = [
  "https://mainnet.base.org",
  "https://1rpc.io/base",
  "https://base.llamarpc.com",
  "https://base-rpc.publicnode.com",
  "https://rpc.ankr.com/base",
  "https://base.drpc.org"
];

// Optional (recommended): BaseScan Logs API.
// This can return logs for large block ranges without the strict eth_getLogs range caps
// some public RPCs enforce (e.g. "max is 1k blocks").
// Set BASESCAN_API_KEY in your Vercel env for higher rate limits.
const BASESCAN_API = "https://api.basescan.org/api";

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
  // Serverless environments can hang on slow RPCs; enforce a per-call timeout.
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), 7000);

  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
    signal: ctrl.signal
  }).finally(() => clearTimeout(t));

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

  // Try multiple RPCs. Some providers have strict eth_getLogs range limits,
  // others rate-limit aggressively. We rotate rather than failing fast.
  for (let attempt = 0; attempt < 12; attempt++) {
    const url = RPCS[attempt % RPCS.length];
    try {
      return await fn(url);
    } catch (e) {
      lastErr = e;
      const status = e?.httpStatus;
      const bodyText = e?.bodyText || "";
      const msg = String(e?.message || "");
      const lower = (msg + " " + bodyText).toLowerCase();

      if (isRateLimitish(status, bodyText) || lower.includes("rate") || lower.includes("too many requests")) {
        await sleep(350 + attempt * 200);
        continue;
      }

      // Server-side / gateway errors: try next RPC.
      if (status && status >= 500) {
        await sleep(250 + attempt * 150);
        continue;
      }

      // Many RPC failures come back as HTTP 200 with a JSON-RPC error.
      // In that case, also rotate to the next RPC (some providers are stricter).
      if (lower.includes("rpc error") || lower.includes("eth_getlogs") || lower.includes("timeout") || lower.includes("limit")) {
        await sleep(150 + attempt * 120);
        continue;
      }

      // Default: still rotate a couple times before giving up.
      await sleep(120 + attempt * 80);
      continue;
    }
  }

  throw lastErr || new Error("RPC failed");
}

// --------------------------
// BaseScan Logs API (fast path)
// --------------------------

function basescanUrl(params) {
  const u = new URL(BASESCAN_API);
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === "") continue;
    u.searchParams.set(k, String(v));
  }
  const key = process.env.BASESCAN_API_KEY;
  if (key) u.searchParams.set("apikey", key);
  return u.toString();
}

async function fetchLogsViaBasescan(fromBlock, toBlock) {
  // Split ranges when BaseScan reports an oversized window.
  // Keep a sane recursion cap.
  async function helper(fb, tb, depth) {
    const url = basescanUrl({
      module: "logs",
      action: "getLogs",
      fromBlock: fb.toString(),
      toBlock: tb.toString(),
      address: CONTRACT,
      topic0: TOPIC0_ACTION_LOGGED,
      topic2: TOPIC2_ACTION_WEEKLY_ADD,
      topic0_2_opr: "and"
    });

    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 9000);
    const r = await fetch(url, { signal: ctrl.signal }).finally(() => clearTimeout(t));
    const text = await r.text().catch(() => "");
    if (!r.ok) throw new Error(`BaseScan HTTP ${r.status}: ${text.slice(0, 200)}`);

    let j;
    try {
      j = JSON.parse(text);
    } catch {
      throw new Error(`BaseScan bad JSON: ${text.slice(0, 200)}`);
    }

    const msg = String(j?.message || "");
    const status = String(j?.status || "");
    const lower = (msg + " " + (j?.result ? "" : "") + " " + text).toLowerCase();

    // No records is not an error.
    if (status === "0" && msg.toLowerCase().includes("no records")) return [];

    // Typical oversize signals.
    const oversize =
      lower.includes("result window is too large") ||
      lower.includes("too many results") ||
      lower.includes("exceed") ||
      lower.includes("range") && lower.includes("too large");

    if (oversize && depth < 8) {
      const mid = (fb + tb) / 2n;
      if (mid <= fb) return []; // safety
      const left = await helper(fb, mid, depth + 1);
      const right = await helper(mid + 1n, tb, depth + 1);
      return left.concat(right);
    }

    if (status !== "1") {
      // Let caller fall back to RPC scan.
      throw new Error(`BaseScan error: ${msg || "unknown"}`);
    }

    return Array.isArray(j.result) ? j.result : [];
  }

  return helper(BigInt(fromBlock), BigInt(toBlock), 0);
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

// Warm-function cache (best-effort). Helps avoid repeated log scans when users
// hit Refresh quickly.
const _CACHE = new Map();

module.exports = async function handler(req, res) {
  try {
    // Helpful for Mini App if this ever gets called cross-origin.
    res.setHeader("access-control-allow-origin", "*");

    const now = Date.now();
    const weekStart = Number(req.query.weekStart || weekStartUtcMs(now));
    const prevWeekStart = weekStart - 7 * 24 * 60 * 60 * 1000;

    const cacheKey = `${weekStart}:names=${String(req.query.names ?? "1")}`;
    const cached = _CACHE.get(cacheKey);
    if (cached && now - cached.ts < 60_000) {
      res.setHeader("cache-control", "s-maxage=60, stale-while-revalidate=300");
      res.status(200).json(cached.data);
      return;
    }

    const latestHex = await withRpcRotation((url) => rpcCall(url, "eth_blockNumber", []));
    const latest = BigInt(latestHex);

    // We show both "This week" + "Last week" in the UI, so we need to scan
    // roughly the last 2 weeks of logs. Use a timestamp-based estimate for
    // window size to keep it small early in the week.
    const approxBlocksSincePrevWeek = BigInt(Math.ceil((now - prevWeekStart) / 2000));
    const WINDOW = approxBlocksSincePrevWeek + 50000n; // safety buffer
    const MAX_WINDOW = 950000n; // cap to avoid pathological long scans
    const windowBlocks = WINDOW > MAX_WINDOW ? MAX_WINDOW : WINDOW;

    const fromBlock = latest > windowBlocks ? latest - windowBlocks : 0n;

    // Fewer RPC calls = fewer timeouts. Start large, and shrink if RPC complains.
    // Some public RPCs cap eth_getLogs to ~1k blocks (or less). We adapt.
    // We only need 2 leaderboards now: this week + last week.
    const thisWeekMap = new Map();
    const lastWeekMap = new Map();

    const thisWeekKey = BigInt(weekStart);
    const lastWeekKey = BigInt(prevWeekStart);

    const applyLogs = (logs) => {
      for (const l of logs || []) {
        const user = addrFromTopic(l.topics?.[1]);
        const payload = extractBytesParamFromLogData(l.data);
        const dec = decodePointsAndWeek(payload);
        if (!dec) continue;

        const points = dec.points;
        const wk = dec.week;

        if (wk === thisWeekKey) {
          thisWeekMap.set(user, (thisWeekMap.get(user) || 0n) + points);
        } else if (wk === lastWeekKey) {
          lastWeekMap.set(user, (lastWeekMap.get(user) || 0n) + points);
        }
      }
    };

    // FAST PATH: BaseScan logs API (1–few HTTP calls instead of hundreds of RPC calls).
    // If it fails (rate limit, no key, outage), fall back to RPC scanning.
    let didBasescan = false;
    try {
      const logs = await fetchLogsViaBasescan(fromBlock, latest);
      applyLogs(logs);
      didBasescan = true;
    } catch {
      // fall back below
    }

    if (!didBasescan) {
      // RPC fallback: adaptive chunking.
      const MIN_STEP = 120n; // allow shrinking below 1k if provider also caps by response size
      let step = 20000n;

      for (let from = fromBlock; from <= latest; ) {
        // Treat `step` as the max number of blocks per query.
        const to = from + (step - 1n) > latest ? latest : from + (step - 1n);

        const filter = {
          address: CONTRACT,
          fromBlock: toHex(from),
          toBlock: toHex(to),
          topics: [TOPIC0_ACTION_LOGGED, null, TOPIC2_ACTION_WEEKLY_ADD]
        };

        let logs;
        try {
          logs = await withRpcRotation((url) => rpcCall(url, "eth_getLogs", [filter]));
        } catch (e) {
          const msg = String(e?.message || "");
          const lower = msg.toLowerCase();
          const rangeTooWide =
            lower.includes("block range") ||
            lower.includes("range is too large") ||
            lower.includes("too many") ||
            lower.includes("query returned") ||
            lower.includes("response size") ||
            lower.includes("limit") ||
            lower.includes("max is") ||
            lower.includes("eth_getlogs range") ||
            lower.includes("timeout");

          // If the provider rejects large ranges, retry with a smaller step.
          // Many providers include "max is 1k blocks" in the message.
          if (rangeTooWide && step > MIN_STEP) {
            const m = lower.match(/max\s+is\s+(\d+)\s*(k)?\s*blocks?/);
            if (m) {
              const base = BigInt(m[1]);
              const maxBlocks = m[2] ? base * 1000n : base;
              const target = (maxBlocks * 9n) / 10n; // 90% of max
              step = target > MIN_STEP ? target : MIN_STEP;
            } else {
              step = step / 2n;
              if (step < MIN_STEP) step = MIN_STEP;
            }
            continue; // retry same from-block with smaller step
          }

          throw e;
        }

        applyLogs(logs);
        from = to + 1n;
      }
    }

    const weeklySorted = sortMapToArray(thisWeekMap);
    const prevWeekSorted = sortMapToArray(lastWeekMap);

    // Optional lightweight name resolution.
    // Use ?names=0 to skip all name work (fastest + most reliable).
    const wantNames = String(req.query.names ?? "1") !== "0";
    const topAddrs = wantNames
      ? [...new Set([
          ...weeklySorted.slice(0, 140).map((x) => x.addr),
          ...prevWeekSorted.slice(0, 140).map((x) => x.addr)
        ].map((a) => String(a).toLowerCase()))]
      : [];

    const fcMap = wantNames ? await fetchNamesFromNeynar(topAddrs) : new Map();

    function pickName(addr) {
      const k = String(addr || "").toLowerCase();
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

    const payload = {
      weekStart,
      prevWeekStart,
      weeklySorted: toJson(weeklySorted),
      prevWeekSorted: toJson(prevWeekSorted)
    };

    _CACHE.set(cacheKey, { ts: now, data: payload });

    res.setHeader("cache-control", "s-maxage=60, stale-while-revalidate=300");
    res.status(200).json(payload);
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
};
