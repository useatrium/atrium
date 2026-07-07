import { useEffect, useMemo, useRef, useState } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  Text,
  TextInput,
  View,
} from 'react-native';
import { Ionicons } from '@expo/vector-icons';
import type { AgentProfile } from '@atrium/surface-client';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useModalAccessibilityFocus } from '../lib/accessibility';
import { font, radius, space, useTheme } from '../lib/theme';

const HARNESSES = [
  { value: 'codex', label: 'Codex', hint: 'Best for code changes.' },
  { value: 'claude-code', label: 'Claude Code', hint: 'Alternate coding provider.' },
  { value: 'demo', label: 'Demo', hint: 'Watch an agent work, no setup.' },
] as const;

export type SpawnSheetHarness = (typeof HARNESSES)[number]['value'];

export interface SpawnSheetConfig {
  task: string;
  harness: SpawnSheetHarness;
  repo?: string;
  agentProfileId?: string;
  agentProfileVersionId?: string;
}

export function SpawnSheet({
  visible,
  channelId,
  channelName,
  initialTask,
  loadProfiles,
  onClose,
  onSpawn,
}: {
  visible: boolean;
  channelId: string;
  channelName: string;
  initialTask?: string;
  loadProfiles?: () => Promise<AgentProfile[]>;
  onClose: () => void;
  onSpawn: (config: SpawnSheetConfig) => void;
}) {
  const { colors, reduceMotion } = useTheme();
  const insets = useSafeAreaInsets();
  const taskInputRef = useRef<TextInput>(null);
  const [task, setTask] = useState('');
  const [repo, setRepo] = useState('');
  const [harness, setHarness] = useState<SpawnSheetHarness>('codex');
  const [profiles, setProfiles] = useState<AgentProfile[]>([]);
  const [agentProfileId, setAgentProfileId] = useState('');
  const wasVisibleRef = useRef(false);
  const trimmedTask = task.trim();
  const trimmedRepo = repo.trim();
  const canSpawn = trimmedTask.length > 0;
  const channelLabel = channelName.trim() || channelId;
  const matchingProfiles = useMemo(
    () => profiles.filter((profile) => profile.provider === harness && profile.currentVersionId),
    [harness, profiles],
  );
  const selectedProfile = matchingProfiles.find((profile) => profile.id === agentProfileId);
  const selectedProfileVersionId = selectedProfile?.currentVersionId ?? '';

  useModalAccessibilityFocus(taskInputRef, visible);

  useEffect(() => {
    if (visible && !wasVisibleRef.current) {
      setTask(initialTask ?? '');
      setAgentProfileId('');
    }
    wasVisibleRef.current = visible;
  }, [initialTask, visible]);

  useEffect(() => {
    if (!visible || !loadProfiles) return;
    let disposed = false;
    loadProfiles()
      .then((loadedProfiles) => {
        if (!disposed) setProfiles(loadedProfiles);
      })
      .catch((err: unknown) => {
        console.warn('failed to load agent profiles', err);
        if (!disposed) setProfiles([]);
      });
    return () => {
      disposed = true;
    };
  }, [loadProfiles, visible]);

  useEffect(() => {
    setAgentProfileId('');
  }, [harness]);

  useEffect(() => {
    if (agentProfileId && !selectedProfile) setAgentProfileId('');
  }, [agentProfileId, selectedProfile]);

  const submit = () => {
    if (!canSpawn) return;
    onSpawn({
      task: trimmedTask,
      harness,
      ...(trimmedRepo ? { repo: trimmedRepo } : {}),
      ...(selectedProfile && selectedProfileVersionId
        ? {
            agentProfileId: selectedProfile.id,
            agentProfileVersionId: selectedProfileVersionId,
          }
        : {}),
    });
    setTask('');
    setRepo('');
    setHarness('codex');
    setAgentProfileId('');
  };

  return (
    <Modal
      visible={visible}
      transparent
      animationType={reduceMotion ? 'none' : 'slide'}
      onRequestClose={onClose}
    >
      <KeyboardAvoidingView
        behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        style={{ flex: 1 }}
      >
        <View style={{ flex: 1, backgroundColor: colors.scrim, justifyContent: 'flex-end' }}>
          <Pressable
            accessible={false}
            importantForAccessibility="no"
            onPress={onClose}
            style={{ position: 'absolute', top: 0, right: 0, bottom: 0, left: 0 }}
          />
          <View
            testID="spawn-sheet"
            accessibilityLabel={`New agent for ${channelLabel}`}
            accessibilityViewIsModal
            style={{
              backgroundColor: colors.bgElevated,
              borderColor: colors.border,
              borderTopLeftRadius: radius.lg,
              borderTopRightRadius: radius.lg,
              borderWidth: 1,
              maxHeight: '88%',
              overflow: 'hidden',
            }}
          >
            <View
              style={{
                alignItems: 'center',
                borderBottomColor: colors.border,
                borderBottomWidth: 1,
                flexDirection: 'row',
                minHeight: 56,
                paddingHorizontal: space.lg,
              }}
            >
              <View style={{ flex: 1, paddingVertical: space.sm }}>
                <Text
                  accessibilityRole="header"
                  maxFontSizeMultiplier={2}
                  style={{ color: colors.text, fontSize: font.md, fontWeight: '800' }}
                >
                  New agent
                </Text>
                <Text
                  maxFontSizeMultiplier={2}
                  numberOfLines={1}
                  style={{ color: colors.textMuted, fontSize: font.xs, marginTop: 2 }}
                >
                  {channelLabel}
                </Text>
              </View>
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Close new agent sheet"
                onPress={onClose}
                hitSlop={8}
                style={({ pressed }) => ({
                  alignItems: 'center',
                  backgroundColor: pressed ? colors.bgPressed : 'transparent',
                  borderRadius: radius.sm,
                  height: 44,
                  justifyContent: 'center',
                  width: 44,
                })}
              >
                <Ionicons name="close" size={22} color={colors.textSecondary} />
              </Pressable>
            </View>

            <ScrollView
              keyboardShouldPersistTaps="handled"
              contentContainerStyle={{
                gap: space.lg,
                paddingHorizontal: space.lg,
                paddingTop: space.lg,
                paddingBottom: space.md,
              }}
            >
              <View style={{ gap: space.sm }}>
                <Text style={{ color: colors.textMuted, fontSize: font.xs, fontWeight: '800' }}>
                  Task
                </Text>
                <TextInput
                  ref={taskInputRef}
                  autoFocus
                  accessibilityLabel="Agent task"
                  accessibilityHint="Describe what the agent should do."
                  multiline
                  value={task}
                  onChangeText={setTask}
                  placeholder="What should the agent do?"
                  placeholderTextColor={colors.textFaint}
                  returnKeyType="default"
                  textAlignVertical="top"
                  style={{
                    backgroundColor: colors.bgInput,
                    borderColor: colors.border,
                    borderRadius: radius.md,
                    borderWidth: 1,
                    color: colors.text,
                    fontSize: font.md,
                    minHeight: 112,
                    paddingHorizontal: space.md,
                    paddingVertical: space.md,
                  }}
                />
              </View>

              <View style={{ gap: space.sm }}>
                <Text style={{ color: colors.textMuted, fontSize: font.xs, fontWeight: '800' }}>
                  Harness
                </Text>
                <View style={{ gap: space.sm }}>
                  {HARNESSES.map((item) => {
                    const selected = harness === item.value;
                    return (
                      <Pressable
                        key={item.value}
                        accessibilityRole="button"
                        accessibilityLabel={item.label}
                        accessibilityHint={item.hint}
                        accessibilityState={{ selected }}
                        onPress={() => setHarness(item.value)}
                        style={({ pressed }) => ({
                          borderColor: selected ? colors.accent : colors.border,
                          borderRadius: radius.md,
                          borderWidth: 1,
                          backgroundColor: pressed
                            ? colors.bgPressed
                            : selected
                              ? colors.accentBg
                              : colors.bgInput,
                          minHeight: 58,
                          paddingHorizontal: space.md,
                          paddingVertical: space.sm,
                        })}
                      >
                        <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
                          <Ionicons
                            name={selected ? 'radio-button-on' : 'radio-button-off'}
                            size={18}
                            color={selected ? colors.accent : colors.textMuted}
                          />
                          <View style={{ flex: 1 }}>
                            <Text
                              maxFontSizeMultiplier={2}
                              style={{ color: colors.text, fontSize: font.sm, fontWeight: '800' }}
                            >
                              {item.label}
                            </Text>
                            <Text
                              maxFontSizeMultiplier={2}
                              style={{ color: colors.textMuted, fontSize: font.xs, marginTop: 2 }}
                            >
                              {item.hint}
                            </Text>
                          </View>
                        </View>
                      </Pressable>
                    );
                  })}
                </View>
              </View>

              {matchingProfiles.length > 0 ? (
                <View style={{ gap: space.sm }}>
                  <Text style={{ color: colors.textMuted, fontSize: font.xs, fontWeight: '800' }}>
                    Profile
                  </Text>
                  <View style={{ gap: space.sm }}>
                    <Pressable
                      accessibilityRole="button"
                      accessibilityLabel="Default profile"
                      accessibilityHint="Use the default profile for this harness."
                      accessibilityState={{ selected: agentProfileId === '' }}
                      onPress={() => setAgentProfileId('')}
                      style={({ pressed }) => ({
                        borderColor: agentProfileId === '' ? colors.accent : colors.border,
                        borderRadius: radius.md,
                        borderWidth: 1,
                        backgroundColor: pressed
                          ? colors.bgPressed
                          : agentProfileId === ''
                            ? colors.accentBg
                            : colors.bgInput,
                        minHeight: 58,
                        paddingHorizontal: space.md,
                        paddingVertical: space.sm,
                      })}
                    >
                      <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
                        <Ionicons
                          name={agentProfileId === '' ? 'radio-button-on' : 'radio-button-off'}
                          size={18}
                          color={agentProfileId === '' ? colors.accent : colors.textMuted}
                        />
                        <View style={{ flex: 1 }}>
                          <Text
                            maxFontSizeMultiplier={2}
                            style={{ color: colors.text, fontSize: font.sm, fontWeight: '800' }}
                          >
                            Default
                          </Text>
                          <Text
                            maxFontSizeMultiplier={2}
                            style={{ color: colors.textMuted, fontSize: font.xs, marginTop: 2 }}
                          >
                            Use the harness default.
                          </Text>
                        </View>
                      </View>
                    </Pressable>

                    {matchingProfiles.map((profile) => {
                      const selected = agentProfileId === profile.id;
                      return (
                        <Pressable
                          key={profile.id}
                          accessibilityRole="button"
                          accessibilityLabel={`Profile ${profile.name}`}
                          accessibilityHint="Use this saved agent profile for the session."
                          accessibilityState={{ selected }}
                          onPress={() => setAgentProfileId(profile.id)}
                          style={({ pressed }) => ({
                            borderColor: selected ? colors.accent : colors.border,
                            borderRadius: radius.md,
                            borderWidth: 1,
                            backgroundColor: pressed
                              ? colors.bgPressed
                              : selected
                                ? colors.accentBg
                                : colors.bgInput,
                            minHeight: 58,
                            paddingHorizontal: space.md,
                            paddingVertical: space.sm,
                          })}
                        >
                          <View style={{ flexDirection: 'row', alignItems: 'center', gap: space.sm }}>
                            <Ionicons
                              name={selected ? 'radio-button-on' : 'radio-button-off'}
                              size={18}
                              color={selected ? colors.accent : colors.textMuted}
                            />
                            <View style={{ flex: 1 }}>
                              <Text
                                maxFontSizeMultiplier={2}
                                style={{ color: colors.text, fontSize: font.sm, fontWeight: '800' }}
                              >
                                {profile.name}
                              </Text>
                              <Text
                                maxFontSizeMultiplier={2}
                                style={{ color: colors.textMuted, fontSize: font.xs, marginTop: 2 }}
                              >
                                Saved {itemLabelForHarness(harness)} profile.
                              </Text>
                            </View>
                          </View>
                        </Pressable>
                      );
                    })}
                  </View>
                </View>
              ) : null}

              <View style={{ gap: space.sm }}>
                <Text style={{ color: colors.textMuted, fontSize: font.xs, fontWeight: '800' }}>
                  Repo optional
                </Text>
                <TextInput
                  accessibilityLabel="Repository"
                  accessibilityHint="Optionally enter a repository for the agent session."
                  autoCapitalize="none"
                  autoCorrect={false}
                  value={repo}
                  onChangeText={setRepo}
                  placeholder="owner/repo"
                  placeholderTextColor={colors.textFaint}
                  style={{
                    backgroundColor: colors.bgInput,
                    borderColor: colors.border,
                    borderRadius: radius.md,
                    borderWidth: 1,
                    color: colors.text,
                    fontSize: font.md,
                    minHeight: 48,
                    paddingHorizontal: space.md,
                    paddingVertical: space.sm,
                  }}
                />
              </View>
            </ScrollView>

            <View
              style={{
                borderTopColor: colors.border,
                borderTopWidth: 1,
                paddingBottom: insets.bottom + space.md,
                paddingHorizontal: space.lg,
                paddingTop: space.md,
              }}
            >
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Start agent"
                accessibilityState={{ disabled: !canSpawn }}
                disabled={!canSpawn}
                onPress={submit}
                style={({ pressed }) => ({
                  alignItems: 'center',
                  backgroundColor: canSpawn ? colors.accent : colors.bgPressed,
                  borderRadius: radius.md,
                  minHeight: 48,
                  justifyContent: 'center',
                  opacity: !canSpawn ? 0.55 : pressed ? 0.85 : 1,
                  paddingHorizontal: space.lg,
                })}
              >
                <Text
                  maxFontSizeMultiplier={2}
                  style={{
                    color: canSpawn ? colors.onAccent : colors.textMuted,
                    fontSize: font.md,
                    fontWeight: '800',
                  }}
                >
                  Start agent
                </Text>
              </Pressable>
            </View>
          </View>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  );
}

function itemLabelForHarness(harness: SpawnSheetHarness): string {
  return HARNESSES.find((item) => item.value === harness)?.label ?? harness;
}
