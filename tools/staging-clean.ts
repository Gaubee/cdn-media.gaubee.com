// staging-clean.ts — cdn-media staging 清理工具（r13 P1-3：保留期协议的唯一执行者）
//
// 意图（正交意图清单）：
// - [2026-10-07 r13 P1-3] 原需求（plan 3.3 / SKILL 媒体管道裁决冻结）：staging 保留期 =
//   「发布校验通过后 7 天清理」，此前无执行者。本工具默认 dry-run 只打印将删清单；
//   --execute 才真删。安全条件（全部满足才删）：
//     1. 文件在当前 manifest 对象集内（复用 media-pack 的 loadCurrentState 三态校验）
//     2. 对象所在卷已发布——current.json volumes[] 的 asset_id ≥1 且 url 非空（发布收据）
//     3. 文件 mtime 距今超过 7 天
//     4. 文件位于 staging/x/ 下（canonical 布局；卷 tar 与 .verify-restore 不在范围）
//   任何读取/解析失败 fail-closed：不删任何文件。
// - [2026-10-07] 与 media-pack 的关系：只读复用其 manifest 载入/校验；本工具绝不打包、
//   不换代、不碰 staging 外的卷 tar。
//
// 用法:
//   bun cdn-media/tools/staging-clean.ts              # dry-run：只打印将删清单，不动文件
//   bun cdn-media/tools/staging-clean.ts --execute    # 真删（协议见 SKILL/rollout 的
//                                                     # 「staging 清理协议」：dry-run 先行）
//
// 验证: bun test cdn-media/tools/staging-clean.test.ts

import { mkdirSync, readdirSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { loadCurrentState } from "./media-pack.ts";

const STAGING_X = path.resolve(import.meta.dir, "..", "staging", "x");
const RETENTION_DAYS = 7;
const RETENTION_MS = RETENTION_DAYS * 24 * 60 * 60 * 1000;

function fail(msg: string): never {
  console.error(`[staging-clean] 错误: ${msg}`);
  process.exit(1);
}

function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(2)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${n} B`;
}

type StagedFile = { abs: string; rel: string; size: number; mtimeMs: number };

// 递归扫 staging/x；任何读取失败直接抛（fail-closed，绝不当空目录处理）
function walkStagingX(root: string): StagedFile[] {
  const out: StagedFile[] = [];
  const stack: string[] = [root];
  while (stack.length) {
    const dir = stack.pop()!;
    let ents: import("node:fs").Dirent[];
    try {
      ents = readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      throw new Error(`staging/x 目录读取失败（fail-closed）: ${dir}: ${e}`);
    }
    for (const ent of ents) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) {
        stack.push(abs);
        continue;
      }
      if (!ent.isFile()) {
        throw new Error(`staging/x 下存在非常规文件（fail-closed，不猜测语义）: ${abs}`);
      }
      let st: import("node:fs").Stats;
      try {
        st = statSync(abs);
      } catch (e) {
        throw new Error(`staging/x 文件 stat 失败（fail-closed）: ${abs}: ${e}`);
      }
      out.push({ abs, rel: path.relative(root, abs), size: st.size, mtimeMs: st.mtimeMs });
    }
  }
  return out;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a !== "--execute");
  if (unknown.length) fail(`未知参数: ${unknown.join(" ")}（用法: staging-clean.ts [--execute]）`);
  const execute = args.includes("--execute");

  // 安全条件 1+2 的依据：loadCurrentState 三态校验（current 缺失/损坏/sha 不符/
  // 卷集合不一致一律 fail-closed），发布收据以 current.json 卷指针为准
  const curState = loadCurrentState();
  if (curState.state === "absent") {
    fail("current.json 不存在——没有任何发布收据可依据，fail-closed 不清理");
  }
  if (curState.state === "corrupt") {
    fail(curState.error);
  }
  if (curState.state !== "ok") fail("unreachable：manifest 状态既非 absent 也非 corrupt");
  const { gen, manifest, pointer } = curState;

  // 对象 key → 所在卷；卷名 → 已发布（asset_id ≥1 且 url 非空 = 发布校验通过收据）
  const keyToVolume = new Map<string, string>();
  for (const o of manifest.objects) keyToVolume.set(o.key, o.volume);
  const publishedVolumes = new Set<string>();
  for (const v of pointer.volumes) {
    if (typeof v.asset_id === "number" && v.asset_id >= 1 && typeof v.url === "string" && v.url.length > 0) {
      publishedVolumes.add(v.name);
    }
  }

  // 扫描 + 四条件逐条判定（读取/解析失败在这里抛出 → fail-closed 不删任何文件）
  const now = Date.now();
  const candidates: StagedFile[] = [];
  const skipNotInManifest: string[] = []; // 不在 manifest（待打包/孤儿——审计工具管辖）
  const skipUnpublished: string[] = []; // 在 manifest 但卷未发布（待 --publish）
  const skipRetention: string[] = []; // 已发布但未满 7 天
  let stagingBytesTotal = 0;
  const files = walkStagingX(STAGING_X);
  for (const f of files) {
    stagingBytesTotal += f.size;
    // 安全条件 4：防逃逸断言（walk 已约束在 root 下，双保险）
    const relCheck = path.relative(STAGING_X, f.abs);
    if (relCheck.startsWith("..") || path.isAbsolute(relCheck)) {
      fail(`扫描结果逃逸 staging/x（fail-closed）: ${f.abs}`);
    }
    const key = `x/${f.rel}`;
    const volume = keyToVolume.get(key);
    if (volume === undefined) {
      skipNotInManifest.push(key);
      continue;
    }
    if (!publishedVolumes.has(volume)) {
      skipUnpublished.push(key);
      continue;
    }
    if (now - f.mtimeMs <= RETENTION_MS) {
      skipRetention.push(key);
      continue;
    }
    candidates.push(f);
  }

  const candidateBytes = candidates.reduce((s, f) => s + f.size, 0);
  console.log(`[staging-clean] manifest gen ${gen}：对象 ${manifest.objects.length}，已发布卷 ${publishedVolumes.size}/${pointer.volumes.length}`);
  console.log(
    `[staging-clean] staging/x 共 ${files.length} 文件 / ${fmtBytes(stagingBytesTotal)}：` +
      `将删 ${candidates.length} / ${fmtBytes(candidateBytes)}；` +
      `不动：未入卷 ${skipNotInManifest.length} · 未发布 ${skipUnpublished.length} · 未满 ${RETENTION_DAYS} 天 ${skipRetention.length}`,
  );
  for (const f of candidates) {
    console.log(`  - x/${f.rel}（${fmtBytes(f.size)}，mtime ${new Date(f.mtimeMs).toISOString()}）`);
  }

  if (!execute) {
    console.log("[staging-clean] dry-run：未删除任何文件（确认清单无误后加 --execute 执行）");
    return;
  }

  // --execute：先完整收集（任何失败已在上方退出），此处才允许落删除
  let deleted = 0;
  let freedBytes = 0;
  for (const f of candidates) {
    try {
      rmSync(f.abs);
    } catch (e) {
      fail(`删除失败（中止收据输出，剩余文件保持原状）: ${f.abs}: ${e}`);
    }
    deleted += 1;
    freedBytes += f.size;
  }
  // 收据里的「剩余」以删除后的真实盘点为准，不用减法估算
  let remainingCount = 0;
  let remainingBytes = 0;
  for (const f of walkStagingX(STAGING_X)) {
    remainingCount += 1;
    remainingBytes += f.size;
  }
  console.log(
    `[staging-clean] 收据：删除 ${deleted} 个文件 / 释放 ${fmtBytes(freedBytes)}；` +
      `staging/x 剩余 ${remainingCount} 个文件 / ${fmtBytes(remainingBytes)}`,
  );
}

export { RETENTION_DAYS, RETENTION_MS, STAGING_X, fmtBytes, walkStagingX };

if (import.meta.main) {
  mkdirSync(STAGING_X, { recursive: true }); // 不存在视为空 staging（扫描仍 fail-closed 于读错误）
  await main();
}
