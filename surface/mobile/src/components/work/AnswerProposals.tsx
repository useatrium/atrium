import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import type { QuestionPrompt, SessionAnswerProposal } from '@atrium/surface-client';
import { font, radius, space, useTheme } from '../../lib/theme';

export function AnswerProposals({
  proposals,
  prompts,
  onSubmit,
  onDismiss,
}: {
  proposals: SessionAnswerProposal[];
  prompts: QuestionPrompt[];
  onSubmit: (proposalId: string) => void;
  onDismiss: (proposalId: string, note?: string) => void;
}) {
  const { colors } = useTheme();

  if (proposals.length === 0) return null;

  return (
    <View
      testID="answer-proposals"
      style={{
        borderTopWidth: 1,
        borderTopColor: colors.warningBorder,
        paddingTop: space.sm,
        gap: space.sm,
      }}
    >
      <Text
        style={{
          color: colors.textMuted,
          fontSize: font.xs,
          fontWeight: '900',
          letterSpacing: 0.6,
          textTransform: 'uppercase',
        }}
      >
        Proposed answers · {proposals.length}
      </Text>
      <View style={{ gap: space.sm }}>
        {proposals.map((proposal) => (
          <AnswerProposalRow
            key={proposal.id}
            proposal={proposal}
            prompts={prompts}
            onSubmit={onSubmit}
            onDismiss={onDismiss}
          />
        ))}
      </View>
    </View>
  );
}

function AnswerProposalRow({
  proposal,
  prompts,
  onSubmit,
  onDismiss,
}: {
  proposal: SessionAnswerProposal;
  prompts: QuestionPrompt[];
  onSubmit: (proposalId: string) => void;
  onDismiss: (proposalId: string, note?: string) => void;
}) {
  const { colors } = useTheme();
  const [dismissNote, setDismissNote] = useState('');
  const author = displayAuthor(proposal);
  const submitLabel = `Submit proposal from ${author}`;
  const dismissLabel = `Dismiss proposal from ${author}`;

  const dismiss = () => {
    const note = dismissNote.trim();
    if (note.length > 0) {
      onDismiss(proposal.id, note);
      return;
    }
    onDismiss(proposal.id);
  };

  return (
    <View
      testID="answer-proposal-row"
      style={{
        borderWidth: 1,
        borderColor: colors.borderSoft,
        backgroundColor: colors.bgElevated,
        borderRadius: radius.md,
        padding: space.sm,
        gap: space.sm,
      }}
    >
      <Text style={{ color: colors.textMuted, fontSize: font.xs, lineHeight: 16 }}>
        <Text style={{ color: colors.text, fontWeight: '800' }}>{author}</Text> proposes
      </Text>

      <View style={{ gap: 6 }}>
        {prompts.map((prompt) => (
          <View key={prompt.id} style={{ gap: 2 }}>
            <Text style={{ color: colors.textMuted, fontSize: font.xs, fontWeight: '800' }}>
              {prompt.header}
            </Text>
            <Text style={{ color: colors.text, fontSize: font.sm, lineHeight: 19 }}>
              {formatAnswers(proposal.answers[prompt.id]?.answers)}
            </Text>
          </View>
        ))}
      </View>

      <TextInput
        accessibilityLabel={`Dismiss note for ${author}`}
        value={dismissNote}
        onChangeText={setDismissNote}
        placeholder="Dismiss note (optional)"
        placeholderTextColor={colors.textFaint}
        style={{
          borderRadius: radius.sm,
          backgroundColor: colors.bgInput,
          color: colors.text,
          paddingHorizontal: space.sm,
          paddingVertical: space.xs,
          fontSize: font.sm,
        }}
      />

      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
        <ProposalButton label="Submit" accessibilityLabel={submitLabel} onPress={() => onSubmit(proposal.id)} />
        <ProposalButton label="Dismiss" accessibilityLabel={dismissLabel} muted onPress={dismiss} />
      </View>
    </View>
  );
}

function ProposalButton({
  label,
  accessibilityLabel,
  muted = false,
  onPress,
}: {
  label: string;
  accessibilityLabel: string;
  muted?: boolean;
  onPress: () => void;
}) {
  const { colors } = useTheme();
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel}
      onPress={onPress}
      style={({ pressed }) => ({
        borderWidth: 1,
        borderColor: colors.border,
        borderRadius: radius.sm,
        backgroundColor: pressed ? colors.bgPressed : colors.bgElevated,
        paddingHorizontal: space.md,
        paddingVertical: space.sm,
      })}
    >
      <Text style={{ color: muted ? colors.textMuted : colors.text, fontSize: font.sm, fontWeight: '800' }}>
        {label}
      </Text>
    </Pressable>
  );
}

function displayAuthor(proposal: SessionAnswerProposal): string {
  const authorName = proposal.authorName?.trim();
  return authorName && authorName.length > 0 ? authorName : proposal.authorId;
}

function formatAnswers(answers: string[] | undefined): string {
  const values = (answers ?? []).map((answer) => answer.trim()).filter((answer) => answer.length > 0);
  return values.length > 0 ? values.join(', ') : 'No answer';
}
