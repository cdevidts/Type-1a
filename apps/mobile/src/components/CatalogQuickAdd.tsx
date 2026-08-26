import { useState } from 'react';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import {
  isValidServings,
  MAX_SERVINGS,
  MIN_SERVINGS,
  scaleCatalogFood,
  scaleCatalogFoodByServings,
  servingGramsOf,
  type CatalogFood,
} from '@type1a/domain';

import { colors, radius, spacing } from '../theme';

/**
 * El agregado rápido desde el catálogo: elegir un alimento ya conocido y decir
 * cuánto se comió.
 *
 * ## Por qué existe
 *
 * Vivía dentro de `MealModal`, así que **solo el acceso rápido de comida lo
 * tenía**. La sección de comida del Modal Maestro sabía sacar foto, analizar
 * por texto y anotar macros, pero no podía reusar un alimento guardado: para
 * eso había que salir y entrar por el otro botón. Es exactamente la asimetría
 * que `projectbrief.md` prohíbe — un flujo que sabe menos que otro.
 *
 * Se **movió**, no se reescribió. Es el mismo bloque, con el mismo escalado,
 * los mismos límites de porción y los mismos textos.
 *
 * ## Qué encapsula y qué no
 *
 * Encapsula la elección (qué alimento, en porciones o en gramos) y devuelve el
 * resultado escalado. **No decide nada de lo que se guarda**: quien lo monta
 * recibe los gramos y decide qué hacer con ellos. En particular, los
 * carbohidratos que salen de acá son una **sugerencia** —el catálogo es una
 * media de estimaciones de IA— y nunca se escriben solos como confirmados.
 */

export interface CatalogPortion {
  food: CatalogFood;
  /** Gramos que se comieron, ya resueltos desde porciones o desde gramos. */
  grams: number;
  /** Escalado a esos gramos. Los carbos son sugerencia, no confirmación. */
  carbsG: number;
  proteinG: number;
  fatG: number;
  fiberG: number;
}

export function CatalogQuickAdd({
  foods,
  onApply,
  onMessage,
}: {
  foods: readonly CatalogFood[];
  onApply: (portion: CatalogPortion) => void;
  /** Errores de porción y la confirmación de lo aplicado, en el mensaje del modal anfitrión. */
  onMessage: (message: string) => void;
}) {
  const [pendingFood, setPendingFood] = useState<CatalogFood | null>(null);
  const [portionInput, setPortionInput] = useState('');
  /**
   * En qué unidad se pide la porción. Pensar en "dos tazas" es más fácil que
   * en "300 gramos", pero quien pesa en balanza no debería tener que dividir
   * mentalmente — por eso las dos puertas quedan abiertas y no se elige una.
   */
  const [portionMode, setPortionMode] = useState<'servings' | 'grams'>('servings');

  function apply(): void {
    if (pendingFood === null) return;
    const typed = Number(portionInput.trim().replace(',', '.'));
    if (!Number.isFinite(typed) || typed <= 0) {
      onMessage(portionMode === 'servings'
        ? `Escribe cuántas porciones comiste, entre ${MIN_SERVINGS} y ${MAX_SERVINGS}.`
        : 'Escribe cuántos gramos comiste.');
      return;
    }
    if (portionMode === 'servings' && !isValidServings(typed)) {
      onMessage(`Las porciones van de ${MIN_SERVINGS} a ${MAX_SERVINGS}.`);
      return;
    }
    const grams = portionMode === 'servings' ? typed * servingGramsOf(pendingFood) : typed;
    const scaled = portionMode === 'servings'
      ? scaleCatalogFoodByServings(pendingFood, typed)
      : scaleCatalogFood(pendingFood, grams);
    onApply({ food: pendingFood, grams, carbsG: scaled.carbsG, proteinG: scaled.proteinG, fatG: scaled.fatG, fiberG: scaled.fiberG });
    onMessage(`${pendingFood.name}, ${grams.toFixed(0)} g: ≈ ${scaled.carbsG} g de carbohidratos. Escríbelos abajo si los confirmas.`);
    setPendingFood(null);
  }

  if (foods.length === 0 && pendingFood === null) return null;

  if (pendingFood === null) {
    return (
      <View style={styles.catalogBox}>
        <Text style={styles.catalogTitle}>Lo que sueles comer</Text>
        <Text style={styles.catalogHint}>
          Alimentos que la IA ya reconoció antes. Tócalos para reusar su estimación sin gastar otra foto.
        </Text>
        <View style={styles.catalogRow}>
          {foods.map((food) => (
            <Pressable
              key={food.key}
              style={styles.catalogChip}
              onPress={() => { setPendingFood(food); setPortionInput(''); }}
              accessibilityRole="button"
              accessibilityLabel={`Reusar ${food.name}`}
            >
              <Text style={styles.catalogChipName}>{food.name}</Text>
              <Text style={styles.catalogChipMeta}>
                {food.carbsPer100g.toFixed(0)} g carbos/100 g · porción {servingGramsOf(food).toFixed(0)} g
              </Text>
            </Pressable>
          ))}
        </View>
      </View>
    );
  }

  return (
    <View style={styles.catalogBox}>
      <Text style={styles.catalogTitle}>{pendingFood.name}</Text>
      <Text style={styles.catalogHint}>
        {portionMode === 'servings'
          ? `¿Cuántas porciones comiste? Una porción son ${servingGramsOf(pendingFood).toFixed(0)} g${pendingFood.servingLabel === undefined ? '' : ` (${pendingFood.servingLabel})`}.`
          : '¿Cuántos gramos comiste? Se escala desde la estimación guardada.'}
      </Text>
      <View style={styles.unitToggle}>
        <Pressable
          style={[styles.unitOption, portionMode === 'servings' && styles.unitOptionActive]}
          onPress={() => { setPortionMode('servings'); setPortionInput(''); }}
          accessibilityRole="button"
          accessibilityState={{ selected: portionMode === 'servings' }}
        >
          <Text style={[styles.unitOptionText, portionMode === 'servings' && styles.unitOptionTextActive]}>Porciones</Text>
        </Pressable>
        <Pressable
          style={[styles.unitOption, portionMode === 'grams' && styles.unitOptionActive]}
          onPress={() => { setPortionMode('grams'); setPortionInput(''); }}
          accessibilityRole="button"
          accessibilityState={{ selected: portionMode === 'grams' }}
        >
          <Text style={[styles.unitOptionText, portionMode === 'grams' && styles.unitOptionTextActive]}>Gramos</Text>
        </Pressable>
      </View>
      <View style={styles.portionRow}>
        <TextInput
          value={portionInput}
          onChangeText={setPortionInput}
          keyboardType="decimal-pad"
          style={styles.portionInput}
          placeholder={portionMode === 'servings' ? `${MIN_SERVINGS} a ${MAX_SERVINGS}` : 'gramos'}
          placeholderTextColor={colors.muted}
          accessibilityLabel={portionMode === 'servings' ? 'Cuántas porciones' : 'Porción en gramos'}
        />
        <Pressable style={styles.portionButton} onPress={() => { apply(); }} accessibilityRole="button">
          <Text style={styles.portionButtonText}>Usar</Text>
        </Pressable>
        <Pressable style={styles.portionCancel} onPress={() => { setPendingFood(null); }} accessibilityRole="button">
          <Text style={styles.portionCancelText}>Cancelar</Text>
        </Pressable>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  catalogBox: { backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.md, marginTop: spacing.md },
  catalogTitle: { color: colors.ink, fontSize: 14, fontWeight: '800' },
  catalogHint: { color: colors.muted, fontSize: 11, lineHeight: 16, marginTop: 2, marginBottom: spacing.sm },
  catalogRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  catalogChip: {
    borderColor: colors.line, borderWidth: 1, borderRadius: radius.sm,
    paddingVertical: spacing.sm, paddingHorizontal: spacing.md, minHeight: 44, justifyContent: 'center',
  },
  catalogChipName: { color: colors.ink, fontSize: 13, fontWeight: '700' },
  catalogChipMeta: { color: colors.muted, fontSize: 10, marginTop: 1 },
  unitToggle: { flexDirection: 'row', gap: spacing.xs, marginBottom: spacing.sm },
  unitOption: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: spacing.lg,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
  },
  unitOptionActive: { backgroundColor: colors.tealSoft, borderColor: colors.teal },
  unitOptionText: { fontSize: 13, fontWeight: '600', color: colors.muted },
  unitOptionTextActive: { color: colors.teal },
  portionRow: { flexDirection: 'row', gap: spacing.sm, alignItems: 'center' },
  portionInput: {
    flex: 1, minHeight: 44, backgroundColor: colors.background, borderRadius: radius.sm,
    borderColor: colors.line, borderWidth: 1, color: colors.ink, fontSize: 15, paddingHorizontal: spacing.md,
  },
  portionButton: {
    minHeight: 44, paddingHorizontal: spacing.lg, alignItems: 'center', justifyContent: 'center',
    borderRadius: radius.sm, backgroundColor: colors.teal,
  },
  portionButtonText: { color: '#FFFFFF', fontSize: 14, fontWeight: '800' },
  portionCancel: { minHeight: 44, paddingHorizontal: spacing.md, alignItems: 'center', justifyContent: 'center' },
  portionCancelText: { color: colors.muted, fontSize: 13, fontWeight: '700' },
});
