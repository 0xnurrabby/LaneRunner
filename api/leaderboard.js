// Vercel Serverless Function: /api/leaderboard
// Server-side leaderboard aggregation to avoid mobile RPC limits.
//
// - Uses JSON-RPC directly (no heavy deps).
// - Uses RPC rotation + retries to reduce 429s.
// - Scans a recent block window (default: 350k blocks) which is roughly ~7 days on Base.
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
  "https://rpc.ankr.com/base/9e1676c46f6d37395a7b9b94a66d6ad2915b8343940ab1d84bcbbdd7b185baae",
  "https://mainnet.base.org",
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

    // Resolve display names for only the top N to keep this fast + cheap.
    const topAddrs = [
      ...weeklySorted.slice(0, 200).map((x) => x.addr),
      ...prevWeekSorted.slice(0, 200).map((x) => x.addr),
      ...allTimeSorted.slice(0, 200).map((x) => x.addr)
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
