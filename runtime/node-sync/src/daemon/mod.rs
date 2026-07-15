//! Portable state and decisions owned by the node-sync daemon rather than its
//! filesystem watcher or Linux syscall adapters.

pub mod config;
pub mod loop_state;
pub mod session;
