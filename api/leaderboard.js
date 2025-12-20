// Vercel Serverless Function: /api/leaderboard
// Server-side leaderboard aggregation to avoid mobile RPC limits.
//
// - Uses JSON-RPC directly (no dependencies).
// - Uses RPC rotation + retries to reduce 429s.
// - Scans a recent block window (default: 350k blocks) which is roughly ~7 days on Base.

const CONTRACT = "0xB331328F506f2D35125e367A190e914B1b6830cF";

// Basenames reverse resolution (Base L2 resolver)
// Source: Base/Coinbase docs list the L2 Resolver contract for Base mainnet.
const BASENAMES_L2_RESOLVER = "0xC6d566A56A1aFf6508b41f6c90ff131615583BCD";
// name(bytes32) => 0x691f3431
const SIG_NAME_BYTES32 = "0x691f3431";

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


// --- Minimal keccak256 + namehash (for ENS/Basenames reverse resolution) ---
// Based on the js-sha3 keccak256 implementation pattern (MIT). Kept local to avoid new deps.
function keccak256Hex(inputBytes) {
  // inputBytes: Uint8Array
  // returns 0x-prefixed hex string (32 bytes)
  const RC = [
    1n, 32898n, 32906n, 2147483649n, 32907n, 2147483648n, 2147516416n, 2147483658n,
    2147516545n, 32777n, 138n, 136n, 2147516425n, 2147483658n, 2147516555n, 139n,
    32905n, 32771n, 32770n, 128n, 32778n, 2147483658n, 2147516545n, 32896n
  ];
  const ROT = [
    [0, 36, 3, 41, 18],
    [1, 44, 10, 45, 2],
    [62, 6, 43, 15, 61],
    [28, 55, 25, 21, 56],
    [27, 20, 39, 8, 14]
  ];
  const rate = 136; // 1088 bits for keccak256

  const s = Array(25).fill(0n);

  function rotl(x, n) {
    n = BigInt(n);
    return ((x << n) | (x >> (64n - n))) & 0xffffffffffffffffn;
  }

  function keccakf() {
    for (let round = 0; round < 24; round++) {
      // theta
      const c = new Array(5);
      for (let x = 0; x < 5; x++) {
        c[x] = s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20];
      }
      const d = new Array(5);
      for (let x = 0; x < 5; x++) {
        d[x] = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1);
      }
      for (let i = 0; i < 25; i++) {
        s[i] = s[i] ^ d[i % 5];
      }

      // rho + pi
      const b = Array(25).fill(0n);
      for (let x = 0; x < 5; x++) {
        for (let y = 0; y < 5; y++) {
          const idx = x + 5 * y;
          const X = y;
          const Y = (2 * x + 3 * y) % 5;
          b[X + 5 * Y] = rotl(s[idx], ROT[y][x]);
        }
      }

      // chi
      for (let x = 0; x < 5; x++) {
        for (let y = 0; y < 5; y++) {
          const idx = x + 5 * y;
          s[idx] = b[idx] ^ ((~b[((x + 1) % 5) + 5 * y]) & b[((x + 2) % 5) + 5 * y]);
        }
      }

      // iota
      s[0] = s[0] ^ RC[round];
    }
  }

  // absorb
  const bytes = inputBytes;
  const padded = [];
  for (let i = 0; i < bytes.length; i++) padded.push(bytes[i]);
  // pad10*1
  padded.push(0x01);
  while ((padded.length % rate) !== rate - 1) padded.push(0x00);
  padded.push(0x80);

  for (let offset = 0; offset < padded.length; offset += rate) {
    for (let i = 0; i < rate; i += 8) {
      let v = 0n;
      for (let j = 0; j < 8; j++) {
        v |= BigInt(padded[offset + i + j]) << BigInt(8 * j);
      }
      s[i / 8] ^= v;
    }
    keccakf();
  }

  // squeeze 32 bytes
  const out = new Uint8Array(32);
  let outPos = 0;
  for (let i = 0; i < 4; i++) { // 4 lanes * 8 bytes = 32 bytes
    const v = s[i];
    for (let j = 0; j < 8; j++) {
      out[outPos++] = Number((v >> BigInt(8 * j)) & 0xffn);
    }
  }

  return "0x" + [...out].map(b => b.toString(16).padStart(2, "0")).join("");
}

function utf8Bytes(str) {
  return new TextEncoder().encode(str);
}

function hexToBytes(hex) {
  const h = (hex || "").replace(/^0x/, "");
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  return out;
}

function bytesToHex(bytes) {
  return "0x" + [...bytes].map(b => b.toString(16).padStart(2, "0")).join("");
}

function concatBytes(a, b) {
  const out = new Uint8Array(a.length + b.length);
  out.set(a, 0);
  out.set(b, a.length);
  return out;
}

// ENS namehash (EIP-137 style)
function namehash(name) {
  let node = new Uint8Array(32); // all zeros
  if (!name) return bytesToHex(node);
  const labels = String(name).split(".").filter(Boolean);
  for (let i = labels.length - 1; i >= 0; i--) {
    const labelHash = hexToBytes(keccak256Hex(utf8Bytes(labels[i])));
    const nodeHash = hexToBytes(keccak256Hex(concatBytes(node, labelHash)));
    node = nodeHash;
  }
  return bytesToHex(node);
}

function pad32(hex) {
  const h = (hex || "").replace(/^0x/, "");
  return "0x" + h.padStart(64, "0");
}

function decodeAbiString(hex) {
  const h = (hex || "").replace(/^0x/, "");
  if (h.length < 128) return "";
  const lenHex = h.slice(64, 128);
  const len = parseInt(lenHex, 16);
  if (!Number.isFinite(len) || len <= 0) return "";
  const strHex = h.slice(128, 128 + len * 2);
  try {
    const bytes = hexToBytes("0x" + strHex);
    return new TextDecoder().decode(bytes);
  } catch {
    return "";
  }
}

async function fetchBasenamesFromChain(addresses, rpcCall) {
  const uniq = [...new Set((addresses || []).map(a => String(a || "").toLowerCase()))].filter(Boolean);
  const out = new Map();
  if (!uniq.length) return out;

  // concurrency limit
  const limit = 6;
  let idx = 0;

  async function worker() {
    while (idx < uniq.length) {
      const i = idx++;
      const addr = uniq[i];
      try {
        const label = addr.replace(/^0x/, "");
        const reverseName = `${label}.addr.reverse`;
        const node = namehash(reverseName); // bytes32 hex
        const data = SIG_NAME_BYTES32 + node.replace(/^0x/, ""); // selector + bytes32
        const hex = await rpcCall("eth_call", [{ to: BASENAMES_L2_RESOLVER, data }, "latest"]);
        const name = decodeAbiString(hex);
        if (name && typeof name === "string") out.set(addr, name);
      } catch {}
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, uniq.length) }, worker));
  return out;
}

async function fetchEnsPrimaryFromEnsData(addresses) {
  const uniq = [...new Set((addresses || []).map(a => String(a || "").toLowerCase()))].filter(Boolean);
  const out = new Map();
  if (!uniq.length) return out;

  const limit = 6;
  let idx = 0;

  async function worker() {
    while (idx < uniq.length) {
      const i = idx++;
      const addr = uniq[i];
      try {
        const r = await fetch(`https://api.ensdata.net/${addr}`, { headers: { "accept": "application/json" } });
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
// --- end: keccak/namehash helpers ---

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
      const name = "@" + u.username;

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

        const topAddrs = [
      ...weeklySorted.slice(0, 200).map((x) => x.addr),
      ...prevWeekSorted.slice(0, 200).map((x) => x.addr),
      ...allTimeSorted.slice(0, 200).map((x) => x.addr)
    ].map((a) => String(a || "").toLowerCase());

    const rpc = (method, params) => withRpcRotation((url) => rpcCall(url, method, params));

    // Resolve names (priority: basename -> ENS -> farcaster username)
    const [farcasterMap, basenameMap, ensMap] = await Promise.all([
      fetchNamesFromNeynar(topAddrs), // Map<address, @username>
      fetchBasenamesFromChain(topAddrs, rpc), // Map<address, name.base.eth>
      fetchEnsPrimaryFromEnsData(topAddrs) // Map<address, name.eth>
    ]);

    function pickPrimaryName(addr) {
      const k = String(addr || "").toLowerCase();

      const bn = basenameMap?.get(k);
      if (typeof bn === "string" && bn.length) return bn;

      const ens = ensMap?.get(k);
      if (typeof ens === "string" && ens.length) return ens;

      const fc = farcasterMap?.get(k);
      if (typeof fc === "string" && fc.length) {
        const u = fc.replace(/^@/, "");
        if (u) return `${u}.farcaster.eth`;
      }
      return null;
    }

    const toJson = (arr) =>
      arr.slice(0, 200).map((x) => ({
        addr: x.addr,
        pts: x.pts.toString(),
        name: pickPrimaryName(x.addr)
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
