// media-pack.ts — cdn-media Phase 0 打包工具（Bun + TypeScript，零第三方依赖）
//
// 用法:
//   bun cdn-media/tools/media-pack.ts --initial
//       扫描打包源（Phase 3 起默认 cdn-media/staging/x canonical 布局；--source 可指向
//       任意月份目录根），按 YYYY-MM 目录聚簇，产出每卷 ≤200MiB 的未压缩 USTAR
//       tar 卷（512 字节块对齐；成员路径 = canonical media key: x/<YYYY-MM>/<file>），
//       卷名 vol-<YYYY-MM>-<seq>.tar（seq 从 1 起，三位零填充），输出到 cdn-media/staging。
//       同时生成 manifest/manifest-<gen>.json（gen 从 1 起）并更新 manifest/current.json。
//       r5 修复：写 current.json 前按 name+sha256 对账既有指针——已发布卷保留 asset_id
//       （禁止回退 null，url 统一 asset id API URL）；已发布卷内容漂移 = 直接报错
//       （同名卷不可变，A2）。r6 修复：对账升级为双向 fail-closed——prev 中已发布卷
//       在本次集合缺失同样直接报错（卷 append-only，R4）；对账发生在任何落盘之前，
//       失败不写 manifest、不写 current、不推进 gen、不清 staging。
//       r6 修复（P0-3）：既有 current/manifest 三态区分——完全没有 current 才允许
//       gen=1 初始化；存在但损坏（JSON 解析失败/manifest 缺失/sha 不符/gen 或路径
//       非法/卷集合不一致）一律立即失败，绝不重初始化覆盖发布历史。staging 复用前
//       逐成员重算源 sha256（同大小内容变更必产生新卷/新 gen）。
//   bun cdn-media/tools/media-pack.ts --patch
//       增量补丁（Phase 0.3）：扫描打包源中 manifest 尚未收录的新文件（按
//       canonical key 对比当前代 manifest），按月份组各打包一个补丁卷
//       patch-<YYYY-MM>-<DD>.tar（DD 为打包日，月份取自文件所属月份组，供发布按月对位；
//       未压缩 USTAR、512 对齐、成员路径 = canonical key；单月超卷限时按
//       patch-<YYYY-MM>-<DD>-<seq>.tar 分流）。不动既有卷：新代 manifest-<gen+1>.json =
//       旧对象+新对象、volumes = 旧卷+补丁卷，current.json 指针换代时旧已发布卷指针
//       原样保留（mergePublishedPointers 双向 fail-closed 兼容），补丁卷指针先为 null，
//       由 --publish 追加到该月份既有 release 后回填。同月同日重复补丁且同名卷已被
//       manifest 引用 → 直接 die（同名卷不可变，A2，防覆盖）；同名卷存在但未被引用
//       （崩溃残留）→ 确定性重打包覆盖；无新增文件 → 不打包、不换代。
//       要求已有发布历史：current.json 缺失时引导 --initial，损坏时 fail-closed。
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
//   优先读 ~/.gaubee-skills/data/sources/x-likes/media-meta.json（键为 canonical media key
//   cdn-media/x/<月>/<文件>，值 {w, h, ms}；Phase 3 前的旧键 x-media/<月>/<文件> 已废弃）；
//   缺失条目回退 ffprobe；仍不可得则省略字段。
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
// Phase 3（cdn-media-bootstrap plan 3.3）源切换：打包源从主仓 static/x-media 改为
// cdn-media/staging/x（staging 目录结构 = canonical key 布局：抓取管道直接下载到此，
// media-pack 从 staging 打卷）。--source <dir> 可指向任意「月份目录根」
//（目录下直接是 YYYY-MM/），例如回溯对账时指向旧的 static/x-media。
const DEFAULT_SOURCE = path.join(MEDIA_REPO, "staging", "x");
let SOURCE_DIR = DEFAULT_SOURCE;
const STAGING = path.join(MEDIA_REPO, "staging");
const MANIFEST_DIR = path.join(MEDIA_REPO, "manifest");
const META_PATH = path.join(homedir(), ".gaubee-skills", "data", "sources", "x-likes", "media-meta.json");
const RESTORE_DIR = path.join(STAGING, ".verify-restore");

/** 解析打包源目录（--source 覆盖；缺省 staging/x canonical 布局）。导出供测试。 */
export function resolveSourceDir(explicit?: string): string {
  return explicit ? path.resolve(explicit) : DEFAULT_SOURCE;
}

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

// 指针对账合并（r5 P0-2 / r6 P0-2）：写 current.json 前按 name+sha256 双向对账。
// 正向：本次集合中已发布的卷按 name+sha256 保留既有 asset_id/url（禁止回退 null，
// url 统一 asset id API URL）；已发布但内容 sha256 不一致 → 直接报错（同名卷不可变，A2）。
// 反向（r6 P0-2）：prev 中所有已发布（asset_id > 0）的卷必须仍出现在本次集合中——
// 卷 append-only、不可改写（R4），缺失 = 误删源目录/改月份目录/扫描异常，直接
// fail-closed；绝不把历史已发布卷从新 current 指针中静默丢弃（否则仍被旧文章引用的
// 媒体在新一代 manifest 上变 404）。若未来要做删除，必须单独设计带 tombstone/保留期
// 的协议，不能借由本工具的默认路径删除。
export type PointerMergeResult =
  | { ok: true; volumes: CurrentVol[]; preserved: number }
  | { ok: false; error: string };

export function mergePublishedPointers(
  volumes: VolRec[],
  prev: CurrentVol[] | null | undefined
): PointerMergeResult {
  // r7 P1-2：重复输入保护——不依赖调用方先清洗。本次扫描集合或 prev 指针里
  // 出现重复卷名都是上游损坏信号（loadCurrentState 已拦一道，这里兜底），
  // 重复名会让 Map 去重悄悄吞掉一条卷记录，破坏 append-only 对账
  const scanByName = new Map<string, VolRec>(volumes.map((v) => [v.name, v]));
  if (scanByName.size !== volumes.length) {
    return {
      ok: false,
      error: `本次扫描集合存在重复卷名（${volumes.length} 条记录 vs ${scanByName.size} 个唯一名）——同名卷在单代 manifest 中必须唯一，禁止继续`,
    };
  }
  const prevByName = new Map<string, CurrentVol>((prev ?? []).map((v) => [v.name, v]));
  if (prevByName.size !== (prev ?? []).length) {
    return {
      ok: false,
      error: `prev 指针存在重复卷名（${(prev ?? []).length} 条记录 vs ${prevByName.size} 个唯一名）——current.json 卷名必须唯一，禁止继续`,
    };
  }
  // r6 P0-2 反向对账：prev 已发布卷缺失 = 历史卷丢失，fail-closed
  for (const p of prev ?? []) {
    if (!(typeof p.asset_id === "number" && p.asset_id > 0)) continue;
    if (!scanByName.has(p.name)) {
      return {
        ok: false,
        error:
          `已发布卷 ${p.name}（asset_id=${p.asset_id}）不在本次扫描集合中——` +
          `卷 append-only（R4），历史已发布卷禁止从指针中消失。` +
          `该错误通常意味着源目录被误删/月份目录被改名/扫描异常；` +
          `恢复缺失的源目录后重跑，不要用重初始化绕过`,
      };
    }
  }
  const out: CurrentVol[] = [];
  let preserved = 0;
  for (const v of volumes) {
    const p = prevByName.get(v.name);
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

// ustar 头构造（导出供确定性修复/测试复用——staging 卷损坏时按 manifest 记录
// 从源文件重建，sha256 对上 manifest 记录才算修复成功）
export function buildUstarHeader(p: string, size: number, mtimeSec: number): Uint8Array {
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

/** 扫描打包源（月份目录根，缺省 --source 解析结果）；导出供测试 */
export function scanSource(dir: string = SOURCE_DIR): Map<string, FileEntry[]> {
  if (!existsSync(dir)) die(`源目录不存在: ${dir}`);
  const months = new Map<string, FileEntry[]>();
  for (const month of readdirSync(dir).sort()) {
    const mdir = path.join(dir, month);
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

// 单个月份组的成员装箱（--initial 的 vol- 卷与 --patch 的补丁卷共享）：
// 512 头 + 数据 + 对齐，超过卷硬限即分流下一卷；nameFor 决定第 seq 卷的命名。
function planMembersInto(
  month: string,
  files: FileEntry[],
  nameFor: (seq: number) => string,
  vols: PlannedVol[]
): void {
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
      cur = { name: nameFor(seq), month, members: [], finalSize: END_MARK };
      used = 0;
      vols.push(cur);
    }
    cur.members.push({ key: `x/${f.rel}`, entry: f, dataOffset: used + BLOCK });
    used += cost;
    cur.finalSize = used + END_MARK;
  }
}

function planVolumes(months: Map<string, FileEntry[]>): PlannedVol[] {
  const vols: PlannedVol[] = [];
  for (const month of [...months.keys()].sort()) {
    planMembersInto(month, months.get(month)!, (seq) => volName(month, seq), vols);
  }
  return vols;
}

// 补丁卷命名：patch-<YYYY-MM>-<DD>.tar（月份 = 文件所属月份组，DD = 打包日；
// 同月同日装箱超限时 seq 分流）。月份进卷名使「补丁卷 → 该月份 release」的对位
// 不依赖外部状态，monthOfVolume 可直接解析。
function patchVolName(month: string, day: number, seq: number): string {
  const base = `patch-${month}-${String(day).padStart(2, "0")}`;
  return seq === 1 ? `${base}.tar` : `${base}-${seq}.tar`;
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
    // Phase 3：media-meta.json 键 = canonical media key `cdn-media/x/<月>/<文件>`
    //（media-meta.ts 自 manifest 内嵌 w/h/ms 产出，键空间与 x.json mediaLocal 一致）
    let v = this.map.get(`cdn-media/x/${m.entry.rel}`);
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

// ---------- 既有 manifest 载入（幂等复用 + r6 P0-3 两态区分） ----------

// r6 P0-3：三态区分——「完全没有 current.json（允许 gen=1 初始化）」vs
// 「current.json 存在但任一字段/目标清单不可验证（立即 fail-closed）」。
// 旧实现把 JSON 损坏、manifest 缺失、sha 不符统统归为 null，runInitial 会走
// gen=1 重初始化分支——可能覆盖旧 manifest 或把 generation 倒退到 1。
export type CurrentState =
  | { state: "absent" }
  | { state: "ok"; gen: number; manifestPath: string; manifest: Manifest; pointer: CurrentFile }
  | { state: "corrupt"; error: string };

export function loadCurrentState(): CurrentState {
  const curPath = path.join(MANIFEST_DIR, "current.json");
  if (!existsSync(curPath)) return { state: "absent" };
  // current.json 存在即视为「已有发布历史」——以下任何一步不可验证都 fail-closed
  let cur: CurrentFile;
  try {
    cur = JSON.parse(readFileSync(curPath, "utf8")) as CurrentFile;
  } catch (e) {
    return {
      state: "corrupt",
      error: `current.json 解析失败: ${e}——存在发布历史时禁止重初始化；请先人工修复 current.json（或从 git 恢复）`,
    };
  }
  if (typeof cur.gen !== "number" || !Number.isInteger(cur.gen) || cur.gen < 1) {
    return { state: "corrupt", error: `current.json gen 非法: ${JSON.stringify((cur as any).gen)}` };
  }
  if (typeof cur.manifest_sha256 !== "string" || !/^[0-9a-fA-F]{64}$/.test(cur.manifest_sha256)) {
    return { state: "corrupt", error: `current.json manifest_sha256 非法（须 64 位 hex）: ${JSON.stringify((cur as any).manifest_sha256)}` };
  }
  const expectPath = `manifest/manifest-${cur.gen}.json`;
  if (cur.manifest_path !== expectPath) {
    return { state: "corrupt", error: `current.json manifest_path 必须为 ${expectPath}（当前 ${JSON.stringify(cur.manifest_path)}）` };
  }
  if (!Array.isArray(cur.volumes)) {
    return { state: "corrupt", error: "current.json volumes 必须是数组" };
  }
  // r7 P1-2：逐卷校验 + 唯一 name set——0 不是合法已发布指针（merge 只认 >0，
  // 会被当未发布导致下一次 patch 把真实 asset 指针写成 null）也不是合法未发布态
  //（null）；url 一律 null 或 asset id API URL；卷名重复直接拒绝
  const curNames = new Set<string>();
  for (const v of cur.volumes) {
    if (typeof v?.name !== "string" || typeof v?.sha256 !== "string") {
      return { state: "corrupt", error: `current.json 卷条目非法: ${JSON.stringify(v)}` };
    }
    if (!(v.asset_id === null || (typeof v.asset_id === "number" && Number.isInteger(v.asset_id) && v.asset_id >= 1))) {
      return {
        state: "corrupt",
        error: `current.json 卷 ${v.name} asset_id 非法（须 null 或 ≥1 整数，0 不是合法已发布指针也不是合法未发布态）: ${JSON.stringify(v.asset_id)}`,
      };
    }
    if (!(v.url === null || (typeof v.asset_id === "number" && v.url === apiAssetUrl(v.asset_id)))) {
      return {
        state: "corrupt",
        error: `current.json 卷 ${v.name} url 非法（须 null 或 asset id API URL ${v.asset_id === null ? "" : apiAssetUrl(v.asset_id)}）: ${JSON.stringify(v.url)}`,
      };
    }
    if (curNames.has(v.name)) {
      return { state: "corrupt", error: `current.json 重复卷名: ${v.name}` };
    }
    curNames.add(v.name);
  }
  const mp = path.join(MANIFEST_DIR, `manifest-${cur.gen}.json`);
  if (!existsSync(mp)) {
    return { state: "corrupt", error: `manifest-${cur.gen}.json 缺失（current.json 指向的清单不存在）——存在发布历史时禁止重初始化` };
  }
  let mbytes: Buffer;
  try {
    mbytes = readFileSync(mp);
  } catch (e) {
    return { state: "corrupt", error: `manifest-${cur.gen}.json 读取失败: ${e}` };
  }
  const msha = new Bun.CryptoHasher("sha256").update(mbytes).digest("hex");
  if (msha !== cur.manifest_sha256.toLowerCase()) {
    return {
      state: "corrupt",
      error: `manifest-${cur.gen}.json sha256 与 current.json 不一致: current=${cur.manifest_sha256} actual=${msha}——存在发布历史时禁止重初始化`,
    };
  }
  let manifest: Manifest;
  try {
    manifest = JSON.parse(mbytes.toString());
  } catch (e) {
    return { state: "corrupt", error: `manifest-${cur.gen}.json 解析失败: ${e}` };
  }
  if (manifest.format_version !== 1) {
    return { state: "corrupt", error: `manifest-${cur.gen}.json format_version=${manifest.format_version}，预期 1` };
  }
  // r7 P1-2：代际强制一致——SHA 自洽但代际错乱的清单不得进入 ok 态
  if (manifest.gen !== cur.gen) {
    return {
      state: "corrupt",
      error: `manifest-${cur.gen}.json gen=${JSON.stringify(manifest.gen)} 与 current.json gen=${cur.gen} 不一致——sha 自洽但代际错乱，存在发布历史时禁止重初始化`,
    };
  }
  if (!Array.isArray(manifest.volumes) || !Array.isArray(manifest.objects)) {
    return { state: "corrupt", error: `manifest-${cur.gen}.json objects/volumes 必须是数组` };
  }
  // r7 P1-2：current 与 manifest 各建唯一 name set——任意重复卷名拒绝；两边集合
  // 必须双向相等（Map.size 相等不能替代反向校验：manifest=[v1,v2] vs
  // current=[v1,v1] 时 size 与长度都恰好相等，v2 会被静默丢失）
  const manVols = new Map<string, VolRec>();
  for (const v of manifest.volumes) {
    if (typeof v?.name !== "string" || typeof v?.sha256 !== "string") {
      return { state: "corrupt", error: `manifest-${cur.gen}.json 卷条目非法: ${JSON.stringify(v)}` };
    }
    if (manVols.has(v.name)) {
      return { state: "corrupt", error: `manifest-${cur.gen}.json 重复卷名: ${v.name}` };
    }
    manVols.set(v.name, v);
  }
  // 卷集合一致：current.volumes 与 manifest.volumes 名称集合一致且逐卷 sha256 一致
  for (const cv of cur.volumes) {
    const mv = manVols.get(cv.name);
    if (!mv) {
      return { state: "corrupt", error: `current.json 卷 ${cv.name} 不在 manifest-${cur.gen}.json 中（不同代/损坏）` };
    }
    if (cv.sha256 !== mv.sha256) {
      return { state: "corrupt", error: `卷 ${cv.name} 的 sha256 在 current.json 与 manifest-${cur.gen}.json 不一致` };
    }
  }
  for (const [name] of manVols) {
    if (!curNames.has(name)) {
      return {
        state: "corrupt",
        error: `manifest-${cur.gen}.json 卷 ${name} 不在 current.json 中（发布指针缺失/不同代）——存在发布历史时禁止重初始化`,
      };
    }
  }
  return { state: "ok", gen: cur.gen, manifestPath: mp, manifest, pointer: cur };
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

// ---------- manifest 构造与指针落盘（--initial / --patch 共享） ----------

function buildManifestObject(gen: number, objects: ObjRec[], volumes: VolRec[], totalSize: number) {
  return {
    format_version: 1,
    gen,
    object_count: objects.length,
    total_size: totalSize,
    volume_limit_bytes: VOL_LIMIT,
    objects,
    volumes,
  };
}

function serializeManifest(m: unknown): string {
  return JSON.stringify(m, null, 2) + "\n";
}

// 代际决策（共享）：候选序列化与上一代清单逐字节一致 → 沿用旧 gen 不落盘；
// 否则 gen+1（无旧代 = gen 1 初始化）。调用方保证 build(gen) 确定性。
function decideGeneration(
  old: { gen: number; manifestPath: string } | null,
  build: (gen: number) => string
): { gen: number; manifestBytes: string; wroteManifest: boolean } {
  if (!old) return { gen: 1, manifestBytes: build(1), wroteManifest: true };
  const candidate = build(old.gen);
  if (candidate === readFileSync(old.manifestPath, "utf8")) {
    return { gen: old.gen, manifestBytes: candidate, wroteManifest: false };
  }
  return { gen: old.gen + 1, manifestBytes: build(old.gen + 1), wroteManifest: true };
}

function writeCurrentPointer(gen: number, manifestSha: string, volumes: CurrentVol[]): void {
  const current = {
    gen,
    manifest_sha256: manifestSha,
    manifest_path: `manifest/manifest-${gen}.json`,
    volumes,
    updated_at: new Date().toISOString(),
  };
  writeFileSync(path.join(MANIFEST_DIR, "current.json"), JSON.stringify(current, null, 2) + "\n");
}

// gen 保留 N 代（只清理本工具命名模式的文件）
function pruneOldManifests(): void {
  const gens = readdirSync(MANIFEST_DIR)
    .map((f) => /^manifest-(\d+)\.json$/.exec(f))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ f: m[0], n: parseInt(m[1], 10) }))
    .sort((a, b) => a.n - b.n);
  for (const g of gens.slice(0, Math.max(0, gens.length - GEN_KEEP))) {
    rmSync(path.join(MANIFEST_DIR, g.f));
    log(`[clean] 移除过期 manifest ${g.f}（保留最近 ${GEN_KEEP} 代）`);
  }
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
  log(`[initial] 扫描 ${SOURCE_DIR}: ${totalFiles} 文件, ${totalBytes} 字节, ${months.size} 个月份组`);

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

  // r6 P0-3：三态载入——损坏/缺失清单绝不允许被当作全新仓库重初始化
  const curState = loadCurrentState();
  if (curState.state === "corrupt") die(curState.error);
  const old = curState.state === "ok"
    ? { gen: curState.gen, manifestPath: curState.manifestPath, manifest: curState.manifest }
    : null;
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

  // r6 P0-2：prev 指针提前取用——已发布卷的重打包闸门（见循环内）需要它，
  // 指针对账合并本身仍在任何 manifest/current 落盘之前
  const prevPtrs = curState.state === "ok" ? curState.pointer.volumes : null;
  const publishedPtrs = new Map(
    (prevPtrs ?? [])
      .filter((v) => typeof v.asset_id === "number" && v.asset_id > 0)
      .map((v) => [v.name, v])
  );

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
    // 已发布卷重打包闸门（先于任何落盘）：同名卷已被发布（指针 asset_id > 0）时，
    // 重打包只允许「逐字节确定性重建」（布局与逐成员源 sha256 与已发布 manifest 完全
    // 一致，用于 staging 丢失/损坏后的修复）；任何布局或内容漂移在写盘前直接
    // fail-closed——否则 packVolume 会先把漂移内容覆盖进既有 staging 卷，毁掉已发布卷
    // 的本地权威副本（A2 硬约束）。r6 P0-2 的指针对账合并仍在其后兜底。
    if (!skipped) {
      const ptr = publishedPtrs.get(v.name);
      if (ptr) {
        const objs = oldObjs.get(v.name) || [];
        const layoutOk = objs.length === v.members.length && objs.every(
          (o, i) => o.key === v.members[i].key
            && o.size === v.members[i].entry.size
            && o.offset === v.members[i].dataOffset
        );
        let drifted: string | null = null;
        if (layoutOk) {
          for (let i = 0; i < v.members.length; i++) {
            if ((await hashFile(v.members[i].entry.abs)) !== objs[i].sha256) {
              drifted = v.members[i].key;
              break;
            }
          }
        }
        if (!layoutOk || drifted !== null) {
          die(
            `已发布卷 ${v.name}（asset_id=${ptr.asset_id}）重打包前检出` +
              `${!layoutOk ? "布局漂移" : `内容漂移（${drifted}）`}——同名卷不可变（A2 硬约束），` +
              `已发布卷禁止重打包覆盖；已发布月份的源漂移必须改走 --patch 补丁卷方案`
          );
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

  // manifest 生成（内容与上一代完全一致时不产生新 gen）——构造/序列化/代际决策
  // 与 --patch 共享同一代码路径
  const { gen, manifestBytes, wroteManifest } = decideGeneration(
    old ? { gen: old.gen, manifestPath: old.manifestPath } : null,
    (g) => serializeManifest(buildManifestObject(g, objects, volumes, totalBytes))
  );
  const manifestSha = sha256Bytes(manifestBytes);

  // r6 P0-2 / P0-3：指针对账（含 prev 已发布卷缺失的反向 fail-closed）必须先于
  // 任何 manifest/current 落盘——失败即 die：不写 manifest、不写 current、不推进
  // gen、不清 staging（已发布 staging 卷的写前闸门见循环内）
  const merged = mergePublishedPointers(volumes, prevPtrs);
  if (!merged.ok) die(merged.error);

  if (wroteManifest) {
    writeFileSync(path.join(MANIFEST_DIR, `manifest-${gen}.json`), manifestBytes);
  }

  // 清理本次规划之外的孤儿卷（同命名模式的旧产物），避免污染上传阶段
  //（r6 P0-2：挪到指针对账之后——fail-closed 路径绝不删除任何 staging 卷）
  const plannedNames = new Set(plan.map((v) => v.name));
  for (const f of readdirSync(STAGING)) {
    if (/^vol-\d{4}-\d{2}-\d+\.tar$/.test(f) && !plannedNames.has(f)) {
      rmSync(path.join(STAGING, f));
      log(`[clean] 移除孤儿卷 ${f}`);
    }
  }

  // r5 P0-2 / r6 P0-2：写 current.json——已发布指针按 name+sha256 对账保留，
  // url 统一改写为 asset id API URL（r5 P1-16）；写入口与 --patch 共享
  writeCurrentPointer(gen, manifestSha, merged.volumes);
  log(`[initial] 指针对账：保留已发布指针 ${merged.preserved}/${volumes.length}（url 统一为 asset id API URL）`);

  // gen 保留 N 代（只清理本工具命名模式的文件）
  pruneOldManifests();

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

// ---------- Phase 0.3：增量补丁（--patch） ----------

// 补丁模式（plan.md Phase 0.3 / spec R4「cron 新媒体传当月补丁卷」）：
// 不动既有卷与既有指针，只新增补丁卷并换代。打包/manifest 构造/指针合并全部
// 复用 --initial 的共享代码路径（planMembersInto / packVolume / buildManifestObject /
// decideGeneration / mergePublishedPointers / writeCurrentPointer / pruneOldManifests）。
async function runPatch(): Promise<void> {
  mkdirSync(STAGING, { recursive: true });
  mkdirSync(MANIFEST_DIR, { recursive: true });

  // 补丁要求已有发布历史：absent = 还没有任何 gen（引导 --initial）；corrupt = fail-closed
  const curState = loadCurrentState();
  if (curState.state === "absent") {
    die("current.json 不存在——补丁模式要求已有发布历史，首次打包请用 --initial");
  }
  if (curState.state === "corrupt") die(curState.error);
  const old = {
    gen: curState.gen,
    manifestPath: curState.manifestPath,
    manifest: curState.manifest,
    pointer: curState.pointer,
  };

  // 1. 扫描源目录，按 canonical key 对比当前代 manifest，找新增文件并按月份组聚类
  const months = scanSource();
  const knownKeys = new Set(old.manifest.objects.map((o) => o.key));
  const newByMonth = new Map<string, FileEntry[]>();
  let newFiles = 0;
  let newBytes = 0;
  let vanished = 0;
  for (const [month, files] of months) {
    const add = files.filter((f) => !knownKeys.has(`x/${f.rel}`));
    if (add.length > 0) {
      newByMonth.set(month, add);
      newFiles += add.length;
      newBytes += add.reduce((s, f) => s + f.size, 0);
    }
  }
  {
    const seen = new Set<string>();
    for (const files of months.values()) for (const f of files) seen.add(`x/${f.rel}`);
    vanished = old.manifest.objects.filter((o) => !seen.has(o.key)).length;
  }
  log(
    `[patch] 扫描 ${SOURCE_DIR}: 当前 manifest-${old.gen}.json ${old.manifest.objects.length} 对象; ` +
      `新增 ${newFiles} 文件 / ${newBytes} 字节（月份组: ${[...newByMonth.keys()].sort().join(", ") || "无"}）` +
      (vanished > 0 ? `; 警告: ${vanished} 个已入卷对象在源目录缺失（卷 append-only 不受影响，删除需单独协议，--verify 将报缺失）` : "")
  );
  if (newFiles === 0) {
    log(`[patch] 无新增文件: 不打包、不换代（gen=${old.gen} 保持不变）`);
    return;
  }

  // 2. 规划补丁卷：每月新增一个 patch-<YYYY-MM>-<DD>.tar（DD = 打包日；超限时 seq 分流）
  const now = new Date();
  const day = now.getDate();
  const plan: PlannedVol[] = [];
  for (const [month, files] of newByMonth) {
    planMembersInto(month, files, (seq) => patchVolName(month, day, seq), plan);
  }

  // 3. 防覆盖闸门：同名补丁卷已被当前代 manifest 引用 = 已是不可变卷（A2），同日
  //    重复补丁直接 die（改日重跑即得新卷名）；存在但未被引用 = 上次运行的崩溃残留，
  //    允许确定性重打包覆盖（packVolume 内先删后写）
  const referenced = new Set(old.manifest.volumes.map((v) => v.name));
  for (const v of plan) {
    if (referenced.has(v.name)) {
      die(
        `补丁卷 ${v.name} 已存在且被 manifest-${old.gen}.json 引用（同名卷不可变，A2）——` +
          `同日重复补丁禁止覆盖，请改日重跑 --patch 生成新补丁卷`
      );
    }
  }

  // 4. 预检（打包前）：每个按月 release 的 asset 数 = 既有卷 + 本次补丁卷 ≤ 1000
  const perMonth = new Map<string, number>();
  for (const v of old.manifest.volumes) {
    const mo = monthOfVolume(v.name);
    perMonth.set(mo, (perMonth.get(mo) || 0) + 1);
  }
  for (const v of plan) perMonth.set(v.month, (perMonth.get(v.month) || 0) + 1);
  for (const [month, n] of perMonth) {
    if (n > ASSET_MAX_PER_RELEASE) {
      die(`预检失败: media-${month} 将有 ${n} 卷（asset），超过每 release ${ASSET_MAX_PER_RELEASE} 上限`);
    }
  }
  log(`[patch] 预检通过: ${plan.length} 个补丁卷（${plan.map((v) => `${v.name}:${v.members.length}成员`).join(", ")}），每月 asset 数 ≤${ASSET_MAX_PER_RELEASE}`);

  // 5. 打包补丁卷（与 --initial 共享 packVolume：ustar 构造/流式 sha256/元数据全复用）
  const meta = new MetaSource();
  const newObjects: ObjRec[] = [];
  const patchVols: VolRec[] = [];
  for (const v of plan) {
    const vr = await packVolume(v, newObjects, meta);
    patchVols.push(vr);
    log(`[pack] ${vr.name} ${vr.size} bytes, ${v.members.length} 成员, sha256=${vr.sha256}`);
  }

  // 6. 新代 manifest = 旧对象 + 新对象、旧卷 + 补丁卷（共享构造/序列化/代际决策；
  //    必然产生新代——新对象使序列化结果与上一代必然不同）
  const objects = [...old.manifest.objects, ...newObjects];
  const volumes = [...old.manifest.volumes, ...patchVols];
  const totalSize = objects.reduce((s, o) => s + o.size, 0);
  const { gen, manifestBytes, wroteManifest } = decideGeneration(
    { gen: old.gen, manifestPath: old.manifestPath },
    (g) => serializeManifest(buildManifestObject(g, objects, volumes, totalSize))
  );
  if (gen === old.gen) die("内部错误: 补丁新增对象未产生新代 manifest（候选与旧代逐字节一致）");
  const manifestSha = sha256Bytes(manifestBytes);

  // 7. 指针对账（共享双向 fail-closed）：旧已发布卷按 name+sha256 全部在场 → 指针
  //    原样保留；补丁卷未发布 → 指针 null，待 --publish 回填。合并先于任何落盘。
  const merged = mergePublishedPointers(volumes, old.pointer.volumes);
  if (!merged.ok) die(merged.error);

  if (wroteManifest) {
    writeFileSync(path.join(MANIFEST_DIR, `manifest-${gen}.json`), manifestBytes);
  }
  writeCurrentPointer(gen, manifestSha, merged.volumes);
  pruneOldManifests();

  const totalPatchBytes = patchVols.reduce((s, v) => s + v.size, 0);
  log(`[patch] 完成: gen ${old.gen} → ${gen}, manifest-${gen}.json ${wroteManifest ? "已写入" : "沿用"}（对象 ${objects.length}, 卷 ${volumes.length}）, current.json 已换代`);
  log(`[patch] 指针对账: 旧已发布指针保留 ${merged.preserved}/${volumes.length}（原样不动）, 补丁指针 ${patchVols.length} 条待 --publish 回填`);
  log(`[patch] 补丁卷 ${patchVols.length} 个 / ${totalPatchBytes} 字节 / ${newObjects.length} 新对象; 尺寸元数据: media-meta 命中 ${meta.hits}, ffprobe 回退 ${meta.fallback}, 省略字段 ${meta.omitted}, 含 duration_ms ${meta.msCount}`);
  log(`[patch] 下一步: bun tools/media-pack.ts --publish 上传补丁卷到对应月份 release，随后由主流程完成指针 git 提交`);
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

export type GhAsset = { id: number; name: string; size: number; digest: string | null; browser_download_url: string };
export type GhRelease = { tag_name: string; assets: GhAsset[] };

// 卷名 → 月份（--publish 按月对位 release、--patch 预检共享）。
// vol-<YYYY-MM>-<seq>.tar 与补丁卷 patch-<YYYY-MM>-<DD>[-<seq>].tar 两种命名模式。
export function monthOfVolume(name: string): string {
  let m = /^vol-(\d{4}-\d{2})-\d{3}\.tar$/.exec(name);
  if (m) return m[1];
  m = /^patch-(\d{4}-\d{2})-\d{2}(?:-\d+)?\.tar$/.exec(name);
  if (m) return m[1];
  die(`卷名无法解析月份: ${name}`);
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
  // r6 P0-3：与 --initial 共用三态载入——current.json 缺失/损坏/sha 不符/
  // 卷集合不一致（含「current 多出 manifest 没有的卷」的反向校验）一律 die
  const st = loadCurrentState();
  if (st.state === "absent") die("current.json 不存在，请先运行 --initial");
  if (st.state === "corrupt") die(st.error);
  return { cur: st.pointer, manifest: st.manifest };
}

// r7 P1-5：上传前统一预检（纯函数，不产生任何副作用）——对每个月份 release：
// 1. 幂等分类（仅 size+digest 双一致才复用；不一致 = A2 冲突直接拒绝）；
// 2. 投影 asset 总量 = 远端既有（含同名复用，它们已在远端计数中）+ 待上传，
//    超过 1000 立即拒绝。旧实现只数本次 manifest 选中的卷数，漏计远端既有
//    无关 asset，且总数检查发生在上传之后——超限副作用先于失败发生。
// 所有判定先于任何 release 创建/上传副作用，任何月份失败 = 整体退出零副作用。
export type UploadPlanEntry = {
  month: string;
  tag: string;
  need: VolRec[];
  reused: number;
  remoteCount: number;
};
export type UploadPlan = { ok: true; plan: UploadPlanEntry[] } | { ok: false; error: string };

export function planUploads(
  byMonth: Map<string, VolRec[]>,
  releases: Map<string, GhRelease>
): UploadPlan {
  const plan: UploadPlanEntry[] = [];
  for (const month of [...byMonth.keys()].sort()) {
    const list = byMonth.get(month)!;
    const tag = `media-${month}`;
    const rel = releases.get(tag);
    const remoteCount = rel?.assets.length ?? 0;
    // 幂等跳过（r5 P0-3）：仅 size+digest 双一致才跳过；不一致直接拒绝——
    // 同名 asset 不可变是 A2 硬约束，不再 --clobber 重传
    const assetByName = new Map((rel?.assets ?? []).map((a) => [a.name, a]));
    const need: VolRec[] = [];
    let reused = 0;
    for (const v of list) {
      const cls = classifyRemoteAsset(v, assetByName.get(v.name));
      if (cls.action === "skip") {
        reused += 1;
        continue;
      }
      if (cls.action === "die") return { ok: false, error: cls.reason };
      need.push(v);
    }
    const projected = remoteCount + need.length;
    if (projected > ASSET_MAX_PER_RELEASE) {
      return {
        ok: false,
        error:
          `预检失败: ${tag} 上传后将有 ${projected} asset（远端既有 ${remoteCount} + 待上传 ${need.length}），` +
          `超过每 release ${ASSET_MAX_PER_RELEASE} 上限——上传前退出，未产生任何 release/上传副作用`,
      };
    }
    plan.push({ month, tag, need, reused, remoteCount });
  }
  return { ok: true, plan };
}

async function runPublish(only?: string): Promise<void> {
  const t0 = Date.now();
  if (only && !/^\d{4}-\d{2}$/.test(only)) die(`--only 参数非法: ${only}（应为 YYYY-MM）`);
  const { cur, manifest } = loadCurrentStrict();

  // r6 P0-2：current.json 卷集合与 manifest 卷集合双向对齐（名称 + 逐卷 sha256）
  // 已由 loadCurrentState 的三态校验完成——manifest 有 current 没有 / current 有
  // manifest 没有（历史卷缺失）两种方向都 fail-closed，此处为显式断言位
  const curVolByName = new Map(cur.volumes.map((v) => [v.name, v]));
  const manifestVolNames = new Set(manifest.volumes.map((v) => v.name));
  for (const v of manifest.volumes) {
    const cv = curVolByName.get(v.name);
    if (!cv) die(`manifest 卷不在 current.json: ${v.name}`);
    if (cv.sha256 !== v.sha256) die(`current 与 manifest 卷 sha256 不一致: ${v.name}`);
  }
  for (const cv of cur.volumes) {
    if (!manifestVolNames.has(cv.name)) {
      die(`current.json 卷不在 manifest 中（历史卷缺失/不同代？）: ${cv.name}`);
    }
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

  // 无网络快速预检（远端拉取前）：本次 manifest 选中卷数本身超限直接失败
  for (const [month, list] of byMonth) {
    if (list.length > ASSET_MAX_PER_RELEASE) {
      die(`预检失败: media-${month} 需 ${list.length} asset，超过每 release ${ASSET_MAX_PER_RELEASE} 上限`);
    }
  }

  log(`[publish] 拉取远端 release 列表…`);
  const releases = listGhReleases();

  // r7 P1-5：上传前统一预检（纯函数）——逐月幂等分类 + 投影 asset 总量
  //（远端既有 + 待上传）。所有判定先于任何 release 创建/上传副作用：
  // 任何月份超限或 A2 冲突 = 整体退出，不产生部分上传
  const planned = planUploads(byMonth, releases);
  if (!planned.ok) die(planned.error);
  log(`[publish] 上传前预检通过: ${planned.plan.length} 个按月 release，每 release 投影 asset 数 ≤${ASSET_MAX_PER_RELEASE}`);
  for (const p of planned.plan) {
    log(
      `[publish] ${p.tag}: ${p.remoteCount > 0 ? `release 已存在（远端 asset ${p.remoteCount}）` : "release 将创建"}` +
        `，复用 ${p.reused} / 待上传 ${p.need.length}，投影 asset ${p.remoteCount + p.need.length}`,
    );
  }

  let created = 0;
  let existed = 0;
  let uploaded = 0;
  let reused = 0;
  let uploadedBytes = 0;

  for (const p of planned.plan) {
    const { tag, need } = p;
    const list = byMonth.get(p.month)!;
    let rel = releases.get(tag);
    if (!rel) {
      const notes = `cdn-media 月度媒体卷归档 ${tag}：共 ${list.length} 个 tar 卷（vol-NNN 基础卷与 patch-NN 补丁卷），由 media-pack --publish 上传；对象索引以仓库 manifest 为准（卷内容不可变，asset 即权威副本）。`;
      runGh(["release", "create", tag, "--repo", GH_REPO, "--title", tag, "--notes", notes], GH_API_TIMEOUT_MS);
      rel = { tag_name: tag, assets: [] };
      releases.set(tag, rel);
      created += 1;
      log(`[publish] ${tag}: release 已创建（${need.length} asset 待传）`);
    } else {
      existed += 1;
    }
    if (need.length > 0) {
      uploadAssets(tag, need);
      uploaded += need.length;
      uploadedBytes += need.reduce((s, v) => s + v.size, 0);
    }
    reused += p.reused;
    log(`[publish] ${tag}: 本月上传 ${need.length} / 复用 ${p.reused}，累计 asset ${p.remoteCount + need.length}（${list.reduce((s, v) => s + v.size, 0)} 字节）`);
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
  // --source <dir>：打包源目录（月份目录根），--initial/--patch/--verify 共用（Phase 3）
  const srcIdx = args.indexOf("--source");
  if (srcIdx >= 0) {
    const dir = args[srcIdx + 1];
    if (!dir) {
      console.error("--source 需要一个目录参数（月份目录根，目录下直接是 YYYY-MM/）");
      process.exit(2);
    }
    SOURCE_DIR = resolveSourceDir(dir);
  }
  if (args.includes("--initial")) {
    await runInitial();
  } else if (args.includes("--patch")) {
    await runPatch();
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
    console.error("用法: bun cdn-media/tools/media-pack.ts --initial | --patch | --verify | --publish [--only YYYY-MM] | --drill <dir> [--steps N]");
    console.error("  --initial            扫描打包源（默认 cdn-media/staging/x，--source 可覆盖）按月打包 USTAR 卷到 cdn-media/staging，生成 manifest 与 current.json（已发布指针按 name+sha256 对账保留，url 统一 asset id API URL）");
    console.error("  --patch              增量补丁：manifest 未收录的新文件（默认扫 cdn-media/staging/x，--source 可覆盖）按月打包为 patch-<YYYY-MM>-<DD>.tar 并换代（不动既有卷与已发布指针；同日同名补丁卷已被引用则拒绝覆盖）；无新增则不换代");
  console.error("  --source <dir>       打包源目录（月份目录根，目录下直接是 YYYY-MM/）；Phase 3 起默认 cdn-media/staging/x（canonical key 布局），--initial/--patch/--verify 共用");
    console.error("  --verify             本地恢复演练：manifest + 卷 → 解包恢复 → 与源目录全量 sha256 对账");
    console.error("  --publish [--only M] 上传 staging 卷到 GitHub Releases（按月 release，幂等可重入；同名 asset 不可变，不一致直接报错），完成后回填 current.json 的 asset_id 与 url（API URL）");
    console.error("  --drill <dir>        外部恢复演练：空目录，只经公网 URL 拉取 current/manifest/卷并全量恢复 sha256 对账；--steps N 限步（2 = 指针+清单校验冒烟）");
    process.exit(2);
  }
}
