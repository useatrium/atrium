export type AgentProfileProvider = 'codex' | 'claude-code';

export type AgentProfileRiskLabel =
  | 'safe'
  | 'needs-secret-ref'
  | 'policy-capped'
  | 'unsupported';

export interface AgentProfileExcludedItem {
  path?: string;
  key?: string;
  reason: string;
}

export interface AgentProfileSourceHash {
  path: string;
  sha256: string;
  sizeBytes?: number;
}

export interface AgentProfileBundleEntry {
  path: string;
  role: string;
  sha256: string;
  sizeBytes: number;
  executable?: boolean;
  warnings?: string[];
}

export interface AgentProfileManifest {
  provider: AgentProfileProvider;
  adapterVersion: string;
  settings?: Record<string, unknown>;
  mcpServers?: Record<string, unknown>;
  bundles?: AgentProfileBundleEntry[];
  excluded?: AgentProfileExcludedItem[];
  warnings?: string[];
}

export interface AgentProfileRiskSummary {
  labels: AgentProfileRiskLabel[];
  blockedSecrets: number;
  executableItems: number;
  unsupportedItems: number;
  warnings: string[];
}

export interface AgentProfileDiff {
  added: string[];
  changed: string[];
  removed: string[];
}

export interface AgentProfileProposalPayload {
  provider: AgentProfileProvider;
  adapterVersion: string;
  sourceHashes: AgentProfileSourceHash[];
  manifest: AgentProfileManifest;
  riskSummary: AgentProfileRiskSummary;
  baselineHash?: string | null;
  diff?: AgentProfileDiff;
}

export type AgentProfileProposalStatus =
  | 'pending'
  | 'discarded'
  | 'applied_to_lineage'
  | 'saved_profile';

export interface AgentProfileProposal {
  id: string;
  sessionId: string | null;
  provider: AgentProfileProvider;
  baseProfileVersionId: string | null;
  adapterVersion: string;
  proposal: AgentProfileProposalPayload;
  diff?: AgentProfileDiff;
  riskSummary: AgentProfileRiskSummary;
  status: AgentProfileProposalStatus;
  source: 'session' | 'local_import';
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
}

export interface AgentProfileVersion {
  id: string;
  profileId: string;
  provider: AgentProfileProvider;
  adapterVersion: string;
  manifest: AgentProfileManifest;
  runtimeOverlay: Record<string, unknown>;
  contentHash: string;
  createdAt: string;
}

export interface AgentProfile {
  id: string;
  provider: AgentProfileProvider;
  name: string;
  currentVersionId: string | null;
  currentVersion?: AgentProfileVersion | null;
  createdAt: string;
  updatedAt: string;
}
