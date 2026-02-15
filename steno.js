import { Muxer, ArrayBufferTarget } from 'https://cdn.jsdelivr.net/npm/mp4-muxer@5/+esm';

const W = 854;
const H = 480;
const FPS = 30;
const BITRATE = 1_500_000;
const SBS = 32;                  // ← было 16 → сильно быстрее
const Q = 128;
const REDUNDANCY = 2;            // ← было 3 → быстрее и меньше размер
const MIN_FRAMES = 30;
const KEYFRAME_INTERVAL = 6;     // ← новый параметр
const MAGIC = new Uint8Array([0x53, 0x57, 0x4D, 0x50]);
const FORMAT_VERSION = 4;
const XOR_KEY = new Uint8Array([0x53,0x48,0x52,0x45,0x4B,0x21,0x4F,0x47,0x52,0x45,0x53,0x57,0x41,0x4D,0x50,0x21]);

const SCOLS = W / SBS;
const SROWS = H / SBS;
const BPF = SCOLS * SROWS;
const EFFECTIVE_BPF = Math.floor(BPF / REDUNDANCY);
const EFFECTIVE_BYTES_PER_FRAME = EFFECTIVE_BPF >>> 3;

export const CONFIG = {
  W, H, FPS, BITRATE, SBS, Q, REDUNDANCY, MIN_FRAMES,
  SCOLS, SROWS, BPF, EFFECTIVE_BPF, EFFECTIVE_BYTES_PER_FRAME, FORMAT_VERSION,
  KEYFRAME_INTERVAL
};

const CRC_TABLE = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
  let c = i;
  for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
  CRC_TABLE[i] = c;
}

export function crc32(data) {
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < data.length; i++) crc = CRC_TABLE[(crc ^ data[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function qimEmbed(val, bit) {
  const half = Q >>> 1;
  let t = bit === 0
    ? Math.round(val / Q) * Q
    : Math.round((val - half) / Q) * Q + half;
  return Math.max(0, Math.min(255, t));
}

function qimExtract(val) {
  const half = Q >>> 1;
  const d0 = Math.abs(val - Math.round(val / Q) * Q);
  const d1 = Math.abs(val - (Math.round((val - half) / Q) * Q + half));
  return d0 <= d1 ? 0 : 1;
}

let _interleaveCache = null;
let _interleaveCacheSize = 0;

function interleaveIndices(totalBits) {
  if (_interleaveCache && _interleaveCacheSize === totalBits) return _interleaveCache;
  const indices = new Uint32Array(totalBits);
  for (let i = 0; i < totalBits; i++) indices[i] = i;
  let seed = 0x5F3759DF;
  for (let i = totalBits - 1; i > 0; i--) {
    seed = (seed * 1103515245 + 12345) & 0x7FFFFFFF;
    const j = seed % (i + 1);
    [indices[i], indices[j]] = [indices[j], indices[i]];
  }
  _interleaveCache = indices;
  _interleaveCacheSize = totalBits;
  return indices;
}

export function embedFrame(imgData, slice) {
  const d = imgData.data;
  const totalBits = BPF;
  const logicalBits = EFFECTIVE_BPF;

  const dataBits = new Uint8Array(logicalBits);
  if (slice) {
    for (let i = 0; i < logicalBits; i++) {
      const byteI = i >>> 3;
      const bitP = 7 - (i & 7);
      if (byteI < slice.length) {
        dataBits[i] = (slice[byteI] >>> bitP) & 1;
      }
    }
  }

  const expandedBits = new Uint8Array(totalBits);
  for (let i = 0; i < logicalBits; i++) {
    expandedBits.fill(dataBits[i], i * REDUNDANCY, i * REDUNDANCY + REDUNDANCY);
  }

  const interleaveMap = interleaveIndices(totalBits);
  const finalBits = new Uint8Array(totalBits);
  for (let i = 0; i < totalBits; i++) {
    finalBits[interleaveMap[i]] = expandedBits[i];
  }

  let bi = 0;
  for (let by = 0; by < SROWS; by++) {
    const sy = by * SBS;
    for (let bx = 0; bx < SCOLS; bx++) {
      const sx = bx * SBS;
      const bit = finalBits[bi++];
      let sumY = 0;
      for (let py = 0; py < SBS; py++) {
        for (let px = 0; px < SBS; px++) {
          const off = ((sy + py) * W + sx + px) << 2;
          sumY += 0.299 * d[off] + 0.587 * d[off + 1] + 0.114 * d[off + 2];
        }
      }
      const avgY = sumY / (SBS * SBS);
      const tgt = qimEmbed(avgY, bit);
      const delta = tgt - avgY;
      for (let py = 0; py < SBS; py++) {
        for (let px = 0; px < SBS; px++) {
          const off = ((sy + py) * W + sx + px) << 2;
          d[off    ] = Math.max(0, Math.min(255, Math.round(d[off    ] + delta)));
          d[off + 1] = Math.max(0, Math.min(255, Math.round(d[off + 1] + delta)));
          d[off + 2] = Math.max(0, Math.min(255, Math.round(d[off + 2] + delta)));
        }
      }
    }
  }
}

export function extractFrame(imgData) {
  const d = imgData.data;
  const totalBits = BPF;

  const rawBits = new Uint8Array(totalBits);
  let bi = 0;
  for (let by = 0; by < SROWS; by++) {
    const sy = by * SBS;
    for (let bx = 0; bx < SCOLS; bx++) {
      const sx = bx * SBS;
      let sumY = 0;
      for (let py = 0; py < SBS; py++) {
        for (let px = 0; px < SBS; px++) {
          const off = ((sy + py) * W + sx + px) << 2;
          sumY += 0.299 * d[off] + 0.587 * d[off + 1] + 0.114 * d[off + 2];
        }
      }
      rawBits[bi++] = qimExtract(sumY / (SBS * SBS));
    }
  }

  const interleaveMap = interleaveIndices(totalBits);
  const deinterleavedBits = new Uint8Array(totalBits);
  for (let i = 0; i < totalBits; i++) {
    deinterleavedBits[i] = rawBits[interleaveMap[i]];
  }

  const out = new Uint8Array(EFFECTIVE_BYTES_PER_FRAME);
  for (let i = 0; i < EFFECTIVE_BPF; i++) {
    let votes = 0;
    for (let r = 0; r < REDUNDANCY; r++) {
      votes += deinterleavedBits[i * REDUNDANCY + r];
    }
    if (votes > REDUNDANCY / 2) {
      out[i >>> 3] |= (1 << (7 - (i & 7)));
    }
  }
  return out;
}

function obfuscateHeader(json) {
  const b = new TextEncoder().encode(json);
  const o = new Uint8Array(b.length);
  for (let i = 0; i < b.length; i++) o[i] = b[i] ^ XOR_KEY[i % XOR_KEY.length];
  return o;
}

function deobfuscateHeader(o) {
  const b = new Uint8Array(o.length);
  for (let i = 0; i < o.length; i++) b[i] = o[i] ^ XOR_KEY[i % XOR_KEY.length];
  return new TextDecoder().decode(b);
}

class PayloadBuilder {
  constructor(headerJson, fileData) {
    const headerBytes = obfuscateHeader(headerJson);
    const headerCrc = crc32(headerBytes);
    const hl = headerBytes.length;
    const prefixLen = 4 + 1 + 4 + hl + 4;
    this.prefix = new Uint8Array(prefixLen);
    let pos = 0;
    this.prefix.set(MAGIC, pos); pos += 4;
    this.prefix[pos++] = FORMAT_VERSION;
    this.prefix[pos++] = (hl >>> 24) & 0xFF;
    this.prefix[pos++] = (hl >>> 16) & 0xFF;
    this.prefix[pos++] = (hl >>> 8) & 0xFF;
    this.prefix[pos++] = hl & 0xFF;
    this.prefix.set(headerBytes, pos); pos += hl;
    this.prefix[pos++] = (headerCrc >>> 24) & 0xFF;
    this.prefix[pos++] = (headerCrc >>> 16) & 0xFF;
    this.prefix[pos++] = (headerCrc >>> 8) & 0xFF;
    this.prefix[pos  ] = headerCrc & 0xFF;
    this.fileData = fileData;
    this.prefixLen = prefixLen;
    this.length = prefixLen + fileData.length;
  }

  getFrameSlice(frameIdx) {
    const bpf = EFFECTIVE_BYTES_PER_FRAME;
    const offset = frameIdx * bpf;
    const end = Math.min(offset + bpf, this.length);
    if (end <= offset) return null;
    if (offset >= this.prefixLen) return this.fileData.subarray(offset - this.prefixLen, end - this.prefixLen);
    if (end <= this.prefixLen) return this.prefix.subarray(offset, end);
    const result = new Uint8Array(end - offset);
    result.set(this.prefix.subarray(offset, this.prefixLen));
    result.set(this.fileData.subarray(0, end - this.prefixLen), this.prefixLen - offset);
    return result;
  }
}

export function fmtSize(b) {
  if (b < 1024) return b + ' B';
  if (b < 1048576) return (b / 1024).toFixed(1) + ' KB';
  if (b < 1073741824) return (b / 1048576).toFixed(2) + ' MB';
  return (b / 1073741824).toFixed(2) + ' GB';
}

export function fmtTime(sec) {
  if (sec < 60) return Math.round(sec) + 's';
  return Math.floor(sec / 60) + 'm ' + Math.round(sec % 60) + 's';
}

export function estimateOutput(fileSize) {
  const hdrEst = 200;
  const payloadSize = 13 + hdrEst + fileSize;
  const dataFrames = Math.ceil(payloadSize / EFFECTIVE_BYTES_PER_FRAME);
  const totalFrames = Math.max(dataFrames, MIN_FRAMES);
  const duration = totalFrames / FPS;
  return { est: Math.ceil(duration * BITRATE / 8), frames: totalFrames, duration, dataFrames };
}

function yieldToUI() {
  return new Promise(r => setTimeout(r, 0));
}

async function findWorkingCodec(w, h, bitrate, fps) {
  const candidates = [
    'avc1.42001f', 'avc1.420029', 'avc1.42E01E', 'avc1.4D401F', 'avc1.640029',
  ];
  const base = { width: w, height: h, bitrate, framerate: fps };
  for (const codec of candidates) {
    try {
      if ((await VideoEncoder.isConfigSupported({ ...base, codec })).supported) return codec;
    } catch {}
  }
  return null;
}

export async function encode(file, coverVideo, onProgress, cancelCheck) {
  onProgress(2, 'Reading file...');
  const fileData = new Uint8Array(await file.arrayBuffer());
  if (cancelCheck()) throw new Error('Cancelled');

  onProgress(5, 'Building payload...');
  const checksum = crc32(fileData);
  const headerJson = JSON.stringify({
    n: file.name,
    s: fileData.length,
    v: FORMAT_VERSION,
    q: Q,
    r: REDUNDANCY,
    c: checksum,
    w: W,
    h: H,
    b: SBS
  });
  const payload = new PayloadBuilder(headerJson, fileData);
  const dataFrames = Math.ceil(payload.length / EFFECTIVE_BYTES_PER_FRAME);
  const totalFrames = Math.max(dataFrames, MIN_FRAMES);

  onProgress(8, 'Initializing H.264...');

  const codecString = await findWorkingCodec(W, H, BITRATE, FPS);
  if (!codecString) throw new Error('No supported H.264 profile. Try Chrome/Edge.');

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width: W, height: H },
    fastStart: 'in-memory',
  });

  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: e => { throw e; }
  });

  encoder.configure({
    codec: codecString,
    width: W,
    height: H,
    bitrate: BITRATE,
    framerate: FPS,
    hardwareAcceleration: 'prefer-hardware',  // ← пробуем hardware сначала
  });

  const offscreen = new OffscreenCanvas(W, H);
  const ctx = offscreen.getContext('2d', { willReadFrequently: true });

  // Подготовка cover видео
  coverVideo.muted = true;
  coverVideo.loop = true;
  coverVideo.preload = 'auto';
  coverVideo.currentTime = 0;
  await new Promise(r => { coverVideo.onloadeddata = r; coverVideo.load(); });

  let frameIndex = 0;
  let lastProgress = -1;
  const MAX_QUEUE = 16;  // ← больше очередь → меньше простоев

  coverVideo.play().catch(() => {});

  const processFrame = async () => {
    while (frameIndex < totalFrames) {
      if (cancelCheck()) throw new Error('Cancelled');

      if (encoder.encodeQueueSize >= MAX_QUEUE) {
        await new Promise(r => encoder.addEventListener('dequeue', r, { once: true }));
        continue;
      }

      ctx.drawImage(coverVideo, 0, 0, W, H);
      const imgData = ctx.getImageData(0, 0, W, H);

      const slice = payload.getFrameSlice(frameIndex);
      embedFrame(imgData, slice);
      ctx.putImageData(imgData, 0, 0);

      const bitmap = await createImageBitmap(offscreen);
      const vf = new VideoFrame(bitmap, {
        timestamp: frameIndex * (1_000_000 / FPS),
        duration: 1_000_000 / FPS,
      });

      encoder.encode(vf, { keyFrame: frameIndex % KEYFRAME_INTERVAL === 0 });
      vf.close();
      bitmap.close();

      frameIndex++;

      if (frameIndex - lastProgress >= 20 || frameIndex === totalFrames) {
        const pct = 10 + Math.round((frameIndex / totalFrames) * 85);
        onProgress(pct, `Frames ${frameIndex}/${totalFrames}`);
        lastProgress = frameIndex;
        await yieldToUI();
      }
    }

    onProgress(94, 'Finalizing video...');
    await encoder.flush();
    encoder.close();
    muxer.finalize();

    const mp4Buf = muxer.target.buffer;
    return {
      blob: new Blob([mp4Buf], { type: 'video/mp4' }),
      totalFrames,
      dataFrames,
      checksum,
      fileSize: fileData.length,
      videoSize: mp4Buf.byteLength,
      duration: totalFrames / FPS
    };
  };

  try {
    const result = await processFrame();
    coverVideo.pause();
    coverVideo.currentTime = 0;
    return result;
  } catch (e) {
    coverVideo.pause();
    throw e;
  }
}

// decode остаётся почти без изменений, но с чуть лучшим yield и прогрессом
export async function decode(file, onProgress, cancelCheck) {
  onProgress(1, 'Loading video...');

  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  const videoUrl = URL.createObjectURL(file);

  try {
    video.src = videoUrl;
    await new Promise((res, rej) => {
      video.onloadedmetadata = res;
      video.onerror = () => rej(new Error('Video load failed'));
      setTimeout(() => rej(new Error('Video load timeout')), 30000);
    });
    await new Promise(r => { video.oncanplaythrough = r; video.load(); });

    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    const estFrames = Math.max(1, Math.ceil(video.duration * FPS));
    onProgress(3, `Scanning ~${estFrames} frames...`);

    let outputBuffer = null;
    let outputOffset = 0;
    let headerParsed = false;
    let totalNeeded = 0;
    let parsedHeader = null;

    const tempSize = Math.min(estFrames * EFFECTIVE_BYTES_PER_FRAME, 4_000_000); // чуть больше буфер
    const tempBuffer = new Uint8Array(tempSize);
    let tempOffset = 0;

    let frameIdx = 0;
    let lastYield = performance.now();

    while (frameIdx < estFrames * 1.1) {  // небольшой запас
      if (cancelCheck()) throw new Error('Cancelled');

      const t = frameIdx / FPS;
      if (t > video.duration + 0.5) break;

      await new Promise(res => {
        const onSeek = () => { video.removeEventListener('seeked', onSeek); res(); };
        video.addEventListener('seeked', onSeek);
        video.currentTime = t;
        setTimeout(res, 1500); // fallback
      });

      ctx.drawImage(video, 0, 0, W, H);
      const imgData = ctx.getImageData(0, 0, W, H);
      const frameBytes = extractFrame(imgData);

      if (!headerParsed) {
        const copyLen = Math.min(EFFECTIVE_BYTES_PER_FRAME, tempBuffer.length - tempOffset);
        if (copyLen > 0) {
          tempBuffer.set(frameBytes.subarray(0, copyLen), tempOffset);
          tempOffset += copyLen;
        }

        if (tempOffset >= 9) {
          if (!MAGIC.every((v, i) => tempBuffer[i] === v)) {
            throw new Error('Not a SwampCrypt v4 video (magic mismatch)');
          }
          const version = tempBuffer[4];
          if (version !== FORMAT_VERSION) {
            throw new Error(`Version mismatch: found v${version}, need v${FORMAT_VERSION}`);
          }

          const hl = (tempBuffer[5]<<24)|(tempBuffer[6]<<16)|(tempBuffer[7]<<8)|tempBuffer[8];
          if (hl < 10 || hl > 10000) throw new Error(`Bad header length: ${hl}`);

          const headerEnd = 9 + hl + 4;
          if (tempOffset >= headerEnd) {
            const headerBytes = tempBuffer.slice(9, 9 + hl);
            const storedCrc = ((tempBuffer[9+hl]<<24)|(tempBuffer[9+hl+1]<<16)|(tempBuffer[9+hl+2]<<8)|tempBuffer[9+hl+3]) >>> 0;
            if (storedCrc !== crc32(headerBytes)) {
              throw new Error('Header CRC mismatch – video damaged?');
            }

            const hdrJson = deobfuscateHeader(headerBytes);
            parsedHeader = JSON.parse(hdrJson);
            if (!parsedHeader.n || !parsedHeader.s) throw new Error('Header missing fields');

            totalNeeded = headerEnd + parsedHeader.s;
            outputBuffer = new Uint8Array(totalNeeded);
            outputBuffer.set(tempBuffer.subarray(0, Math.min(tempOffset, totalNeeded)));
            outputOffset = Math.min(tempOffset, totalNeeded);
            headerParsed = true;
          }
        }
      } else {
        const remaining = totalNeeded - outputOffset;
        if (remaining > 0) {
          const copy = Math.min(EFFECTIVE_BYTES_PER_FRAME, remaining);
          outputBuffer.set(frameBytes.subarray(0, copy), outputOffset);
          outputOffset += copy;
        }
        if (outputOffset >= totalNeeded) break;
      }

      frameIdx++;

      const now = performance.now();
      if (now - lastYield > 80 || frameIdx % 30 === 0) {
        const pct = headerParsed ? 20 + (outputOffset / totalNeeded) * 70 : 5 + (frameIdx / estFrames) * 15;
        onProgress(Math.min(95, pct), headerParsed ? `Extracting ${fmtSize(outputOffset)} / ${fmtSize(totalNeeded)}` : `Scanning frame ${frameIdx}`);
        lastYield = now;
        await yieldToUI();
      }
    }

    if (!headerParsed) throw new Error('No valid SwampCrypt header found');
    if (outputOffset < totalNeeded) {
      throw new Error(`Incomplete: got ${fmtSize(outputOffset)}, expected ${fmtSize(totalNeeded)}`);
    }

    onProgress(96, 'Verifying...');

    const hl = (outputBuffer[5]<<24)|(outputBuffer[6]<<16)|(outputBuffer[7]<<8)|outputBuffer[8];
    const fileStart = 9 + hl + 4;
    const extractedFile = outputBuffer.slice(fileStart, fileStart + parsedHeader.s);

    let integrityOk = true;
    let integrityMsg = '';
    if (parsedHeader.c !== undefined) {
      const gotCrc = crc32(extractedFile);
      if (gotCrc === parsedHeader.c) {
        integrityMsg = 'CRC OK';
      } else {
        integrityOk = false;
        integrityMsg = `CRC error: expected ${parsedHeader.c.toString(16).toUpperCase()}, got ${gotCrc.toString(16).toUpperCase()}`;
      }
    }

    return {
      data: extractedFile,
      filename: parsedHeader.n,
      size: parsedHeader.s,
      integrityOk,
      integrityMsg
    };
  } finally {
    URL.revokeObjectURL(videoUrl);
  }
}
