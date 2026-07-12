import { Schema } from 'effect';

export const AgentProfileProviderSchema = Schema.Literal('codex', 'claude-code');
export type AgentProfileProvider = Schema.Schema.Type<typeof AgentProfileProviderSchema>;

export const CreateAgentProfileBodySchema = Schema.Struct({
  provider: Schema.optional(Schema.Unknown),
  name: Schema.optional(Schema.Unknown),
});
export type CreateAgentProfileBody = {
  provider: AgentProfileProvider;
  name: string;
};

export const AgentProfileProposalEnvelopeBodySchema = Schema.Record({
  key: Schema.String,
  value: Schema.Unknown,
});
export type AgentProfileProposalEnvelopeBody = Schema.Schema.Type<typeof AgentProfileProposalEnvelopeBodySchema>;

export const CreateAgentProfileVersionBodySchema = AgentProfileProposalEnvelopeBodySchema;
export type CreateAgentProfileVersionBody = AgentProfileProposalPayload;

export const ImportLocalAgentProfileBodySchema = AgentProfileProposalEnvelopeBodySchema;
export type ImportLocalAgentProfileBody = {
  provider: AgentProfileProvider;
  proposal: AgentProfileProposalPayload;
};

export const SaveAgentProfileProposalToCurrentBodySchema = Schema.Struct({
  profileId: Schema.optional(Schema.Unknown),
  name: Schema.optional(Schema.Unknown),
});
export type SaveAgentProfileProposalToCurrentBody = {
  profileId?: string;
  name?: string;
};

export const SaveAgentProfileProposalAsNewBodySchema = Schema.Struct({
  name: Schema.optional(Schema.Unknown),
});
export type SaveAgentProfileProposalAsNewBody = {
  name: string;
};

export type AgentProfileRiskLabel = 'safe' | 'needs-secret-ref' | 'policy-capped' | 'unsupported';

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

export type AgentProfileProposalStatus = 'pending' | 'discarded' | 'applied_to_lineage' | 'saved_profile';

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
