/* =========================================================
   EcoScan IA — Clasificador de residuos (Teachable Machine)
   ========================================================= */

// Modelo oficial (organic, recyclable, non-recyclable)
const MODEL_URL = "https://teachablemachine.withgoogle.com/models/AG8xg8V-G/";
const PREDICT_SIZE = 224; // tamaño cuadrado que espera el modelo

// Textos y colores legibles por clase
const CLASS_INFO = {
  "organic": {
    label: "🌱 Orgánico aprovechable",
    desc: "Se traslada a plantas de compostaje biológico.",
    tone: "organic"
  },
  "recyclable": {
    label: "💧 Material reciclable",
    desc: "Prioridad de clasificación: PET, PEAD y PP.",
    tone: "recyclable"
  },
  "non-recyclable": {
    label: "🗑️ No aprovechable",
    desc: "Va directo a disposición final (relleno sanitario).",
    tone: "non-recyclable"
  }
};

// ---------- Referencias del DOM ----------
const els = {
  startBtn: document.getElementById("start-btn"),
  switchBtn: document.getElementById("switch-btn"),
  captureBtn: document.getElementById("capture-btn"),
  video: document.getElementById("video"),
  viewfinder: document.getElementById("viewfinder"),
  cameraBadge: document.getElementById("camera-badge"),
  screen: document.getElementById("screen"),
  statusTitle: document.getElementById("status-title"),
  statusResult: document.getElementById("status-result"),
  statusDesc: document.getElementById("status-desc"),
  labelContainer: document.getElementById("label-container"),
  errorMsg: document.getElementById("error-msg"),
  captureCanvas: document.getElementById("capture-canvas"),
  photoModal: document.getElementById("photo-modal"),
  photoPreview: document.getElementById("photo-preview"),
  photoResultLabel: document.getElementById("photo-result-label"),
  photoResultValue: document.getElementById("photo-result-value"),
  retakeBtn: document.getElementById("retake-btn"),
  downloadBtn: document.getElementById("download-btn"),
};

// ---------- Estado ----------
let model = null;
let maxPredictions = 0;
let stream = null;
let currentFacing = "user";
let availableCameraCount = 1;
let running = false;
let loopHandle = null;
let lastPrediction = null;

// Canvas oculto de trabajo para las predicciones (cuadrado, tamaño fijo)
const predictCanvas = document.createElement("canvas");
predictCanvas.width = PREDICT_SIZE;
predictCanvas.height = PREDICT_SIZE;
const predictCtx = predictCanvas.getContext("2d");

// =========================================================
// Utilidades
// =========================================================

function showError(message) {
  els.errorMsg.textContent = message;
  els.errorMsg.hidden = false;
}

function clearError() {
  els.errorMsg.hidden = true;
  els.errorMsg.textContent = "";
}

function isLikelyMobile() {
  return /Android|iPhone|iPad|iPod|Mobile/i.test(navigator.userAgent);
}

// Detecta cuántas cámaras hay disponibles para decidir el modo por defecto:
// una sola cámara (PC / laptop) -> frontal | varias cámaras (celular) -> trasera
async function detectPreferredFacing() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    const cams = devices.filter((d) => d.kind === "videoinput");
    availableCameraCount = cams.length || 1;
  } catch (err) {
    availableCameraCount = 1;
  }

  if (availableCameraCount > 1 || isLikelyMobile()) {
    return "environment";
  }
  return "user";
}

// Calcula un recorte tipo "cover" para que el frame encaje limpio en el canvas.
function computeCoverRect(sourceWidth, sourceHeight, targetWidth, targetHeight) {
  const sourceRatio = sourceWidth / sourceHeight;
  const targetRatio = targetWidth / targetHeight;

  let drawWidth = targetWidth;
  let drawHeight = targetHeight;
  let offsetX = 0;
  let offsetY = 0;

  if (sourceRatio > targetRatio) {
    drawHeight = targetHeight;
    drawWidth = targetHeight * sourceRatio;
    offsetX = -(drawWidth - targetWidth) / 2;
  } else {
    drawWidth = targetWidth;
    drawHeight = targetWidth / sourceRatio;
    offsetY = -(drawHeight - targetHeight) / 2;
  }

  return { drawWidth, drawHeight, offsetX, offsetY };
}

function drawVideoToCanvas(ctx, targetWidth, targetHeight, videoEl, options = {}) {
  const vw = videoEl.videoWidth;
  const vh = videoEl.videoHeight;
  if (!vw || !vh) return false;

  const { mirror = false } = options;
  const rect = computeCoverRect(vw, vh, targetWidth, targetHeight);

  ctx.save();
  ctx.clearRect(0, 0, targetWidth, targetHeight);
  ctx.imageSmoothingEnabled = true;

  if (mirror) {
    ctx.translate(targetWidth, 0);
    ctx.scale(-1, 1);
  }

  ctx.drawImage(videoEl, 0, 0, vw, vh, rect.offsetX, rect.offsetY, rect.drawWidth, rect.drawHeight);
  ctx.restore();
  return true;
}

// =========================================================
// Carga del modelo
// =========================================================

async function loadModel() {
  if (model) return model;
  model = await tmImage.load(MODEL_URL + "model.json", MODEL_URL + "metadata.json");
  maxPredictions = model.getTotalClasses();
  buildPredictionRows();
  return model;
}

function buildPredictionRows() {
  els.labelContainer.innerHTML = "";
  for (let i = 0; i < maxPredictions; i++) {
    const row = document.createElement("div");
    row.className = "pred-row";
    row.id = `pred-row-${i}`;
    row.innerHTML = `
      <div class="pred-label">
        <span id="pred-text-${i}">—</span>
        <span class="pred-value" id="pred-value-${i}">0%</span>
      </div>
      <div class="pred-bar"><div class="pred-bar-fill" id="pred-bar-${i}"></div></div>
    `;
    els.labelContainer.appendChild(row);
  }
}

// =========================================================
// Cámara
// =========================================================

async function startCamera(preferredFacing) {
  stopStreamTracks();

  const constraintsList = [
    { video: { facingMode: { ideal: preferredFacing }, width: { ideal: 640 }, height: { ideal: 640 } }, audio: false },
    { video: { facingMode: preferredFacing }, audio: false },
    { video: true, audio: false }, // último recurso
  ];

  let lastError = null;
  for (const constraints of constraintsList) {
    try {
      stream = await navigator.mediaDevices.getUserMedia(constraints);
      currentFacing = preferredFacing;
      attachStream();
      clearError();
      return;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error("No se pudo acceder a la cámara.");
}

function attachStream() {
  els.video.srcObject = stream;
  els.video.classList.toggle("mirrored", currentFacing === "user");
  els.cameraBadge.textContent = currentFacing === "user" ? "Cámara frontal" : "Cámara trasera";
  els.cameraBadge.hidden = false;
}

function stopStreamTracks() {
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
}

async function refreshCameraCount() {
  try {
    const devices = await navigator.mediaDevices.enumerateDevices();
    availableCameraCount = devices.filter((d) => d.kind === "videoinput").length || 1;
  } catch (err) {
    /* se mantiene el valor previo */
  }
  els.switchBtn.hidden = availableCameraCount <= 1;
}

// =========================================================
// Escaneo / predicción
// =========================================================

async function predictLoop() {
  if (!running) return;

  drawVideoToCanvas(predictCtx, PREDICT_SIZE, PREDICT_SIZE, els.video);

  try {
    const prediction = await model.predict(predictCanvas);
    updatePredictionUI(prediction);
  } catch (err) {
    /* si un frame falla, se sigue con el siguiente */
  }

  loopHandle = requestAnimationFrame(predictLoop);
}

function updatePredictionUI(prediction) {
  let top = { className: "", probability: 0 };

  prediction.forEach((p, i) => {
    const pct = Math.round(p.probability * 100);
    const key = p.className.trim().toLowerCase();
    const info = CLASS_INFO[key];
    const readableName = info ? info.label : p.className;

    const row = document.getElementById(`pred-row-${i}`);
    if (row) {
      row.dataset.class = key;
      document.getElementById(`pred-text-${i}`).textContent = readableName;
      document.getElementById(`pred-value-${i}`).textContent = `${pct}%`;
      document.getElementById(`pred-bar-${i}`).style.width = `${pct}%`;
    }

    if (p.probability > top.probability) top = p;
  });

  if (top.probability > 0.65) {
    const key = top.className.trim().toLowerCase();
    lastPrediction = { key, probability: top.probability };
    updateBigScreen(key);
  }
}

function updateBigScreen(key) {
  const info = CLASS_INFO[key];
  if (!info) return;

  els.screen.dataset.tone = info.tone;
  els.statusTitle.textContent = "Escaneo IA en tiempo real";
  els.statusResult.textContent = info.label;
  els.statusDesc.textContent = info.desc;
}

// =========================================================
// Captura de foto
// =========================================================

function capturePhoto() {
  const vw = els.video.videoWidth;
  const vh = els.video.videoHeight;
  if (!vw || !vh) return;

  els.captureCanvas.width = vw;
  els.captureCanvas.height = vh;
  const ctx = els.captureCanvas.getContext("2d");

  const didDraw = drawVideoToCanvas(ctx, vw, vh, els.video, {
    mirror: currentFacing === "user"
  });

  if (!didDraw) return;

  const dataUrl = els.captureCanvas.toDataURL("image/png");
  els.photoPreview.src = dataUrl;

  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  els.downloadBtn.href = dataUrl;
  els.downloadBtn.download = `ecoscan-residuo-${stamp}.png`;

  if (lastPrediction && CLASS_INFO[lastPrediction.key]) {
    const info = CLASS_INFO[lastPrediction.key];
    els.photoResultLabel.textContent = "Resultado del escaneo";
    els.photoResultValue.textContent = `${info.label} · ${Math.round(lastPrediction.probability * 100)}%`;
  } else {
    els.photoResultLabel.textContent = "Resultado del escaneo";
    els.photoResultValue.textContent = "Sin clasificar todavía";
  }

  els.photoModal.hidden = false;
}

// =========================================================
// Control principal (iniciar / detener)
// =========================================================

async function handleStart() {
  els.startBtn.disabled = true;
  els.startBtn.textContent = "Cargando cerebro IA…";
  clearError();

  try {
    await loadModel();
    const preferred = await detectPreferredFacing();
    await startCamera(preferred);
    await refreshCameraCount();

    running = true;
    els.viewfinder.dataset.active = "true";
    els.captureBtn.hidden = false;
    els.startBtn.textContent = "Detener escáner";
    els.startBtn.disabled = false;

    els.statusTitle.textContent = "Escaneo IA en tiempo real";
    els.statusResult.textContent = "Analizando…";
    els.statusDesc.textContent = "Muestra el residuo frente a la cámara.";

    predictLoop();
  } catch (err) {
    console.error(err);
    showError("No se pudo acceder a la cámara. Revisa los permisos del navegador e inténtalo de nuevo.");
    els.startBtn.textContent = "Reintentar escáner";
    els.startBtn.disabled = false;
  }
}

function handleStop() {
  running = false;
  if (loopHandle) cancelAnimationFrame(loopHandle);
  stopStreamTracks();

  els.viewfinder.dataset.active = "false";
  els.cameraBadge.hidden = true;
  els.captureBtn.hidden = true;
  els.switchBtn.hidden = true;
  els.startBtn.textContent = "Iniciar escáner";

  els.screen.removeAttribute("data-tone");
  els.statusTitle.textContent = "Estado del sensor";
  els.statusResult.textContent = "Cámara detenida";
  els.statusDesc.textContent = "Presiona «Iniciar escáner» para comenzar el análisis.";
}

async function handleSwitchCamera() {
  const next = currentFacing === "user" ? "environment" : "user";
  els.switchBtn.disabled = true;
  try {
    await startCamera(next);
  } catch (err) {
    showError("No se pudo cambiar de cámara en este dispositivo.");
  } finally {
    els.switchBtn.disabled = false;
  }
}

// =========================================================
// Eventos
// =========================================================

els.startBtn.addEventListener("click", () => {
  if (running) {
    handleStop();
  } else {
    handleStart();
  }
});

els.switchBtn.addEventListener("click", handleSwitchCamera);
els.captureBtn.addEventListener("click", capturePhoto);

els.retakeBtn.addEventListener("click", () => {
  els.photoModal.hidden = true;
});

document.addEventListener("visibilitychange", () => {
  // Libera la cámara si el usuario cambia de pestaña por mucho tiempo no es
  // necesario, pero si cierra/recarga sí conviene apagarla.
});

window.addEventListener("beforeunload", stopStreamTracks);
