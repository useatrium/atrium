import { useCallback, useEffect, useRef, useState } from 'react';
import type { EnqueueOpInput, UserRef } from '@atrium/surface-client';
import type { Channel } from '../api';
import { api } from '../api';
import { randomId } from '@atrium/surface-client';
import { useDialog } from '../useDialog';
import { Avatar } from './Avatar';
import { showErrorToast } from './Toasts';

type MemberOp = EnqueueOpInput<'channel.join'> | EnqueueOpInput<'channel.leave'>;

export function ChannelMembersMenu({
  channel,
  meId,
  enqueueOp,
}: {
  channel: Channel;
  meId: string;
  enqueueOp: (input: MemberOp) => Promise<unknown>;
}) {
  const [open, setOpen] = useState(false);
  const [members, setMembers] = useState<UserRef[] | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [people, setPeople] = useState<UserRef[] | null>(null);
  const buttonRef = useRef<HTMLButtonElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const addButtonRef = useRef<HTMLButtonElement | null>(null);
  const [leaveAsk, setLeaveAsk] = useState(false);

  const loadMembers = useCallback(() => {
    api
      .channelMembers(channel.id)
      .then(({ members }) => setMembers(members))
      .catch(() => setMembers([]));
  }, [channel.id]);

  useEffect(() => {
    setMembers(null);
    setOpen(false);
    setPickerOpen(false);
    setLeaveAsk(false);
  }, [channel.id]);

  const close = useCallback(() => {
    setOpen(false);
    setPickerOpen(false);
    setLeaveAsk(false);
  }, []);

  useDialog({
    open,
    containerRef: popoverRef,
    initialFocusRef: addButtonRef,
    invokerRef: buttonRef,
    closeOnOutsidePointer: true,
    onClose: close,
  });

  useEffect(() => {
    if (!leaveAsk) return;
    const t = setTimeout(() => setLeaveAsk(false), 5000);
    return () => clearTimeout(t);
  }, [leaveAsk]);

  const loadPeople = () => {
    if (people) return;
    api
      .users()
      .then(({ users }) => setPeople(users))
      .catch(() => setPeople([]));
  };

  const inviteMember = (userId: string) => {
    void enqueueOp({
      opId: randomId(),
      opType: 'channel.join',
      payload: { channelId: channel.id, userId },
    })
      .then((op) => {
        if (!op) return;
        loadMembers();
        setPickerOpen(false);
      })
      .catch(() => showErrorToast("Couldn't queue the invite."));
  };

  const leaveChannel = () => {
    if (!leaveAsk) {
      setLeaveAsk(true);
      return;
    }
    setLeaveAsk(false);
    void enqueueOp({
      opId: randomId(),
      opType: 'channel.leave',
      payload: { channelId: channel.id, userId: meId },
    }).catch(() => showErrorToast("Couldn't queue the channel leave."));
  };

  return (
    <div className="relative">
      <button
        type="button"
        ref={buttonRef}
        onClick={() => {
          setOpen((v) => !v);
          if (!members) loadMembers();
        }}
        aria-expanded={open}
        aria-haspopup="dialog"
        aria-controls="members-popover"
        className="rounded-md px-2 py-1 text-xs text-fg-tertiary hover:bg-surface-overlay hover:text-fg"
      >
        Members
      </button>
      {open && (
        <div
          ref={popoverRef}
          id="members-popover"
          role="dialog"
          aria-label="Channel members"
          className="absolute left-0 top-8 z-20 w-64 rounded-md border border-edge-strong bg-surface-raised p-2 shadow-xl"
        >
          <div className="mb-2 flex items-center justify-between">
            <h2 className="text-xs font-semibold text-fg-secondary">Members</h2>
            <button
              type="button"
              ref={addButtonRef}
              onClick={() => {
                setPickerOpen((v) => !v);
                loadPeople();
              }}
              className="rounded px-2 py-0.5 text-xs text-fg-tertiary hover:bg-surface-overlay"
            >
              Add
            </button>
          </div>
          {pickerOpen && (
            <div className="mb-2 max-h-32 overflow-y-auto border-b border-edge pb-2">
              {(people ?? [])
                .filter((u) => !members?.some((m) => m.id === u.id))
                .map((u) => (
                  <button
                    type="button"
                    key={u.id}
                    onClick={() => inviteMember(u.id)}
                    className="flex w-full items-center gap-2 rounded px-2 py-1 text-left text-xs text-fg-secondary hover:bg-surface-overlay"
                  >
                    <Avatar name={u.displayName} seed={u.id} size={16} />
                    <span className="truncate">{u.displayName}</span>
                  </button>
                ))}
            </div>
          )}
          <ul className="max-h-48 overflow-y-auto">
            {(members ?? channel.members ?? []).map((u) => (
              <li key={u.id} className="flex items-center gap-2 px-2 py-1 text-xs text-fg-secondary">
                <Avatar name={u.displayName} seed={u.id} size={16} />
                <span className="truncate">{u.displayName}</span>
              </li>
            ))}
          </ul>
          <button
            type="button"
            onClick={leaveChannel}
            aria-label={leaveAsk ? 'Confirm leave channel' : 'Leave channel'}
            className={`mt-2 w-full rounded border px-2 py-1 text-xs ${
              leaveAsk
                ? 'border-danger-border-strong bg-danger-tint/60 font-medium text-danger-text-strong hover:bg-danger-surface/60'
                : 'border-danger-border/60 text-danger-text hover:bg-danger-tint/40'
            }`}
          >
            {leaveAsk ? 'Confirm leave' : 'Leave'}
          </button>
        </div>
      )}
    </div>
  );
}
