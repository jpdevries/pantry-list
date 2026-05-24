// rust-embed's proc-macro doesn't reliably emit `cargo:rerun-if-changed`
// for files inside the embed folder, so changes to `static/` after the
// first build don't trigger a rebuild. Walk the dir here and tell Cargo
// to watch every file. This file is small enough that a second-pass
// build still finishes in seconds.
use std::path::Path;

fn watch(path: &Path) {
    if path.is_dir() {
        for entry in std::fs::read_dir(path).into_iter().flatten().flatten() {
            watch(&entry.path());
        }
    }
    println!("cargo:rerun-if-changed={}", path.display());
}

fn main() {
    let static_dir = Path::new("static");
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=static");
    watch(static_dir);
}
