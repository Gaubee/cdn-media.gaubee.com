# cdn-media.gaubee.com

gaubee.com 的媒体分发仓库（cdn-base 的持久兜底源）。

## 职责

- **GitHub Releases 分卷载体**：存量与增量媒体按月分卷（≤200MB/卷，append-only）挂在
  [Releases](https://github.com/Gaubee/cdn-media.gaubee.com/releases)；`media-index`
  release 挂 manifest.json（文件 → 卷/偏移/sha256 的稳定入口）。
- **manifest**：`manifest/` 目录维护清单源文件（打包工具生成的分发副本在 Releases）。
- **打包工具**：`tools/` （media-pack，由主仓编排，见主仓 openspec/specs/cdn-media）。

## 引用

本仓库以 git submodule 挂载于主仓 `gaubee/gaubee.com` 的 `cdn-media/` 路径。
媒体路径契约与分发架构见主仓 `openspec/specs/cdn-media/spec.md`。

注意：**媒体二进制不进本仓库 git 历史**（体积红线），一律走 Releases assets。
