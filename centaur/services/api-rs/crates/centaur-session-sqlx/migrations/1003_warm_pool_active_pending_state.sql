create table if not exists session_warm_pool_state (
    pool_name text primary key,
    active_workload_key text,
    pending_workload_key text,
    target_size integer not null default 0 check (target_size >= 0),
    generation bigint not null default 0,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now()
);
