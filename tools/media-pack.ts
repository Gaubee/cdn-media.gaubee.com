// media-pack.ts — cdn-media Phase 0 打包工具（Bun + TypeScript，零第三方依赖）
//
// 用法:
//   bun cdn-media/tools/media-pack.ts --initial
//       扫描主仓 static/x-media，按 YYYY-MM 目录聚簇，产出每卷 ≤200MiB 的未压缩 USTAR
//       tar 卷（512 字节块对齐；成员路径 = canonical media key: x/<YYYY-MM>/<file>），
//       卷名 vol-<YYYY-MM>-<seq>.tar（seq 从 1 起，三位零填充），输出到 cdn-media/staging。
//       同时生成 manifest/manifest-<gen>.json（gen 从 1 起）并更新 manifest/current.json。
//   bun cdn-media/tools/media-pack.ts --verify
//       本地恢复演练：拉 current.json → 拉 manifest-<gen>.json（校验 sha256）→ 校验每卷
//       sha256 → 按对象 offset/size 从卷中解包恢复到 cdn-media/staging/.verify-restore →
//       与源目录全量逐一 sha256 对账。
//
// 契约引用:
//   openspec/changes/cdn-media-bootstrap/plan.md — Stage A 契约 A1（tar 卷格式与 manifest
//   字段）、A2（manifest 发布机制：manifest-<gen>.json + current.json 指针）。
//   openspec/specs/cdn-media/spec.md — R4（GitHub Releases 源：卷格式冻结、offset 语义、
//   每月 release 的 asset 数上限）。
//
// manifest-<gen>.json 字段:
//   format_version=1；objects 每项 {key, volume, offset（数据起始字节偏移，即位于 512 字节
//   头之后、上个成员 padding 之后的第一个数据字节）, size, sha256, content_type, width,
//   height, duration_ms}——宽高与时长不可得时省略对应字段；volumes 每项
//   {name, size, sha256, asset_name}。
// current.json 字段:
//   {gen, manifest_sha256, volumes: [{asset_id, url, sha256, name}]}——asset_id 与 url 是
//   上传阶段（Phase 0.2）才回填的占位 null，字段结构在本阶段就位。
//
// 宽高与时长元数据:
//   优先读 ~/.gaubee-skills/data/sources/x-likes/media-meta.json（键为 x-media/<月>/<文件>，
//   值 {w, h, ms}）；缺失条目回退 ffprobe；仍不可得则省略字段。
//
// 工程约束:
//   - 流式 sha256（分块读取，不整读内存）；tar 头手工构造（ustar；name ≤100 字节，超限按
//     斜杠边界拆进 prefix 字段 ≤155 字节；mode 0644；typeflag '0'；校验和按标准规则：
//     校验和字段先填 8 个空格再对整头 512 字节求和）。
//   - 打包前预检：每个按月 release 的卷（asset）数 ≤1000，超限直接失败退出。
//   - 幂等可重入：staging 已有同名卷、且其尺寸与既有 manifest 记录一致、实际 sha256 与
//     记录一致时，跳过重打包直接复用记录；内容完全相同的重复运行不产生新 gen。
//   - 卷硬限 200MiB = 209715200 字节（含 1024 字节 tar 结束标记；单文件超限即失败）。

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import * as path from "node:path";

const TOOLS_DIR = import.meta.dir;
const MEDIA_REPO = path.resolve(TOOLS_DIR, "..");
const MAIN_ROOT = path.resolve(MEDIA_REPO, "..");
const SRC_DIR = path.join(MAIN_ROOT, "static", "x-media");
const STAGING = path.join(MEDIA_REPO, "staging");
const MANIFEST_DIR = path.join(MEDIA_REPO, "manifest");
const META_PATH = path.join(homedir(), ".gaubee-skills", "data", "sources", "x-likes", "media-meta.json");
const RESTORE_DIR = path.join(STAGING, ".verify-restore");

const BLOCK = 512;
const END_MARK = 1024;
const VOL_LIMIT = 200 * 1024 * 1024;
const ASSET_MAX_PER_RELEASE = 1000;
const GEN_KEEP = 10;

const encoder = new TextEncoder();
const ZERO_BLOCK = new Uint8Array(BLOCK);

type FileEntry = { rel: string; abs: string; size: number; mtimeSec: number };
type Member = { key: string; entry: FileEntry; dataOffset: number };
type PlannedVol = { name: string; month: string; members: Member[]; finalSize: number };
type ObjRec = {
  key: string; volume: string; offset: number; size: number; sha256: string; content_type: string;
  width?: number; height?: number; duration_ms?: number;
};
type VolRec = { name: string; size: number; sha256: string; asset_name: string };
type Manifest = { format_version: number; gen: number; objects: ObjRec[]; volumes: VolRec[] };

function log(msg: string): void { console.log(msg); }
function die(msg: string): never {
  console.error(`[media-pack] 错误: ${msg}`);
  process.exit(1);
}

function pad512(n: number): number { return (BLOCK - (n % BLOCK)) % BLOCK; }

function volName(month: string, seq: number): string {
  return `vol-${month}-${String(seq).padStart(3, "0")}.tar`;
}

async function hashFile(p: string): Promise<string> {
  const hasher = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(p).stream()) hasher.update(chunk as Uint8Array);
  return hasher.digest("hex");
}

function sha256Bytes(s: string): string {
  const hasher = new Bun.CryptoHasher("sha256");
  hasher.update(encoder.encode(s));
  return hasher.digest("hex");
}

// ---------- ustar 头（手工构造） ----------

function octal(v: number, digits: number, tail: string): string {
  return v.toString(8).padStart(digits, "0") + tail;
}

function setStr(h: Uint8Array, off: number, len: number, s: string): void {
  const b = encoder.encode(s);
  if (b.length > len) die(`tar 头字段 @${off} 溢出（需 ${b.length} 字节 > ${len}）`);
  h.set(b, off);
}

function buildUstarHeader(p: string, size: number, mtimeSec: number): Uint8Array {
  const h = new Uint8Array(BLOCK);
  let name = p;
  let prefix = "";
  if (encoder.encode(p).length > 100) {
    // 超长路径按斜杠边界拆分：prefix ≤155 字节、name ≤100 字节，取最靠后的合法切点
    let best = -1;
    for (let i = 0; i < p.length; i++) {
      if (p.charCodeAt(i) !== 47) continue;
      if (encoder.encode(p.slice(0, i)).length <= 155 && encoder.encode(p.slice(i + 1)).length <= 100) best = i;
    }
    if (best < 0) die(`路径无法按 ustar name+prefix 拆分: ${p}`);
    prefix = p.slice(0, best);
    name = p.slice(best + 1);
  }
  setStr(h, 0, 100, name);
  setStr(h, 100, 8, octal(0o644, 7, "\0"));    // mode 0644
  setStr(h, 108, 8, octal(0, 7, "\0"));        // uid
  setStr(h, 116, 8, octal(0, 7, "\0"));        // gid
  setStr(h, 124, 12, octal(size, 11, "\0"));   // size
  setStr(h, 136, 12, octal(mtimeSec, 11, "\0"));
  for (let i = 148; i < 156; i++) h[i] = 32;   // chksum 占位：8 个空格
  h[156] = 48;                                 // typeflag '0'（常规文件）
  setStr(h, 257, 6, "ustar");                  // magic，尾随 NUL 由零填充提供
  setStr(h, 263, 2, "00");                     // version
  if (prefix) setStr(h, 345, 155, prefix);
  let sum = 0;
  for (let i = 0; i < BLOCK; i++) sum += h[i];
  setStr(h, 148, 8, octal(sum, 6, "\0 "));     // 6 位八进制 + NUL + 空格
  return h;
}

// ---------- 扫描与规划 ----------

function scanSource(): Map<string, FileEntry[]> {
  if (!existsSync(SRC_DIR)) die(`源目录不存在: ${SRC_DIR}`);
  const months = new Map<string, FileEntry[]>();
  for (const month of readdirSync(SRC_DIR).sort()) {
    const mdir = path.join(SRC_DIR, month);
    if (!statSync(mdir).isDirectory()) continue;
    if (!/^\d{4}-\d{2}$/.test(month)) die(`非法月份目录名: ${month}`);
    const files: FileEntry[] = [];
    for (const name of readdirSync(mdir).sort()) {
      const abs = path.join(mdir, name);
      const fst = statSync(abs);
      if (!fst.isFile()) die(`非常规文件，拒绝入卷: ${abs}`);
      if (name.includes("/") || encoder.encode(`${month}/${name}`).length > 260) {
        die(`成员名非法或过长: ${abs}`);
      }
      files.push({ rel: `${month}/${name}`, abs, size: fst.size, mtimeSec: Math.floor(fst.mtimeMs / 1000) });
    }
    months.set(month, files);
  }
  return months;
}

function planVolumes(months: Map<string, FileEntry[]>): PlannedVol[] {
  const vols: PlannedVol[] = [];
  for (const month of [...months.keys()].sort()) {
    const files = months.get(month)!;
    let seq = 0;
    let cur: PlannedVol | null = null;
    let used = 0;
    for (const f of files) {
      const cost = BLOCK + f.size + pad512(f.size);
      if (cost + END_MARK > VOL_LIMIT) {
        die(`单文件超出卷硬限（${f.rel}，${f.size} 字节 > 上限 ${VOL_LIMIT - END_MARK}）`);
      }
      if (!cur || used + cost + END_MARK > VOL_LIMIT) {
        seq += 1;
        cur = { name: volName(month, seq), month, members: [], finalSize: END_MARK };
        used = 0;
        vols.push(cur);
      }
      cur.members.push({ key: `x/${f.rel}`, entry: f, dataOffset: used + BLOCK });
      used += cost;
      cur.finalSize = used + END_MARK;
    }
  }
  return vols;
}

// ---------- 尺寸元数据 ----------

function ffprobeDims(abs: string): { w?: number; h?: number; ms?: number } {
  try {
    const r = Bun.spawnSync([
      "ffprobe", "-v", "error", "-print_format", "json",
      "-show_entries", "stream=width,height:format=duration", abs,
    ]);
    if (!r.success) return {};
    const j = JSON.parse(r.stdout.toString());
    const stream = (j.streams || []).find(
      (s: any) => typeof s?.width === "number" && typeof s?.height === "number"
    );
    const out: { w?: number; h?: number; ms?: number } = {};
    if (stream) { out.w = stream.width; out.h = stream.height; }
    const dur = j?.format?.duration;
    if (typeof dur === "string" && Number.isFinite(parseFloat(dur))) {
      out.ms = Math.round(parseFloat(dur) * 1000);
    }
    return out;
  } catch {
    return {};
  }
}

class MetaSource {
  map: Map<string, any>;
  hits = 0;
  fallback = 0;
  omitted = 0;
  msCount = 0;

  constructor() {
    this.map = new Map();
    if (existsSync(META_PATH)) {
      const raw = JSON.parse(readFileSync(META_PATH, "utf8"));
      for (const k of Object.keys(raw)) this.map.set(k, raw[k]);
    }
  }

  metaFor(m: Member): { width?: number; height?: number; duration_ms?: number } {
    let v = this.map.get(`x-media/${m.entry.rel}`);
    if (!v || typeof v.w !== "number" || typeof v.h !== "number") {
      v = ffprobeDims(m.entry.abs);
      this.fallback += 1;
    } else {
      this.hits += 1;
    }
    const out: { width?: number; height?: number; duration_ms?: number } = {};
    if (v && typeof v.w === "number" && typeof v.h === "number") {
      out.width = v.w;
      out.height = v.h;
    } else {
      this.omitted += 1;
    }
    if (v && typeof v.ms === "number") {
      out.duration_ms = v.ms;
      this.msCount += 1;
    }
    return out;
  }
}

const CONTENT_TYPES: Record<string, string> = {
  jpg: "image/jpeg", jpeg: "image/jpeg", png: "image/png", gif: "image/gif",
  webp: "image/webp", avif: "image/avif", svg: "image/svg+xml",
  mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", mov: "video/quicktime",
  mp3: "audio/mpeg", m4a: "audio/mp4", ogg: "audio/ogg", wav: "audio/wav",
  pdf: "application/pdf",
};

function contentType(key: string): string {
  const i = key.lastIndexOf(".");
  const ext = i >= 0 ? key.slice(i + 1).toLowerCase() : "";
  return CONTENT_TYPES[ext] || "application/octet-stream";
}

// ---------- 既有 manifest 载入（幂等复用用） ----------

function loadCurrentManifest(): { gen: number; manifestPath: string; manifest: Manifest } | null {
  const curPath = path.join(MANIFEST_DIR, "current.json");
  if (!existsSync(curPath)) return null;
  try {
    const cur = JSON.parse(readFileSync(curPath, "utf8"));
    const mp = path.join(MANIFEST_DIR, `manifest-${cur.gen}.json`);
    if (!existsSync(mp) || typeof cur.gen !== "number") return null;
    const manifest = JSON.parse(readFileSync(mp, "utf8"));
    if (manifest.format_version !== 1) return null;
    return { gen: cur.gen, manifestPath: mp, manifest };
  } catch {
    return null;
  }
}

// ---------- 打包 ----------

async function packVolume(vol: PlannedVol, objectsOut: ObjRec[], meta: MetaSource): Promise<VolRec> {
  const volPath = path.join(STAGING, vol.name);
  if (existsSync(volPath)) rmSync(volPath);
  const sink = Bun.file(volPath).writer({ highWaterMark: 4 * 1024 * 1024 });
  const volHash = new Bun.CryptoHasher("sha256");
  let cursor = 0;
  const emit = (buf: Uint8Array): void => {
    sink.write(buf);
    volHash.update(buf);
    cursor += buf.byteLength;
  };
  for (const m of vol.members) {
    const header = buildUstarHeader(m.key, m.entry.size, m.entry.mtimeSec);
    const dataOffset = cursor + BLOCK;
    if (dataOffset !== m.dataOffset) {
      die(`offset 规划偏差 ${m.key}: plan=${m.dataOffset} actual=${dataOffset}`);
    }
    emit(header);
    const fileHash = new Bun.CryptoHasher("sha256");
    let written = 0;
    for await (const chunk of Bun.file(m.entry.abs).stream()) {
      const c = chunk as Uint8Array;
      fileHash.update(c);
      emit(c);
      written += c.byteLength;
    }
    if (written !== m.entry.size) {
      die(`成员字节数与 stat 不符（打包中源文件被改动？）: ${m.key} stat=${m.entry.size} read=${written}`);
    }
    const pad = pad512(m.entry.size);
    if (pad > 0) emit(ZERO_BLOCK.subarray(0, pad));
    objectsOut.push({
      key: m.key,
      volume: vol.name,
      offset: dataOffset,
      size: m.entry.size,
      sha256: fileHash.digest("hex"),
      content_type: contentType(m.key),
      ...meta.metaFor(m),
    });
  }
  emit(new Uint8Array(END_MARK));
  await sink.end();
  if (cursor !== vol.finalSize) {
    die(`卷尺寸规划偏差 ${vol.name}: plan=${vol.finalSize} actual=${cursor}`);
  }
  return { name: vol.name, size: cursor, sha256: volHash.digest("hex"), asset_name: vol.name };
}

async function runInitial(): Promise<void> {
  mkdirSync(STAGING, { recursive: true });
  mkdirSync(MANIFEST_DIR, { recursive: true });

  const months = scanSource();
  let totalFiles = 0;
  let totalBytes = 0;
  for (const files of months.values()) {
    for (const f of files) { totalFiles += 1; totalBytes += f.size; }
  }
  log(`[initial] 扫描 static/x-media: ${totalFiles} 文件, ${totalBytes} 字节, ${months.size} 个月份组`);

  const plan = planVolumes(months);

  // 打包前预检：每个按月 release 的卷（asset）数 ≤1000
  const perMonth = new Map<string, number>();
  for (const v of plan) perMonth.set(v.month, (perMonth.get(v.month) || 0) + 1);
  let maxMonth = "";
  let maxN = 0;
  for (const [month, n] of perMonth) {
    if (n > ASSET_MAX_PER_RELEASE) die(`预检失败: ${month} 需 ${n} 卷（asset），超过每 release ${ASSET_MAX_PER_RELEASE} 上限`);
    if (n > maxN) { maxN = n; maxMonth = month; }
  }
  log(`[initial] 预检通过: 每月卷数 ≤${ASSET_MAX_PER_RELEASE}（最密集 ${maxMonth}: ${maxN} 卷）, 共 ${plan.length} 卷`);

  const old = loadCurrentManifest();
  const oldVols = new Map<string, VolRec>();
  const oldObjs = new Map<string, ObjRec[]>();
  if (old) {
    for (const v of old.manifest.volumes) oldVols.set(v.name, v);
    for (const o of old.manifest.objects) {
      const list = oldObjs.get(o.volume);
      if (list) list.push(o); else oldObjs.set(o.volume, [o]);
    }
  }

  const meta = new MetaSource();
  const objects: ObjRec[] = [];
  const volumes: VolRec[] = [];
  let packed = 0;
  let reused = 0;

  for (const v of plan) {
    const rec = oldVols.get(v.name);
    let skipped = false;
    if (rec && rec.size === v.finalSize) {
      const objs = oldObjs.get(v.name) || [];
      const layoutOk = objs.length === v.members.length && objs.every(
        (o, i) => o.key === v.members[i].key
          && o.size === v.members[i].entry.size
          && o.offset === v.members[i].dataOffset
      );
      const volPath = path.join(STAGING, v.name);
      if (layoutOk && existsSync(volPath) && statSync(volPath).size === rec.size) {
        const sha = await hashFile(volPath);
        if (sha === rec.sha256) {
          for (let i = 0; i < v.members.length; i++) {
            const m = v.members[i];
            objects.push({
              key: m.key,
              volume: v.name,
              offset: m.dataOffset,
              size: m.entry.size,
              sha256: objs[i].sha256,
              content_type: contentType(m.key),
              ...meta.metaFor(m),
            });
          }
          volumes.push(rec);
          reused += 1;
          log(`[skip] ${v.name}（staging 同名且 sha256 一致，${v.members.length} 成员复用）`);
          skipped = true;
        }
      }
    }
    if (!skipped) {
      const vr = await packVolume(v, objects, meta);
      volumes.push(vr);
      packed += 1;
      log(`[pack] ${v.name} ${vr.size} bytes, ${v.members.length} 成员, sha256=${vr.sha256}`);
    }
  }

  // 清理本次规划之外的孤儿卷（同命名模式的旧产物），避免污染上传阶段
  const plannedNames = new Set(plan.map((v) => v.name));
  for (const f of readdirSync(STAGING)) {
    if (/^vol-\d{4}-\d{2}-\d+\.tar$/.test(f) && !plannedNames.has(f)) {
      rmSync(path.join(STAGING, f));
      log(`[clean] 移除孤儿卷 ${f}`);
    }
  }

  // manifest 生成（内容与上一代完全一致时不产生新 gen）
  const buildManifest = (gen: number) => ({
    format_version: 1,
    gen,
    object_count: objects.length,
    total_size: totalBytes,
    volume_limit_bytes: VOL_LIMIT,
    objects,
    volumes,
  });
  const serialize = (m: Manifest | ReturnType<typeof buildManifest>): string => JSON.stringify(m, null, 2) + "\n";

  let gen: number;
  let manifestBytes: string;
  let wroteManifest = true;
  if (old) {
    const candidate = serialize(buildManifest(old.gen));
    const existing = readFileSync(old.manifestPath, "utf8");
    if (candidate === existing) {
      gen = old.gen;
      manifestBytes = candidate;
      wroteManifest = false;
    } else {
      gen = old.gen + 1;
      manifestBytes = serialize(buildManifest(gen));
    }
  } else {
    gen = 1;
    manifestBytes = serialize(buildManifest(1));
  }
  if (wroteManifest) {
    writeFileSync(path.join(MANIFEST_DIR, `manifest-${gen}.json`), manifestBytes);
  }
  const manifestSha = sha256Bytes(manifestBytes);

  const current = {
    gen,
    manifest_sha256: manifestSha,
    manifest_path: `manifest/manifest-${gen}.json`,
    volumes: volumes.map((v) => ({ asset_id: null, url: null, sha256: v.sha256, name: v.name })),
    updated_at: new Date().toISOString(),
  };
  writeFileSync(path.join(MANIFEST_DIR, "current.json"), JSON.stringify(current, null, 2) + "\n");

  // gen 保留 N 代（只清理本工具命名模式的文件）
  const gens = readdirSync(MANIFEST_DIR)
    .map((f) => /^manifest-(\d+)\.json$/.exec(f))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ f: m[0], n: parseInt(m[1], 10) }))
    .sort((a, b) => a.n - b.n);
  for (const g of gens.slice(0, Math.max(0, gens.length - GEN_KEEP))) {
    rmSync(path.join(MANIFEST_DIR, g.f));
    log(`[clean] 移除过期 manifest ${g.f}（保留最近 ${GEN_KEEP} 代）`);
  }

  const totalVolBytes = volumes.reduce((s, v) => s + v.size, 0);
  const sizes = volumes.map((v) => v.size).sort((a, b) => a - b);
  const dist = sizes.length
    ? `最小 ${sizes[0]} / 中位 ${sizes[Math.floor(sizes.length / 2)]} / 最大 ${sizes[sizes.length - 1]}`
    : "无卷";
  log(`[initial] 完成: 卷 ${volumes.length}（新打包 ${packed} / 复用 ${reused}）, 卷总字节 ${totalVolBytes}（${dist}）`);
  log(`[initial] manifest 对象数 ${objects.length}（应为源文件数 ${totalFiles}）`);
  log(`[initial] manifest/manifest-${gen}.json ${wroteManifest ? "已写入" : "内容未变，沿用"}（gen=${gen}, manifest_sha256=${manifestSha}）, current.json 已更新`);
  log(`[initial] 尺寸元数据: media-meta 命中 ${meta.hits}, ffprobe 回退 ${meta.fallback}, 省略字段 ${meta.omitted}, 含 duration_ms ${meta.msCount}`);
  if (objects.length !== totalFiles) die(`manifest 对象数 ${objects.length} ≠ 源文件数 ${totalFiles}`);
}

// ---------- 恢复演练（本地版验收门） ----------

async function runVerify(): Promise<void> {
  const curPath = path.join(MANIFEST_DIR, "current.json");
  if (!existsSync(curPath)) die("current.json 不存在，请先运行 --initial");
  const cur = JSON.parse(readFileSync(curPath, "utf8"));
  const mp = path.join(MANIFEST_DIR, `manifest-${cur.gen}.json`);
  if (!existsSync(mp)) die(`manifest-${cur.gen}.json 不存在`);
  const mbytes = readFileSync(mp);
  const msha = new Bun.CryptoHasher("sha256").update(mbytes).digest("hex");
  if (msha !== cur.manifest_sha256) {
    die(`manifest sha256 与 current.json 不一致: current=${cur.manifest_sha256} actual=${msha}`);
  }
  const manifest: Manifest = JSON.parse(mbytes.toString());
  if (manifest.format_version !== 1) die(`format_version=${manifest.format_version}，预期 1`);
  log(`[verify] current.json gen=${cur.gen} → manifest-${cur.gen}.json sha256 校验通过, 对象 ${manifest.objects.length}, 卷 ${manifest.volumes.length}`);

  for (const v of manifest.volumes) {
    const p = path.join(STAGING, v.name);
    if (!existsSync(p)) die(`卷缺失: ${v.name}`);
    const st = statSync(p);
    if (st.size !== v.size) die(`卷尺寸不符: ${v.name} manifest=${v.size} actual=${st.size}`);
    const sha = await hashFile(p);
    if (sha !== v.sha256) die(`卷 sha256 不符: ${v.name} manifest=${v.sha256} actual=${sha}`);
  }
  log(`[verify] ${manifest.volumes.length} 卷 sha256 全部一致`);

  rmSync(RESTORE_DIR, { recursive: true, force: true });
  mkdirSync(RESTORE_DIR, { recursive: true });
  let restored = 0;
  let restoreBad = 0;
  for (const o of manifest.objects) {
    if (o.key.startsWith("/") || o.key.includes("..") || o.key.includes("\\")) die(`非法 key: ${o.key}`);
    const dest = path.join(RESTORE_DIR, o.key);
    mkdirSync(path.dirname(dest), { recursive: true });
    const volPath = path.join(STAGING, o.volume);
    const fh = new Bun.CryptoHasher("sha256");
    const sink = Bun.file(dest).writer();
    let read = 0;
    for await (const chunk of Bun.file(volPath).slice(o.offset, o.offset + o.size).stream()) {
      const c = chunk as Uint8Array;
      fh.update(c);
      sink.write(c);
      read += c.byteLength;
    }
    await sink.end();
    if (read !== o.size || fh.digest("hex") !== o.sha256) {
      restoreBad += 1;
      log(`[verify] 解包校验失败: ${o.key}（read=${read} size=${o.size}）`);
    } else {
      restored += 1;
    }
  }
  log(`[verify] 恢复 ${restored} 文件（逐对象 sha256 与 manifest 一致），解包坏档 ${restoreBad}`);

  const byKey = new Map(manifest.objects.map((o) => [o.key, o]));
  const months = scanSource();
  let match = 0;
  let diff = 0;
  let extra = 0;
  const seen = new Set<string>();
  for (const files of months.values()) {
    for (const f of files) {
      const key = `x/${f.rel}`;
      seen.add(key);
      const o = byKey.get(key);
      if (!o) {
        extra += 1;
        log(`[verify] 源文件不在 manifest: ${key}`);
        continue;
      }
      const sha = await hashFile(f.abs);
      if (sha === o.sha256) match += 1;
      else {
        diff += 1;
        log(`[verify] 源文件 sha256 与 manifest 不一致: ${key}`);
      }
    }
  }
  const missing = manifest.objects.filter((o) => !seen.has(o.key)).length;

  const ok = restoreBad === 0 && diff === 0 && missing === 0 && extra === 0 && restored === manifest.objects.length;
  if (ok) {
    log(`恢复 ${restored} 文件 / sha256 全部一致 / 0 差异`);
    rmSync(RESTORE_DIR, { recursive: true, force: true });
  } else {
    die(`对账失败: 解包坏档 ${restoreBad}, 源差异 ${diff}, manifest 缺失对应源 ${missing}, 源多余 ${extra}（恢复目录保留于 ${RESTORE_DIR}）`);
  }
}

// ---------- 入口 ----------

const args = process.argv.slice(2);
if (args.includes("--initial")) {
  await runInitial();
} else if (args.includes("--verify")) {
  await runVerify();
} else {
  console.error("用法: bun cdn-media/tools/media-pack.ts --initial | --verify");
  console.error("  --initial  扫描 static/x-media 按月打包 USTAR 卷到 cdn-media/staging，生成 manifest 与 current.json");
  console.error("  --verify   恢复演练：manifest + 卷 → 解包恢复 → 与源目录全量 sha256 对账");
  process.exit(2);
}
