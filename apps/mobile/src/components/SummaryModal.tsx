import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View } from 'react-native';

import {
  buildAmbulatoryProfile,
  buildNutritionInsights,
  MIN_SAMPLE_FOR_RATE,
  summarizeGlucose,
  type MealWindowInsight,
} from '@type1a/domain';
import type { CGMReading } from '@type1a/schemas';

import { logSaveError } from '../log';
import { colors, glucoseBands, radius, spacing } from '../theme';
import type { SummaryData } from '../types';
import { ErrorBoundary } from './ErrorBoundary';
import { ModalShell } from './ModalShell';
import { AgpChart, AgpLegend, DayGlucoseChart, isNonSensorReading, RangeBar } from './SummaryCharts';

/**
 * Pantalla "Resumen" (Fase 11 + parte descriptiva de la Fase 12). Tres
 * sub-páginas, en el mismo orden que un reporte AGP clínico estándar
 * (estadísticas → perfil de 24 h → días individuales), reordenado para
 * móvil: primero los días, después las métricas, después los patrones.
 *
 * Todo el cálculo vive en `packages/domain` (`glucose-metrics`, `agp`,
 * `nutrition-insights`); este archivo solo elige rango, formatea y dibuja.
 * Nada de esto sugiere ni ajusta dosis — ver la frontera de seguridad
 * documentada en `nutrition-insights.ts`.
 */

type SummaryTab = 'days' | 'metrics' | 'food';

const TABS: { key: SummaryTab; label: string }[] = [
  { key: 'days', label: 'Días' },
  { key: 'metrics', label: 'Métricas' },
  { key: 'food', label: 'Comidas' },
];

/**
 * Un solo rango para toda la pantalla, como en los reportes de CGM
 * (LibreView/Clarity): el período de reporte es uno, no uno por gráfico.
 * 14 días es el mínimo de consenso para que la HbA1c estimada y el AGP
 * sean representativos, por eso es el valor por defecto.
 */
const RANGE_OPTIONS = [7, 14, 30, 90] as const;
const DEFAULT_RANGE_DAYS = 14;
/** Días individuales a dibujar como máximo, para no montar 90 gráficos. */
const MAX_DAY_CHARTS = 30;

function dayKey(isoTimestamp: string): string {
  const date = new Date(isoTimestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function formatDayHeading(isoTimestamp: string): string {
  return new Intl.DateTimeFormat('es-CL', { weekday: 'long', day: '2-digit', month: 'long' })
    .format(new Date(isoTimestamp));
}

function formatWindowHours(startHour: number, endHour: number): string {
  return `${String(startHour).padStart(2, '0')}:00–${String(endHour % 24).padStart(2, '0')}:00`;
}

export function SummaryModal({
  visible,
  onClose,
  onLoadSummary,
}: {
  visible: boolean;
  onClose: () => void;
  onLoadSummary: (range: { from: Date; to: Date }) => Promise<SummaryData>;
}) {
  const { width } = useWindowDimensions();
  const [tab, setTab] = useState<SummaryTab>('days');
  const [rangeDays, setRangeDays] = useState<number>(DEFAULT_RANGE_DAYS);
  const [data, setData] = useState<SummaryData | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  // `SummaryModal` nunca se desmonta (se renderiza siempre, con `visible`
  // alternando), así que `rangeDays` y `failed` sobreviven a cerrar y volver
  // a abrir el modal. Por eso el mensaje viejo ("cierra y vuelve a abrir el
  // resumen") no podía funcionar: al reabrir se reintentaba exactamente el
  // mismo rango que ya había fallado, y solo cerrar la app entera —que
  // reinicia el estado a 14 días— lo "arreglaba". Este contador da una
  // salida real: reintentar el mismo rango sin depender del ciclo de vida
  // del modal. Ver `docs/ROADMAP_V0.2.md` § Fase 13, ítem 5.
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    const to = new Date();
    const from = new Date(to.getTime() - rangeDays * 24 * 60 * 60_000);
    onLoadSummary({ from, to })
      .then((loaded) => {
        if (!cancelled) setData(loaded);
      })
      .catch((error: unknown) => {
        logSaveError('SummaryModal.load', error);
        if (!cancelled) {
          setData(null);
          setFailed(true);
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [visible, rangeDays, onLoadSummary, reloadToken]);

  const summary = useMemo(() => (data === null ? null : summarizeGlucose(data.readings)), [data]);
  const profile = useMemo(() => (data === null ? null : buildAmbulatoryProfile(data.readings)), [data]);
  const insights = useMemo(() => (data === null ? [] : buildNutritionInsights(data)), [data]);

  // Días individuales, del más reciente al más antiguo. Las lecturas
  // sintéticas se excluyen del todo — un día "de mentira" no se grafica ni
  // atenuado (misma regla que el reporte PDF y `summarizeGlucose`).
  const days = useMemo(() => {
    if (data === null) return [];
    const buckets = new Map<string, CGMReading[]>();
    for (const reading of data.readings) {
      if (reading.origin === 'synthetic') continue;
      const key = dayKey(reading.sourceTimestamp);
      const list = buckets.get(key);
      if (list) list.push(reading);
      else buckets.set(key, [reading]);
    }
    return [...buckets.entries()]
      .sort(([a], [b]) => (a < b ? 1 : -1))
      .slice(0, MAX_DAY_CHARTS)
      .map(([key, readings]) => ({ key, readings }));
  }, [data]);

  const chartWidth = Math.max(240, width - spacing.lg * 2 - spacing.md * 2);

  return (
    <ModalShell visible={visible} title="Resumen" onClose={onClose} scroll={false}>
      <View style={styles.tabBar}>
        {TABS.map((entry) => {
          const active = entry.key === tab;
          return (
            <Pressable
              key={entry.key}
              style={[styles.tab, active && styles.tabActive]}
              onPress={() => { setTab(entry.key); }}
              accessibilityRole="tab"
              accessibilityState={{ selected: active }}
            >
              <Text style={[styles.tabLabel, active && styles.tabLabelActive]}>{entry.label}</Text>
            </Pressable>
          );
        })}
      </View>

      <View style={styles.rangeRow}>
        {RANGE_OPTIONS.map((days_) => {
          const active = days_ === rangeDays;
          return (
            <Pressable
              key={days_}
              style={[styles.rangeChip, active && styles.rangeChipActive]}
              onPress={() => { setRangeDays(days_); }}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
            >
              <Text style={[styles.rangeChipText, active && styles.rangeChipTextActive]}>{days_} días</Text>
            </Pressable>
          );
        })}
      </View>

      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator color={colors.teal} />
          <Text style={styles.mutedText}>Leyendo tu historial…</Text>
        </View>
      ) : failed ? (
        <View style={styles.centered}>
          <Text style={styles.emptyTitle}>No se pudo leer el historial</Text>
          <Text style={styles.mutedText}>
            Falló la lectura de los últimos {rangeDays} días. Tus registros están intactos: esto solo afecta a
            esta pantalla.
          </Text>
          <Pressable
            style={styles.retryButton}
            onPress={() => { setReloadToken((token) => token + 1); }}
            accessibilityRole="button"
            accessibilityLabel="Reintentar"
          >
            <Text style={styles.retryButtonText}>Reintentar</Text>
          </Pressable>
          {rangeDays > RANGE_OPTIONS[0] ? (
            <Text style={styles.mutedText}>
              Si vuelve a fallar, prueba con un rango más corto — puede haber un registro ilegible en la parte
              más antigua del historial.
            </Text>
          ) : null}
        </View>
      ) : (
        // Una excepción durante el render (no dentro del `await`, que ya
        // tiene su `.catch`) desmontaría la app entera sin esta frontera.
        <ErrorBoundary
          title="No se pudo dibujar el resumen"
          body={`Algo en los últimos ${rangeDays} días no se pudo interpretar. Prueba con un rango más corto.`}
          onReset={() => { setReloadToken((token) => token + 1); }}
        >
          <ScrollView contentContainerStyle={styles.scrollBody}>
            {/*
              Si se descartaron filas ilegibles, hay que decirlo antes de
              cualquier número: un TIR o una HbA1c estimada sobre una muestra
              recortada en silencio es un número inventado, no un dato
              omitido. Ver `DecodeTally` en `db.ts`.
            */}
            {data !== null && data.unreadableCount > 0 ? (
              <View style={styles.integrityBox}>
                <Text style={styles.integrityText}>
                  {data.unreadableCount} registro(s) de este rango no se pudieron leer y quedaron fuera. Las
                  métricas de abajo están calculadas sin ellos.
                </Text>
              </View>
            ) : null}
            {tab === 'days' ? <DaysTab days={days} chartWidth={chartWidth} rangeDays={rangeDays} /> : null}
            {tab === 'metrics' ? (
              <MetricsTab summary={summary} profile={profile} chartWidth={chartWidth} rangeDays={rangeDays} />
            ) : null}
            {tab === 'food' ? <FoodTab insights={insights} rangeDays={rangeDays} /> : null}
          </ScrollView>
        </ErrorBoundary>
      )}
    </ModalShell>
  );
}

function EmptyState({ title, body }: { title: string; body: string }) {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.mutedText}>{body}</Text>
    </View>
  );
}

function DaysTab({
  days,
  chartWidth,
  rangeDays,
}: {
  days: { key: string; readings: CGMReading[] }[];
  chartWidth: number;
  rangeDays: number;
}) {
  if (days.length === 0) {
    return (
      <EmptyState
        title="Sin días para mostrar"
        body={`No hay lecturas de glucosa reales, manuales ni importadas en los últimos ${rangeDays} días. Registra una glucosa o importa tu historial desde Ajustes.`}
      />
    );
  }
  return (
    <View>
      <Text style={styles.tabIntro}>
        Un gráfico por día, de las 00:00 a las 24:00. La franja celeste es el rango objetivo 70–180 mg/dL.
        Los puntos huecos con línea punteada no vienen del sensor: son lecturas manuales o historial importado.
      </Text>
      {days.map((day) => {
        const daySummary = summarizeGlucose(day.readings);
        return (
          <View key={day.key} style={styles.card}>
            <View style={styles.cardHeader}>
              <Text style={styles.cardTitle}>{formatDayHeading(day.readings[0]!.sourceTimestamp)}</Text>
              {daySummary === null ? null : (
                <Text style={styles.cardMeta}>
                  {daySummary.range.targetPct.toFixed(0)}% en rango · {daySummary.readingCount} lecturas
                  {day.readings.some(isNonSensorReading) ? ' · incluye manual/importado' : ''}
                </Text>
              )}
            </View>
            <DayGlucoseChart readings={day.readings} width={chartWidth} />
          </View>
        );
      })}
    </View>
  );
}

function StatTile({ value, label, hint }: { value: string; label: string; hint?: string }) {
  return (
    <View style={styles.statTile}>
      <Text style={styles.statValue}>{value}</Text>
      <Text style={styles.statLabel}>{label}</Text>
      {hint === undefined ? null : <Text style={styles.statHint}>{hint}</Text>}
    </View>
  );
}

function MetricsTab({
  summary,
  profile,
  chartWidth,
  rangeDays,
}: {
  summary: ReturnType<typeof summarizeGlucose>;
  profile: ReturnType<typeof buildAmbulatoryProfile>;
  chartWidth: number;
  rangeDays: number;
}) {
  if (summary === null) {
    return (
      <EmptyState
        title="Sin datos para calcular métricas"
        body={`No hay lecturas de glucosa reales, manuales ni importadas en los últimos ${rangeDays} días. Las lecturas sintéticas del modo de desarrollo nunca entran en estos números.`}
      />
    );
  }
  return (
    <View>
      <View style={styles.statRow}>
        <StatTile value={`${summary.estimatedA1cPct.toFixed(1)}%`} label="HbA1c estimada" hint="GMI, no laboratorio" />
        <StatTile value={`${summary.meanGlucoseMgDl.toFixed(0)}`} label="Promedio" hint="mg/dL" />
      </View>
      <View style={styles.statRow}>
        <StatTile value={`${summary.range.targetPct.toFixed(0)}%`} label="Tiempo en rango" hint="meta >70%" />
        <StatTile value={`${summary.coefficientOfVariationPct.toFixed(0)}%`} label="Variabilidad (CV)" hint="meta ≤36%" />
      </View>

      <Text style={styles.sectionTitle}>Distribución del tiempo</Text>
      <View style={styles.card}>
        <RangeBar range={summary.range} />
      </View>

      <Text style={styles.sectionTitle}>Día promedio ponderado</Text>
      <Text style={styles.tabIntro}>
        Cómo se ve un día cualquiera tuyo: todas las lecturas de los últimos {rangeDays} días superpuestas
        sobre 24 horas. La línea es la mediana; las franjas, dónde cayó la mayoría de tus valores a esa hora.
        Es el formato estándar de los reportes de CGM (perfil ambulatorio, AGP).
      </Text>
      {profile === null || profile.buckets.length === 0 ? (
        <EmptyState title="Sin perfil todavía" body="Hacen falta lecturas repartidas en el día para dibujar el perfil promedio." />
      ) : (
        <View style={styles.card}>
          <AgpChart profile={profile} width={chartWidth} />
          <AgpLegend />
        </View>
      )}

      <View style={styles.noteBox}>
        <Text style={styles.noteTitle}>Cómo leer estos números</Text>
        <Text style={styles.noteText}>
          La HbA1c estimada (GMI) la calcula esta app desde tu promedio de glucosa sobre {summary.readingCount} lecturas
          en {summary.daysCovered} día(s). No reemplaza una HbA1c de laboratorio, que mide algo distinto y puede
          diferir. Las metas indicadas son las de consenso internacional para diabetes tipo 1, no un objetivo
          personal: ese lo define tu equipo clínico.
        </Text>
        {summary.daysCovered < 14 ? (
          <Text style={styles.noteWarning}>
            Cobertura de {summary.daysCovered} día(s): con menos de 14 días la HbA1c estimada y el día promedio
            son poco representativos.
          </Text>
        ) : null}
        {summary.excludedSyntheticCount > 0 ? (
          <Text style={styles.noteWarning}>
            Se excluyeron {summary.excludedSyntheticCount} lectura(s) sintética(s) del modo de desarrollo.
          </Text>
        ) : null}
      </View>
    </View>
  );
}

function FoodTab({ insights, rangeDays }: { insights: MealWindowInsight[]; rangeDays: number }) {
  const hasAnything = insights.some(
    (window) => window.mealCount > 0 || window.rapidDoseCount > 0 || window.confirmedCarbsSampleSize > 0,
  );
  if (!hasAnything) {
    return (
      <EmptyState
        title="Sin registros de comida o insulina"
        body={`No hay comidas, carbohidratos ni insulina registrados en los últimos ${rangeDays} días. Estos patrones aparecen solos a medida que registras.`}
      />
    );
  }
  return (
    <View>
      <Text style={styles.tabIntro}>
        Qué sueles comer y ponerte en cada franja del día, y dónde estaba tu glucosa 1, 2 y 3 horas después
        de una dosis rápida — por debajo, dentro o por encima del rango objetivo.
      </Text>

      {insights.map((window) => (
        <View key={window.key} style={styles.card}>
          <View style={styles.cardHeader}>
            <Text style={styles.cardTitle}>{window.label}</Text>
            <Text style={styles.cardMeta}>{formatWindowHours(window.startHour, window.endHour)}</Text>
          </View>

          <View style={styles.foodStatsRow}>
            <FoodStat
              value={window.avgConfirmedCarbsG === undefined ? '—' : `${window.avgConfirmedCarbsG.toFixed(0)} g`}
              label="Carbos confirmados"
              meta={window.confirmedCarbsSampleSize > 0 ? `promedio de ${window.confirmedCarbsSampleSize}` : 'sin registros'}
            />
            <FoodStat
              value={window.avgRapidUnits === undefined ? '—' : `${window.avgRapidUnits.toFixed(1)} U`}
              label="Insulina rápida"
              meta={window.rapidDoseCount > 0 ? `promedio de ${window.rapidDoseCount}` : 'sin registros'}
            />
            <FoodStat
              value={window.avgBasalUnits === undefined ? '—' : `${window.avgBasalUnits.toFixed(1)} U`}
              label="Insulina basal"
              meta={window.basalDoseCount > 0 ? `promedio de ${window.basalDoseCount}` : 'sin registros'}
            />
          </View>

          <Text style={styles.outcomeHeading}>Dónde estaba tu glucosa después de una rápida</Text>
          {window.outcomes.map((outcome) => (
            <View key={outcome.horizonHours}>
              <View style={styles.outcomeRow}>
                <Text style={styles.outcomeHorizon}>{outcome.horizonHours} h</Text>
                {outcome.inTargetPct === undefined ? (
                  <>
                    <View style={styles.outcomeTrackEmpty} />
                    <Text style={styles.outcomeInsufficient}>
                      {outcome.sampleSize === 0
                        ? 'sin datos'
                        : `n=${outcome.sampleSize}, faltan ${MIN_SAMPLE_FOR_RATE - outcome.sampleSize}`}
                    </Text>
                  </>
                ) : (
                  <>
                    {/* Tres segmentos, no una sola barra "de logro": un único
                        % en rango junto al promedio de insulina de la franja
                        invita a leer "poco = me falta insulina" cuando los
                        fallos pueden haber sido hipoglucemias. La dirección
                        del fallo es justamente lo que no se puede perder. */}
                    <View style={styles.outcomeTrack}>
                      {outcome.belowTargetPct! > 0 ? (
                        <View style={{ width: `${outcome.belowTargetPct!}%`, backgroundColor: glucoseBands.low }} />
                      ) : null}
                      {outcome.inTargetPct > 0 ? (
                        <View style={{ width: `${outcome.inTargetPct}%`, backgroundColor: glucoseBands.target }} />
                      ) : null}
                      {outcome.aboveTargetPct! > 0 ? (
                        <View style={{ width: `${outcome.aboveTargetPct!}%`, backgroundColor: glucoseBands.high }} />
                      ) : null}
                    </View>
                    <Text style={styles.outcomeValue}>
                      {outcome.inTargetPct.toFixed(0)}% <Text style={styles.outcomeSample}>n={outcome.sampleSize}</Text>
                    </Text>
                  </>
                )}
              </View>
              {outcome.inTargetPct === undefined ? null : (
                <Text style={styles.outcomeBreakdown}>
                  Bajo {outcome.belowTargetPct!.toFixed(0)}% · En rango {outcome.inTargetPct.toFixed(0)}% ·
                  {' '}Alto {outcome.aboveTargetPct!.toFixed(0)}%
                </Text>
              )}
            </View>
          ))}
        </View>
      ))}

      <View style={styles.noteBox}>
        <Text style={styles.noteTitle}>Qué es y qué no es esto</Text>
        <Text style={styles.noteText}>
          Es una descripción de lo que ya pasó: de las dosis rápidas que registraste en esa franja, dónde estaba
          tu glucosa una, dos y tres horas después — separando por debajo de 70, en rango 70–180, y por encima de
          180 mg/dL. Se muestran los tres, no solo el "en rango", porque quedar fuera de rango por abajo y por
          arriba son cosas opuestas. No mide si una dosis fue correcta, ni sugiere cambiarla: la glucosa a esa hora
          también depende de la comida, la actividad, el estrés, la basal y el sitio de inyección.
        </Text>
        <Text style={styles.noteWarning}>
          Type 1A nunca calcula ni recomienda insulina. Cualquier cambio de dosis o de parámetros se decide con tu
          equipo clínico.
        </Text>
        <Text style={styles.noteText}>
          Los porcentajes solo aparecen con al menos {MIN_SAMPLE_FOR_RATE} dosis en la franja — con menos, el número
          sería ruido y no un patrón.
        </Text>
      </View>
    </View>
  );
}

function FoodStat({ value, label, meta }: { value: string; label: string; meta: string }) {
  return (
    <View style={styles.foodStat}>
      <Text style={styles.foodStatValue}>{value}</Text>
      <Text style={styles.foodStatLabel}>{label}</Text>
      <Text style={styles.foodStatMeta}>{meta}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  tabBar: {
    flexDirection: 'row',
    backgroundColor: colors.line,
    borderRadius: radius.sm,
    padding: 3,
    marginHorizontal: spacing.lg,
    marginTop: spacing.md,
  },
  tab: { flex: 1, alignItems: 'center', justifyContent: 'center', paddingVertical: spacing.sm, minHeight: 44, borderRadius: radius.sm - 3 },
  tabActive: { backgroundColor: colors.surface },
  tabLabel: { color: colors.muted, fontSize: 14, fontWeight: '700' },
  tabLabelActive: { color: colors.ink },
  rangeRow: { flexDirection: 'row', gap: spacing.sm, paddingHorizontal: spacing.lg, marginTop: spacing.md },
  rangeChip: {
    flex: 1,
    alignItems: 'center',
    justifyContent: 'center',
    minHeight: 44,
    borderRadius: radius.sm,
    borderWidth: 1,
    borderColor: colors.line,
    backgroundColor: colors.surface,
  },
  rangeChipActive: { borderColor: colors.teal, backgroundColor: colors.tealSoft },
  rangeChipText: { color: colors.muted, fontSize: 13, fontWeight: '700' },
  rangeChipTextActive: { color: colors.teal },
  scrollBody: { padding: spacing.lg, paddingBottom: 44 },
  integrityBox: { backgroundColor: colors.warningSoft, borderRadius: radius.sm, padding: spacing.md, marginBottom: spacing.md },
  integrityText: { color: colors.warning, fontSize: 12, lineHeight: 18, fontWeight: '600' },
  centered: { alignItems: 'center', gap: spacing.md, padding: spacing.xl },
  retryButton: {
    minHeight: 44,
    alignSelf: 'stretch',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
    backgroundColor: colors.teal,
  },
  retryButtonText: { color: colors.surface, fontSize: 15, fontWeight: '800' },
  empty: { backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.lg, gap: spacing.sm },
  emptyTitle: { color: colors.ink, fontSize: 15, fontWeight: '800', textAlign: 'center' },
  mutedText: { color: colors.muted, fontSize: 13, textAlign: 'center', lineHeight: 19 },
  tabIntro: { color: colors.muted, fontSize: 12, lineHeight: 18, marginBottom: spacing.md },
  card: {
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    padding: spacing.md,
    marginBottom: spacing.md,
  },
  // Columna, no fila: un meta largo ("79% en rango · 141 lecturas ·
  // incluye manual/importado") junto al título en una sola fila sin
  // flexShrink en ambos lados empujaba el título a un ancho casi nulo,
  // envolviéndolo letra por letra. Apilado es además más legible en
  // pantallas angostas.
  cardHeader: { marginBottom: spacing.sm, gap: 2 },
  cardTitle: { color: colors.ink, fontSize: 15, fontWeight: '800', textTransform: 'capitalize' },
  cardMeta: { color: colors.muted, fontSize: 11 },
  statRow: { flexDirection: 'row', gap: spacing.md, marginBottom: spacing.md },
  statTile: { flex: 1, backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.md },
  statValue: { color: colors.navy, fontSize: 26, fontWeight: '800' },
  statLabel: { color: colors.ink, fontSize: 13, fontWeight: '600', marginTop: 2 },
  statHint: { color: colors.muted, fontSize: 11, marginTop: 1 },
  sectionTitle: { color: colors.ink, fontSize: 17, fontWeight: '800', marginTop: spacing.lg, marginBottom: spacing.sm },
  noteBox: { backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.md, marginTop: spacing.sm, gap: spacing.sm },
  noteTitle: { color: colors.ink, fontSize: 13, fontWeight: '800' },
  noteText: { color: colors.muted, fontSize: 12, lineHeight: 18 },
  noteWarning: { color: colors.warning, fontSize: 12, lineHeight: 18, fontWeight: '600' },
  foodStatsRow: { flexDirection: 'row', gap: spacing.sm, marginBottom: spacing.md },
  foodStat: { flex: 1 },
  foodStatValue: { color: colors.navy, fontSize: 17, fontWeight: '800' },
  foodStatLabel: { color: colors.ink, fontSize: 11, fontWeight: '600', marginTop: 1 },
  foodStatMeta: { color: colors.muted, fontSize: 10, marginTop: 1 },
  outcomeHeading: { color: colors.ink, fontSize: 12, fontWeight: '700', marginBottom: spacing.sm },
  outcomeRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: spacing.sm },
  outcomeHorizon: { color: colors.muted, fontSize: 12, fontWeight: '700', width: 28 },
  outcomeTrack: { flex: 1, height: 8, borderRadius: 4, backgroundColor: colors.line, overflow: 'hidden', flexDirection: 'row' },
  outcomeTrackEmpty: { flex: 1, height: 8, borderRadius: 4, backgroundColor: colors.line, opacity: 0.5 },
  outcomeValue: { color: colors.ink, fontSize: 12, fontWeight: '800', width: 82, textAlign: 'right' },
  outcomeSample: { color: colors.muted, fontSize: 10, fontWeight: '600' },
  outcomeInsufficient: { color: colors.muted, fontSize: 11, width: 82, textAlign: 'right' },
  outcomeBreakdown: { color: colors.muted, fontSize: 10, marginLeft: 36, marginTop: -4, marginBottom: spacing.sm },
});
