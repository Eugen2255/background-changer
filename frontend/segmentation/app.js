'use strict';

/**
 * Pose + SelfieSegmentation only
 * - фон: color / image / blur (blur дешевый: downsample→blur→upscale)
 * - человек: базовая маска + halo removal (перо только внутрь, кэшируется)
 * - руки: только по Pose (аккуратные плечи, кисти-эллипсы с размытием)
 * - PERF: ограничение FPS, децимация моделей, реюз offscreen-слоёв
 * - HUD: FPS, CPU load, frame ms, Seg/Pose ms, JS heap, GPU renderer (toggle: 'g')
 */

/* ===================== CONFIG ===================== */

// сглаживание краёв маски (из твоего первого кода)
const EDGE_SMOOTH_PX   = 15;   // внешний софт у границы SelfieSeg
const FEATHER_INNER_PX = 1;  // лёгкое «перо» внутрь при композите
const HALO_BLUR        = 3;   // радиус для кольца-ореола (размыть и вычесть)
const HALO_ALPHA       = 1;  // сколько «съедать» наружный ореол

// визуальные параметры рук/кистей
const ARM_FEATHER_PX   = 8;    // размытие краёв коридора рук
const PALM_FEATHER_PX  = 18;   // размытие краёв эллипса кисти

// масштаб кистей (эллипсы)
const PALM_FORWARD_K     = 1;
const PALM_A_MIN         = 0.10;
const PALM_A_MAX         = 0.30;
const PALM_B_TO_A        = 0.50;
const PALM_OUTLINE_SCALE = 0.94;

// частоты/каденция
const TARGET_FPS = 30;
const SEG_EVERY  = 2;
const POSE_EVERY = 3;
const HALO_EVERY = 4;

// порядок моделей
const MODEL_ORDER = ['seg', 'pose'];

// === ВАЖНО: защита плеч от дорисовки Pose ===
const SHOULDER_KEEP_OUT_ENABLED        = true;   // вырезать всё от Pose вблизи плеч
const SHOULDER_KEEP_OUT_FOR_PALMS      = true;   // применять вырез к эллипсам кистей
const SHOULDER_KEEPOUT_RADIUS_K        = 0.28;   // радиус = shoulderW * K (подбирается по вкусу)

// индексы BlazePose
const IDX = {
  L_SHOULDER: 11, R_SHOULDER: 12,
  L_ELBOW: 13,   R_ELBOW: 14,
  L_WRIST: 15,   R_WRIST: 16,
  L_PINKY: 17,   R_PINKY: 18,
  L_INDEX: 19,   R_INDEX: 20,
  L_THUMB: 21,   R_THUMB: 22,
};

/* ===================== GLOBALS ===================== */

let video, canvas, ctx;
let selfieSegmentation = null;
let pose = null;
let latestPose = null;

let backgroundMode = 'color';
let backgroundImage = null;

// === UI элементы ===
let stageEl, overlayTextEl;
let bgColorBtn, bgBlurBtn, bgImageBtn, highBtn, mediumBtn, lowBtn, hideBtn;
let bgPickerEl, bgGridEl, bgPickerCloseEl;
let currentPrivacyLevel = 'low';
const PRIVACY_BASE = '/privacy'; // база для JSON с данными сотрудника

// даунскейл для Pose
let detCanvas, detCtx;

// основная маска
let maskCanvas, maskCtx;

// offscreen буферы
let solidCanvas, solidCtx;  // «жёсткая» копия маски
let ringCanvas,  ringCtx;   // halo-кольцо
let armLayer,    armCtx;    // слой рук
let palmLayer,   palmCtx;   // слой кистей
let fgCanvas,    fgCtx;     // итоговый передний план
let bgSmallCanvas, bgSmallCtx;

// перф
let frameNo = 0;
const frameBudgetMs = 1000 / TARGET_FPS;
let lastFrameTs = 0;

// PERF HUD
const EMA_A = 0.8;
const perf = {
  frames: 0,
  fps: 0,
  frameStartTs: 0,
  cpuBusyMs: 0,
  cpuLoad: 0,
  segMs: null,
  poseMs: null,
  frameMs: null,
  heapMB: null,
  cores: navigator.hardwareConcurrency || null,
  gpuRenderer: '—',
  hudOn: true,
};

/* ===================== LOADER ===================== */

async function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    if ([...document.scripts].some(s => s.src.includes(src))) return resolve();
    const s = document.createElement('script');
    s.src = src;
    s.onload = () => resolve();
    s.onerror = () => reject(new Error(`Failed to load ${src}`));
    document.head.appendChild(s);
  });
}

async function ensureMediaPipeReady() {
  await loadScriptOnce('https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/selfie_segmentation.js');
  await loadScriptOnce('https://cdn.jsdelivr.net/npm/@mediapipe/pose/pose.js');
  if (typeof SelfieSegmentation === 'undefined') throw new Error('SelfieSegmentation is not available (CDN blocked?)');
  if (typeof Pose === 'undefined') throw new Error('Pose is not available (CDN blocked?)');
}

/* ===================== INIT ===================== */

window.addEventListener('load', init);

async function init() {

  try { await ensureMediaPipeReady(); }
  catch (e) { console.error(e); alert('Не удалось загрузить MediaPipe. Проверьте интернет/CDN.'); return; }

  // видео
  video = document.createElement('video');
  video.autoplay = true; video.muted = true; video.playsInline = true;

  canvas = document.getElementById('outputCanvas');
  ctx = canvas.getContext('2d', { alpha: false });

  /* ===================== UI ПОДКЛЮЧЕНИЕ ===================== */
  stageEl = document.getElementById('stage');
  overlayTextEl = document.getElementById('overlayText');

  bgColorBtn = document.getElementById('bgColorBtn');
  bgBlurBtn = document.getElementById('bgBlurBtn');
  bgImageBtn = document.getElementById('bgImageBtn');
  highBtn = document.getElementById('showTextHighBtn');
  mediumBtn = document.getElementById('showTextMediumBtn');
  lowBtn = document.getElementById('showTextBtn');
  hideBtn = document.getElementById('hideTextBtn');
  bgPickerEl = document.getElementById('bgPicker');
  bgGridEl = document.getElementById('bgGrid');
  bgPickerCloseEl = document.getElementById('bgPickerClose');
  const bgUploadBtn = document.getElementById("bgUploadBtn");
  const bgUploadInput = document.getElementById("bgUploadInput");

  if (bgUploadBtn && bgUploadInput) {
    bgUploadBtn.addEventListener("click", () => bgUploadInput.click());
    bgUploadInput.addEventListener("change", onBackgroundUpload);
  }

  // === кнопки фона ===
  bgColorBtn?.addEventListener('click', () => { setBackground('color'); updateActiveBgButtons(); });
  bgBlurBtn?.addEventListener('click', () => { setBackground('blur'); updateActiveBgButtons(); });
  bgImageBtn?.addEventListener('click', openBgPicker);
  bgPickerCloseEl?.addEventListener('click', closeBgPicker);

  // === кнопки приватности ===
  highBtn?.addEventListener('click', () => { setPrivacy('high'); updateActivePrivacyButtons(); });
  mediumBtn?.addEventListener('click', () => { setPrivacy('medium'); updateActivePrivacyButtons(); });
  lowBtn?.addEventListener('click', () => { setPrivacy('low'); updateActivePrivacyButtons(); });
  hideBtn?.addEventListener('click', hideText);

  // фон (устаревшая универсальная логика кликов)
  document.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-bg]');
    if (btn) setBackground(btn.getAttribute('data-bg'));
  });

  // toggle HUD
  window.addEventListener('keydown', (e) => {
    if (e.key.toLowerCase() === 'g') perf.hudOn = !perf.hudOn;
  });

  // камера
  try {
    const stream = await navigator.mediaDevices.getUserMedia({
      video: { width: { ideal: 1280 }, height: { ideal: 720 }, facingMode: 'user' }, audio: false
    });
    video.srcObject = stream; await video.play();
    canvas.width = video.videoWidth; canvas.height = video.videoHeight;
  } catch (err) {
    console.error('❌ Камера недоступна:', err);
    alert('❌ Не удалось получить доступ к камере. Проверьте разрешения.');
    return;
  }

  // даунскейл для Pose
  const detTargetW = 256;
  const aspect = canvas.width / canvas.height || (16 / 9);
  detCanvas = document.createElement('canvas');
  detCanvas.width = detTargetW;
  detCanvas.height = Math.round(detTargetW / aspect);
  detCtx = detCanvas.getContext('2d');

  // маска
  maskCanvas = document.createElement('canvas');
  maskCanvas.width = canvas.width; maskCanvas.height = canvas.height;
  maskCtx = maskCanvas.getContext('2d');

  // оффскрины
  allocOffscreens(canvas.width, canvas.height);

  // === ПОДГРУЗКА ФОНОВ С СЕРВЕРА ===
  try {
    const userId = localStorage.getItem("user_id");
    if (userId) {
      const res = await fetch(`http://127.0.0.1:8000/backgrounds/${userId}`);
      if (res.ok) {
        const data = await res.json();
        fillBackgroundGrid(data.backgrounds);
      } else {
        console.warn("⚠️ Ошибка загрузки фонов:", res.status);
      }
    } else {
      console.warn("⚠️ user_id не найден — пользователь не залогинен");
    }
  } catch (err) {
    console.error("❌ Сервер недоступен:", err);
  }

  // GPU renderer info
  detectGPUInfo();

  // ===== модели =====
  selfieSegmentation = new SelfieSegmentation({
    locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/selfie_segmentation/${file}`,
  });
  selfieSegmentation.setOptions({ modelSelection: 1, selfieMode: true });
  selfieSegmentation.onResults(onSegmentationResults);

  pose = new Pose({ locateFile: (file) => `https://cdn.jsdelivr.net/npm/@mediapipe/pose/${file}` });
  pose.setOptions({
    selfieMode: true,
    modelComplexity: 1,
    smoothLandmarks: true,
    minDetectionConfidence: 0.5,
    minTrackingConfidence: 0.7
  });
  pose.onResults((res) => { latestPose = res; });

  // FPS окно 1 сек.
  setInterval(() => {
    perf.fps = perf.frames; perf.frames = 0;
    perf.cpuLoad = clamp(perf.cpuBusyMs / 1000, 0, 1);
    perf.cpuBusyMs = 0;

    if (performance.memory) {
      perf.heapMB = (performance.memory.usedJSHeapSize / 1048576) | 0;
    }
  }, 1000);

  // Показ данных сотрудника по умолчанию
  setPrivacy('low');
  updateActivePrivacyButtons();

  requestAnimationFrame(processFrame);
}

function setBackground(mode) { backgroundMode = mode; }

function allocOffscreens(w, h) {
  const mk = () => {
    const c = document.createElement('canvas');
    c.width = w; c.height = h;
    return [c, c.getContext('2d')];
  };
  [solidCanvas, solidCtx] = mk();
  [ringCanvas,  ringCtx]  = mk();
  [armLayer,    armCtx]   = mk();
  [palmLayer,   palmCtx]  = mk();
  [fgCanvas,    fgCtx]    = mk();
  bgSmallCanvas = document.createElement('canvas');
  bgSmallCanvas.width  = Math.max(160, (w / 3) | 0);
  bgSmallCanvas.height = Math.max( 90, (h / 3) | 0);
  bgSmallCtx = bgSmallCanvas.getContext('2d');
}

/* ===================== MAIN LOOP ===================== */

async function processFrame(ts) {
  if (video.readyState < HTMLMediaElement.HAVE_ENOUGH_DATA) {
    requestAnimationFrame(processFrame); return;
  }

  if (ts - lastFrameTs < frameBudgetMs - 0.5) {
    requestAnimationFrame(processFrame); return;
  }
  lastFrameTs = ts;

  perf.frameStartTs = performance.now();

  detCtx.drawImage(video, 0, 0, detCanvas.width, detCanvas.height);
  frameNo++;

  try {
    if (frameNo % SEG_EVERY === 0) await selfieSegmentation.send({ image: video });
    if (frameNo % POSE_EVERY === 0) await pose.send({ image: detCanvas });
  } catch (e) {
    console.warn('model err', e);
  }

  const frameEnd = performance.now();
  const frameMs = frameEnd - perf.frameStartTs;
  perf.frameMs = perf.frameMs == null ? frameMs : EMA_A * perf.frameMs + (1 - EMA_A) * frameMs;
  perf.cpuBusyMs += frameMs;
  perf.frames++;

  requestAnimationFrame(processFrame);
}

/* ===================== UI / PRIVACY ===================== */

// ===== EMPLOYEE OVERLAY (fetch + render) =====
async function empFetch(level) {
  const url = `${PRIVACY_BASE}/${level}_privacy.json`;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`Employee JSON HTTP ${res.status}: ${url}`);
  const data = await res.json();
  return data.employee || {};
}

function empRender(emp) {
  if (!overlayTextEl) return;

  const lines = [];
  const push = (v) => {
    if (v == null || v === '') return;
    normalizeMultiline(v).split('\n').forEach(s => lines.push(s));
  };

  push(emp.full_name);
  push(emp.position);
  push(emp.company);
  push(emp.department);
  push(emp.office_location);
  push(emp?.contact?.email ? `✉ ${emp.contact.email}` : '');
  push(emp?.contact?.telegram ? `💬 ${emp.contact.telegram}` : '');
  push(emp?.contact?.phone ? `☎ ${emp.contact.phone}` : '');

  const logoUrl = emp?.branding?.logo_url;
  const slogan  = emp?.branding?.slogan ? normalizeMultiline(emp.branding.slogan) : '';

  if (logoUrl || slogan) {
    overlayTextEl.innerHTML = `
      ${logoUrl ? `<img src="${logoUrl}" alt="logo" style="width:42px;height:42px;object-fit:contain;border-radius:8px;display:block;margin-bottom:6px;">` : ``}
      ${slogan ? `<div style="opacity:.9;font-style:italic;margin-bottom:6px;">${slogan}</div>` : ``}
      <div id="ovlTextBody" style="white-space:pre-line;"></div>
    `;
    const body = document.getElementById('ovlTextBody');
    if (body) body.textContent = lines.join('\n');
  } else {
    overlayTextEl.style.whiteSpace = 'pre-line';
    overlayTextEl.textContent = lines.join('\n');
  }
}

async function empSetPrivacy(level) {
  try {
    const emp = await empFetch(level);
    empRender(emp);
  } catch (err) {
    console.warn('[employee overlay] fetch error:', err);
    overlayTextEl.textContent = `Не удалось загрузить данные (${level}): ${err.message || err}`;
  }
}

function updateActiveBgButtons() {
  bgColorBtn?.classList.toggle('active', backgroundMode === 'color');
  bgBlurBtn?.classList.toggle('active', backgroundMode === 'blur');
  bgImageBtn?.classList.toggle('active', backgroundMode === 'image');
}

function updateActivePrivacyButtons() {
  highBtn?.classList.toggle('active', currentPrivacyLevel === 'high');
  mediumBtn?.classList.toggle('active', currentPrivacyLevel === 'medium');
  lowBtn?.classList.toggle('active', currentPrivacyLevel === 'low');
}

async function openBgPicker() {
  try {
    let userId = auth?.currentUser?.user_id;
    if (!userId) {
      const userStr = localStorage.getItem("user");
      if (userStr) {
        const userObj = JSON.parse(userStr);
        userId = userObj.user_id;
      }
    }

    if (!userId) {
      alert("⚠️ Пользователь не авторизован — невозможно загрузить фоны");
      return;
    }

    bgGridEl.innerHTML = "<p style='padding:10px'>⏳ Загрузка фонов...</p>";

    const res = await fetch(`http://127.0.0.1:8000/backgrounds/${userId}`);
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    if (data?.backgrounds?.length) {
      fillBackgroundGrid(data.backgrounds);
      bgPickerEl.classList.remove('hidden');
    } else {
      bgGridEl.innerHTML = "<p style='padding:10px'>❌ Фоны не найдены</p>";
    }
  } catch (err) {
    console.error("❌ Ошибка при загрузке фонов:", err);
    alert("❌ Не удалось загрузить фоны. Проверьте сервер или интернет.");
  }
}

function closeBgPicker() { bgPickerEl.classList.add('hidden'); }

function selectBackground(url) {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.onload = () => {
    backgroundImage = img;
    backgroundMode = 'image';
    updateActiveBgButtons();
  };
  img.src = url;
  closeBgPicker();
}

// заменено: setPrivacy теперь тянет JSON и обновляет облачко
async function setPrivacy(level) {
  currentPrivacyLevel = level;
  await empSetPrivacy(level);
}

function hideText() {
  currentPrivacyLevel = 'hidden';
  if (overlayTextEl) overlayTextEl.innerHTML = '';
  highBtn?.classList.remove('active');
  mediumBtn?.classList.remove('active');
  lowBtn?.classList.remove('active');
}

/* ===================== ФОНЫ С СЕРВЕРА ===================== */
function fillBackgroundGrid(backgrounds) {
  bgGridEl.innerHTML = '';
  backgrounds.forEach(url => {
    const img = document.createElement('img');
    img.src = `http://127.0.0.1:8000${url}`;
    img.className = 'bg-thumb';
    img.onclick = () => selectBackground(img.src);
    bgGridEl.appendChild(img);
  });
}

async function onBackgroundUpload(event) {
  const file = event.target.files?.[0];
  if (!file) return;

  let userId = auth?.currentUser?.user_id;
  if (!userId) {
    const userStr = localStorage.getItem("user");
    if (userStr) userId = JSON.parse(userStr)?.user_id;
  }
  if (!userId) {
    alert("⚠️ Пользователь не авторизован — невозможно загрузить фон");
    return;
  }

  const bgUploadBtn = document.getElementById("bgUploadBtn");
  bgUploadBtn.disabled = false;
  bgUploadBtn.textContent = "⏳ Загрузка...";

  try {
    const formData = new FormData();
    formData.append("user_id", userId);
    formData.append("file", file);

    const res = await fetch("http://127.0.0.1:8000/upload_background/", {
      method: "POST",
      body: formData,
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();

    if (data?.path) {
      const newImg = document.createElement("img");
      newImg.src = `http://127.0.0.1:8000${data.path}`;
      newImg.className = "bg-thumb";
      newImg.onclick = () => selectBackground(newImg.src);
      bgGridEl.appendChild(newImg);
    }

    alert("✅ Фон успешно добавлен!");
  } catch (err) {
    console.error("❌ Ошибка при загрузке фона:", err);
    alert("❌ Не удалось загрузить фон. Проверь сервер или тип файла.");
  } finally {
    const bgUploadBtn2 = document.getElementById("bgUploadBtn");
    bgUploadBtn2.disabled = false;
    bgUploadBtn2.textContent = "➕ Добавить фон";
    event.target.value = "";
  }
}

/* ===================== RENDER ===================== */

function onSegmentationResults(results) {
  if (!results.segmentationMask || !ctx) return;

  const w = canvas.width, h = canvas.height;
  ctx.clearRect(0, 0, w, h);

  // 1) фон
  if (backgroundMode === 'image' && backgroundImage) {
    ctx.drawImage(backgroundImage, 0, 0, w, h);
  } else if (backgroundMode === 'blur') {
    const bw = Math.max(160, (w / 3) | 0);
    const bh = Math.max( 90, (h / 3) | 0);
    if (bgSmallCanvas.width !== bw || bgSmallCanvas.height !== bh) {
      bgSmallCanvas.width = bw; bgSmallCanvas.height = bh;
      bgSmallCtx = bgSmallCanvas.getContext('2d');
    }
    bgSmallCtx.filter = 'none';
    bgSmallCtx.drawImage(results.image, 0, 0, bw, bh);
    bgSmallCtx.filter = 'blur(6px)';
    bgSmallCtx.drawImage(bgSmallCanvas, 0, 0, bw, bh); // второй прогон
    bgSmallCtx.filter = 'none';
    ctx.drawImage(bgSmallCanvas, 0, 0, bw, bh, 0, 0, w, h);
  } else if (backgroundMode === 'color') {
    ctx.fillStyle = '#101318';
    ctx.fillRect(0, 0, w, h);
  } else {
    ctx.drawImage(results.image, 0, 0, w, h);
  }

  // === 2) БАЗОВАЯ МАСКА С НАРУЖНЫМ СГЛАЖИВАНИЕМ ===
  maskCtx.clearRect(0, 0, w, h);
  solidCtx.clearRect(0, 0, w, h);
  ringCtx.clearRect(0, 0, w, h);

  // копим «жёсткую» маску
  solidCtx.drawImage(results.segmentationMask, 0, 0, w, h);

  // сглаживаем край наружу → итог в maskCanvas
  maskCtx.save();
  maskCtx.filter = `blur(${EDGE_SMOOTH_PX}px)`;
  maskCtx.drawImage(solidCanvas, 0, 0, w, h);
  maskCtx.filter = 'none';
  maskCtx.restore();

  // === 3) HALO REMOVAL: размываем solid → вычитаем «кольцо»
  if (frameNo % HALO_EVERY === 0) {
    ringCtx.clearRect(0, 0, w, h);
    ringCtx.filter = `blur(${HALO_BLUR}px)`;
    ringCtx.drawImage(solidCanvas, 0, 0, w, h);
    ringCtx.filter = 'none';
    ringCtx.globalCompositeOperation = 'destination-out';
    ringCtx.drawImage(solidCanvas, 0, 0, w, h); // blurred - solid => внешнее кольцо
    ringCtx.globalCompositeOperation = 'source-over';
  }

  // вычитаем часть наружного ореола из финальной маски
  maskCtx.save();
  maskCtx.globalCompositeOperation = 'destination-out';
  maskCtx.globalAlpha = HALO_ALPHA;
  maskCtx.drawImage(ringCanvas, 0, 0, w, h);
  maskCtx.restore();
  maskCtx.globalAlpha = 1;
  maskCtx.globalCompositeOperation = 'source-over';

  // 4) РУКИ ТОЛЬКО ПО POSE: коридоры + кисти-эллипсы (с плечевым keep-out)
  if (latestPose?.poseLandmarks?.length) {
    const lms = latestPose.poseLandmarks;

    drawArmCorridorBlurred(maskCtx, lms, w, h);

    const haveLeftPalm  = [IDX.L_WRIST, IDX.L_INDEX, IDX.L_PINKY].every(i => lms[i]?.visibility === undefined || lms[i].visibility > 0.2);
    const haveRightPalm = [IDX.R_WRIST, IDX.R_INDEX, IDX.R_PINKY].every(i => lms[i]?.visibility === undefined || lms[i].visibility > 0.2);

    if (haveLeftPalm)  drawPalmEllipseBlurred(maskCtx, lms, w, h, 'L');
    if (haveRightPalm) drawPalmEllipseBlurred(maskCtx, lms, w, h, 'R');
  }

  // 5) ПРИМЕНЯЕМ МАСКУ К ИСХОДНИКУ (лёгкое внутреннее «перо»)
  fgCtx.clearRect(0, 0, w, h);
  fgCtx.drawImage(results.image, 0, 0, w, h);
  fgCtx.globalCompositeOperation = 'destination-in';
  fgCtx.save();
  fgCtx.filter = `blur(${FEATHER_INNER_PX}px)`; // только внутрь
  fgCtx.drawImage(maskCanvas, 0, 0, w, h);
  fgCtx.filter = 'none';
  fgCtx.restore();
  fgCtx.globalCompositeOperation = 'source-over';

  ctx.drawImage(fgCanvas, 0, 0, w, h);

  // 6) HUD поверх
  if (perf.hudOn) drawPerfHUD(ctx, w, h);
}

/* ===================== ARMS & PALMS ===================== */

function lerp(a, b, t) { return a + (b - a) * t; }

// «сужающаяся капсула» — серия коротких отрезков с плавной толщиной
function taperedSegment(ctx2d, A, B, rA, rB, steps = 18) {
  ctx2d.save();
  ctx2d.strokeStyle = 'white';
  ctx2d.lineCap = 'round';
  ctx2d.lineJoin = 'round';
  for (let i = 0; i < steps; i++) {
    const t0 = i / steps, t1 = (i + 1) / steps;
    const p0 = { x: lerp(A.x, B.x, t0), y: lerp(A.y, B.y, t0) };
    const p1 = { x: lerp(A.x, B.x, t1), y: lerp(A.y, B.y, t1) };
    const r  = lerp(rA, rB, (t0 + t1) * 0.5);
    ctx2d.lineWidth = Math.max(1, r * 2);
    ctx2d.beginPath();
    ctx2d.moveTo(p0.x, p0.y);
    ctx2d.lineTo(p1.x, p1.y);
    ctx2d.stroke();
  }
  ctx2d.restore();
}

// вырезать «буфер» вокруг плеч на указанном canvas
function cutShoulders(layerCtx, L_SH, R_SH, r) {
  if (!SHOULDER_KEEP_OUT_ENABLED) return;
  layerCtx.save();
  layerCtx.globalCompositeOperation = 'destination-out';
  layerCtx.beginPath(); layerCtx.arc(L_SH.x, L_SH.y, r, 0, Math.PI * 2); layerCtx.fill();
  layerCtx.beginPath(); layerCtx.arc(R_SH.x, R_SH.y, r, 0, Math.PI * 2); layerCtx.fill();
  layerCtx.restore();
}

// аккуратный коридор рук ТОЛЬКО по Pose: локоть→запястье, без плеч
function drawArmCorridorBlurred(dstCtx, lms, w, h) {
  armCtx.clearRect(0, 0, w, h);
  const a = armCtx;

  const L_EL = n2px(lms[IDX.L_ELBOW], w, h);
  const R_EL = n2px(lms[IDX.R_ELBOW], w, h);
  const L_WR = n2px(lms[IDX.L_WRIST], w, h);
  const R_WR = n2px(lms[IDX.R_WRIST], w, h);

  const L_SH = n2px(lms[IDX.L_SHOULDER], w, h);
  const R_SH = n2px(lms[IDX.R_SHOULDER], w, h);
  const shoulderW = dist(L_SH, R_SH);
  const Rbase = clamp(Math.round(shoulderW * 0.20), Math.round(w * 0.016), Math.round(w * 0.05));
  const rKeep = Math.round(shoulderW * SHOULDER_KEEPOUT_RADIUS_K);

  // радиусы предплечья (локоть→запястье)
  const r_elbow = Math.round(Rbase * 0.90);
  const r_wrist = Math.round(Rbase * 0.72);

  a.save();
  a.fillStyle = 'white';
  a.strokeStyle = 'white';

  // ЛЕВАЯ/ПРАВАЯ: локоть→кисть
  taperedSegment(a, L_EL, L_WR, r_elbow, r_wrist);
  taperedSegment(a, R_EL, R_WR, r_elbow, r_wrist);

  // круглые «швы»
  const joints = [
    [L_EL, Math.round(r_elbow * 1.02)],
    [R_EL, Math.round(r_elbow * 1.02)],
    [L_WR, Math.round(r_wrist * 1.05)],
    [R_WR, Math.round(r_wrist * 1.05)],
  ];
  for (const [P, r] of joints) { a.beginPath(); a.arc(P.x, P.y, r, 0, Math.PI * 2); a.fill(); }
  a.restore();

  // плечевой keep-out (ничего от Pose рядом с плечами)
  cutShoulders(a, L_SH, R_SH, rKeep);

  // мягкое наложение
  dstCtx.save();
  dstCtx.filter = `blur(${ARM_FEATHER_PX}px)`;
  dstCtx.globalCompositeOperation = 'source-over';
  dstCtx.drawImage(armLayer, 0, 0, w, h);
  dstCtx.filter = 'none';
  dstCtx.restore();
}

// вытянутый эллипс кисти по направлению пальцев (с плечевым keep-out)
function drawPalmEllipseBlurred(dstCtx, lms, w, h, side /* 'L' or 'R' */) {
  const WR = side === 'L' ? IDX.L_WRIST : IDX.R_WRIST;
  const IX = side === 'L' ? IDX.L_INDEX : IDX.R_INDEX;
  const PK = side === 'L' ? IDX.L_PINKY : IDX.R_PINKY;

  const wrist = n2px(lms[WR], w, h);
  const index = n2px(lms[IX], w, h);
  const pinky = n2px(lms[PK], w, h);

  const tip = { x: (index.x + pinky.x) * 0.5, y: (index.y + pinky.y) * 0.5 };
  let vx = tip.x - wrist.x, vy = tip.y - wrist.y;
  const L = Math.hypot(vx, vy) || 1; vx /= L; vy /= L;

  const forward = clamp(L * PALM_FORWARD_K, w * 0.04, w * 0.14);
  const cx = wrist.x + vx * forward;
  const cy = wrist.y + vy * forward;

  const aSemi = clamp(L * 2, w * PALM_A_MIN, w * PALM_A_MAX);
  const bSemi = aSemi * PALM_B_TO_A;
  const angle = Math.atan2(vy, vx);

  palmCtx.clearRect(0, 0, w, h);
  palmCtx.save();
  palmCtx.fillStyle = 'white';
  palmCtx.beginPath();
  palmCtx.ellipse(cx, cy, aSemi, bSemi, angle, 0, Math.PI * 2);
  palmCtx.fill();

  // лёгкая внутренняя обводка
  palmCtx.globalAlpha = 0.9;
  palmCtx.lineWidth = Math.max(2, Math.round(Math.min(aSemi, bSemi) * 0.22));
  palmCtx.strokeStyle = 'white';
  palmCtx.beginPath();
  palmCtx.ellipse(cx, cy, aSemi * PALM_OUTLINE_SCALE, bSemi * PALM_OUTLINE_SCALE, angle, 0, Math.PI * 2);
  palmCtx.stroke();
  palmCtx.restore();

  // плечевой keep-out и для кистей
  if (SHOULDER_KEEP_OUT_ENABLED && SHOULDER_KEEP_OUT_FOR_PALMS) {
    const L_SH = n2px(lms[IDX.L_SHOULDER], w, h);
    const R_SH = n2px(lms[IDX.R_SHOULDER], w, h);
    const rKeep = Math.round(dist(L_SH, R_SH) * SHOULDER_KEEPOUT_RADIUS_K);
    cutShoulders(palmCtx, L_SH, R_SH, rKeep);
  }

  dstCtx.save();
  dstCtx.filter = `blur(${PALM_FEATHER_PX}px)`;
  dstCtx.globalCompositeOperation = 'source-over';
  dstCtx.drawImage(palmLayer, 0, 0, w, h);
  dstCtx.filter = 'none';
  dstCtx.restore();
}

/* ===================== HUD ===================== */

function detectGPUInfo() {
  try {
    const glCanvas = document.createElement('canvas');
    const gl = glCanvas.getContext('webgl') || glCanvas.getContext('experimental-webgl');
    if (!gl) return;
    const dbg = gl.getExtension('WEBGL_debug_renderer_info');
    if (dbg) {
      const vendor = gl.getParameter(dbg.UNMASKED_VENDOR_WEBGL);
      const renderer = gl.getParameter(dbg.UNMASKED_RENDERER_WEBGL);
      perf.gpuRenderer = `${vendor} / ${renderer}`;
    } else {
      perf.gpuRenderer = gl.getParameter(gl.RENDERER) || 'WebGL';
    }
  } catch (_) { }
}

function drawRoundedRect(c, x, y, w, h, r) {
  r = Math.min(r, w / 2, h / 2);
  c.beginPath();
  c.moveTo(x + r, y);
  c.arcTo(x + w, y, x + w, y + h, r);
  c.arcTo(x + w, y + h, x, y + h, r);
  c.arcTo(x, y + h, x, y, r);
  c.arcTo(x, y, x + w, y, r);
  c.closePath();
}

function drawPerfHUD(c, W, H) {
  const pad = 12;
  const boxW = Math.min(320, Math.round(W * 0.36));
  const boxH = 146 + (perf.gpuRenderer ? 16 : 0);
  const x = W - boxW - pad;
  const y = pad;

  c.save();
  c.globalAlpha = 0.95;
  c.fillStyle = 'rgba(0,0,0,0.45)';
  drawRoundedRect(c, x, y, boxW, boxH, 10);
  c.fill();

  c.globalAlpha = 1;
  c.fillStyle = '#fff';
  c.font = '12px system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif';
  c.textBaseline = 'top';

  let ty = y + 10;
  const tx = x + 12;

  const frameMs = perf.frameMs ? perf.frameMs.toFixed(1) : '—';
  c.fillText(`FPS: ${perf.fps}   frame: ${frameMs} ms`, tx, ty); ty += 18;

  const cpuPct = Math.round((perf.cpuLoad || 0) * 100);
  c.fillText(`CPU (main): ${cpuPct}%` + (perf.cores ? ` • cores: ${perf.cores}` : ''), tx, ty); ty += 16;

  if (perf.heapMB != null) { c.fillText(`JS heap: ${perf.heapMB} MB`, tx, ty); ty += 18; }

  if (perf.gpuRenderer) {
    c.fillStyle = 'rgba(255,255,255,0.9)';
    c.fillText(`GPU: ${perf.gpuRenderer}`, tx, ty);
    ty += 18;
  }

  c.fillStyle = 'rgba(255,255,255,0.7)';
  c.fillText('Press G to toggle HUD', tx, ty);

  c.restore();
}

/* ===================== UTILS ===================== */

function clamp(x, a, b) { return Math.max(a, Math.min(b, x)); }

function n2px(lm, w, h) {
  return { x: Math.round(clamp(lm.x, 0, 1) * w), y: Math.round(clamp(lm.y, 0, 1) * h) };
}

function dist(a, b) { const dx = a.x - b.x, dy = a.y - b.y; return Math.hypot(dx, dy); }

// === Новая утилита: заменяем литералы "\r\n" и "\n" на реальные переводы строки
function normalizeMultiline(val) {
  if (val == null) return '';
  return String(val).replace(/\\r\\n/g, '\n').replace(/\\n/g, '\n');
}
