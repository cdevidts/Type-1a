import { StyleSheet, Text, TextInput, View } from 'react-native';

import { colors, radius, spacing } from '../theme';

/**
 * El campo numérico de esta app, y el trío de macros que se repetía en los
 * cuatro formularios de comida.
 *
 * ## Por qué existe
 *
 * Proteína/grasa/fibra estaba escrito **seis veces**: `EntryModal`,
 * `MealModal`, `MealEditModal` y **dos veces** dentro de
 * `TimelineDetailModal` (un bloque de 24 líneas duplicado literalmente entre
 * sus dos ramas). Con cuatro `Field` locales distintos y tres variantes
 * visuales del mismo input.
 *
 * El costo no era estético: cada mejora había que hacerla cuatro veces y
 * siempre se olvidaba una. La Fase 21 existió entera porque editar había
 * quedado más pobre que crear, y los macros vivían en un solo camino.
 *
 * ## Lo que se corrigió al unificar
 *
 * `MealEditModal` tenía sus inputs en `fontSize: 16` + `paddingVertical:
 * spacing.sm` — **unos 32 pt de alto tocable, bajo el mínimo de 44** que exige
 * `contracts/ux-checklist.md`. La variante compacta de acá llega a 44 con
 * `minHeight` explícito en vez de depender del padding.
 *
 * ## Lo que NO hace
 *
 * No parsea ni valida: devuelve texto. El "en blanco no es 0 g" lo resuelven
 * `parseBlankAsUnset` / `parseBlankAsClear` en `format.ts`, y la procedencia,
 * `resolveMacrosSource` en `packages/domain`. Un componente de formulario no
 * decide nada que llegue al reporte médico.
 */

export type MacroField = 'protein' | 'fat' | 'fiber' | 'calories';

export function NumericField({
  label,
  value,
  unit,
  onChange,
  placeholder = '—',
  compact = false,
  accessibilityLabel,
}: {
  label: string;
  value: string;
  unit: string;
  onChange: (next: string) => void;
  placeholder?: string;
  /** Trío en fila dentro de un bloque plegable, en vez de campo a lo ancho. */
  compact?: boolean;
  accessibilityLabel?: string;
}) {
  return (
    <View style={compact ? styles.compactField : styles.field}>
      <Text style={compact ? styles.compactLabel : styles.label}>{label}</Text>
      <View style={styles.inputWrap}>
        <TextInput
          value={value}
          onChangeText={onChange}
          keyboardType="decimal-pad"
          style={compact ? styles.compactInput : styles.input}
          placeholder={placeholder}
          placeholderTextColor={colors.muted}
          selectTextOnFocus
          accessibilityLabel={accessibilityLabel ?? `${label} en ${unit}`}
        />
        {/* La unidad va pegada al campo, no solo en el label de arriba. */}
        <Text style={styles.unit}>{unit}</Text>
      </View>
    </View>
  );
}

export function MacroFields({
  protein,
  fat,
  fiber,
  calories,
  onChange,
  hint,
  layout = 'row',
  placeholder,
}: {
  protein: string;
  fat: string;
  fiber: string;
  /** Solo `MealEditModal` las edita; omitir deja el trío. */
  calories?: string | undefined;
  onChange: (field: MacroField, next: string) => void;
  /**
   * Qué decirle a la usuaria. Cambia según si la IA los precargó, así que lo
   * decide quien llama — pero **nunca se omite**: sin él, un campo vacío se
   * lee como "cero gramos", que es justo lo que no es.
   */
  hint: string;
  /** `'row'` para el trío compacto; `'stacked'` para campos a lo ancho. */
  layout?: 'row' | 'stacked';
  placeholder?: string;
}) {
  const compact = layout === 'row';
  const common = { compact, ...(placeholder === undefined ? {} : { placeholder }) };
  return (
    <View>
      <View style={compact ? styles.row : undefined}>
        <NumericField label="Proteína" unit="g" value={protein} onChange={(next) => { onChange('protein', next); }} {...common} />
        <NumericField label="Grasa" unit="g" value={fat} onChange={(next) => { onChange('fat', next); }} {...common} />
        <NumericField label="Fibra" unit="g" value={fiber} onChange={(next) => { onChange('fiber', next); }} {...common} />
      </View>
      {calories === undefined ? null : (
        <NumericField label="Calorías" unit="kcal" value={calories} onChange={(next) => { onChange('calories', next); }} compact={compact} {...(placeholder === undefined ? {} : { placeholder })} />
      )}
      <Text style={styles.hint}>{hint}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  field: { flex: 1, marginTop: spacing.md },
  label: { color: colors.navy, fontSize: 12, fontWeight: '800' },
  compactField: { flex: 1, marginTop: spacing.sm },
  compactLabel: { color: colors.muted, fontSize: 11, fontWeight: '700', marginBottom: spacing.xs },
  inputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: colors.surface,
    borderRadius: radius.sm,
    borderColor: colors.line,
    borderWidth: 1,
    marginTop: 6,
    paddingHorizontal: spacing.md,
  },
  // `minHeight` explícito y no "el padding alcanza": el mínimo de 44 pt es del
  // área tocable, y confiarlo al alto de la fuente fue lo que dejó los campos
  // de `MealEditModal` en unos 32.
  input: { color: colors.ink, fontSize: 20, fontWeight: '700', flex: 1, paddingVertical: spacing.md, minHeight: 44 },
  compactInput: { color: colors.ink, fontSize: 15, flex: 1, paddingVertical: spacing.sm, minHeight: 44 },
  unit: { color: colors.muted, fontSize: 12, marginLeft: spacing.xs },
  row: { flexDirection: 'row', gap: spacing.sm },
  hint: { color: colors.muted, fontSize: 11, lineHeight: 16, marginTop: 6 },
});
