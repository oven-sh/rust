#!/bin/sh
# in-container.sh IMAGE [toolchain.ts arguments]
#
# The checkout is at /checkout, where rust-lang's builds have it: profiles name a file-local
# function by the path of its source file.
set -eu
image=$1
shift
cd "$(dirname "$0")/.."
if ! docker image inspect "$image" >/dev/null 2>&1; then
  [ -z "${GH_TOKEN:-}" ] || echo "$GH_TOKEN" | docker login ghcr.io -u "$GITHUB_ACTOR" --password-stdin
  docker pull -q "$image"
fi
mkdir -p obj/home
# As the calling user, so that git trusts the checkout and the outputs are theirs.
exec docker run --rm --init -v "$PWD:/checkout" -w /checkout \
  --user "$(id -u):$(id -g)" -e HOME=/checkout/obj/home \
  -v /etc/passwd:/etc/passwd:ro -v /etc/group:/etc/group:ro \
  ${DOCKER_RUN_ARGS:-} "$image" node bun/toolchain.ts "$@"
