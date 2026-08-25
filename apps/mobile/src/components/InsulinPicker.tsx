import {
  findCatalogInsulin,
  insulinsByCategory,
  isPlausibleInsulinDuration,
  MAX_INSULIN_DURATION_HOURS,
  MIN_INSULIN_DURATION_HOURS,
  type InsulinCategory,
} from '@type1a/domain';
import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

import { colors, radius, spacing } from '../theme';

/**
 * Elegir qué insulina usa la persona, y cuánto dura.
 *
 * Compartido a propósito entre Ajustes y el flujo de primer uso: si fueran
 * dos formularios distintos, se irían separando (es exactamente lo que pasó
 * entre `EntryModal` y `MealEditModal`, documentado en la Fase 21).
 *
 * ── Qué NO es esto ────────────────────────────────────────────────────────
 *
 * La duración se usa **solo** para higiene de datos: decidir si había otra
 * dosis actuando dentro de la ventana de un episodio, y por lo tanto si ese
 * episodio entra o no a un promedio descriptivo. **No es insulina activa
 * (IOB)** y no alimenta ninguna calculadora de dosis — `AGENTS.md` prohíbe
 * IOB y dosificación automática en el MVP. La copia visible lo dice, porque
 * un campo que dice "cuánto dura tu insulina" invita justamente a la lectura
 * equivocada.
 *
 * ── Por qué nada viene preseleccionado ────────────────────────────────────
 *
 * `AGENTS.md`: "Never infer therapy parameters". La app no adivina qué
 * insulina usa alguien. Los números que muestra son **el dato de la ficha
 * técnica del fabricante**, no una estimación sobre esa persona, y se pueden
 * sobrescribir con lo que le haya dicho su equipo clínico.
 */
export interface InsulinSelection {
  id?: string | undefined;
  durationHours?: number | undefined;
}

const CATEGORY_COPY: Record<InsulinCategory, { title: string; help: string; accent: string; soft: string }> = {
  rapid: {
    title: 'Insulina rápida',
    help: 'La que te pones con las comidas y para corregir.',
    accent: colors.blue,
    soft: '#E5F1FA',
  },
  basal: {
    title: 'Insulina basal',
    help: 'La de acción prolongada, la de base del día.',
    accent: colors.navy,
    soft: '#E7EDF2',
  },
};

export function InsulinPicker({
  category,
  selection,
  onChange,
}: {
  category: InsulinCategory;
  selection: InsulinSelection;
  onChange: (next: InsulinSelection) => void;
}) {
  const copy = CATEGORY_COPY[category];
  const options = insulinsByCategory(category);
  const chosen = findCatalogInsulin(selection.id);
  const durationText = selection.durationHours === undefined ? '' : String(selection.durationHours);
  const durationInvalid =
    selection.durationHours !== undefined && !isPlausibleInsulinDuration(selection.durationHours);

  function select(id: string): void {
    // Al elegir una marca se trae SU duración de ficha técnica. Si la usuaria
    // la había editado a mano para otra marca, ese número no se arrastra: era
    // de otra insulina.
    if (selection.id === id) {
      onChange({});
      return;
    }
    onChange({ id, durationHours: findCatalogInsulin(id)?.durationHours });
  }

  return (
    <View style={styles.block}>
      <Text style={styles.title}>{copy.title}</Text>
      <Text style={styles.help}>{copy.help}</Text>

      {options.map((insulin) => {
        const active = insulin.id === selection.id;
        return (
          <Pressable
            key={insulin.id}
            onPress={() => { select(insulin.id); }}
            accessibilityRole="radio"
            accessibilityState={{ selected: active }}
            accessibilityLabel={`${insulin.brand}, ${insulin.generic}`}
            style={[styles.option, active && { borderColor: copy.accent, backgroundColor: copy.soft }]}
          >
            <View style={styles.optionCopy}>
              <Text style={[styles.optionBrand, active && { color: copy.accent }]}>{insulin.brand}</Text>
              <Text style={styles.optionGeneric}>{insulin.generic}</Text>
              <Text style={styles.optionNote}>{insulin.note}</Text>
            </View>
            {/*
              La selección NO se comunica solo con color (regla de
              UX_GUIDELINES y de las HIG): va la palabra "Elegida".
            */}
            {active ? <Text style={[styles.optionMark, { color: copy.accent }]}>Elegida</Text> : null}
          </Pressable>
        );
      })}

      {chosen === undefined ? (
        <Text style={styles.hint}>
          Sin elegir, la app no supone ninguna: los patrones se calculan igual, solo que sin descartar los
          tramos donde otra dosis pudo estar actuando.
        </Text>
      ) : (
        <>
          <View style={styles.durationRow}>
            <View style={styles.durationCopy}>
              <Text style={styles.durationLabel}>Cuánto dura</Text>
              <Text style={styles.durationFoot}>
                Viene de la ficha técnica de {chosen.brand}. Cámbialo solo si tu equipo clínico te indicó otro
                valor.
              </Text>
            </View>
            <View style={styles.durationInputWrap}>
              <TextInput
                value={durationText}
                onChangeText={(text) => {
                  const parsed = Number(text.replace(',', '.'));
                  onChange({
                    id: selection.id,
                    durationHours: text.trim() === '' || !Number.isFinite(parsed) ? undefined : parsed,
                  });
                }}
                keyboardType="decimal-pad"
                style={styles.durationInput}
                accessibilityLabel={`Duración de ${chosen.brand} en horas`}
              />
              <Text style={styles.durationUnit}>h</Text>
            </View>
          </View>
          {durationInvalid ? (
            <Text style={styles.error}>
              Ingresa entre {MIN_INSULIN_DURATION_HOURS} y {MAX_INSULIN_DURATION_HOURS} horas.
            </Text>
          ) : null}
        </>
      )}
    </View>
  );
}

/**
 * La aclaración de seguridad que acompaña al selector donde sea que se use.
 * Exportada aparte para que Ajustes la muestre una vez y no dos.
 */
export function InsulinPickerSafetyNote() {
  return (
    <View style={styles.safetyBox}>
      <Text style={styles.safetyText}>
        Esto sirve para leer mejor tus patrones: la app usa la duración para saber si otra dosis pudo estar
        actuando en un tramo, y en ese caso no lo promedia como si fuera limpio.{'\n\n'}
        Type 1A no calcula insulina activa ni la resta de ninguna dosis, y este dato no entra en ninguna
        calculadora. Las decisiones de insulina son siempre de tu equipo clínico.
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  block: { marginTop: spacing.lg },
  title: { color: colors.ink, fontSize: 16, fontWeight: '800' },
  help: { color: colors.muted, fontSize: 13, lineHeight: 19, marginTop: spacing.xs },
  option: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    minHeight: 44,
    borderWidth: 1,
    borderColor: colors.line,
    borderRadius: radius.md,
    backgroundColor: colors.surface,
    padding: spacing.md,
    marginTop: spacing.sm,
  },
  optionCopy: { flex: 1 },
  optionBrand: { color: colors.ink, fontSize: 15, fontWeight: '700' },
  optionGeneric: { color: colors.muted, fontSize: 13, marginTop: 1 },
  optionNote: { color: colors.muted, fontSize: 12, lineHeight: 17, marginTop: spacing.xs },
  optionMark: { fontSize: 12, fontWeight: '800', letterSpacing: 0.4 },
  hint: { color: colors.muted, fontSize: 12, lineHeight: 18, marginTop: spacing.sm },
  durationRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.md, marginTop: spacing.md },
  durationCopy: { flex: 1 },
  durationLabel: { color: colors.navy, fontSize: 13, fontWeight: '800' },
  durationFoot: { color: colors.muted, fontSize: 12, lineHeight: 17, marginTop: 1 },
  durationInputWrap: {
    flexDirection: 'row',
    alignItems: 'center',
    minWidth: 92,
    minHeight: 44,
    paddingHorizontal: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
  },
  durationInput: { flex: 1, color: colors.ink, fontSize: 20, fontWeight: '800', textAlign: 'right' },
  durationUnit: { color: colors.muted, fontSize: 14, marginLeft: spacing.xs },
  error: { color: colors.red, fontSize: 13, marginTop: spacing.sm },
  safetyBox: {
    backgroundColor: colors.warningSoft,
    borderRadius: radius.sm,
    padding: spacing.md,
    marginTop: spacing.lg,
  },
  safetyText: { color: colors.warning, fontSize: 13, lineHeight: 19 },
});

/**
 * Traduce lo elegido a los campos de `TherapyProfile`.
 *
 * Escribe los cuatro campos **siempre**, incluso en `undefined`. Es
 * deliberado: quien llama hace `{ ...profile, ...insulinProfileFields(...) }`,
 * y si acá se omitiera la clave al deseleccionar, el valor viejo del perfil
 * sobreviviría al spread y la insulina no se podría quitar nunca. Los tipos
 * del esquema incluyen `| undefined`, así que esto pasa
 * `exactOptionalPropertyTypes`.
 */
export function insulinProfileFields(rapid: InsulinSelection, basal: InsulinSelection): {
  rapidInsulinId: string | undefined;
  rapidInsulinDurationHours: number | undefined;
  basalInsulinId: string | undefined;
  basalInsulinDurationHours: number | undefined;
} {
  return {
    rapidInsulinId: rapid.id,
    rapidInsulinDurationHours: rapid.id === undefined ? undefined : rapid.durationHours,
    basalInsulinId: basal.id,
    basalInsulinDurationHours: basal.id === undefined ? undefined : basal.durationHours,
  };
}
