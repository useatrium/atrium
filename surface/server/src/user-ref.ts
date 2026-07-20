export interface UserRefRow {
  id: string;
  handle: string;
  display_name: string;
  avatar_s3_key?: string | null;
  avatar_version?: number | null;
}

export interface UserRefJson {
  id: string;
  handle: string;
  displayName: string;
  avatarUrl?: string | null;
  avatarVersion?: number;
}

export function userRefFromRow(row: UserRefRow): UserRefJson {
  const avatarVersion = Number(row.avatar_version ?? 0);
  return {
    id: row.id,
    handle: row.handle,
    displayName: row.display_name,
    ...(row.avatar_s3_key
      ? {
          avatarUrl: `/api/users/${row.id}/avatar?v=${avatarVersion}`,
          avatarVersion,
        }
      : {}),
  };
}
