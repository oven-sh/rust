#!/bin/bash
# Ad-hoc experiments on the arm64 runner against a saved rust-repro artifact (stage2.tar.zst,
# librustc_driver-*.so{,.instrumented}, probe.sh), extracted into $1. Runs on the runner host,
# not in the container (needs gdb; the stage2 rustc only needs glibc >= the image's).
set -euo pipefail
cd "$1"
ls -la
tar -I zstd -xf stage2.tar.zst
so=$(ls librustc_driver-*.so | head -1); name=$(basename "$so")
command -v gdb >/dev/null || { sudo apt-get update -qq; sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq gdb >/dev/null; }
gdb --version | head -1
# probe.sh: exec "$1/bin/rustc" '<args...>' < /dev/null  →  the argument list
args=$(sed -n 's|^exec "\$1/bin/rustc" \(.*\) < /dev/null$|\1|p' probe.sh)
fwk=$(nm --defined-only "$so" | awk '/ T _RNvMs1_.*8CheckCfg15fill_well_known$/ {print $3}')
echo "fill_well_known = $fwk"
for lib in "$name" "$name.instrumented"; do
  echo; echo "================ $lib ================"
  cp "$lib" "stage2/lib/$name"
  cat > cmds.gdb <<GDB
set pagination off
set confirm off
set print thread-events off
set breakpoint pending on
break $fwk
run
# at function entry: the frame will be entry_sp - 0x80 (callee saves) - 0x2da0; the slot HashMap::extend
# reads the iterator's size_hint() lower bound from is frame+0x8e0 (ldr x21, [sp, #0x8e0]).
set \$slot = (unsigned long *)((char *)\$sp - 0x80 - 0x2da0 + 0x8e0)
printf "entry sp=%p slot=%p\\n", \$sp, \$slot
watch -l *\$slot
commands
  printf "---- write to slot: now 0x%lx (pair: 0x%lx 0x%lx)\\n", *\$slot, *(\$slot-1), *\$slot
  bt 6
  continue
end
continue
GDB
  eval "timeout 600 gdb -batch -x cmds.gdb --args stage2/bin/rustc $args" < /dev/null 2>&1 | grep -vE "^\[(New|Thread|Inferior)|^warning: |Missing separate debuginfo|^Download" | tail -120 || true
done
