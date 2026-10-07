# cdn-media.gaubee.com

gaubee.com 的媒体分发仓库（cdn-base 的持久兜底源）。

## 职责

- **GitHub Releases 分卷载体**：存量与增量媒体按月分卷（≤200MB/卷，append-only）挂在
  [Releases](https://github.com/Gaubee/cdn-media.gaubee.com/releases)；卷是不可变 asset，
  一经发布禁止改写/覆盖。
- **manifest（git 指针模型，A2 契约）**：清单权威在本仓 **main 分支** `manifest/` 目录——
  `current.json`（`{gen, manifest_sha256, volumes:[{asset_id,url,sha256,name}]}` 指针 +
  各卷发布收据）→ `manifest-<gen>.json`（文件 → 卷/偏移/sha256 的完整对象集，按约定
  永不重写）。换代 = 一次 git commit（新增 manifest-<gen>.json + 更新 current.json），
  回滚 = git revert，gen 保留 10 代；消费者经 raw.githubusercontent 读 main（无 API
  限额），sha256 校验通过才采用，失败保 last-known-good。
- **工具**：`tools/`（media-pack 打包/发布/演练，staging-clean 保留期清理；由主仓编排，
  见主仓 openspec/specs/cdn-media）。

## 引用

本仓库以 git submodule 挂载于主仓 `gaubee/gaubee.com` 的 `cdn-media/` 路径。
媒体路径契约与分发架构见主仓 `openspec/specs/cdn-media/spec.md`。

注意：**媒体二进制不进本仓库 git 历史**（体积红线），一律走 Releases assets。
