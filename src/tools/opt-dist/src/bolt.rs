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
    copy_file(path, &inputs_dir.join(file_name))?;
    copy_file(&profile.0, &inputs_dir.join(format!("{file_name}.fdata")))?;

    // FIXME: cdsplit in llvm-bolt is currently broken on AArch64, drop this once it's fixed upstream
    let split_strategy =
        if env.host_tuple().starts_with("aarch64") { "profile2" } else { "cdsplit" };

    // Bounded: llvm-bolt has been seen not to terminate on aarch64 shared libraries; fail in
    // OPT_DIST_BOLT_TIMEOUT (default 45m) rather than at the job's limit. The python shim reports
    // the run's peak RSS and wall time, since memory is the suspect.
    let timeout = std::env::var("OPT_DIST_BOLT_TIMEOUT").unwrap_or_else(|_| "45m".to_string());
    const MEASURE: &str = "import resource,subprocess,sys,time;t=time.time();r=subprocess.run(sys.argv[1:]);u=resource.getrusage(resource.RUSAGE_CHILDREN);o=sys.argv[sys.argv.index('-o')+1] if '-o' in sys.argv else '?';print(f'[bolt] {o}: exit={r.returncode} wall={time.time()-t:.0f}s maxrss={u.ru_maxrss//1024}MiB',file=sys.stderr,flush=True);sys.exit(r.returncode)";
    let update_debug_sections = std::env::var_os("OPT_DIST_BOLT_NO_DEBUG_UPDATE").is_none();
    let mut bolt = cmd(&["python3", "-c", MEASURE, "timeout", "--verbose", "-k", "60s", timeout.as_str(), env.llvm_bolt().as_str()])
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
        .arg("-dyno-stats");
    // Update DWARF debug info in the final binary (OPT_DIST_BOLT_NO_DEBUG_UPDATE=1 skips it, to
    // measure its cost)
    if update_debug_sections {
        bolt = bolt.arg("-update-debug-sections");
    }
    bolt.run().with_context(|| anyhow::anyhow!("Could not optimize {path} with BOLT"))?;

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
