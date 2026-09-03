use anyhow::Context;
use camino::{Utf8Path, Utf8PathBuf};

use crate::environment::Environment;
use crate::exec::cmd;
use crate::training::BoltProfile;
use crate::utils::io::copy_file;

/// Instruments an artifact at the given `path` (in-place) with BOLT and then calls `func`.
/// After this function finishes, the original file will be restored.
pub fn with_bolt_instrumented<F: FnOnce(&Utf8Path) -> anyhow::Result<R>, R>(
    env: &Environment,
    path: &Utf8Path,
    func: F,
) -> anyhow::Result<R> {
    // Back up the original file.
    // It will be restored to its original state when this function exits.
    // By copying it, we break any existing hard links, so that they are not affected by the
    // instrumentation.
    let _backup_file = BackedUpFile::new(path)?;

    // Keep the pre-BOLT library (and below, the instrumented one) with the other opt-artifacts
    // before anything runs it, so a crash or stall from here on can be reproduced from the
    // uploaded inputs alone.
    let inputs_dir = env.artifact_dir().join("bolt-inputs");
    std::fs::create_dir_all(&inputs_dir)?;
    let file_name = path.file_name().expect("BOLT input has a file name");
    copy_file(path, &inputs_dir.join(file_name))?;

    let instrumented_path = tempfile::NamedTempFile::new()?.into_temp_path();

    let profile_dir =
        tempfile::TempDir::new().context("Could not create directory for BOLT profiles")?;
    let profile_prefix = profile_dir.path().join("prof.fdata");
    let profile_prefix = Utf8Path::from_path(&profile_prefix).unwrap();

    // Instrument the original file with BOLT, saving the result into `instrumented_path`
    cmd(&[env.llvm_bolt().as_str()])
        .arg("-instrument")
        .arg(path)
        .arg(&format!("--instrumentation-file={profile_prefix}"))
        // Make sure that each process will write its profiles into a separate file
        .arg("--instrumentation-file-append-pid")
        .arg("-o")
        .arg(instrumented_path.display())
        .run()
        .with_context(|| anyhow::anyhow!("Could not instrument {path} using BOLT"))?;

    // Copy the instrumented artifact over the original one
    copy_file(&instrumented_path, path)?;
    copy_file(&instrumented_path, &inputs_dir.join(format!("{file_name}.instrumented")))?;

    // Run the function that will make use of the instrumented artifact.
    // The original file will be restored when `_backup_file` is dropped.
    func(profile_prefix)
}

/// Optimizes the file at `path` with BOLT in-place using the given `profile`.
pub fn bolt_optimize(
    path: &Utf8Path,
    profile: &BoltProfile,
    env: &Environment,
) -> anyhow::Result<()> {
    // Copy the artifact to a new location, so that we do not use the same input and output file.
    // BOLT cannot handle optimizing when the input and output is the same file, because it performs
    // in-place patching.
    let temp_path = tempfile::NamedTempFile::new()?.into_temp_path();
    copy_file(path, &temp_path)?;

    // Keep the inputs of this step (the pre-BOLT library and its merged profile) with the other
    // opt-artifacts, so a slow or failing llvm-bolt run can be reproduced without redoing the
    // hours before it.
    let inputs_dir = env.artifact_dir().join("bolt-inputs");
    std::fs::create_dir_all(&inputs_dir)?;
    let file_name = path.file_name().expect("BOLT input has a file name");
    copy_file(&profile.0, &inputs_dir.join(format!("{file_name}.fdata")))?;

    // FIXME: cdsplit in llvm-bolt is currently broken on AArch64, drop this once it's fixed upstream
    let split_strategy =
        if env.host_tuple().starts_with("aarch64") { "profile2" } else { "cdsplit" };

    // Bounded: llvm-bolt has been seen not to terminate on aarch64 shared libraries; fail in
    // OPT_DIST_BOLT_TIMEOUT (default 45m) rather than at the job's limit. The python shim reports
    // the run's peak RSS and wall time, since memory is the suspect.
    let timeout = std::env::var("OPT_DIST_BOLT_TIMEOUT").unwrap_or_else(|_| "45m".to_string());
    // OPT_DIST_BOLT_MEM_LIMIT (bytes of address space, via prlimit): make a runaway rewrite fail
    // with ENOMEM instead of taking the machine down with it. Unset = unlimited.
    let mem_limit = std::env::var("OPT_DIST_BOLT_MEM_LIMIT").ok();
    const MEASURE: &str = r#"
import resource, subprocess, sys, time, os
o = sys.argv[sys.argv.index('-o') + 1] if '-o' in sys.argv else '?'
log = os.environ['OPT_DIST_BOLT_LOG']
t = time.time()
# llvm-bolt's own output goes to a file, not the job's log pipe: if it floods, nothing blocks, and
# the file says what it printed.
with open(log, 'wb') as f:
    r = subprocess.run(sys.argv[1:], stdout=f, stderr=subprocess.STDOUT)
u = resource.getrusage(resource.RUSAGE_CHILDREN)
lines = sum(1 for _ in open(log, 'rb'))
print(f'[bolt] {o}: exit={r.returncode} wall={time.time()-t:.0f}s maxrss={u.ru_maxrss//1024}MiB output={lines} lines in {log}', file=sys.stderr, flush=True)
os.system(f"grep -v 'BOLT-INFO: (Starting|Finished) pass' -E {log} | tail -60 >&2")
sys.exit(r.returncode)
"#;
    let update_debug_sections = std::env::var_os("OPT_DIST_BOLT_NO_DEBUG_UPDATE").is_none();
    // While it runs, a sampler logs memory and the llvm-bolt process state every 30 s, so a
    // stall shows up in the log with numbers next to it.
    const SAMPLER: &str = r#"
import os, time, sys
def meminfo():
    m = {l.split(':')[0]: int(l.split()[1]) // 1024 for l in open('/proc/meminfo')}
    return f"used={m['MemTotal']-m['MemAvailable']}M avail={m['MemAvailable']}M swap_used={m['SwapTotal']-m['SwapFree']}M"
def bolts():
    out = []
    for pid in os.listdir('/proc'):
        if not pid.isdigit(): continue
        try:
            if os.readlink(f'/proc/{pid}/exe').rsplit('/', 1)[-1] != 'llvm-bolt': continue
            st = {l.split(':')[0]: l.split(':', 1)[1].strip() for l in open(f'/proc/{pid}/status')}
            stat = open(f'/proc/{pid}/stat').read().rsplit(')', 1)[1].split()
            wchan = open(f'/proc/{pid}/wchan').read() or '-'
            out.append(f"pid={pid} state={st['State']} rss={int(st['VmRSS'].split()[0])//1024}M hwm={int(st['VmHWM'].split()[0])//1024}M threads={st['Threads']} utime={int(stat[11])//100}s stime={int(stat[12])//100}s wchan={wchan}")
        except (OSError, KeyError): pass
    return ' | '.join(out) or 'no llvm-bolt process'
log = open(os.environ['OPT_DIST_BOLT_LOG'] + '.samples', 'a')
while True:
    time.sleep(10)
    line = f"[bolt-sample] {time.strftime('%H:%M:%S', time.gmtime())} {meminfo()} :: {bolts()}"
    print(line, file=log, flush=True)
    print(line, file=sys.stderr, flush=True)
"#;
    let bolt_log = inputs_dir.join(format!("{file_name}.bolt.log"));
    let mut sampler = std::process::Command::new("python3").arg("-c").arg(SAMPLER).env("OPT_DIST_BOLT_LOG", bolt_log.as_str()).spawn().ok();
    let mut argv: Vec<String> = vec!["python3".into(), "-c".into(), MEASURE.into()];
    if let Some(limit) = &mem_limit {
        argv.extend(["prlimit".into(), format!("--as={limit}")]);
    }
    argv.extend(["timeout".into(), "--verbose".into(), "-k".into(), "60s".into(), timeout.clone(), env.llvm_bolt().to_string()]);
    let argv_ref: Vec<&str> = argv.iter().map(String::as_str).collect();
    let mut bolt = cmd(&argv_ref)
        .env("OPT_DIST_BOLT_LOG", bolt_log.as_str())
        .arg(temp_path.display())
        .arg("-data")
        .arg(&profile.0)
        .arg("-o")
        .arg(path)
        // Reorder basic blocks within functions
        .arg("-reorder-blocks=ext-tsp")
        // Reorder functions within the binary
        .arg("-reorder-functions=cdsort")
        // Split function code into hot and code regions
        .arg("-split-functions")
        // Split using best available strategy (three-way splitting, Cache-Directed Sort)
        .arg(format!("-split-strategy={split_strategy}"))
        // Split as many basic blocks as possible
        .arg("-split-all-cold")
        // Move jump tables to a separate section
        .arg("-jump-tables=move")
        // Fold functions with identical code
        .arg("-icf=all")
        // The following flag saves about 50 MiB of libLLVM.so size.
        // However, it succeeds very non-deterministically. To avoid frequent artifact size swings,
        // it is kept disabled for now.
        // FIXME(kobzol): try to re-enable this once BOLT in-place rewriting is merged or after
        // we bump LLVM.
        // Try to reuse old text segments to reduce binary size
        // .arg("--use-old-text")
        // Print optimization statistics
        .arg("-dyno-stats")
        // Per-pass and per-rewrite-phase timers (BOLT-INFO lines at exit): free, and they say where
        // the time went when a rewrite is slow.
        .arg("-time-opts")
        .arg("-time-rewrite");
    // Update DWARF debug info in the final binary (OPT_DIST_BOLT_NO_DEBUG_UPDATE=1 skips it, to
    // measure its cost)
    if update_debug_sections {
        bolt = bolt.arg("-update-debug-sections");
    }
    if std::env::var_os("OPT_DIST_BOLT_VERBOSE").is_some() {
        bolt = bolt.arg("-v=1");
    }
    let result = bolt.run().with_context(|| anyhow::anyhow!("Could not optimize {path} with BOLT"));
    if let Some(s) = sampler.as_mut() {
        let _ = s.kill();
        let _ = s.wait();
    }
    result?;

    Ok(())
}

/// Copies a file to a temporary location and restores it (copies it back) when it is dropped.
pub struct BackedUpFile {
    original: Utf8PathBuf,
    backup: tempfile::TempPath,
}

impl BackedUpFile {
    pub fn new(file: &Utf8Path) -> anyhow::Result<Self> {
        let temp_path = tempfile::NamedTempFile::new()?.into_temp_path();
        copy_file(file, &temp_path)?;
        Ok(Self { backup: temp_path, original: file.to_path_buf() })
    }
}

impl Drop for BackedUpFile {
    fn drop(&mut self) {
        copy_file(&self.backup, &self.original).expect("Cannot restore backed up file");
    }
}
