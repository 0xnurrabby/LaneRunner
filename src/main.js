import { sdk } from "https://esm.sh/@farcaster/miniapp-sdk@0.2.1";
import { encodeAbiParameters, encodeFunctionData, keccak256, stringToHex, toHex } from "https://esm.sh/viem@2.21.0";
import { Attribution } from "https://esm.sh/ox/erc8021";

/**
 * NON-NEGOTIABLE: builder code MUST match your Base.dev Builder Code.
 * This project uses "nurrabby" as the assumed code.
 */
const BUILDER_CODE = "nurrabby";

const CONTRACT = "0xB331328F506f2D35125e367A190e914B1b6830cF";
const BASE_CHAIN_ID_HEX = "0x2105";

const dataSuffix = Attribution.toDataSuffix({ codes: [BUILDER_CODE] });

/** UI bootstrap */
const app = document.getElementById("app");
app.innerHTML = `
  <div class="shell">
    <div class="topbar">
      <button class="iconBtn" id="menuBtn" aria-label="Menu">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none"><path d="M4 7h16M4 12h16M4 17h16" stroke="currentColor" stroke-width="2" stroke-linecap="round"/></svg>
      </button>
      <div class="badge" id="statusBadge">Loading…</div>
    </div>

    <div class="gameCard">
      <div class="canvasWrap">
        <canvas id="c"></canvas>
      </div>

      <div class="hud" id="hud">
        <div class="hudTitle">Lane Runner</div>
        <div class="hudRow">
          <div>Score: <b id="score">0</b></div>
          <div>Coins: <b id="coins">0</b></div>
          <div>Near: <b id="near">0</b></div>
        </div>
        <div class="hudRow" style="margin-top:8px">
          <div>Boost: <b id="boost">—</b></div>
        </div>
      </div>

      <div class="toast" id="toast"></div>
    </div>

    <div class="bottomBar">
      <div style="width:100%">
        <div class="controls">
          <button class="ctrlBtn" id="leftBtn">◀</button>
          <button class="ctrlBtn primary" id="cashBtn">CASH OUT</button>
          <button class="ctrlBtn" id="rightBtn">▶</button>
        </div>
        <div class="smallHint">Tap buttons • Instant response • Cash out anytime</div>
      </div>
    </div>

    <div class="sheet" id="sheet">
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
  score: $("#score"),
  coins: $("#coins"),
  near: $("#near"),
  boost: $("#boost"),
  c: $("#c")
};

function $(sel){ return document.querySelector(sel); }

function toast(msg, ms=1800){
  els.toast.textContent = msg;
  els.toast.classList.add("show");
  clearTimeout(toast._t);
  toast._t = setTimeout(()=>els.toast.classList.remove("show"), ms);
}

/** Mini App readiness: MUST call */
(async () => {
  try {
    // Disable native gestures because we use frequent taps/swipes for gameplay.
    await sdk.actions.ready({ disableNativeGestures: true });
    els.statusBadge.textContent = "Ready";
  } catch (e) {
    // If this fails, you're almost certainly in browser mode or SDK not injected.
    els.statusBadge.textContent = "SDK not detected";
  }
})();

/** Wallet / chain state */
let ethProvider = null;
let account = null;

async function getProvider(){
  if (ethProvider) return ethProvider;
  try {
    ethProvider = await sdk.wallet.getEthereumProvider();
    return ethProvider;
  } catch {
    return null;
  }
}

async function connectWallet(){
  const p = await getProvider();
  if (!p) {
    toast("Open inside Base / Farcaster Mini App to connect wallet.");
    return null;
  }
  const accs = await p.request({ method: "eth_requestAccounts", params: [] });
  account = accs?.[0] || null;
  renderStatus();
  return account;
}

async function ensureBase(){
  const p = await getProvider();
  if (!p) throw new Error("No provider");
  const chainId = await p.request({ method: "eth_chainId", params: [] });
  if (chainId === BASE_CHAIN_ID_HEX) return;
  try {
    await p.request({ method: "wallet_switchEthereumChain", params: [{ chainId: BASE_CHAIN_ID_HEX }] });
  } catch (e) {
    throw new Error("Please switch to Base (0x2105) in your wallet.");
  }
}

function renderStatus(){
  if (!account) {
    els.statusBadge.textContent = "Tap Menu → Connect";
    return;
  }
  els.statusBadge.textContent = `${account.slice(0,6)}…${account.slice(-4)} (Base)`;
}

/** Game: short, tense, player-controlled stop */
const state = {
  running: true,
  lane: 1,              // 0..2
  score: 0,
  coins: 0,
  near: 0,
  speed: 1.0,           // increases with risk
  risk: 0,              // 0..1
  obstacles: [],
  lastSpawn: 0,
  t: 0,
  sessionBest: Number(localStorage.getItem("nr_best") || "0"),
  weeklyBest: Number(localStorage.getItem("nr_weekly_best") || "0"),
  allTimeBest: Number(localStorage.getItem("nr_all_best") || "0"),
  lastCommitAt: Number(localStorage.getItem("nr_last_commit") || "0"),
  boostReadyAt: Number(localStorage.getItem("nr_boost_ready_at") || "0"),
  boostMult: 1,
  nextBoostInMs: 0
};

const WEEK_MS = 7*24*60*60*1000;
// Fixed weekly reset: Monday 00:00 UTC (simple + deterministic)
function currentWeekIdUtc(){
  const now = new Date();
  const day = now.getUTCDay(); // 0 Sun .. 6 Sat
  const diffToMon = (day + 6) % 7; // how many days since Monday
  const monday = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() - diffToMon, 0,0,0,0));
  return monday.toISOString().slice(0,10); // YYYY-MM-DD
}
function ensureWeeklyReset(){
  const weekId = currentWeekIdUtc();
  const stored = localStorage.getItem("nr_week_id");
  if (stored !== weekId){
    localStorage.setItem("nr_week_id", weekId);
    localStorage.setItem("nr_weekly_best", "0");
    state.weeklyBest = 0;
    toast("Weekly leaderboard reset!");
  }
}
ensureWeeklyReset();

/** Return rhythm: every 2-6 hours give a temporary multiplier */
function computeBoost(){
  const now = Date.now();
  // First run: schedule next boost in 2-6h
  if (!state.boostReadyAt){
    const wait = hoursToMs(randInt(2,6));
    state.boostReadyAt = now + wait;
    localStorage.setItem("nr_boost_ready_at", String(state.boostReadyAt));
  }
  if (now >= state.boostReadyAt){
    // grant boost for this session, then schedule next
    state.boostMult = randChoice([1.15, 1.2, 1.25, 1.3]);
    const wait = hoursToMs(randInt(2,6));
    state.boostReadyAt = now + wait;
    localStorage.setItem("nr_boost_ready_at", String(state.boostReadyAt));
    localStorage.setItem("nr_boost_mult", String(state.boostMult));
    toast(`Boost active: x${state.boostMult.toFixed(2)} score`);
  } else {
    state.boostMult = Number(localStorage.getItem("nr_boost_mult") || "1") || 1;
  }
  state.nextBoostInMs = Math.max(0, state.boostReadyAt - now);
}
computeBoost();

function hoursToMs(h){ return h*60*60*1000; }
function randInt(a,b){ return Math.floor(Math.random()*(b-a+1))+a; }
function randChoice(arr){ return arr[Math.floor(Math.random()*arr.length)]; }

/** Canvas sizing */
const ctx = els.c.getContext("2d", { alpha: false });
function resize(){
  const r = els.c.getBoundingClientRect();
  const dpr = Math.max(1, Math.min(2, window.devicePixelRatio || 1));
  els.c.width = Math.floor(r.width * dpr);
  els.c.height = Math.floor(r.height * dpr);
  ctx.setTransform(dpr,0,0,dpr,0,0);
}
window.addEventListener("resize", resize);
resize();

/** Input: instant & mobile-friendly */
const input = { left:false, right:false };
bindHold($("#leftBtn"), ()=>move(-1));
bindHold($("#rightBtn"), ()=>move(1));
$("#cashBtn").addEventListener("click", cashOut);

function bindHold(btn, fn){
  let holding = false;
  let raf = 0;

  const start = (e) => {
    e.preventDefault();
    holding = true;
    fn();
    const loop = () => {
      if (!holding) return;
      fn();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
  };
  const stop = (e) => {
    e.preventDefault();
    holding = false;
    cancelAnimationFrame(raf);
  };

  btn.addEventListener("pointerdown", start, { passive: false });
  btn.addEventListener("pointerup", stop, { passive: false });
  btn.addEventListener("pointercancel", stop, { passive: false });
  btn.addEventListener("pointerleave", stop, { passive: false });
}

function move(dir){
  state.lane = clamp(state.lane + dir, 0, 2);
  // subtle haptic feedback if available
  try { sdk.haptics.impactOccurred?.("light"); } catch {}
}

function clamp(v,a,b){ return Math.max(a, Math.min(b,v)); }

/** Obstacles */
function spawn(){
  const lane = randInt(0,2);
  const kind = randChoice(["block","coin"]);
  state.obstacles.push({
    lane,
    y: -60,
    kind,
    w: 56,
    h: 70,
    passed: false
  });
}

function update(dt){
  ensureWeeklyReset();
  state.t += dt;

  // Risk rises with time survived + speed; player can cash out any time.
  state.risk = clamp(state.risk + dt*0.00012*state.speed, 0, 1);

  // Spawns
  state.lastSpawn += dt;
  const spawnEvery = 900 / state.speed; // ms
  if (state.lastSpawn >= spawnEvery){
    state.lastSpawn = 0;
    spawn();
  }

  // Speed increases slowly, extra bump with risk
  state.speed = 1 + state.t*0.00005 + state.risk*0.8;

  // Move obstacles
  const fall = 0.22 * state.speed; // px per ms
  for (const o of state.obstacles){
    o.y += fall * dt;
    // Near miss detection
    if (!o.passed && o.kind === "block" && o.y > laneY().carY - 20 && Math.abs(o.lane - state.lane) === 1){
      o.passed = true;
      state.near += 1;
      state.score += Math.floor(8 * state.boostMult);
    }
  }

  // Collisions
  const car = laneY();
  for (const o of state.obstacles){
    if (o.kind === "coin"){
      if (collides(car, o)){
        o.dead = true;
        state.coins += 1;
        state.score += Math.floor(15 * state.boostMult);
        try { sdk.haptics.impactOccurred?.("light"); } catch {}
      }
    } else {
      if (collides(car, o)){
        // Crash: lose this run's score progress since last cash out.
        crash();
        return;
      }
    }
  }

  // Clean
  state.obstacles = state.obstacles.filter(o => !o.dead && o.y < 900);

  // Passive score gain is small but scales with risk & boost
  state.score += Math.floor((dt * 0.01) * (1 + state.risk) * state.boostMult);

  // HUD
  els.score.textContent = String(state.score);
  els.coins.textContent = String(state.coins);
  els.near.textContent = String(state.near);

  const mins = Math.floor(state.nextBoostInMs/60000);
  const hrs = Math.floor(mins/60);
  const mm = mins % 60;
  els.boost.textContent = state.boostMult > 1 ? `x${state.boostMult.toFixed(2)}` : `${hrs}h ${mm}m`;
}

function laneY(){
  // Car location derived from canvas size
  const r = els.c.getBoundingClientRect();
  const w = r.width;
  const h = r.height;
  const laneW = w / 3;
  const carW = Math.min(76, laneW * 0.62);
  const carH = carW * 1.25;
  const carX = laneW*state.lane + laneW/2 - carW/2;
  const carY = h - carH - 28;
  return { carX, carY, carW, carH, laneW, w, h };
}

function collides(car, o){
  const { carX, carY, carW, carH, laneW } = car;
  const ox = laneW*o.lane + laneW/2 - o.w/2;
  const oy = o.y;
  return !(carX + carW < ox || carX > ox + o.w || carY + carH < oy || carY > oy + o.h);
}

function crash(){
  // Keep bests, reset run.
  try { sdk.haptics.notificationOccurred?.("error"); } catch {}
  toast("Crashed! Try a shorter cash out next time.");
  resetRun();
}

function cashOut(){
  try { sdk.haptics.notificationOccurred?.("success"); } catch {}
  // Update bests
  state.sessionBest = Math.max(state.sessionBest, state.score);
  state.weeklyBest = Math.max(state.weeklyBest, state.score);
  state.allTimeBest = Math.max(state.allTimeBest, state.score);

  localStorage.setItem("nr_best", String(state.sessionBest));
  localStorage.setItem("nr_weekly_best", String(state.weeklyBest));
  localStorage.setItem("nr_all_best", String(state.allTimeBest));

  toast(`Cashed out at ${state.score}!`);
  resetRun();
}

function resetRun(){
  state.score = 0;
  state.coins = 0;
  state.near = 0;
  state.risk = 0;
  state.speed = 1;
  state.t = 0;
  state.obstacles = [];
  state.lastSpawn = 0;
}

/** Render */
function draw(){
  const r = els.c.getBoundingClientRect();
  const w = r.width;
  const h = r.height;

  // background
  ctx.fillStyle = "#0b0b12";
  ctx.fillRect(0,0,w,h);

  // road
  const { laneW } = laneY();
  const roadX = w*0.14;
  const roadW = w*0.72;
  const roadY = h*0.07;
  const roadH = h*0.86;

  // glow border
  ctx.save();
  ctx.globalAlpha = 0.65;
  ctx.strokeStyle = "rgba(255,130,0,0.55)";
  ctx.lineWidth = 8;
  roundRect(ctx, roadX, roadY, roadW, roadH, 26);
  ctx.stroke();
  ctx.restore();

  // inner road
  ctx.fillStyle = "rgba(255,255,255,0.04)";
  roundRect(ctx, roadX, roadY, roadW, roadH, 22);
  ctx.fill();

  // lane lines
  ctx.strokeStyle = "rgba(255,255,255,0.26)";
  ctx.lineWidth = 3;
  ctx.setLineDash([10, 18]);
  for (let i=1;i<=2;i++){
    const x = roadX + (roadW/3)*i;
    ctx.beginPath();
    ctx.moveTo(x, roadY);
    ctx.lineTo(x, roadY+roadH);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  // obstacles
  const laneX0 = roadX;
  for (const o of state.obstacles){
    const cx = laneX0 + laneW*o.lane + laneW/2;
    const x = cx - o.w/2;
    const y = roadY + o.y;
    if (o.kind === "coin"){
      ctx.fillStyle = "rgba(255,215,100,0.9)";
      ctx.beginPath();
      ctx.arc(cx, y + o.h/2, Math.min(18, o.w*0.35), 0, Math.PI*2);
      ctx.fill();
      ctx.strokeStyle = "rgba(0,0,0,0.35)";
      ctx.lineWidth = 2;
      ctx.stroke();
    } else {
      ctx.fillStyle = "rgba(255,77,109,0.85)";
      roundRect(ctx, x, y, o.w, o.h, 14);
      ctx.fill();
      ctx.fillStyle = "rgba(0,0,0,0.25)";
      roundRect(ctx, x+10, y+12, o.w-20, 14, 8);
      ctx.fill();
    }
  }

  // car (player)
  const car = laneY();
  const carCx = roadX + laneW*state.lane + laneW/2;
  const carX = carCx - car.carW/2;
  const carY = roadY + car.carY;
  ctx.fillStyle = "rgba(80,160,255,0.95)";
  roundRect(ctx, carX, carY, car.carW, car.carH, 16);
  ctx.fill();
  ctx.fillStyle = "rgba(0,0,0,0.25)";
  roundRect(ctx, carX+10, carY+12, car.carW-20, 14, 8);
  ctx.fill();
  ctx.fillStyle = "rgba(255,255,255,0.65)";
  ctx.beginPath(); ctx.arc(carX+16, carY+car.carH-14, 6, 0, Math.PI*2); ctx.fill();
  ctx.beginPath(); ctx.arc(carX+car.carW-16, carY+car.carH-14, 6, 0, Math.PI*2); ctx.fill();

  // risk bar (encourages stopping)
  const barW = roadW*0.76;
  const barX = roadX + (roadW-barW)/2;
  const barY = roadY + roadH + 10;
  ctx.fillStyle = "rgba(255,255,255,0.08)";
  roundRect(ctx, barX, barY, barW, 10, 6);
  ctx.fill();
  ctx.fillStyle = "rgba(255,130,0,0.75)";
  roundRect(ctx, barX, barY, barW*state.risk, 10, 6);
  ctx.fill();
}

function roundRect(ctx, x, y, w, h, r){
  const rr = Math.min(r, w/2, h/2);
  ctx.beginPath();
  ctx.moveTo(x+rr, y);
  ctx.arcTo(x+w, y, x+w, y+h, rr);
  ctx.arcTo(x+w, y+h, x, y+h, rr);
  ctx.arcTo(x, y+h, x, y, rr);
  ctx.arcTo(x, y, x+w, y, rr);
  ctx.closePath();
}

/** Game loop */
let last = performance.now();
function loop(now){
  const dt = Math.min(32, now - last);
  last = now;
  update(dt);
  draw();
  requestAnimationFrame(loop);
}
requestAnimationFrame(loop);

/** Menu */
$("#menuBtn").addEventListener("click", () => openSheet("Menu", renderMenu()));
$("#closeSheet").addEventListener("click", closeSheet);
$("#sheet").addEventListener("click", (e)=>{ if (e.target.id === "sheet") closeSheet(); });

function openSheet(title, html){
  els.sheetTitle.textContent = title;
  els.sheetBody.innerHTML = html;
  els.sheet.classList.add("open");
  wireSheetActions();
}
function closeSheet(){ els.sheet.classList.remove("open"); }

function renderMenu(){
  const lastCommitAgoMin = state.lastCommitAt ? Math.floor((Date.now()-state.lastCommitAt)/60000) : null;
  const canCommit = Date.now() - state.lastCommitAt > hoursToMs(2);
  return `
    <div class="kv"><div>Wallet</div><span>${account ? (account.slice(0,6)+"…"+account.slice(-4)) : "Not connected"}</span></div>
    <div class="kv"><div>Best (session)</div><span>${state.sessionBest}</span></div>
    <div class="kv"><div>Best (weekly)</div><span>${state.weeklyBest}</span></div>
    <div class="kv"><div>Best (all-time)</div><span>${state.allTimeBest}</span></div>
    <div class="kv"><div>Commit cooldown</div><span>${canCommit ? "Ready" : `Wait ~${Math.max(0, 120-(lastCommitAgoMin||0))}m`}</span></div>

    <div class="row">
      <button class="btn accent" data-act="connect">${account ? "Reconnect" : "Connect"}</button>
      <button class="btn" data-act="leaderboards">Leaderboards</button>
    </div>

    <div class="row">
      <button class="btn" data-act="how">How it works</button>
      <button class="btn" data-act="settings">Settings</button>
    </div>

    <div class="row">
      <button class="btn ${canCommit ? "accent" : ""}" data-act="commit" ${canCommit ? "" : "disabled"}>Commit weekly best on-chain</button>
    </div>

    <div style="margin-top:12px" class="mono">
      Contract: ${CONTRACT}<br/>
      Chain: Base Mainnet (${BASE_CHAIN_ID_HEX})<br/>
      Builder code: ${BUILDER_CODE}<br/>
      dataSuffix: ${dataSuffix}
    </div>
  `;
}

function renderLeaderboards(){
  return `
    <div style="color:var(--text); font-weight:800; margin-bottom:10px">Local leaderboards (device)</div>
    <div class="kv"><div>Weekly</div><span>${state.weeklyBest}</span></div>
    <div class="kv"><div>All-time</div><span>${state.allTimeBest}</span></div>

    <div style="margin-top:12px; color:var(--muted)">
      Weekly resets every Monday 00:00 UTC. Commit a score on-chain when it feels meaningful.
    </div>

    <div class="row">
      <button class="btn" data-act="back">Back</button>
      <button class="btn accent" data-act="share">Share</button>
    </div>
  `;
}

function renderHow(){
  return `
    <div style="color:var(--text); font-weight:800; margin-bottom:10px">Design</div>
    <div>
      This game is built for frequent, intentional returns.
      Every 2–6 hours, your next session can grant a small score boost.
      Gameplay is always off-chain. Only when you're proud of a score, you can commit it on-chain.
    </div>
    <div style="margin-top:12px; color:var(--text); font-weight:800">Controls</div>
    <div>Use ◀ ▶ for lane changes. Cash out anytime to lock your best.</div>
    <div class="row">
      <button class="btn" data-act="back">Back</button>
      <button class="btn accent" data-act="leaderboards">Leaderboards</button>
    </div>
  `;
}

function renderSettings(){
  return `
    <div class="kv"><div>Boost multiplier</div><span>x${state.boostMult.toFixed(2)}</span></div>
    <div class="kv"><div>Next boost</div><span>${Math.floor(state.nextBoostInMs/60000)} min</span></div>

    <div class="row">
      <button class="btn danger" data-act="reset">Reset local scores</button>
      <button class="btn" data-act="back">Back</button>
    </div>
  `;
}

function wireSheetActions(){
  els.sheetBody.querySelectorAll("[data-act]").forEach(btn=>{
    btn.addEventListener("click", async () => {
      const act = btn.getAttribute("data-act");
      try{
        if (act === "connect"){
          await connectWallet();
          await ensureBase().catch(()=>{});
          openSheet("Menu", renderMenu());
        } else if (act === "leaderboards"){
          openSheet("Leaderboards", renderLeaderboards());
        } else if (act === "how"){
          openSheet("How it works", renderHow());
        } else if (act === "settings"){
          openSheet("Settings", renderSettings());
        } else if (act === "reset"){
          if (confirm("Reset local leaderboard data?")){
            localStorage.removeItem("nr_best");
            localStorage.removeItem("nr_weekly_best");
            localStorage.removeItem("nr_all_best");
            state.sessionBest = 0; state.weeklyBest = 0; state.allTimeBest = 0;
            toast("Reset complete.");
            openSheet("Settings", renderSettings());
          }
        } else if (act === "back"){
          openSheet("Menu", renderMenu());
        } else if (act === "share"){
          await shareApp();
        } else if (act === "commit"){
          await commitWeeklyBest();
          openSheet("Menu", renderMenu());
        }
      }catch(e){
        toast(e?.message || "Something went wrong");
      }
    });
  });
}

async function shareApp(){
  try{
    await sdk.actions.composeCast({
      text: `I just played Nurrabby Lane Runner. Weekly best: ${state.weeklyBest} 🏁`,
      embeds: ["https://nurrabby.com/"]
    });
  }catch{
    toast("Share only works inside a Farcaster client.");
  }
}

/** On-chain commit: calls your contract logAction(bytes32,bytes) */
async function commitWeeklyBest(){
  if (state.weeklyBest <= 0) throw new Error("Play and cash out first.");
  if (!account) await connectWallet();
  await ensureBase();

  const now = Date.now();
  const COOLDOWN_MS = 2*60*60*1000;
  if (now - state.lastCommitAt < COOLDOWN_MS) throw new Error("Cooldown active. Try later.");

  const action = stringToHex("COMMIT_WEEKLY", { size: 32 });
  const data = encodeAbiParameters(
    [
      { name:"score", type:"uint256" },
      { name:"week", type:"string" },
      { name:"ts", type:"uint256" }
    ],
    [BigInt(state.weeklyBest), currentWeekIdUtc(), BigInt(now)]
  );

  const calldata = encodeFunctionData({
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
    args: [action, data]
  });

  const p = await getProvider();
  if (!p) throw new Error("No wallet provider");
  const from = account;

  // Preferred: ERC-5792 wallet_sendCalls with dataSuffix capability
  let txHash = null;
  try{
    const res = await p.request({
      method: "wallet_sendCalls",
      params: [{
        version: "2.0.0",
        from,
        chainId: BASE_CHAIN_ID_HEX,
        atomicRequired: true,
        calls: [{
          to: CONTRACT,
          value: "0x0",
          data: calldata
        }],
        capabilities: { dataSuffix }
      }]
    });
    txHash = (typeof res === "string") ? res : (res?.hash || null);
  }catch(e){
    // If user rejects, keep UI usable
    if (isUserRejected(e)){
      toast("Transaction canceled.");
      return;
    }
    // Fallback: eth_sendTransaction (append suffix ourselves)
    try{
      const dataWithSuffix = calldata + dataSuffix.slice(2);
      const hash = await p.request({
        method: "eth_sendTransaction",
        params: [{
          from,
          to: CONTRACT,
          value: "0x0",
          data: dataWithSuffix
        }]
      });
      txHash = hash;
    }catch(e2){
      if (isUserRejected(e2)){
        toast("Transaction canceled.");
        return;
      }
      throw new Error("Transaction failed. Please try again.");
    }
  }

  state.lastCommitAt = now;
  localStorage.setItem("nr_last_commit", String(now));

  if (txHash) toast("Committed on-chain!");
}

function isUserRejected(e){
  const msg = (e?.message || "").toLowerCase();
  return e?.code === 4001 || msg.includes("user rejected") || msg.includes("rejected") || msg.includes("denied");
}

// Pre-render status
renderStatus();
