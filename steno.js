import { Muxer, ArrayBufferTarget } from 'https://cdn.jsdelivr.net/npm/mp4-muxer@5/+esm';

const W = 854;
const H = 480;
const FPS = 24;                    // ← 24 вместо 30 — экономия ~20%
const BITRATE = 1_400_000;         // чуть ниже — лучше сжимается
const SBS = 32;
const Q = 112;                     // чуть агрессивнее — меньше заметно
const REDUNDANCY = 2;
const MIN_FRAMES = 30;
const MAX_SAFE_FRAMES = 4800;      // ~3.3 минуты при 24 fps — разумный предел
const KEYFRAME_EVERY = 72;         // ~3 секунды

const MAGIC = new Uint8Array([0x53, 0x57, 0x4D, 0x50]);
const FORMAT_VERSION = 4;
const XOR_KEY = new Uint8Array([0x53,0x48,0x52,0x45,0x4B,0x21,0x4F,0x47,0x52,0x45,0x53,0x57,0x41,0x4D,0x50,0x21]);

const SCOLS = W / SBS | 0;
const SROWS = H / SBS | 0;
const BPF = SCOLS * SROWS;
const EFFECTIVE_BPF = (BPF / REDUNDANCY) | 0;
const EFFECTIVE_BYTES_PER_FRAME = EFFECTIVE_BPF >> 3;

export const CONFIG = {
  W, H, FPS, BITRATE, SBS, Q, REDUNDANCY, MIN_FRAMES,
  KEYFRAME_EVERY, MAX_SAFE_FRAMES,
  SCOLS, SROWS, BPF, EFFECTIVE_BPF, EFFECTIVE_BYTES_PER_FRAME, FORMAT_VERSION
};

// ──────────────────────────────────────── CRC ────────────────────────────────────────
const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) {
    c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  }
  CRC_TABLE[i] = c;
}

export function crc32(data) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
  }
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

// ──────────────────────────────────────── QIM ────────────────────────────────────────
function qimEmbed(val, bit) {
  const half = Q >> 1;
  const t = bit === 0
    ? Math.round(val / Q) * Q
    : Math.round((val - half) / Q) * Q + half;
  return Math.max(0, Math.min(255, t | 0));
}

function qimExtract(val) {
  const half = Q >> 1;
  const d0 = Math.abs(val - Math.round(val / Q) * Q);
  const d1 = Math.abs(val - Math.round((val - half) / Q) * Q - half + Q);
  return d0 <= d1 ? 0 : 1;
}

// ──────────────────────────────────────── Interleave ────────────────────────────────────────
let interleaveCache = null;
let interleaveCacheSize = 0;

function getInterleaveMap(bitCount) {
  if (interleaveCache && interleaveCacheSize === bitCount) return interleaveCache;
  const map = new Uint32Array(bitCount);
  map.set(Array.from({length: bitCount}, (_,i)=>i));
  let seed = 0x5F3759DF;
  for (let i = bitCount - 1; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF;
    const j = seed % (i + 1);
    [map[i], map[j]] = [map[j], map[i]];
  }
  interleaveCache = map;
  interleaveCacheSize = bitCount;
  return map;
}

// ──────────────────────────────────────── Embed / Extract ────────────────────────────────────────
export function embedFrame(imgData, slice) {
  const d = imgData.data;
  const totalBits = BPF;
  const map = getInterleaveMap(totalBits);

  const dataBits = new Uint8Array(EFFECTIVE_BPF);
  if (slice) {
    for (let i = 0; i < EFFECTIVE_BPF; i++) {
      const byteIdx = i >> 3;
      const bitPos = 7 - (i & 7);
      dataBits[i] = byteIdx < slice.length ? (slice[byteIdx] >> bitPos) & 1 : 0;
    }
  }

  const bits = new Uint8Array(totalBits);
  let pos = 0;
  for (let i = 0; i < EFFECTIVE_BPF; i++) {
    const b = dataBits[i];
    bits[pos++] = b;
    bits[pos++] = b;
  }

  const shuffled = new Uint8Array(totalBits);
  for (let i = 0; i < totalBits; i++) {
    shuffled[map[i]] = bits[i];
  }

  let bitIdx = 0;
  for (let row = 0; row < SROWS; row++) {
    const y0 = row * SBS;
    for (let col = 0; col < SCOLS; col++) {
      const x0 = col * SBS;
      const bit = shuffled[bitIdx++];

      let sum = 0;
      for (let dy = 0; dy < SBS; dy++) {
        const y = y0 + dy;
        let off = (y * W + x0) << 2;
        for (let dx = 0; dx < SBS; dx++, off += 4) {
          sum += 0.299 * d[off] + 0.587 * d[off+1] + 0.114 * d[off+2];
        }
      }
      const avg = sum / (SBS * SBS);
      const target = qimEmbed(avg, bit);
      const delta = (target - avg) | 0;

      for (let dy = 0; dy < SBS; dy++) {
        const y = y0 + dy;
        let off = (y * W + x0) << 2;
        for (let dx = 0; dx < SBS; dx++, off += 4) {
          d[off  ] = Math.max(0, Math.min(255, d[off  ] + delta));
          d[off+1] = Math.max(0, Math.min(255, d[off+1] + delta));
          d[off+2] = Math.max(0, Math.min(255, d[off+2] + delta));
        }
      }
    }
  }
}

export function extractFrame(imgData) {
  const d = imgData.data;
  const totalBits = BPF;
  const map = getInterleaveMap(totalBits);

  const raw = new Uint8Array(totalBits);
  let idx = 0;

  for (let row = 0; row < SROWS; row++) {
    const y0 = row * SBS;
    for (let col = 0; col < SCOLS; col++) {
      const x0 = col * SBS;
      let sum = 0;
      for (let dy = 0; dy < SBS; dy++) {
        let off = ((y0 + dy) * W + x0) << 2;
        for (let dx = 0; dx < SBS; dx++, off += 4) {
          sum += 0.299 * d[off] + 0.587 * d[off+1] + 0.114 * d[off+2];
        }
      }
      raw[idx++] = qimExtract(sum / (SBS * SBS));
    }
  }

  const deint = new Uint8Array(totalBits);
  for (let i = 0; i < totalBits; i++) {
    deint[i] = raw[map[i]];
  }

  const bytes = new Uint8Array(EFFECTIVE_BYTES_PER_FRAME);
  for (let i = 0; i < EFFECTIVE_BPF; i++) {
    let votes = deint[i*2] + deint[i*2 + 1];
    if (votes >= 2) {  // REDUNDANCY=2 → majority = 2
      bytes[i >> 3] |= 1 << (7 - (i & 7));
    }
  }
  return bytes;
}

// ──────────────────────────────────────── Payload & Utils ────────────────────────────────────────
function obfuscateHeader(json) {
  const bytes = new TextEncoder().encode(json);
  const out = new Uint8Array(bytes.length);
  for (let i = 0; i < bytes.length; i++) {
    out[i] = bytes[i] ^ XOR_KEY[i % XOR_KEY.length];
  }
  return out;
}

function deobfuscateHeader(scrambled) {
  const bytes = new Uint8Array(scrambled.length);
  for (let i = 0; i < scrambled.length; i++) {
    bytes[i] = scrambled[i] ^ XOR_KEY[i % XOR_KEY.length];
  }
  return new TextDecoder().decode(bytes);
}

class PayloadBuilder {
  constructor(headerJson, fileData) {
    const header = obfuscateHeader(headerJson);
    const crc = crc32(header);
    const hlen = header.length;
    const prefixLen = 4 + 1 + 4 + hlen + 4;

    this.prefix = new Uint8Array(prefixLen);
    let p = 0;
    this.prefix.set(MAGIC, p); p += 4;
    this.prefix[p++] = FORMAT_VERSION;
    this.prefix[p++] = (hlen >> 24) & 255;
    this.prefix[p++] = (hlen >> 16) & 255;
    this.prefix[p++] = (hlen >> 8)  & 255;
    this.prefix[p++] = hlen & 255;
    this.prefix.set(header, p); p += hlen;
    this.prefix[p++] = (crc >> 24) & 255;
    this.prefix[p++] = (crc >> 16) & 255;
    this.prefix[p++] = (crc >> 8)  & 255;
    this.prefix[p  ] = crc & 255;

    this.fileData = fileData;
    this.prefixLen = prefixLen;
    this.totalLength = prefixLen + fileData.length;
  }

  getSlice(frameIdx) {
    const bpf = EFFECTIVE_BYTES_PER_FRAME;
    const start = frameIdx * bpf;
    const end = Math.min(start + bpf, this.totalLength);
    if (start >= this.totalLength) return null;

    if (end <= this.prefixLen) {
      return this.prefix.subarray(start, end);
    }
    if (start >= this.prefixLen) {
      return this.fileData.subarray(start - this.prefixLen, end - this.prefixLen);
    }

    const buf = new Uint8Array(end - start);
    const prefixPart = this.prefixLen - start;
    buf.set(this.prefix.subarray(start, this.prefixLen));
    buf.set(this.fileData.subarray(0, end - this.prefixLen), prefixPart);
    return buf;
  }
}

export function fmtSize(bytes) {
  if (bytes < 1024) return bytes + ' B';
  if (bytes < 1048576) return (bytes/1024).toFixed(1)+' KB';
  if (bytes < 1073741824) return (bytes/1048576).toFixed(2)+' MB';
  return (bytes/1073741824).toFixed(2)+' GB';
}

export function fmtTime(s) {
  if (s < 60) return Math.round(s)+'s';
  const m = Math.floor(s/60);
  s = Math.round(s%60);
  return m+'m '+s+'s';
}

export function estimate(fileSizeBytes) {
  const payloadBytes = 200 + 13 + fileSizeBytes;
  const dataFrames = Math.ceil(payloadBytes / EFFECTIVE_BYTES_PER_FRAME);
  const frames = Math.max(dataFrames, MIN_FRAMES);
  if (frames > MAX_SAFE_FRAMES) {
    console.warn(`Ограничение до ${MAX_SAFE_FRAMES} кадров`);
  }
  const dur = frames / FPS;
  const estSize = Math.ceil(dur * BITRATE / 8);
  return { estSize, frames, durationSec: dur, dataFrames };
}

async function yieldToMain(ms = 0) {
  return new Promise(r => setTimeout(r, ms));
}

// ──────────────────────────────────────── ENCODE ────────────────────────────────────────
export async function encode(file, coverVideo, onProgress, isCancelled = () => false) {
  onProgress(3, 'Чтение файла...');
  const fileBytes = new Uint8Array(await file.arrayBuffer());

  onProgress(6, 'Подготовка заголовка...');
  const checksum = crc32(fileBytes);
  const header = JSON.stringify({
    n: file.name,
    s: fileBytes.length,
    v: FORMAT_VERSION,
    q: Q,
    r: REDUNDANCY,
    c: checksum,
    w: W, h: H, b: SBS
  });
  const payload = new PayloadBuilder(header, fileBytes);

  const dataFramesNeeded = Math.ceil(payload.totalLength / EFFECTIVE_BYTES_PER_FRAME);
  let totalFrames = Math.max(dataFramesNeeded, MIN_FRAMES);
  if (totalFrames > MAX_SAFE_FRAMES) totalFrames = MAX_SAFE_FRAMES;

  onProgress(9, 'Поиск кодека...');

  let codec = null;
  for (const c of ['avc1.640029', 'avc1.4D401F', 'avc1.42E01E', 'avc1.42001F']) {
    try {
      if ((await VideoEncoder.isConfigSupported({
        codec: c, width: W, height: H, bitrate: BITRATE, framerate: FPS
      })).supported) {
        codec = c; break;
      }
    } catch {}
  }
  if (!codec) throw new Error('H.264 не поддерживается в этом браузере');

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width: W, height: H },
    fastStart: 'in-memory'
  });

  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: e => { throw e; }
  });

  encoder.configure({
    codec,
    width: W,
    height: H,
    bitrate: BITRATE,
    framerate: FPS,
    hardwareAcceleration: 'prefer-hardware',
    bitrateMode: 'quantizer'
  });

  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext('2d', { willReadFrequently: true, alpha: false });

  coverVideo.muted = true;
  coverVideo.loop = true;
  coverVideo.preload = 'auto';
  await coverVideo.play().catch(() => {});

  let frameCount = 0;
  let lastProgressTime = performance.now();
  const MAX_ENCODE_QUEUE = 12;

  try {
    while (frameCount < totalFrames) {
      if (isCancelled()) throw new Error('Отменено пользователем');

      if (encoder.encodeQueueSize >= MAX_ENCODE_QUEUE) {
        await new Promise(r => encoder.addEventListener('dequeue', r, {once: true}));
        await yieldToMain(2);
        continue;
      }

      ctx.drawImage(coverVideo, 0, 0, W, H);
      const id = ctx.getImageData(0, 0, W, H);

      const slice = payload.getSlice(frameCount);
      embedFrame(id, slice);
      ctx.putImageData(id, 0, 0);

      const bitmap = await createImageBitmap(canvas);
      const vf = new VideoFrame(bitmap, {
        timestamp: frameCount * (1_000_000 / FPS),
        duration: 1_000_000 / FPS
      });

      encoder.encode(vf, { keyFrame: frameCount % KEYFRAME_EVERY === 0 });

      vf.close();
      bitmap.close();

      frameCount++;

      const now = performance.now();
      if (now - lastProgressTime > 180 || frameCount === totalFrames) {
        const pct = 12 + Math.round((frameCount / totalFrames) * 83);
        onProgress(Math.min(95, pct), `Кадр ${frameCount}/${totalFrames}`);
        lastProgressTime = now;
        await yieldToMain(0);
      }

      if (frameCount % 3 === 0) await yieldToMain(6);
    }

    onProgress(96, 'Финализация...');
    await encoder.flush();
    encoder.close();
    muxer.finalize();

    const buffer = muxer.target.buffer;
    return {
      blob: new Blob([buffer], {type: 'video/mp4'}),
      totalFrames,
      dataFrames: dataFramesNeeded,
      checksum,
      fileSize: fileBytes.length,
      videoSize: buffer.byteLength,
      duration: totalFrames / FPS
    };
  } finally {
    coverVideo.pause();
    coverVideo.currentTime = 0;
  }
}

// decode функция осталась почти без изменений — можешь оставить как в твоём варианте
// или использовать версию из предыдущего ответа

// ... (decode код можно взять из твоего последнего сообщения — он вполне рабочий)
