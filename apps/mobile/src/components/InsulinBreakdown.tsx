import { StyleSheet, Text, View } from 'react-native';

import { colors, radius, spacing } from '../theme';

/**
 * El desglose de una dosis calculada: de dónde salió cada unidad.
 *
 * ## Por qué existe
 *
 * Desde que la calculadora descuenta insulina activa (2026-09-02), el número
 * que propone **ya no se deduce de lo que está en pantalla**. Antes, con la
 * glucosa y el factor a la vista, cualquiera podía rehacer la cuenta de
 * cabeza; ahora hay un término que no se ve. Un total que baja sin decir por
 * qué es peor que uno que no baja: se lee como un error de la app justo en la
 * pantalla donde menos conviene dudar.
 *
 * Así que la resta se muestra entera, siempre, en los tres sitios que
 * calculan (`CorrectionModal`, `MealModal`, `UnifiedEntryModal`). Es la misma
 * regla que ya rige `MacroFields` y `MealAiFields`: lo que comparten, se
 * comparte — y acá además el texto es superficie de seguridad, no decoración.
 *
 * ## Lo que NO hace
 *
 * No calcula. Recibe números ya resueltos por `packages/domain` y los dibuja.
 * Un componente que sumara insulina sería un componente decidiendo una dosis.
 */

export function InsulinBreakdown({
  mealUnits,
  correctionUnits,
  activeInsulinUnits,
  activeInsulinAppliedUnits,
  activeDoseCount,
  totalUnits,
  /** Sin insulina configurada no hay curva y no se descuenta nada. */
  insulinConfigured,
  /**
   * Si el activo se **restó** de este total o solo se informa.
   *
   * El conteo por carbohidratos de `MealModal` no calcula corrección, así que
   * no hay de qué restar — pero saber que hay 3 U actuando igual cambia lo que
   * decides. Sin esta distinción el panel mostraba "5 U de comida, − 3 U
   * activas, total 5 U": tres números que no suman, en la pantalla donde menos
   * conviene desconfiar de la aritmética.
   */
  activeWasSubtracted = true,
}: {
  /** Ausente en la corrección suelta, donde no hay carbohidratos que cubrir. */
  mealUnits?: number | undefined;
  correctionUnits: number;
  /** `undefined` = no se sabe, que **no** es lo mismo que 0. */
  activeInsulinUnits: number | undefined;
  /**
   * Cuánto del activo se descontó **de verdad**. Puede ser menos que
   * `activeInsulinUnits`: el descuento se detiene cuando la corrección llega a
   * 0, porque la comida nunca se toca.
   *
   * Existe porque sin él la resta no cuadraba con el total y el panel parecía
   * un error de la app — mostraba "− 9 U" sobre un total que solo había
   * bajado 3. Omitido = se aplicó todo (la corrección suelta, donde el total
   * **es** la corrección).
   */
  activeInsulinAppliedUnits?: number | undefined;
  activeDoseCount: number;
  totalUnits: number;
  insulinConfigured: boolean;
  activeWasSubtracted?: boolean;
}) {
  const round = (value: number): string => String(Number(value.toFixed(2)));
  // Sin `activeInsulinAppliedUnits` (la corrección suelta) todo el activo se
  // aplicó: ahí el total **es** la corrección y no hay comida que proteger.
  const applied = activeInsulinAppliedUnits ?? activeInsulinUnits ?? 0;
  const unused = (activeInsulinUnits ?? 0) - applied;
  return (
    <View style={styles.box}>
      <Text style={styles.title}>De dónde sale este número</Text>

      {mealUnits === undefined ? null : (
        <Row label="Comida (carbohidratos)" value={`${round(mealUnits)} U`} />
      )}
      <Row label="Corrección (glucosa)" value={`${round(correctionUnits)} U`} />

      {activeInsulinUnits === undefined ? null : (
        <>
          <Row
            label={`Insulina todavía activa${activeDoseCount === 0 ? '' : ` · ${activeDoseCount} ${activeDoseCount === 1 ? 'dosis' : 'dosis'}`}${activeWasSubtracted ? '' : ' (informativo)'}`}
            value={activeWasSubtracted ? `− ${round(applied)} U` : `${round(activeInsulinUnits)} U`}
            emphasis
          />
          {unused <= 0.005 ? null : (
            // La línea que hace que la resta cuadre. Sin ella el panel muestra
            // "− 9 U" sobre un total que solo bajó 3 y parece un error.
            <Row
              label="No se descontó (tu comida no se toca)"
              value={`${round(unused)} U`}
            />
          )}
        </>
      )}

      <View style={styles.total}>
        <Text style={styles.totalLabel}>Total propuesto</Text>
        <Text style={styles.totalValue}>{round(totalUnits)} U</Text>
      </View>

      {activeInsulinUnits === undefined ? (
        // El caso que más importa decir: sin insulina elegida no hay curva, y
        // "no lo sé" nunca se convierte en "no queda nada actuando".
        <Text style={styles.note}>
          {insulinConfigured
            ? 'No se pudo calcular la insulina activa, así que no se descontó nada. Revisa tus dosis recientes antes de ponerte esta.'
            : 'No se descontó insulina activa porque todavía no elegiste tu insulina rápida en Ajustes → Terapia. Sin eso, si te corregiste hace poco este número puede quedar de más.'}
        </Text>
      ) : (
        <Text style={styles.note}>
          {activeDoseCount === 0
            ? 'No quedan dosis recientes actuando.'
            : activeWasSubtracted
              ? unused > 0.005
                ? 'Te sobra insulina activa, así que no hay corrección que poner. Los carbohidratos igual llevan su dosis completa: comer siempre pide insulina, corregir no siempre.'
                : 'La insulina activa se descuenta solo de la corrección: los carbohidratos siempre llevan su dosis completa.'
              : 'Este conteo cubre solo carbohidratos, así que no se le descontó nada: el total de arriba NO incluye esa resta. Se muestra porque, si vas a corregir además, esas unidades ya están actuando.'}
          {' '}Es una estimación sobre la duración que configuraste, no una medición. Revisa el número antes de inyectarte.
        </Text>
      )}
    </View>
  );
}

function Row({ label, value, emphasis = false }: { label: string; value: string; emphasis?: boolean }) {
  return (
    <View style={styles.row}>
      <Text style={[styles.rowLabel, emphasis && styles.rowLabelEmphasis]} numberOfLines={2}>{label}</Text>
      <Text style={[styles.rowValue, emphasis && styles.rowValueEmphasis]}>{value}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  box: {
    backgroundColor: colors.background, borderRadius: radius.md, borderWidth: 1, borderColor: colors.line,
    padding: spacing.md, marginTop: spacing.md,
  },
  title: { color: colors.navy, fontSize: 12, fontWeight: '900', letterSpacing: 0.4, marginBottom: spacing.sm },
  row: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'flex-start', gap: spacing.sm, marginTop: 4 },
  rowLabel: { flex: 1, color: colors.muted, fontSize: 13, lineHeight: 18 },
  rowLabelEmphasis: { color: colors.teal, fontWeight: '700' },
  rowValue: { color: colors.ink, fontSize: 14, fontWeight: '700' },
  rowValueEmphasis: { color: colors.teal, fontWeight: '900' },
  total: {
    flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline',
    borderTopWidth: 1, borderTopColor: colors.line, marginTop: spacing.sm, paddingTop: spacing.sm,
  },
  totalLabel: { color: colors.ink, fontSize: 14, fontWeight: '800' },
  totalValue: { color: colors.ink, fontSize: 20, fontWeight: '900' },
  note: { color: colors.muted, fontSize: 11, lineHeight: 16, marginTop: spacing.sm },
});
