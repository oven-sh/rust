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
  # offset (from fill_well_known) of the instruction that reads the slot: ldr x21, [sp, #0x8e0]
  fwk_addr=$(nm --defined-only "$lib" | awk -v f="$fwk" '$3==f {print $1}')
  fwk_size=$(nm -S --defined-only "$lib" | awk -v f="$fwk" '$4==f {print $2}')
  reader_off=$(objdump -d --start-address=0x$fwk_addr --stop-address=$((0x$fwk_addr + 0x$fwk_size)) "$lib" | awk -v base=$((0x$fwk_addr)) '/ldr\tx21, \[sp, #2272\]|ldr\s+x21, \[sp, #0x8e0\]/ { split($1,a,":"); printf "%d\n", strtonum("0x" a[1]) - base; exit }')
  echo "reader: fill_well_known+${reader_off:-?}"
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
break *(\$pc - 0x44 + ${reader_off:-0})
commands
  printf "==== read of slot at fill_well_known+${reader_off:-0}: x21 will be 0x%lx (pair 0x%lx 0x%lx), [sp+0x460]=%p -> +0x20 = 0x%lx\\n", *\$slot, *(\$slot-1), *\$slot, *(void**)((char*)\$sp+0x460), *(unsigned long*)((char*)*(void**)((char*)\$sp+0x460)+0x20)
  continue
end

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
  log="gdb-$lib.log"
  eval "timeout 900 gdb -batch -x cmds.gdb --args stage2/bin/rustc $args" < /dev/null > "$log" 2>&1 || true
  echo "$(grep -c 'write to slot' "$log") writes, $(grep -c 'read of slot' "$log") reads logged → $log ($(wc -l < "$log") lines)"
  grep -nE "write to slot|read of slot|hit Breakpoint [345]|panicked|SIGSEGV|exited" "$log" | tail -40
done
# where the instrumented library's BOLT runtime lives, for mapping the pcs above
readelf -SW "$name.instrumented" | grep -E "bolt|\.text" || true
