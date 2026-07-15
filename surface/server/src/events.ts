export { DomainError } from './events/wire.js';
export type {
  AnnotationFold,
  AnnotationReaction,
  AttachmentMeta,
  Channel,
  UserRef,
  VoicePostMeta,
  WireEvent,
  Workspace,
} from './events/wire.js';

export {
  addChannelMember,
  addChannelMemberTx,
  appendEvent,
  appendVoiceTranscribedEventTx,
  createChannel,
  createWorkspace,
  deleteMessage,
  deleteMessageTx,
  editMessage,
  editMessageTx,
  ensureDefaultWorkspace,
  extractEntryRefs,
  getOrCreateDm,
  getOrCreateGdm,
  leaveChannel,
  leaveChannelTx,
  postMessage,
  REACTION_EMOJI,
  setEntryReactionTx,
  setReaction,
  setReactionTx,
  suppressUnfurls,
  suppressUnfurlsTx,
} from './events/write.js';
export type { PostedMessage, ReactionAction, ReactionResult } from './events/write.js';

export {
  canAccessChannel,
  canAccessFile,
  foldAnnotations,
  listChannelMembers,
  listChannelMessages,
  listChannels,
  listChannelsFor,
  listThreadMessages,
  listUsers,
  listVisibleSyncEvents,
  listWorkspaces,
  searchMessages,
} from './events/read.js';
export type { MessagePage, SearchHit, SyncEventsPage } from './events/read.js';
