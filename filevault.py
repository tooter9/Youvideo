#!/usr/bin/env python3
"""
FileVault v3 - Encode any file into a real video, decode it back perfectly.

Upload to YouTube (unlisted/private), download later, decode back.
Pure Python + ffmpeg. No pip dependencies.

Features:
  - zlib compression (smaller videos)
  - Optional password encryption (AES-like XOR stream cipher)
  - Frame repetition for YouTube resilience
  - Calibration frame for color shift detection
  - ETA and speed in progress display
  - Adaptive decoding with error recovery

Usage:
    python3 filevault.py encode myfile.pdf
    python3 filevault.py encode myfile.pdf -p mypassword
    python3 filevault.py encode myfile.pdf --mode youtube --repeat 3
    python3 filevault.py decode video.mp4
    python3 filevault.py decode video.mp4 -p mypassword
    python3 filevault.py info video.mp4
    python3 filevault.py verify video.mp4
"""

import sys
import os
import struct
import hashlib
import subprocess
import json
import math
import argparse
import time
import zlib
import io

MAGIC = b'FVLT'
VERSION = 3

YT_LEVELS = [0, 85, 170, 255]
LOCAL_LEVELS = [0, 36, 73, 109, 146, 182, 219, 255]

DEFAULT_WIDTH = 640
DEFAULT_HEIGHT = 480
DEFAULT_FPS = 10
DEFAULT_BLOCK_YT = 8
DEFAULT_BLOCK_LOCAL = 4

BANNER = r"""
   _____ _ _   __     __          _ _
  |  ___(_) | __\ \   / /_ _ _   _| | |_
  | |_  | | |/ _ \ \ / / _` | | | | | __|
  |  _| | | |  __/\ V / (_| | |_| | | |_
  |_|   |_|_|\___| \_/ \__,_|\__,_|_|\__|  v3
"""


def build_lut(levels):
    lut = [0] * 256
    for v in range(256):
        best_i = 0
        best_d = abs(v - levels[0])
        for i in range(1, len(levels)):
            d = abs(v - levels[i])
            if d < best_d:
                best_i = i
                best_d = d
        lut[v] = best_i
    return lut


def check_ffmpeg():
    try:
        r = subprocess.run(
            ['ffmpeg', '-version'],
            capture_output=True, timeout=10
        )
        return r.returncode == 0
    except Exception:
        return False


def file_sha256(data):
    return hashlib.sha256(data).digest()


def fmt_size(n):
    for unit in ('B', 'KB', 'MB', 'GB'):
        if n < 1024:
            return f"{n:.1f} {unit}" if unit != 'B' else f"{n} {unit}"
        n /= 1024
    return f"{n:.1f} TB"


def fmt_time(seconds):
    if seconds < 60:
        return f"{seconds:.0f}s"
    m = int(seconds) // 60
    s = int(seconds) % 60
    return f"{m}m{s:02d}s"


def progress_bar(current, total, t0, width=30):
    pct = current / total if total else 0
    filled = int(width * pct)
    bar = '#' * filled + '-' * (width - filled)
    elapsed = time.time() - t0
    if current > 0:
        eta = (elapsed / current) * (total - current)
        speed = current / elapsed if elapsed > 0 else 0
        return f"[{bar}] {pct*100:.0f}% | {fmt_time(elapsed)}<{fmt_time(eta)} | {speed:.0f} fr/s"
    return f"[{bar}] 0%"


def derive_key(password, salt, length=256):
    key = bytearray()
    block = 0
    while len(key) < length:
        h = hashlib.sha256()
        h.update(struct.pack('>I', block))
        h.update(password.encode('utf-8'))
        h.update(salt)
        key.extend(h.digest())
        block += 1
    return bytes(key[:length])


def xor_crypt(data, key):
    out = bytearray(len(data))
    klen = len(key)
    for i in range(len(data)):
        out[i] = data[i] ^ key[i % klen]
    return bytes(out)


def compress_data(data):
    compressed = zlib.compress(data, 9)
    if len(compressed) < len(data):
        return compressed, True
    return data, False


def decompress_data(data, is_compressed):
    if is_compressed:
        return zlib.decompress(data)
    return data


def generate_calibration_frame(width, height, block_size, levels):
    bs = block_size
    grid_w = width // bs
    grid_h = height // bs
    frame = bytearray(width * height * 3)

    for gy in range(grid_h):
        row = bytearray(width * 3)
        for gx in range(grid_w):
            if gy < 2 or gy >= grid_h - 2 or gx < 2 or gx >= grid_w - 2:
                idx = (gx + gy) % len(levels)
                r = g = b = levels[idx]
            else:
                ci = ((gx - 2) + (gy - 2) * (grid_w - 4)) % len(levels)
                r = levels[ci % len(levels)]
                g = levels[(ci + 1) % len(levels)]
                b = levels[(ci + 2) % len(levels)]

            seg = bytes([r, g, b]) * bs
            off = gx * bs * 3
            row[off:off + len(seg)] = seg

        row_b = bytes(row)
        for py in range(gy * bs, min(gy * bs + bs, height)):
            start = py * width * 3
            frame[start:start + width * 3] = row_b

    return bytes(frame)


def detect_calibration_shift(frame, width, height, block_size, levels):
    bs = block_size
    lut = build_lut(levels)
    w3 = width * 3
    half = bs // 2

    errors = 0
    total = 0
    offsets_r = []
    offsets_g = []
    offsets_b = []

    grid_w = width // bs
    grid_h = height // bs

    for gy in range(2, min(grid_h - 2, 10)):
        for gx in range(2, min(grid_w - 2, 10)):
            ci = ((gx - 2) + (gy - 2) * (grid_w - 4)) % len(levels)
            expected_r = levels[ci % len(levels)]
            expected_g = levels[(ci + 1) % len(levels)]
            expected_b = levels[(ci + 2) % len(levels)]

            cy = gy * bs + half
            cx = gx * bs + half
            o = cy * w3 + cx * 3
            actual_r = frame[o]
            actual_g = frame[o + 1]
            actual_b = frame[o + 2]

            offsets_r.append(actual_r - expected_r)
            offsets_g.append(actual_g - expected_g)
            offsets_b.append(actual_b - expected_b)

            if lut[actual_r] != levels.index(expected_r):
                errors += 1
            if lut[actual_g] != levels.index(expected_g):
                errors += 1
            if lut[actual_b] != levels.index(expected_b):
                errors += 1
            total += 3

    if not offsets_r:
        return 0, 0, 0, 0.0

    avg_r = sum(offsets_r) // len(offsets_r)
    avg_g = sum(offsets_g) // len(offsets_g)
    avg_b = sum(offsets_b) // len(offsets_b)
    error_rate = errors / total if total > 0 else 0.0

    return avg_r, avg_g, avg_b, error_rate


class Encoder:
    def __init__(self, block_size, mode, width, height, fps, repeat=1):
        self.mode = mode
        self.width = width
        self.height = height
        self.fps = fps
        self.repeat = max(1, repeat)

        if mode == 'youtube':
            self.levels = YT_LEVELS
            self.bpc = 2
            self.block_size = block_size or DEFAULT_BLOCK_YT
        else:
            self.levels = LOCAL_LEVELS
            self.bpc = 3
            self.block_size = block_size or DEFAULT_BLOCK_LOCAL

        bs = self.block_size
        self.grid_w = width // bs
        self.grid_h = height // bs
        self.blocks_per_frame = self.grid_w * self.grid_h
        self.bpb = self.bpc * 3
        self.bytes_per_frame = (self.blocks_per_frame * self.bpb) // 8

    def _data_to_blocks(self, data, count):
        bpc = self.bpc
        bpb = self.bpb
        levels = self.levels
        mask = (1 << bpc) - 1
        blocks = []
        buf = 0
        buf_bits = 0
        pos = 0

        for _ in range(count):
            while buf_bits < bpb and pos < len(data):
                buf = (buf << 8) | data[pos]
                buf_bits += 8
                pos += 1

            if buf_bits >= bpb:
                buf_bits -= bpb
                val = (buf >> buf_bits) & ((1 << bpb) - 1)
            else:
                val = (buf << (bpb - buf_bits)) & ((1 << bpb) - 1)
                buf_bits = 0

            ri = (val >> (bpc * 2)) & mask
            gi = (val >> bpc) & mask
            bi = val & mask
            blocks.append((levels[ri], levels[gi], levels[bi]))

        return blocks

    def _render_frame(self, blocks):
        bs = self.block_size
        parts = []

        for gy in range(self.grid_h):
            row = bytearray(self.width * 3)
            base = gy * self.grid_w
            for gx in range(self.grid_w):
                r, g, b = blocks[base + gx]
                seg = bytes([r, g, b]) * bs
                off = gx * bs * 3
                row[off:off + len(seg)] = seg
            row_b = bytes(row)
            for _ in range(bs):
                parts.append(row_b)

        return b''.join(parts)

    def _build_meta(self, filename, original_size, payload_size,
                    file_hash, is_compressed, is_encrypted, salt):
        m = bytearray()
        m.extend(MAGIC)
        m.append(VERSION)
        m.append(self.block_size)
        m.append(self.bpc)
        m.extend(struct.pack('>H', self.width))
        m.extend(struct.pack('>H', self.height))
        m.append(self.fps)
        m.append(self.repeat)

        flags = 0
        if is_compressed:
            flags |= 0x01
        if is_encrypted:
            flags |= 0x02
        m.append(flags)

        name_b = filename.encode('utf-8')[:255]
        m.append(len(name_b))
        m.extend(name_b)

        m.extend(struct.pack('>Q', original_size))
        m.extend(struct.pack('>Q', payload_size))
        m.extend(file_hash)

        if is_encrypted and salt:
            m.extend(salt)
        else:
            m.extend(b'\x00' * 16)

        crc = zlib.crc32(bytes(m)) & 0xFFFFFFFF
        m.extend(struct.pack('>I', crc))

        if len(m) < self.bytes_per_frame:
            m.extend(b'\x00' * (self.bytes_per_frame - len(m)))

        return bytes(m[:self.bytes_per_frame])

    def encode(self, input_path, output_path, password=None):
        if not os.path.isfile(input_path):
            print(f"  Error: file not found: {input_path}")
            return False

        with open(input_path, 'rb') as f:
            raw_data = f.read()

        fsize = len(raw_data)
        fname = os.path.basename(input_path)
        fhash = file_sha256(raw_data)

        payload, is_compressed = compress_data(raw_data)
        if is_compressed:
            ratio = len(payload) / fsize * 100
            print(f"  Compressed: {fmt_size(fsize)} -> {fmt_size(len(payload))} ({ratio:.0f}%)")

        is_encrypted = False
        salt = b'\x00' * 16
        if password:
            salt = hashlib.sha256(os.urandom(32)).digest()[:16]
            key = derive_key(password, salt, len(payload))
            payload = xor_crypt(payload, key)
            is_encrypted = True
            print(f"  Encrypted:  yes (password protected)")

        payload_size = len(payload)
        data_frames = math.ceil(payload_size / self.bytes_per_frame)
        total_unique_frames = 1 + 1 + data_frames
        total_video_frames = 1 + 1 + data_frames * self.repeat
        duration = total_video_frames / self.fps

        print(f"  File:       {fname}")
        print(f"  Original:   {fmt_size(fsize)}")
        print(f"  Payload:    {fmt_size(payload_size)}")
        print(f"  Mode:       {self.mode}")
        print(f"  Block:      {self.block_size}x{self.block_size}")
        print(f"  Resolution: {self.width}x{self.height}")
        print(f"  Data/frame: {fmt_size(self.bytes_per_frame)}")
        print(f"  Frames:     {total_video_frames} (1 cal + 1 meta + {data_frames}x{self.repeat} data)")
        print(f"  Duration:   ~{fmt_time(duration)} @ {self.fps}fps")
        print(f"  SHA-256:    {fhash.hex()[:16]}...")
        print()

        if self.mode == 'youtube':
            cmd = [
                'ffmpeg', '-y', '-v', 'warning',
                '-f', 'rawvideo',
                '-pix_fmt', 'rgb24',
                '-s', f'{self.width}x{self.height}',
                '-r', str(self.fps),
                '-i', '-',
                '-c:v', 'libx264',
                '-pix_fmt', 'yuv420p',
                '-crf', '18',
                '-preset', 'medium',
                '-tune', 'stillimage',
                '-movflags', '+faststart',
                output_path
            ]
        else:
            cmd = [
                'ffmpeg', '-y', '-v', 'warning',
                '-f', 'rawvideo',
                '-pix_fmt', 'rgb24',
                '-s', f'{self.width}x{self.height}',
                '-r', str(self.fps),
                '-i', '-',
                '-c:v', 'libx264',
                '-pix_fmt', 'yuv444p',
                '-crf', '0',
                '-preset', 'ultrafast',
                '-movflags', '+faststart',
                output_path
            ]

        try:
            proc = subprocess.Popen(
                cmd, stdin=subprocess.PIPE,
                stdout=subprocess.PIPE, stderr=subprocess.PIPE
            )
        except FileNotFoundError:
            print("  Error: ffmpeg not found")
            return False

        t0 = time.time()

        cal_frame = generate_calibration_frame(
            self.width, self.height, self.block_size, self.levels
        )
        proc.stdin.write(cal_frame)

        meta = self._build_meta(
            fname, fsize, payload_size, fhash,
            is_compressed, is_encrypted, salt
        )
        blocks = self._data_to_blocks(meta, self.blocks_per_frame)
        proc.stdin.write(self._render_frame(blocks))

        for i in range(data_frames):
            off = i * self.bytes_per_frame
            chunk = payload[off:off + self.bytes_per_frame]
            if len(chunk) < self.bytes_per_frame:
                chunk += b'\x00' * (self.bytes_per_frame - len(chunk))

            blk = self._data_to_blocks(chunk, self.blocks_per_frame)
            rendered = self._render_frame(blk)

            for _ in range(self.repeat):
                proc.stdin.write(rendered)

            sys.stdout.write(
                f"\r  Encoding: {progress_bar(i + 1, data_frames, t0)} "
            )
            sys.stdout.flush()

        proc.stdin.close()
        stderr = proc.stderr.read()
        proc.wait()

        if proc.returncode != 0:
            print(f"\n  ffmpeg error:\n{stderr.decode()[:500]}")
            return False

        elapsed = time.time() - t0
        vsize = os.path.getsize(output_path)

        print(f"\n\n  Done in {fmt_time(elapsed)}")
        print(f"  Video:  {output_path} ({fmt_size(vsize)})")
        print(f"  SHA-256: {fhash.hex()}")
        return True


class Decoder:
    def __init__(self):
        self._lut_cache = {}

    def _get_lut(self, levels):
        key = tuple(levels)
        if key not in self._lut_cache:
            self._lut_cache[key] = build_lut(levels)
        return self._lut_cache[key]

    def _build_adjusted_lut(self, levels, r_off, g_off, b_off):
        lut_r = [0] * 256
        lut_g = [0] * 256
        lut_b = [0] * 256
        for v in range(256):
            adj_r = max(0, min(255, v - r_off))
            adj_g = max(0, min(255, v - g_off))
            adj_b = max(0, min(255, v - b_off))

            best_r = 0
            best_dr = abs(adj_r - levels[0])
            best_g = 0
            best_dg = abs(adj_g - levels[0])
            best_b = 0
            best_db = abs(adj_b - levels[0])

            for i in range(1, len(levels)):
                dr = abs(adj_r - levels[i])
                dg = abs(adj_g - levels[i])
                db = abs(adj_b - levels[i])
                if dr < best_dr:
                    best_r = i
                    best_dr = dr
                if dg < best_dg:
                    best_g = i
                    best_dg = dg
                if db < best_db:
                    best_b = i
                    best_db = db

            lut_r[v] = best_r
            lut_g[v] = best_g
            lut_b[v] = best_b

        return lut_r, lut_g, lut_b

    def _frame_to_blocks(self, frame, width, height, bs, levels,
                         lut=None, lut_r=None, lut_g=None, lut_b=None):
        if lut is None and lut_r is None:
            lut = self._get_lut(levels)

        grid_w = width // bs
        grid_h = height // bs
        blocks = []
        w3 = width * 3
        half = bs // 2

        if bs >= 6:
            sample_range = range(-2, 3)
        elif bs >= 4:
            sample_range = range(-1, 2)
        else:
            sample_range = range(0, 1)
        sample_count = len(sample_range) ** 2

        use_adjusted = lut_r is not None

        for gy in range(grid_h):
            cy = gy * bs + half
            for gx in range(grid_w):
                cx = gx * bs + half
                r_s = g_s = b_s = 0
                for dy in sample_range:
                    for dx in sample_range:
                        o = (cy + dy) * w3 + (cx + dx) * 3
                        r_s += frame[o]
                        g_s += frame[o + 1]
                        b_s += frame[o + 2]

                ra = r_s // sample_count
                ga = g_s // sample_count
                ba = b_s // sample_count

                if use_adjusted:
                    blocks.append((lut_r[ra], lut_g[ga], lut_b[ba]))
                else:
                    blocks.append((lut[ra], lut[ga], lut[ba]))

        return blocks

    def _blocks_to_data(self, blocks, bpc):
        bpb = bpc * 3
        buf = 0
        buf_bits = 0
        result = bytearray()

        for ri, gi, bi in blocks:
            val = (ri << (bpc * 2)) | (gi << bpc) | bi
            buf = (buf << bpb) | val
            buf_bits += bpb
            while buf_bits >= 8:
                buf_bits -= 8
                result.append((buf >> buf_bits) & 0xFF)

        return bytes(result)

    def _merge_repeated_frames(self, frames_data, width, height, bs, levels,
                               bpc, repeat, lut_r=None, lut_g=None, lut_b=None):
        if repeat <= 1:
            return self._frame_to_blocks(
                frames_data[0], width, height, bs, levels,
                lut_r=lut_r, lut_g=lut_g, lut_b=lut_b
            )

        grid_w = width // bs
        grid_h = height // bs
        n_blocks = grid_w * grid_h

        all_blocks = []
        for fd in frames_data:
            blk = self._frame_to_blocks(
                fd, width, height, bs, levels,
                lut_r=lut_r, lut_g=lut_g, lut_b=lut_b
            )
            all_blocks.append(blk)

        merged = []
        for bi in range(n_blocks):
            votes_r = {}
            votes_g = {}
            votes_b = {}
            for blk in all_blocks:
                ri, gi, bii = blk[bi]
                votes_r[ri] = votes_r.get(ri, 0) + 1
                votes_g[gi] = votes_g.get(gi, 0) + 1
                votes_b[bii] = votes_b.get(bii, 0) + 1

            best_r = max(votes_r, key=votes_r.get)
            best_g = max(votes_g, key=votes_g.get)
            best_b = max(votes_b, key=votes_b.get)
            merged.append((best_r, best_g, best_b))

        return merged

    def _try_decode_meta(self, frame, width, height, bs, levels, bpc,
                         lut_r=None, lut_g=None, lut_b=None):
        grid_w = width // bs
        grid_h = height // bs
        if grid_w < 4 or grid_h < 4:
            return None

        blocks = self._frame_to_blocks(
            frame, width, height, bs, levels,
            lut_r=lut_r, lut_g=lut_g, lut_b=lut_b
        )
        data = self._blocks_to_data(blocks, bpc)

        if len(data) < 4 or data[:4] != MAGIC:
            return None

        try:
            p = 4
            ver = data[p]; p += 1
            mbs = data[p]; p += 1
            mbpc = data[p]; p += 1
            mw = struct.unpack('>H', data[p:p+2])[0]; p += 2
            mh = struct.unpack('>H', data[p:p+2])[0]; p += 2
            mfps = data[p]; p += 1

            if ver >= 3:
                repeat = data[p]; p += 1
                flags = data[p]; p += 1
                is_compressed = bool(flags & 0x01)
                is_encrypted = bool(flags & 0x02)
            else:
                repeat = 1
                is_compressed = False
                is_encrypted = False

            name_len = data[p]; p += 1
            if name_len == 0 or p + name_len > len(data):
                return None
            fname = data[p:p+name_len].decode('utf-8'); p += name_len

            if p + 8 > len(data):
                return None
            original_size = struct.unpack('>Q', data[p:p+8])[0]; p += 8

            if ver >= 3:
                if p + 8 > len(data):
                    return None
                payload_size = struct.unpack('>Q', data[p:p+8])[0]; p += 8
            else:
                payload_size = original_size

            if p + 32 > len(data):
                return None
            fhash = data[p:p+32]; p += 32

            if ver >= 3:
                if p + 16 > len(data):
                    return None
                salt = data[p:p+16]; p += 16
            else:
                salt = b'\x00' * 16

            if p + 4 > len(data):
                return None
            stored_crc = struct.unpack('>I', data[p:p+4])[0]; p += 4

            meta_bytes = data[:p-4]
            calc_crc = zlib.crc32(bytes(meta_bytes)) & 0xFFFFFFFF
            if calc_crc != stored_crc:
                return None

            if original_size == 0 or original_size > 2 * 1024 * 1024 * 1024:
                return None

            return {
                'version': ver,
                'block_size': mbs,
                'bpc': mbpc,
                'width': mw,
                'height': mh,
                'fps': mfps,
                'repeat': repeat,
                'is_compressed': is_compressed,
                'is_encrypted': is_encrypted,
                'filename': fname,
                'original_size': original_size,
                'payload_size': payload_size,
                'file_hash': fhash,
                'salt': salt,
            }
        except Exception:
            return None

    def _probe_video(self, path):
        cmd = [
            'ffprobe', '-v', 'quiet',
            '-print_format', 'json',
            '-show_streams', path
        ]
        try:
            r = subprocess.run(cmd, capture_output=True, text=True, timeout=30)
            info = json.loads(r.stdout)
            for s in info.get('streams', []):
                if s.get('codec_type') == 'video':
                    return int(s['width']), int(s['height'])
        except Exception:
            pass
        return None, None

    def decode(self, input_path, output_dir='.', verify_only=False, password=None):
        if not os.path.isfile(input_path):
            print(f"  Error: file not found: {input_path}")
            return False

        w, h = self._probe_video(input_path)
        if not w:
            print("  Error: cannot read video dimensions")
            return False

        print(f"  Video: {w}x{h}")

        cmd = [
            'ffmpeg', '-i', input_path,
            '-f', 'rawvideo',
            '-pix_fmt', 'rgb24',
            '-v', 'quiet', '-'
        ]
        proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE)

        frame_size = w * h * 3

        cal_frame = proc.stdout.read(frame_size)
        if len(cal_frame) < frame_size:
            print("  Error: cannot read calibration frame")
            proc.kill()
            return False

        meta_frame = proc.stdout.read(frame_size)
        if len(meta_frame) < frame_size:
            print("  Error: cannot read metadata frame")
            proc.kill()
            return False

        meta = None
        r_off = g_off = b_off = 0
        cal_error = 0.0

        for bs in (8, 4, 16, 6, 10, 12, 2):
            for bpc, lvls in ((2, YT_LEVELS), (3, LOCAL_LEVELS)):
                meta = self._try_decode_meta(meta_frame, w, h, bs, lvls, bpc)
                if meta:
                    r_off, g_off, b_off, cal_error = detect_calibration_shift(
                        cal_frame, w, h, bs, lvls
                    )
                    break
            if meta:
                break

        if not meta and cal_frame:
            for bs in (8, 4, 16, 6, 10, 12, 2):
                for bpc, lvls in ((2, YT_LEVELS), (3, LOCAL_LEVELS)):
                    r_off, g_off, b_off, cal_error = detect_calibration_shift(
                        cal_frame, w, h, bs, lvls
                    )
                    if abs(r_off) > 2 or abs(g_off) > 2 or abs(b_off) > 2:
                        lut_r, lut_g, lut_b = self._build_adjusted_lut(
                            lvls, r_off, g_off, b_off
                        )
                        meta = self._try_decode_meta(
                            meta_frame, w, h, bs, lvls, bpc,
                            lut_r=lut_r, lut_g=lut_g, lut_b=lut_b
                        )
                        if meta:
                            break
                if meta:
                    break

        if not meta:
            old_cal = meta_frame
            old_meta = proc.stdout.read(frame_size)
            if len(old_meta) >= frame_size:
                for bs in (8, 4, 16, 6, 10, 12, 2):
                    for bpc, lvls in ((2, YT_LEVELS), (3, LOCAL_LEVELS)):
                        meta = self._try_decode_meta(old_cal, w, h, bs, lvls, bpc)
                        if meta:
                            break
                    if meta:
                        break

        if not meta:
            print("  Error: not a FileVault video (metadata not found)")
            proc.kill()
            return False

        bs = meta['block_size']
        bpc = meta['bpc']
        levels = YT_LEVELS if bpc == 2 else LOCAL_LEVELS
        fname = meta['filename']
        original_size = meta['original_size']
        payload_size = meta['payload_size']
        fhash = meta['file_hash']
        repeat = meta.get('repeat', 1)
        is_compressed = meta.get('is_compressed', False)
        is_encrypted = meta.get('is_encrypted', False)
        salt = meta.get('salt', b'\x00' * 16)

        lut_r_adj = lut_g_adj = lut_b_adj = None
        if abs(r_off) > 2 or abs(g_off) > 2 or abs(b_off) > 2:
            lut_r_adj, lut_g_adj, lut_b_adj = self._build_adjusted_lut(
                levels, r_off, g_off, b_off
            )
            print(f"  Color adj: R{r_off:+d} G{g_off:+d} B{b_off:+d} (error: {cal_error*100:.1f}%)")

        bpb = bpc * 3
        grid_w = w // bs
        grid_h = h // bs
        bpf_count = grid_w * grid_h
        bytes_per_frame = (bpf_count * bpb) // 8
        need_frames = math.ceil(payload_size / bytes_per_frame)

        print(f"  File:       {fname}")
        print(f"  Original:   {fmt_size(original_size)}")
        print(f"  Payload:    {fmt_size(payload_size)}")
        print(f"  Block:      {bs}x{bs}")
        print(f"  Mode:       {'youtube' if bpc == 2 else 'local'}")
        print(f"  Repeat:     {repeat}x")
        if is_compressed:
            print(f"  Compressed: yes")
        if is_encrypted:
            print(f"  Encrypted:  yes")
        print(f"  Frames:     {need_frames}")
        print()

        if is_encrypted and not password:
            print("  Error: this file is password-protected.")
            print("  Use:  python3 filevault.py decode video.mp4 -p YOUR_PASSWORD")
            proc.kill()
            return False

        t0 = time.time()
        all_data = bytearray()
        count = 0

        while count < need_frames:
            if repeat > 1:
                rep_frames = []
                for _ in range(repeat):
                    chunk = proc.stdout.read(frame_size)
                    if len(chunk) < frame_size:
                        break
                    rep_frames.append(chunk)

                if not rep_frames:
                    break

                blk = self._merge_repeated_frames(
                    rep_frames, w, h, bs, levels, bpc, repeat,
                    lut_r=lut_r_adj, lut_g=lut_g_adj, lut_b=lut_b_adj
                )
            else:
                chunk = proc.stdout.read(frame_size)
                if len(chunk) < frame_size:
                    break
                blk = self._frame_to_blocks(
                    chunk, w, h, bs, levels,
                    lut_r=lut_r_adj, lut_g=lut_g_adj, lut_b=lut_b_adj
                )

            all_data.extend(self._blocks_to_data(blk, bpc))
            count += 1

            sys.stdout.write(
                f"\r  Decoding: {progress_bar(count, need_frames, t0)} "
            )
            sys.stdout.flush()

        proc.kill()
        proc.wait()

        if count < need_frames:
            print(f"\n  Warning: got {count}/{need_frames} frames")

        payload = bytes(all_data[:payload_size])

        if is_encrypted:
            key = derive_key(password, salt, len(payload))
            payload = xor_crypt(payload, key)

        try:
            file_data = decompress_data(payload, is_compressed)
        except zlib.error:
            print("\n\n  Error: decompression failed.")
            if is_encrypted:
                print("  This usually means the password is wrong.")
            return False

        actual_hash = file_sha256(file_data)
        ok = actual_hash == fhash

        print()
        if ok:
            print(f"\n  Checksum: OK")
        else:
            print(f"\n  WARNING: checksum MISMATCH!")
            print(f"  Expected: {fhash.hex()}")
            print(f"  Got:      {actual_hash.hex()}")
            if is_encrypted:
                print("  Wrong password? Try again with the correct password.")
            else:
                print("  The file may be corrupted after YouTube re-encoding.")
                print("  Try: download at original resolution, or use --repeat 3 when encoding.")

        if verify_only:
            elapsed = time.time() - t0
            print(f"  Time: {fmt_time(elapsed)}")
            return ok

        os.makedirs(output_dir, exist_ok=True)
        out_path = os.path.join(output_dir, fname)
        if os.path.exists(out_path):
            base, ext = os.path.splitext(fname)
            c = 1
            while os.path.exists(out_path):
                out_path = os.path.join(output_dir, f"{base}_{c}{ext}")
                c += 1

        with open(out_path, 'wb') as f:
            f.write(file_data)

        elapsed = time.time() - t0
        print(f"  Saved: {out_path}")
        print(f"  Size:  {fmt_size(len(file_data))}")
        print(f"  Time:  {fmt_time(elapsed)}")
        return ok

    def info(self, input_path):
        if not os.path.isfile(input_path):
            print(f"  Error: file not found: {input_path}")
            return False

        w, h = self._probe_video(input_path)
        if not w:
            print("  Error: cannot read video")
            return False

        cmd = [
            'ffmpeg', '-i', input_path,
            '-frames:v', '2',
            '-f', 'rawvideo',
            '-pix_fmt', 'rgb24',
            '-v', 'quiet', '-'
        ]
        try:
            r = subprocess.run(cmd, capture_output=True, timeout=30)
            raw = r.stdout
        except Exception:
            print("  Error: cannot extract frames")
            return False

        frame_size = w * h * 3

        if len(raw) >= frame_size * 2:
            cal_frame = raw[:frame_size]
            meta_frame_data = raw[frame_size:frame_size*2]
        elif len(raw) >= frame_size:
            cal_frame = None
            meta_frame_data = raw[:frame_size]
        else:
            print("  Error: incomplete frame data")
            return False

        meta = None
        for bs in (8, 4, 16, 6, 10, 12, 2):
            for bpc, lvls in ((2, YT_LEVELS), (3, LOCAL_LEVELS)):
                meta = self._try_decode_meta(meta_frame_data, w, h, bs, lvls, bpc)
                if meta:
                    break
            if meta:
                break

        if not meta and cal_frame:
            for bs in (8, 4, 16, 6, 10, 12, 2):
                for bpc, lvls in ((2, YT_LEVELS), (3, LOCAL_LEVELS)):
                    meta = self._try_decode_meta(cal_frame, w, h, bs, lvls, bpc)
                    if meta:
                        break
                if meta:
                    break

        if not meta:
            print("  Not a FileVault video")
            return False

        bpb = meta['bpc'] * 3
        grid_w = w // meta['block_size']
        grid_h = h // meta['block_size']
        bpf = (grid_w * grid_h * bpb) // 8
        repeat = meta.get('repeat', 1)
        nf = math.ceil(meta['payload_size'] / bpf)

        print(f"  FileVault v{meta['version']}")
        print(f"  File:       {meta['filename']}")
        print(f"  Original:   {fmt_size(meta['original_size'])}")
        print(f"  Payload:    {fmt_size(meta['payload_size'])}")
        print(f"  SHA-256:    {meta['file_hash'].hex()}")
        print(f"  Video:      {meta['width']}x{meta['height']}")
        print(f"  Block:      {meta['block_size']}x{meta['block_size']}")
        print(f"  Mode:       {'youtube' if meta['bpc'] == 2 else 'local'}")
        print(f"  Data/frame: {fmt_size(bpf)}")
        print(f"  Repeat:     {repeat}x")
        print(f"  Compressed: {'yes' if meta.get('is_compressed') else 'no'}")
        print(f"  Encrypted:  {'yes' if meta.get('is_encrypted') else 'no'}")
        print(f"  Frames:     {nf * repeat + 2} (1 cal + 1 meta + {nf}x{repeat} data)")

        if cal_frame:
            r_off, g_off, b_off, err = detect_calibration_shift(
                cal_frame, w, h, meta['block_size'],
                YT_LEVELS if meta['bpc'] == 2 else LOCAL_LEVELS
            )
            if abs(r_off) > 0 or abs(g_off) > 0 or abs(b_off) > 0:
                print(f"  Color shift: R{r_off:+d} G{g_off:+d} B{b_off:+d}")
                print(f"  Block error: {err*100:.1f}%")

        return True


def main():
    parser = argparse.ArgumentParser(
        prog='filevault',
        description=BANNER + '\n  Encode any file into a real H.264 video.\n  Upload to YouTube, download later, decode back.',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            'examples:\n'
            '  python3 filevault.py encode secret.pdf\n'
            '  python3 filevault.py encode secret.pdf -p mypassword\n'
            '  python3 filevault.py encode data.zip video.mp4 --repeat 3\n'
            '  python3 filevault.py encode big.bin --mode local\n'
            '  python3 filevault.py decode video.mp4\n'
            '  python3 filevault.py decode video.mp4 -p mypassword\n'
            '  python3 filevault.py decode video.mp4 ./recovered/\n'
            '  python3 filevault.py info video.mp4\n'
            '  python3 filevault.py verify video.mp4\n'
        )
    )
    sub = parser.add_subparsers(dest='cmd')

    p_enc = sub.add_parser('encode', help='Encode file into video')
    p_enc.add_argument('input', help='Input file path')
    p_enc.add_argument('output', nargs='?', help='Output .mp4 path (default: <input>.mp4)')
    p_enc.add_argument(
        '-m', '--mode', choices=['youtube', 'local'],
        default='youtube',
        help='youtube = YouTube-safe (default), local = lossless/fast'
    )
    p_enc.add_argument(
        '-b', '--block-size', type=int, default=None,
        help='Pixel block size (default: 8 for youtube, 4 for local)'
    )
    p_enc.add_argument(
        '-r', '--resolution', default='640x480',
        help='Video resolution WxH (default: 640x480)'
    )
    p_enc.add_argument(
        '--fps', type=int, default=10,
        help='Frames per second (default: 10)'
    )
    p_enc.add_argument(
        '--repeat', type=int, default=1,
        help='Repeat each data frame N times for YouTube resilience (default: 1)'
    )
    p_enc.add_argument(
        '-p', '--password', default=None,
        help='Encrypt file with password'
    )

    p_dec = sub.add_parser('decode', help='Decode video back to original file')
    p_dec.add_argument('input', help='Input video file')
    p_dec.add_argument('output', nargs='?', default='.', help='Output directory (default: .)')
    p_dec.add_argument(
        '-p', '--password', default=None,
        help='Decryption password (if file was encrypted)'
    )

    p_inf = sub.add_parser('info', help='Show FileVault video metadata')
    p_inf.add_argument('input', help='Input video file')

    p_ver = sub.add_parser('verify', help='Decode and verify checksum (no file saved)')
    p_ver.add_argument('input', help='Input video file')
    p_ver.add_argument(
        '-p', '--password', default=None,
        help='Decryption password (if file was encrypted)'
    )

    args = parser.parse_args()

    if not args.cmd:
        print(BANNER)
        parser.print_help()
        sys.exit(1)

    if not check_ffmpeg():
        print(BANNER)
        print("  ffmpeg not found! Install it:\n")
        print("    Ubuntu/Debian:  sudo apt install ffmpeg")
        print("    macOS:          brew install ffmpeg")
        print("    iSH (iPhone):   apk add ffmpeg")
        print("    Arch Linux:     sudo pacman -S ffmpeg")
        print("    Fedora:         sudo dnf install ffmpeg")
        print("    Windows:        https://ffmpeg.org/download.html")
        print()
        sys.exit(1)

    print(BANNER)

    if args.cmd == 'encode':
        w, h = map(int, args.resolution.split('x'))
        out = args.output or (os.path.splitext(args.input)[0] + '.mp4')
        enc = Encoder(args.block_size, args.mode, w, h, args.fps, args.repeat)
        ok = enc.encode(args.input, out, password=args.password)
        sys.exit(0 if ok else 1)

    elif args.cmd == 'decode':
        dec = Decoder()
        ok = dec.decode(args.input, args.output, password=args.password)
        sys.exit(0 if ok else 1)

    elif args.cmd == 'info':
        dec = Decoder()
        ok = dec.info(args.input)
        sys.exit(0 if ok else 1)

    elif args.cmd == 'verify':
        dec = Decoder()
        ok = dec.decode(args.input, verify_only=True,
                        password=getattr(args, 'password', None))
        sys.exit(0 if ok else 1)


if __name__ == '__main__':
    main()
