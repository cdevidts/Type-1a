import { useEffect, useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import {
  confirmProposal,
  foodKey,
  initialServingGrams,
  recipeItemsFromConfirmed,
  rejectionMessage,
  similarityLabel,
  MAX_SERVING_GRAMS,
  MIN_SERVING_GRAMS,
  type CatalogFood,
  type CatalogProposal,
  type CatalogProposalSet,
  type RecipeItem,
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

/**
 * Qué hacer con una comida de varios alimentos.
 *
 * Es la pregunta de tres salidas que pidió el producto, y aparece **solo**
 * cuando el análisis devolvió más de un alimento: guardar "una manzana" como
 * receta no tiene sentido.
 */
export type MultiFoodChoice = 'foods' | 'recipe' | 'both';

/** La decisión ya tomada, lista para escribirse. */
export interface ConfirmedCatalogEntries {
  /** Los alimentos sueltos. Vacío si eligió guardar **solo** como receta. */
  entries: Omit<CatalogFood, 'timesSeen'>[];
  /**
   * La receta, si eligió guardarla. Sus componentes referencian por clave a
   * los alimentos —que en ese caso también se escriben, porque una receta sin
   * sus componentes en el catálogo sería una suma sin sumandos.
   */
  recipe?: { name: string; items: RecipeItem[]; imageUri?: string | undefined };
}

/**
 * "¿Ya lo tienes?" — fusionar a mano con un alimento del catálogo.
 *
 * La heurística de `catalog-similarity.ts` solo empareja plural/singular y las
 * mismas palabras en otro orden, a propósito: no puede saber que "pata de
 * pollo" es el "Muslo de pollo" de Verónica, y adivinarlo mezclaría macros de
 * dos alimentos distintos. Ella sí lo sabe. Esto le da dónde decirlo: busca en
 * su catálogo y elige; la propuesta pasa a fusionarse con ese en vez de crear
 * otro. Si la heurística encontró algo, viene preseleccionado **y visible**,
 * con la salida "es otro" a un toque.
 */
function MergePicker({
  proposal,
  catalog,
  selected,
  onSelect,
}: {
  proposal: CatalogProposal;
  catalog: readonly CatalogFood[];
  selected: CatalogFood | null;
  onSelect: (food: CatalogFood | null) => void;
}) {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const term = foodKey(query);
  const results = term === ''
    ? []
    : catalog.filter((food) => food.key !== proposal.entry.key && food.key.includes(term)).slice(0, 6);

  return (
    <View style={styles.merge}>
      {selected !== null ? (
        <>
          <Text style={styles.similar}>
            {proposal.similarTo !== null && proposal.similarTo.food.key === selected.key
              ? `${similarityLabel(proposal.similarTo.reason)}: "${selected.name}". `
              : `Se fusiona con "${selected.name}". `}
            Al confirmar se suma a ese alimento en vez de crear otro, y conserva su nombre.
          </Text>
          <View style={styles.mergeRow}>
            <Pressable style={styles.mergeButton} onPress={() => { onSelect(null); setOpen(false); }} accessibilityRole="button">
              <Text style={styles.mergeButtonText}>No, es otro alimento</Text>
            </Pressable>
            <Pressable style={styles.mergeButton} onPress={() => { setOpen((v) => !v); }} accessibilityRole="button">
              <Text style={styles.mergeButtonText}>Elegir otro</Text>
            </Pressable>
          </View>
        </>
      ) : (
        <Pressable style={styles.mergeButton} onPress={() => { setOpen((v) => !v); }} accessibilityRole="button">
          <Text style={styles.mergeButtonText}>{open ? 'Cerrar búsqueda' : '¿Ya lo tienes con otro nombre? Buscar'}</Text>
        </Pressable>
      )}
      {open ? (
        <>
          <TextInput
            value={query}
            onChangeText={setQuery}
            style={styles.labelInput}
            placeholder="Busca en tu catálogo, por ejemplo pollo"
            placeholderTextColor={colors.muted}
            accessibilityLabel={`Buscar con qué alimento fusionar ${proposal.entry.name}`}
            autoFocus
          />
          {results.map((food) => (
            <Pressable
              key={food.key}
              style={styles.mergeResult}
              onPress={() => { onSelect(food); setOpen(false); setQuery(''); }}
              accessibilityRole="button"
              accessibilityLabel={`Fusionar con ${food.name}`}
            >
              <Text style={styles.mergeResultName}>{food.name}</Text>
              <Text style={styles.mergeResultMeta}>
                {numberText(food.carbsPer100g)} g carbos/100 g · visto {food.timesSeen} {food.timesSeen === 1 ? 'vez' : 'veces'}
              </Text>
            </Pressable>
          ))}
          {term !== '' && results.length === 0 ? (
            <Text style={styles.kept}>Nada con ese nombre en tu catálogo.</Text>
          ) : null}
        </>
      ) : null}
    </View>
  );
}

function ProposalRow({
  proposal,
  catalog,
  grams,
  label,
  mergeInto,
  onGrams,
  onLabel,
  onMergeInto,
}: {
  proposal: CatalogProposal;
  catalog: readonly CatalogFood[];
  grams: string;
  label: string;
  mergeInto: CatalogFood | null;
  onGrams: (value: string) => void;
  onLabel: (value: string) => void;
  onMergeInto: (food: CatalogFood | null) => void;
}) {
  const { entry } = proposal;
  const merges = proposal.existing || mergeInto !== null;
  return (
    <View style={styles.card}>
      <View style={styles.cardHead}>
        <Text style={styles.name} numberOfLines={2}>{entry.name}</Text>
        {/* El estado va **escrito**, nunca solo por color: alta y fusión
            tienen consecuencias distintas sobre un dato que ya existía. */}
        <Text style={[styles.badge, merges ? styles.badgeMerge : styles.badgeNew]}>
          {merges ? 'Ya existe · se fusiona' : 'Nuevo'}
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

      {proposal.existing ? null : (
        // Duplicados: **solo se propone**, y desde acá también se elige.
        // Emparejar mal mezcla los macros de dos alimentos distintos, y eso
        // después sugiere carbohidratos sin que nada lo delate.
        <MergePicker proposal={proposal} catalog={catalog} selected={mergeInto} onSelect={onMergeInto} />
      )}

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
  catalog,
  onClose,
  onConfirm,
}: {
  visible: boolean;
  proposals: CatalogProposalSet | null;
  /** El catálogo entero, ocultos incluidos: para fusionar a mano. */
  catalog: readonly CatalogFood[];
  /** Cerrar sin guardar nada al catálogo. La comida ya quedó registrada. */
  onClose: () => void;
  onConfirm: (confirmed: ConfirmedCatalogEntries) => Promise<void>;
}) {
  const [grams, setGrams] = useState<Record<string, string>>({});
  const [labels, setLabels] = useState<Record<string, string>>({});
  const [mergeInto, setMergeInto] = useState<Record<string, CatalogFood | null>>({});
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [choice, setChoice] = useState<MultiFoodChoice>('foods');
  const [recipeName, setRecipeName] = useState('');

  useEffect(() => {
    if (!visible || proposals === null) return;
    const nextGrams: Record<string, string> = {};
    const nextLabels: Record<string, string> = {};
    const nextMerge: Record<string, CatalogFood | null> = {};
    for (const proposal of proposals.proposals) {
      // La porción que ella ya fijó manda sobre la que propone la IA.
      const initial = initialServingGrams(proposal);
      nextGrams[proposal.entry.key] = initial === null ? '' : numberText(initial);
      nextLabels[proposal.entry.key] = proposal.entry.servingLabel ?? proposal.proposedServingLabel ?? '';
      // El parecido por nombre viene preseleccionado y **a la vista**, con la
      // salida "es otro" al lado. Antes el texto prometía la fusión y la
      // entrada se guardaba con su propia clave: prometía y no cumplía.
      nextMerge[proposal.entry.key] = proposal.similarTo?.food ?? null;
    }
    setGrams(nextGrams);
    setLabels(nextLabels);
    setMergeInto(nextMerge);
    setMessage(null);
    setBusy(false);
    // Por defecto, lo de siempre: alimentos sueltos. Guardar como receta es
    // una decisión, no algo que pase por omisión.
    setChoice('foods');
    setRecipeName(proposals.suggestedRecipeName ?? '');
  }, [visible, proposals]);

  async function confirm(): Promise<void> {
    if (proposals === null) return;
    setMessage(null);
    // Una receta necesita nombre y al menos dos componentes; si no, no es un
    // plato, es un alimento.
    const wantsRecipe = isMulti && (choice === 'recipe' || choice === 'both');
    const entries: Omit<CatalogFood, 'timesSeen'>[] = [];
    const confirmedItems: { key: string; basisGrams: number }[] = [];
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
        // "Solo receta": los componentes se escriben pero no se listan
        // sueltos. Antes esta elección hacía exactamente lo mismo que "las
        // dos cosas", y la grilla se llenaba de alimentos que ella no pidió.
        ...(isMulti && choice === 'recipe' ? { listed: false } : {}),
        // Con receta, la foto del plato es de la receta: un componente con la
        // miniatura del plato entero era el bug que originó todo esto.
        ...(wantsRecipe ? { withoutPlatePhoto: true } : {}),
        mergeInto: mergeInto[proposal.entry.key] ?? null,
      });
      if (entry === null) {
        setMessage(`No se pudo preparar ${proposal.entry.name} con esos valores. Revisa la porción.`);
        return;
      }
      entries.push(entry);
      confirmedItems.push({ key: entry.key, basisGrams: proposal.basisGrams });
    }
    if (wantsRecipe && recipeName.trim() === '') {
      setMessage('Ponle un nombre a la receta, por ejemplo "Arroz con pollo".');
      return;
    }
    setBusy(true);
    try {
      await onConfirm({
        // Con "solo receta" los alimentos igual se escriben: una receta guarda
        // referencias a sus componentes y sus totales se derivan de ellos, así
        // que sin los alimentos en el catálogo sería una suma sin sumandos. Lo
        // que cambia es que no se listan sueltos en la grilla.
        entries,
        ...(wantsRecipe
          ? {
              recipe: {
                name: recipeName.trim(),
                // Por clave **final**: dos propuestas fusionadas en el mismo
                // alimento son una sola línea con los gramos sumados.
                items: recipeItemsFromConfirmed(confirmedItems),
                ...(proposals.imageUri === undefined ? {} : { imageUri: proposals.imageUri }),
              },
            }
          : {}),
      });
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
  // La pregunta de tres salidas solo aparece con más de un alimento: guardar
  // "una manzana" como receta no significa nada.
  const isMulti = list.length > 1;

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

      {isMulti ? (
        <View style={styles.block}>
          <Text style={styles.blockTitle}>Son {list.length} alimentos. ¿Cómo lo guardas?</Text>
          <Text style={styles.blockHint}>
            Una receta es el plato completo con sus alimentos adentro. Guardarla arregla que cada
            componente herede la foto del plato entero: dentro de la receta cada uno puede tener la suya.
          </Text>
          <View style={styles.choices}>
            {([
              ['foods', 'Por separado'],
              ['recipe', 'Como receta'],
              ['both', 'Las dos cosas'],
            ] as const).map(([value, label]) => (
              <Pressable
                key={value}
                style={[styles.choice, choice === value && styles.choiceOn]}
                onPress={() => { setChoice(value); }}
                accessibilityRole="button"
                accessibilityState={{ selected: choice === value }}
              >
                <Text style={[styles.choiceText, choice === value && styles.choiceTextOn]}>{label}</Text>
              </Pressable>
            ))}
          </View>
          {choice === 'foods' ? null : (
            <>
              <TextInput
                value={recipeName}
                onChangeText={setRecipeName}
                style={styles.nameInput}
                placeholder="Nombre del plato"
                placeholderTextColor={colors.muted}
                accessibilityLabel="Nombre de la receta"
              />
              <Text style={styles.blockHint}>
                {choice === 'recipe'
                  ? 'Sus alimentos quedan solo dentro de la receta: no aparecen sueltos en el catálogo ni en el buscador. Desde la receta puedes mostrar cualquiera cuando quieras.'
                  : 'La receta y además cada alimento suelto en el catálogo.'}
                {' '}Sus macros no se guardan: siempre son la suma de sus alimentos. Si después corriges uno,
                la receta se corrige sola.
              </Text>
            </>
          )}
        </View>
      ) : null}

      {list.map((proposal) => (
        <ProposalRow
          key={proposal.entry.key}
          proposal={proposal}
          catalog={catalog}
          grams={grams[proposal.entry.key] ?? ''}
          label={labels[proposal.entry.key] ?? ''}
          mergeInto={mergeInto[proposal.entry.key] ?? null}
          onGrams={(value) => { setGrams((prev) => ({ ...prev, [proposal.entry.key]: value })); }}
          onLabel={(value) => { setLabels((prev) => ({ ...prev, [proposal.entry.key]: value })); }}
          onMergeInto={(food) => { setMergeInto((prev) => ({ ...prev, [proposal.entry.key]: food })); }}
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
  similar: {
    color: colors.navy, backgroundColor: colors.tealSoft, borderRadius: radius.sm,
    padding: spacing.sm, fontSize: 11, lineHeight: 16, marginTop: spacing.sm,
  },
  merge: { marginTop: spacing.sm },
  mergeRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginTop: spacing.xs },
  mergeButton: {
    minHeight: 44, justifyContent: 'center', paddingHorizontal: spacing.md,
    borderRadius: radius.sm, borderWidth: 1, borderColor: colors.teal, backgroundColor: colors.surface,
  },
  mergeButtonText: { color: colors.teal, fontSize: 12, fontWeight: '800' },
  mergeResult: { minHeight: 44, justifyContent: 'center', paddingVertical: spacing.sm, borderBottomWidth: 1, borderBottomColor: colors.line },
  mergeResultName: { color: colors.ink, fontSize: 14, fontWeight: '700' },
  mergeResultMeta: { color: colors.muted, fontSize: 11, marginTop: 2 },
  choices: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginTop: spacing.sm },
  choice: {
    minHeight: 44, justifyContent: 'center', paddingHorizontal: spacing.md,
    borderRadius: radius.sm, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface,
  },
  choiceOn: { borderColor: colors.teal, backgroundColor: colors.tealSoft },
  choiceText: { color: colors.muted, fontSize: 12, fontWeight: '700' },
  choiceTextOn: { color: colors.navy, fontWeight: '900' },
  block: {
    backgroundColor: colors.surface, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line,
    padding: spacing.md, marginTop: spacing.md,
  },
  blockTitle: { color: colors.ink, fontSize: 14, fontWeight: '800' },
  blockHint: { color: colors.muted, fontSize: 12, lineHeight: 17, marginTop: 4 },
  nameInput: {
    color: colors.ink, fontSize: 15, fontWeight: '700', backgroundColor: colors.background,
    borderRadius: radius.sm, borderColor: colors.line, borderWidth: 1,
    paddingHorizontal: spacing.md, paddingVertical: spacing.sm, marginTop: spacing.sm, minHeight: 44,
  },
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
