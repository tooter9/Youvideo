import { Muxer, ArrayBufferTarget } from 'https://cdn.jsdelivr.net/npm/mp4-muxer@5/+esm';

const W = 1280, H = 720, FPS = 30;
const BITRATE = 25_000_000;
const SBS = 8;
const Q = 80;
const REDUNDANCY = 3;
const MIN_FRAMES = 30;
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
  SCOLS, SROWS, BPF, EFFECTIVE_BPF, EFFECTIVE_BYTES_PER_FRAME, FORMAT_VERSION
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
  let t;
  if (bit === 0) {
    t = Math.round(val / Q) * Q;
  } else {
    t = Math.round((val - half) / Q) * Q + half;
  }
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
    const tmp = indices[i]; indices[i] = indices[j]; indices[j] = tmp;
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
    for (let r = 0; r < REDUNDANCY; r++) {
      expandedBits[i * REDUNDANCY + r] = dataBits[i];
    }
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
      const bit = finalBits[bi];
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
          d[off] = Math.max(0, Math.min(255, Math.round(d[off] + delta)));
          d[off + 1] = Math.max(0, Math.min(255, Math.round(d[off + 1] + delta)));
          d[off + 2] = Math.max(0, Math.min(255, Math.round(d[off + 2] + delta)));
        }
      }
      bi++;
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
      const avgY = sumY / (SBS * SBS);
      rawBits[bi] = qimExtract(avgY);
      bi++;
    }
  }

  const interleaveMap = interleaveIndices(totalBits);
  const deinterleavedBits = new Uint8Array(totalBits);
  for (let i = 0; i < totalBits; i++) {
    deinterleavedBits[i] = rawBits[interleaveMap[i]];
  }

  const logicalBits = EFFECTIVE_BPF;
  const out = new Uint8Array(EFFECTIVE_BYTES_PER_FRAME);
  for (let i = 0; i < logicalBits; i++) {
    let votes = 0;
    for (let r = 0; r < REDUNDANCY; r++) {
      votes += deinterleavedBits[i * REDUNDANCY + r];
    }
    const bit = (votes > REDUNDANCY / 2) ? 1 : 0;
    if (bit) out[i >>> 3] |= (1 << (7 - (i & 7)));
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
    this.prefix[pos] = FORMAT_VERSION; pos += 1;
    this.prefix[pos] = (hl >>> 24) & 0xFF;
    this.prefix[pos + 1] = (hl >>> 16) & 0xFF;
    this.prefix[pos + 2] = (hl >>> 8) & 0xFF;
    this.prefix[pos + 3] = hl & 0xFF;
    pos += 4;
    this.prefix.set(headerBytes, pos); pos += hl;
    this.prefix[pos] = (headerCrc >>> 24) & 0xFF;
    this.prefix[pos + 1] = (headerCrc >>> 16) & 0xFF;
    this.prefix[pos + 2] = (headerCrc >>> 8) & 0xFF;
    this.prefix[pos + 3] = headerCrc & 0xFF;
    this.fileData = fileData;
    this.prefixLen = prefixLen;
    this.length = prefixLen + fileData.length;
  }

  getFrameSlice(frameIdx) {
    const bpf = EFFECTIVE_BYTES_PER_FRAME;
    const offset = frameIdx * bpf;
    const end = Math.min(offset + bpf, this.length);
    if (end <= offset) return null;
    if (offset >= this.prefixLen) {
      return this.fileData.subarray(offset - this.prefixLen, end - this.prefixLen);
    }
    if (end <= this.prefixLen) {
      return this.prefix.subarray(offset, end);
    }
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

function seekVideo(video, time) {
  return new Promise((resolve, reject) => {
    const onSeeked = () => {
      video.removeEventListener('seeked', onSeeked);
      resolve();
    };
    video.addEventListener('seeked', onSeeked);
    video.currentTime = time;
    setTimeout(() => {
      video.removeEventListener('seeked', onSeeked);
      resolve();
    }, 2000);
  });
}

export async function encode(file, coverVideo, onProgress, cancelCheck) {
  onProgress(2, 'Reading file...');
  await yieldToUI();
  const fileData = new Uint8Array(await file.arrayBuffer());
  if (cancelCheck()) throw new Error('Cancelled');

  onProgress(5, 'Building payload...');
  await yieldToUI();
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
  await yieldToUI();
  const codecString = 'avc1.42001f';
  const support = await VideoEncoder.isConfigSupported({
    codec: codecString, width: W, height: H, bitrate: BITRATE, framerate: FPS,
  });
  if (!support.supported) throw new Error('H.264 not supported in this browser.');

  const muxer = new Muxer({
    target: new ArrayBufferTarget(),
    video: { codec: 'avc', width: W, height: H },
    fastStart: 'in-memory',
  });

  let encError = null;
  const encoder = new VideoEncoder({
    output: (chunk, meta) => muxer.addVideoChunk(chunk, meta),
    error: e => { encError = e; },
  });

  encoder.configure({
    codec: codecString, width: W, height: H,
    bitrate: BITRATE, framerate: FPS, latencyMode: 'quality',
  });

  const cvs = document.createElement('canvas');
  cvs.width = W; cvs.height = H;
  const ctx = cvs.getContext('2d', { willReadFrequently: true });
  const shrekDur = coverVideo.duration;
  const startTime = performance.now();
  let lastYield = startTime;
  const MAX_QUEUE = 6;

  try {
    for (let i = 0; i < totalFrames; i++) {
      if (cancelCheck()) throw new Error('Cancelled');
      if (encError) throw encError;

      const shrekTime = (i / FPS) % shrekDur;
      await seekVideo(coverVideo, shrekTime);
      ctx.drawImage(coverVideo, 0, 0, W, H);
      const imgData = ctx.getImageData(0, 0, W, H);

      const slice = payload.getFrameSlice(i);
      embedFrame(imgData, slice);
      ctx.putImageData(imgData, 0, 0);

      const frame = new VideoFrame(cvs, {
        timestamp: i * (1_000_000 / FPS),
        duration: 1_000_000 / FPS,
      });

      while (encoder.encodeQueueSize >= MAX_QUEUE) {
        await new Promise(r => encoder.addEventListener('dequeue', r, { once: true }));
        if (cancelCheck()) { frame.close(); throw new Error('Cancelled'); }
        if (encError) { frame.close(); throw encError; }
      }

      encoder.encode(frame, { keyFrame: true });
      frame.close();

      const now = performance.now();
      if (now - lastYield > 30 || i === totalFrames - 1) {
        const pct = 10 + (i / totalFrames) * 85;
        const elapsed = (now - startTime) / 1000;
        const fps = (i + 1) / elapsed;
        const eta = (totalFrames - i - 1) / fps;
        const etaStr = i > 5 ? ' (ETA: ' + fmtTime(eta) + ')' : '';
        onProgress(pct, 'Frame ' + (i + 1) + '/' + totalFrames + etaStr);
        await yieldToUI();
        lastYield = performance.now();
      }
    }

    onProgress(96, 'Flushing encoder...');
    await yieldToUI();
    await encoder.flush();
    encoder.close();
    muxer.finalize();
    if (encError) throw encError;

    const mp4Buf = muxer.target.buffer;
    const blob = new Blob([mp4Buf], { type: 'video/mp4' });
    return {
      blob,
      totalFrames,
      dataFrames,
      checksum,
      fileSize: fileData.length,
      videoSize: mp4Buf.byteLength,
      duration: totalFrames / FPS
    };
  } catch (e) {
    try { encoder.close(); } catch (_) {}
    throw e;
  }
}

export async function decode(file, onProgress, cancelCheck) {
  onProgress(1, 'Loading video...');
  await yieldToUI();

  const video = document.createElement('video');
  video.muted = true;
  video.playsInline = true;
  video.preload = 'auto';
  const videoUrl = URL.createObjectURL(file);

  try {
    video.src = videoUrl;
    await new Promise((res, rej) => {
      video.onloadedmetadata = res;
      video.onerror = () => rej(new Error('Failed to load video file.'));
      setTimeout(() => rej(new Error('Video load timeout (30s)')), 30000);
    });
    await new Promise((res, rej) => {
      video.oncanplaythrough = res;
      video.load();
      setTimeout(() => res(), 10000);
    });

    const canvas = document.createElement('canvas');
    canvas.width = W; canvas.height = H;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    const estFrames = Math.max(1, Math.ceil(video.duration * FPS));
    onProgress(3, 'Scanning ' + estFrames + ' frames...');

    let outputBuffer = null;
    let outputOffset = 0;
    let headerParsed = false;
    let totalNeeded = 0;
    let parsedHeader = null;

    const tempSize = Math.min(estFrames * EFFECTIVE_BYTES_PER_FRAME, 2_000_000);
    const tempBuffer = new Uint8Array(tempSize);
    let tempOffset = 0;

    const startTime = performance.now();
    let lastYield = startTime;

    for (let i = 0; i < estFrames; i++) {
      if (cancelCheck()) throw new Error('Cancelled');

      const t = i / FPS;
      if (t > video.duration + 1) break;

      await seekVideo(video, t);
      await yieldToUI();

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
          if (tempBuffer[0] !== MAGIC[0] || tempBuffer[1] !== MAGIC[1] ||
              tempBuffer[2] !== MAGIC[2] || tempBuffer[3] !== MAGIC[3]) {
            throw new Error('No hidden data found. This video was not created by SwampCrypt v4.');
          }

          const version = tempBuffer[4];
          if (version !== FORMAT_VERSION) {
            throw new Error('Format version mismatch: found v' + version + ', expected v' + FORMAT_VERSION);
          }

          const hl = (tempBuffer[5] << 24) | (tempBuffer[6] << 16) | (tempBuffer[7] << 8) | tempBuffer[8];
          if (hl > 10000 || hl < 10) throw new Error('Invalid header length: ' + hl + '. Video may be corrupted.');

          const headerEnd = 9 + hl + 4;
          if (tempOffset >= headerEnd) {
            const headerBytes = tempBuffer.slice(9, 9 + hl);
            const storedCrc = ((tempBuffer[9 + hl] << 24) | (tempBuffer[9 + hl + 1] << 16) |
                               (tempBuffer[9 + hl + 2] << 8) | tempBuffer[9 + hl + 3]) >>> 0;
            const computedCrc = crc32(headerBytes);
            if (storedCrc !== computedCrc) {
              throw new Error('Header integrity check failed (CRC mismatch). Video may be damaged.');
            }

            try {
              const hdrJson = deobfuscateHeader(headerBytes);
              parsedHeader = JSON.parse(hdrJson);
              if (!parsedHeader.n || !parsedHeader.s) throw new Error('Missing required fields');
            } catch (e) {
              if (e.message.includes('CRC') || e.message.includes('integrity')) throw e;
              throw new Error('Failed to parse header: ' + e.message);
            }

            totalNeeded = headerEnd + parsedHeader.s;
            outputBuffer = new Uint8Array(totalNeeded);
            const toCopy = Math.min(tempOffset, totalNeeded);
            outputBuffer.set(tempBuffer.subarray(0, toCopy));
            outputOffset = toCopy;
            headerParsed = true;
          }
        }
      } else {
        const remaining = totalNeeded - outputOffset;
        if (remaining > 0) {
          const toCopy = Math.min(EFFECTIVE_BYTES_PER_FRAME, remaining);
          outputBuffer.set(frameBytes.subarray(0, toCopy), outputOffset);
          outputOffset += toCopy;
        }
        if (outputOffset >= totalNeeded) {
          onProgress(90, 'All data extracted.');
          break;
        }
      }

      const now = performance.now();
      if (now - lastYield > 50 || i === estFrames - 1) {
        const pct = 5 + ((i + 1) / estFrames) * 80;
        const elapsed = (now - startTime) / 1000;
        const fps = (i + 1) / elapsed;
        const framesLeft = headerParsed
          ? Math.ceil((totalNeeded - outputOffset) / EFFECTIVE_BYTES_PER_FRAME)
          : (estFrames - i - 1);
        const etaStr = i > 3 ? ' (ETA: ' + fmtTime(framesLeft / fps) + ')' : '';
        onProgress(pct, 'Frame ' + (i + 1) + '/' + estFrames + etaStr);
        await yieldToUI();
        lastYield = performance.now();
      }
    }

    if (!headerParsed) throw new Error('No hidden data found. Make sure this video was created by SwampCrypt v4.');
    if (outputOffset < totalNeeded) {
      throw new Error('Incomplete data: expected ' + fmtSize(totalNeeded) + ', extracted ' + fmtSize(outputOffset) + '. Video may be truncated.');
    }

    onProgress(95, 'Verifying integrity...');
    await yieldToUI();

    const hl = (outputBuffer[5] << 24) | (outputBuffer[6] << 16) | (outputBuffer[7] << 8) | outputBuffer[8];
    const fileStart = 9 + hl + 4;
    const fileData = outputBuffer.slice(fileStart, fileStart + parsedHeader.s);

    let integrityOk = true;
    let integrityMsg = '';
    if (parsedHeader.c !== undefined) {
      const extractedCrc = crc32(fileData);
      if (extractedCrc === parsedHeader.c) {
        integrityMsg = 'CRC32 verified OK.';
      } else {
        integrityOk = false;
        integrityMsg = 'CRC32 mismatch! Expected ' + parsedHeader.c.toString(16).toUpperCase() +
                       ', got ' + extractedCrc.toString(16).toUpperCase() + '. File may have minor corruption from video compression.';
      }
    }

    return {
      data: fileData,
      filename: parsedHeader.n,
      size: parsedHeader.s,
      integrityOk,
      integrityMsg
    };
  } finally {
    URL.revokeObjectURL(videoUrl);
  }
}
