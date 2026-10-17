#[path = "build_support/demo_resources.rs"]
mod demo_resources;

fn main() {
    let manifest = std::path::PathBuf::from(
        std::env::var_os("CARGO_MANIFEST_DIR").expect("Cargo manifest directory"),
    );
    let source = manifest.join("../demo-vault");
    // Cargo watches directories recursively, including newly added/deleted
    // entries. The helper is also an explicit input once rerun rules are set.
    println!("cargo:rerun-if-changed={}", source.display());
    println!("cargo:rerun-if-changed=build_support/demo_resources.rs");
    println!("cargo:rerun-if-changed=build.rs");
    println!("cargo:rerun-if-changed=../shared/policy/mail.v1.json");
    let _held = demo_resources::stage(&source, &manifest.join(".bundle-resources"))
        .expect("could not stage safe demo-vault resources");
    tauri_build::build()
}
