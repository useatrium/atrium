use super::*;

#[test]
fn harness_auth_fragments_are_baked_in() {
    let codex = harness_auth_fragment("codex", "api_key").unwrap().unwrap();
    let codex_placeholders = placeholder_env(&[codex]);
    assert_eq!(
        codex_placeholders.get("OPENAI_API_KEY").map(String::as_str),
        Some("OPENAI_API_KEY")
    );

    // access_token carries the token-broker credential, not a replace
    // placeholder, so it contributes no sandbox placeholder env.
    let codex_access = harness_auth_fragment("codex", "access_token")
        .unwrap()
        .unwrap();
    assert!(placeholder_env(&[codex_access]).is_empty());

    let openrouter = harness_auth_fragment("openrouter", "api_key")
        .unwrap()
        .unwrap();
    let openrouter_placeholders = placeholder_env(&[openrouter]);
    assert_eq!(
        openrouter_placeholders
            .get("OPENROUTER_API_KEY")
            .map(String::as_str),
        Some("OPENROUTER_API_KEY")
    );

    let meta_ai = harness_auth_fragment("meta-ai", "api_key")
        .unwrap()
        .unwrap();
    let meta_ai_placeholders = placeholder_env(&[meta_ai]);
    assert_eq!(
        meta_ai_placeholders
            .get("META_AI_API_KEY")
            .map(String::as_str),
        Some("META_AI_API_KEY")
    );

    let claude_code = harness_auth_fragment("claude-code", "api_key")
        .unwrap()
        .unwrap();
    let claude_code_placeholders = placeholder_env(&[claude_code]);
    assert_eq!(
        claude_code_placeholders
            .get("ANTHROPIC_API_KEY")
            .map(String::as_str),
        Some("ANTHROPIC_API_KEY")
    );

    assert!(harness_auth_fragment("codex", "bogus").unwrap().is_none());

    let infra = infra_fragment().unwrap();
    assert_eq!(
        infra.top_level["proxy"]["upstream_response_header_timeout"].as_str(),
        Some("120s")
    );
    let placeholders = placeholder_env(&[infra]);
    assert!(placeholders.is_empty());
}

#[test]
fn pg_sandbox_dsns_reads_name_and_database_from_fragments() {
    // A listener with a sandbox_env (the api-rs-internal annotation api-rs
    // stamps from each tool's declared pg_dsn name/database) is surfaced; a
    // listener without one (proxy-only) is skipped. Results are sorted/deduped.
    let fragment = load_fragment_str(
        r#"
postgres:
  - name: reshift_dsn
    sandbox_env:
      name: RESHIFT_DSN
      database: warehouse
  - name: analytics_dsn
    sandbox_env:
      name: ANALYTICS_DSN
      database: analytics
  - name: proxy_only
"#,
    )
    .unwrap();

    let dsns = pg_sandbox_dsns(&[fragment.clone(), fragment]);
    assert_eq!(
        dsns,
        vec![
            ("ANALYTICS_DSN".to_owned(), "analytics".to_owned()),
            ("RESHIFT_DSN".to_owned(), "warehouse".to_owned()),
        ]
    );
}

#[test]
fn access_token_fragment_carries_no_broker_credentials_block() {
    // Broker credentials now live in iron-control, not the proxy fragment. The
    // access-token fragment still references the credential via a token_broker
    // source, but the unknown `broker_credentials:` key (if any) is ignored.
    let codex = harness_auth_fragment("codex", "access_token")
        .unwrap()
        .unwrap();
    assert!(!codex.top_level.contains_key("broker_credentials"));
}

#[test]
fn shipped_proxy_allowlist_preserves_railway_project_tokens() {
    let config: serde_yaml::Value =
        serde_yaml::from_str(include_str!("../../../../iron-proxy/iron-proxy.yaml")).unwrap();
    let transforms = config["transforms"].as_sequence().unwrap();
    let header_allowlist = transforms
        .iter()
        .find(|transform| transform["name"].as_str() == Some("header_allowlist"))
        .unwrap();
    let headers = header_allowlist["config"]["headers"].as_sequence().unwrap();

    assert!(
        headers
            .iter()
            .any(|header| header.as_str() == Some("project-access-token"))
    );
}

#[test]
fn extra_allowlist_fragment_is_empty_by_default() {
    // The default deployment must add no transform at all, so its allowlist stays
    // exactly what the granted credentials imply.
    assert!(extra_allowlist_fragment(&[]).is_none());
    assert!(extra_allowlist_fragment(&["".to_owned(), "   ".to_owned()]).is_none());
}

#[test]
fn extra_allowlist_fragment_declares_domains_and_no_secret() {
    let fragment =
        extra_allowlist_fragment(&["pypi.org".to_owned(), " files.pythonhosted.org ".to_owned()])
            .expect("domains configured");
    let transform = match fragment.transforms.as_slice() {
        [transform] => transform,
        other => panic!("expected exactly one transform, got {}", other.len()),
    };
    assert_eq!(transform.name, "allowlist");
    // Allow the host, inject nothing — the same shape as the per-user codex
    // fragment. A secret here would make iron-control treat it as a credential.
    assert!(transform.config.secrets.is_empty());
    assert_eq!(
        transform.config.extra.get("domains"),
        Some(&serde_yaml::Value::Sequence(vec![
            serde_yaml::Value::String("pypi.org".to_owned()),
            serde_yaml::Value::String("files.pythonhosted.org".to_owned()),
        ]))
    );
}

#[test]
fn extra_allowlist_fragment_does_not_displace_the_harness_allowlist() {
    // The property that makes this safe to deploy: centaur-console unions the
    // domains of EVERY transform named `allowlist` (Proxy.split_allowlist_transforms),
    // so appending ours widens egress rather than replacing codex's chatgpt.com.
    // If this ever became a replace, prod would lose model egress.
    let mut merged = per_user_harness_auth_fragment("codex", "access_token")
        .unwrap()
        .expect("codex per-user fragment");
    let extra = extra_allowlist_fragment(&["pypi.org".to_owned()]).expect("domains configured");
    merged.transforms.extend(extra.transforms);

    let allowlists: Vec<&Transform> = merged
        .transforms
        .iter()
        .filter(|transform| transform.name == "allowlist")
        .collect();
    assert_eq!(
        allowlists.len(),
        2,
        "both allowlists must survive the merge"
    );

    let domains: Vec<String> = allowlists
        .iter()
        .filter_map(|transform| transform.config.extra.get("domains"))
        .filter_map(|value| value.as_sequence())
        .flatten()
        .filter_map(|value| value.as_str().map(str::to_owned))
        .collect();
    assert!(domains.contains(&"chatgpt.com".to_owned()));
    assert!(domains.contains(&"pypi.org".to_owned()));
}
