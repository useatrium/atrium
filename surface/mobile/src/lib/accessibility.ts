import { useEffect, useRef, type Component, type ComponentClass, type RefObject } from 'react';
import { AccessibilityInfo, Platform, findNodeHandle } from 'react-native';

type FocusTarget = null | number | Component<any, any> | ComponentClass<any>;

export function useModalAccessibilityFocus(ref: RefObject<unknown>, visible: boolean) {
  useEffect(() => {
    if (!visible) return;
    if (Platform.OS === 'web') return;
    const timer = setTimeout(() => {
      const tag = findNodeHandle(ref.current as FocusTarget);
      if (tag != null) AccessibilityInfo.setAccessibilityFocus(tag);
    }, 100);
    return () => clearTimeout(timer);
  }, [ref, visible]);
}

export function useAccessibilityAnnouncement(message: string | null | undefined, enabled = true) {
  const lastMessage = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled || !message) {
      if (!message) lastMessage.current = null;
      return;
    }
    if (lastMessage.current === message) return;
    lastMessage.current = message;
    AccessibilityInfo.announceForAccessibility(message);
  }, [enabled, message]);
}
