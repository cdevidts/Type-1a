/**
 * Qué se le manda al modelo para que responda una pregunta sobre sus datos.
 *
 * ## La decisión que gobierna este archivo
 *
 * **Los parámetros de terapia NO viajan.** Ni el ratio de carbohidratos, ni el
 * factor de corrección, ni el objetivo.
 *
 * No es prudencia de más. Con el ratio, el factor y una glucosa, calcular una
 * dosis es una división que cualquier modelo hace de memoria, y ahí `AGENTS.md`
 * ya está roto sin que ningún filtro de salida lo note: el número sería
 * aritméticamente correcto y aun así lo habría producido el modelo. La única
 * defensa que no depende de una frase del prompt es que **el dato no esté**.
 * Viaja `therapyConfigured: boolean` y nada más, que alcanza para explicar por
 * qué una calculadora está bloqueada.
 *
 * Es el mismo principio que ya sostiene `MealSnapshotSchema` (sin insulina) y
 * `EpisodeContextEvent` (sin texto libre): la frontera es la forma del tipo.
 *
 * ## Y nunca la serie cruda
 *
 * Un día de CGM son ~288 lecturas; noventa días, 26.000. Además de costar una
 * fortuna en tokens, un modelo leyendo 26.000 números va a promediar peor que
 * `summarizeGlucose`, que es determinístico y tiene test. Viajan **las métricas
 * ya calculadas**, con su cobertura y su integridad al lado.
 */

import type { GlucoseSummary } from './glucose-metrics';

/**
 * Cuántas lecturas no se pudieron decodificar.
 *
 * Se declara acá y no se importa de `apps/mobile` porque `packages/domain` no
 * depende del móvil. La forma es la misma.
 */
export interface AgentDecodeTally {
  unreadable: number;
}

export interface AgentContextInput {
  /** Ahora, en ISO con desfase. El modelo no tiene reloj. */
  now: string;
  /** Zona del teléfono, para que "ayer" signifique lo mismo para los dos. */
  timeZone: string;
  /** El rango sobre el que se preguntó. */
  range: { fromIso: string; toIso: string; label: string };
  summary: GlucoseSummary | null;
  tally: AgentDecodeTally;
  /** Cuántos eventos de cada tipo hay en el rango. Conteos, no contenido. */
  counts: { meals: number; rapidDoses: number; basalDoses: number; activity: number; waterMl: number };
  /**
   * Si la terapia está configurada. **Solo el booleano.** Ver la cabecera: los
   * valores no viajan ni van a viajar.
   */
  therapyConfigured: boolean;
  /** Última glucosa conocida y de dónde salió. */
  latest: { valueMgDl: number; minutesAgo: number; origin: 'real' | 'manual' | 'imported' } | null;
}

/**
 * Lo que efectivamente se serializa y se manda.
 *
 * Es un tipo aparte del input a propósito: lo que entra se puede ampliar sin
 * que crezca en silencio lo que sale del teléfono.
 */
export interface AgentContext {
  ahora: string;
  zonaHoraria: string;
  rango: { desde: string; hasta: string; etiqueta: string };
  /** `null` cuando no hay lecturas utilizables en el rango. */
  glucosa: {
    lecturas: number;
    diasCubiertos: number;
    promedioMgDl: number;
    cv: number;
    /** Rotulada SIEMPRE como estimada: es GMI, no un laboratorio. */
    hba1cEstimadaGmi: number;
    /** Los tres lados, nunca "70% en rango" a secas. */
    bajoPct: number;
    enRangoPct: number;
    altoPct: number;
  } | null;
  /**
   * Lo que falta, dicho antes que cualquier promedio.
   *
   * Un TIR sobre una muestra recortada en silencio no es un dato omitido: es un
   * número inventado.
   */
  integridad: { registrosIlegibles: number; sinDatos: boolean };
  conteos: AgentContextInput['counts'];
  terapiaConfigurada: boolean;
  ultimaGlucosa: { mgDl: number; haceMinutos: number; procedencia: string } | null;
}

/** Cómo se nombra una procedencia para que no se pueda leer como sensor en vivo. */
export function describeOrigin(origin: 'real' | 'manual' | 'imported'): string {
  if (origin === 'real') return 'sensor';
  if (origin === 'manual') return 'medición capilar que ella escribió';
  return 'dato importado de otra app';
}

/**
 * Arma el contexto. Puro: no toca red, base ni reloj.
 *
 * `null` en `glucosa` no es un error: es "no hay lecturas utilizables", y el
 * prompt obliga a decirlo en vez de responder igual.
 */
export function buildAgentContext(input: AgentContextInput): AgentContext {
  const { summary } = input;
  return {
    ahora: input.now,
    zonaHoraria: input.timeZone,
    rango: { desde: input.range.fromIso, hasta: input.range.toIso, etiqueta: input.range.label },
    glucosa: summary === null
      ? null
      : {
          lecturas: summary.readingCount,
          diasCubiertos: summary.daysCovered,
          promedioMgDl: Math.round(summary.meanGlucoseMgDl),
          cv: Math.round(summary.coefficientOfVariationPct),
          hba1cEstimadaGmi: Number(summary.estimatedA1cPct.toFixed(1)),
          // Los tres lados juntos, siempre. "70% en rango" esconde si el 30%
          // fueron hipos o hipers, que son problemas opuestos, e invita a
          // concluir que falta insulina.
          bajoPct: Math.round(summary.range.veryLowPct + summary.range.lowPct),
          enRangoPct: Math.round(summary.range.targetPct),
          altoPct: Math.round(summary.range.highPct + summary.range.veryHighPct),
        },
    integridad: {
      registrosIlegibles: input.tally.unreadable,
      sinDatos: summary === null,
    },
    conteos: input.counts,
    terapiaConfigurada: input.therapyConfigured,
    ultimaGlucosa: input.latest === null
      ? null
      : {
          mgDl: Math.round(input.latest.valueMgDl),
          haceMinutos: Math.round(input.latest.minutesAgo),
          procedencia: describeOrigin(input.latest.origin),
        },
  };
}

/**
 * Las claves que **nunca** pueden aparecer en un contexto.
 *
 * Se afirma en un test en vez de confiar en que nadie las agregue. Si mañana
 * alguien suma el perfil de terapia "para que el chat pueda explicarlo mejor",
 * el test falla y le cuenta por qué no.
 */
export const CONTEXT_FORBIDDEN_KEYS: readonly string[] = [
  'carbRatio',
  'correctionFactor',
  'targetGlucose',
  'doseIncrement',
  'ratio',
  'factor',
  'objetivo',
];

/** Busca claves prohibidas en un contexto ya armado, a cualquier profundidad. */
export function forbiddenKeysIn(context: unknown): string[] {
  const found: string[] = [];
  const walk = (value: unknown): void => {
    if (Array.isArray(value)) { for (const item of value) walk(item); return; }
    if (value === null || typeof value !== 'object') return;
    for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
      if (CONTEXT_FORBIDDEN_KEYS.includes(key)) found.push(key);
      walk(child);
    }
  };
  walk(context);
  return found;
}
