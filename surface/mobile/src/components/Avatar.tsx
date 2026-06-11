import { Text, View } from 'react-native';
import { initials, userColor } from '@atrium/surface-client';

/** Colored-initials avatar, same hash/palette as the web client. */
export function Avatar({ name, seed, size = 36 }: { name: string; seed: string; size?: number }) {
  return (
    <View
      style={{
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.3),
        backgroundColor: userColor(seed),
        alignItems: 'center',
        justifyContent: 'center',
      }}
    >
      <Text
        style={{
          color: 'white',
          fontSize: Math.round(size * 0.38),
          fontWeight: '700',
        }}
      >
        {initials(name)}
      </Text>
    </View>
  );
}
