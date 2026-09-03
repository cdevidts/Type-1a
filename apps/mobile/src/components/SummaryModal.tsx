import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, useWindowDimensions, View, type GestureResponderHandlers } from 'react-native';

import {
  MIN_EPISODES_PER_SEGMENT,
  observeCorrectionsFrom,
  summarizeObservedDuration,
  type DaySegmentKey,  buildAmbulatoryProfile,
  buildNutritionInsights,
  MIN_SAMPLE_FOR_RATE,
  summarizeGlucose,
  type MealWindowInsight,
  describeCoverage,
  RELIABLE_COVERAGE_DAYS,
} from '@type1a/domain';
import type { CGMReading, TherapyProfile } from '@type1a/schemas';

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

type SummaryTab = 'days' | 'metrics' | 'food' | 'insulin';

const TABS: { key: SummaryTab; label: string }[] = [
  { key: 'days', label: 'Días' },
  { key: 'metrics', label: 'Métricas' },
  { key: 'food', label: 'Comidas' },
  { key: 'insulin', label: 'Insulina' },
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
  therapy,
  onAdoptSegmentDuration,
  swipeHandlers,
}: {
  visible: boolean;
  onClose: () => void;
  onLoadSummary: (range: { from: Date; to: Date }) => Promise<SummaryData>;
  /** Para leer la duración configurada y los overrides ya adoptados. */
  therapy: TherapyProfile;
  /**
   * Adoptar la duración observada de un tramo. Es un acto **de la usuaria**:
   * la app mide y propone, ella decide — `AGENTS.md` prohíbe que la app fije
   * un parámetro de terapia por su cuenta, y desde el ADR 0005 este número
   * cambia una dosis.
   */
  onAdoptSegmentDuration: (segment: DaySegmentKey, hours: number | null) => Promise<void>;
  /** Navegación lateral por gesto — es un destino de la barra inferior. */
  swipeHandlers?: GestureResponderHandlers;
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
  // del modal. Ver el tag `archive/pre-memory-bank`, § Fase 13, ítem 5.
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
    <ModalShell visible={visible} title="Resumen" onClose={onClose} scroll={false} swipeHandlers={swipeHandlers}>
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
            {tab === 'insulin' ? (
              <InsulinTab data={data} rangeDays={rangeDays} therapy={therapy} onAdoptSegment={onAdoptSegmentDuration} />
            ) : null}
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
  const coverage = describeCoverage({ daysCovered: summary.daysCovered, rangeDays });
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
        {/*
          La cobertura va **siempre**, y arriba. Antes solo aparecía por debajo
          del umbral clínico de 14 días, así que en 30 o 90 días con datos
          suficientes para pasarlo se esfumaba y la pantalla se leía como si el
          promedio resumiera el rango completo. Son dos afirmaciones distintas:
          cuánto está cubierto (descriptivo) y si alcanza para que la HbA1c
          estimada sea confiable (clínico). Ver `coverage.ts`.
        */}
        <Text style={[styles.noteText, coverage.isPartial && styles.notePartial]}>
          {coverage.isPartial
            ? `Estos números cubren ${coverage.text}, no los ${coverage.rangeDays} completos.`
            : `Estos números cubren ${coverage.text}.`}
        </Text>
        <Text style={styles.noteText}>
          La HbA1c estimada (GMI) la calcula esta app desde tu promedio de glucosa sobre {summary.readingCount} lecturas
          en {coverage.daysCovered} día(s). No reemplaza una HbA1c de laboratorio, que mide algo distinto y puede
          diferir. Las metas indicadas son las de consenso internacional para diabetes tipo 1, no un objetivo
          personal: ese lo define tu equipo clínico.
        </Text>
        {coverage.isBelowReliableThreshold ? (
          <Text style={styles.noteWarning}>
            Con menos de {RELIABLE_COVERAGE_DAYS} días de datos la HbA1c estimada y el día promedio son poco
            representativos.
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

/**
 * Cuánto dura de verdad tu insulina, por tramo del día.
 *
 * ## Por qué esta pantalla existe
 *
 * Verónica lo pidió para ver si su curva de efecto se alarga en la mañana. Y
 * desde el ADR 0005 dejó de ser curiosidad: la duración configurada **cambia
 * una dosis propuesta**, así que poder contrastarla con lo que de verdad pasa
 * en sus datos es control de calidad de un parámetro clínico.
 *
 * ## Las reglas que la gobiernan
 *
 * - **El `n` va siempre, la cifra solo cuando la sostiene.** Un "tu insulina
 *   dura 2 h en la mañana" sacado de un episodio se lee como patrón, y acá
 *   puede terminar restando unidades de una dosis real.
 * - **Nada se adopta solo.** El botón es de ella. La app mide y propone;
 *   fijar un parámetro de terapia es un acto suyo (`AGENTS.md`).
 * - **La barra no comunica sola**: cada tramo lleva su número, su `n` y su
 *   rango escritos (`contracts/ux-checklist.md`).
 */
function InsulinTab({
  data,
  rangeDays,
  therapy,
  onAdoptSegment,
}: {
  data: SummaryData | null;
  rangeDays: number;
  therapy: TherapyProfile;
  onAdoptSegment: (segment: DaySegmentKey, hours: number | null) => Promise<void>;
}) {
  const [busy, setBusy] = useState<DaySegmentKey | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const summary = useMemo(() => {
    if (data === null) return null;
    // El filtrado de qué episodio cuenta vive en `packages/domain`: es
    // justamente la parte que puede producir un número equivocado.
    return summarizeObservedDuration(observeCorrectionsFrom({
      insulin: data.insulin,
      meals: data.meals,
      readings: data.readings,
    }));
  }, [data]);

  if (summary === null) return null;

  const configuredHours = therapy.rapidInsulinDurationHours;
  const hoursText = (minutes: number): string => `${(minutes / 60).toFixed(1)} h`;
  const longest = Math.max(60, ...summary.segments.map((s) => s.medianMinutes ?? 0));

  return (
    <View>
      <Text style={styles.sectionTitle}>Cuánto dura tu insulina, en tus datos</Text>
      <Text style={styles.sectionHint}>
        Mide, después de <Text style={styles.noteStrong}>cada dosis rápida</Text> —de comida o de corrección—,
        cuánto tardó tu glucosa en dejar de bajar y en qué momento bajó más rápido. La ventana se recorta en la
        dosis siguiente en vez de descartar el episodio.
        {' '}Últimos {rangeDays} días · {summary.totalEpisodes} {summary.totalEpisodes === 1 ? 'episodio' : 'episodios'} utilizables
        {summary.cleanEpisodes === summary.totalEpisodes
          ? ', ninguno con comida en la ventana'
          : `, ${summary.cleanEpisodes} sin comida en la ventana`}.
        {summary.adjusted
          ? ' Las medianas están descontadas por los carbohidratos y las unidades de cada episodio.'
          : ' Las medianas son crudas: todavía no hay muestra para descontar el efecto de los carbohidratos.'}
      </Text>

      {summary.totalEpisodes === 0 ? (
        <Text style={styles.empty}>
          Todavía no hay episodios medibles en este rango. Hace falta que entre una dosis y la siguiente pasen al
          menos 2 h con lecturas del sensor, y que la glucosa baje al menos 15 mg/dL. Prueba con un rango más largo.
        </Text>
      ) : null}

      {summary.segments.map((segment) => {
        const override = therapy.segmentDurationHours?.[segment.segment];
        const width = segment.medianMinutes === undefined ? 0 : (segment.medianMinutes / longest) * 100;
        return (
          <View key={segment.segment} style={styles.segmentBlock}>
            <View style={styles.segmentHead}>
              <Text style={styles.segmentLabel}>{segment.label}</Text>
              <Text style={styles.segmentValue}>
                {segment.medianMinutes === undefined ? 'sin datos suficientes' : hoursText(segment.medianMinutes)}
              </Text>
            </View>
            <View style={styles.segmentTrack}>
              <View style={[styles.segmentFill, { width: `${width}%` }]} />
            </View>
            <Text style={styles.segmentMeta}>
              {segment.episodeCount} {segment.episodeCount === 1 ? 'episodio' : 'episodios'}
              {segment.cleanCount === segment.episodeCount ? '' : ` (${segment.cleanCount} sin comida)`}
              {segment.medianMinutes === undefined
                ? ` · hacen falta ${MIN_EPISODES_PER_SEGMENT} para publicar una mediana`
                : segment.rangeMinutes === undefined
                  ? ''
                  : ` · entre ${hoursText(segment.rangeMinutes.min)} y ${hoursText(segment.rangeMinutes.max)}`}
              {segment.medianPeakMinutes === undefined
                ? ''
                : ` · bajó más rápido a los ${segment.medianPeakMinutes} min`}
              {override === undefined ? '' : ` · estás usando ${override} h en este tramo`}
            </Text>
            {segment.cleanMedianMinutes === undefined ? (
              segment.medianMinutes === undefined ? null : (
                // Se ve el número para comparar tramos, pero no se puede
                // adoptar: la mediana ajustada conserva el aporte medio de la
                // comida, y adoptarla metería la digestión dentro de la
                // duración de la insulina.
                <Text style={styles.segmentMeta}>
                  Para poder usarlo como tu duración hacen falta {MIN_EPISODES_PER_SEGMENT} episodios
                  {' '}sin comida en la ventana; en este tramo hay {segment.cleanCount}.
                </Text>
              )
            ) : (
              <View style={styles.segmentActions}>
                <Pressable
                  style={[styles.segmentButton, busy !== null && styles.disabled]}
                  disabled={busy !== null}
                  accessibilityRole="button"
                  onPress={() => {
                    const hours = Number((segment.cleanMedianMinutes! / 60).toFixed(1));
                    setBusy(segment.segment);
                    setMessage(null);
                    void onAdoptSegment(segment.segment, hours)
                      .then(() => { setMessage(`${segment.label}: ahora se usan ${hours} h para calcular la insulina activa.`); })
                      .catch(() => { setMessage('No se pudo guardar. Tu configuración sigue como estaba.'); })
                      .finally(() => { setBusy(null); });
                  }}
                >
                  <Text style={styles.segmentButtonText}>Usar {hoursText(segment.cleanMedianMinutes)} en este tramo</Text>
                </Pressable>
                {override === undefined ? null : (
                  <Pressable
                    style={[styles.segmentButtonPlain, busy !== null && styles.disabled]}
                    disabled={busy !== null}
                    accessibilityRole="button"
                    onPress={() => {
                      setBusy(segment.segment);
                      setMessage(null);
                      void onAdoptSegment(segment.segment, null)
                        .then(() => { setMessage(`${segment.label}: vuelve a usar tu duración general.`); })
                        .catch(() => { setMessage('No se pudo guardar. Tu configuración sigue como estaba.'); })
                        .finally(() => { setBusy(null); });
                    }}
                  >
                    <Text style={styles.segmentButtonPlainText}>Volver a la general</Text>
                  </Pressable>
                )}
              </View>
            )}
          </View>
        );
      })}

      {message === null ? null : <Text style={styles.adoptMessage}>{message}</Text>}

      <View style={styles.noteBox}>
        <Text style={styles.noteTitle}>Qué es y qué no es este número</Text>
        <Text style={styles.noteText}>
          Es cuándo dejó de verse el efecto en <Text style={styles.noteStrong}>tu</Text> glucosa, que llega antes
          que el final teórico de la insulina en la ficha técnica. No es una medición de laboratorio: la
          absorción cambia con el sitio de inyección, la temperatura y el ejercicio. Un episodio con comida
          adentro mide la insulina menos los carbohidratos; por eso los carbohidratos entran como covariable y
          la pantalla dice arriba si el descuento se pudo aplicar o no.
          {configuredHours === undefined
            ? ' Todavía no tienes una duración configurada en Ajustes → Terapia, así que la app no descuenta insulina activa de ninguna dosis.'
            : ` Hoy usas ${configuredHours} h como duración general.`}
        </Text>
        <Text style={styles.noteWarning}>
          La cifra que se compara entre tramos y la que se puede adoptar no son la misma: para adoptar solo se
          usan los episodios sin comida en la ventana, porque la mediana ajustada conserva el aporte medio de la
          comida y adoptarla metería la digestión dentro de la duración de tu insulina.{'\n\n'}
          Adoptar una duración cambia cuánta insulina activa se descuenta de tus correcciones, o sea la dosis que
          la app te propone. Es tu decisión y conviene conversarla con tu equipo clínico. Type 1A nunca la cambia
          sola.
        </Text>
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

          {/*
            Macros solo si hay alguno anotado: una fila de tres guiones en cada
            franja sería ruido para quien no los registra. Un "—" acá significa
            "no lo anotaste", nunca 0 g.
          */}
          {window.proteinSampleSize + window.fatSampleSize + window.fiberSampleSize > 0 ? (
            <View style={styles.foodStatsRow}>
              <FoodStat
                value={window.avgProteinG === undefined ? '—' : `${window.avgProteinG.toFixed(0)} g`}
                label="Proteína"
                meta={window.proteinSampleSize > 0 ? `promedio de ${window.proteinSampleSize}` : 'sin anotar'}
              />
              <FoodStat
                value={window.avgFatG === undefined ? '—' : `${window.avgFatG.toFixed(0)} g`}
                label="Grasa"
                meta={window.fatSampleSize > 0 ? `promedio de ${window.fatSampleSize}` : 'sin anotar'}
              />
              <FoodStat
                value={window.avgFiberG === undefined ? '—' : `${window.avgFiberG.toFixed(0)} g`}
                label="Fibra"
                meta={window.fiberSampleSize > 0 ? `promedio de ${window.fiberSampleSize}` : 'sin anotar'}
              />
            </View>
          ) : null}

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
                  {/*
                    Cuántas de esas dosis tuvieron algo registrado en el medio.
                    Antes esas dosis se descartaban del cálculo, y con comidas
                    cada 4-5 h eso dejaba la pantalla vacía. Ahora cuentan, y
                    se declara — un porcentaje mezclado sin esta línea se lee
                    como uno limpio.
                  */}
                  {outcome.confoundedCount > 0
                    ? ` · ${outcome.confoundedCount} de ${outcome.sampleSize} con otra comida, dosis o actividad de por medio`
                    : ''}
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
          Type 1A nunca decide ni sugiere una dosis por su cuenta: la calculadora solo aplica los parámetros que
          cargaste tú. Cualquier cambio de dosis o de parámetros se decide con tu equipo clínico.
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
  sectionHint: { color: colors.muted, fontSize: 12, lineHeight: 18, marginTop: 4 },
  disabled: { opacity: 0.55 },
  segmentBlock: { marginTop: spacing.lg },
  segmentHead: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  segmentLabel: { color: colors.ink, fontSize: 15, fontWeight: '800' },
  segmentValue: { color: colors.navy, fontSize: 15, fontWeight: '800' },
  segmentTrack: { height: 8, borderRadius: 4, backgroundColor: colors.line, overflow: 'hidden', marginTop: 6 },
  segmentFill: { height: '100%', borderRadius: 4, backgroundColor: colors.teal },
  segmentMeta: { color: colors.muted, fontSize: 11, lineHeight: 16, marginTop: 4 },
  segmentActions: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm },
  segmentButton: {
    minHeight: 44, justifyContent: 'center', paddingHorizontal: spacing.md,
    borderRadius: radius.sm, borderWidth: 1, borderColor: colors.teal, backgroundColor: colors.surface,
  },
  segmentButtonText: { color: colors.teal, fontSize: 12, fontWeight: '800' },
  segmentButtonPlain: { minHeight: 44, justifyContent: 'center', paddingHorizontal: spacing.sm },
  segmentButtonPlainText: { color: colors.muted, fontSize: 12, fontWeight: '700' },
  adoptMessage: { color: colors.navy, backgroundColor: colors.tealSoft, borderRadius: radius.sm, padding: spacing.md, fontSize: 13, lineHeight: 19, marginTop: spacing.md },
  noteStrong: { fontWeight: '800' },
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
  notePartial: { fontWeight: '800', color: colors.navy },
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
