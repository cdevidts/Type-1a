import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { assessKetones } from '@type1a/domain';

import { parseBlankAsUnsetPositive, parseNonNegativeNumber } from '../format';
import { logSaveError } from '../log';
import { colors, radius, spacing } from '../theme';
import { ModalShell } from './ModalShell';

/**
 * Los accesos rápidos de un solo propósito: Basal y Cetonas.
 *
 * ## Por qué vuelven a ser modales dedicados
 *
 * Una fase anterior los convirtió en focos del Modal Maestro. La experiencia
 * que pide el producto es otra: **el momento en que se miden las cetonas
 * —enfermedad, glucosa alta sostenida— es justo cuando no se quiere navegar**,
 * y lo mismo vale para la basal de todos los días. Un formulario de seis
 * secciones, aunque cinco vengan plegadas, se lee como un formulario largo.
 *
 * ## Y por qué esto NO es volver atrás
 *
 * El fallo que produjo la fusión no fue tener modales pequeños: fue que **cada
 * uno traía su propia copia del parseo, la validación y la escritura**, y las
 * copias divergieron. Acá hay un solo componente parametrizado, sin lógica
 * clínica propia:
 *
 * - El blanco lo resuelven `parseBlankAsUnsetPositive` / `parseNonNegativeNumber`
 *   de `format.ts`, no un chequeo a mano.
 * - La banda de cetonas la decide `assessKetones` en `packages/domain`, y se
 *   muestra **escrita**, no solo en el tono. Este archivo no sabe qué es una
 *   banda urgente.
 * - Guardar es la misma función de `db.ts` que usa el maestro; acá solo se
 *   junta el número.
 *
 * La entrada completa sigue siendo el maestro: quien quiera anotar la basal
 * **y** la glucosa entra por "Nueva entrada", que es un toque más y guarda
 * todo junto bajo un mismo `entry_group_id`.
 */

export type QuickNumericKind = 'basal' | 'ketones';

const COPY: Record<QuickNumericKind, {
  title: string;
  label: string;
  unit: string;
  placeholder: string;
  hint: string;
  cta: string;
}> = {
  basal: {
    title: 'Basal',
    label: 'Unidades de acción prolongada',
    unit: 'U',
    placeholder: '—',
    hint: 'Se guarda exactamente lo que escribas. La app no calcula ni sugiere dosis de basal.',
    cta: 'Guardar basal',
  },
  ketones: {
    title: 'Cetonas',
    label: 'Cetonas en sangre',
    unit: 'mmol/L',
    placeholder: '—',
    hint: 'Type 1A registra el valor y te dice en qué banda cae; qué hacer con eso lo decides con tu equipo clínico.',
    cta: 'Guardar cetonas',
  },
};

export function QuickNumericModal({
  kind,
  visible,
  insulinName,
  onClose,
  onSave,
  onOpenFullEntry,
}: {
  kind: QuickNumericKind;
  visible: boolean;
  /**
   * Solo para 'basal': qué insulina se va a estampar. Es **dato de solo
   * lectura** — el nombre vive en Ajustes → Terapia, no en cada registro.
   */
  insulinName?: string | undefined;
  onClose: () => void;
  onSave: (value: number) => Promise<void>;
  /** Salida al maestro para quien además quiera anotar otra cosa. */
  onOpenFullEntry: () => void;
}) {
  const copy = COPY[kind];
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    setText('');
    setMessage(null);
    setBusy(false);
  }, [visible]);

  // La banda se calcula mientras escribe, para que el valor no se guarde a
  // ciegas. La decide el dominio; acá solo se muestra su texto.
  const preview = (() => {
    if (kind !== 'ketones') return null;
    const value = parseNonNegativeNumber(text);
    if (value === null || text.trim() === '' || value > 20) return null;
    return assessKetones(value);
  })();

  async function save(): Promise<void> {
    setMessage(null);
    const value = kind === 'basal' ? parseBlankAsUnsetPositive(text) : parseNonNegativeNumber(text);
    if (value === null || value === undefined) {
      setMessage(kind === 'basal'
        ? 'Escribe las unidades: un número positivo.'
        : 'Escribe las cetonas: un número entre 0 y 20 mmol/L.');
      return;
    }
    if (kind === 'basal' && value > 100) {
      setMessage('Las unidades deben ser 100 U o menos. Revisa si escribiste un punto de más.');
      return;
    }
    if (kind === 'ketones' && value > 20) {
      setMessage('Las cetonas deben estar entre 0 y 20 mmol/L.');
      return;
    }
    setBusy(true);
    try {
      await onSave(value);
      onClose();
    } catch (error) {
      logSaveError(`QuickNumericModal.${kind}`, error);
      setMessage('No se pudo guardar. Inténtalo otra vez; nada se perdió.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalShell visible={visible} title={copy.title} onClose={onClose}>
      <Text style={styles.label}>{copy.label}</Text>
      <View style={styles.inputWrap}>
        <TextInput
          value={text}
          onChangeText={setText}
          keyboardType="decimal-pad"
          style={styles.input}
          placeholder={copy.placeholder}
          placeholderTextColor={colors.muted}
          selectTextOnFocus
          autoFocus
          accessibilityLabel={`${copy.label} en ${copy.unit}`}
        />
        <Text style={styles.unit}>{copy.unit}</Text>
      </View>

      {preview === null ? null : (
        <View style={[styles.band, preview.urgent && styles.bandUrgent]}>
          {/* La banda va **escrita**. El tono la refuerza; nunca la comunica solo. */}
          <Text style={[styles.bandText, preview.urgent && styles.bandTextUrgent]}>
            Banda: {preview.label}
          </Text>
          {preview.urgent ? (
            <Text style={styles.bandTextUrgent}>Corresponde contactar a tu equipo clínico sin esperar.</Text>
          ) : null}
        </View>
      )}

      {kind === 'basal' ? (
        <Text style={styles.hint}>
          Insulina basal: {insulinName ?? 'sin configurar'}. Se estampa al guardar y se cambia en Ajustes → Terapia,
          no aquí.
        </Text>
      ) : null}
      <Text style={styles.hint}>{copy.hint}</Text>

      {message === null ? null : <Text style={styles.message}>{message}</Text>}

      <Pressable style={[styles.save, busy && styles.disabled]} disabled={busy} onPress={() => { void save(); }} accessibilityRole="button">
        <Text style={styles.saveText}>{busy ? 'Guardando…' : copy.cta}</Text>
      </Pressable>
      <Pressable style={styles.link} onPress={onOpenFullEntry} accessibilityRole="button">
        <Text style={styles.linkText}>Anotar también otra cosa (entrada completa)</Text>
      </Pressable>
    </ModalShell>
  );
}

const styles = StyleSheet.create({
  label: { color: colors.navy, fontSize: 13, fontWeight: '800', marginTop: spacing.md },
  inputWrap: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface,
    borderRadius: radius.sm, borderColor: colors.line, borderWidth: 1, marginTop: 6, paddingHorizontal: spacing.md,
  },
  input: { color: colors.ink, fontSize: 28, fontWeight: '800', flex: 1, paddingVertical: spacing.md, minHeight: 56 },
  unit: { color: colors.muted, fontSize: 13, marginLeft: 4 },
  band: { backgroundColor: colors.tealSoft, borderRadius: radius.sm, padding: spacing.md, marginTop: spacing.md },
  bandUrgent: { backgroundColor: colors.redSoft },
  bandText: { color: colors.navy, fontSize: 14, fontWeight: '800' },
  bandTextUrgent: { color: colors.red, fontSize: 13, fontWeight: '800', lineHeight: 18 },
  hint: { color: colors.muted, fontSize: 12, lineHeight: 17, marginTop: spacing.md },
  message: { color: colors.warning, backgroundColor: colors.warningSoft, borderRadius: radius.sm, padding: spacing.md, fontSize: 13, lineHeight: 19, marginTop: spacing.md },
  save: { backgroundColor: colors.teal, borderRadius: radius.md, padding: spacing.lg, alignItems: 'center', marginTop: spacing.xl, minHeight: 44, justifyContent: 'center' },
  saveText: { color: '#FFFFFF', fontSize: 16, fontWeight: '800' },
  link: { minHeight: 44, justifyContent: 'center', alignItems: 'center', marginTop: spacing.sm },
  linkText: { color: colors.teal, fontSize: 13, fontWeight: '700' },
  disabled: { opacity: 0.55 },
});
