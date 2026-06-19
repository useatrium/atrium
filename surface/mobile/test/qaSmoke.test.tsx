// @vitest-environment jsdom
// QA-loop smoke test: proves RN components render + respond to interaction under
// vitest via react-native-web + Testing Library (the loop the mobile surfaces use).
import '@testing-library/jest-dom/vitest';
import { afterEach, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Pressable, Text, View } from 'react-native';

afterEach(cleanup);

it('renders RN primitives and fires onPress through RNW', () => {
  const onPress = vi.fn();
  render(
    <View>
      <Text>hello mobile</Text>
      <Pressable onPress={onPress} accessibilityRole="button">
        <Text>tap me</Text>
      </Pressable>
    </View>,
  );
  expect(screen.getByText('hello mobile')).toBeInTheDocument();
  fireEvent.click(screen.getByText('tap me'));
  expect(onPress).toHaveBeenCalledTimes(1);
});
