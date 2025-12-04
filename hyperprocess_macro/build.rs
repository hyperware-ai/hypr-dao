use std::env;
use std::fs;
use std::path::PathBuf;

fn main() {
    // Kit expects a `.wasm` artifact for this package when targeting wasm32, but this crate is a
    // host-only proc-macro. Emit a tiny placeholder wasm into the wasm target dir so
    // `wasm-tools component new` has something to wrap.
    let profile = env::var("PROFILE").unwrap_or_else(|_| "debug".to_string());
    // Prefer explicit target dir, otherwise use workspace root + /target.
    let manifest_dir = PathBuf::from(env::var("CARGO_MANIFEST_DIR").unwrap());
    let default_target_dir = manifest_dir.parent().unwrap_or(&manifest_dir).join("target");
    let target_dir = env::var("CARGO_TARGET_DIR")
        .map(PathBuf::from)
        .unwrap_or_else(|_| default_target_dir.clone());
    let out_paths = [
        target_dir
            .join("wasm32-wasip1")
            .join(&profile)
            .join("hyperprocess_macro.wasm"),
        // Also emit into the crate-local target dir in case cargo isolates it.
        manifest_dir
            .join("target")
            .join("wasm32-wasip1")
            .join(&profile)
            .join("hyperprocess_macro.wasm"),
    ];
    // Minimal valid wasm header for an empty module.
    let minimal_wasm: [u8; 8] = [0x00, 0x61, 0x73, 0x6D, 0x01, 0x00, 0x00, 0x00];
    for out_path in out_paths {
        if let Some(parent) = out_path.parent() {
            let _ = fs::create_dir_all(parent);
        }
        if fs::write(&out_path, minimal_wasm).is_ok() {
            println!("cargo:warning=Emitted placeholder wasm at {}", out_path.display());
        }
    }
}
