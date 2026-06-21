//! Linux syscall layer for the node scanner (cfg(target_os = "linux") only).
//!
//! Turns a real overlay `upper` directory into [`RawEntry`]s for the
//! classifier, and provides the symlink-hardened byte reader (openat2 with
//! [`safety::HARDENED_RESOLVE`]). Reading `trusted.overlay.*` xattrs requires
//! CAP_SYS_ADMIN (the scanner is privileged). Exercised by the on-node
//! integration tests (a real overlay mount), not the platform-neutral unit tests.

use std::ffi::CString;
use std::fs;
use std::io;
use std::os::unix::ffi::OsStrExt;
use std::os::unix::fs::{FileTypeExt, MetadataExt};
use std::os::unix::io::{AsRawFd, OwnedFd, FromRawFd};
use std::path::{Path, PathBuf};

use crate::overlay::{RawEntry, RawFileType, XATTR_METACOPY, XATTR_OPAQUE, XATTR_REDIRECT};
use crate::safety::{is_safe_relpath, HARDENED_RESOLVE};
use crate::tornread::{read_stable, FileIdentity, TornReadError};

/// Recursively read every entry under `upper_root` into `RawEntry`s (relative
/// paths). Directories are descended; symlinks are NEVER followed (recorded as
/// metadata only). The caller feeds these to [`crate::classify`].
pub fn read_upper_entries(upper_root: &Path) -> io::Result<Vec<RawEntry>> {
    let mut out = Vec::new();
    walk(upper_root, upper_root, &mut out)?;
    Ok(out)
}

fn walk(root: &Path, dir: &Path, out: &mut Vec<RawEntry>) -> io::Result<()> {
    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        let meta = fs::symlink_metadata(&path)?; // lstat: never traverses a symlink
        let ft = meta.file_type();
        let file_type = if ft.is_symlink() {
            RawFileType::Symlink
        } else if ft.is_dir() {
            RawFileType::Dir
        } else if ft.is_char_device() {
            RawFileType::CharDevice
        } else if ft.is_file() {
            RawFileType::Regular
        } else {
            RawFileType::Other
        };
        let rel = path.strip_prefix(root).unwrap_or(&path).to_path_buf();
        out.push(RawEntry {
            rel_path: rel,
            file_type: file_type.clone(),
            rdev: meta.rdev(),
            size: meta.size(),
            xattrs: read_overlay_xattrs(&path),
        });
        // Descend into real directories only (overlay encodes opaque/redirect on
        // the dir node itself, which the classifier reads from its RawEntry).
        if matches!(file_type, RawFileType::Dir) {
            walk(root, &path, out)?;
        }
    }
    Ok(())
}

fn read_overlay_xattrs(path: &Path) -> Vec<(String, Vec<u8>)> {
    let mut out = Vec::new();
    for name in [XATTR_OPAQUE, XATTR_REDIRECT, XATTR_METACOPY] {
        if let Ok(Some(val)) = xattr::get(path, name) {
            out.push((name.to_string(), val));
        }
    }
    out
}

// === openat2-hardened reads (#1) =========================================

#[repr(C)]
struct OpenHow {
    flags: u64,
    mode: u64,
    resolve: u64,
}

/// Open `rel_path` beneath `dir_fd` with the hardened RESOLVE mask, refusing to
/// traverse any symlink/magic-link or leave the subtree. Returns ELOOP/EXDEV as
/// an error (the agent planted an escape — skip + log). This is the load-bearing
/// defense against `proj-x/leak -> /etc/shadow`.
pub fn open_hardened(dir: &Path, rel_path: &Path) -> io::Result<OwnedFd> {
    if !is_safe_relpath(rel_path) {
        return Err(io::Error::new(io::ErrorKind::InvalidInput, "unsafe relpath"));
    }
    let dirfd = open_dir(dir)?;
    let c_rel = CString::new(rel_path.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "nul in path"))?;
    let how = OpenHow {
        flags: (libc::O_RDONLY | libc::O_CLOEXEC) as u64,
        mode: 0,
        resolve: HARDENED_RESOLVE,
    };
    // SYS_openat2 (437 on most arches); libc exposes the number.
    let ret = unsafe {
        libc::syscall(
            libc::SYS_openat2,
            dirfd.as_raw_fd(),
            c_rel.as_ptr(),
            &how as *const OpenHow,
            std::mem::size_of::<OpenHow>(),
        )
    };
    if ret < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { OwnedFd::from_raw_fd(ret as i32) })
}

fn open_dir(dir: &Path) -> io::Result<OwnedFd> {
    let c = CString::new(dir.as_os_str().as_bytes())
        .map_err(|_| io::Error::new(io::ErrorKind::InvalidInput, "nul in path"))?;
    let fd = unsafe { libc::open(c.as_ptr(), libc::O_RDONLY | libc::O_DIRECTORY | libc::O_CLOEXEC) };
    if fd < 0 {
        return Err(io::Error::last_os_error());
    }
    Ok(unsafe { OwnedFd::from_raw_fd(fd) })
}

/// Read a regular file's bytes safely: hardened open + torn-read guard (re-read
/// while the file changes under us). Returns the settled bytes, or an error if
/// the path escapes (ELOOP) or never settles.
pub fn read_file_safe(dir: &Path, rel_path: &Path, max_retries: u32) -> io::Result<Vec<u8>> {
    use std::io::Read;
    let identity = || -> Result<FileIdentity, TornReadError> {
        let fd = open_hardened(dir, rel_path).map_err(|e| TornReadError::Io(e.to_string()))?;
        let meta = fs::File::from(fd)
            .metadata()
            .map_err(|e| TornReadError::Io(e.to_string()))?;
        Ok(FileIdentity { size: meta.size(), mtime_ns: meta.mtime_nsec() as i128 + (meta.mtime() as i128) * 1_000_000_000, ino: meta.ino() })
    };
    let read = || -> Result<Vec<u8>, TornReadError> {
        let fd = open_hardened(dir, rel_path).map_err(|e| TornReadError::Io(e.to_string()))?;
        let mut f = fs::File::from(fd);
        let mut buf = Vec::new();
        f.read_to_end(&mut buf).map_err(|e| TornReadError::Io(e.to_string()))?;
        Ok(buf)
    };
    read_stable(max_retries, identity, read).map_err(|e| match e {
        TornReadError::ChangedTooManyTimes => io::Error::new(io::ErrorKind::Other, "file never settled"),
        TornReadError::Io(s) => io::Error::new(io::ErrorKind::Other, s),
    })
}
