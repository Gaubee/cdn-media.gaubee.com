// media-pack 回归测试（r5 修复逐条带测）：
//   bun test cdn-media/tools
//
// 覆盖：
// - classifyRemoteAsset（P0-3）：仅 size+digest 双一致跳过；不一致/digest 缺失 die
// - mergePublishedPointers（P0-2/P1-16）：name+sha256 对账保留指针；url 统一 API URL；
//   已发布卷内容漂移拒绝；未发布卷保持 null
// - monthOfVolume：vol- 卷与 patch- 补丁卷两种命名模式的月份解析（--publish 按月对位）
// - sandbox 端到端：--initial 重跑指针保留（P0-2 回归主测）、同尺寸源漂移重打包
//   换代（P1-13）、已发布卷源漂移直接报错（P0-2+A2 联动，且 staging 写前闸门保住
//   已发布卷字节）、--patch 增量补丁（新 gen 旧指针保留、重复运行不换代、同日防
//   覆盖、崩溃残留可重入、补丁后 --initial 仍 fail-closed）
//
// sandbox 结构：脚本以 import.meta.dir 推导路径（TOOLS_DIR/../..），因此把
// media-pack.ts 拷进 <tmp>/media/tools/、源目录造在 <tmp>/static/x-media/ 即可
// 完全隔离真实仓库。

import { describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { apiAssetUrl, classifyRemoteAsset, GH_REPO, mergePublishedPointers, monthOfVolume, planUploads, type GhAsset, type GhRelease } from "./media-pack.ts";

const SRC = path.resolve(import.meta.dir, "media-pack.ts");

type VolRec = { name: string; size: number; sha256: string; asset_name: string };
type CurrentVol = { asset_id: number | null; url: string | null; sha256: string; name: string };

const vol = (name: string, sha: string): VolRec => ({ name, size: 100, sha256: sha, asset_name: name });

// ---------- P0-3：classifyRemoteAsset ----------

describe("classifyRemoteAsset", () => {
  const v = vol("vol-1970-01-001.tar", "aa".repeat(32));

  test("asset 不存在 → upload（新 asset 追加合法）", () => {
    expect(classifyRemoteAsset(v, undefined)).toEqual({ action: "upload" });
  });

  test("size+digest 双一致 → skip", () => {
    expect(
      classifyRemoteAsset(v, { id: 1, name: v.name, size: v.size, digest: `sha256:${v.sha256}`, browser_download_url: "x" })
    ).toEqual({ action: "skip" });
  });

  test("digest 不一致 → die（禁止覆盖不可变 asset）", () => {
    const r = classifyRemoteAsset(v, { id: 1, name: v.name, size: v.size, digest: `sha256:${"bb".repeat(32)}`, browser_download_url: "x" });
    expect(r.action).toBe("die");
  });

  test("size 不一致 → die", () => {
    const r = classifyRemoteAsset(v, { id: 1, name: v.name, size: v.size + 1, digest: `sha256:${v.sha256}`, browser_download_url: "x" });
    expect(r.action).toBe("die");
  });

  test("digest 缺失（null）→ die：无法证明双一致", () => {
    const r = classifyRemoteAsset(v, { id: 1, name: v.name, size: v.size, digest: null, browser_download_url: "x" });
    expect(r.action).toBe("die");
    if (r.action === "die") expect(r.reason).toContain("不可变");
  });
});

// ---------- P0-2 / P1-16：mergePublishedPointers ----------

describe("mergePublishedPointers", () => {
  test("prev 为空 → 全部 null 指针", () => {
    const r = mergePublishedPointers([vol("v1", "s1")], null);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.volumes).toEqual([{ asset_id: null, url: null, sha256: "s1", name: "v1" }]);
      expect(r.preserved).toBe(0);
    }
  });

  test("name+sha256 一致的已发布卷 → 指针保留且 url 统一为 API URL", () => {
    const prev: CurrentVol[] = [{ asset_id: 615171231, url: "https://github.com/o/r/releases/download/t/v1", sha256: "s1", name: "v1" }];
    const r = mergePublishedPointers([vol("v1", "s1"), vol("v2", "s2")], prev);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.preserved).toBe(1);
      expect(r.volumes[0]).toEqual({ asset_id: 615171231, url: apiAssetUrl(615171231), sha256: "s1", name: "v1" });
      expect(r.volumes[0].url).toBe(`https://api.github.com/repos/${GH_REPO}/releases/assets/615171231`);
      // 未发布的新卷保持 null
      expect(r.volumes[1]).toEqual({ asset_id: null, url: null, sha256: "s2", name: "v2" });
    }
  });

  test("已发布卷 sha256 漂移 → 拒绝（同名卷不可变 A2）", () => {
    const prev: CurrentVol[] = [{ asset_id: 42, url: null, sha256: "s1", name: "v1" }];
    const r = mergePublishedPointers([vol("v1", "s1-changed")], prev);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("不可变");
  });

  test("prev 指针 null（未发布）→ 新结果保持 null", () => {
    const prev: CurrentVol[] = [{ asset_id: null, url: null, sha256: "s1", name: "v1" }];
    const r = mergePublishedPointers([vol("v1", "s1")], prev);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.volumes[0].asset_id).toBeNull();
  });

  // ---- r6 P0-2：prev 已发布卷在本次集合缺失 → fail-closed ----

  test("r6 P0-2: prev 已发布 v1、本次只有 v2 → 拒绝（卷 append-only）", () => {
    const prev: CurrentVol[] = [
      { asset_id: 42, url: apiAssetUrl(42), sha256: "s1", name: "v1" },
    ];
    const r = mergePublishedPointers([vol("v2", "s2")], prev);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("append-only");
      expect(r.error).toContain("v1");
    }
  });

  test("r6 P0-2: prev 未发布卷缺失 → 不受反向对账约束（未发布无 asset）", () => {
    const prev: CurrentVol[] = [{ asset_id: null, url: null, sha256: "s1", name: "v1" }];
    const r = mergePublishedPointers([vol("v2", "s2")], prev);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.volumes.map((v) => v.name)).toEqual(["v2"]);
  });

  test("r6 P0-2: prev 已发布卷全部在场 → 正常合并", () => {
    const prev: CurrentVol[] = [
      { asset_id: 42, url: apiAssetUrl(42), sha256: "s1", name: "v1" },
    ];
    const r = mergePublishedPointers([vol("v1", "s1"), vol("v2", "s2")], prev);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.preserved).toBe(1);
  });

  // ---- r7 P1-2：重复输入保护（不依赖调用方清洗） ----

  test("r7 P1-2: 本次扫描集合重复卷名 → 拒绝", () => {
    const r = mergePublishedPointers([vol("v1", "s1"), vol("v1", "s1")], null);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("重复卷名");
  });

  test("r7 P1-2: prev 指针重复卷名 → 拒绝", () => {
    const dup: CurrentVol[] = [
      { asset_id: 42, url: apiAssetUrl(42), sha256: "s1", name: "v1" },
      { asset_id: 43, url: apiAssetUrl(43), sha256: "s1", name: "v1" },
    ];
    const r = mergePublishedPointers([vol("v1", "s1")], dup);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("重复卷名");
  });
});

// ---------- r7 P1-5：上传前上限闸门（远端既有计入投影） ----------

describe("planUploads（r7 P1-5 上传前预检）", () => {
  const ghAsset = (name: string, over: Partial<GhAsset> = {}): GhAsset => ({
    id: 900000,
    name,
    size: 100,
    digest: null,
    browser_download_url: "https://example.com/x",
    ...over,
  });
  const release = (tag: string, assets: GhAsset[]): GhRelease => ({ tag_name: tag, assets });

  test("远端已有无关 asset 接近上限 → 拒绝且不产出上传计划（零上传副作用）", () => {
    const existing = Array.from({ length: 999 }, (_, i) => ghAsset(`other-${i}.tar`));
    const releases = new Map([["media-2024-05", release("media-2024-05", existing)]]);
    const byMonth = new Map([
      ["2024-05", [vol("vol-2024-05-001.tar", "sa"), vol("vol-2024-05-002.tar", "sb")]],
    ]);
    // 旧实现此处通过（只数本次 2 卷），上传后总数 1001 才爆——新实现上传前拒绝
    const r = planUploads(byMonth, releases);
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.error).toContain("1001");
      expect(r.error).toContain("上传前退出");
    }
  });

  test("同名一致复用计入远端既有、不重复计数；未超限 → 产出精确计划", () => {
    const v1 = vol("vol-2024-05-001.tar", "sa");
    const v2 = vol("vol-2024-05-002.tar", "sb");
    const v3 = vol("vol-2024-05-003.tar", "sc");
    const existing = [
      ...Array.from({ length: 997 }, (_, i) => ghAsset(`other-${i}.tar`)),
      // v1/v2 已发布且 size+digest 双一致 → 复用
      ghAsset(v1.name, { size: 100, digest: "sha256:sa" }),
      ghAsset(v2.name, { size: 100, digest: "sha256:sb" }),
    ];
    const releases = new Map([["media-2024-05", release("media-2024-05", existing)]]);
    const r = planUploads(new Map([["2024-05", [v1, v2, v3]]]), releases);
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan).toHaveLength(1);
      expect(r.plan[0].reused).toBe(2);
      expect(r.plan[0].need.map((v) => v.name)).toEqual([v3.name]);
      expect(r.plan[0].remoteCount).toBe(999);
    }
  });

  test("恰好达到 1000 → 允许；1001 → 拒绝（边界）", () => {
    const v1 = vol("vol-2024-05-001.tar", "sa");
    const existing = Array.from({ length: 999 }, (_, i) => ghAsset(`other-${i}.tar`));
    const releases = new Map([["media-2024-05", release("media-2024-05", existing)]]);
    expect(planUploads(new Map([["2024-05", [v1]]]), releases).ok).toBe(true);
    expect(planUploads(new Map([["2024-05", [v1, vol("vol-2024-05-002.tar", "sb")]]]), releases).ok).toBe(false);
  });

  test("远端同名不一致 → 上传前拒绝（A2，不产生部分上传）", () => {
    const v1 = vol("vol-2024-05-001.tar", "sa");
    const releases = new Map([
      ["media-2024-05", release("media-2024-05", [ghAsset(v1.name, { size: 999, digest: "sha256:zz" })])],
    ]);
    const r = planUploads(new Map([["2024-05", [v1]]]), releases);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("不可变");
  });

  test("release 不存在 → 全部待上传且不超限 → 通过", () => {
    const r = planUploads(
      new Map([["2024-05", [vol("vol-2024-05-001.tar", "sa")]]]),
      new Map()
    );
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.plan[0].remoteCount).toBe(0);
      expect(r.plan[0].need).toHaveLength(1);
      expect(r.plan[0].reused).toBe(0);
    }
  });
});

// ---------- monthOfVolume：vol-/patch- 两种卷名模式的月份解析 ----------

describe("monthOfVolume", () => {
  test("基础卷 vol-<YYYY-MM>-<seq>.tar → 月份", () => {
    expect(monthOfVolume("vol-2026-10-001.tar")).toBe("2026-10");
    expect(monthOfVolume("vol-1970-01-012.tar")).toBe("1970-01");
  });

  test("补丁卷 patch-<YYYY-MM>-<DD>.tar → 月份（发布按月对位 release）", () => {
    expect(monthOfVolume("patch-2026-10-07.tar")).toBe("2026-10");
  });

  test("补丁卷同日分流 patch-<YYYY-MM>-<DD>-<seq>.tar → 月份", () => {
    expect(monthOfVolume("patch-2026-10-07-2.tar")).toBe("2026-10");
    expect(monthOfVolume("patch-1970-01-31-3.tar")).toBe("1970-01");
  });
});

// ---------- sandbox 端到端 ----------

type Sandbox = { root: string; script: string; current: string };

function makeSandbox(tag: string): Sandbox {
  const root = path.join(mkdtempSync(path.join("/tmp", `mpack-${tag}-`)));
  const mainStatic = path.join(root, "static", "x-media");
  const tools = path.join(root, "media", "tools");
  mkdirSync(path.join(mainStatic, "1970-01"), { recursive: true });
  mkdirSync(path.join(mainStatic, "2024-05"), { recursive: true });
  mkdirSync(tools, { recursive: true });
  copyFileSync(SRC, path.join(tools, "media-pack.ts"));
  writeFileSync(path.join(mainStatic, "1970-01", "poster-a.jpg"), Buffer.from("content-A-1970-poster-a"));
  writeFileSync(path.join(mainStatic, "1970-01", "poster-b.jpg"), Buffer.from("content-B-1970-poster-b"));
  writeFileSync(path.join(mainStatic, "2024-05", "clip.mp4"), Buffer.from("content-C-2024-clip"));
  return { root, script: path.join(tools, "media-pack.ts"), current: path.join(root, "media", "manifest", "current.json") };
}

function runInitial(sb: Sandbox): { code: number; stdout: string; stderr: string } {
  const r = Bun.spawnSync(["bun", sb.script, "--initial"], { stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

function runMode(sb: Sandbox, mode: string): { code: number; stdout: string; stderr: string } {
  const r = Bun.spawnSync(["bun", sb.script, mode], { stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

const runPatch = (sb: Sandbox): { code: number; stdout: string; stderr: string } => runMode(sb, "--patch");

function readCurrent(sb: Sandbox): { gen: number; manifest_sha256: string; volumes: CurrentVol[] } {
  return JSON.parse(readFileSync(sb.current, "utf8"));
}

function manifestPath(sb: Sandbox, gen: number): string {
  return path.join(sb.root, "media", "manifest", `manifest-${gen}.json`);
}

function readManifest(sb: Sandbox, gen: number): { objects: { key: string; volume: string; offset: number; size: number; sha256: string }[]; volumes: VolRec[] } {
  return JSON.parse(readFileSync(manifestPath(sb, gen), "utf8"));
}

// 模拟 --publish 回填：把 current.json 全部指针写成已发布（asset_id 从 base 递增）
function backfillPointers(sb: Sandbox, base = 615171231): void {
  const c = readCurrent(sb);
  writeFileSync(
    sb.current,
    JSON.stringify(
      { ...c, volumes: c.volumes.map((v, i) => ({ ...v, asset_id: base + i, url: apiAssetUrl(base + i) })) },
      null,
      2
    ) + "\n"
  );
}

function sha256(buf: Buffer | string): string {
  return new Bun.CryptoHasher("sha256").update(buf).digest("hex");
}

test("sandbox: --initial 产出 gen1 + null 指针，重跑复用不换代", () => {
  const sb = makeSandbox("reuse");
  try {
    const r1 = runInitial(sb);
    expect(r1.code).toBe(0);
    const c1 = readCurrent(sb);
    expect(c1.gen).toBe(1);
    for (const v of c1.volumes) {
      expect(v.asset_id).toBeNull();
      expect(v.url).toBeNull();
    }

    // 第二次（源未变）：逐成员对账一致 → 全复用、内容未变沿用 gen1
    const r2 = runInitial(sb);
    expect(r2.code).toBe(0);
    expect(r2.stdout).toContain("[skip]");
    expect(r2.stdout).toContain("内容未变，沿用");
    expect(readCurrent(sb).gen).toBe(1);
  } finally {
    rmSync(sb.root, { recursive: true, force: true });
  }
});

test("sandbox r5 P0-2/P1-16 回归：已发布指针重跑 --initial 后保留且 url 保持 API URL", () => {
  const sb = makeSandbox("pointer");
  try {
    expect(runInitial(sb).code).toBe(0);
    const c1 = readCurrent(sb);
    // 模拟 --publish 回填：已发布指针写 asset id + API URL
    //（r7 P1-2 起 loadCurrentState 对 url fail-closed：非「null 或 asset id API
    // URL」的 current 直接判 corrupt——browser_download_url 不再进入合法状态空间）
    const backfilled = {
      ...c1,
      volumes: c1.volumes.map((v, i) => ({
        ...v,
        asset_id: 615171231 + i,
        url: apiAssetUrl(615171231 + i),
      })),
    };
    writeFileSync(sb.current, JSON.stringify(backfilled, null, 2) + "\n");

    const r2 = runInitial(sb);
    expect(r2.code).toBe(0);
    expect(r2.stdout).toContain("指针对账");
    const c2 = readCurrent(sb);
    expect(c2.gen).toBe(1, "内容未变不产生新 gen");
    c2.volumes.forEach((v, i) => {
      expect(v.asset_id).toBe(615171231 + i);
      expect(v.url).toBe(apiAssetUrl(615171231 + i));
    });
  } finally {
    rmSync(sb.root, { recursive: true, force: true });
  }
});

test("sandbox r7 P1-2：current.json 携带非 API URL（browser_download_url）→ corrupt 拒绝", () => {
  const sb = makeSandbox("legacy-url");
  try {
    expect(runInitial(sb).code).toBe(0);
    const c1 = readCurrent(sb);
    writeFileSync(
      sb.current,
      JSON.stringify(
        {
          ...c1,
          volumes: c1.volumes.map((v) => ({
            ...v,
            asset_id: 615171231,
            url: `https://github.com/${GH_REPO}/releases/download/media-x/${v.name}`,
          })),
        },
        null,
        2
      ) + "\n"
    );
    const r = runInitial(sb);
    expect(r.code).not.toBe(0, "browser_download_url 不在合法状态空间");
    expect(r.stderr).toContain("url 非法");
    expect(readCurrent(sb).gen).toBe(1);
  } finally {
    rmSync(sb.root, { recursive: true, force: true });
  }
});

test("sandbox r5 P1-13 回归：同大小源内容漂移必须重打包并换代", () => {
  const sb = makeSandbox("drift");
  try {
    expect(runInitial(sb).code).toBe(0);
    const c1 = readCurrent(sb);
    // 同尺寸改写 2024-05/clip.mp4（staging 卷与卷 sha 都不变 → 旧逻辑会静默沿用旧档）
    const original = "content-C-2024-clip";
    const mutated = "drifted-" + "X".repeat(original.length - 8);
    expect(mutated.length).toBe(original.length, "必须是同尺寸漂移");
    const target = path.join(sb.root, "static", "x-media", "2024-05", "clip.mp4");
    writeFileSync(target, Buffer.from(mutated));

    const r2 = runInitial(sb);
    expect(r2.code).toBe(0);
    expect(r2.stdout).toContain("[drift]");
    const c2 = readCurrent(sb);
    expect(c2.gen).toBe(c1.gen + 1, "漂移必须产生新 gen");
    // 新 manifest 的对象 sha256 必须等于漂移后的源内容
    const manifest = JSON.parse(
      readFileSync(path.join(sb.root, "media", "manifest", `manifest-${c2.gen}.json`), "utf8")
    ) as { objects: { key: string; sha256: string }[] };
    const obj = manifest.objects.find((o) => o.key === "x/2024-05/clip.mp4");
    expect(obj?.sha256).toBe(sha256(mutated));
  } finally {
    rmSync(sb.root, { recursive: true, force: true });
  }
});

test("sandbox r5 P0-2+A2 联动：已发布卷源漂移 → --initial 直接报错（不产错档）", () => {
  const sb = makeSandbox("published-drift");
  try {
    expect(runInitial(sb).code).toBe(0);
    const c1 = readCurrent(sb);
    writeFileSync(
      sb.current,
      JSON.stringify(
        { ...c1, volumes: c1.volumes.map((v) => ({ ...v, asset_id: 12345, url: apiAssetUrl(12345) })) },
        null,
        2
      ) + "\n"
    );
    writeFileSync(
      path.join(sb.root, "static", "x-media", "1970-01", "poster-a.jpg"),
      Buffer.from("mutated-AAAA-1970-poster-a")
    );
    const r2 = runInitial(sb);
    expect(r2.code).not.toBe(0, "已发布卷内容漂移必须失败退出");
    expect(r2.stderr).toContain("不可变");
    expect(readCurrent(sb).gen).toBe(1, "失败路径不得改写指针代际");
  } finally {
    rmSync(sb.root, { recursive: true, force: true });
  }
});

test("sandbox: 纯函数 import 不触发 CLI 入口（import.meta.main 守卫）", () => {
  // 走到这里本身即证明：本测试文件 import ./media-pack.ts 未触发 process.exit(2)
  expect(existsSync(SRC)).toBe(true);
});

// ---------- r6 P0-2 sandbox：prev 已发布卷缺失 → 失败且 current/manifest 均不变 ----------

test("sandbox r6 P0-2：prev 已发布 v1、本次只有 v2 → 失败，不写 current、不推进 gen、不清 staging", () => {
  const sb = makeSandbox("missing-vol");
  try {
    expect(runInitial(sb).code).toBe(0);
    const c1 = readCurrent(sb);
    // 模拟两卷均已发布
    writeFileSync(
      sb.current,
      JSON.stringify(
        {
          ...c1,
          volumes: c1.volumes.map((v, i) => ({ ...v, asset_id: 615171231 + i, url: apiAssetUrl(615171231 + i) })),
        },
        null,
        2
      ) + "\n"
    );
    const manifestDir = path.join(sb.root, "media", "manifest");
    const beforeCurrent = readFileSync(sb.current);
    const beforeManifest1 = readFileSync(path.join(manifestDir, "manifest-1.json"));
    const stagingV1 = path.join(sb.root, "media", "staging", "vol-1970-01-001.tar");
    expect(existsSync(stagingV1)).toBe(true);

    // 误删 1970-01 整个月份目录 → 本次扫描只有 2024-05
    rmSync(path.join(sb.root, "static", "x-media", "1970-01"), { recursive: true, force: true });

    const r = runInitial(sb);
    expect(r.code).not.toBe(0, "已发布卷缺失必须失败退出");
    expect(r.stderr).toContain("append-only");
    // 失败路径不产生任何副作用
    expect(readFileSync(sb.current).equals(beforeCurrent)).toBe(true, "current.json 必须逐字节不变");
    expect(readFileSync(path.join(manifestDir, "manifest-1.json")).equals(beforeManifest1)).toBe(true, "manifest-1.json 必须逐字节不变");
    expect(existsSync(path.join(manifestDir, "manifest-2.json"))).toBe(false, "失败不得推进 gen");
    expect(existsSync(stagingV1)).toBe(true, "fail-closed 路径不得清理 staging 孤儿卷");
    expect(readCurrent(sb).gen).toBe(1, "失败路径不得改写指针代际");
  } finally {
    rmSync(sb.root, { recursive: true, force: true });
  }
});

// ---------- r6 P0-3 sandbox：损坏 current/manifest 全部 fail-closed ----------

type CorruptCase = {
  name: string;
  corrupt: (sb: Sandbox) => void;
  expectErrContains: string;
};

const corruptCases: CorruptCase[] = [
  {
    name: "current.json 损坏（非法 JSON）",
    corrupt: (sb) => writeFileSync(sb.current, "{{{not-json"),
    expectErrContains: "禁止重初始化",
  },
  {
    name: "current.json 指向的 manifest 缺失",
    corrupt: (sb) => rmSync(path.join(sb.root, "media", "manifest", "manifest-1.json")),
    expectErrContains: "禁止重初始化",
  },
  {
    name: "manifest sha256 与 current.json 不符",
    corrupt: (sb) => {
      const p = path.join(sb.root, "media", "manifest", "manifest-1.json");
      const j = JSON.parse(readFileSync(p, "utf8")) as { total_size: number };
      j.total_size += 1;
      writeFileSync(p, JSON.stringify(j, null, 2) + "\n");
    },
    expectErrContains: "sha256",
  },
  {
    name: "current.json gen 倒退/非法",
    corrupt: (sb) => {
      const c = JSON.parse(readFileSync(sb.current, "utf8")) as { gen: number };
      c.gen = 0;
      writeFileSync(sb.current, JSON.stringify(c, null, 2) + "\n");
    },
    expectErrContains: "gen",
  },
  {
    name: "current.json manifest_path 注入",
    corrupt: (sb) => {
      const c = JSON.parse(readFileSync(sb.current, "utf8")) as { manifest_path: string };
      c.manifest_path = "../evil/manifest-1.json";
      writeFileSync(sb.current, JSON.stringify(c, null, 2) + "\n");
    },
    expectErrContains: "manifest_path",
  },
  // ---- r7 P1-2：fail-closed 补洞（重复卷名 / 集合不等 / asset_id=0 / 代际不一致） ----
  {
    name: "current.json 少一个 manifest 卷",
    corrupt: (sb) => {
      const c = JSON.parse(readFileSync(sb.current, "utf8")) as { volumes: CurrentVol[] };
      c.volumes = c.volumes.filter((v) => v.name !== "vol-2024-05-001.tar");
      writeFileSync(sb.current, JSON.stringify(c, null, 2) + "\n");
    },
    expectErrContains: "不在 current.json",
  },
  {
    name: "current.json 重复卷名（[v1,v1] vs manifest [v1,v2]）",
    corrupt: (sb) => {
      const c = JSON.parse(readFileSync(sb.current, "utf8")) as { volumes: CurrentVol[] };
      // 两条同名记录：Map.size 与数组长度都恰好相等，旧代码无法察觉
      c.volumes = [c.volumes[0], { ...c.volumes[0] }];
      writeFileSync(sb.current, JSON.stringify(c, null, 2) + "\n");
    },
    expectErrContains: "重复卷名",
  },
  {
    name: "current.json asset_id=0",
    corrupt: (sb) => {
      const c = JSON.parse(readFileSync(sb.current, "utf8")) as { volumes: CurrentVol[] };
      c.volumes[0] = { ...c.volumes[0], asset_id: 0 };
      writeFileSync(sb.current, JSON.stringify(c, null, 2) + "\n");
    },
    expectErrContains: "0 不是合法已发布指针",
  },
  {
    name: "manifest gen 与 current 不一致（SHA 自洽但代际错乱）",
    corrupt: (sb) => {
      const p = manifestPath(sb, 1);
      const j = JSON.parse(readFileSync(p, "utf8")) as { gen: number };
      j.gen = 2;
      const bytes = Buffer.from(JSON.stringify(j, null, 2) + "\n");
      writeFileSync(p, bytes);
      // 同步 current 的 manifest_sha256，让损坏只剩「代际不一致」这一个面
      const c = JSON.parse(readFileSync(sb.current, "utf8")) as { manifest_sha256: string };
      c.manifest_sha256 = sha256(bytes);
      writeFileSync(sb.current, JSON.stringify(c, null, 2) + "\n");
    },
    expectErrContains: "代际错乱",
  },
];

for (const tc of corruptCases) {
  test(`sandbox r6 P0-3/r7 P1-2：${tc.name} → --initial 立即失败且 current/manifest/staging 均不变`, () => {
    const sb = makeSandbox(`corrupt-${tc.expectErrContains.length}`);
    try {
      expect(runInitial(sb).code).toBe(0);
      const manifestDir = path.join(sb.root, "media", "manifest");
      const stagingDir = path.join(sb.root, "media", "staging");
      // r7 P1-2：staging 逐文件字节级快照（名:尺寸:sha256）——fail-closed 路径
      // 不得增删改 staging 任何字节
      const stagingSnap = () =>
        readdirSync(stagingDir)
          .map((f) => {
            const p = path.join(stagingDir, f);
            if (!statSync(p).isFile()) return `${f}:dir`;
            return `${f}:${statSync(p).size}:${sha256(readFileSync(p))}`;
          })
          .sort();

      tc.corrupt(sb);

      // 快照 = 损坏后的状态：失败的运行不得对其做任何进一步改写
      //（不重初始化、不覆盖、不推进 gen、不动 staging）
      const beforeCurrent = readFileSync(sb.current);
      const manifest1Path = path.join(manifestDir, "manifest-1.json");
      const beforeManifest1 = existsSync(manifest1Path) ? readFileSync(manifest1Path) : null;
      const beforeStaging = stagingSnap();

      const r = runInitial(sb);
      expect(r.code).not.toBe(0, `${tc.name} 必须失败退出`);
      expect(r.stderr).toContain(tc.expectErrContains);
      expect(readFileSync(sb.current).equals(beforeCurrent)).toBe(true, "current.json 不得被改写");
      if (beforeManifest1) {
        expect(readFileSync(manifest1Path).equals(beforeManifest1)).toBe(true, "manifest-1.json 不得被改写");
      } else {
        expect(existsSync(manifest1Path)).toBe(false, "缺失的 manifest 不得被工具重建");
      }
      expect(existsSync(path.join(manifestDir, "manifest-2.json"))).toBe(false, "失败不得推进 gen");
      expect(stagingSnap()).toEqual(beforeStaging, "fail-closed 路径不得增删改 staging 任何字节");
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });
}

test("sandbox r6 P0-3：完全没有 current.json → 允许 gen=1 初始化（absent 态回归）", () => {
  const sb = makeSandbox("absent-init");
  try {
    const r = runInitial(sb);
    expect(r.code).toBe(0);
    expect(readCurrent(sb).gen).toBe(1);
  } finally {
    rmSync(sb.root, { recursive: true, force: true });
  }
});

// ---------- Phase 0.3 sandbox：--patch 增量补丁 ----------

const patchDay = (): string => String(new Date().getDate()).padStart(2, "0");

test("sandbox patch: 已发布月份追加文件 → --patch 新 gen，旧指针原样保留，新对象入补丁卷", () => {
  const sb = makeSandbox("patch-basic");
  try {
    expect(runInitial(sb).code).toBe(0);
    backfillPointers(sb);
    const c1 = readCurrent(sb);

    // 向已发布月份 1970-01 追加两个新文件（--initial 对此会因卷不可变而拒绝）
    writeFileSync(path.join(sb.root, "static", "x-media", "1970-01", "late-1.jpg"), Buffer.from("late-content-1"));
    writeFileSync(path.join(sb.root, "static", "x-media", "1970-01", "late-2.jpg"), Buffer.from("late-content-2"));

    const r = runPatch(sb);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("[patch]");

    const c2 = readCurrent(sb);
    expect(c2.gen).toBe(c1.gen + 1, "补丁必须换代");
    expect(c2.volumes.length).toBe(c1.volumes.length + 1);
    // 旧已发布指针按原顺序原样保留（asset_id / url / sha256 / name 全不动的旧卷在前）
    c1.volumes.forEach((v, i) => {
      expect(c2.volumes[i]).toEqual({
        asset_id: 615171231 + i,
        url: apiAssetUrl(615171231 + i),
        sha256: v.sha256,
        name: v.name,
      });
    });
    // 补丁卷指针在末尾，未发布态（asset_id/url 为 null）
    expect(c2.volumes.at(-1)?.name).toMatch(/^patch-1970-01-\d{2}\.tar$/);
    expect(c2.volumes.at(-1)?.asset_id).toBeNull();
    expect(c2.volumes.at(-1)?.url).toBeNull();
    // manifest_sha256 与落盘的 manifest-<gen>.json 一致
    const mBytes = readFileSync(manifestPath(sb, c2.gen));
    expect(c2.manifest_sha256).toBe(sha256(mBytes));

    const m2 = JSON.parse(mBytes.toString()) as {
      objects: { key: string; volume: string; offset: number; size: number; sha256: string; content_type: string }[];
      volumes: VolRec[];
    };
    expect(m2.objects.length).toBe(3 + 2, "旧对象 + 新对象");
    expect(m2.volumes.length).toBe(c1.volumes.length + 1, "旧卷 + 补丁卷");
    const patchVol = m2.volumes.at(-1)!;
    expect(patchVol.name).toBe(c2.volumes.at(-1)?.name);
    for (const [name, content] of [
      ["late-1.jpg", "late-content-1"],
      ["late-2.jpg", "late-content-2"],
    ] as const) {
      const o = m2.objects.find((x) => x.key === `x/1970-01/${name}`);
      expect(o).toBeDefined();
      expect(o!.volume).toBe(patchVol.name, "新对象必须落在补丁卷");
      expect(o!.sha256).toBe(sha256(content));
      expect(o!.content_type).toBe("image/jpeg");
      expect(o!.offset).toBeGreaterThanOrEqual(512);
    }
    // staging 补丁卷真实存在且尺寸与 manifest 一致
    const patchPath = path.join(sb.root, "media", "staging", patchVol.name);
    expect(existsSync(patchPath)).toBe(true);
    expect(statSync(patchPath).size).toBe(patchVol.size);
  } finally {
    rmSync(sb.root, { recursive: true, force: true });
  }
});

test("sandbox patch: 重复 --patch 无新文件 → 不换代、current 逐字节不变", () => {
  const sb = makeSandbox("patch-idempotent");
  try {
    expect(runInitial(sb).code).toBe(0);
    backfillPointers(sb);
    writeFileSync(path.join(sb.root, "static", "x-media", "1970-01", "late-1.jpg"), Buffer.from("late-content-1"));
    expect(runPatch(sb).code).toBe(0);
    expect(readCurrent(sb).gen).toBe(2);

    const before = readFileSync(sb.current);
    const r = runPatch(sb);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("无新增文件");
    expect(r.stdout).toContain("不换代");
    expect(readFileSync(sb.current).equals(before)).toBe(true, "无新增时 current.json 必须逐字节不变");
    expect(readCurrent(sb).gen).toBe(2);
    expect(existsSync(manifestPath(sb, 3))).toBe(false, "无新增不得推进 gen");
  } finally {
    rmSync(sb.root, { recursive: true, force: true });
  }
});

test("sandbox patch: 同日同名补丁卷已被 manifest 引用 → 再有新增文件时 die（防覆盖不可变卷）", () => {
  const sb = makeSandbox("patch-sameday");
  try {
    expect(runInitial(sb).code).toBe(0);
    backfillPointers(sb);
    writeFileSync(path.join(sb.root, "static", "x-media", "1970-01", "late-1.jpg"), Buffer.from("late-content-1"));
    expect(runPatch(sb).code).toBe(0);
    const c2 = readCurrent(sb);
    expect(c2.gen).toBe(2);
    const before = readFileSync(sb.current);
    const patchPath = path.join(sb.root, "media", "staging", `patch-1970-01-${patchDay()}.tar`);
    expect(existsSync(patchPath)).toBe(true);
    const volBefore = readFileSync(patchPath);

    // 同日又来了新文件：补丁卷名与 gen2 引用的相同 → 必须 die，不得覆盖
    writeFileSync(path.join(sb.root, "static", "x-media", "1970-01", "late-2.jpg"), Buffer.from("late-content-2"));
    const r = runPatch(sb);
    expect(r.code).not.toBe(0, "同日重复补丁必须失败退出");
    expect(r.stderr).toContain("禁止覆盖");
    expect(readFileSync(sb.current).equals(before)).toBe(true, "失败路径不得改写 current.json");
    expect(readCurrent(sb).gen).toBe(2);
    expect(existsSync(manifestPath(sb, 3))).toBe(false, "失败不得推进 gen");
    expect(readFileSync(patchPath).equals(volBefore)).toBe(true, "已引用补丁卷字节不得被改写");
  } finally {
    rmSync(sb.root, { recursive: true, force: true });
  }
});

test("sandbox patch: staging 同名卷存在但未被 manifest 引用（崩溃残留）→ 确定性重打包覆盖", () => {
  const sb = makeSandbox("patch-crash-reentry");
  try {
    expect(runInitial(sb).code).toBe(0);
    backfillPointers(sb);
    writeFileSync(path.join(sb.root, "static", "x-media", "1970-01", "late-1.jpg"), Buffer.from("late-content-1"));
    // 模拟上次运行在打包后、manifest/current 落盘前崩溃留下的残卷
    const leftover = path.join(sb.root, "media", "staging", `patch-1970-01-${patchDay()}.tar`);
    writeFileSync(leftover, Buffer.from("corrupted-leftover-from-crashed-run"));

    const r = runPatch(sb);
    expect(r.code).toBe(0, "未被引用的残留卷允许覆盖重打包");
    const c2 = readCurrent(sb);
    expect(c2.gen).toBe(2);
    const m2 = readManifest(sb, 2);
    const patchVol = m2.volumes.at(-1)!;
    expect(patchVol.name).toBe(`patch-1970-01-${patchDay()}.tar`);
    expect(statSync(leftover).size).toBe(patchVol.size);
    expect(sha256(readFileSync(leftover))).toBe(patchVol.sha256, "残留卷必须被确定性重打包为正确内容");
  } finally {
    rmSync(sb.root, { recursive: true, force: true });
  }
});

test("sandbox patch: 无发布历史（current.json 缺失）→ die 引导 --initial", () => {
  const sb = makeSandbox("patch-absent");
  try {
    const r = runPatch(sb);
    expect(r.code).not.toBe(0);
    expect(r.stderr).toContain("--initial");
    expect(existsSync(sb.current)).toBe(false, "失败路径不得创建 current.json");
  } finally {
    rmSync(sb.root, { recursive: true, force: true });
  }
});

test("sandbox patch 后 --initial 仍 fail-closed（r6 P0-2 交互）：已发布卷重打包在写盘前被拦截，staging 字节原样", () => {
  const sb = makeSandbox("patch-initial-guard");
  try {
    expect(runInitial(sb).code).toBe(0);
    backfillPointers(sb);
    writeFileSync(path.join(sb.root, "static", "x-media", "1970-01", "late-1.jpg"), Buffer.from("late-content-1"));
    expect(runPatch(sb).code).toBe(0);
    backfillPointers(sb, 700000000); // 补丁卷也发布（指针回填）
    const c2 = readCurrent(sb);
    expect(c2.gen).toBe(2);

    // 快照：current + 全部 staging 卷字节（含补丁卷）
    const beforeCurrent = readFileSync(sb.current);
    const stagingDir = path.join(sb.root, "media", "staging");
    const volNames = readdirSync(stagingDir);
    expect(volNames.length).toBe(3);
    const volBytes = new Map(volNames.map((n) => [n, readFileSync(path.join(stagingDir, n))]));

    // --initial 重规划会把新文件插进 vol-1970-01-001 的布局 → 必须在写盘前 die
    const r = runInitial(sb);
    expect(r.code).not.toBe(0, "已发布卷布局漂移必须失败退出");
    expect(r.stderr).toContain("不可变");
    expect(readFileSync(sb.current).equals(beforeCurrent)).toBe(true, "current.json 必须逐字节不变");
    expect(existsSync(manifestPath(sb, 3))).toBe(false, "失败不得推进 gen");
    for (const n of volNames) {
      expect(readFileSync(path.join(stagingDir, n)).equals(volBytes.get(n))).toBe(true, `staging 卷 ${n} 字节不得被改写`);
    }
  } finally {
    rmSync(sb.root, { recursive: true, force: true });
  }
});
