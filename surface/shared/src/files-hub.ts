export type FileOrigin = 'upload' | 'agent' | 'workspace';

export interface HubFileUploader {
  id: string;
  name?: string;
}

export interface HubFile {
  artifactId: string;
  workspaceId: string;
  path: string;
  name: string;
  mime: string | null;
  mediaKind: string | null;
  isText: boolean | null;
  sizeBytes: number | null;
  width?: number;
  height?: number;
  origin: FileOrigin;
  uploader?: HubFileUploader;
  channelId?: string | null;
  sessionId?: string | null;
  sourceMessageId?: string | null;
  createdAt: string;
  updatedAt: string;
  versionSeq: number;
  labels: string[];
  starred: boolean;
  tombstoned: boolean;
}

export interface HubFileListQuery {
  origin?: FileOrigin[];
  mediaKind?: string[];
  channelId?: string;
  sessionId?: string;
  label?: string;
  starred?: boolean;
  q?: string;
  includeDeleted?: boolean;
  includeScratch?: boolean;
  sort?: 'recent' | 'name' | 'size';
  cursor?: string;
  limit?: number;
}

export interface HubFileListResult {
  files: HubFile[];
  nextCursor?: string | null;
}

export interface HubFileLabelRequest {
  label: string;
}

export interface HubFileLabelResponse {
  artifactId: string;
  labels: string[];
}

export interface HubFileStarResponse {
  artifactId: string;
  starred: boolean;
}

export interface HubFileRenameRequest {
  name: string;
}

export interface HubFileRenameResponse {
  artifactId: string;
  path: string;
  name: string;
}

export interface HubFileDeleteResponse {
  artifactId: string;
  tombstoned: true;
}

export interface HubFileRestoreResponse {
  artifactId: string;
  tombstoned: false;
}
