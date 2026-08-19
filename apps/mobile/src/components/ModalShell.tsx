import type { ReactNode } from 'react';
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View,
} from 'react-native';
// `SafeAreaView` tiene que venir de `react-native-safe-area-context`, NO de
// `react-native`: el de RN es iOS-only y en Android se comporta como un
// `View` cualquiera, sin insets. Con edge-to-edge (obligatorio desde Expo
// SDK 54) la app dibuja debajo de la barra de estado, así que el header de
// cada modal — y con él el botón "Cerrar" — quedaba tapado por la hora, la
// batería y la señal. `App.tsx` ya usaba el correcto; este archivo no.
import { SafeAreaView } from 'react-native-safe-area-context';

import { colors, spacing } from '../theme';

export function ModalShell({
  visible,
  title,
  onClose,
  children,
  scroll = true,
}: {
  visible: boolean;
  title: string;
  onClose: () => void;
  children: ReactNode;
  scroll?: boolean;
}) {
  // `scroll={false}` hands the child full control of its own scrolling and
  // padding (see SummaryModal: fixed tab bar + range row, then its own
  // ScrollView for the tab content) — applying `styles.content`'s padding
  // here too used to double it up wherever the child added its own,
  // throwing off any width computed from the screen width minus a single
  // padding layer (charts rendering wider than their card, e.g.).
  const body = scroll ? (
    <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
      {children}
    </ScrollView>
  ) : (
    <View style={styles.flex}>{children}</View>
  );

  return (
    <Modal visible={visible} animationType="slide" presentationStyle="pageSheet" onRequestClose={onClose}>
      <SafeAreaView style={styles.safeArea} edges={['top', 'bottom']}>
        <KeyboardAvoidingView
          style={styles.flex}
          behavior={Platform.OS === 'ios' ? 'padding' : undefined}
        >
          <View style={styles.header}>
            <Text style={styles.title}>{title}</Text>
            <Pressable accessibilityRole="button" accessibilityLabel="Cerrar" onPress={onClose} hitSlop={10}>
              <Text style={styles.close}>Cerrar</Text>
            </Pressable>
          </View>
          {body}
        </KeyboardAvoidingView>
      </SafeAreaView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  safeArea: { flex: 1, backgroundColor: colors.background },
  flex: { flex: 1 },
  header: {
    backgroundColor: colors.surface,
    borderBottomColor: colors.line,
    borderBottomWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: spacing.lg,
    paddingVertical: spacing.md,
  },
  title: { color: colors.ink, fontSize: 21, fontWeight: '800' },
  close: { color: colors.teal, fontSize: 15, fontWeight: '700' },
  content: { padding: spacing.lg, paddingBottom: 44 },
});
