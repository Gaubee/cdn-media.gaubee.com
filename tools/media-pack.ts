// media-pack.ts — cdn-media Phase 0 打包工具（Bun + TypeScript，零第三方依赖）
//
// 用法:
//   bun cdn-media/tools/media-pack.ts --initial
//       扫描主仓 static/x-media，按 YYYY-MM 目录聚簇，产出每卷 ≤200MiB 的未压缩 USTAR
//       tar 卷（512 字节块对齐；成员路径 = canonical media key: x/<YYYY-MM>/<file>），
//       卷名 vol-<YYYY-MM>-<seq>.tar（seq 从 1 起，三位零填充），输出到 cdn-media/staging。
//       同时生成 manifest/manifest-<gen>.json（gen 从 1 起）并更新 manifest/current.json。
//       r5 修复：写 current.json 前按 name+sha256 对账既有指针——已发布卷保留 asset_id
//       （禁止回退 null，url 统一 asset id API URL）；已发布卷内容漂移 = 直接报错
//       （同名卷不可变，A2）。staging 复用前逐成员重算源 sha256（同大小内容变更
//       必产生新卷/新 gen）。
//   bun cdn-media/tools/media-pack.ts --verify
//       本地恢复演练：拉 current.json → 拉 manifest-<gen>.json（校验 sha256）→ 校验每卷
//       sha256 → 按对象 offset/size 从卷中解包恢复到 cdn-media/staging/.verify-restore →
//       与源目录全量逐一 sha256 对账。
//   bun cdn-media/tools/media-pack.ts --publish [--only YYYY-MM]
//       发布阶段（Phase 0.2）：按月分组把 staging 卷上传 GitHub Releases（release tag =
//       media-<YYYY-MM>，标题同名；卷为该 release 的 asset，asset 名 = 文件名）。
//       r5 修复：幂等仅 size+digest 双一致才跳过；远端不一致（含 digest 缺失）直接
//       报错退出——同名 asset 不可变（A2 硬约束），禁止 --clobber 覆盖，必须人工处置。
//       上传后终验并回填 current.json 的 volumes[].asset_id 与 url（统一 asset id
//       API URL: https://api.github.com/repos/<repo>/releases/assets/<id>）；
//       manifest_sha256 保持指向 manifest-<gen>.json 不变；回填只写工作区文件，
//       git 提交由主流程完成。--only 仅处理指定月份（冒烟用）。
//   bun cdn-media/tools/media-pack.ts --drill <dir> [--steps N]
//       外部恢复演练（Phase 0.2 验收门）：空目录 <dir>，只通过公网 URL 拉取——
//       raw.githubusercontent 的 current.json → manifest-<gen>.json（校验 sha256）→
//       逐卷按 asset id API URL 拉取（Accept: application/octet-stream，校验整卷
//       sha256）→ 按对象 offset/size 解包恢复全量文件并逐一 sha256 对账，输出
//       「恢复 N / 一致 N / 差异 0」。--steps N 限步（2 = 只跑指针+清单校验冒烟，
//       不下载 3.4GB 卷）。
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
//   {gen, manifest_sha256, volumes: [{asset_id, url, sha256, name}]}——asset_id 与 url
//   在打包时为占位 null，--publish 后回填；url 统一为 asset id API URL（r5 P1-16）。
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

// GitHub 媒体仓库（r5 P1-16：卷 URL 语义统一为 asset id API URL）
export const GH_REPO = "Gaubee/cdn-media.gaubee.com";

// asset id 的 API URL（r5 P1-16）：current.json 的 volumes[].url 一律写此格式，
// 不写 browser_download_url（按 tag+文件名拼的下载 URL 不具备抗误改性，A2）。
export function apiAssetUrl(assetId: number, repo: string = GH_REPO): string {
  return `https://api.github.com/repos/${repo}/releases/assets/${assetId}`;
}

// 指针对账合并（r5 P0-2）：写 current.json 前按 name+sha256 保留既有 asset_id/url。
// - 已发布（asset_id 非 null）且 sha256 一致 → 保留指针，url 统一改写为 API URL
// - 已发布但本次内容 sha256 不一致 → 直接报错：同名卷不可变是 A2 硬约束，
//   已发布月份的源漂移禁止以同名卷覆盖（增量必须走 patch 卷）
// - 未发布或新增卷 → asset_id/url 保持 null（等待 --publish 回填）
export type PointerMergeResult =
  | { ok: true; volumes: CurrentVol[]; preserved: number }
  | { ok: false; error: string };

export function mergePublishedPointers(
  volumes: VolRec[],
  prev: CurrentVol[] | null | undefined
): PointerMergeResult {
  const byName = new Map<string, CurrentVol>((prev ?? []).map((v) => [v.name, v]));
  const out: CurrentVol[] = [];
  let preserved = 0;
  for (const v of volumes) {
    const p = byName.get(v.name);
    if (p && typeof p.asset_id === "number" && p.asset_id > 0) {
      if (p.sha256 !== v.sha256) {
        return {
          ok: false,
          error:
            `卷 ${v.name} 已发布（asset_id=${p.asset_id}）但本次内容 sha256=${v.sha256.slice(0, 16)}… ` +
            `与已发布 ${p.sha256.slice(0, 16)}… 不一致——同名卷不可变（A2 硬约束），` +
            `已发布卷禁止重打包覆盖；已发布月份的源漂移必须改走 patch 卷方案`,
        };
      }
      out.push({ asset_id: p.asset_id, url: apiAssetUrl(p.asset_id), sha256: v.sha256, name: v.name });
      preserved += 1;
    } else {
      out.push({ asset_id: null, url: null, sha256: v.sha256, name: v.name });
    }
  }
  return { ok: true, volumes: out, preserved };
}

// 远端 asset 与本地卷的一致性分类（r5 P0-3）：
// - 不存在 → upload（新 asset 追加，合法）
// - size+digest 双一致 → skip（幂等复用）
// - 其余（含 digest 缺失无法证明一致）→ die：同名 asset 不可变（A2 硬约束），
//   禁止 --clobber 覆盖，必须人工核查处置
export type AssetClass =
  | { action: "skip" }
  | { action: "upload" }
  | { action: "die"; reason: string };

export function classifyRemoteAsset(v: VolRec, a: GhAsset | undefined): AssetClass {
  if (!a) return { action: "upload" };
  const sizeOk = a.size === v.size;
  const digestOk = a.digest === `sha256:${v.sha256}`;
  if (sizeOk && digestOk) return { action: "skip" };
  return {
    action: "die",
    reason:
      `远端 asset 与本地卷不一致（${v.name}）：local size=${v.size} digest=sha256:${v.sha256.slice(0, 16)}…，` +
      `remote size=${a.size} digest=${a.digest ?? "null"}——同名 asset 不可变（A2 硬约束），` +
      `禁止 --clobber 覆盖。请人工核查（gh release view 或 gh api）后删除错误 asset 再重跑 publish`,
  };
}

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
type CurrentVol = { asset_id: number | null; url: string | null; sha256: string; name: string };
type CurrentFile = { gen: number; manifest_sha256: string; manifest_path: string; volumes: CurrentVol[]; updated_at: string };

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

// 读旧 current.json 的裸指针（r5 P0-2 对账用）：尽力解析，缺失/损坏返回 null。
// 与 loadCurrentManifest 不同——即使 manifest 文件缺失，指针中的 asset_id/url
// 依然是已发布事实，必须参与对账。
function readPreviousCurrent(): CurrentFile | null {
  const p = path.join(MANIFEST_DIR, "current.json");
  if (!existsSync(p)) return null;
  try {
    const cur = JSON.parse(readFileSync(p, "utf8")) as CurrentFile;
    if (!Array.isArray(cur.volumes)) return null;
    return cur;
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
          // r5 P1-13：复用前逐成员重算源文件 sha256——staging 卷本身没变不代表源没变，
          // 「同大小内容变更」的源漂移必须落到重打包（新卷/新 gen），不得静默沿用旧档
          let drifted: string | null = null;
          for (let i = 0; i < v.members.length; i++) {
            const srcSha = await hashFile(v.members[i].entry.abs);
            if (srcSha !== objs[i].sha256) {
              drifted = v.members[i].key;
              break;
            }
          }
          if (drifted === null) {
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
            log(`[skip] ${v.name}（staging 与源逐成员 sha256 对账一致，${v.members.length} 成员复用）`);
            skipped = true;
          } else {
            log(`[drift] ${v.name} 源内容漂移（${drifted} 同尺寸改写），放弃复用改重打包`);
          }
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

  // r5 P0-2：写 current.json 前按 name+sha256 对账既有指针——已发布卷禁止回退 null，
  // url 统一改写为 asset id API URL（r5 P1-16）
  const prevPtrs = readPreviousCurrent()?.volumes ?? null;
  const merged = mergePublishedPointers(volumes, prevPtrs);
  if (!merged.ok) die(merged.error);

  const current = {
    gen,
    manifest_sha256: manifestSha,
    manifest_path: `manifest/manifest-${gen}.json`,
    volumes: merged.volumes,
    updated_at: new Date().toISOString(),
  };
  writeFileSync(path.join(MANIFEST_DIR, "current.json"), JSON.stringify(current, null, 2) + "\n");
  log(`[initial] 指针对账：保留已发布指针 ${merged.preserved}/${volumes.length}（url 统一为 asset id API URL）`);

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

// ---------- Phase 0.2：GitHub Releases 发布（--publish）与外部恢复演练（--drill） ----------

const RAW_MANIFEST_BASE = `https://raw.githubusercontent.com/${GH_REPO}/main/manifest`;
const GH_RETRY = 3;            // gh 报错重试次数（指数退避）
const CURL_RETRY = 3;          // curl 报错重试次数（指数退避）
const BACKOFF_BASE_MS = 2000;
const GH_API_TIMEOUT_MS = 60_000;
const GH_UPLOAD_TIMEOUT_MS = 30 * 60_000;

type GhAsset = { id: number; name: string; size: number; digest: string | null; browser_download_url: string };
type GhRelease = { tag_name: string; assets: GhAsset[] };

function monthOfVolume(name: string): string {
  const m = /^vol-(\d{4}-\d{2})-\d{3}\.tar$/.exec(name);
  if (!m) die(`卷名无法解析月份: ${name}`);
  return m[1];
}

function runWithRetry(label: string, cmd: string[], timeoutMs: number, retries: number): { stdout: string; stderr: string } {
  let lastErr = "";
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const wait = BACKOFF_BASE_MS * 2 ** (attempt - 1);
      log(`[retry] ${label} 第 ${attempt}/${retries} 次重试（退避 ${wait}ms）`);
      Bun.sleepSync(wait);
    }
    const r = Bun.spawnSync(cmd, { stdout: "pipe", stderr: "pipe", timeout: timeoutMs });
    if (r.exitCode === 0) return { stdout: r.stdout.toString(), stderr: r.stderr.toString() };
    lastErr = `exit=${r.exitCode} signal=${r.signalCode ?? "-"} stderr=${r.stderr.toString().trim().slice(-400)}`;
    log(`[retry] ${label} 失败: ${lastErr}`);
  }
  die(`${label} 连续 ${retries + 1} 次尝试均失败（${lastErr}）`);
}

function runGh(args: string[], timeoutMs: number): { stdout: string; stderr: string } {
  return runWithRetry(`gh ${args[0]} ${args[1] ?? ""}`.trim(), ["gh", ...args], timeoutMs, GH_RETRY);
}

// 拉取远端全部 release 及其 asset（含 API digest，用于幂等跳过的强校验）
function listGhReleases(): Map<string, GhRelease> {
  const out = new Map<string, GhRelease>();
  const jq = "[.[] | {tag_name: .tag_name, assets: [.assets[] | {id: .id, name: .name, size: .size, digest: .digest, browser_download_url: .browser_download_url}]}]";
  let page = 1;
  for (;;) {
    const { stdout } = runGh(["api", `repos/${GH_REPO}/releases?per_page=100&page=${page}`, "--jq", jq], GH_API_TIMEOUT_MS);
    const trimmed = stdout.trim();
    const rels = JSON.parse(trimmed === "" ? "[]" : trimmed) as GhRelease[];
    for (const r of rels) out.set(r.tag_name, r);
    if (rels.length < 100) break;
    page += 1;
  }
  return out;
}

function loadCurrentStrict(): { cur: CurrentFile; manifest: Manifest } {
  const curPath = path.join(MANIFEST_DIR, "current.json");
  if (!existsSync(curPath)) die("current.json 不存在，请先运行 --initial");
  const cur = JSON.parse(readFileSync(curPath, "utf8")) as CurrentFile;
  if (typeof cur.gen !== "number" || typeof cur.manifest_sha256 !== "string" || !Array.isArray(cur.volumes)) {
    die("current.json 结构非法");
  }
  const mp = path.join(MANIFEST_DIR, `manifest-${cur.gen}.json`);
  if (!existsSync(mp)) die(`manifest-${cur.gen}.json 不存在`);
  const mbytes = readFileSync(mp);
  const msha = new Bun.CryptoHasher("sha256").update(mbytes).digest("hex");
  if (msha !== cur.manifest_sha256) {
    die(`manifest-${cur.gen}.json sha256 与 current.json 不一致: current=${cur.manifest_sha256} actual=${msha}`);
  }
  const manifest = JSON.parse(mbytes.toString()) as Manifest;
  if (manifest.format_version !== 1) die(`format_version=${manifest.format_version}，预期 1`);
  return { cur, manifest };
}

async function runPublish(only?: string): Promise<void> {
  const t0 = Date.now();
  if (only && !/^\d{4}-\d{2}$/.test(only)) die(`--only 参数非法: ${only}（应为 YYYY-MM）`);
  const { cur, manifest } = loadCurrentStrict();

  // current.json 卷集合与 manifest 对齐校验（名称 + sha256）
  const curVolByName = new Map(cur.volumes.map((v) => [v.name, v]));
  for (const v of manifest.volumes) {
    const cv = curVolByName.get(v.name);
    if (!cv) die(`manifest 卷不在 current.json: ${v.name}`);
    if (cv.sha256 !== v.sha256) die(`current 与 manifest 卷 sha256 不一致: ${v.name}`);
  }

  const selected = only ? manifest.volumes.filter((v) => monthOfVolume(v.name) === only) : manifest.volumes;
  if (selected.length === 0) die(`--only ${only} 没有匹配的卷`);

  // 打包产物完整性闸门：staging 卷尺寸 + 整卷 sha256 逐一复算
  log(`[publish] 复算 staging ${selected.length} 卷整卷 sha256（与 manifest 对账）…`);
  for (const v of selected) {
    const p = path.join(STAGING, v.name);
    if (!existsSync(p)) die(`staging 卷缺失: ${v.name}`);
    const st = statSync(p);
    if (st.size !== v.size) die(`卷尺寸不符: ${v.name} manifest=${v.size} actual=${st.size}`);
    const sha = await hashFile(p);
    if (sha !== v.sha256) die(`卷 sha256 不符: ${v.name} manifest=${v.sha256} actual=${sha}`);
  }

  // 按月分组
  const byMonth = new Map<string, VolRec[]>();
  for (const v of selected) {
    const month = monthOfVolume(v.name);
    const list = byMonth.get(month);
    if (list) list.push(v); else byMonth.set(month, [v]);
  }

  // 预检（上传前）：每 release asset 数 ≤1000
  for (const [month, list] of byMonth) {
    if (list.length > ASSET_MAX_PER_RELEASE) {
      die(`预检失败: media-${month} 需 ${list.length} asset，超过每 release ${ASSET_MAX_PER_RELEASE} 上限`);
    }
  }
  log(`[publish] 预检通过: ${byMonth.size} 个按月 release，每月 asset 数 ≤${ASSET_MAX_PER_RELEASE}`);

  log(`[publish] 拉取远端 release 列表…`);
  const releases = listGhReleases();

  let created = 0;
  let existed = 0;
  let uploaded = 0;
  let reused = 0;
  let uploadedBytes = 0;

  for (const month of [...byMonth.keys()].sort()) {
    const list = byMonth.get(month)!;
    const tag = `media-${month}`;
    let rel = releases.get(tag);
    if (!rel) {
      const notes = `cdn-media 月度媒体卷归档 ${tag}：vol-${month}-NNN.tar 共 ${list.length} 卷，由 media-pack --publish 上传；对象索引以仓库 manifest 为准（卷内容不可变，asset 即权威副本）。`;
      runGh(["release", "create", tag, "--repo", GH_REPO, "--title", tag, "--notes", notes], GH_API_TIMEOUT_MS);
      rel = { tag_name: tag, assets: [] };
      releases.set(tag, rel);
      created += 1;
      log(`[publish] ${tag}: release 已创建（${list.length} asset 待传）`);
    } else {
      existed += 1;
      log(`[publish] ${tag}: release 已存在（远端 asset ${rel.assets.length}，跳过创建）`);
    }

    // 幂等跳过（r5 P0-3）：仅 size+digest 双一致才跳过；不一致直接 die——
    // 同名 asset 不可变是 A2 硬约束，不再 --clobber 重传
    const assetByName = new Map(rel.assets.map((a) => [a.name, a]));
    const need: VolRec[] = [];
    for (const v of list) {
      const cls = classifyRemoteAsset(v, assetByName.get(v.name));
      if (cls.action === "skip") {
        reused += 1;
        continue;
      }
      if (cls.action === "die") die(cls.reason);
      need.push(v);
    }
    if (need.length > 0) {
      uploadAssets(tag, need);
      uploaded += need.length;
      uploadedBytes += need.reduce((s, v) => s + v.size, 0);
    }
    log(`[publish] ${tag}: 本月上传 ${need.length} / 复用 ${list.length - need.length}，累计 asset ${list.length}（${list.reduce((s, v) => s + v.size, 0)} 字节）`);
    Bun.sleepSync(500); // 按月限速，降低 secondary rate limit 风险
  }

  // 终验：重新拉取远端列表，逐卷核对 asset 存在性 + size + digest，并再跑一次 asset 数预检
  log(`[publish] 终验：重新拉取远端 release 列表核对全部 asset…`);
  const finals = listGhReleases();
  const perTagCount = new Map<string, number>();
  const assetsByName = new Map<string, GhAsset>();
  for (const rel of finals.values()) {
    perTagCount.set(rel.tag_name, rel.assets.length);
    for (const a of rel.assets) assetsByName.set(a.name, a);
  }
  for (const [month, _list] of byMonth) {
    const n = perTagCount.get(`media-${month}`) ?? 0;
    if (n > ASSET_MAX_PER_RELEASE) die(`终验预检失败: media-${month} asset 数 ${n} 超过 ${ASSET_MAX_PER_RELEASE} 上限`);
  }
  for (const v of selected) {
    const a = assetsByName.get(v.name);
    if (!a) die(`终验失败: 卷无对应 asset: ${v.name}`);
    if (a.size !== v.size) die(`终验 size 不符: ${v.name} local=${v.size} remote=${a.size}`);
    // r5 P0-3：终验同样要求 digest 双一致（digest 缺失 = 无法证明不可变性，拒绝放行）
    if (a.digest === null || a.digest !== `sha256:${v.sha256}`) {
      die(`终验 digest 不符/缺失: ${v.name} local=sha256:${v.sha256} remote=${a.digest ?? "null"}`);
    }
  }

  // 回填 current.json（只写工作区文件，git 提交由主流程完成）
  // r5 P1-16：url 统一写 asset id API URL，不写 browser_download_url
  const selectedNames = new Set(selected.map((v) => v.name));
  const curPath = path.join(MANIFEST_DIR, "current.json");
  const curObj = JSON.parse(readFileSync(curPath, "utf8")) as CurrentFile;
  let filled = 0;
  for (const cv of curObj.volumes) {
    if (!selectedNames.has(cv.name)) continue;
    const a = assetsByName.get(cv.name)!;
    const apiUrl = apiAssetUrl(a.id);
    if (cv.asset_id !== a.id || cv.url !== apiUrl) filled += 1;
    cv.asset_id = a.id;
    cv.url = apiUrl;
  }
  curObj.updated_at = new Date().toISOString();
  writeFileSync(curPath, JSON.stringify(curObj, null, 2) + "\n");

  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  log(`[publish] 完成: release ${byMonth.size} 个（新建 ${created} / 已存在 ${existed}），asset 上传 ${uploaded} 个（${uploadedBytes} 字节），复用跳过 ${reused} 个，耗时 ${elapsed}s`);
  log(`[publish] 终验通过: ${selected.length} 卷远端 asset size/digest 全部一致，每 release asset 数 ≤${ASSET_MAX_PER_RELEASE}`);
  log(`[publish] current.json 已回填 asset_id 与 url（本次覆盖 ${selected.length} 卷，其中变更 ${filled} 条）；manifest_sha256 保持 ${curObj.manifest_sha256.slice(0, 16)}…（gen=${curObj.gen}，指向 manifest-${curObj.gen}.json）`);
}

function uploadAssets(tag: string, vols: VolRec[]): void {
  // r5 P0-3：同名 asset 不可变（A2）——远端存在性/一致性已在 classifyRemoteAsset
  // 把关（不一致直接 die），此处只做「新 asset 追加上传」，禁止任何覆盖（无 --clobber）
  const files = vols.map((v) => path.join(STAGING, v.name));
  runGh(["release", "upload", tag, ...files, "--repo", GH_REPO], GH_UPLOAD_TIMEOUT_MS);
}

// ---------- 外部恢复演练（--drill <dir>） ----------

function curlTo(url: string, dest: string, timeoutMs: number, headers: string[] = []): void {
  runWithRetry(
    `curl ${url}`,
    ["curl", "-fsSL", "--connect-timeout", "30", "--max-time", "3600", ...headers, "-o", dest, url],
    timeoutMs,
    CURL_RETRY,
  );
}

function curlBytes(url: string): Uint8Array {
  const dest = path.join("/tmp", `media-pack-curl-${process.pid}-${Date.now()}.tmp`);
  try {
    curlTo(url, dest, 120_000);
    return new Uint8Array(readFileSync(dest));
  } finally {
    rmSync(dest, { force: true });
  }
}

// raw 主分支清单的 JSON 拉取。注意：curlBytes 返回的是纯 Uint8Array（readFileSync 的
// Buffer 经 new Uint8Array 拷贝后丢失 toString 的 utf8 覆盖），必须 TextDecoder 解码，
// 否则 JSON.parse 拿到的是 "123,10,32..." 十进制串必然失败（2026-10-06 演练实录）。
function curlJsonWithRetry<T>(url: string, retries = 4): T {
  let last = "";
  for (let attempt = 0; attempt <= retries; attempt++) {
    if (attempt > 0) {
      const wait = 3000 * 2 ** (attempt - 1);
      log(`[drill] ${url} 第 ${attempt}/${retries} 次重试（退避 ${wait}ms）：${last}`);
      Bun.sleepSync(wait);
    }
    const bytes = curlBytes(url);
    try {
      return JSON.parse(new TextDecoder().decode(bytes)) as T;
    } catch {
      last = `响应非 JSON（前 80 字符：${new TextDecoder().decode(bytes).slice(0, 80).replace(/\n/g, " ")}）`;
    }
  }
  die(`JSON 拉取连续 ${retries + 1} 次失败：${url}（${last}）`);
}

async function runDrill(dirArg: string, maxSteps = 5): Promise<void> {
  const t0 = Date.now();
  const dir = path.resolve(dirArg);
  if (existsSync(dir) && readdirSync(dir).length > 0) {
    die(`演练目录非空: ${dir}（验收要求空目录，请先清空）`);
  }
  const volDir = path.join(dir, "volumes");
  const restoreDir = path.join(dir, "restore");
  mkdirSync(volDir, { recursive: true });
  mkdirSync(restoreDir, { recursive: true });

  // 1/5 公网拉 current.json（raw.githubusercontent，无鉴权）
  const currentUrl = `${RAW_MANIFEST_BASE}/current.json`;
  log(`[drill] 1/5 拉取 ${currentUrl}`);
  const cur = curlJsonWithRetry<CurrentFile>(currentUrl);
  if (typeof cur.gen !== "number" || typeof cur.manifest_sha256 !== "string") die("远程 current.json 结构非法");

  // 2/5 公网拉 manifest-<gen>.json 并校验 sha256
  const manifestUrl = `${RAW_MANIFEST_BASE}/manifest-${cur.gen}.json`;
  log(`[drill] 2/5 拉取 ${manifestUrl} 并校验 sha256`);
  const mBytes = curlBytes(manifestUrl);
  const mSha = new Bun.CryptoHasher("sha256").update(mBytes).digest("hex");
  if (mSha !== cur.manifest_sha256) {
    die(`manifest sha256 与远程 current.json 不一致: current=${cur.manifest_sha256} actual=${mSha}`);
  }
  const manifest = JSON.parse(new TextDecoder().decode(mBytes)) as Manifest;
  if (manifest.format_version !== 1) die(`format_version=${manifest.format_version}，预期 1`);
  log(`[drill] manifest 校验通过: gen=${cur.gen}, 对象 ${manifest.objects.length}, 卷 ${manifest.volumes.length}`);

  // r5 P1-16 冒烟位：--steps 2 只跑前两步（指针+清单校验）即通过退出
  if (maxSteps < 3) {
    log(`[drill] --steps ${maxSteps}：指针+清单校验通过，冒烟结束（不下载卷）`);
    return;
  }

  // 3/5 卷 URL 解析（r5 P1-16：统一 asset id API URL 语义）——以远程指针的 asset_id
  // 构造 API URL（Accept: application/octet-stream 跟随重定向取字节）；url 字段仅作
  // 格式核对，不再回退本地文件（指针已发布则 asset_id 必在，本地回退是多余的盲信）
  const urls = new Map<string, string>();
  let staleUrlFmt = 0;
  for (const v of cur.volumes) {
    if (typeof v.asset_id !== "number" || v.asset_id <= 0) {
      die(`远程 current.json 卷 ${v.name} 无有效 asset_id（发布未完成？）——拒绝演练`);
    }
    const apiUrl = apiAssetUrl(v.asset_id);
    if (v.url && v.url !== apiUrl) {
      staleUrlFmt += 1;
      log(`[drill] 卷 ${v.name} 指针 url 为旧格式（${v.url}），统一改用 API URL`);
    }
    urls.set(v.name, apiUrl);
  }
  log(`[drill] 3/5 卷下载 URL 全部按 asset id API URL 构造（${urls.size} 条，纯公网链路${staleUrlFmt ? `，${staleUrlFmt} 条旧格式已统一` : ""}）`);

  const manifestVolByName = new Map(manifest.volumes.map((v) => [v.name, v]));
  if (cur.volumes.length !== manifest.volumes.length) {
    die(`current 与 manifest 卷数不一致: current=${cur.volumes.length} manifest=${manifest.volumes.length}`);
  }
  for (const cv of cur.volumes) {
    const mv = manifestVolByName.get(cv.name);
    if (!mv) die(`current.json 卷不在 manifest: ${cv.name}`);
    if (cv.sha256 !== mv.sha256) die(`current 与 manifest 卷 sha256 不一致: ${cv.name}`);
    if (!urls.has(cv.name)) die(`卷无下载 URL: ${cv.name}`);
  }

  // 4/5 逐卷：公网下载 → 整卷 sha256 校验 → 按对象 offset/size 解包恢复 → 删卷控磁盘
  const objsByVol = new Map<string, ObjRec[]>();
  for (const o of manifest.objects) {
    const list = objsByVol.get(o.volume);
    if (list) list.push(o); else objsByVol.set(o.volume, [o]);
  }
  let downloadedBytes = 0;
  let restored = 0;
  let consistent = 0;
  let diff = 0;
  let volDone = 0;
  for (const v of manifest.volumes) {
    const dest = path.join(volDir, v.name);
    // r5 P1-16：API asset URL 必须 Accept: application/octet-stream 才跟随重定向取字节
    curlTo(urls.get(v.name) as string, dest, 60 * 60_000, [
      "-H",
      "Accept: application/octet-stream",
    ]);
    downloadedBytes += v.size;
    const st = statSync(dest);
    if (st.size !== v.size) die(`下载卷尺寸不符: ${v.name} want=${v.size} got=${st.size}`);
    const sha = await hashFile(dest);
    if (sha !== v.sha256) die(`下载卷 sha256 不符: ${v.name} manifest=${v.sha256} actual=${sha}`);
    for (const o of objsByVol.get(v.name) ?? []) {
      if (o.key.startsWith("/") || o.key.includes("..") || o.key.includes("\\")) die(`非法 key: ${o.key}`);
      const out = path.join(restoreDir, o.key);
      mkdirSync(path.dirname(out), { recursive: true });
      const fh = new Bun.CryptoHasher("sha256");
      const sink = Bun.file(out).writer();
      let read = 0;
      for await (const chunk of Bun.file(dest).slice(o.offset, o.offset + o.size).stream()) {
        const c = chunk as Uint8Array;
        fh.update(c);
        sink.write(c);
        read += c.byteLength;
      }
      await sink.end();
      restored += 1;
      if (read === o.size && fh.digest("hex") === o.sha256) {
        consistent += 1;
      } else {
        diff += 1;
        log(`[drill] 对象校验失败: ${o.key}（read=${read} size=${o.size}）`);
      }
    }
    rmSync(dest);
    volDone += 1;
    log(`[drill] 4/5 ${v.name} 整卷 sha256 一致（${volDone}/${manifest.volumes.length} 卷，已恢复 ${restored}/${manifest.objects.length} 对象）`);
  }

  // 5/5 汇总验收
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);
  log(`[drill] 5/5 恢复 ${restored} / 一致 ${consistent} / 差异 ${diff}`);
  log(`[drill] 卷校验 ${volDone}/${manifest.volumes.length} 全部 sha256 一致；公网下载 ${downloadedBytes} 字节，恢复目录 ${restoreDir}，耗时 ${elapsed}s`);
  if (diff !== 0 || restored !== manifest.objects.length || consistent !== manifest.objects.length) {
    die(`演练未通过: 恢复 ${restored} / 一致 ${consistent} / 差异 ${diff}（期望 ${manifest.objects.length} 全恢复全一致零差异）`);
  }
  log(`[drill] 通过: ${manifest.objects.length} 对象全部经公网 URL 恢复且逐一 sha256 与公网 manifest 对账一致`);
}

// ---------- 入口（import.meta.main 守卫：测试可 import 纯函数而不触发 CLI） ----------

if (import.meta.main) {
  const args = process.argv.slice(2);
  if (args.includes("--initial")) {
    await runInitial();
  } else if (args.includes("--verify")) {
    await runVerify();
  } else if (args.includes("--publish")) {
    const onlyIdx = args.indexOf("--only");
    const only = onlyIdx >= 0 ? args[onlyIdx + 1] : undefined;
    await runPublish(only);
  } else if (args.includes("--drill")) {
    const i = args.indexOf("--drill");
    const dirArg = i >= 0 ? args[i + 1] : undefined;
    if (!dirArg) {
      console.error("用法: --drill <空目录> [--steps N]（如 /tmp/cdn-media-drill；--steps 2 只跑指针+清单校验冒烟）");
      process.exit(2);
    }
    const stepsIdx = args.indexOf("--steps");
    const steps = stepsIdx >= 0 ? parseInt(args[stepsIdx + 1], 10) : 5;
    if (!Number.isFinite(steps) || steps < 1 || steps > 5) {
      console.error("--steps 必须是 1-5 的整数（默认 5 = 全量演练）");
      process.exit(2);
    }
    await runDrill(dirArg, steps);
  } else {
    console.error("用法: bun cdn-media/tools/media-pack.ts --initial | --verify | --publish [--only YYYY-MM] | --drill <dir> [--steps N]");
    console.error("  --initial            扫描 static/x-media 按月打包 USTAR 卷到 cdn-media/staging，生成 manifest 与 current.json（已发布指针按 name+sha256 对账保留，url 统一 asset id API URL）");
    console.error("  --verify             本地恢复演练：manifest + 卷 → 解包恢复 → 与源目录全量 sha256 对账");
    console.error("  --publish [--only M] 上传 staging 卷到 GitHub Releases（按月 release，幂等可重入；同名 asset 不可变，不一致直接报错），完成后回填 current.json 的 asset_id 与 url（API URL）");
    console.error("  --drill <dir>        外部恢复演练：空目录，只经公网 URL 拉取 current/manifest/卷并全量恢复 sha256 对账；--steps N 限步（2 = 指针+清单校验冒烟）");
    process.exit(2);
  }
}
