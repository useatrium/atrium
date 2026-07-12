import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import type { SessionSuggestion } from '@atrium/surface-client';
import { font, radius, space, useTheme } from '../../lib/theme';

type RowMode = 'idle' | 'editing' | 'dismissing';
type MaybePromise = void | Promise<void>;

export type OptimisticSuggestionSend = {
  suggestion: SessionSuggestion;
  text: string;
  edited: boolean;
};

function watchOptimisticFailure(
  result: MaybePromise,
  optimisticId: string | undefined,
  onFailed?: (id: string) => void,
) {
  if (!optimisticId || !result || typeof result.then !== 'function') return;
  void result.catch(() => onFailed?.(optimisticId));
}

function ActionButton({
  label,
  onPress,
  variant = 'quiet',
  disabled = false,
}: {
  label: string;
  onPress: () => void;
  variant?: 'outline' | 'quiet';
  disabled?: boolean;
}) {
  const { colors } = useTheme();
  const outlined = variant === 'outline';

  return (
    <Pressable
      onPress={onPress}
      disabled={disabled}
      accessibilityRole="button"
      accessibilityState={disabled ? { disabled: true } : undefined}
      style={({ pressed }) => ({
        borderWidth: outlined ? 1 : 0,
        borderColor: disabled ? colors.borderSoft : colors.border,
        borderRadius: radius.sm,
        backgroundColor: pressed && !disabled ? colors.bgPressed : colors.bgElevated,
        paddingHorizontal: space.sm,
        paddingVertical: space.xs,
        opacity: disabled ? 0.55 : 1,
      })}
    >
      <Text
        style={{
          color: disabled ? colors.textFaint : outlined ? colors.text : colors.textSecondary,
          fontSize: font.xs,
          fontWeight: '700',
        }}
      >
        {label}
      </Text>
    </Pressable>
  );
}

function SuggestionInput({
  value,
  onChangeText,
  label,
  placeholder,
  multiline = false,
}: {
  value: string;
  onChangeText: (value: string) => void;
  label: string;
  placeholder?: string;
  multiline?: boolean;
}) {
  const { colors } = useTheme();

  return (
    <TextInput
      value={value}
      onChangeText={onChangeText}
      accessibilityLabel={label}
      placeholder={placeholder}
      placeholderTextColor={colors.textFaint}
      multiline={multiline}
      style={{
        minHeight: multiline ? 72 : 36,
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: radius.sm,
        backgroundColor: colors.bgInput,
        color: colors.text,
        fontSize: font.sm,
        paddingHorizontal: space.sm,
        paddingVertical: space.sm,
        textAlignVertical: multiline ? 'top' : 'center',
      }}
    />
  );
}

function SuggestionRow({
  suggestion,
  isDriver,
  onSend,
  onEditSend,
  onDismiss,
  onOptimisticSend,
  onOptimisticSendFailed,
}: {
  suggestion: SessionSuggestion;
  isDriver: boolean;
  onSend: (suggestionId: string) => MaybePromise;
  onEditSend: (suggestionId: string, text: string) => MaybePromise;
  onDismiss: (suggestionId: string, note?: string) => MaybePromise;
  onOptimisticSend?: (input: OptimisticSuggestionSend) => string | undefined;
  onOptimisticSendFailed?: (pendingId: string) => void;
}) {
  const { colors } = useTheme();
  const [mode, setMode] = useState<RowMode>('idle');
  const [draft, setDraft] = useState(suggestion.text);
  const [note, setNote] = useState('');
  const authorName = suggestion.authorName ?? suggestion.authorId;

  const startEdit = () => {
    setDraft(suggestion.text);
    setMode('editing');
  };
  const startDismiss = () => {
    setNote('');
    setMode('dismissing');
  };
  const sendEdited = () => {
    if (draft.trim().length === 0) return;
    const optimisticId = onOptimisticSend?.({
      suggestion,
      text: draft,
      edited: draft !== suggestion.text,
    });
    watchOptimisticFailure(onEditSend(suggestion.id, draft), optimisticId, onOptimisticSendFailed);
  };
  const dismiss = () => {
    const trimmed = note.trim();
    // resolveSuggestionAction reports then rethrows; dismiss has no optimistic
    // bubble to roll back, so swallow the rejection to avoid an unhandled promise.
    const result = onDismiss(suggestion.id, trimmed.length > 0 ? trimmed : undefined);
    if (result && typeof result.then === 'function') void result.catch(() => {});
  };
  const send = () => {
    const optimisticId = onOptimisticSend?.({
      suggestion,
      text: suggestion.text,
      edited: false,
    });
    watchOptimisticFailure(onSend(suggestion.id), optimisticId, onOptimisticSendFailed);
  };

  return (
    <View
      testID="suggestion-row"
      style={{
        gap: space.sm,
        paddingVertical: space.sm,
        borderTopWidth: 1,
        borderTopColor: colors.borderSoft,
      }}
    >
      <Text style={{ color: colors.text, fontSize: font.sm, lineHeight: font.lg }}>
        <Text style={{ fontWeight: '700' }}>{authorName}</Text>
        {mode === 'editing' ? null : <Text style={{ color: colors.textSecondary }}> {suggestion.text}</Text>}
      </Text>

      {mode === 'editing' ? (
        <View style={{ gap: space.sm }}>
          <SuggestionInput value={draft} onChangeText={setDraft} label="Edit suggestion" multiline />
          <View style={{ flexDirection: 'row', gap: space.sm }}>
            <ActionButton
              label="Send edited"
              onPress={sendEdited}
              variant="outline"
              disabled={draft.trim().length === 0}
            />
            <ActionButton label="Cancel" onPress={() => setMode('idle')} />
          </View>
        </View>
      ) : mode === 'dismissing' ? (
        <View style={{ gap: space.sm }}>
          <SuggestionInput value={note} onChangeText={setNote} label="Dismiss reason" placeholder="why? (optional)" />
          <View style={{ flexDirection: 'row', gap: space.sm }}>
            <ActionButton label="Dismiss" onPress={dismiss} variant="outline" />
            <ActionButton label="Cancel" onPress={() => setMode('idle')} />
          </View>
        </View>
      ) : isDriver ? (
        <View style={{ flexDirection: 'row', gap: space.sm }}>
          <ActionButton label="Send" onPress={send} variant="outline" />
          <ActionButton label="Edit" onPress={startEdit} />
          <ActionButton label="Dismiss" onPress={startDismiss} />
        </View>
      ) : null}
    </View>
  );
}

export function SuggestionsStrip({
  suggestions,
  isDriver,
  onSend,
  onEditSend,
  onDismiss,
  onOptimisticSend,
  onOptimisticSendFailed,
}: {
  suggestions: SessionSuggestion[];
  isDriver: boolean;
  onSend: (suggestionId: string) => MaybePromise;
  onEditSend: (suggestionId: string, text: string) => MaybePromise;
  onDismiss: (suggestionId: string, note?: string) => MaybePromise;
  onOptimisticSend?: (input: OptimisticSuggestionSend) => string | undefined;
  onOptimisticSendFailed?: (pendingId: string) => void;
}) {
  const { colors } = useTheme();
  const pendingSuggestions = suggestions.filter((suggestion) => suggestion.status === 'pending');

  if (pendingSuggestions.length === 0) return null;

  return (
    <View
      testID="suggestion-strip"
      style={{
        borderTopWidth: 1,
        borderTopColor: colors.border,
        backgroundColor: colors.bgElevated,
        paddingHorizontal: space.md,
        paddingTop: space.sm,
        paddingBottom: space.xs,
      }}
    >
      <Text
        style={{
          color: colors.textMuted,
          fontSize: font.xs,
          fontWeight: '800',
          marginBottom: space.xs,
        }}
      >
        Suggestions · {pendingSuggestions.length}
      </Text>
      {pendingSuggestions.map((suggestion) => (
        <SuggestionRow
          key={suggestion.id}
          suggestion={suggestion}
          isDriver={isDriver}
          onSend={onSend}
          onEditSend={onEditSend}
          onDismiss={onDismiss}
          onOptimisticSend={onOptimisticSend}
          onOptimisticSendFailed={onOptimisticSendFailed}
        />
      ))}
    </View>
  );
}
