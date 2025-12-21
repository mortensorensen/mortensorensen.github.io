"use strict";

// ═══════════════════════════════════════════════════════════════
// INFINITY MATRIX Ω++ - High Performance Engine
// ═══════════════════════════════════════════════════════════════

// ─────────────────────────
// PERFORMANCE CONFIGURATION
// ─────────────────────────
const PERF = {
  targetFPS: 60,
  particleCount: 800,
  connectionCheckLimit: 50,
  matrixLayers: 2,
  skipFrameThreshold: 30,
  statsUpdateInterval: 500,
  useOffscreenCanvas: true,
  adaptiveQuality: true,
};

// ───────────────
// CONFIGURATION
// ───────────────
const CONFIG = {
  particles: {
    count: PERF.particleCount,
    connectionDistance: 120,
    mouseInfluence: 250,
    baseSpeed: 0.5,
  },
  matrix: {
    columns: 0,
    fontSize: 14,
    characters:
      "アイウエオカキクケコサシスセソタチツテトナニヌネノハヒフヘホマミムメモヤユヨラリルレロワヲン0123456789ABCDEF",
    layers: PERF.matrixLayers,
  },
  audio: {
    fftSize: 1024,
    smoothing: 0.8,
    minDecibels: -90,
    maxDecibels: -10,
  },
  modes: ["CYBER", "COSMIC", "NEURAL", "PLASMA", "VOID"],
  intensities: ["LOW", "MEDIUM", "HIGH", "EXTREME"],
};

// ──────
// STATE
// ──────
const STATE = {
  width: window.innerWidth,
  height: window.innerHeight,
  mouse: { x: window.innerWidth / 2, y: window.innerHeight / 2 },
  time: 0,
  deltaTime: 0,
  lastTime: 0,
  fps: 60,
  fpsSmooth: 60,
  frameCount: 0,
  audioEnabled: false,
  audioData: new Uint8Array(512),
  bassLevel: 0,
  midLevel: 0,
  highLevel: 0,
  overallLevel: 0,
  currentMode: 0,
  currentIntensity: 2,
  isLoading: true,
  lastStatsUpdate: 0,
  qualityScale: 1,
};

// ─────────────────────
// PRECOMPUTED TABLES
// ─────────────────────
const SIN_TABLE = new Float32Array(360);
const COS_TABLE = new Float32Array(360);
for (let i = 0; i < 360; i++) {
  SIN_TABLE[i] = Math.sin((i * Math.PI) / 180);
  COS_TABLE[i] = Math.cos((i * Math.PI) / 180);
}

function fastSin(angle) {
  const idx = (((angle * 57.2958) % 360) + 360) % 360;
  return SIN_TABLE[Math.floor(idx)];
}

function fastCos(angle) {
  const idx = (((angle * 57.2958) % 360) + 360) % 360;
  return COS_TABLE[Math.floor(idx)];
}

// ─────────────
// CANVAS SETUP
// ─────────────
const mainCanvas = document.getElementById("main-canvas");
const uiCanvas = document.getElementById("ui-canvas");
const ctx = mainCanvas.getContext("2d", {
  alpha: false,
  desynchronized: true, // Reduce latency
});
const uiCtx = uiCanvas.getContext("2d");

// Offscreen canvases for caching
let matrixOffscreen, matrixOffCtx;
let scanlineOffscreen, scanlineOffCtx;

function createOffscreenCanvases() {
  if (PERF.useOffscreenCanvas && typeof OffscreenCanvas !== "undefined") {
    matrixOffscreen = new OffscreenCanvas(STATE.width, STATE.height);
    scanlineOffscreen = new OffscreenCanvas(STATE.width, STATE.height);
  } else {
    matrixOffscreen = document.createElement("canvas");
    scanlineOffscreen = document.createElement("canvas");
    matrixOffscreen.width = STATE.width;
    matrixOffscreen.height = STATE.height;
    scanlineOffscreen.width = STATE.width;
    scanlineOffscreen.height = STATE.height;
  }
  matrixOffCtx = matrixOffscreen.getContext("2d");
  scanlineOffCtx = scanlineOffscreen.getContext("2d");

  // Pre-render scanlines (static)
  prerenderScanlines();
}

function prerenderScanlines() {
  scanlineOffCtx.clearRect(0, 0, STATE.width, STATE.height);
  scanlineOffCtx.fillStyle = "rgba(0, 0, 0, 0.03)";
  for (let y = 0; y < STATE.height; y += 3) {
    scanlineOffCtx.fillRect(0, y, STATE.width, 1);
  }
}

function resizeCanvas() {
  STATE.width = window.innerWidth;
  STATE.height = window.innerHeight;

  // Adaptive quality based on screen size
  const pixels = STATE.width * STATE.height;
  if (pixels > 2073600) {
    // > 1080p
    STATE.qualityScale = 0.75;
  } else {
    STATE.qualityScale = 1;
  }

  const scale = STATE.qualityScale;
  const dpr = Math.min(window.devicePixelRatio || 1, 2); // Cap DPR at 2

  [mainCanvas, uiCanvas].forEach((canvas) => {
    canvas.width = STATE.width * dpr * scale;
    canvas.height = STATE.height * dpr * scale;
    canvas.style.width = STATE.width + "px";
    canvas.style.height = STATE.height + "px";
    const context = canvas.getContext("2d");
    context.scale(dpr * scale, dpr * scale);
  });

  CONFIG.matrix.columns = Math.ceil(STATE.width / CONFIG.matrix.fontSize);

  createOffscreenCanvases();
  initMatrixDrops();
  spatialGrid.cellSize = CONFIG.particles.connectionDistance;
}

// ─────────────────────────
// SPATIAL GRID (O(n) lookup)
// ─────────────────────────
class SpatialGrid {
  constructor(cellSize) {
    this.cellSize = cellSize;
    this.grid = new Map();
    this.pool = [];
  }

  clear() {
    this.grid.forEach((arr) => {
      arr.length = 0;
      this.pool.push(arr);
    });
    this.grid.clear();
  }

  getKey(x, y) {
    return (
      (Math.floor(x / this.cellSize) << 16) |
      (Math.floor(y / this.cellSize) & 0xffff)
    );
  }

  insert(idx, x, y) {
    const key = this.getKey(x, y);
    let cell = this.grid.get(key);
    if (!cell) {
      cell = this.pool.pop() || [];
      this.grid.set(key, cell);
    }
    cell.push({ idx, x, y });
  }

  *getNearby(x, y) {
    const cx = Math.floor(x / this.cellSize);
    const cy = Math.floor(y / this.cellSize);

    for (let dx = -1; dx <= 1; dx++) {
      for (let dy = -1; dy <= 1; dy++) {
        const key = ((cx + dx) << 16) | ((cy + dy) & 0xffff);
        const cell = this.grid.get(key);
        if (cell) {
          for (let i = 0; i < cell.length; i++) {
            yield cell[i];
          }
        }
      }
    }
  }
}

const spatialGrid = new SpatialGrid(CONFIG.particles.connectionDistance);

// ─────────────────
// PARTICLE SYSTEM
// ─────────────────

// Use TypedArrays for particle data (better cache performance)
const MAX_PARTICLES = PERF.particleCount;
const particleData = {
  x: new Float32Array(MAX_PARTICLES),
  y: new Float32Array(MAX_PARTICLES),
  z: new Float32Array(MAX_PARTICLES),
  vx: new Float32Array(MAX_PARTICLES),
  vy: new Float32Array(MAX_PARTICLES),
  vz: new Float32Array(MAX_PARTICLES),
  size: new Float32Array(MAX_PARTICLES),
  hue: new Float32Array(MAX_PARTICLES),
  life: new Float32Array(MAX_PARTICLES),
  maxLife: new Float32Array(MAX_PARTICLES),
  age: new Float32Array(MAX_PARTICLES),
};

function resetParticle(i) {
  particleData.x[i] = Math.random() * STATE.width;
  particleData.y[i] = Math.random() * STATE.height;
  particleData.z[i] = Math.random() * 1000;
  particleData.vx[i] = (Math.random() - 0.5) * 2;
  particleData.vy[i] = (Math.random() - 0.5) * 2;
  particleData.vz[i] = (Math.random() - 0.5) * 2;
  particleData.size[i] = Math.random() * 3 + 1;
  particleData.hue[i] = Math.random() * 60 + 160;
  particleData.life[i] = 1;
  particleData.maxLife[i] = Math.random() * 500 + 500;
  particleData.age[i] = 0;
}

function initParticles() {
  for (let i = 0; i < MAX_PARTICLES; i++) {
    resetParticle(i);
  }
}

// Cached screen positions for connection drawing
const screenPos = {
  x: new Float32Array(MAX_PARTICLES),
  y: new Float32Array(MAX_PARTICLES),
  scale: new Float32Array(MAX_PARTICLES),
};

function updateAndDrawParticles(ctx) {
  const intensity = CONFIG.intensities[STATE.currentIntensity];
  const speedMult =
    intensity === "LOW"
      ? 0.5
      : intensity === "MEDIUM"
      ? 1
      : intensity === "HIGH"
      ? 1.5
      : 2;
  const mouseInfluence = CONFIG.particles.mouseInfluence;
  const halfWidth = STATE.width / 2;
  const halfHeight = STATE.height / 2;
  const bassLevel = STATE.bassLevel;
  const midLevel = STATE.midLevel;
  const timeOffset = STATE.time * 20;

  spatialGrid.clear();

  // Update all particles
  for (let i = 0; i < MAX_PARTICLES; i++) {
    let x = particleData.x[i];
    let y = particleData.y[i];
    let vx = particleData.vx[i];
    let vy = particleData.vy[i];

    // Mouse influence
    const dx = STATE.mouse.x - x;
    const dy = STATE.mouse.y - y;
    const distSq = dx * dx + dy * dy;

    if (distSq < mouseInfluence * mouseInfluence) {
      const dist = Math.sqrt(distSq);
      const force =
        (1 - dist / mouseInfluence) * 0.05 * speedMult * (bassLevel + 0.5);
      vx += dx * force;
      vy += dy * force;
    }

    // Audio reactivity (simplified)
    vx += (Math.random() - 0.5) * bassLevel;
    vy += (Math.random() - 0.5) * midLevel;

    // Physics
    vx *= 0.98;
    vy *= 0.98;

    x += vx * speedMult;
    y += vy * speedMult;

    // Wrap boundaries
    if (x < 0) x = STATE.width;
    else if (x > STATE.width) x = 0;
    if (y < 0) y = STATE.height;
    else if (y > STATE.height) y = 0;

    particleData.x[i] = x;
    particleData.y[i] = y;
    particleData.vx[i] = vx;
    particleData.vy[i] = vy;

    // Update life
    particleData.age[i]++;
    particleData.life[i] = 1 - particleData.age[i] / particleData.maxLife[i];
    if (particleData.life[i] <= 0) resetParticle(i);

    // Calculate screen position
    const z = particleData.z[i];
    const scale = 1000 / (1000 + z);
    const sx = (x - halfWidth) * scale + halfWidth;
    const sy = (y - halfHeight) * scale + halfHeight;

    screenPos.x[i] = sx;
    screenPos.y[i] = sy;
    screenPos.scale[i] = scale;

    // Insert into spatial grid
    spatialGrid.insert(i, sx, sy);
  }

  // Draw connections using spatial grid (O(n) instead of O(n²))
  const connDist = CONFIG.particles.connectionDistance;
  const connDistSq = connDist * connDist;

  ctx.strokeStyle = `rgba(0, 245, 255, ${0.15 * (1 + midLevel)})`;
  ctx.lineWidth = 0.5;
  ctx.beginPath();

  const drawnConnections = new Set();

  for (let i = 0; i < MAX_PARTICLES; i++) {
    const sx = screenPos.x[i];
    const sy = screenPos.y[i];
    let connectionCount = 0;

    for (const neighbor of spatialGrid.getNearby(sx, sy)) {
      if (connectionCount >= PERF.connectionCheckLimit) break;

      const j = neighbor.idx;
      if (i >= j) continue;

      const key = (i << 16) | j;
      if (drawnConnections.has(key)) continue;

      const nx = neighbor.x;
      const ny = neighbor.y;
      const dx = sx - nx;
      const dy = sy - ny;
      const distSq = dx * dx + dy * dy;

      if (distSq < connDistSq * screenPos.scale[i]) {
        ctx.moveTo(sx, sy);
        ctx.lineTo(nx, ny);
        drawnConnections.add(key);
        connectionCount++;
      }
    }
  }
  ctx.stroke();

  // Draw particles (batched by similar colors)
  for (let i = 0; i < MAX_PARTICLES; i++) {
    const sx = screenPos.x[i];
    const sy = screenPos.y[i];
    const scale = screenPos.scale[i];
    const size = particleData.size[i] * scale * (1 + bassLevel);
    const alpha = particleData.life[i] * scale * 0.8;
    const hue = (particleData.hue[i] + timeOffset) % 360;

    ctx.beginPath();
    ctx.arc(sx, sy, size, 0, Math.PI * 2);
    ctx.fillStyle = `hsla(${hue | 0}, 100%, 70%, ${alpha.toFixed(2)})`;
    ctx.fill();
  }
}

// ────────────
// MATRIX RAIN
// ────────────
let matrixDrops = [];
const charCache = new Map();

function initMatrixDrops() {
  matrixDrops = [];
  const cols = CONFIG.matrix.columns;
  const chars = CONFIG.matrix.characters;
  const charLen = chars.length;

  for (let layer = 0; layer < CONFIG.matrix.layers; layer++) {
    const layerDrops = new Array(cols);
    for (let i = 0; i < cols; i++) {
      const length = ((Math.random() * 15) | 0) + 8;
      const dropChars = new Array(length);
      for (let j = 0; j < length; j++) {
        dropChars[j] = chars[(Math.random() * charLen) | 0];
      }
      layerDrops[i] = {
        y: Math.random() * STATE.height,
        speed: Math.random() * 3 + 1 + layer * 0.5,
        chars: dropChars,
        opacity: 1 - layer * 0.25,
      };
    }
    matrixDrops.push(layerDrops);
  }
}

function drawMatrix(ctx) {
  const intensity = STATE.currentIntensity;
  const speedMult = [0.3, 0.6, 1, 1.5][intensity];
  const fontSize = CONFIG.matrix.fontSize;
  const audioBoost = 1 + STATE.bassLevel;
  const chars = CONFIG.matrix.characters;
  const charLen = chars.length;
  const hueBase = 160 + STATE.time * 10;
  const overallLevel = STATE.overallLevel;

  ctx.font = `${fontSize}px monospace`;

  for (let layerIndex = 0; layerIndex < matrixDrops.length; layerIndex++) {
    const layer = matrixDrops[layerIndex];
    const layerHue = hueBase + layerIndex * 20;

    for (let i = 0; i < layer.length; i++) {
      const drop = layer[i];
      const x = i * fontSize;

      drop.y += drop.speed * speedMult * audioBoost;

      const dropLen = drop.chars.length;
      if (drop.y > STATE.height + dropLen * fontSize) {
        drop.y = -dropLen * fontSize;
        for (let j = 0; j < dropLen; j++) {
          drop.chars[j] = chars[(Math.random() * charLen) | 0];
        }
      }

      // Draw only visible characters
      const startJ = Math.max(0, Math.floor(-drop.y / fontSize));
      const endJ = Math.min(
        dropLen,
        Math.ceil((STATE.height - drop.y) / fontSize)
      );

      for (let j = startJ; j < endJ; j++) {
        const y = drop.y + j * fontSize;
        const charOpacity = (1 - j / dropLen) * drop.opacity;
        const lightness = j === 0 ? 90 : 50;

        ctx.fillStyle = `hsla(${layerHue | 0}, 100%, ${lightness}%, ${(
          charOpacity *
          (0.3 + overallLevel * 0.5)
        ).toFixed(2)})`;
        ctx.fillText(drop.chars[j], x, y);

        // Random character change frequency
        if (Math.random() < 0.01 * audioBoost) {
          drop.chars[j] = chars[(Math.random() * charLen) | 0];
        }
      }
    }
  }
}

// ───────────────
// NEURAL NETWORK
// ───────────────
const neuralNodes = [];
const neuralConnections = [];

function initNeuralNetwork() {
  neuralNodes.length = 0;
  neuralConnections.length = 0;

  const layers = 4;
  const nodesPerLayer = 6;
  const layerWidth = STATE.width / (layers + 1);
  const layerHeight = STATE.height / (nodesPerLayer + 1);

  for (let l = 0; l < layers; l++) {
    for (let n = 0; n < nodesPerLayer; n++) {
      neuralNodes.push({
        x: layerWidth * (l + 1) + (Math.random() - 0.5) * 50,
        y: layerHeight * (n + 1) + (Math.random() - 0.5) * 50,
        layer: l,
        activation: 0,
        pulsePhase: Math.random() * 6.28,
      });
    }
  }

  // Create connections
  const nodeCount = neuralNodes.length;
  for (let i = 0; i < nodeCount; i++) {
    const node = neuralNodes[i];
    for (let j = i + 1; j < nodeCount; j++) {
      const other = neuralNodes[j];
      if (other.layer === node.layer + 1 && Math.random() < 0.4) {
        neuralConnections.push({ from: i, to: j, weight: Math.random() });
      }
    }
  }
}

function drawNeuralNetwork(ctx) {
  const time = STATE.time;
  const bassLevel = STATE.bassLevel;
  const audioData = STATE.audioData;
  const audioLen = audioData.length;

  // Update activations
  for (let i = 0; i < neuralNodes.length; i++) {
    const node = neuralNodes[i];
    const target =
      audioData[(Math.random() * audioLen) | 0] / 255 ||
      fastSin(time * 2 + node.pulsePhase) * 0.5 + 0.5;
    node.activation += (target - node.activation) * 0.1;
  }

  // Draw connections (batched)
  ctx.lineWidth = 1 + bassLevel;
  ctx.beginPath();

  for (let i = 0; i < neuralConnections.length; i++) {
    const conn = neuralConnections[i];
    const from = neuralNodes[conn.from];
    const to = neuralNodes[conn.to];

    ctx.moveTo(from.x, from.y);
    ctx.lineTo(to.x, to.y);
  }

  ctx.strokeStyle = `rgba(0, 245, 255, ${0.2 + STATE.midLevel * 0.3})`;
  ctx.stroke();

  // Draw signal pulses
  for (let i = 0; i < neuralConnections.length; i++) {
    const conn = neuralConnections[i];
    const from = neuralNodes[conn.from];
    const to = neuralNodes[conn.to];
    const activation = (from.activation + to.activation) / 2;

    const pulsePos = (time * 0.5 + conn.weight) % 1;
    const pulseX = from.x + (to.x - from.x) * pulsePos;
    const pulseY = from.y + (to.y - from.y) * pulsePos;

    ctx.beginPath();
    ctx.arc(pulseX, pulseY, 2 + STATE.midLevel * 2, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(255, 255, 255, ${activation * 0.7})`;
    ctx.fill();
  }

  // Draw nodes
  for (let i = 0; i < neuralNodes.length; i++) {
    const node = neuralNodes[i];
    const size = 3 + node.activation * 6 + bassLevel * 3;

    ctx.beginPath();
    ctx.arc(node.x, node.y, size, 0, Math.PI * 2);
    ctx.fillStyle = `rgba(0, 245, 255, ${node.activation * 0.8})`;
    ctx.fill();
  }
}

// ──────────
// WAVEFORM
// ──────────
function drawWaveform(ctx) {
  const centerY = STATE.height / 2;
  const amplitude = 80 + STATE.bassLevel * 100;
  const time = STATE.time;
  const audioData = STATE.audioData;
  const audioLen = audioData.length;
  const width = STATE.width;
  const step = 4;

  ctx.beginPath();
  ctx.moveTo(0, centerY);

  for (let x = 0; x < width; x += step) {
    const audioIndex = ((x / width) * audioLen) | 0;
    const audioValue = audioData[audioIndex] / 255 || 0;

    const y =
      centerY +
      fastSin(x * 0.01 + time * 2) * amplitude * 0.3 +
      fastSin(x * 0.02 + time * 3) * amplitude * 0.2 +
      audioValue * amplitude * 0.4;

    ctx.lineTo(x, y);
  }

  ctx.strokeStyle = `rgba(0, 245, 255, 0.6)`;
  ctx.lineWidth = 2 + STATE.overallLevel * 2;
  ctx.stroke();
}

// ────────────────
// SACRED GEOMETRY
// ────────────────
function drawSacredGeometry(ctx) {
  const cx = STATE.width / 2;
  const cy = STATE.height / 2;
  const maxRadius = Math.min(STATE.width, STATE.height) * 0.3;
  const time = STATE.time;
  const bassLevel = STATE.bassLevel;

  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(time * 0.1);

  const radius = maxRadius * 0.18 * (1 + bassLevel * 0.3);
  const hue = 180 + time * 20;

  ctx.strokeStyle = `hsla(${hue | 0}, 100%, 60%, ${
    0.25 + STATE.midLevel * 0.3
  })`;
  ctx.lineWidth = 1;
  ctx.beginPath();

  // Flower pattern
  for (let ring = 0; ring < 2; ring++) {
    const ringRadius = radius * ring;
    const ringCircles = ring === 0 ? 1 : 6;

    for (let i = 0; i < ringCircles; i++) {
      const angle =
        (i / ringCircles) * Math.PI * 2 + time * (0.1 + ring * 0.05);
      const x = fastCos(angle) * ringRadius;
      const y = fastSin(angle) * ringRadius;

      ctx.moveTo(x + radius, y);
      ctx.arc(x, y, radius, 0, Math.PI * 2);
    }
  }
  ctx.stroke();

  ctx.restore();
}

// ───────────
// AUDIO BARS
// ───────────
function drawAudioBars(ctx) {
  if (!STATE.audioEnabled) return;

  const barCount = 32;
  const barWidth = STATE.width / barCount;
  const maxHeight = STATE.height * 0.25;
  const audioData = STATE.audioData;
  const audioLen = audioData.length;
  const time = STATE.time;
  const height = STATE.height;

  for (let i = 0; i < barCount; i++) {
    const audioIndex = ((i / barCount) * audioLen) | 0;
    const value = audioData[audioIndex] / 255;
    const barHeight = value * maxHeight;

    if (barHeight < 2) continue;

    const x = i * barWidth;
    const hue = 180 + i * 2 + time * 20;

    ctx.fillStyle = `hsla(${hue | 0}, 100%, 50%, 0.6)`;
    ctx.fillRect(x, height - barHeight, barWidth - 1, barHeight);
  }
}

// ───────────────
// GLITCH EFFECT
// ───────────────
let lastGlitchTime = 0;

function applyGlitchEffect(ctx) {
  const now = STATE.time;
  if (now - lastGlitchTime < 0.5) return;

  if (Math.random() > 0.98 || STATE.bassLevel > 0.85) {
    lastGlitchTime = now;
    const sliceHeight = Math.random() * 30 + 10;
    const y = (Math.random() * STATE.height) | 0;
    const offset = ((Math.random() - 0.5) * 30 * STATE.bassLevel) | 0;

    const imageData = ctx.getImageData(0, y, STATE.width, sliceHeight);
    ctx.putImageData(imageData, offset, y);
  }
}

// ────────────────────
// STATIC SCANLINES
// ────────────────────
function drawScanlines(ctx) {
  // Use pre-rendered scanlines
  ctx.drawImage(scanlineOffscreen, 0, 0);

  // Vignette (pre-calculate and cache this)
  ctx.fillStyle = vignetteGradient;
  ctx.fillRect(0, 0, STATE.width, STATE.height);
}

let vignetteGradient;

function createVignetteGradient() {
  vignetteGradient = ctx.createRadialGradient(
    STATE.width / 2,
    STATE.height / 2,
    STATE.height * 0.3,
    STATE.width / 2,
    STATE.height / 2,
    STATE.height * 0.8
  );
  vignetteGradient.addColorStop(0, "rgba(0, 0, 0, 0)");
  vignetteGradient.addColorStop(1, "rgba(0, 0, 0, 0.4)");
}

// ─────────────────
// MAIN RENDER LOOP
// ─────────────────
function render(timestamp) {
  STATE.deltaTime = (timestamp - STATE.lastTime) / 1000;
  STATE.lastTime = timestamp;
  STATE.time += STATE.deltaTime;
  STATE.frameCount++;

  // Smooth FPS calculation
  const instantFPS = 1 / STATE.deltaTime;
  STATE.fpsSmooth = STATE.fpsSmooth * 0.9 + instantFPS * 0.1;
  STATE.fps = STATE.fpsSmooth | 0;

  // Adaptive quality
  if (PERF.adaptiveQuality && STATE.frameCount % 60 === 0) {
    if (STATE.fps < 25 && CONFIG.particles.count > 200) {
      CONFIG.particles.count = Math.max(200, CONFIG.particles.count - 100);
    } else if (STATE.fps > 55 && CONFIG.particles.count < PERF.particleCount) {
      CONFIG.particles.count = Math.min(
        PERF.particleCount,
        CONFIG.particles.count + 50
      );
    }
  }

  // Clear with optimized fade
  ctx.fillStyle =
    STATE.fps < PERF.skipFrameThreshold
      ? "rgba(0, 0, 0, 0.2)"
      : `rgba(0, 0, 0, ${0.08 + STATE.overallLevel * 0.08})`;
  ctx.fillRect(0, 0, STATE.width, STATE.height);

  // Draw based on mode
  const mode = CONFIG.modes[STATE.currentMode];
  const lowFPS = STATE.fps < PERF.skipFrameThreshold;

  drawMatrix(ctx);

  // Apply effects (scanlines are pre-rendered)
  drawScanlines(ctx);

  requestAnimationFrame(render);
}

// ──────────────
// CUSTOM CURSOR
// ──────────────
const cursor = document.getElementById("cursor");
const cursorDot = document.getElementById("cursor-dot");
let cursorX = 0,
  cursorY = 0;
let targetX = 0,
  targetY = 0;

window.addEventListener("resize", () => {
  resizeCanvas();
  initNeuralNetwork();
  createVignetteGradient();
});

// ────────────────
// INITIALIZATION
// ────────────────
function init() {
  resizeCanvas();
  createVignetteGradient();
  initParticles();
  initMatrixDrops();
  initNeuralNetwork();
  // updateCursor();

  setTimeout(() => {
    document.getElementById("loading").classList.add("hidden");
    STATE.isLoading = false;
    requestAnimationFrame(render);
  }, 1500);
}

init();
