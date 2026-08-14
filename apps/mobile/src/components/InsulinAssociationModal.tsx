import { useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { formatDayTime } from '../format';
import { colors, radius, spacing } from '../theme';
import type { PendingInsulinAssociation } from '../types';
import { ModalShell } from './ModalShell';

export function InsulinAssociationModal({
  pending,
  onConfirm,
}: {
  pending: PendingInsulinAssociation | null;
  onConfirm: (episodeId: string, insulinEventId: string | null) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function confirm(insulinEventId: string | null): Promise<void> {
    if (pending === null) return;
    setBusy(true);
    setError(null);
    try {
      await onConfirm(pending.episodeId, insulinEventId);
    } catch {
      setError('No se pudo guardar la asociación.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <ModalShell
      visible={pending !== null}
      title="Contexto de insulina"
      onClose={() => { setError('El episodio seguirá pendiente hasta confirmar este contexto.'); }}
    >
      {pending === null ? null : (
        <>
          <View style={styles.mealCard}>
            <Text style={styles.eyebrow}>COMIDA</Text>
            <Text style={styles.mealTime}>{formatDayTime(pending.mealTimestamp)}</Text>
            <Text style={styles.carbs}>{pending.confirmedCarbsG} g de carbohidratos confirmados</Text>
          </View>
          <Text style={styles.question}>¿Qué insulina rápida corresponde a esta comida?</Text>
          <Text style={styles.explanation}>Solo se muestran dosis registradas entre 90 minutos antes y 60 minutos después. No se asociará ninguna sin tu confirmación cuando haya ambigüedad.</Text>

          {pending.candidates.length === 0 ? (
            <View style={styles.emptyCandidates}>
              <Text style={styles.emptyText}>No se encontraron dosis rápidas en esa ventana.</Text>
            </View>
          ) : pending.candidates.map((event) => (
            <Pressable
              key={event.id}
              style={[styles.candidate, busy && styles.disabled]}
              disabled={busy}
              onPress={() => { void confirm(event.id); }}
            >
              <Text style={styles.candidateUnits}>{event.units} U</Text>
              <Text style={styles.candidateTime}>{formatDayTime(event.timestamp)}</Text>
            </Pressable>
          ))}

          <Pressable
            style={[styles.noneButton, busy && styles.disabled]}
            disabled={busy}
            onPress={() => { void confirm(null); }}
          >
            <Text style={styles.noneText}>Confirmar que no hubo rápida asociada</Text>
          </Pressable>
          <Text style={styles.safety}>Esto completa el contexto del episodio; no calcula IOB ni modifica una dosis.</Text>
          {error === null ? null : <Text style={styles.error}>{error}</Text>}
        </>
      )}
    </ModalShell>
  );
}

const styles = StyleSheet.create({
  mealCard: { backgroundColor: colors.orangeSoft, borderRadius: radius.md, padding: spacing.md },
  eyebrow: { color: colors.orange, fontSize: 10, fontWeight: '900', letterSpacing: 0.8 },
  mealTime: { color: colors.ink, fontSize: 20, fontWeight: '800', marginTop: 3 },
  carbs: { color: colors.muted, fontSize: 13, marginTop: 4 },
  question: { color: colors.ink, fontSize: 20, fontWeight: '800', marginTop: spacing.xl },
  explanation: { color: colors.muted, fontSize: 13, lineHeight: 19, marginTop: spacing.sm },
  candidate: { backgroundColor: colors.surface, borderColor: colors.blue, borderWidth: 1, borderRadius: radius.md, padding: spacing.lg, flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginTop: spacing.md },
  candidateUnits: { color: colors.blue, fontSize: 22, fontWeight: '900' },
  candidateTime: { color: colors.muted, fontSize: 13 },
  emptyCandidates: { backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.lg, marginTop: spacing.md },
  emptyText: { color: colors.muted, fontSize: 13, textAlign: 'center' },
  noneButton: { backgroundColor: colors.navy, borderRadius: radius.md, padding: spacing.lg, alignItems: 'center', marginTop: spacing.md },
  noneText: { color: '#FFFFFF', fontSize: 14, fontWeight: '800', textAlign: 'center' },
  safety: { color: colors.muted, fontSize: 11, lineHeight: 16, marginTop: spacing.md },
  error: { color: colors.red, fontSize: 13, marginTop: spacing.md },
  disabled: { opacity: 0.55 },
});
