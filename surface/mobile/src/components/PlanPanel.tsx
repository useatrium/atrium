import { memo, useMemo, useState } from 'react';
import { Pressable, Text, View } from 'react-native';
import type { SessionState, TodoEntry } from '@atrium/centaur-client';
import { font, radius, space, useTheme } from '../lib/theme';
import { SessionMarkdown } from './Markdown';

type PlanState = NonNullable<SessionState['plan']>;

export const PlanPanel = memo(function PlanPanel({ todos, plan }: { todos?: TodoEntry[]; plan?: PlanState | null }) {
  const { colors } = useTheme();
  const [open, setOpen] = useState(false);
  const hasTodos = (todos?.length ?? 0) > 0;
  const hasPlan = plan != null;

  const summary = useMemo(() => {
    if (!hasTodos) return 'Plan';
    const total = todos?.length ?? 0;
    const completed = todos?.filter((todo) => todo.status === 'completed').length ?? 0;
    return `Plan · ${completed}/${total} done`;
  }, [hasTodos, todos]);

  if (!hasTodos && !hasPlan) return null;

  return (
    <View
      testID="plan-panel"
      style={{
        borderWidth: 1,
        borderColor: colors.border,
        backgroundColor: colors.bgElevated,
        borderRadius: radius.sm,
        overflow: 'hidden',
      }}
    >
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={summary}
        accessibilityState={{ expanded: open }}
        onPress={() => setOpen((value) => !value)}
        style={({ pressed }) => ({
          flexDirection: 'row',
          alignItems: 'center',
          gap: space.sm,
          paddingHorizontal: space.md,
          paddingVertical: space.sm,
          backgroundColor: pressed ? colors.bgPressed : 'transparent',
        })}
      >
        <Text style={{ color: colors.textMuted, fontSize: font.xs, width: 12 }}>{open ? '▾' : '▸'}</Text>
        <Text
          numberOfLines={1}
          style={{ flex: 1, minWidth: 0, color: colors.textSecondary, fontSize: font.xs, fontWeight: '800' }}
        >
          {summary}
        </Text>
      </Pressable>
      {open ? (
        <View
          style={{
            borderTopWidth: 1,
            borderTopColor: colors.borderSoft,
            padding: space.md,
            gap: space.sm,
          }}
        >
          {hasTodos ? (
            <View style={{ gap: space.sm }}>
              {todos!.map((todo, index) => (
                <TodoRow key={`${index}:${todo.content}`} todo={todo} />
              ))}
            </View>
          ) : null}
          {plan?.text ? (
            <View
              style={{
                borderTopWidth: hasTodos ? 1 : 0,
                borderTopColor: colors.borderSoft,
                paddingTop: hasTodos ? space.sm : 0,
              }}
            >
              <SessionMarkdown text={plan.text} />
            </View>
          ) : null}
        </View>
      ) : null}
    </View>
  );
});

function TodoRow({ todo }: { todo: TodoEntry }) {
  const { colors } = useTheme();
  const label = todo.status === 'in_progress' && todo.activeForm ? todo.activeForm : todo.content;
  const completed = todo.status === 'completed';
  const active = todo.status === 'in_progress';

  return (
    <View style={{ flexDirection: 'row', alignItems: 'flex-start', gap: space.sm }}>
      <TodoStatusIcon status={todo.status} />
      <Text
        style={{
          flex: 1,
          minWidth: 0,
          color: completed ? colors.textMuted : active ? colors.accent : colors.text,
          fontSize: font.sm,
          lineHeight: 19,
          fontWeight: active ? '700' : '400',
          textDecorationLine: completed ? 'line-through' : 'none',
        }}
      >
        {label}
      </Text>
    </View>
  );
}

function TodoStatusIcon({ status }: { status: TodoEntry['status'] }) {
  const { colors } = useTheme();
  if (status === 'completed') {
    return (
      <View
        aria-hidden
        style={{
          marginTop: space.xxs,
          width: 15,
          height: 15,
          borderRadius: 8,
          alignItems: 'center',
          justifyContent: 'center',
          backgroundColor: colors.online,
        }}
      >
        <Text style={{ color: colors.bg, fontSize: 10, fontWeight: '900', lineHeight: 12 }}>✓</Text>
      </View>
    );
  }
  return (
    <View
      aria-hidden
      style={{
        marginTop: space.xs,
        width: 12,
        height: 12,
        borderRadius: radius.sm,
        borderWidth: 1,
        borderColor: status === 'in_progress' ? colors.accent : colors.textFaint,
        backgroundColor: status === 'in_progress' ? colors.accent : 'transparent',
      }}
    />
  );
}
