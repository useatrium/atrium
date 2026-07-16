// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { useState } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, screen } from '@testing-library/react';
import { Text } from 'react-native';
import {
  SessionAudienceToggle,
  sessionComposerRoute,
  type SessionComposerAudience,
} from '../src/components/SessionAudienceToggle';
import { renderWithTheme } from './rnTestUtils';

vi.mock('@expo/vector-icons', () => ({
  Ionicons: ({ name }: { name: string }) => <Text>{name}</Text>,
  MaterialCommunityIcons: ({ name }: { name: string }) => <Text>{name}</Text>,
}));

afterEach(cleanup);

describe('full-session composer audience', () => {
  it('routes People to the thread and Agent to steer or suggest', () => {
    expect(sessionComposerRoute('people', true, true)).toBe('discussion');
    expect(sessionComposerRoute('agent', true, true)).toBe('steer');
    expect(sessionComposerRoute('agent', false, true)).toBe('suggest');
    expect(sessionComposerRoute('people', false, false)).toBe('suggest');
  });

  it('uses a binary switch with both audiences visible and checked state', () => {
    function Harness() {
      const [audience, setAudience] = useState<SessionComposerAudience>('agent');
      return (
        <SessionAudienceToggle
          audience={audience}
          isDriver={false}
          driverName="Gary"
          onToggle={() => setAudience((current) => (current === 'agent' ? 'people' : 'agent'))}
        />
      );
    }

    renderWithTheme(<Harness />);
    const toggle = screen.getByRole('switch', { name: 'Agent audience' });
    expect(toggle).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('chatbubble-ellipses-outline')).toBeInTheDocument();
    expect(screen.getByText('robot')).toBeInTheDocument();
    expect(screen.queryByText('Suggests a prompt for Gary.')).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(toggle).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText('chatbubble-ellipses')).toBeInTheDocument();
    expect(screen.getByText('robot-outline')).toBeInTheDocument();
  });
});
