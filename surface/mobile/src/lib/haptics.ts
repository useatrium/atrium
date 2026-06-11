import * as Haptics from 'expo-haptics';

export function selectionHaptic() {
  void Haptics.selectionAsync().catch(() => {});
}

export function lightImpactHaptic() {
  void Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(() => {});
}
