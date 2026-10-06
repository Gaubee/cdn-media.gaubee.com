// media-pack 回归测试（r5 修复逐条带测）：
//   bun test cdn-media/tools
//
// 覆盖：
// - classifyRemoteAsset（P0-3）：仅 size+digest 双一致跳过；不一致/digest 缺失 die
// - mergePublishedPointers（P0-2/P1-16）：name+sha256 对账保留指针；url 统一 API URL；
//   已发布卷内容漂移拒绝；未发布卷保持 null
// - sandbox 端到端：--initial 重跑指针保留（P0-2 回归主测）、同尺寸源漂移重打包
//   换代（P1-13）、已发布卷源漂移直接报错（P0-2+A2 联动）
//
// sandbox 结构：脚本以 import.meta.dir 推导路径（TOOLS_DIR/../..），因此把
// media-pack.ts 拷进 <tmp>/media/tools/、源目录造在 <tmp>/static/x-media/ 即可
// 完全隔离真实仓库。

import { describe, expect, test } from "bun:test";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { apiAssetUrl, classifyRemoteAsset, GH_REPO, mergePublishedPointers } from "./media-pack.ts";

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

function readCurrent(sb: Sandbox): { gen: number; manifest_sha256: string; volumes: CurrentVol[] } {
  return JSON.parse(readFileSync(sb.current, "utf8"));
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

test("sandbox r5 P0-2/P1-16 回归：已发布指针重跑 --initial 后保留且 url 统一 API URL", () => {
  const sb = makeSandbox("pointer");
  try {
    expect(runInitial(sb).code).toBe(0);
    const c1 = readCurrent(sb);
    // 模拟 --publish 回填（旧格式 browser_download_url 也在清理之列）
    const backfilled = {
      ...c1,
      volumes: c1.volumes.map((v, i) => ({
        ...v,
        asset_id: 615171231 + i,
        url: `https://github.com/Gaubee/cdn-media.gaubee.com/releases/download/media-x/${v.name}`,
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
