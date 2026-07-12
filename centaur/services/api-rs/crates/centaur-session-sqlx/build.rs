// sqlx::migrate!() embeds the migrations directory at macro expansion, but
// cargo does not treat that directory as a crate input — with a cached target
// dir (the api-rs Docker build keeps one in a cache mount), adding a migration
// without touching any .rs file reuses the stale rlib and the binary ships
// without the new migration (this dropped 1004 on 2026-07-12). This build
// script is sqlx's documented fix: re-fingerprint the crate whenever the
// migrations directory changes.
fn main() {
    println!("cargo:rerun-if-changed=migrations");
}
