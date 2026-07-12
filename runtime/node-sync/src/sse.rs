use std::collections::{HashMap, HashSet};

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, serde::Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ChangeFeed {
    Artifacts,
    Atrium,
    Profile,
}

#[derive(Debug, Clone, PartialEq, Eq, serde::Deserialize)]
pub struct ChangedEvent {
    pub feed: ChangeFeed,
    #[serde(default)]
    pub key: Option<String>,
    #[serde(default, rename = "workspaceId")]
    pub workspace_id: Option<String>,
    #[serde(default)]
    pub channels: Vec<String>,
    pub seq: i64,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SseOutput {
    Hello { protocol: Option<u64> },
    Changed(ChangedEvent),
    Malformed { event: String, error: String },
}

#[derive(Debug, Default)]
pub struct SseParser {
    pending: String,
    event: Option<String>,
    data: Vec<String>,
}

impl SseParser {
    pub fn push(&mut self, bytes: &[u8]) -> Vec<SseOutput> {
        self.pending.push_str(&String::from_utf8_lossy(bytes));
        let mut out = Vec::new();
        while let Some(index) = self.pending.find('\n') {
            let mut line = self.pending[..index].to_string();
            if line.ends_with('\r') {
                line.pop();
            }
            self.pending.drain(..=index);
            if let Some(output) = self.push_line(&line) {
                out.push(output);
            }
        }
        out
    }

    pub fn finish(&mut self) -> Vec<SseOutput> {
        if self.pending.is_empty() {
            return Vec::new();
        }
        let line = std::mem::take(&mut self.pending);
        self.push_line(line.trim_end_matches('\r'))
            .into_iter()
            .collect()
    }

    fn push_line(&mut self, line: &str) -> Option<SseOutput> {
        if line.is_empty() {
            return self.dispatch();
        }
        if line.starts_with(':') {
            return None;
        }
        let (field, value) = line.split_once(':').unwrap_or((line, ""));
        let value = value.strip_prefix(' ').unwrap_or(value);
        match field {
            "event" => self.event = Some(value.to_string()),
            "data" => self.data.push(value.to_string()),
            _ => {}
        }
        None
    }

    fn dispatch(&mut self) -> Option<SseOutput> {
        let event = self.event.take().unwrap_or_else(|| "message".to_string());
        let data = std::mem::take(&mut self.data).join("\n");
        match event.as_str() {
            "hello" => {
                let protocol = serde_json::from_str::<serde_json::Value>(&data)
                    .ok()
                    .and_then(|value| value.get("protocol").and_then(|v| v.as_u64()));
                Some(SseOutput::Hello { protocol })
            }
            "changed" => match serde_json::from_str::<ChangedEvent>(&data) {
                Ok(changed) => Some(SseOutput::Changed(changed)),
                Err(error) => Some(SseOutput::Malformed {
                    event,
                    error: error.to_string(),
                }),
            },
            _ => None,
        }
    }
}

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub struct DirtyFeeds {
    pub artifacts: bool,
    pub atrium: bool,
    pub profile: bool,
    pub channel_ids: HashSet<String>,
}

impl DirtyFeeds {
    pub fn any(&self) -> bool {
        self.artifacts || self.atrium || self.profile || !self.channel_ids.is_empty()
    }

    fn mark(&mut self, event: &ChangedEvent) {
        match event.feed {
            ChangeFeed::Artifacts => self.artifacts = true,
            ChangeFeed::Atrium => {
                self.atrium = true;
                self.channel_ids.extend(
                    event
                        .channels
                        .iter()
                        .filter(|id| !id.trim().is_empty())
                        .cloned(),
                );
            }
            ChangeFeed::Profile => self.profile = true,
        }
    }
}

#[derive(Debug, Default)]
pub struct DirtySet {
    by_key: HashMap<String, DirtyFeeds>,
}

impl DirtySet {
    pub fn mark_changed<'a>(
        &mut self,
        event: &ChangedEvent,
        current_session_keys: impl IntoIterator<Item = &'a str>,
    ) {
        if let Some(key) = event.key.as_deref().filter(|key| !key.trim().is_empty()) {
            self.by_key.entry(key.to_string()).or_default().mark(event);
            return;
        }
        for key in current_session_keys {
            self.by_key.entry(key.to_string()).or_default().mark(event);
        }
    }

    pub fn drain_for<'a>(
        &mut self,
        current_session_keys: impl IntoIterator<Item = &'a str>,
    ) -> HashMap<String, DirtyFeeds> {
        let current = current_session_keys
            .into_iter()
            .map(str::to_string)
            .collect::<HashSet<_>>();
        let mut out = HashMap::new();
        let keys = self.by_key.keys().cloned().collect::<Vec<_>>();
        for key in keys {
            if current.contains(&key)
                && let Some(feeds) = self.by_key.remove(&key)
                && feeds.any()
            {
                out.insert(key, feeds);
            }
        }
        self.by_key.retain(|key, _| current.contains(key));
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn changed(feed: ChangeFeed, key: Option<&str>) -> ChangedEvent {
        ChangedEvent {
            feed,
            key: key.map(str::to_string),
            workspace_id: None,
            channels: Vec::new(),
            seq: 42,
        }
    }

    #[test]
    fn parser_handles_events_comments_and_partial_lines() {
        let mut parser = SseParser::default();
        assert!(parser.push(b"event: hel").is_empty());
        assert_eq!(
            parser.push(b"lo\ndata: {\"protocol\":1}\n\n: keep-alive\n"),
            vec![SseOutput::Hello { protocol: Some(1) }]
        );
        assert_eq!(
            parser.push(
                b"event: changed\ndata: {\"feed\":\"artifacts\",\"key\":\"s1\",\"seq\":7}\n\n"
            ),
            vec![SseOutput::Changed(ChangedEvent {
                feed: ChangeFeed::Artifacts,
                key: Some("s1".to_string()),
                workspace_id: None,
                channels: Vec::new(),
                seq: 7,
            })]
        );
    }

    #[test]
    fn parser_reports_malformed_changed_data() {
        let mut parser = SseParser::default();
        let out = parser.push(b"event: changed\ndata: {not-json}\n\n");
        assert_eq!(out.len(), 1);
        assert!(matches!(out[0], SseOutput::Malformed { ref event, .. } if event == "changed"));
    }

    #[test]
    fn dirty_set_drains_keyed_and_keyless_events() {
        let mut dirty = DirtySet::default();
        dirty.mark_changed(&changed(ChangeFeed::Artifacts, Some("s1")), ["s1", "s2"]);
        dirty.mark_changed(&changed(ChangeFeed::Profile, None), ["s1", "s2"]);

        let drained = dirty.drain_for(["s1", "s2"]);
        assert_eq!(drained.len(), 2);
        assert!(drained["s1"].artifacts);
        assert!(drained["s1"].profile);
        assert!(!drained["s2"].artifacts);
        assert!(drained["s2"].profile);
        assert!(dirty.drain_for(["s1", "s2"]).is_empty());
    }

    #[test]
    fn dirty_set_drops_removed_sessions_on_drain() {
        let mut dirty = DirtySet::default();
        dirty.mark_changed(&changed(ChangeFeed::Atrium, Some("gone")), ["gone"]);
        assert!(dirty.drain_for(["current"]).is_empty());
        assert!(dirty.drain_for(["gone"]).is_empty());
    }

    #[test]
    fn dirty_set_carries_channel_ids_for_atrium_events() {
        let mut dirty = DirtySet::default();
        let mut event = changed(ChangeFeed::Atrium, Some("s1"));
        event.channels = vec!["chan-1".to_string(), "chan-2".to_string()];

        dirty.mark_changed(&event, ["s1"]);
        let drained = dirty.drain_for(["s1"]);

        let feeds = drained.get("s1").unwrap();
        assert!(feeds.atrium);
        assert_eq!(
            feeds.channel_ids,
            HashSet::from(["chan-1".to_string(), "chan-2".to_string()])
        );
    }
}
