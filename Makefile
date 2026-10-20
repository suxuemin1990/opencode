# OpenCode 构建命令封装
#
# 用法示例：
#   make install                 # 安装依赖
#   make install-skip            # 安装依赖（跳过/复用已有 node_modules）
#   make build                   # 构建当前平台二进制（默认版本取自 git tag）
#   make build VERSION=2.0.32-vision   # 指定版本号构建
#   make build-all               # 构建全部平台
#   make build-node              # 构建 Node 版（SEA）二进制
#   make clean                   # 清理 CLI 构建产物
#
# 常用变量：
#   VERSION   二进制内嵌版本号（对应 `--version` 输出 `opencode v<VERSION>`）
#   OUTDIR    CLI 构建产物目录（默认 packages/cli/dist）
#   TARGET    指定构建某单一平台，例如 TARGET=opencode-linux-x64
#   EXTRA     向构建命令末尾追加额外参数，例如：
#               make build EXTRA=--skip-web-ui                     # 跳过 web UI 打包
#               make build EXTRA=--outdir=/tmp/my-dist             # 指定产物目录
#               make build EXTRA="--skip-web-ui --outdir=/tmp/d"   # 多个参数需加引号

SHELL := /bin/bash

# 版本号：优先使用 VERSION；否则从最近的 git tag 读取（去掉前导 v）
ifndef VERSION
VERSION := $(shell git describe --tags --abbrev=0 2>/dev/null | sed 's/^v//')
endif
ifndef VERSION
VERSION := 2.0.32
endif

OUTDIR ?= packages/cli/dist

# ---- 依赖安装 ----

install:
	bun install

# 跳过依赖安装（复用已有 node_modules）
install-skip:
	@echo "依赖未重新安装，复用已有 node_modules"

# ---- 二进制构建 ----

# 构建当前平台（linux/darwin/win32 对应本机）二进制
# 可用 EXTRA 追加额外参数，如 EXTRA=--skip-web-ui
build:
	cd packages/cli && OPENCODE_VERSION=$(VERSION) bun run script/build.ts --single $(EXTRA)

# 构建当前平台二进制，并跳过依赖安装（复用已有 node_modules）
build-skip-install:
	cd packages/cli && OPENCODE_VERSION=$(VERSION) bun run script/build.ts --single --skip-install $(EXTRA)

# 构建全部平台二进制
build-all:
	cd packages/cli && OPENCODE_VERSION=$(VERSION) bun run script/build.ts $(EXTRA)

# 构建指定单一平台，例如 TARGET=opencode-linux-x64
build-target:
	cd packages/cli && OPENCODE_VERSION=$(VERSION) bun run script/build.ts --target=$(TARGET) $(EXTRA)

# Node 版（SEA）二进制
build-node:
	cd packages/cli && OPENCODE_VERSION=$(VERSION) bun run script/build-node.ts $(EXTRA)

# ---- 清理 ----

clean:
	rm -rf $(OUTDIR)
	rm -rf packages/cli/dist-node

.PHONY: install install-skip build build-skip-install build-all build-target build-node clean
