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

  it('keeps the toggle icon-only while exposing its full description', () => {
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
    const toggle = screen.getByLabelText('Agent mode selected. Switch to People mode.');
    expect(screen.queryByText('Suggests a prompt for Gary.')).not.toBeInTheDocument();

    fireEvent.click(toggle);
    expect(screen.getByLabelText('People mode selected. Switch to Agent mode.')).toBeInTheDocument();
  });
});
