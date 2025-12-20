import { sdk } from "https://esm.sh/@farcaster/miniapp-sdk@0.2.1";
import {
  createPublicClient,
  decodeEventLog,
  decodeAbiParameters,
  encodeAbiParameters,
  encodeFunctionData,
  http,
  parseAbiItem,
  stringToHex,
  toHex
} from "https://esm.sh/viem@2.21.0";
import { Attribution } from "https://esm.sh/ox/erc8021";

// =====================================================
// HARD INPUTS
// =====================================================
const APP_NAME = "Web3 Runner";
const HOME_URL = "https://web3-runner.vercel.app/";

const BASE_CHAIN_ID_HEX = "0x2105";
const CONTRACT = "0xB331328F506f2D35125e367A190e914B1b6830cF";

// Builder Code from your screenshot (must match Base.dev)
const BUILDER_CODE = "bc_nkm4ufdx";
const dataSuffix = Attribution.toDataSuffix({ codes: [BUILDER_CODE] });

// On-chain action name (bytes32)
const ACTION_WEEKLY_ADD = stringToHex("WEEKLY_ADD", { size: 32 });

// Event ABI
const ACTION_LOGGED_EVENT = parseAbiItem(
  "event ActionLogged(address indexed user, bytes32 indexed action, uint256 timestamp, bytes data)"
);

// =====================================================
// UI
// =====================================================
const app = document.getElementById("app");
app.innerHTML = `
  <div class="shell">
    <div class="topbar">
      <button class="iconBtn" id="menuBtn" aria-label="Menu">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      </button>
      <div class="title">${APP_NAME}</div>
      <button class="badge" id="statusBadge">Loading…</button>
    </div>

    <div class="gameCard">
      <div class="canvasWrap">
        <canvas id="c"></canvas>
      </div>

      <div class="hud" id="hud">
        <div class="hudTitle">${APP_NAME}</div>
        <div class="hudRow">
          <div>Run: <b id="runScore">0</b></div>
          <div>Coins: <b id="coins">0</b></div>
        </div>
        <div class="hudRow" style="margin-top:8px">
          <div>Bank: <b id="bankPoints">0</b></div>
          <div>Boost: <b id="boost">—</b></div>
        </div>
      </div>

      <div class="toast" id="toast"></div>
    </div>

    <div class="bottomBar">
      <div class="controls">
        <button class="ctrlBtn" id="leftBtn" aria-label="Move Left">
          <span class="ctrlIcon">◀</span><span class="ctrlText">Left</span>
        </button>
        <button class="ctrlBtn primary" id="saveBtn" aria-label="Save Points">
          <span class="ctrlText">Save</span>
        </button>
        <button class="ctrlBtn" id="rightBtn" aria-label="Move Right">
          <span class="ctrlText">Right</span><span class="ctrlIcon">▶</span>
        </button>
      </div>
    </div>

    <div class="sheet" id="sheet" role="dialog" aria-modal="true" aria-hidden="true">
      <div class="sheetPanel">
        <div class="sheetHeader">
          <h3 id="sheetTitle">Menu</h3>
          <button class="iconBtn" id="closeSheet" aria-label="Close">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M6 6l12 12M18 6L6 18" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
          </button>
        </div>
        <div class="sheetBody" id="sheetBody"></div>
      </div>
    </div>
  </div>
`;

const els = {
  statusBadge: $("#statusBadge"),
  sheet: $("#sheet"),
  sheetTitle: $("#sheetTitle"),
  sheetBody: $("#sheetBody"),
  toast: $("#toast"),
  c: $("#c"),
  runScore: $("#runScore"),
  coins: $("#coins"),
  bankPoints: $("#bankPoints"),
  boost: $("#boost"),
  menuBtn: $("#menuBtn"),
  closeSheet: $("#closeSheet"),
  leftBtn: $("#leftBtn"),
  rightBtn: $("#rightBtn"),
  saveBtn: $("#saveBtn")
};

function $(sel) {
  return document.querySelector(sel);
}

function toast(msg, ms = 1800) {
  els.toast.textContent = msg;
  els.toast.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(() => els.toast.classList.remove("show"), ms);
}

// =====================================================
// Audio + Haptics (coin sfx, background music, vibration)
// Notes:
// - Mobile browsers block autoplay. We "unlock" audio on the first user gesture.
// - Vibration is best-effort (only works where supported).
// =====================================================
const AUDIO = {
  unlocked: false,
  coinPool: [],
  coinIdx: 0,
  bgm: null
};

function setupAudio() {
  if (AUDIO.coinPool.length) return;

  // Coin SFX pool (allows rapid consecutive plays)
  for (let i = 0; i < 5; i++) {
    const a = new Audio("/assets/coin.mp3");
    a.preload = "auto";
    a.volume = 0.20; // ✅ 50% lower than 0.40
    AUDIO.coinPool.push(a);
  }

  // Background music
  AUDIO.bgm = new Audio("/assets/bgm.mp3");
  AUDIO.bgm.preload = "auto";
  AUDIO.bgm.loop = true;
  AUDIO.bgm.volume = 0.32;
}

async function ensureAudioUnlocked() {
  setupAudio();
  if (AUDIO.unlocked) return;

  try {
    // Attempt a silent play/pause to unlock audio on iOS/Android.
    const a = AUDIO.coinPool[0];
    a.muted = true;
    await a.play();
    a.pause();
    a.currentTime = 0;
    a.muted = false;
    AUDIO.unlocked = true;
  } catch {
    AUDIO.unlocked = false;
  }

  if (AUDIO.unlocked) startBgm();
}

function startBgm() {
  setupAudio();
  if (!AUDIO.unlocked || !AUDIO.bgm) return;
  if (!AUDIO.bgm.paused) return;

  AUDIO.bgm.currentTime = 0;
  AUDIO.bgm.play().catch(() => {});
}

function stopBgm() {
  if (!AUDIO.bgm) return;
  try {
    AUDIO.bgm.pause();
  } catch {}
}

function playCoinSfx() {
  if (!AUDIO.unlocked || !AUDIO.coinPool.length) return;
  const a = AUDIO.coinPool[AUDIO.coinIdx % AUDIO.coinPool.length];
  AUDIO.coinIdx++;
  try {
    a.currentTime = 0;
    a.play().catch(() => {});
  } catch {}
}

function vibrate(pattern) {
  // 1) Standard Web Vibration API (works mostly on Android Chrome, some in-app browsers)
  try {
    if (navigator && typeof navigator.vibrate === "function") {
      return navigator.vibrate(pattern);
    }
  } catch {}

  // 2) Farcaster miniapp SDK fallback (best effort)
  try {
    const p = Array.isArray(pattern) ? pattern[0] : pattern;
    if (sdk?.actions?.haptics?.impact) {
      const type = p >= 60 ? "medium" : "light";
      sdk.actions.haptics.impact(type);
      return true;
    }
    if (sdk?.actions?.haptics?.notification) {
      sdk.actions.haptics.notification("success");
      return true;
    }
  } catch {}

  return false;
}

// ✅ Missing functions added
function hapticTap() {
  vibrate(12);
}
function crashVibe() {
  vibrate([55, 30, 55]);
}

// =====================================================
// Mini App READY (MANDATORY)
// =====================================================
(async () => {
  try {
    await sdk.actions.ready({ disableNativeGestures: true });
    els.statusBadge.textContent = "Connect";
  } catch {
    els.statusBadge.textContent = "SDK missing";
  }
})();

// =====================================================
// Wallet / Chain
// =====================================================
let ethProvider = null;
let account = null;

async function getProvider() {
  if (ethProvider) return ethProvider;
  try {
    ethProvider = await sdk.wallet.getEthereumProvider();
    return ethProvider;
  } catch {
    return null;
  }
}

function shortAddr(a) {
  return `${a.slice(0, 6)}…${a.slice(-4)}`;
}

let fcUsername = null;
let fcFid = null;

function _toStr(v) {
  if (typeof v === "string") return v;
  if (v == null) return null;
  if (typeof v === "number" || typeof v === "bigint") return String(v);
  if (typeof v === "object") {
    if (typeof v.username === "string") return v.username;
    if (typeof v.displayName === "string") return v.displayName;
    if (typeof v.name === "string") return v.name;
  }
  return null;
}

async function getFcUsername() {
  if (fcUsername !== null) return fcUsername;
  try {
    const ctx =
      (sdk && sdk.context) ||
      (sdk && sdk.actions && (await sdk.actions.getContext?.())) ||
      null;
    const u = ctx?.user || ctx?.context?.user || null;
    fcUsername = _toStr(u?.username ?? u?.displayName ?? u?.name ?? null);
    fcFid = u?.fid ?? ctx?.fid ?? ctx?.userFid ?? null;
  } catch {
    fcUsername = null;
  }
  return fcUsername;
}

async function getFcFid() {
  if (fcFid !== null) return fcFid;
  await getFcUsername();
  return fcFid;
}

async function displayNameFor(addr) {
  try {
    const raw = localStorage.getItem("addrNameMap");
    if (raw) {
      const m = JSON.parse(raw);
      const k = String(addr || "").toLowerCase();
      const v = m?.[k];
      if (v) return v;
    }
  } catch {}

  if (account && addr && addr.toLowerCase() === account.toLowerCase()) {
    const u = await getFcUsername();
    if (u) return `@${u}`;
  }
  return shortAddr(addr);
}

function fmtPts(n) {
  const s = (typeof n === "bigint" ? n : BigInt(n || 0)).toString();
  return s.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
}

function renderStatus() {
  if (!account) {
    els.statusBadge.textContent = "Connect";
    return;
  }
  els.statusBadge.textContent = `${shortAddr(account)} (Base)`;
}

async function connectWallet() {
  const p = await getProvider();
  if (!p) {
    toast("Open inside Farcaster/Base Mini App to connect wallet.");
    return null;
  }
  const accs = await p.request({ method: "eth_requestAccounts", params: [] });
  account = accs?.[0] || null;
  try {
    const u = await getFcUsername();
    if (typeof u === "string" && u && account) {
      const raw = localStorage.getItem("addrNameMap");
      const m = raw ? JSON.parse(raw) : {};
      m[String(account).toLowerCase()] = `@${u}`;
      localStorage.setItem("addrNameMap", JSON.stringify(m));
    }
  } catch {}
  renderStatus();
  return account;
}

async function ensureBase() {
  const p = await getProvider();
  if (!p) throw new Error("No provider");
  const chainId = await p.request({ method: "eth_chainId", params: [] });
  if (chainId === BASE_CHAIN_ID_HEX) return;
  try {
    await p.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: BASE_CHAIN_ID_HEX }]
    });
  } catch {
    throw new Error("Please switch your wallet to Base Mainnet (0x2105).");
  }
}

// =====================================================
// Time windows (Weekly reset) + Boost rhythm
// =====================================================
function weekStartUtcMs(now = Date.now()) {
  const d = new Date(now);
  const day = d.getUTCDay(); // 0 Sun..6 Sat
  const diffToMon = (day + 6) % 7; // days since Monday
  const mon = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - diffToMon, 0, 0, 0, 0)
  );
  return mon.getTime();
}

function weekIdUtc(now = Date.now()) {
  return new Date(weekStartUtcMs(now)).toISOString().slice(0, 10);
}

function randInt(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function hoursToMs(h) {
  return h * 60 * 60 * 1000;
}

// =====================================================
// Off-chain Profile: banked points + coins + decay
// =====================================================
const DECAY_INTERVAL_MS = 15 * 60 * 1000;
const DECAY_MULT = 0.75;

const profile = {
  bankPoints: Number(localStorage.getItem("w3r_bank") || "0"),
  coins: Number(localStorage.getItem("w3r_coins") || "0"),
  lastDecayAt: Number(localStorage.getItem("w3r_decay_at") || "0"),
  boostReadyAt: Number(localStorage.getItem("w3r_boost_ready_at") || "0"),
  boostActiveUntil: Number(localStorage.getItem("w3r_boost_active_until") || "0"),
  boostMult: 1
};

function persistProfile() {
  localStorage.setItem("w3r_bank", String(Math.floor(profile.bankPoints)));
  localStorage.setItem("w3r_coins", String(Math.floor(profile.coins)));
  localStorage.setItem("w3r_decay_at", String(profile.lastDecayAt));
  localStorage.setItem("w3r_boost_ready_at", String(profile.boostReadyAt));
  localStorage.setItem("w3r_boost_active_until", String(profile.boostActiveUntil));
}

function applyDecay(now = Date.now()) {
  if (!profile.lastDecayAt) {
    profile.lastDecayAt = now;
    persistProfile();
    return;
  }
  if (profile.bankPoints <= 0) {
    profile.lastDecayAt = now;
    persistProfile();
    return;
  }

  const elapsed = now - profile.lastDecayAt;
  if (elapsed < DECAY_INTERVAL_MS) return;

  const steps = Math.floor(elapsed / DECAY_INTERVAL_MS);
  profile.bankPoints = profile.bankPoints * Math.pow(DECAY_MULT, steps);
  profile.lastDecayAt += steps * DECAY_INTERVAL_MS;
  persistProfile();
}

function computeBoost(now = Date.now()) {
  if (!profile.boostReadyAt) {
    profile.boostReadyAt = now + hoursToMs(randInt(2, 6));
    persistProfile();
  }

  if (profile.boostActiveUntil && now < profile.boostActiveUntil) {
    profile.boostMult = 1.25;
    return;
  }

  if (now >= profile.boostReadyAt) {
    profile.boostActiveUntil = now + 5 * 60 * 1000;
    profile.boostReadyAt = now + hoursToMs(randInt(2, 6));
    persistProfile();
    toast("Boost active! +25% points for 5 minutes");
    profile.boostMult = 1.25;
    return;
  }

  profile.boostMult = 1.0;
}

function boostCountdownText(now = Date.now()) {
  if (profile.boostActiveUntil && now < profile.boostActiveUntil) {
    const ms = profile.boostActiveUntil - now;
    const m = Math.max(0, Math.floor(ms / 60000));
    const s = Math.max(0, Math.floor((ms % 60000) / 1000));
    return `ON ${m}m ${s}s`;
  }
  const ms = Math.max(0, profile.boostReadyAt - now);
  const h = Math.floor(ms / 3600000);
  const m = Math.floor((ms % 3600000) / 60000);
  return `${h}h ${m}m`;
}

// =====================================================
// GAME: 4-lane runner
// =====================================================
const game = {
  started: false,
  over: false,
  lane: 1,
  runScore: 0,
  t: 0,
  speed: 1.0,
  obstacles: [],
  coins: [],
  lastSpawnAt: 0,
  lastCoinAt: 0,
  lastFrame: performance.now()
};

function resetRun() {
  game.started = true;
  game.over = false;
  game.lane = 1;
  game.runScore = 0;
  game.t = 0;
  game.speed = 1.0;
  game.obstacles = [];
  game.coins = [];
  game.lastSpawnAt = 0;
  game.lastCoinAt = 0;

  startBgm();
}
resetRun();

function saveRunToBank() {
  applyDecay();
  if (game.runScore <= 0) {
    toast("No points to save");
    return;
  }
  profile.bankPoints += game.runScore;
  game.runScore = 0;
  persistProfile();
  toast("Saved to Bank");
}

function convertCoinsToBank() {
  applyDecay();
  if (profile.coins <= 0) {
    toast("No coins to convert");
    return;
  }
  const pts = profile.coins * 10;
  profile.coins = 0;
  profile.bankPoints += pts;
  persistProfile();
  toast(`Converted +${pts} points`);
}

// =====================================================
// LEADERBOARD API
// =====================================================
async function fetchLeaderboard() {
  const weekStart = weekStartUtcMs();
  const res = await fetch(`/api/leaderboard?weekStart=${encodeURIComponent(String(weekStart))}`);
  if (!res.ok) {
    const t = await res.text().catch(() => "");
    throw new Error(t || `Leaderboard API failed (${res.status})`);
  }
  const j = await res.json();

  const normalize = (arr) =>
    (arr || []).map((x) => ({ addr: x.addr, pts: BigInt(x.pts), name: x.name }));

  return {
    weekStart: j.weekStart,
    prevWeekStart: j.prevWeekStart,
    weeklySorted: normalize(j.weeklySorted),
    prevWeekSorted: normalize(j.prevWeekSorted),
    allTimeSorted: normalize(j.allTimeSorted)
  };
}

// =====================================================
// On-chain Commit
// =====================================================
let commitInFlight = false;

async function commitWeeklyOnchain() {
  applyDecay();

  if (!account) {
    await connectWallet();
    if (!account) return;
  }

  const pts = Math.floor(profile.bankPoints);
  if (pts <= 0) {
    toast("Bank is empty");
    return;
  }

  if (commitInFlight) return;
  commitInFlight = true;

  try {
    await ensureBase();

    const p = await getProvider();
    if (!p) throw new Error("No provider");

    const chainId = await p.request({ method: "eth_chainId", params: [] });

    const weekStart = weekStartUtcMs();
    const payload = encodeAbiParameters(
      [{ type: "uint256" }, { type: "uint256" }],
      [BigInt(pts), BigInt(weekStart)]
    );

    const data = encodeFunctionData({
      abi: [
        {
          type: "function",
          name: "logAction",
          stateMutability: "nonpayable",
          inputs: [
            { name: "action", type: "bytes32" },
            { name: "data", type: "bytes" }
          ],
          outputs: []
        }
      ],
      functionName: "logAction",
      args: [ACTION_WEEKLY_ADD, payload]
    });

    const params = {
      version: "2.0.0",
      from: account,
      chainId,
      atomicRequired: true,
      calls: [{ to: CONTRACT, value: "0x0", data }],
      capabilities: { dataSuffix }
    };

    try {
      await p.request({ method: "wallet_sendCalls", params: [params] });
    } catch (e) {
      if (String(e?.message || "").toLowerCase().includes("rejected")) {
        toast("Transaction rejected");
        return;
      }
      await p.request({
        method: "eth_sendTransaction",
        params: [{ from: account, to: CONTRACT, value: "0x0", data }]
      });
    }

    profile.bankPoints = 0;
    persistProfile();
    toast("Committed on-chain! Updating leaderboard…", 2200);

    if (isSheetOpen()) await openLeaderboardsView();
  } catch (e) {
    toast(e?.message ? String(e.message) : "Commit failed");
  } finally {
    commitInFlight = false;
  }
}

// =====================================================
// Controls: instant + no double triggers
// =====================================================
function bindInstantTap(btn, fn) {
  btn.style.touchAction = "none";

  const onPointerDown = (ev) => {
    ev.preventDefault();
    ev.stopPropagation();
    ensureAudioUnlocked();
    fn();
  };

  btn.addEventListener("pointerdown", onPointerDown, { passive: false });

  btn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
  });
}

function moveLane(delta) {
  if (game.over) return;
  const next = Math.max(0, Math.min(3, game.lane + delta));
  game.lane = next;
}

bindInstantTap(els.leftBtn, () => {
  hapticTap();
  moveLane(-1);
});
bindInstantTap(els.rightBtn, () => {
  hapticTap();
  moveLane(+1);
});
bindInstantTap(els.saveBtn, () => saveRunToBank());

// =====================================================
// Menu sheet
// =====================================================
function isSheetOpen() {
  return els.sheet.classList.contains("open");
}

function openSheet(title, bodyHtml) {
  els.sheetTitle.textContent = title;
  els.sheetBody.innerHTML = bodyHtml;
  els.sheet.classList.add("open");
  els.sheet.setAttribute("aria-hidden", "false");
}

function closeSheet() {
  els.sheet.classList.remove("open");
  els.sheet.setAttribute("aria-hidden", "true");
}

els.menuBtn.addEventListener("click", async () => {
  applyDecay();
  computeBoost();
  renderHud();
  openMainMenu();
});
els.closeSheet.addEventListener("click", closeSheet);
els.sheet.addEventListener("click", (e) => {
  if (e.target === els.sheet) closeSheet();
});
els.statusBadge.addEventListener("click", async () => {
  if (!account) await connectWallet();
  renderStatus();
});

function openMainMenu() {
  const walletLine = account ? shortAddr(account) : "Not connected";
  const week = weekIdUtc();

  openSheet(
    "Menu",
    `
    <div class="menuGrid">
      <div class="kv"><div class="k">Wallet</div><div class="v">${walletLine}</div></div>
      <div class="kv"><div class="k">Week</div><div class="v">${week} (UTC)</div></div>
      <div class="kv"><div class="k">Run points</div><div class="v">${Math.floor(game.runScore)}</div></div>
      <div class="kv"><div class="k">Bank points</div><div class="v">${Math.floor(profile.bankPoints)}</div></div>
      <div class="kv"><div class="k">Coins</div><div class="v">${Math.floor(profile.coins)} (→ ${Math.floor(profile.coins) * 10} pts)</div></div>
      <div class="kv"><div class="k">Decay</div><div class="v">-25% every 15 min</div></div>
    </div>

    <div class="btnRow">
      <button class="pill" id="btnConnect">${account ? "Reconnect" : "Connect wallet"}</button>
      <button class="pill" id="btnLeaderboards">Leaderboards</button>
    </div>

    <div class="btnRow">
      <button class="pill" id="btnConvert">Convert coins → points</button>
      <button class="pill" id="btnHow">How it works</button>
    </div>

    <div class="commitWrap">
      <button class="pill primary" id="btnCommit">Commit Bank → Weekly leaderboard (on-chain)</button>
    </div>

    <div class="fineprint">
      Contract: ${CONTRACT}<br/>
      Chain: Base Mainnet (${BASE_CHAIN_ID_HEX})<br/>
      Builder code: ${BUILDER_CODE}
    </div>
  `
  );

  $("#btnConnect").addEventListener("click", async () => {
    await connectWallet();
    renderStatus();
    openMainMenu();
  });

  $("#btnLeaderboards").addEventListener("click", openLeaderboardsView);
  $("#btnConvert").addEventListener("click", () => {
    convertCoinsToBank();
    openMainMenu();
  });
  $("#btnHow").addEventListener("click", openHowView);

  const commitBtn = $("#btnCommit");
  commitBtn.addEventListener(
    "pointerdown",
    (e) => {
      e.preventDefault();
      e.stopPropagation();
      commitWeeklyOnchain();
    },
    { passive: false }
  );
  commitBtn.addEventListener("click", (e) => {
    e.preventDefault();
    e.stopPropagation();
    commitWeeklyOnchain();
  });
}

function openHowView() {
  openSheet(
    "How it works",
    `
    <div class="copy">
      <p><b>Play short runs.</b> Your <b>Run</b> points grow while you survive.</p>
      <p><b>Save</b> moves Run → <b>Bank</b> instantly (no transaction).</p>
      <p><b>Bank decays</b>: every <b>15 minutes</b>, Bank is reduced by <b>25%</b>.</p>
      <p><b>Coins</b>: 1 coin = <b>10 points</b>. Convert from the Menu.</p>
      <p><b>Commit</b> is optional and on-chain. It adds your current Bank to your <b>Weekly public leaderboard</b>.</p>
    </div>
    <div class="btnRow">
      <button class="pill" id="backMenu">Back</button>
      <button class="pill" id="goBoards">Leaderboards</button>
    </div>
  `
  );
  $("#backMenu").addEventListener("click", openMainMenu);
  $("#goBoards").addEventListener("click", openLeaderboardsView);
}

let boardsInFlight = false;

function topN(list, n) {
  return list.slice(0, n);
}

async function openLeaderboardsView() {
  if (boardsInFlight) return;
  boardsInFlight = true;

  openSheet(
    "Leaderboards",
    `
    <div class="copy" style="opacity:.9">Loading on-chain leaderboard…</div>
    <div class="btnRow" style="margin-top:12px">
      <button class="pill" id="backMenu">Back</button>
      <button class="pill" id="refreshBoards">Refresh</button>
    </div>
    <div id="boards"></div>
  `
  );

  $("#backMenu").addEventListener("click", openMainMenu);
  $("#refreshBoards").addEventListener("click", openLeaderboardsView);

  try {
    const data = await fetchLeaderboard();
    const { weekStart, prevWeekStart, weeklySorted, prevWeekSorted, allTimeSorted } = data;

    const weekLabel = new Date(weekStart).toISOString().slice(0, 10);
    const lastWeekLabel = new Date(prevWeekStart).toISOString().slice(0, 10);

    const weeklyTop = topN(weeklySorted, 100);
    const allTop = topN(allTimeSorted, 100);
    const lastWinners = topN(prevWeekSorted, 3);

    const weeklyIndex = account
      ? weeklySorted.findIndex((x) => x.addr.toLowerCase() === account.toLowerCase())
      : -1;
    const yourWeeklyRank = weeklyIndex >= 0 ? weeklyIndex + 1 : null;
    const yourWeeklyPts = weeklyIndex >= 0 ? weeklySorted[weeklyIndex].pts : 0n;

    const renderList = async (items) => {
      const rows = await Promise.all(
        items.map(async (x, i) => {
          const name = (typeof x.name === "string" && x.name) ? x.name : await displayNameFor(x.addr);
          return `
            <div class="entry">
              <div class="left">
                <div class="rankBadge">#${i + 1}</div>
                <div class="addr">${name}</div>
              </div>
              <div class="points">${fmtPts(x.pts)}</div>
            </div>
          `;
        })
      );
      return rows.join("");
    };

    const weeklyHtml = await renderList(weeklyTop);
    const allHtml = await renderList(allTop);
    const winnersHtml =
      lastWinners.length === 0
        ? `<div class="copy">No winners data found for last week.</div>`
        : `<div class="boardList">${await renderList(lastWinners)}</div>`;

    $("#boards").innerHTML = `
      <div class="board">
        <div class="boardTitle"><div>Weekly (since ${weekLabel} UTC)</div><div>Top 100</div></div>
        <div class="boardList">${weeklyHtml || `<div class="copy">No entries yet.</div>`}</div>
        <div class="subcopy">
          ${
            account
              ? yourWeeklyRank
                ? yourWeeklyRank <= 100
                  ? `You: #${yourWeeklyRank} (${fmtPts(yourWeeklyPts)})`
                  : `You: #${yourWeeklyRank} (${fmtPts(yourWeeklyPts)}) — outside top 100`
                : `No on-chain points found for your address this week yet.`
              : "Connect wallet to see your rank."
          }
        </div>
      </div>

      <div class="board">
        <div class="boardTitle"><div>All-time</div><div>Top 100</div></div>
        <div class="boardList">${allHtml || `<div class="copy">No entries yet.</div>`}</div>
      </div>

      <div class="board">
        <div class="boardTitle"><div>Last week winners (since ${lastWeekLabel} UTC)</div><div>Top 3</div></div>
        ${winnersHtml}
      </div>
    `;
  } catch (e) {
    $("#boards").innerHTML = `<div class="copy">Could not load on-chain logs. Try Refresh. ${
      e?.message ? `<br/><span class="mono">${String(e.message)}</span>` : ""
    }</div>`;
  } finally {
    boardsInFlight = false;
  }
}

// =====================================================
// Canvas sizing
// =====================================================
const ctx = els.c.getContext("2d");

function resize() {
  const wrap = els.c.parentElement;
  const w = Math.floor(wrap.clientWidth);
  const h = Math.floor(wrap.clientHeight);
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  els.c.width = Math.floor(w * dpr);
  els.c.height = Math.floor(h * dpr);
  els.c.style.width = `${w}px`;
  els.c.style.height = `${h}px`;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
}
window.addEventListener("resize", resize);
resize();

// =====================================================
// Render + update
// =====================================================
function renderHud() {
  els.runScore.textContent = String(Math.floor(game.runScore));
  els.coins.textContent = String(Math.floor(profile.coins));
  els.bankPoints.textContent = String(Math.floor(profile.bankPoints));
  els.boost.textContent = boostCountdownText();
}

function laneGeometry() {
  const wrap = els.c;
  const w = wrap.clientWidth;
  const h = wrap.clientHeight;

  const roadW = Math.min(360, w * 0.78);
  const roadH = h * 0.86;
  const roadX = (w - roadW) / 2;
  const roadY = (h - roadH) / 2 + 6;

  const lanes = 4;
  const laneW = roadW / lanes;

  return { w, h, roadX, roadY, roadW, roadH, lanes, laneW };
}

function laneCenterX(g, laneIndex) {
  return g.roadX + g.laneW * (laneIndex + 0.5);
}

function spawnObstacle() {
  const g = laneGeometry();
  const lane = randInt(0, 3);
  const size = Math.max(36, Math.min(56, g.laneW * 0.55));
  const w = Math.max(28, size * 0.82);
  const h = Math.max(40, size * 1.18);

  const ENEMY_COLORS = [
    "rgba(255,80,120,0.95)",
    "rgba(255,188,64,0.95)",
    "rgba(160,110,255,0.95)",
    "rgba(60,220,160,0.95)",
    "rgba(90,190,255,0.95)"
  ];
  const color = ENEMY_COLORS[randInt(0, ENEMY_COLORS.length - 1)];

  game.obstacles.push({ lane, y: g.roadY - h - 10, size, w, h, color });
}

function spawnCoin() {
  const g = laneGeometry();
  const lane = randInt(0, 3);
  game.coins.push({ lane, y: g.roadY - 24, r: 10 });
}

function rectsOverlap(a, b) {
  return !(a.x + a.w < b.x || a.x > b.x + b.w || a.y + a.h < b.y || a.y > b.y + b.h);
}

function update(dt) {
  applyDecay();
  computeBoost();

  if (game.over) return;

  game.t += dt;
  game.speed = Math.min(3.2, game.speed + dt * 0.03);

  game.runScore += dt * (8 + game.speed * 5) * profile.boostMult;

  const now = performance.now();

  if (now - game.lastSpawnAt > 650 - game.speed * 80) {
    game.lastSpawnAt = now;
    spawnObstacle();
  }

  if (now - game.lastCoinAt > 1200) {
    game.lastCoinAt = now;
    if (Math.random() < 0.75) spawnCoin();
  }

  const g = laneGeometry();

  // collision rect for the player (consistent with drawn car)
  const carW = Math.max(36, Math.min(60, g.laneW * 0.62));
  const carH = carW * 1.30;
  const carX = laneCenterX(g, game.lane) - carW / 2;
  const carY = g.roadY + g.roadH - carH - 18;
  const carRect = { x: carX, y: carY, w: carW, h: carH };

  const obsSpeed = (220 + game.speed * 90) * dt;
  for (const o of game.obstacles) o.y += obsSpeed;

  const coinSpeed = (190 + game.speed * 70) * dt;
  for (const c of game.coins) c.y += coinSpeed;

  // ✅ collisions (fixed - no duplicate r bug)
  for (const o of game.obstacles) {
    const ow = o.w ?? o.size;
    const oh = o.h ?? o.size;
    const ox = laneCenterX(g, o.lane) - ow / 2;
    const oy = o.y;
    const r = { x: ox, y: oy, w: ow, h: oh };

    if (rectsOverlap(carRect, r)) {
      crashVibe();
      game.over = true;
      stopBgm();
      toast("Crash! Save or restart", 2200);
      break;
    }
  }

  // coin pickup
  const keptCoins = [];
  for (const c of game.coins) {
    const cx = laneCenterX(g, c.lane);
    const cy = c.y;
    const dx = carRect.x + carRect.w / 2 - cx;
    const dy = carRect.y + carRect.h / 2 - cy;
    const dist = Math.sqrt(dx * dx + dy * dy);

    if (dist < carRect.w * 0.45 + c.r) {
      profile.coins += 1;
      playCoinSfx();
      persistProfile();
      continue;
    }
    keptCoins.push(c);
  }
  game.coins = keptCoins;

  game.obstacles = game.obstacles.filter((o) => o.y < g.roadY + g.roadH + 80);
  game.coins = game.coins.filter((c) => c.y < g.roadY + g.roadH + 60);
}

function drawRoundedRect(x, y, w, h, r) {
  const rr = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + rr, y);
  ctx.lineTo(x + w - rr, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + rr);
  ctx.lineTo(x + w, y + h - rr);
  ctx.quadraticCurveTo(x + w, y + h, x + w - rr, y + h);
  ctx.lineTo(x + rr, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - rr);
  ctx.lineTo(x, y + rr);
  ctx.quadraticCurveTo(x, y, x + rr, y);
  ctx.closePath();
}

function drawCarTopDown(x, y, w, h, bodyColor) {
  ctx.fillStyle = bodyColor;
  drawRoundedRect(x, y, w, h, Math.min(14, w * 0.35));
  ctx.fill();

  ctx.fillStyle = "rgba(255,255,255,0.10)";
  drawRoundedRect(x + w * 0.08, y + h * 0.12, w * 0.84, h * 0.52, Math.min(12, w * 0.3));
  ctx.fill();

  ctx.fillStyle = "rgba(0,0,0,0.28)";
  drawRoundedRect(x + w * 0.18, y + h * 0.18, w * 0.64, h * 0.34, Math.min(10, w * 0.25));
  ctx.fill();

  ctx.fillStyle = "rgba(255,255,255,0.16)";
  drawRoundedRect(x + w * 0.24, y + h * 0.22, w * 0.52, h * 0.10, Math.min(8, w * 0.2));
  ctx.fill();

  ctx.fillStyle = "rgba(0,0,0,0.55)";
  const ww = Math.max(4, w * 0.14);
  const wh = Math.max(10, h * 0.18);
  const wy1 = y + h * 0.18;
  const wy2 = y + h * 0.62;
  drawRoundedRect(x - ww * 0.15, wy1, ww, wh, ww * 0.45);
  drawRoundedRect(x + w - ww * 0.85, wy1, ww, wh, ww * 0.45);
  drawRoundedRect(x - ww * 0.15, wy2, ww, wh, ww * 0.45);
  drawRoundedRect(x + w - ww * 0.85, wy2, ww, wh, ww * 0.45);
  ctx.fill();

  ctx.fillStyle = "rgba(255,255,255,0.65)";
  ctx.beginPath();
  ctx.arc(x + w * 0.24, y + h * 0.90, Math.max(2.4, w * 0.06), 0, Math.PI * 2);
  ctx.arc(x + w * 0.76, y + h * 0.90, Math.max(2.4, w * 0.06), 0, Math.PI * 2);
  ctx.fill();
}

function drawPlayerCarPremium(x, y, w, h) {
  ctx.save();

  ctx.globalAlpha = 0.75;
  ctx.beginPath();
  ctx.ellipse(x + w / 2, y + h * 0.92, w * 0.55, h * 0.18, 0, 0, Math.PI * 2);
  ctx.fillStyle = "rgba(90,190,255,0.25)";
  ctx.fill();
  ctx.globalAlpha = 1;

  const paint = ctx.createLinearGradient(x, y, x, y + h);
  paint.addColorStop(0, "rgba(145,225,255,0.98)");
  paint.addColorStop(0.45, "rgba(90,190,255,0.97)");
  paint.addColorStop(1, "rgba(40,120,210,0.98)");

  ctx.fillStyle = paint;
  drawRoundedRect(x, y, w, h, Math.min(18, w * 0.42));
  ctx.fill();

  ctx.strokeStyle = "rgba(255,255,255,0.22)";
  ctx.lineWidth = Math.max(1.6, w * 0.05);
  ctx.stroke();

  const hi = ctx.createLinearGradient(x, y, x + w, y);
  hi.addColorStop(0, "rgba(255,255,255,0.00)");
  hi.addColorStop(0.35, "rgba(255,255,255,0.16)");
  hi.addColorStop(0.65, "rgba(255,255,255,0.10)");
  hi.addColorStop(1, "rgba(255,255,255,0.00)");
  ctx.fillStyle = hi;
  drawRoundedRect(x + w * 0.10, y + h * 0.10, w * 0.80, h * 0.60, Math.min(16, w * 0.38));
  ctx.fill();

  ctx.fillStyle = "rgba(0,0,0,0.30)";
  drawRoundedRect(x + w * 0.20, y + h * 0.16, w * 0.60, h * 0.40, Math.min(14, w * 0.34));
  ctx.fill();

  ctx.fillStyle = "rgba(255,255,255,0.22)";
  drawRoundedRect(x + w * 0.26, y + h * 0.20, w * 0.48, h * 0.12, Math.min(10, w * 0.26));
  ctx.fill();

  ctx.fillStyle = "rgba(255,255,255,0.22)";
  drawRoundedRect(x + w * 0.46, y + h * 0.08, w * 0.08, h * 0.74, w * 0.08);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.10)";
  drawRoundedRect(x + w * 0.42, y + h * 0.10, w * 0.04, h * 0.70, w * 0.06);
  drawRoundedRect(x + w * 0.54, y + h * 0.10, w * 0.04, h * 0.70, w * 0.06);
  ctx.fill();

  ctx.fillStyle = "rgba(0,0,0,0.62)";
  const ww = Math.max(4, w * 0.14);
  const wh = Math.max(10, h * 0.18);
  const wy1 = y + h * 0.18;
  const wy2 = y + h * 0.62;
  drawRoundedRect(x - ww * 0.18, wy1, ww, wh, ww * 0.50);
  drawRoundedRect(x + w - ww * 0.82, wy1, ww, wh, ww * 0.50);
  drawRoundedRect(x - ww * 0.18, wy2, ww, wh, ww * 0.50);
  drawRoundedRect(x + w - ww * 0.82, wy2, ww, wh, ww * 0.50);
  ctx.fill();

  ctx.fillStyle = "rgba(230,248,255,0.80)";
  ctx.beginPath();
  ctx.arc(x + w * 0.24, y + h * 0.90, Math.max(2.6, w * 0.06), 0, Math.PI * 2);
  ctx.arc(x + w * 0.76, y + h * 0.90, Math.max(2.6, w * 0.06), 0, Math.PI * 2);
  ctx.fill();

  ctx.restore();
}

function render() {
  const g = laneGeometry();

  ctx.clearRect(0, 0, g.w, g.h);

  const grd = ctx.createRadialGradient(g.w / 2, g.h / 2, 40, g.w / 2, g.h / 2, g.w);
  grd.addColorStop(0, "rgba(0,0,0,0.0)");
  grd.addColorStop(1, "rgba(0,0,0,0.65)");

  ctx.fillStyle = "#0b0b10";
  ctx.fillRect(0, 0, g.w, g.h);
  ctx.fillStyle = grd;
  ctx.fillRect(0, 0, g.w, g.h);

  ctx.save();
  ctx.globalAlpha = 0.95;
  ctx.fillStyle = "rgba(20,20,28,0.9)";
  drawRoundedRect(g.roadX, g.roadY, g.roadW, g.roadH, 26);
  ctx.fill();

  ctx.strokeStyle = "rgba(255,174,64,0.65)";
  ctx.lineWidth = 3;
  ctx.stroke();

  ctx.strokeStyle = "rgba(255,255,255,0.22)";
  ctx.lineWidth = 3;
  ctx.setLineDash([14, 18]);
  for (let i = 1; i < g.lanes; i++) {
    const x = g.roadX + g.laneW * i;
    ctx.beginPath();
    ctx.moveTo(x, g.roadY + 18);
    ctx.lineTo(x, g.roadY + g.roadH - 18);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  for (const o of game.obstacles) {
    const ow = o.w ?? o.size;
    const oh = o.h ?? o.size;
    const x = laneCenterX(g, o.lane) - ow / 2;
    const y = o.y;
    drawCarTopDown(x, y, ow, oh, o.color ?? "rgba(255,80,120,0.95)");
  }

  for (const c of game.coins) {
    const x = laneCenterX(g, c.lane);
    const y = c.y;
    ctx.beginPath();
    ctx.fillStyle = "rgba(255,214,86,0.95)";
    ctx.arc(x, y, c.r, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "rgba(255,255,255,0.25)";
    ctx.lineWidth = 2;
    ctx.stroke();
  }

  const carW = Math.max(36, Math.min(60, g.laneW * 0.62));
  const carH = carW * 1.30;
  const carX = laneCenterX(g, game.lane) - carW / 2;
  const carY = g.roadY + g.roadH - carH - 18;
  drawPlayerCarPremium(carX, carY, carW, carH);

  if (game.over) {
    ctx.fillStyle = "rgba(0,0,0,0.55)";
    drawRoundedRect(g.roadX + 16, g.roadY + g.roadH * 0.38, g.roadW - 32, 90, 16);
    ctx.fill();
    ctx.fillStyle = "rgba(255,255,255,0.92)";
    ctx.font = "700 18px system-ui, -apple-system, Segoe UI, Roboto";
    ctx.fillText("Crash!", g.roadX + 34, g.roadY + g.roadH * 0.38 + 34);
    ctx.font = "500 14px system-ui, -apple-system, Segoe UI, Roboto";
    ctx.fillText(
      "Tap Save to bank points, or tap here to restart",
      g.roadX + 34,
      g.roadY + g.roadH * 0.38 + 60
    );
    els.c.style.cursor = "pointer";
  } else {
    els.c.style.cursor = "default";
  }

  ctx.restore();
  renderHud();
}

// Restart on tap when over
els.c.addEventListener(
  "pointerdown",
  (e) => {
    ensureAudioUnlocked();
    if (!game.over) return;
    e.preventDefault();
    e.stopPropagation();
    resetRun();
  },
  { passive: false }
);

// Main loop
function tick(ts) {
  const dt = Math.min(0.033, (ts - game.lastFrame) / 1000);
  game.lastFrame = ts;
  update(dt);
  render();
  requestAnimationFrame(tick);
}
requestAnimationFrame(tick);

// Initial status
renderStatus();
renderHud();
