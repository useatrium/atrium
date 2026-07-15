//! centaur-node-syncd -- the per-node sync daemon (Track C4), stateful and
//! multi-session aware.
//!
//! Portable configuration and session decisions live beside the binary; the
//! syscall and mount orchestration remains Linux-only.

#[cfg(target_os = "linux")]
#[path = "centaur-node-syncd/linux_daemon/mod.rs"]
mod linux_daemon;

#[cfg(target_os = "linux")]
fn main() {
    linux_daemon::main();
}

#[cfg(not(target_os = "linux"))]
fn main() {
    eprintln!("centaur-node-syncd runs on linux nodes only");
    std::process::exit(1);
}
