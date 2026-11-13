'use strict';

const $ = (s) => document.querySelector(s);
const rnd = (a, b) => a + Math.random() * (b - a);
const pick = (arr) => arr[(Math.random() * arr.length) | 0];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ===== 設定の保存 ===== */
const cfg = Object.assign({ trigger: 'touch', seconds: 10, sound: true, vibe: true },
  (() => { try { return JSON.parse(localStorage.getItem('parin_cfg')) || {}; } catch { return {}; } })());
const saveCfg = () => { try { localStorage.setItem('parin_cfg', JSON.stringify(cfg)); } catch {} };

/* スクショは IndexedDB に保存（容量が大きいため） */
const idb = {
  db: null,
  open() {
    return this.db || (this.db = new Promise((res, rej) => {
      const r = indexedDB.open('parin', 1);
      r.onupgradeneeded = () => r.result.createObjectStore('kv');
      r.onsuccess = () => res(r.result); r.onerror = () => rej(r.error);
    }));
  },
  async get(k) { const db = await this.open(); return new Promise((res) => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => res(q.result); q.onerror = () => res(null); }); },
  async set(k, v) { const db = await this.open(); return new Promise((res) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put(v, k); t.oncomplete = res; t.onerror = res; }); },
};

/* ===== 状態 ===== */
const S = {
  mode: 'setup',        // setup | standby | crash | reveal
  img: null,            // なりすまし画像
  armedAt: 0, timer: null, cornerTimer: null, wake: null,
  cracks: [], dpr: 1, W: 0, H: 0,
  audio: null, demo: false, hits: 0,
};
const baseCv = $('#baseCv'), crackCv = $('#crackCv');
const bctx = baseCv.getContext('2d'), cctx = crackCv.getContext('2d');
const off = document.createElement('canvas'), octx = off.getContext('2d'); // 元画像の控え

/* ===== 設定画面 ===== */
function renderSetup() {
  for (const b of document.querySelectorAll('#triggerSeg button')) b.classList.toggle('on', b.dataset.v === cfg.trigger);
  for (const b of document.querySelectorAll('#timerBox button')) b.classList.toggle('on', +b.dataset.s === cfg.seconds);
  $('#timerBox').classList.toggle('hidden', cfg.trigger !== 'timer');
  $('#triggerHint').textContent = cfg.trigger === 'touch'
    ? 'スタンバイ後、友達が画面に触れた場所から割れます。'
    : `スタンバイから${cfg.seconds < 60 ? cfg.seconds + '秒' : '1分'}後、勝手に割れます。友達に渡しておくだけ。`;
  $('#soundSw').checked = cfg.sound; $('#vibeSw').checked = cfg.vibe;
}
function bindSetup() {
  for (const b of document.querySelectorAll('#triggerSeg button')) b.onclick = () => { cfg.trigger = b.dataset.v; saveCfg(); renderSetup(); };
  for (const b of document.querySelectorAll('#timerBox button')) b.onclick = () => { cfg.seconds = +b.dataset.s; saveCfg(); renderSetup(); };
  $('#soundSw').onchange = (e) => { cfg.sound = e.target.checked; saveCfg(); };
  $('#vibeSw').onchange = (e) => { cfg.vibe = e.target.checked; saveCfg(); };
  $('#fileInput').onchange = async (e) => {
    const f = e.target.files[0]; if (!f) return;
    await idb.set('shot', f);
    await loadShot(f);
  };
  $('#startBtn').onclick = () => start(false);
  $('#demoBtn').onclick = () => start(true);
  $('#againBtn').onclick = () => start(S.demo);
  $('#backBtn').onclick = toSetup;
}
async function loadShot(blob) {
  if (!blob) return;
  const url = URL.createObjectURL(blob);
  const img = new Image();
  await new Promise((res) => { img.onload = res; img.onerror = res; img.src = url; });
  if (!img.naturalWidth) return;
  S.img = img;
  $('#preview').src = url; $('#preview').classList.remove('hidden');
  $('#pickText').textContent = '';
  $('#err').classList.add('hidden');
}

/* ===== 画面の切り替え ===== */
function show(id) { for (const s of ['#setup', '#stage', '#reveal']) $(s).classList.toggle('hidden', s !== id); }

async function start(demo) {
  S.demo = demo;
  unlockAudio();
  // 全画面（Androidなど対応端末のみ）
  try { if (!document.fullscreenElement) await document.documentElement.requestFullscreen?.({ navigationUI: 'hide' }); } catch {}
  try { S.wake = await navigator.wakeLock?.request('screen'); } catch {}
  show('#stage');
  $('#stage').style.transform = ''; baseCv.style.filter = '';
  crackCv.style.display = '';
  await sleep(60);
  sizeCanvas();
  drawBase();
  S.cracks = []; S.hits = 0; drawCracks();
  S.mode = 'standby';
  S.armedAt = performance.now() + (demo ? 300 : 1500);   // 渡すときに自分の指で割れないように少し待つ
  clearTimeout(S.timer);
  if (cfg.trigger === 'timer' && !demo) {
    S.timer = setTimeout(() => {
      if (S.mode === 'standby') crash(rnd(0.25, 0.75) * S.W, rnd(0.3, 0.7) * S.H);
    }, cfg.seconds * 1000);
  }
}
function toSetup() {
  S.mode = 'setup';
  clearTimeout(S.timer);
  S.wake?.release?.().catch(() => {}); S.wake = null;
  try { if (document.fullscreenElement) document.exitFullscreen(); } catch {}
  stopConfetti();
  show('#setup');
}

/* ===== キャンバス ===== */
function sizeCanvas() {
  S.dpr = Math.min(window.devicePixelRatio || 1, 3);
  S.W = window.innerWidth; S.H = window.innerHeight;
  for (const c of [baseCv, crackCv, off]) { c.width = Math.round(S.W * S.dpr); c.height = Math.round(S.H * S.dpr); }
  for (const x of [bctx, cctx, octx]) x.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
}
function drawBase() {
  const W = S.W, H = S.H;
  if (S.img) {
    const iw = S.img.naturalWidth, ih = S.img.naturalHeight;
    const sc = Math.max(W / iw, H / ih), dw = iw * sc, dh = ih * sc;
    octx.drawImage(S.img, (W - dw) / 2, (H - dh) / 2, dw, dh);
  } else fakeHome(octx, W, H);
  bctx.setTransform(1, 0, 0, 1, 0, 0);
  bctx.drawImage(off, 0, 0);
  bctx.setTransform(S.dpr, 0, 0, S.dpr, 0, 0);
}
/* スクショがないとき用の、それっぽいホーム画面 */
function fakeHome(ctx, W, H) {
  const g = ctx.createLinearGradient(0, 0, W, H);
  g.addColorStop(0, '#3B5BDB'); g.addColorStop(0.5, '#7048E8'); g.addColorStop(1, '#E64980');
  ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
  const d = new Date();
  ctx.fillStyle = '#fff'; ctx.textAlign = 'center';
  ctx.font = '600 15px -apple-system, sans-serif';
  ctx.fillText(`${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`, 40, 28);
  const cols = 4, size = Math.min(62, W / 6), gap = (W - cols * size) / (cols + 1);
  const colors = ['#34C759', '#FF9500', '#FF3B30', '#5AC8FA', '#FFCC00', '#AF52DE', '#007AFF', '#FF2D55', '#30B0C7', '#8E8E93', '#A2845E', '#32ADE6'];
  let i = 0;
  for (let r = 0; r < 5; r++) for (let c = 0; c < cols; c++) {
    const x = gap + c * (size + gap), y = 70 + r * (size + 34);
    ctx.fillStyle = colors[i++ % colors.length];
    roundRect(ctx, x, y, size, size, size * 0.23); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,.85)'; ctx.fillRect(x + size * 0.15, y + size + 9, size * 0.7, 6);
  }
  ctx.fillStyle = 'rgba(255,255,255,.25)';
  roundRect(ctx, 12, H - 100, W - 24, 84, 30); ctx.fill();
  for (let c = 0; c < cols; c++) {
    ctx.fillStyle = colors[(c * 3 + 2) % colors.length];
    roundRect(ctx, gap + c * (size + gap), H - 89, size, size, size * 0.23); ctx.fill();
  }
}
function roundRect(ctx, x, y, w, h, r) { ctx.beginPath(); ctx.moveTo(x + r, y); ctx.arcTo(x + w, y, x + w, y + h, r); ctx.arcTo(x + w, y + h, x, y + h, r); ctx.arcTo(x, y + h, x, y, r); ctx.arcTo(x, y, x + w, y, r); ctx.closePath(); }

/* ===== ひびの生成 ===== */
function makeCrack(x, y, size) {
  const segs = [], shards = [];
  const rays = 9 + ((Math.random() * 8) | 0);
  const base = Math.random() * Math.PI * 2;
  const rayPts = [];
  let maxD = 0;
  const walk = (sx, sy, a, len, d0, w0, depth, pts) => {
    let px = sx, py = sy, d = d0;
    const end = d0 + len;
    while (d < end) {
      const step = size * rnd(0.025, 0.07);
      a += rnd(-0.2, 0.2);
      const nx = px + Math.cos(a) * step, ny = py + Math.sin(a) * step;
      d += step;
      segs.push({ x1: px, y1: py, x2: nx, y2: ny, d, w: Math.max(0.5, w0 * (1 - (d - d0) / len)) });
      if (pts) pts.push({ x: nx, y: ny, d });
      if (depth < 2 && Math.random() < 0.09) walk(nx, ny, a + rnd(0.5, 1.1) * pick([-1, 1]), len * rnd(0.15, 0.35), d, w0 * 0.6, depth + 1, null);
      px = nx; py = ny;
    }
    maxD = Math.max(maxD, d);
  };
  for (let i = 0; i < rays; i++) {
    const pts = [{ x, y, d: 0 }];
    walk(x, y, base + i * (Math.PI * 2 / rays) + rnd(-0.25, 0.25), size * rnd(0.35, 1.0), 0, rnd(1.6, 2.6), 0, pts);
    rayPts.push(pts);
  }
  // 同心円状のひび（蜘蛛の巣っぽさ）
  const near = (pts, r) => pts.find((p) => p.d >= r);
  for (const f of [0.06, 0.14, 0.26, 0.4]) {
    const r = f * size;
    for (let i = 0; i < rays; i++) {
      if (Math.random() < 0.3) continue;
      const A = near(rayPts[i], r * rnd(0.9, 1.1)), B = near(rayPts[(i + 1) % rays], r * rnd(0.9, 1.1));
      if (!A || !B) continue;
      let px = A.x, py = A.y;
      const n = 3;
      for (let k = 1; k <= n; k++) {
        const t = k / n;
        const jx = k < n ? rnd(-1, 1) * r * 0.06 : 0, jy = k < n ? rnd(-1, 1) * r * 0.06 : 0;
        const nx = A.x + (B.x - A.x) * t + jx, ny = A.y + (B.y - A.y) * t + jy;
        segs.push({ x1: px, y1: py, x2: nx, y2: ny, d: r, w: 1.1 });
        px = nx; py = ny;
      }
    }
  }
  // 中心の砕けた破片
  for (let i = 0; i < 9; i++) {
    const a = rnd(0, Math.PI * 2), r1 = rnd(2, size * 0.05), a2 = a + rnd(0.4, 1.2), r2 = rnd(2, size * 0.06);
    shards.push({ pts: [[x, y], [x + Math.cos(a) * r1, y + Math.sin(a) * r1], [x + Math.cos(a2) * r2, y + Math.sin(a2) * r2]], o: rnd(0.12, 0.45) });
  }
  return { x, y, segs, shards, maxD, prog: 0 };
}
function drawCracks() {
  cctx.clearRect(0, 0, S.W, S.H);
  cctx.lineCap = 'round'; cctx.lineJoin = 'round';
  for (const c of S.cracks) {
    for (const s of c.shards) {
      if (c.prog < 5) continue;
      cctx.fillStyle = `rgba(255,255,255,${s.o})`;
      cctx.beginPath(); cctx.moveTo(...s.pts[0]); cctx.lineTo(...s.pts[1]); cctx.lineTo(...s.pts[2]); cctx.closePath(); cctx.fill();
    }
    // 影 → 光の順に重ねてガラスっぽく
    for (const pass of [0, 1]) {
      cctx.strokeStyle = pass ? 'rgba(255,255,255,0.92)' : 'rgba(0,0,0,0.5)';
      for (const s of c.segs) {
        if (s.d > c.prog) continue;
        cctx.lineWidth = pass ? s.w : s.w + 1.6;
        const o = pass ? 0 : 0.8;
        cctx.beginPath(); cctx.moveTo(s.x1 + o, s.y1 + o); cctx.lineTo(s.x2 + o, s.y2 + o); cctx.stroke();
      }
    }
    if (c.prog > 0) {
      const g = cctx.createRadialGradient(c.x, c.y, 0, c.x, c.y, 14);
      g.addColorStop(0, 'rgba(255,255,255,.85)'); g.addColorStop(1, 'rgba(255,255,255,0)');
      cctx.fillStyle = g; cctx.beginPath(); cctx.arc(c.x, c.y, 14, 0, Math.PI * 2); cctx.fill();
    }
  }
}
function growCrack(c, ms) {
  return new Promise((res) => {
    const t0 = performance.now();
    const f = (t) => {
      const k = Math.min(1, (t - t0) / ms);
      c.prog = c.maxD * (1 - Math.pow(1 - k, 3));
      drawCracks();
      if (k < 1) requestAnimationFrame(f); else res();
    };
    requestAnimationFrame(f);
  });
}
function addCrack(x, y, size, ms, loud) {
  const c = makeCrack(x, y, size);
  S.cracks.push(c);
  if (cfg.sound) glassSound(loud);
  if (cfg.vibe) navigator.vibrate?.(loud > 0.7 ? [180, 40, 60] : 60);
  $('#flash').classList.remove('go'); void $('#flash').offsetWidth; $('#flash').classList.add('go');
  return growCrack(c, ms);
}

/* ===== 割れる → 故障 → ネタばらし ===== */
async function crash(x, y) {
  if (S.mode !== 'standby') return;
  S.mode = 'crash';
  clearTimeout(S.timer);
  const big = Math.max(S.W, S.H);
  await addCrack(x, y, big * 0.75, 140, 1);
  await sleep(1300);
  if (S.mode !== 'crash') return;
  // ひびが広がる
  await addCrack(rnd(0.15, 0.85) * S.W, rnd(0.15, 0.85) * S.H, big * 0.55, 700, 0.6);
  await sleep(450);
  if (S.mode !== 'crash') return;
  addCrack(rnd(0.15, 0.85) * S.W, rnd(0.15, 0.85) * S.H, big * 0.45, 600, 0.45);
  await sleep(500);
  if (S.mode !== 'crash') return;
  await glitch(2800);
  if (S.mode !== 'crash') return;
  await blackout();
  if (S.mode !== 'crash') return;
  reveal();
}

/* 画面が壊れたような乱れ */
function glitch(ms) {
  return new Promise((res) => {
    const t0 = performance.now();
    const deadLines = [];
    const buzz = cfg.sound ? buzzSound(ms) : null;
    const stage = $('#stage');
    const tick = (t) => {
      if (S.mode !== 'crash') { buzz?.stop(); return res(); }
      const k = Math.min(1, (t - t0) / ms);
      const W = S.W, H = S.H, dpr = S.dpr;
      bctx.setTransform(1, 0, 0, 1, 0, 0);
      bctx.drawImage(off, 0, 0);
      // 横ずれ
      const slices = 2 + Math.floor(k * 12);
      for (let i = 0; i < slices; i++) {
        const sy = rnd(0, H) * dpr, sh = rnd(3, 50 + k * 60) * dpr, dx = rnd(-1, 1) * (15 + k * 140) * dpr;
        bctx.drawImage(off, 0, sy, off.width, sh, dx, sy, off.width, sh);
      }
      bctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      // 色のノイズ帯
      const bars = Math.floor(rnd(0, 3 + k * 8));
      for (let i = 0; i < bars; i++) {
        bctx.fillStyle = pick(['rgba(255,0,255,.55)', 'rgba(0,255,255,.5)', 'rgba(0,255,0,.45)', 'rgba(255,255,255,.7)', 'rgba(0,0,0,.85)']);
        bctx.fillRect(rnd(-20, W * 0.6), rnd(0, H), rnd(W * 0.3, W * 1.2), rnd(1, 8 + k * 20));
      }
      // 黒い欠け
      if (Math.random() < k * 0.6) { bctx.fillStyle = '#000'; bctx.fillRect(rnd(0, W), rnd(0, H), rnd(30, 160), rnd(20, 120)); }
      // 縦線（だんだん増える）
      if (Math.random() < 0.08 + k * 0.15) deadLines.push({ x: rnd(0, W), w: rnd(1, 3), c: pick(['#00FF66', '#FF00FF', '#FFFFFF', '#00E5FF']) });
      for (const l of deadLines) { bctx.fillStyle = l.c; bctx.fillRect(l.x, 0, l.w, H); }
      // 画面全体のちらつき
      baseCv.style.filter = Math.random() < 0.08 + k * 0.12 ? pick(['invert(1)', 'hue-rotate(90deg) saturate(4)', 'contrast(3) brightness(.6)', 'grayscale(1) contrast(2)']) : 'none';
      stage.style.transform = `translate(${rnd(-1, 1) * k * 7}px, ${rnd(-1, 1) * k * 5}px)`;
      crackCv.style.opacity = Math.random() < 0.1 * k ? '0.2' : '1';
      if (k < 1) setTimeout(() => requestAnimationFrame(tick), 45); else { buzz?.stop(); res(); }
    };
    requestAnimationFrame(tick);
  });
}
async function blackout() {
  const stage = $('#stage');
  stage.style.transform = ''; baseCv.style.filter = '';
  bctx.fillStyle = '#000'; bctx.fillRect(0, 0, S.W, S.H);
  crackCv.style.display = 'none';
  if (cfg.vibe) navigator.vibrate?.(300);
  await sleep(700);
  // 一瞬だけ戻ってまた消える
  crackCv.style.display = ''; drawBase(); baseCv.style.filter = 'contrast(2) brightness(.5)';
  await sleep(90);
  bctx.fillStyle = '#000'; bctx.fillRect(0, 0, S.W, S.H); crackCv.style.display = 'none'; baseCv.style.filter = '';
  await sleep(900);
}
function reveal() {
  S.mode = 'reveal';
  crackCv.style.display = ''; crackCv.style.opacity = '1';
  show('#reveal');
  if (cfg.sound) fanfare();
  confetti();
}

/* ===== タッチ ===== */
function bindStage() {
  const st = $('#stage');
  st.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const inCorner = e.clientX < 70 && e.clientY < 70;
    if (inCorner) {
      clearTimeout(S.cornerTimer);
      S.cornerTimer = setTimeout(() => { if (S.mode !== 'setup') toSetup(); }, 2000);
      return;
    }
    if (S.mode === 'standby' && (cfg.trigger === 'touch' || S.demo) && performance.now() > S.armedAt) crash(e.clientX, e.clientY);
    else if (S.mode === 'crash' && S.cracks.length < 6 && S.hits++ < 3) addCrack(e.clientX, e.clientY, Math.max(S.W, S.H) * 0.4, 120, 0.5);
  });
  const cancel = () => clearTimeout(S.cornerTimer);
  st.addEventListener('pointerup', cancel);
  st.addEventListener('pointercancel', cancel);
  st.addEventListener('contextmenu', (e) => e.preventDefault());
  document.addEventListener('gesturestart', (e) => e.preventDefault());
  window.addEventListener('resize', () => { if (S.mode === 'standby') { sizeCanvas(); drawBase(); drawCracks(); } });
  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState === 'visible' && S.mode === 'standby') { try { S.wake = await navigator.wakeLock?.request('screen'); } catch {} }
  });
}

/* ===== 音（すべてその場で合成） ===== */
function unlockAudio() {
  if (!cfg.sound) return;
  try {
    S.audio = S.audio || new (window.AudioContext || window.webkitAudioContext)();
    if (S.audio.state === 'suspended') S.audio.resume();
    const o = S.audio.createOscillator(), g = S.audio.createGain(); g.gain.value = 0;
    o.connect(g).connect(S.audio.destination); o.start(); o.stop(S.audio.currentTime + 0.01);
  } catch {}
}
function noiseBuf(ac, sec) {
  const b = ac.createBuffer(1, ac.sampleRate * sec, ac.sampleRate), d = b.getChannelData(0);
  for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
  return b;
}
function glassSound(loud = 1) {
  const ac = S.audio; if (!ac) return;
  const t = ac.currentTime, out = ac.createGain();
  out.gain.value = 0.9 * loud; out.connect(ac.destination);
  // 衝撃のノイズ
  const n = ac.createBufferSource(); n.buffer = noiseBuf(ac, 0.5);
  const bp = ac.createBiquadFilter(); bp.type = 'bandpass'; bp.frequency.value = 3200; bp.Q.value = 0.7;
  const ng = ac.createGain(); ng.gain.setValueAtTime(1, t); ng.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
  n.connect(bp).connect(ng).connect(out); n.start(t);
  // ドンという低音
  const o = ac.createOscillator(), og = ac.createGain();
  o.frequency.setValueAtTime(150, t); o.frequency.exponentialRampToValueAtTime(40, t + 0.15);
  og.gain.setValueAtTime(0.7, t); og.gain.exponentialRampToValueAtTime(0.001, t + 0.2);
  o.connect(og).connect(out); o.start(t); o.stop(t + 0.25);
  // パラパラと落ちる破片の音
  const bits = 10 + ((loud * 14) | 0);
  for (let i = 0; i < bits; i++) {
    const s = t + rnd(0.02, 0.7) * (0.4 + loud * 0.6);
    const p = ac.createOscillator(), pg = ac.createGain();
    p.type = 'sine'; p.frequency.value = rnd(2500, 9000);
    pg.gain.setValueAtTime(rnd(0.05, 0.2), s); pg.gain.exponentialRampToValueAtTime(0.0001, s + rnd(0.04, 0.18));
    p.connect(pg).connect(out); p.start(s); p.stop(s + 0.2);
  }
  const hn = ac.createBufferSource(); hn.buffer = noiseBuf(ac, 0.8);
  const hp = ac.createBiquadFilter(); hp.type = 'highpass'; hp.frequency.value = 6000;
  const hg = ac.createGain(); hg.gain.setValueAtTime(0.0001, t);
  for (let i = 0; i < 8; i++) { const s = t + 0.05 + i * rnd(0.04, 0.09); hg.gain.setValueAtTime(rnd(0.1, 0.35), s); hg.gain.setValueAtTime(0.0001, s + 0.015); }
  hn.connect(hp).connect(hg).connect(out); hn.start(t);
}
function buzzSound(ms) {
  const ac = S.audio; if (!ac) return null;
  const t = ac.currentTime, out = ac.createGain(); out.gain.value = 0; out.connect(ac.destination);
  const o1 = ac.createOscillator(), o2 = ac.createOscillator(), lp = ac.createBiquadFilter();
  o1.type = 'sawtooth'; o1.frequency.value = 58; o2.type = 'square'; o2.frequency.value = 117;
  lp.type = 'lowpass'; lp.frequency.value = 1400;
  o1.connect(lp); o2.connect(lp); lp.connect(out);
  const n = ac.createBufferSource(); n.buffer = noiseBuf(ac, ms / 1000 + 0.2);
  const ngn = ac.createGain(); ngn.gain.value = 0.25; n.connect(ngn).connect(out);
  for (let s = 0; s < ms / 1000; s += 0.05) out.gain.setValueAtTime(Math.random() < 0.35 + s / (ms / 1000) * 0.4 ? rnd(0.08, 0.22) : 0, t + s);
  o1.start(t); o2.start(t); n.start(t);
  return { stop() { try { const e = ac.currentTime; out.gain.cancelScheduledValues(e); out.gain.setValueAtTime(0, e); o1.stop(e + 0.05); o2.stop(e + 0.05); n.stop(e + 0.05); } catch {} } };
}
function fanfare() {
  const ac = S.audio; if (!ac) return;
  const t = ac.currentTime;
  [523.25, 659.25, 783.99, 1046.5, 783.99, 1046.5].forEach((f, i) => {
    const o = ac.createOscillator(), g = ac.createGain(), s = t + i * 0.11, d = i >= 4 ? 0.45 : 0.14;
    o.type = 'triangle'; o.frequency.value = f;
    g.gain.setValueAtTime(0.25, s); g.gain.exponentialRampToValueAtTime(0.001, s + d);
    o.connect(g).connect(ac.destination); o.start(s); o.stop(s + d + 0.05);
  });
}

/* ===== 紙吹雪 ===== */
let confRAF = 0;
function confetti() {
  const cv = $('#confettiCv'), ctx = cv.getContext('2d');
  const dpr = Math.min(devicePixelRatio || 1, 2), W = innerWidth, H = innerHeight;
  cv.width = W * dpr; cv.height = H * dpr; ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  const cols = ['#1F2937', '#FFFFFF', '#E5484D', '#2D6CDF', '#12A594', '#8E4EC6'];
  const ps = Array.from({ length: 160 }, () => ({ x: rnd(0, W), y: rnd(-H, 0), vx: rnd(-1, 1), vy: rnd(2, 5), r: rnd(0, 6.28), vr: rnd(-0.2, 0.2), w: rnd(6, 11), h: rnd(8, 16), c: pick(cols) }));
  const t0 = performance.now();
  cancelAnimationFrame(confRAF);
  const f = (t) => {
    ctx.clearRect(0, 0, W, H);
    for (const p of ps) {
      p.x += p.vx; p.y += p.vy; p.r += p.vr;
      if (p.y > H + 20 && t - t0 < 2500) { p.y = -20; p.x = rnd(0, W); }
      ctx.save(); ctx.translate(p.x, p.y); ctx.rotate(p.r); ctx.fillStyle = p.c; ctx.fillRect(-p.w / 2, -p.h / 2, p.w, p.h * Math.abs(Math.cos(p.r * 2))); ctx.restore();
    }
    if (t - t0 < 6000) confRAF = requestAnimationFrame(f); else ctx.clearRect(0, 0, W, H);
  };
  confRAF = requestAnimationFrame(f);
}
function stopConfetti() { cancelAnimationFrame(confRAF); }

/* ===== 起動 ===== */
bindSetup();
bindStage();
renderSetup();
idb.get('shot').then(loadShot).catch(() => {});
if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js').catch(() => {});
