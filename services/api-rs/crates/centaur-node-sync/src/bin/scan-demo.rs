//! scan-demo — read an overlay `upper` and print the classified capture ops as
//! JSON. Used by the on-node integration validation (mount a real overlay, do
//! create/delete/rename/symlink in `merged`, run this on `upper`, assert the ops).
//!
//!   scan-demo <upper_dir>                     # print {ops, skipped} JSON
//!   scan-demo --read <upper_dir> <rel_path>   # hardened openat2 read (exit 13 on ELOOP)

#[cfg(target_os = "linux")]
fn main() {
    use centaur_node_sync::{scan_to_ops, fs_linux};
    use std::path::Path;

    let args: Vec<String> = std::env::args().collect();
    if args.len() >= 4 && args[1] == "--read" {
        // Hardened read: prove a symlink escape is refused (ELOOP) and a regular
        // file reads through. Print the bytes on success; exit 13 on a blocked path.
        match fs_linux::read_file_safe(Path::new(&args[2]), Path::new(&args[3]), 3) {
            Ok(bytes) => {
                print!("{}", String::from_utf8_lossy(&bytes));
            }
            Err(e) => {
                eprintln!("read blocked: {e}");
                std::process::exit(13);
            }
        }
        return;
    }

    let upper = Path::new(args.get(1).map(String::as_str).unwrap_or("."));
    let entries = fs_linux::read_upper_entries(upper).expect("read upper");
    let (ops, skipped) = scan_to_ops(&entries);
    // Hand-rolled JSON (ops already derive Serialize, but we avoid pulling serde_json).
    let ops_json: Vec<String> = ops
        .iter()
        .map(|op| format!("{op:?}").replace('"', "'"))
        .collect();
    let skipped_json: Vec<String> = skipped.iter().map(|(p, r)| format!("{p:?}:{r:?}")).collect();
    println!("OPS[{}]", ops.len());
    for o in &ops_json {
        println!("  {o}");
    }
    println!("SKIPPED[{}]", skipped.len());
    for s in &skipped_json {
        println!("  {s}");
    }
}

#[cfg(not(target_os = "linux"))]
fn main() {
    eprintln!("scan-demo is linux-only (overlay scanning)");
    std::process::exit(1);
}
