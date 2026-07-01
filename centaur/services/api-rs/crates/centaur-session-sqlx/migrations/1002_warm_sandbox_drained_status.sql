alter table session_warm_sandboxes
    drop constraint if exists session_warm_sandboxes_status_supported;

alter table session_warm_sandboxes
    add constraint session_warm_sandboxes_status_supported
        check (status in ('ready', 'claimed', 'failed', 'drained'));
