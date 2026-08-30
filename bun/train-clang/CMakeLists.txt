# Handed to LLVM's PGO machinery as CLANG_PGO_TRAINING_DATA_SOURCE_DIR (see
# bun/lib/llvm.ts). clang/utils/perf-training configures this project with the
# instrumented clang as the C/C++ compiler and builds it; every compile and link
# it performs is recorded into the profile. The "project" is a Bun release build.
cmake_minimum_required(VERSION 3.20)
project(bun-toolchain-training LANGUAGES NONE)

find_program(NODE node REQUIRED)

# LLVM_PROFILE_FILE: one .profraw per 4-way merge pool instead of a single file every clang
# process locks (perf-training's own lit run does the same); LLVM_BINARY_DIR is the
# instrumented stage's. LLD_IN_TEST=1: lld otherwise leaves through _exit and the profile
# runtime's atexit writer never runs, i.e. the links would contribute nothing.
add_custom_target(train-on-bun ALL
  COMMAND ${CMAKE_COMMAND} -E env CC=${CMAKE_C_COMPILER} CXX=${CMAKE_CXX_COMPILER}
          LLVM_PROFILE_FILE=${LLVM_BINARY_DIR}/profiles/bun-%4m.profraw LLD_IN_TEST=1
          ${NODE} ${CMAKE_CURRENT_SOURCE_DIR}/../train.ts clang
  USES_TERMINAL
  COMMENT "Building Bun with the instrumented clang")
