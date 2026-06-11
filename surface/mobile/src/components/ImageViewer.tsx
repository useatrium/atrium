import { useEffect, useMemo, useRef, useState } from 'react';
import {
  Modal,
  PanResponder,
  Platform,
  Pressable,
  ScrollView,
  Text,
  View,
  useWindowDimensions,
} from 'react-native';
import { Image } from 'expo-image';
import type { AttachmentMeta } from '@atrium/surface-client';
import { colors, font, space } from '../lib/theme';

export interface ImageViewerProps {
  attachment: AttachmentMeta | null;
  fileUrl: (id: string) => string;
  fileHeaders?: Record<string, string>;
  onClose: () => void;
  onOpenExternal: (fileId: string) => void;
}

const DOUBLE_TAP_MS = 280;

export function ImageViewer({
  attachment,
  fileUrl,
  fileHeaders,
  onClose,
  onOpenExternal,
}: ImageViewerProps) {
  const { width, height } = useWindowDimensions();
  const [zoomed, setZoomed] = useState(false);
  const lastTapRef = useRef(0);

  useEffect(() => {
    setZoomed(false);
    lastTapRef.current = 0;
  }, [attachment?.id]);

  const panResponder = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponder: (_, gesture) =>
          !zoomed && Math.abs(gesture.dy) > 12 && Math.abs(gesture.dy) > Math.abs(gesture.dx),
        onPanResponderRelease: (_, gesture) => {
          if (gesture.dy > 80) onClose();
        },
      }),
    [onClose, zoomed],
  );

  if (!attachment) return null;

  const ratio = attachment.width && attachment.height ? attachment.width / attachment.height : 1;
  const maxImageWidth = width;
  const maxImageHeight = height - 140;
  let imageWidth = maxImageWidth;
  let imageHeight = imageWidth / ratio;
  if (imageHeight > maxImageHeight) {
    imageHeight = maxImageHeight;
    imageWidth = imageHeight * ratio;
  }
  const scale = zoomed ? 2 : 1;

  const handleTap = () => {
    const now = Date.now();
    if (now - lastTapRef.current < DOUBLE_TAP_MS) setZoomed((value) => !value);
    lastTapRef.current = now;
  };

  return (
    <Modal visible transparent animationType="fade" onRequestClose={onClose}>
      <View
        style={{ flex: 1, backgroundColor: 'black' }}
        {...panResponder.panHandlers}
      >
        <View
          style={{
            position: 'absolute',
            top: 48,
            left: 0,
            right: 0,
            zIndex: 2,
            flexDirection: 'row',
            alignItems: 'center',
            justifyContent: 'space-between',
            paddingHorizontal: space.lg,
          }}
        >
          <Pressable onPress={onClose} hitSlop={12} style={{ padding: space.sm }}>
            <Text style={{ color: colors.text, fontSize: 24, lineHeight: 26 }}>x</Text>
          </Pressable>
          <Pressable
            onPress={() => onOpenExternal(attachment.id)}
            hitSlop={12}
            style={{ padding: space.sm }}
          >
            <Text style={{ color: colors.text, fontSize: font.md, fontWeight: '700' }}>
              Open externally
            </Text>
          </Pressable>
        </View>

        <ScrollView
          style={{ flex: 1 }}
          contentContainerStyle={{
            minHeight: height,
            alignItems: 'center',
            justifyContent: 'center',
          }}
          centerContent
          maximumZoomScale={Platform.OS === 'ios' ? 3 : 1}
          minimumZoomScale={1}
          showsHorizontalScrollIndicator={false}
          showsVerticalScrollIndicator={false}
        >
          <Pressable
            onPress={handleTap}
            style={{
              width: imageWidth * scale,
              height: imageHeight * scale,
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            <Image
              source={{ uri: fileUrl(attachment.id), headers: fileHeaders }}
              style={{
                width: imageWidth,
                height: imageHeight,
                transform: [{ scale }],
              }}
              contentFit="contain"
              transition={120}
            />
          </Pressable>
        </ScrollView>
        {Platform.OS === 'android' ? (
          // React Native ScrollView exposes native pinch zoom on iOS only; Android keeps double-tap zoom.
          <View style={{ position: 'absolute', width: 1, height: 1, opacity: 0 }} />
        ) : null}
      </View>
    </Modal>
  );
}
