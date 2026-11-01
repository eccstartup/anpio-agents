#!/bin/sh
# 构建工具执行镜像；默认标签与 router 的 container.image 一致。
set -eu
cd "$(dirname "$0")"
docker build -t "${ANP_CONTAINER_IMAGE:-anp-toolbox:latest}" -f Containerfile .
