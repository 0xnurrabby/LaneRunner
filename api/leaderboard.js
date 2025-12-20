// Vercel Serverless Function: /api/leaderboard
// Server-side leaderboard aggregation to avoid mobile RPC limits.
//
// - Uses JSON-RPC directly (no dependencies).
// - Uses RPC rotation + retries to reduce 429s.
// - Scans a recent block window (default: 350k blocks) which is roughly ~7 days on Base.

const CONTRACT = "0xB331328F506f2D35125e367A190e914B1b6830cF";

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


async function fetchNamesFromNeynar(addresses) {
  const key = process.env.NEYNAR_API_KEY || process.env.NEYNAR_KEY || "C89D21F4-C944-4646-BDD0-A0668535A805";
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
    for (const raw of j?.users || []) {
      // Neynar payload shape can vary (sometimes nested under `user`)
      const u = raw?.user || raw;

      // Extract a safe string username (avoid "@[object Object]")
      const uname =
        (typeof u?.username === "string" && u.username) ||
        (typeof u?.username?.username === "string" && u.username.username) ||
        (typeof u?.username?.value === "string" && u.username.value) ||
        null;

      const dname =
        (typeof u?.display_name === "string" && u.display_name) ||
        (typeof u?.displayName === "string" && u.displayName) ||
        (typeof u?.name === "string" && u.name) ||
        null;

      const handle = uname || dname;
      if (!handle) continue;

      const name = handle.startsWith("@") ? handle : "@" + handle;

      const custody = u?.custody_address ? String(u.custody_address).toLowerCase() : null;
      if (custody) out.set(custody, name);

      for (const a of u?.verified_addresses?.eth_addresses || []) {
        out.set(String(a).toLowerCase(), name);
      }
    }
  }

  return out;
}


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

    const latestHex = await withRpcRotation((url) => rpcCall(url, "eth_blockNumber", []));
    const latest = BigInt(latestHex);

    const WINDOW = 350000n;
    const fromBlock = latest > WINDOW ? latest - WINDOW : 0n;

    const step = 50000n;

    const perWeek = new Map();
    const allTime = new Map();

    for (let from = fromBlock; from <= latest; ) {
      const to = from + step > latest ? latest : from + step;

      const filter = {
        address: CONTRACT,
        fromBlock: toHex(from),
        toBlock: toHex(to),
        topics: [TOPIC0_ACTION_LOGGED, null, TOPIC2_ACTION_WEEKLY_ADD]
      };

      const logs = await withRpcRotation((url) => rpcCall(url, "eth_getLogs", [filter]));

      for (const l of logs) {
        const user = addrFromTopic(l.topics?.[1]);
        const payload = extractBytesParamFromLogData(l.data);
        const dec = decodePointsAndWeek(payload);
        if (!dec) continue;

        const points = dec.points;
        const wk = dec.week;

        allTime.set(user, (allTime.get(user) || 0n) + points);

        const wkKey = wk.toString();
        let wkMap = perWeek.get(wkKey);
        if (!wkMap) {
          wkMap = new Map();
          perWeek.set(wkKey, wkMap);
        }
        wkMap.set(user, (wkMap.get(user) || 0n) + points);
      }

      from = to + 1n;
    }

    const weeklySorted = sortMapToArray(perWeek.get(String(BigInt(weekStart))) || new Map());
    const prevWeekSorted = sortMapToArray(perWeek.get(String(BigInt(prevWeekStart))) || new Map());
    const allTimeSorted = sortMapToArray(allTime);

    const nameMap = await fetchNamesFromNeynar([
      ...weeklySorted.slice(0, 200).map((x) => x.addr),
      ...prevWeekSorted.slice(0, 200).map((x) => x.addr),
      ...allTimeSorted.slice(0, 200).map((x) => x.addr)
    ]);

    const toJson = (arr) =>
      arr.slice(0, 200).map((x) => ({
        addr: x.addr,
        pts: x.pts.toString(),
        name: nameMap.get(String(x.addr).toLowerCase()) || null
      }));

    res.setHeader("cache-control", "s-maxage=60, stale-while-revalidate=300");
    res.status(200).json({
      weekStart,
      prevWeekStart,
      weeklySorted: toJson(weeklySorted),
      prevWeekSorted: toJson(prevWeekSorted),
      allTimeSorted: toJson(allTimeSorted)
    });
  } catch (e) {
    res.status(500).json({ error: String(e?.message || e) });
  }
};
