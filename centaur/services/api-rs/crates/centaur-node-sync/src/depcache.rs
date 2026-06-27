//! Best-effort node-local dependency cache eviction.

use std::path::{Path, PathBuf};
use std::time::UNIX_EPOCH;

const WARMCACHE_RECEIPTS_DIR: &str = ".warmcache-receipts";

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
pub struct EvictStats {
    pub scanned_files: u64,
    pub scanned_bytes: u64,
    pub deleted_files: u64,
    pub freed_bytes: u64,
}

#[derive(Debug, Clone)]
struct DepcacheFile {
    path: PathBuf,
    size: u64,
    recency_nanos: u64,
}

/// Evict least-recently-used regular files under `depcache_root` until the
/// scanned total is at or under `max_bytes`.
///
/// This is intentionally best-effort: live cache files can vanish or fail
/// metadata/removal while the daemon walks. Those files are skipped.
pub fn evict_depcache_lru(depcache_root: &Path, max_bytes: u64) -> EvictStats {
    let mut files = Vec::new();
    collect_depcache_files(depcache_root, &mut files);
    evict_collected_lru(files, max_bytes)
}

fn collect_depcache_files(dir: &Path, out: &mut Vec<DepcacheFile>) {
    let Ok(rd) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in rd {
        let Ok(entry) = entry else { continue };
        let Ok(ft) = entry.file_type() else { continue };
        let path = entry.path();
        if ft.is_dir() {
            if path.file_name().and_then(|name| name.to_str()) == Some(WARMCACHE_RECEIPTS_DIR) {
                continue;
            }
            collect_depcache_files(&path, out);
        } else if ft.is_file() {
            let Ok(meta) = entry.metadata() else {
                continue;
            };
            out.push(DepcacheFile {
                path,
                size: meta.len(),
                recency_nanos: recency_nanos(&meta),
            });
        }
    }
}

fn evict_collected_lru(mut files: Vec<DepcacheFile>, max_bytes: u64) -> EvictStats {
    let mut stats = EvictStats {
        scanned_files: files.len() as u64,
        scanned_bytes: files
            .iter()
            .fold(0_u64, |total, file| total.saturating_add(file.size)),
        deleted_files: 0,
        freed_bytes: 0,
    };
    if stats.scanned_bytes <= max_bytes {
        return stats;
    }

    files.sort_by(|a, b| {
        a.recency_nanos
            .cmp(&b.recency_nanos)
            .then_with(|| a.path.cmp(&b.path))
    });
    let mut remaining = stats.scanned_bytes;
    for file in files {
        if remaining <= max_bytes {
            break;
        }
        if std::fs::remove_file(&file.path).is_err() {
            continue;
        }
        remaining = remaining.saturating_sub(file.size);
        stats.deleted_files += 1;
        stats.freed_bytes = stats.freed_bytes.saturating_add(file.size);
    }
    stats
}

fn recency_nanos(meta: &std::fs::Metadata) -> u64 {
    time_nanos(meta.accessed().ok()).max(time_nanos(meta.modified().ok()))
}

fn time_nanos(time: Option<std::time::SystemTime>) -> u64 {
    time.and_then(|time| time.duration_since(UNIX_EPOCH).ok())
        .map(|duration| duration.as_nanos().min(u64::MAX as u128) as u64)
        .unwrap_or(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs;
    use std::thread;
    use std::time::Duration;
    use tempfile::TempDir;

    fn write_file(path: &Path, bytes: usize) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).unwrap();
        }
        fs::write(path, vec![b'x'; bytes]).unwrap();
    }

    fn sleep_for_distinct_mtime() {
        thread::sleep(Duration::from_millis(25));
    }

    #[test]
    fn evicts_oldest_files_until_under_cap() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let oldest = root.join("pnpm-store/oldest");
        let middle = root.join("cargo/registry/middle");
        let newest = root.join("uv/newest");
        write_file(&oldest, 4);
        sleep_for_distinct_mtime();
        write_file(&middle, 4);
        sleep_for_distinct_mtime();
        write_file(&newest, 4);

        let stats = evict_depcache_lru(root, 5);

        assert_eq!(stats.scanned_files, 3);
        assert_eq!(stats.scanned_bytes, 12);
        assert_eq!(stats.deleted_files, 2);
        assert_eq!(stats.freed_bytes, 8);
        assert!(!oldest.exists());
        assert!(!middle.exists());
        assert!(newest.exists());
    }

    #[test]
    fn under_cap_is_noop() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let file = root.join("pnpm-store/pkg");
        write_file(&file, 4);

        let stats = evict_depcache_lru(root, 5);

        assert_eq!(stats.scanned_files, 1);
        assert_eq!(stats.scanned_bytes, 4);
        assert_eq!(stats.deleted_files, 0);
        assert_eq!(stats.freed_bytes, 0);
        assert!(file.exists());
    }

    #[test]
    fn warmcache_receipts_dir_is_never_evicted() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let cache_file = root.join("pnpm-store/pkg");
        let receipt = root.join(".warmcache-receipts/receipt.json");
        write_file(&cache_file, 4);
        sleep_for_distinct_mtime();
        write_file(&receipt, 100);

        let stats = evict_depcache_lru(root, 0);

        assert_eq!(stats.scanned_files, 1);
        assert_eq!(stats.scanned_bytes, 4);
        assert_eq!(stats.deleted_files, 1);
        assert_eq!(stats.freed_bytes, 4);
        assert!(!cache_file.exists());
        assert!(receipt.exists());
    }

    #[test]
    fn vanished_file_does_not_abort_eviction() {
        let tmp = TempDir::new().unwrap();
        let root = tmp.path();
        let missing = root.join("pnpm-store/missing");
        let present = root.join("pnpm-store/present");
        write_file(&present, 4);

        let stats = evict_collected_lru(
            vec![
                DepcacheFile {
                    path: missing,
                    size: 4,
                    recency_nanos: 1,
                },
                DepcacheFile {
                    path: present.clone(),
                    size: 4,
                    recency_nanos: 2,
                },
            ],
            0,
        );

        assert_eq!(stats.scanned_files, 2);
        assert_eq!(stats.scanned_bytes, 8);
        assert_eq!(stats.deleted_files, 1);
        assert_eq!(stats.freed_bytes, 4);
        assert!(!present.exists());
    }
}
