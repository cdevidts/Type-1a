import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import {
  confirmProposal,
  initialServingGrams,
  rejectionMessage,
  MAX_SERVING_GRAMS,
  MIN_SERVING_GRAMS,
  type CatalogFood,
  type CatalogProposal,
  type CatalogProposalSet,
} from '@type1a/domain';

import { parseNonNegativeNumber } from '../format';
import { logSaveError } from '../log';
import { colors, radius, spacing } from '../theme';
import { ModalShell } from './ModalShell';

/** Mismo formato corto que usa `CatalogModal`, para que los dos coincidan. */
const numberText = (value: number): string => String(Number(value.toFixed(2)));

/**
 * Confirmar qué se guarda en el catálogo y con qué porción.
 *
 * ## Qué arregla
 *
 * Dos fallas opuestas que aparecieron el mismo día en el teléfono:
 *
 * 1. **Un alimento que no se podía normalizar desaparecía sin decir nada.**
 *    Una Monster Zero descrita por texto vuelve sin gramos de plato —el prompt
 *    le pide al modelo devolver `null` cuando no puede estimarlos— y el
 *    catálogo la descartaba. La pantalla decía "guardado" y no había nada.
 *    Acá cada descarte se muestra **con su razón**.
 * 2. **Todo quedaba con porción de 100 g**, así que reusar un alimento
 *    obligaba a averiguar por fuera qué fracción de 100 g es una porción de
 *    verdad. Ahora la IA la propone y esta pantalla la deja confirmar.
 *
 * ## Por qué se confirma y no se aplica solo
 *
 * La porción multiplica los cuatro macros, así que termina alimentando los
 * carbohidratos que se sugieren cada vez que el alimento se reutiliza. Un
 * número que la IA inventó y nadie miró no puede entrar por esa puerta.
 * Confirmarlo lo vuelve un dato de la usuaria (`servingSource: 'user'`), y
 * desde ahí ningún análisis posterior lo pisa — ver `blendCatalogEntry`.
 *
 * Nada acá calcula ni sugiere insulina: son gramos de alimento.
 *
 * ## Qué NO hace
 *
 * No bloquea el registro. La comida ya quedó guardada antes de que esto se
 * abra; el catálogo es una comodidad, y cerrar sin confirmar no pierde nada de
 * lo que se comió.
 */

/** La decisión ya tomada, lista para escribirse. */
export interface ConfirmedCatalogEntries {
  entries: Omit<CatalogFood, 'timesSeen'>[];
}

function ProposalRow({
  proposal,
  grams,
  label,
  onGrams,
  onLabel,
}: {
  proposal: CatalogProposal;
  grams: string;
  label: string;
  onGrams: (value: string) => void;
  onLabel: (value: string) => void;
}) {
  const { entry } = proposal;
  return (
    <View style={styles.card}>
      <View style={styles.cardHead}>
        <Text style={styles.name} numberOfLines={2}>{entry.name}</Text>
        {/* El estado va **escrito**, nunca solo por color: alta y fusión
            tienen consecuencias distintas sobre un dato que ya existía. */}
        <Text style={[styles.badge, proposal.existing ? styles.badgeMerge : styles.badgeNew]}>
          {proposal.existing ? 'Ya existe · se fusiona' : 'Nuevo'}
        </Text>
      </View>

      <Text style={styles.macros}>
        {numberText(entry.carbsPer100g)} g carbos · {numberText(entry.proteinPer100g)} g proteína ·{' '}
        {numberText(entry.fatPer100g)} g grasa · {numberText(entry.fiberPer100g)} g fibra ·{' '}
        {numberText(entry.kcalPer100g)} kcal <Text style={styles.per100}>por 100 g</Text>
      </Text>

      <Text style={styles.basis}>
        {proposal.basis === 'plate'
          ? `Calculado sobre los ${numberText(proposal.basisGrams)} g que la IA estimó en el plato.`
          : `Sin gramos del plato: calculado sobre una porción de ${numberText(proposal.basisGrams)} g.`}
      </Text>

      <Text style={styles.fieldLabel}>Una porción pesa</Text>
      <View style={styles.inputWrap}>
        <TextInput
          value={grams}
          onChangeText={onGrams}
          keyboardType="decimal-pad"
          style={styles.input}
          placeholder="sin definir"
          placeholderTextColor={colors.muted}
          selectTextOnFocus
          accessibilityLabel={`Gramos de una porción de ${entry.name}`}
        />
        <Text style={styles.unit}>g</Text>
      </View>

      <TextInput
        value={label}
        onChangeText={onLabel}
        style={styles.labelInput}
        placeholder="Cómo se dice: 2 rebanadas, 1 taza, 1 lata"
        placeholderTextColor={colors.muted}
        accessibilityLabel={`Nombre de la porción de ${entry.name}`}
      />

      {proposal.existingServingGrams !== null ? (
        <Text style={styles.kept}>
          Ya tenías {numberText(proposal.existingServingGrams)} g anotados para este alimento, así que se
          precargó eso y no la propuesta de la IA. Cámbialo si quieres.
        </Text>
      ) : proposal.proposedServingGrams === null ? (
        <Text style={styles.kept}>
          La IA no propuso una porción. Puedes dejarla sin definir: se usarán 100 g al reutilizarlo.
        </Text>
      ) : (
        <Text style={styles.kept}>
          Propuesto por la IA{proposal.proposedServingLabel === null ? '' : `: ${proposal.proposedServingLabel}`}.
          Revísalo antes de confirmar.
        </Text>
      )}
    </View>
  );
}

export function CatalogServingModal({
  visible,
  proposals,
  onClose,
  onConfirm,
}: {
  visible: boolean;
  proposals: CatalogProposalSet | null;
  /** Cerrar sin guardar nada al catálogo. La comida ya quedó registrada. */
  onClose: () => void;
  onConfirm: (confirmed: ConfirmedCatalogEntries) => Promise<void>;
}) {
  const [grams, setGrams] = useState<Record<string, string>>({});
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    if (!visible || proposals === null) return;
    const nextGrams: Record<string, string> = {};
    const nextLabels: Record<string, string> = {};
    for (const proposal of proposals.proposals) {
      // La porción que ella ya fijó manda sobre la que propone la IA.
      const initial = initialServingGrams(proposal);
      nextGrams[proposal.entry.key] = initial === null ? '' : numberText(initial);
      nextLabels[proposal.entry.key] = proposal.entry.servingLabel ?? proposal.proposedServingLabel ?? '';
    }
    setGrams(nextGrams);
    setLabels(nextLabels);
    setMessage(null);
    setBusy(false);
  }, [visible, proposals]);

  async function confirm(): Promise<void> {
    if (proposals === null) return;
    setMessage(null);
    const entries: Omit<CatalogFood, 'timesSeen'>[] = [];
    for (const proposal of proposals.proposals) {
      const text = (grams[proposal.entry.key] ?? '').trim();
      // Vacío es una respuesta válida —"este alimento no tiene porción
      // convencional"—, no un error. `Number('')` es 0, así que el vacío se
      // resuelve antes de parsear o se guardaría una porción de 0 g.
      const parsed = text === '' ? null : parseNonNegativeNumber(text);
      if (text !== '' && (parsed === null || parsed < MIN_SERVING_GRAMS || parsed > MAX_SERVING_GRAMS)) {
        setMessage(`Revisa la porción de ${proposal.entry.name}: tiene que estar entre ${MIN_SERVING_GRAMS} y ${MAX_SERVING_GRAMS} g, o quedar vacía.`);
        return;
      }
      const labelText = (labels[proposal.entry.key] ?? '').trim();
      const entry = confirmProposal(proposal, {
        servingGrams: parsed,
        servingLabel: labelText === '' ? null : labelText,
      });
      if (entry === null) {
        setMessage(`No se pudo preparar ${proposal.entry.name} con esos valores. Revisa la porción.`);
        return;
      }
      entries.push(entry);
    }
    setBusy(true);
    try {
      await onConfirm({ entries });
      onClose();
    } catch (error) {
      logSaveError('CatalogServingModal.confirm', error);
      setMessage('No se pudo guardar en el catálogo. Tu comida sí quedó registrada; puedes reintentarlo desde Catálogo.');
    } finally {
      setBusy(false);
    }
  }

  const list = proposals?.proposals ?? [];
  const rejected = proposals?.rejected ?? [];

  return (
    <ModalShell visible={visible} title="Guardar en tu catálogo" onClose={onClose}>
      <Text style={styles.intro}>
        Esto es lo que se guardaría para reutilizar después. La porción define cuánto es "una porción" cuando
        vuelvas a elegir el alimento, así que revísala: es lo que multiplica sus macros.
      </Text>

      {list.length === 0 && rejected.length === 0 ? (
        <Text style={styles.empty}>
          El análisis no dejó ningún alimento para el catálogo. Analiza la comida con foto o con una
          descripción y vuelve a intentarlo.
        </Text>
      ) : null}

      {list.map((proposal) => (
        <ProposalRow
          key={proposal.entry.key}
          proposal={proposal}
          grams={grams[proposal.entry.key] ?? ''}
          label={labels[proposal.entry.key] ?? ''}
          onGrams={(value) => { setGrams((prev) => ({ ...prev, [proposal.entry.key]: value })); }}
          onLabel={(value) => { setLabels((prev) => ({ ...prev, [proposal.entry.key]: value })); }}
        />
      ))}

      {rejected.length === 0 ? null : (
        <View style={styles.rejected}>
          {/* Antes esto se descartaba en silencio y la pantalla decía
              "guardado". Un alimento que no entra tiene que decir por qué. */}
          <Text style={styles.rejectedTitle}>No se pueden guardar todavía</Text>
          {rejected.map((rejection, index) => (
            <Text key={`${rejection.name}-${index}`} style={styles.rejectedItem}>• {rejectionMessage(rejection)}</Text>
          ))}
        </View>
      )}

      {message === null ? null : <Text style={styles.message}>{message}</Text>}

      <Pressable
        style={[styles.save, (busy || list.length === 0) && styles.disabled]}
        disabled={busy || list.length === 0}
        onPress={() => { void confirm(); }}
        accessibilityRole="button"
      >
        <Text style={styles.saveText}>
          {busy ? 'Guardando…' : `Confirmar y guardar ${list.length === 1 ? 'el alimento' : `los ${list.length} alimentos`}`}
        </Text>
      </Pressable>
      <Pressable style={styles.link} onPress={onClose} accessibilityRole="button">
        <Text style={styles.linkText}>Ahora no · tu comida ya quedó registrada</Text>
      </Pressable>
    </ModalShell>
  );
}

const styles = StyleSheet.create({
  intro: { color: colors.muted, fontSize: 13, lineHeight: 19, marginTop: spacing.md },
  empty: { color: colors.muted, fontSize: 13, lineHeight: 19, marginTop: spacing.xl, textAlign: 'center' },
  card: {
    backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line,
    padding: spacing.md, marginTop: spacing.md,
  },
  cardHead: { flexDirection: 'row', alignItems: 'flex-start', gap: spacing.sm },
  name: { flex: 1, color: colors.ink, fontSize: 15, fontWeight: '800' },
  badge: { fontSize: 10, fontWeight: '900', overflow: 'hidden', borderRadius: radius.sm, paddingHorizontal: spacing.sm, paddingVertical: 3 },
  badgeNew: { color: colors.green, backgroundColor: colors.greenSoft },
  badgeMerge: { color: colors.navy, backgroundColor: colors.tealSoft },
  macros: { color: colors.ink, fontSize: 12, lineHeight: 18, marginTop: spacing.sm },
  per100: { color: colors.muted, fontWeight: '700' },
  basis: { color: colors.muted, fontSize: 11, lineHeight: 16, marginTop: 4 },
  fieldLabel: { color: colors.navy, fontSize: 12, fontWeight: '800', marginTop: spacing.md },
  inputWrap: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: colors.background,
    borderRadius: radius.sm, borderColor: colors.line, borderWidth: 1, marginTop: 6, paddingHorizontal: spacing.md,
  },
  input: { color: colors.ink, fontSize: 18, fontWeight: '800', flex: 1, paddingVertical: spacing.sm, minHeight: 44 },
  unit: { color: colors.muted, fontSize: 13, marginLeft: 4 },
  labelInput: {
    color: colors.ink, fontSize: 14, backgroundColor: colors.background, borderRadius: radius.sm,
    borderColor: colors.line, borderWidth: 1, paddingHorizontal: spacing.md, paddingVertical: spacing.sm,
    marginTop: spacing.sm, minHeight: 44,
  },
  kept: { color: colors.muted, fontSize: 11, lineHeight: 16, marginTop: spacing.sm },
  rejected: { backgroundColor: colors.warningSoft, borderRadius: radius.sm, padding: spacing.md, marginTop: spacing.lg },
  rejectedTitle: { color: colors.warning, fontSize: 13, fontWeight: '800' },
  rejectedItem: { color: colors.warning, fontSize: 12, lineHeight: 18, marginTop: 4 },
  message: { color: colors.warning, backgroundColor: colors.warningSoft, borderRadius: radius.sm, padding: spacing.md, fontSize: 13, lineHeight: 19, marginTop: spacing.md },
  save: { backgroundColor: colors.teal, borderRadius: radius.md, padding: spacing.lg, alignItems: 'center', marginTop: spacing.xl, minHeight: 44, justifyContent: 'center' },
  saveText: { color: '#FFFFFF', fontSize: 16, fontWeight: '800' },
  link: { minHeight: 44, justifyContent: 'center', alignItems: 'center', marginTop: spacing.sm },
  linkText: { color: colors.teal, fontSize: 13, fontWeight: '700' },
  disabled: { opacity: 0.55 },
});
