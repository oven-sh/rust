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
# gdb stops after the prologue (fill_well_known+0x44), so sp is already the frame base; the slot
# HashMap::extend reads the iterator's size_hint() lower bound from is frame+0x8e0 (ldr x21, [sp, #0x8e0]).
x/2i \$pc
set \$slot = (unsigned long *)((char *)\$sp + 0x8e0)
printf "frame sp=%p slot=%p (initial contents 0x%lx 0x%lx)\\n", \$sp, \$slot, *(\$slot-1), *\$slot
# also catch the reader: the load at the block that computes the reserve amount

watch -l *\$slot
commands
  printf "---- write to slot: now 0x%lx (pair: 0x%lx 0x%lx)  sp=%p fwk-frame=[%p,%p)\\n", *\$slot, *(\$slot-1), *\$slot, \$sp, (char*)\$slot - 0x8e0, (char*)\$slot - 0x8e0 + 0x2e20
  info registers x0 x1 x8 x9 x21 x22 sp pc
  x/12i \$pc-32
  info symbol \$pc
  bt 8
  continue
end
# stop for good once the panic starts (everything after is noise)
break rust_begin_unwind
break __rustc::rust_begin_unwind
break _RNvCs*7___rustc17rust_begin_unwind
continue
GDB
  eval "timeout 600 gdb -batch -x cmds.gdb --args stage2/bin/rustc $args" < /dev/null 2>&1 | grep -vE "^\[(New|Thread|Inferior)|^warning: |Missing separate debuginfo|^Download|^target_|^lib___|^___$|^unix$|^debug_assertions|^panic=|^proc_macro|^overflow_checks|^fmt_debug|^relocation_model|^ub_checks|^bun_codegen|^off$|^packed$|^unpacked$" | head -400 || true
done
# where the instrumented library's BOLT runtime lives, for mapping the pcs above
readelf -SW "$name.instrumented" | grep -E "bolt|\.text" || true
