// @vitest-environment jsdom

import '@testing-library/jest-dom/vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { Text, View } from 'react-native';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { TranscriptActiveEntryFrame } from '../src/components/work/TranscriptEntryActions';
import { renderWithTheme } from './rnTestUtils';

vi.mock('@expo/vector-icons', () => ({
  Ionicons: ({ name }: { name: string }) => <Text>{name}</Text>,
  MaterialCommunityIcons: ({ name }: { name: string }) => <Text>{name}</Text>,
}));

afterEach(cleanup);

describe('TranscriptActiveEntryFrame', () => {
  it('shows exactly one overflow action button and opens actions from it', () => {
    const onActions = vi.fn();

    renderWithTheme(
      <View>
        <TranscriptActiveEntryFrame active={false} onActions={vi.fn()}>
          <Text>first entry</Text>
        </TranscriptActiveEntryFrame>
        <TranscriptActiveEntryFrame active onActions={onActions}>
          <Text>second entry</Text>
        </TranscriptActiveEntryFrame>
      </View>,
    );

    const buttons = screen.getAllByRole('button', { name: 'Message actions' });
    expect(buttons).toHaveLength(1);

    fireEvent.click(buttons[0]!);

    expect(onActions).toHaveBeenCalledTimes(1);
  });
});
