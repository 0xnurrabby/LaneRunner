// Vercel Serverless Function: /api/leaderboard
// Weekly season leaderboard (This week + Last week), optimized for Base RPC limits.
//
// Key goals:
// - Never call eth_getLogs with >10k block span.
// - Reduce flaky "fetch failed" by rotating RPCs + timeouts + retries.
// - Keep UX fast via edge caching + in-memory caching.
// - No expensive name-resolution (UI can show short addresses).

const CONTRACT = "0xB331328F506f2D35125e367A190e914B1b6830cF";

// keccak256("ActionLogged(address,bytes32,uint256,bytes)")
const TOPIC0_ACTION_LOGGED =
  "0x9e3ed6e89b2d18ef01c7fca2e4c53051bc35b2bfbae65aee8c6079711dd4e929";

// bytes32("WEEKLY_ADD") right-padded to 32 bytes
const TOPIC2_ACTION_WEEKLY_ADD =
  "0x5745454b4c595f41444400000000000000000000000000000000000000000000";

// RPC pool (env override recommended)
function getRpcUrls() {
  const envList = (process.env.BASE_RPC_URLS || "").trim();
  if (envList) {
    return envList
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean);
  }
  // Fallback public RPCs
  return [
    "https://mainnet.base.org",
    "https://base.publicnode.com",
    "https://rpc.ankr.com/base",
    "https://1rpc.io/base",
    "https://base.llamarpc.com"
  ];
}

function weekStartUtcMs(now = Date.now()) {
  const d = new Date(now);
  const day = d.getUTCDay(); // 0=Sun..6=Sat
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
    t.includes("over rate limit") ||
    t.includes("quota")
  );
}

async function rpcCall(url, method, params, { timeoutMs = 15000 } = {}) {
  const ctrl = new AbortController();
  const to = setTimeout(() => ctrl.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
      signal: ctrl.signal
    });

    const txt = await res.text().catch(() => "");
    if (!res.ok) {
      const err = new Error(`RPC ${res.status}: ${txt.slice(0, 300)}`);
      err.status = res.status;
      err.bodyText = txt;
      throw err;
    }
    const j = JSON.parse(txt || "{}");
    if (j.error) {
      const err = new Error(String(j.error?.message || "RPC error"));
      err.code = j.error?.code;
      err.bodyText = JSON.stringify(j.error);
      throw err;
    }
    return j.result;
  } finally {
    clearTimeout(to);
  }
}

function makeRpcRotator(urls) {
  const list = urls.slice();
  let cursor = Math.floor(Math.random() * Math.max(1, list.length));
  return async function withRpcRotation(fn) {
    let lastErr;
    for (let attempt = 0; attempt < Math.min(6, list.length * 2); attempt++) {
      const url = list[cursor % list.length];
      cursor++;
      try {
        return await fn(url);
      } catch (e) {
        lastErr = e;
        // Backoff on rate limits / timeouts / transient fetch errors
        const msg = String(e?.message || "");
        const bodyText = e?.bodyText || "";
        const status = e?.status || 0;
        const transient =
          isRateLimitish(status, bodyText) ||
          msg.toLowerCase().includes("fetch failed") ||
          msg.toLowerCase().includes("aborted") ||
          msg.toLowerCase().includes("timeout") ||
          msg.toLowerCase().includes("socket") ||
          msg.toLowerCase().includes("econnreset");

        if (transient) {
          await sleep(150 + attempt * 250);
          continue;
        }
        // Non-transient: break fast
        break;
      }
    }
    throw lastErr || new Error("RPC failed");
  };
}

// --------------------------
// Log decoding
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

// Our payload bytes are a simple ABI-like encoding:
// - first 32 bytes: points (uint256)
// - second 32 bytes: weekStartMs (uint256)  (the Monday UTC ms)
function decodePointsAndWeek(payloadHex) {
  const h = (payloadHex || "").startsWith("0x") ? payloadHex.slice(2) : (payloadHex || "");
  if (h.length < 128) return null;
  const points = BigInt("0x" + h.slice(0, 64));
  const week = BigInt("0x" + h.slice(64, 128));
  return { points, week };
}

function sortMapToArray(map) {
  const arr = [];
  for (const [addr, pts] of map.entries()) arr.push({ addr, pts });
  arr.sort((a, b) => (a.pts === b.pts ? 0 : a.pts > b.pts ? -1 : 1));
  return arr;
}

function shortAddr(a) {
  if (!a) return "";
  const s = String(a);
  return s.length > 10 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s;
}

function toJson(arr) {
  return (arr || []).map((x) => ({
    addr: x.addr,
    pts: x.pts.toString(),
    name: shortAddr(x.addr)
  }));
}

// --------------------------
// Chunked log scan w/ pool
// --------------------------
const DEFAULT_SPAN = 9900n; // safe under 10k
const DEFAULT_CONCURRENCY = 3;

// Module-scope in-memory cache (per warm instance)
let MEMO = {
  key: "",
  ts: 0,
  payload: null
};

module.exports = async (req, res) => {
  try {
    const now = Date.now();
    const qWeek = Number(req.query.weekStart || 0) || weekStartUtcMs(now);
    const weekStart = qWeek;
    const prevWeekStart = weekStart - 7 * 24 * 3600 * 1000;

    const force = String(req.query.force || "") === "1";
    const cacheKey = `w:${weekStart}`;

    // Fast path: memo cache (10 minutes)
    if (!force && MEMO.payload && MEMO.key === cacheKey && now - MEMO.ts < 10 * 60 * 1000) {
      res.setHeader("cache-control", "public, s-maxage=600, stale-while-revalidate=3600");
      res.status(200).json({ ...MEMO.payload, cached: true });
      return;
    }

    const rpcUrls = getRpcUrls();
    const withRpcRotation = makeRpcRotator(rpcUrls);

    const latestHex = await withRpcRotation((url) => rpcCall(url, "eth_blockNumber", [], { timeoutMs: 12000 }));
    const latest = BigInt(latestHex);

    const deployBlockEnv = process.env.CONTRACT_DEPLOY_BLOCK ? BigInt(process.env.CONTRACT_DEPLOY_BLOCK) : 0n;

    // Estimate blocks since prevWeekStart (Base ~2s/block). Add 15% safety buffer.
    const seconds = Math.max(0, Math.floor((now - prevWeekStart) / 1000));
    const estBlocks = BigInt(Math.ceil((seconds / 2) * 1.15));
    let fromBlock = latest > estBlocks ? latest - estBlocks : 0n;
    if (deployBlockEnv && fromBlock < deployBlockEnv) fromBlock = deployBlockEnv;

    const MAX_BLOCK_SPAN = BigInt(process.env.LOGS_MAX_BLOCK_SPAN || String(DEFAULT_SPAN));
    const CONCURRENCY = Math.max(
      1,
      Math.min(6, Number(process.env.LOGS_CONCURRENCY || String(DEFAULT_CONCURRENCY)))
    );

    // Worker pool scanning
    const perWeek = new Map();

    const ranges = [];
    for (let f = fromBlock; f <= latest; ) {
      const t = f + MAX_BLOCK_SPAN > latest ? latest : f + MAX_BLOCK_SPAN;
      ranges.push([f, t]);
      f = t + 1n;
    }

    async function scanRange(f, t) {
      const filter = {
        address: CONTRACT,
        fromBlock: toHex(f),
        toBlock: toHex(t),
        topics: [TOPIC0_ACTION_LOGGED, null, TOPIC2_ACTION_WEEKLY_ADD]
      };

      // fetch logs with rotation
      const logs = await withRpcRotation((url) => rpcCall(url, "eth_getLogs", [filter], { timeoutMs: 20000 }));

      // decode + aggregate
      for (const l of logs || []) {
        const userTopic = l.topics?.[1] || "";
        if (!userTopic || userTopic.length !== 66) continue;
        const user = "0x" + userTopic.slice(26);

        const payload = extractBytesParamFromLogData(l.data);
        const dec = decodePointsAndWeek(payload);
        if (!dec) continue;

        const wkKey = dec.week.toString();
        let wkMap = perWeek.get(wkKey);
        if (!wkMap) {
          wkMap = new Map();
          perWeek.set(wkKey, wkMap);
        }
        wkMap.set(user, (wkMap.get(user) || 0n) + dec.points);
      }
    }

    // pool execution
    let cursor = 0;
    const workers = new Array(CONCURRENCY).fill(0).map(async () => {
      while (cursor < ranges.length) {
        const i = cursor++;
        const [f, t] = ranges[i];

        // retry each chunk a few times (rotation already helps)
        let ok = false;
        let lastErr;
        for (let attempt = 0; attempt < 3 && !ok; attempt++) {
          try {
            await scanRange(f, t);
            ok = true;
          } catch (e) {
            lastErr = e;
            await sleep(120 + attempt * 220);
          }
        }
        if (!ok) throw lastErr;
      }
    });

    await Promise.all(workers);

    const weeklySorted = sortMapToArray(perWeek.get(String(BigInt(weekStart))) || new Map());
    const prevWeekSorted = sortMapToArray(perWeek.get(String(BigInt(prevWeekStart))) || new Map());

    const payload = {
      weekStart,
      prevWeekStart,
      weeklySorted: toJson(weeklySorted),
      prevWeekSorted: toJson(prevWeekSorted),
      generatedAt: now
    };

    MEMO = { key: cacheKey, ts: now, payload };

    res.setHeader("cache-control", "public, s-maxage=600, stale-while-revalidate=3600");
    res.status(200).json(payload);
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
};
