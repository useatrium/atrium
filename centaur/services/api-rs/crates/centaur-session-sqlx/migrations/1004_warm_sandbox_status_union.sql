-- Re-assert the warm-sandbox status constraint as the union of upstream's and
-- the fork's status vocabularies.
--
-- Upstream 0033 and fork 1002 both recreate session_warm_sandboxes_status_supported:
-- 1002 (long applied on existing DBs) allows the fork's 'drained' status, which
-- the fork's warm-pool code actively writes; 0033 (newer, applies later on
-- existing DBs) recreates the constraint WITHOUT 'drained' and adds upstream's
-- 'evicting'. Whichever runs last wins, and both orderings lose a status the
-- running code needs. This migration runs after both and pins the union.
--
-- Existing 'drained' rows must be reconciled before 0033 can apply on a live
-- DB (0033 aborts on them); see the 2026-07-11 deploy incident.

alter table session_warm_sandboxes
    drop constraint if exists session_warm_sandboxes_status_supported;

alter table session_warm_sandboxes
    add constraint session_warm_sandboxes_status_supported
        check (status in ('ready', 'claimed', 'evicting', 'failed', 'drained'));
