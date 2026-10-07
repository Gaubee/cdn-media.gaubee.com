// staging-clean 夹具测试（r13 P1-3）：
//   bun test cdn-media/tools/staging-clean.test.ts
//
// 覆盖（安全条件矩阵）：
// - 已发布 + 已满 7 天 + 在 manifest：dry-run 只列清单不删；--execute 真删并出收据
// - 未发布（指针 null）：不删（--execute 也不删）
// - 未满 7 天（mtime 新鲜）：不删
// - current.json 缺失（无 manifest）：fail-closed 退出非零，一个文件都不动
// - 未入卷文件（staging 新增、manifest 无记录）：不动（待打包，归审计工具管）
// - 非 --execute 未知参数拒绝
//
// sandbox 结构与 media-pack.test.ts 一致：把 media-pack.ts + staging-clean.ts 拷进
// <tmp>/media/tools/，打包源造在 <tmp>/media/staging/x/，路径经 import.meta.dir 推导，
// 完全隔离真实仓库。发布收据用「回填 current.json 指针」模拟（--publish 不触网）。

import { describe, expect, test } from "bun:test";
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import * as path from "node:path";
import { apiAssetUrl } from "./media-pack.ts";

const TOOLS_SRC = path.resolve(import.meta.dir, "media-pack.ts");
const CLEAN_SRC = path.resolve(import.meta.dir, "staging-clean.ts");

type Sandbox = {
  root: string;
  cleanScript: string;
  packScript: string;
  stagingX: string;
  current: string;
};

function makeSandbox(tag: string): Sandbox {
  const root = mkdtempSync(path.join("/tmp", `sclean-${tag}-`));
  const mediaRepo = path.join(root, "media");
  const stagingX = path.join(mediaRepo, "staging", "x", "2024-05");
  const tools = path.join(mediaRepo, "tools");
  mkdirSync(stagingX, { recursive: true });
  mkdirSync(tools, { recursive: true });
  copyFileSync(TOOLS_SRC, path.join(tools, "media-pack.ts"));
  copyFileSync(CLEAN_SRC, path.join(tools, "staging-clean.ts"));
  writeFileSync(path.join(stagingX, "old.jpg"), Buffer.from("old-published-media"));
  writeFileSync(path.join(stagingX, "fresh.jpg"), Buffer.from("fresh-published-media"));
  return {
    root,
    cleanScript: path.join(tools, "staging-clean.ts"),
    packScript: path.join(tools, "media-pack.ts"),
    stagingX,
    current: path.join(mediaRepo, "manifest", "current.json"),
  };
}

// 打包之后才追加的未入卷文件（打包前写入会被 --initial 收进 manifest，失义）
function addUnpacked(sb: Sandbox): void {
  writeFileSync(path.join(sb.stagingX, "unpacked.txt"), Buffer.from("not-in-manifest-yet"));
}

function run(sb: Sandbox, args: string[] = []): { code: number; stdout: string; stderr: string } {
  const r = Bun.spawnSync(["bun", sb.cleanScript, ...args], { stdout: "pipe", stderr: "pipe" });
  return { code: r.exitCode, stdout: r.stdout.toString(), stderr: r.stderr.toString() };
}

// 打包（产出 manifest gen1 + staging 卷）并把全部指针回填为已发布（模拟 --publish 收据）
function packAndPublish(sb: Sandbox): void {
  const r = Bun.spawnSync(["bun", sb.packScript, "--initial"], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`sandbox --initial 失败: ${r.stderr.toString()}`);
  const cur = JSON.parse(readFileSync(sb.current, "utf8")) as {
    gen: number;
    volumes: { asset_id: number | null; url: string | null; sha256: string; name: string }[];
  };
  const backfilled = {
    ...cur,
    volumes: cur.volumes.map((v, i) => ({ ...v, asset_id: 615171231 + i, url: apiAssetUrl(615171231 + i) })),
  };
  writeFileSync(sb.current, JSON.stringify(backfilled, null, 2) + "\n");
}

// 把 staging/x/<month>/<name> 的 mtime 回拨 N 天
function backdate(sb: Sandbox, name: string, days: number): void {
  const abs = path.join(sb.stagingX, name);
  const past = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
  utimesSync(abs, past, past);
}

// staging/x 全量文件快照（名 → 内容字节），断言「不动」用
function stagingSnap(sb: Sandbox): Map<string, Buffer> {
  const snap = new Map<string, Buffer>();
  const walk = (dir: string) => {
    for (const ent of readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(abs);
      else snap.set(path.relative(sb.stagingX, abs), readFileSync(abs));
    }
  };
  walk(sb.stagingX);
  return snap;
}

const DAY = 24 * 60 * 60 * 1000;

describe("staging-clean（r13 P1-3 七天保留期执行者）", () => {
  test("dry-run：列出「已发布+满 7 天」候选但一个文件都不删", () => {
    const sb = makeSandbox("dryrun");
    try {
      packAndPublish(sb);
      addUnpacked(sb);
      backdate(sb, "old.jpg", 8);
      backdate(sb, "fresh.jpg", 2);
      const before = stagingSnap(sb);
      const r = run(sb);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("dry-run");
      expect(r.stdout).toContain("x/2024-05/old.jpg");
      expect(r.stdout).not.toContain("x/2024-05/fresh.jpg");
      expect(r.stdout).not.toContain("x/2024-05/unpacked.txt");
      expect(stagingSnap(sb)).toEqual(before);
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });

  test("--execute：真删候选，收据给出删除数/释放字节/剩余；未满 7 天与未入卷保持原状", () => {
    const sb = makeSandbox("execute");
    try {
      packAndPublish(sb);
      addUnpacked(sb);
      backdate(sb, "old.jpg", 8);
      const oldSize = statSync(path.join(sb.stagingX, "old.jpg")).size;
      const r = run(sb, ["--execute"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("收据");
      expect(existsSync(path.join(sb.stagingX, "old.jpg"))).toBe(false);
      // 释放字节数与被删文件一致
      expect(r.stdout).toContain(`${oldSize} B`);
      // 安全条件逐条成立：未满 7 天、未入卷的文件都还在
      expect(existsSync(path.join(sb.stagingX, "fresh.jpg"))).toBe(true);
      expect(existsSync(path.join(sb.stagingX, "unpacked.txt"))).toBe(true);
      expect(r.stdout).toContain("未入卷 1");
      expect(r.stdout).toContain("未满 7 天 1");
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });

  test("未发布（指针 null）：--execute 也不删（发布收据缺失）", () => {
    const sb = makeSandbox("unpublished");
    try {
      const r0 = Bun.spawnSync(["bun", sb.packScript, "--initial"], { stdout: "pipe", stderr: "pipe" });
      expect(r0.exitCode).toBe(0);
      backdate(sb, "old.jpg", 30);
      backdate(sb, "fresh.jpg", 30);
      const before = stagingSnap(sb);
      const r = run(sb, ["--execute"]);
      expect(r.code).toBe(0);
      expect(r.stdout).toContain("将删 0");
      expect(stagingSnap(sb)).toEqual(before);
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });

  test("current.json 缺失：fail-closed 退出非零，一个文件都不动", () => {
    const sb = makeSandbox("no-manifest");
    try {
      packAndPublish(sb);
      backdate(sb, "old.jpg", 30);
      rmSync(sb.current);
      const before = stagingSnap(sb);
      const r = run(sb, ["--execute"]);
      expect(r.code).not.toBe(0);
      expect(r.stderr).toContain("fail-closed");
      expect(stagingSnap(sb)).toEqual(before);
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });

  test("current.json 损坏（非法 JSON）：fail-closed 退出非零，一个文件都不动", () => {
    const sb = makeSandbox("bad-manifest");
    try {
      packAndPublish(sb);
      backdate(sb, "old.jpg", 30);
      writeFileSync(sb.current, "{{{not-json");
      const before = stagingSnap(sb);
      const r = run(sb, ["--execute"]);
      expect(r.code).not.toBe(0);
      expect(stagingSnap(sb)).toEqual(before);
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });

  test("未知参数拒绝（exit 非 0，且不删除）", () => {
    const sb = makeSandbox("bad-args");
    try {
      packAndPublish(sb);
      backdate(sb, "old.jpg", 30);
      const before = stagingSnap(sb);
      const r = run(sb, ["--nuke"]);
      expect(r.code).not.toBe(0);
      expect(stagingSnap(sb)).toEqual(before);
    } finally {
      rmSync(sb.root, { recursive: true, force: true });
    }
  });
});
