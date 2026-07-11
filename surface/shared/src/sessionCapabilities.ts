export type SessionCapabilityHarness = 'claude' | 'codex';
export type SessionCapabilityCompleteness = 'complete' | 'partial' | 'observed';
export type SessionCapabilityItemStatus = 'available' | 'pending' | 'observed';

export interface SessionCapabilityItem {
  name: string;
  sources: string[];
  namespace?: string;
  description?: string;
  status?: SessionCapabilityItemStatus;
  count?: number;
}

export interface SessionCapabilityNamespace {
  name: string;
  sources: string[];
  description?: string;
  count: number;
}

export interface SessionCapabilityChange {
  seq: number;
  line: number;
  timestamp?: string;
  source: string;
  summary: string;
  added?: string[];
  removed?: string[];
  readded?: string[];
  counts?: Record<string, number>;
  redacted?: boolean;
}

export interface SessionCapabilitySnapshot {
  parserVersion: number;
  sessionId: string;
  harness: SessionCapabilityHarness;
  sourceSha256: string;
  completeness: SessionCapabilityCompleteness;
  generatedAt: string;
  runtime: Record<string, unknown>;
  counts: {
    tools: number;
    toolNamespaces: number;
    mcpServers: number;
    agents: number;
    skills: number;
    observedToolCalls: number;
    changes: number;
  };
  tools: SessionCapabilityItem[];
  toolNamespaces: SessionCapabilityNamespace[];
  mcpServers: SessionCapabilityItem[];
  agents: SessionCapabilityItem[];
  skills: SessionCapabilityItem[];
  observedToolCalls: SessionCapabilityItem[];
  pendingMcpServers: string[];
  changes: SessionCapabilityChange[];
  warnings: string[];
  redactions: string[];
}

export interface SessionCapabilitiesResponse {
  sessionId: string;
  snapshots: SessionCapabilitySnapshot[];
}
