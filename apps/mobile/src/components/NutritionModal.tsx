import { useEffect, useMemo, useState } from 'react';
import { ActivityIndicator, Pressable, ScrollView, StyleSheet, Text, TextInput, View, type GestureResponderHandlers } from 'react-native';

import {
  ACTIVITY_LEVELS,
  buildMacroGlucoseComparison,
  calculateNutritionTargets,
  energyFromMacros,
  MIN_MEALS_PER_GROUP,
  type ActivityLevel,
  type BiologicalSex,
  type NutritionGoal,
  type NutritionTargets,
} from '@type1a/domain';
import type { CarbEvent, MealEvent, NutritionProfile } from '@type1a/schemas';

import { formatClock } from '../format';
import { logSaveError } from '../log';
import { colors, macroColors, radius, spacing } from '../theme';
import type { NutritionDayData } from '../types';
import { ErrorBoundary } from './ErrorBoundary';
import { ModalShell } from './ModalShell';

/**
 * Pantalla "Nutrición" (Fase 14).
 *
 * Es la mitad alimentaria de la app, separada de la pantalla principal de
 * glucosa a propósito: son dos ritmos distintos (la glucosa se mira muchas
 * veces al día, la alimentación se revisa) y mezclarlas cargaba la principal.
 *
 * Acá viven por fin los datos de comida que se guardaban y no se mostraban:
 * proteína, grasa, fibra y la energía que sale de ellos.
 *
 * ## Frontera de seguridad
 *
 * Toda la aritmética vive en `packages/domain`
 * (`nutrition-targets.ts`, `macro-glucose.ts`), con sus notas de seguridad;
 * este archivo elige rango, formatea y dibuja. Dos reglas que rigen los
 * textos de esta pantalla:
 *
 * 1. **La meta es una referencia, no una prescripción.** Sale de ecuaciones
 *    poblacionales y se dice así en pantalla.
 * 2. **Los patrones de grasa/proteína se describen, nunca se accionan.** La
 *    respuesta que da la literatura a ese patrón es ajustar la insulina
 *    (bolo extendido), y eso es precisamente lo que `AGENTS.md` prohíbe que
 *    la app sugiera.
 */

type NutritionTab = 'today' | 'goals' | 'patterns';

const TABS: { key: NutritionTab; label: string }[] = [
  { key: 'today', label: 'Hoy' },
  { key: 'goals', label: 'Metas' },
  { key: 'patterns', label: 'Patrones' },
];

const GOAL_OPTIONS: { value: NutritionGoal; label: string; detail: string }[] = [
  { value: 'lose', label: 'Bajar de peso', detail: 'Déficit moderado de 500 kcal al día. Habla con tu equipo antes de empezar.' },
  { value: 'maintain', label: 'Mantener', detail: 'Comer alrededor de tu gasto' },
  { value: 'gain', label: 'Subir de peso', detail: 'Superávit de 300 kcal al día' },
  { value: 'trackOnly', label: 'Solo registrar', detail: 'Sin déficit ni superávit; ver lo que comes' },
];

const SEX_OPTIONS: { value: BiologicalSex; label: string }[] = [
  { value: 'female', label: 'Mujer' },
  { value: 'male', label: 'Hombre' },
];

/** Progreso de un macro. Siempre etiquetado: el color nunca lleva la identidad solo. */
function MacroBar({
  label,
  eatenG,
  targetG,
  color,
}: {
  label: string;
  eatenG: number;
  targetG: number;
  color: string;
}) {
  const pct = targetG <= 0 ? 0 : Math.min(100, (eatenG / targetG) * 100);
  const over = eatenG > targetG;
  return (
    <View style={styles.macroBlock}>
      <View style={styles.macroHeader}>
        <View style={styles.macroNameRow}>
          <View style={[styles.macroDot, { backgroundColor: color }]} />
          <Text style={styles.macroName}>{label}</Text>
        </View>
        <Text style={styles.macroNumbers}>
          <Text style={styles.macroEaten}>{Math.round(eatenG)}</Text>
          <Text style={styles.macroTarget}> / {Math.round(targetG)} g</Text>
        </Text>
      </View>
      <View style={styles.macroTrack}>
        <View style={[styles.macroFill, { width: `${pct}%`, backgroundColor: color }]} />
      </View>
      {over ? <Text style={styles.macroOver}>Pasaste la referencia por {Math.round(eatenG - targetG)} g</Text> : null}
    </View>
  );
}

export function NutritionModal({
  visible,
  onClose,
  profile,
  onSaveProfile,
  onLoadDay,
  swipeHandlers,
}: {
  visible: boolean;
  onClose: () => void;
  profile: NutritionProfile | null;
  onSaveProfile: (profile: NutritionProfile) => Promise<void>;
  onLoadDay: () => Promise<NutritionDayData>;
  /** Navegación lateral por gesto — es un destino de la barra inferior. */
  swipeHandlers?: GestureResponderHandlers;
}) {
  const [tab, setTab] = useState<NutritionTab>('today');
  const [data, setData] = useState<NutritionDayData | null>(null);
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);
  const [reloadToken, setReloadToken] = useState(0);

  useEffect(() => {
    if (!visible) return;
    let cancelled = false;
    setLoading(true);
    setFailed(false);
    onLoadDay()
      .then((loaded) => { if (!cancelled) setData(loaded); })
      .catch((error: unknown) => {
        logSaveError('NutritionModal.load', error);
        if (!cancelled) { setData(null); setFailed(true); }
      })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [visible, onLoadDay, reloadToken]);

  const targets = useMemo<NutritionTargets | null>(
    () => (profile === null ? null : calculateNutritionTargets(profile)),
    [profile],
  );

  return (
    <ModalShell visible={visible} title="Nutrición" onClose={onClose} scroll={false} swipeHandlers={swipeHandlers}>
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

      {loading ? (
        <View style={styles.centered}>
          <ActivityIndicator color={colors.teal} />
          <Text style={styles.mutedText}>Leyendo tus comidas…</Text>
        </View>
      ) : failed ? (
        <View style={styles.centered}>
          <Text style={styles.emptyTitle}>No se pudo leer tus comidas</Text>
          <Text style={styles.mutedText}>Tus registros están intactos: esto solo afecta a esta pantalla.</Text>
          <Pressable
            style={styles.primaryButton}
            onPress={() => { setReloadToken((token) => token + 1); }}
            accessibilityRole="button"
          >
            <Text style={styles.primaryButtonText}>Reintentar</Text>
          </Pressable>
        </View>
      ) : (
        <ErrorBoundary
          title="No se pudo dibujar esta pantalla"
          body="Algo en tus registros de comida no se pudo interpretar."
          onReset={() => { setReloadToken((token) => token + 1); }}
        >
          <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
            {data !== null && data.unreadableCount > 0 ? (
              <View style={styles.integrityBox}>
                <Text style={styles.integrityText}>
                  {data.unreadableCount} registro(s) no se pudieron leer y quedaron fuera de estos números.
                </Text>
              </View>
            ) : null}

            {tab === 'today' ? <TodayTab data={data} targets={targets} onGoToGoals={() => { setTab('goals'); }} /> : null}
            {tab === 'goals' ? <GoalsTab profile={profile} targets={targets} onSaveProfile={onSaveProfile} /> : null}
            {tab === 'patterns' ? <PatternsTab data={data} /> : null}
          </ScrollView>
        </ErrorBoundary>
      )}
    </ModalShell>
  );
}

function EmptyState({ title, body, action }: { title: string; body: string; action?: { label: string; onPress: () => void } }) {
  return (
    <View style={styles.empty}>
      <Text style={styles.emptyTitle}>{title}</Text>
      <Text style={styles.mutedText}>{body}</Text>
      {action === undefined ? null : (
        <Pressable style={styles.primaryButton} onPress={action.onPress} accessibilityRole="button">
          <Text style={styles.primaryButtonText}>{action.label}</Text>
        </Pressable>
      )}
    </View>
  );
}

/**
 * Totales del día.
 *
 * Los carbohidratos vienen de **dos** sitios y hay que sumar los dos: las
 * comidas (`MealEvent.confirmedCarbsG`) y los `CarbEvent` sueltos del atajo
 * rápido de la pantalla principal — que es, de hecho, la vía más usada para
 * registrar carbos. Contar solo las comidas mostraba "0 g" a alguien que
 * había registrado 120 g esa mañana, e invitaba a comer un día entero de más.
 *
 * Se excluyen los `CarbEvent` con `source: 'meal_confirmed'` porque esos los
 * escribe la propia confirmación de una comida: sumarlos otra vez duplicaría
 * los carbohidratos de cada comida.
 */
function dayTotals(
  meals: readonly MealEvent[],
  carbEvents: readonly CarbEvent[],
): { carbsG: number; proteinG: number; fatG: number; fiberG: number; anyMissing: boolean } {
  let carbsG = 0;
  let proteinG = 0;
  let fatG = 0;
  let fiberG = 0;
  let anyMissing = false;
  for (const meal of meals) {
    carbsG += meal.confirmedCarbsG ?? 0;
    proteinG += meal.proteinG ?? 0;
    fatG += meal.fatG ?? 0;
    fiberG += meal.fiberG ?? 0;
    // "Sin anotar" no es 0: si falta un macro, el total del día es un piso.
    if (meal.proteinG === undefined || meal.fatG === undefined) anyMissing = true;
  }
  for (const event of carbEvents) {
    if (event.source === 'meal_confirmed') continue;
    carbsG += event.carbsG;
    // Un carbo suelto no trae proteína ni grasa por definición, así que la
    // energía del día queda incompleta: es un piso, no el total.
    anyMissing = true;
  }
  return { carbsG, proteinG, fatG, fiberG, anyMissing };
}

function TodayTab({
  data,
  targets,
  onGoToGoals,
}: {
  data: NutritionDayData | null;
  targets: NutritionTargets | null;
  onGoToGoals: () => void;
}) {
  if (targets === null) {
    return (
      <EmptyState
        title="Primero, tus metas"
        body="Con tu peso, estatura, edad y nivel de actividad podemos estimar cuánta energía y cuántos macronutrientes necesitas al día. Es una referencia para leer lo que comes, no una indicación médica."
        action={{ label: 'Configurar mis metas', onPress: onGoToGoals }}
      />
    );
  }
  if (data === null || (data.dayMeals.length === 0 && data.dayCarbs.length === 0)) {
    return (
      <EmptyState
        title="Sin comidas registradas hoy"
        body="Registra una comida desde la pantalla principal y aparecerá acá con sus carbohidratos, proteína y grasa."
      />
    );
  }

  const totals = dayTotals(data.dayMeals, data.dayCarbs);
  const energy = energyFromMacros({
    carbsG: totals.carbsG,
    proteinG: totals.proteinG,
    fatG: totals.fatG,
  });
  const remaining = targets.caloriesKcal - energy.kcal;

  return (
    <View>
      {/* Número protagonista: una sola cifra grande, no un tablero de cinco. */}
      <View style={styles.heroCard}>
        <Text style={styles.heroEyebrow}>ENERGÍA DE HOY</Text>
        <View style={styles.heroRow}>
          <Text style={styles.heroValue}>{energy.kcal}</Text>
          <Text style={styles.heroUnit}>de {targets.caloriesKcal} kcal</Text>
        </View>
        <View style={styles.heroTrack}>
          <View
            style={[
              styles.heroFill,
              { width: `${Math.min(100, (energy.kcal / targets.caloriesKcal) * 100)}%` },
            ]}
          />
        </View>
        <Text style={styles.heroFoot}>
          {remaining >= 0 ? `Te quedan ${remaining} kcal` : `Pasaste por ${Math.abs(remaining)} kcal`}
        </Text>
        {totals.anyMissing ? (
          <Text style={styles.heroWarning}>
            Alguna comida de hoy no tiene proteína o grasa anotada, así que este total es un mínimo: lo comido
            fue al menos esto.
          </Text>
        ) : null}
      </View>

      <MacroBar label="Carbohidratos" eatenG={totals.carbsG} targetG={targets.carbsG} color={macroColors.carbs} />
      <MacroBar label="Proteína" eatenG={totals.proteinG} targetG={targets.proteinG} color={macroColors.protein} />
      <MacroBar label="Grasa" eatenG={totals.fatG} targetG={targets.fatG} color={macroColors.fat} />
      {totals.fiberG > 0 ? <Text style={styles.fiberNote}>Fibra registrada hoy: {Math.round(totals.fiberG)} g</Text> : null}

      <Text style={styles.sectionTitle}>Comidas de hoy</Text>
      {data.dayMeals.map((meal) => {
        const perMeal = energyFromMacros({
          carbsG: meal.confirmedCarbsG,
          proteinG: meal.proteinG,
          fatG: meal.fatG,
        });
        return (
          <View key={meal.id} style={styles.mealCard}>
            <View style={styles.mealHeader}>
              <Text style={styles.mealTime}>{formatClock(meal.timestamp)}</Text>
              <Text style={styles.mealKcal}>
                {perMeal.kcal} kcal{perMeal.partial ? '+' : ''}
              </Text>
            </View>
            <View style={styles.mealMacroRow}>
              <MealMacroChip label="Carbos" value={meal.confirmedCarbsG} color={macroColors.carbs} />
              <MealMacroChip label="Proteína" value={meal.proteinG} color={macroColors.protein} />
              <MealMacroChip label="Grasa" value={meal.fatG} color={macroColors.fat} />
            </View>
            {perMeal.partial ? (
              <Text style={styles.mealPartial}>
                El “+” indica que falta anotar algún macro, así que la energía real fue mayor.
              </Text>
            ) : null}
            {meal.note === undefined ? null : <Text style={styles.mealNote}>{meal.note}</Text>}
          </View>
        );
      })}

      <View style={styles.noteBox}>
        <Text style={styles.noteText}>
          La energía se calcula desde los macronutrientes que anotaste (4 kcal por gramo de carbohidrato y de
          proteína, 9 por gramo de grasa). Si no anotas proteína y grasa, el total queda corto.
        </Text>
        {/*
          Obligatorio también acá, no solo en Metas: esta es la pantalla que
          se mira a diario, y una línea roja sobre gramos de carbohidrato en
          una app de insulina se lee como un límite si nadie dice lo contrario.
        */}
        <Text style={styles.noteWarning}>
          Las cifras de referencia salen de ecuaciones poblacionales: son para orientarte, no una indicación
          médica ni un límite que debas respetar. Tu objetivo real lo define tu equipo clínico.
        </Text>
      </View>
    </View>
  );
}

function MealMacroChip({ label, value, color }: { label: string; value: number | undefined; color: string }) {
  return (
    <View style={styles.mealChip}>
      <View style={[styles.macroDot, { backgroundColor: value === undefined ? colors.line : color }]} />
      <Text style={styles.mealChipText}>
        {label} {value === undefined ? '—' : `${Math.round(value)} g`}
      </Text>
    </View>
  );
}

function GoalsTab({
  profile,
  targets,
  onSaveProfile,
}: {
  profile: NutritionProfile | null;
  targets: NutritionTargets | null;
  onSaveProfile: (profile: NutritionProfile) => Promise<void>;
}) {
  const [sex, setSex] = useState<BiologicalSex>(profile?.sex ?? 'female');
  const [age, setAge] = useState(profile === null ? '' : String(profile.ageYears));
  const [height, setHeight] = useState(profile === null ? '' : String(profile.heightCm));
  const [weight, setWeight] = useState(profile === null ? '' : String(profile.weightKg));
  const [activity, setActivity] = useState<ActivityLevel>(profile?.activityLevel ?? 'moderate');
  const [goal, setGoal] = useState<NutritionGoal>(profile?.goal ?? 'maintain');
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  async function save(): Promise<void> {
    const parsedAge = Number(age.replace(',', '.'));
    const parsedHeight = Number(height.replace(',', '.'));
    const parsedWeight = Number(weight.replace(',', '.'));
    if (!Number.isFinite(parsedAge) || !Number.isFinite(parsedHeight) || !Number.isFinite(parsedWeight)) {
      setMessage('Revisa edad, estatura y peso: deben ser números.');
      return;
    }
    setBusy(true);
    setMessage(null);
    try {
      await onSaveProfile({
        sex,
        ageYears: Math.round(parsedAge),
        heightCm: parsedHeight,
        weightKg: parsedWeight,
        activityLevel: activity,
        goal,
        updatedAt: new Date().toISOString(),
      });
      setMessage('Metas actualizadas.');
    } catch (error) {
      logSaveError('NutritionModal.saveProfile', error);
      setMessage('No se pudo guardar. Revisa que los valores sean razonables (edad 12–110, estatura 90–250 cm, peso 25–350 kg).');
    } finally {
      setBusy(false);
    }
  }

  return (
    <View>
      {targets === null ? null : (
        <View style={styles.targetCard}>
          <Text style={styles.heroEyebrow}>TU REFERENCIA DIARIA</Text>
          <View style={styles.heroRow}>
            <Text style={styles.heroValue}>{targets.caloriesKcal}</Text>
            <Text style={styles.heroUnit}>kcal al día</Text>
          </View>
          <View style={styles.targetMacroRow}>
            <TargetChip label="Carbohidratos" value={`${targets.carbsG} g`} color={macroColors.carbs} />
            <TargetChip label="Proteína" value={`${targets.proteinG} g`} color={macroColors.protein} />
            <TargetChip label="Grasa" value={`${targets.fatG} g`} color={macroColors.fat} />
          </View>
          <Text style={styles.targetBreakdown}>
            Metabolismo basal estimado {targets.bmrKcal} kcal · gasto total estimado {targets.tdeeKcal} kcal
          </Text>
          {targets.clampedBy === undefined ? null : (
            <Text style={styles.heroWarning}>
              {targets.clampedBy === 'bmr'
                ? 'Ajustamos la meta hacia arriba: el déficit la dejaba por debajo de tu metabolismo basal, y comer menos que eso de forma sostenida no es seguro.'
                : 'Ajustamos la meta hacia arriba hasta el mínimo recomendado. Bajar de ahí necesita supervisión clínica.'}
            </Text>
          )}
        </View>
      )}

      <Text style={styles.sectionTitle}>Tus datos</Text>

      <Text style={styles.fieldLabel}>Sexo biológico</Text>
      <Text style={styles.fieldHint}>La ecuación de gasto energético usa constantes distintas para cada uno.</Text>
      <View style={styles.chipRow}>
        {SEX_OPTIONS.map((option) => (
          <Pressable
            key={option.value}
            style={[styles.chip, sex === option.value && styles.chipActive]}
            onPress={() => { setSex(option.value); }}
            accessibilityRole="button"
            accessibilityState={{ selected: sex === option.value }}
          >
            <Text style={[styles.chipText, sex === option.value && styles.chipTextActive]}>{option.label}</Text>
          </Pressable>
        ))}
      </View>

      <View style={styles.measureRow}>
        <MeasureField label="Edad" unit="años" value={age} onChange={setAge} />
        <MeasureField label="Estatura" unit="cm" value={height} onChange={setHeight} />
        <MeasureField label="Peso" unit="kg" value={weight} onChange={setWeight} />
      </View>

      <Text style={styles.fieldLabel}>Actividad física</Text>
      <Text style={styles.fieldHint}>Piensa en tu semana completa, no en el día de hoy.</Text>
      {ACTIVITY_LEVELS.map((level) => (
        <Pressable
          key={level.key}
          style={[styles.levelRow, activity === level.key && styles.levelRowActive]}
          onPress={() => { setActivity(level.key); }}
          accessibilityRole="button"
          accessibilityState={{ selected: activity === level.key }}
        >
          <View style={styles.levelCopy}>
            <Text style={[styles.levelLabel, activity === level.key && styles.levelLabelActive]}>{level.label}</Text>
            <Text style={styles.levelDetail}>{level.detail}</Text>
          </View>
          {activity === level.key ? <Text style={styles.levelCheck}>✓</Text> : null}
        </Pressable>
      ))}

      <Text style={styles.fieldLabel}>Tu meta</Text>
      {GOAL_OPTIONS.map((option) => (
        <Pressable
          key={option.value}
          style={[styles.levelRow, goal === option.value && styles.levelRowActive]}
          onPress={() => { setGoal(option.value); }}
          accessibilityRole="button"
          accessibilityState={{ selected: goal === option.value }}
        >
          <View style={styles.levelCopy}>
            <Text style={[styles.levelLabel, goal === option.value && styles.levelLabelActive]}>{option.label}</Text>
            <Text style={styles.levelDetail}>{option.detail}</Text>
          </View>
          {goal === option.value ? <Text style={styles.levelCheck}>✓</Text> : null}
        </Pressable>
      ))}

      {/*
        La advertencia fuerte va acá, junto al control, y solo cuando la meta
        elegida es bajar de peso. Al pie de la pantalla se leía como letra
        chica genérica; el momento en que importa es el de elegir.
      */}
      {goal === 'lose' ? (
        <View style={styles.hazardBox}>
          <Text style={styles.hazardTitle}>Antes de bajar de peso con insulina</Text>
          <Text style={styles.hazardText}>
            Comer menos —sobre todo menos carbohidratos— con la misma pauta de insulina que tienes hoy puede
            causarte hipoglucemias. Tu basal y tus bolos puede que necesiten cambiar, y ese ajuste lo hace tu
            equipo clínico, no esta app. Coméntaselo antes de empezar.
          </Text>
        </View>
      ) : null}

      {message === null ? null : <Text style={styles.message}>{message}</Text>}

      <Pressable
        style={[styles.primaryButton, busy && styles.disabled]}
        disabled={busy}
        onPress={() => { void save(); }}
        accessibilityRole="button"
      >
        <Text style={styles.primaryButtonText}>{busy ? 'Guardando…' : 'Guardar metas'}</Text>
      </Pressable>

      <View style={styles.noteBox}>
        <Text style={styles.noteTitle}>Cómo se calcula, y qué no es</Text>
        <Text style={styles.noteText}>
          La energía sale de la ecuación de Mifflin-St Jeor sobre tu peso, estatura, edad y sexo, multiplicada por
          tu nivel de actividad. El reparto apunta a la mitad de la energía en carbohidratos —el rango
          recomendado en diabetes tipo 1— con la proteína calculada por kilo de peso y la grasa como resto
          acotado; según tu perfil puede quedar unos puntos por encima. En tu caso concreto son{' '}
          {Math.round(((targets?.carbsG ?? 0) * 4 / (targets?.caloriesKcal ?? 1)) * 100)} % carbohidratos,{' '}
          {Math.round(((targets?.proteinG ?? 0) * 4 / (targets?.caloriesKcal ?? 1)) * 100)} % proteína y{' '}
          {Math.round(((targets?.fatG ?? 0) * 9 / (targets?.caloriesKcal ?? 1)) * 100)} % grasa.
        </Text>
        <Text style={styles.noteWarning}>
          Es una referencia poblacional, no una indicación médica. Tu objetivo real —sobre todo si vas a bajar de
          peso con insulina— lo define tu equipo clínico, y cambiar lo que comes puede cambiar lo que necesitas.
          Type 1A nunca ajusta ni sugiere dosis.
        </Text>
      </View>
    </View>
  );
}

function TargetChip({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <View style={styles.targetChip}>
      <View style={[styles.macroDot, { backgroundColor: color }]} />
      <Text style={styles.targetChipValue}>{value}</Text>
      <Text style={styles.targetChipLabel}>{label}</Text>
    </View>
  );
}

function MeasureField({
  label,
  unit,
  value,
  onChange,
}: {
  label: string;
  unit: string;
  value: string;
  onChange: (next: string) => void;
}) {
  return (
    <View style={styles.measureField}>
      <Text style={styles.measureLabel}>{label}</Text>
      <View style={styles.measureInputWrap}>
        <TextInput
          style={styles.measureInput}
          value={value}
          onChangeText={onChange}
          keyboardType="decimal-pad"
          placeholder="—"
          placeholderTextColor={colors.muted}
          accessibilityLabel={`${label} en ${unit}`}
        />
        <Text style={styles.measureUnit}>{unit}</Text>
      </View>
    </View>
  );
}

function PatternsTab({ data }: { data: NutritionDayData | null }) {
  const comparison = useMemo(
    () => (data === null ? null : buildMacroGlucoseComparison({
      meals: data.patternMeals,
      readings: data.readings,
      // Fase 23: sin estos, una colación a las 2 h entraría al promedio como
      // si fuera efecto tardío de la grasa de la comida original.
      insulin: data.patternInsulin,
      carbs: data.patternCarbs,
      activity: data.patternActivity,
    })),
    [data],
  );

  if (comparison === null) {
    return (
      <EmptyState
        title="Todavía no hay suficiente para comparar"
        body={`Hacen falta al menos ${MIN_MEALS_PER_GROUP * 2} comidas con grasa y proteína anotadas, y con variedad entre ellas. Anota esos macros al registrar y este patrón aparece solo.`}
      />
    );
  }

  const maxAbs = Math.max(
    1,
    ...[...comparison.higher.points, ...comparison.lower.points]
      .map((point) => Math.abs(point.meanDeltaMgDl ?? 0)),
  );

  return (
    <View>
      <Text style={styles.tabIntro}>
        Cómo se comportó tu glucosa después de comer, separando tus comidas en las de mayor y menor carga de
        grasa más proteína. Se mide el cambio desde el momento de comer, no el valor absoluto.
      </Text>
      <Text style={styles.tabIntro}>
        Cada horizonte usa solo las comidas que no tuvieron otra cosa registrada en el medio (otra comida,
        carbohidratos, una dosis o actividad), porque en esas la glucosa ya no describe solo a la comida
        original. Por eso el <Text style={styles.tabIntroStrong}>n</Text> de cada barra puede ser menor que
        las comidas del grupo, y suele achicarse en los horizontes más largos.
      </Text>

      <View style={styles.legendRow}>
        <View style={styles.legendItem}>
          <View style={[styles.legendSwatch, { backgroundColor: macroColors.fat }]} />
          <Text style={styles.legendText}>
            Más grasa + proteína (≈{Math.round(comparison.higher.avgFatProteinG)} g · {comparison.higher.mealCount} comidas)
          </Text>
        </View>
        <View style={styles.legendItem}>
          <View style={[styles.legendSwatch, styles.legendSwatchLower]} />
          <Text style={styles.legendText}>
            Menos (≈{Math.round(comparison.lower.avgFatProteinG)} g · {comparison.lower.mealCount} comidas)
          </Text>
        </View>
      </View>

      {comparison.higher.points.map((higherPoint) => {
        const lowerPoint = comparison.lower.points.find((p) => p.horizonHours === higherPoint.horizonHours);
        return (
          <View key={higherPoint.horizonHours} style={styles.horizonBlock}>
            <Text style={styles.horizonTitle}>{higherPoint.horizonHours} horas después</Text>
            <DeltaRow point={higherPoint} maxAbs={maxAbs} color={macroColors.fat} />
            <DeltaRow point={lowerPoint} maxAbs={maxAbs} color={colors.muted} />
          </View>
        );
      })}

      <View style={styles.noteBox}>
        <Text style={styles.noteTitle}>Por qué mirar tan tarde</Text>
        <Text style={styles.noteText}>
          En diabetes tipo 1 la grasa y la proteína tienden a mover la glucosa de forma retrasada y prolongada,
          entre una hora y media y seis horas después de comer, y cuando la comida es alta en ambas el efecto se
          suma. Por eso acá se miran las 2, 3, 4 y 5 horas, y no la primera hora como en el resto de la app.
        </Text>
        <Text style={styles.noteWarning}>
          Esto describe lo que ya pasó con tus datos. No es una indicación de cuánta insulina ponerte, ni de
          cuándo, ni de comer menos grasa o proteína. Type 1A nunca calcula ni sugiere una dosis: llévalo a tu
          equipo clínico, que es quien puede decidir algo con esta información.
        </Text>
      </View>
    </View>
  );
}

function DeltaRow({
  point,
  maxAbs,
  color,
}: {
  point: { horizonHours: number; sampleSize: number; meanDeltaMgDl?: number | undefined } | undefined;
  maxAbs: number;
  color: string;
}) {
  if (point === undefined) return null;
  if (point.meanDeltaMgDl === undefined) {
    return (
      <View style={styles.deltaRow}>
        <View style={styles.deltaTrack} />
        <Text style={styles.deltaInsufficient}>n={point.sampleSize}, faltan datos</Text>
      </View>
    );
  }
  const delta = point.meanDeltaMgDl;
  const width = Math.min(100, (Math.abs(delta) / maxAbs) * 100);
  return (
    <View style={styles.deltaRow}>
      <View style={styles.deltaTrack}>
        <View style={[styles.deltaFill, { width: `${width}%`, backgroundColor: color }]} />
      </View>
      {/*
        El `n` va SIEMPRE, no solo cuando faltan datos. Desde la Fase 23 cada
        horizonte descarta por separado las comidas que tuvieron algo más
        registrado en el medio, así que este promedio puede estar hecho de
        muchas menos comidas que las que dice la leyenda del grupo. Mostrar
        "+62 mg/dL" sin decir que son 3 comidas invita a leerlo como un
        patrón firme. Es el mismo dato que ya se imprime en el reporte.
      */}
      <Text style={styles.deltaValue}>
        {delta >= 0 ? '+' : ''}{Math.round(delta)} <Text style={styles.deltaUnit}>mg/dL · n={point.sampleSize}</Text>
      </Text>
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
  body: { padding: spacing.lg, paddingBottom: 44 },
  centered: { alignItems: 'center', gap: spacing.md, padding: spacing.xl },
  mutedText: { color: colors.muted, fontSize: 13, textAlign: 'center', lineHeight: 19 },
  emptyTitle: { color: colors.ink, fontSize: 16, fontWeight: '800', textAlign: 'center' },
  empty: { backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.lg, gap: spacing.sm, alignItems: 'center' },
  integrityBox: { backgroundColor: colors.warningSoft, borderRadius: radius.sm, padding: spacing.md, marginBottom: spacing.md },
  integrityText: { color: colors.warning, fontSize: 12, lineHeight: 18, fontWeight: '600' },

  heroCard: { backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.lg, marginBottom: spacing.lg },
  targetCard: { backgroundColor: colors.surface, borderRadius: radius.lg, padding: spacing.lg, marginBottom: spacing.md },
  heroEyebrow: { color: colors.navy, fontSize: 11, fontWeight: '800', letterSpacing: 1 },
  heroRow: { flexDirection: 'row', alignItems: 'baseline', gap: spacing.sm, marginTop: spacing.xs },
  heroValue: { color: colors.ink, fontSize: 44, fontWeight: '800', letterSpacing: -2 },
  heroUnit: { color: colors.muted, fontSize: 14, fontWeight: '600' },
  heroTrack: { height: 10, borderRadius: 5, backgroundColor: colors.line, overflow: 'hidden', marginTop: spacing.md },
  heroFill: { height: '100%', borderRadius: 5, backgroundColor: colors.teal },
  heroFoot: { color: colors.ink, fontSize: 13, fontWeight: '700', marginTop: spacing.sm },
  heroWarning: { color: colors.warning, fontSize: 12, lineHeight: 18, fontWeight: '600', marginTop: spacing.sm },

  macroBlock: { marginBottom: spacing.md },
  macroHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 },
  macroNameRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  macroDot: { width: 10, height: 10, borderRadius: 5 },
  macroName: { color: colors.ink, fontSize: 14, fontWeight: '700' },
  macroNumbers: { fontSize: 13 },
  macroEaten: { color: colors.ink, fontWeight: '800' },
  macroTarget: { color: colors.muted },
  macroTrack: { height: 8, borderRadius: 4, backgroundColor: colors.line, overflow: 'hidden' },
  macroFill: { height: '100%', borderRadius: 4 },
  macroOver: { color: colors.muted, fontSize: 11, marginTop: 4 },
  fiberNote: { color: colors.muted, fontSize: 12, marginBottom: spacing.md },

  sectionTitle: { color: colors.ink, fontSize: 17, fontWeight: '800', marginTop: spacing.lg, marginBottom: spacing.sm },
  mealCard: { backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.sm },
  mealHeader: { flexDirection: 'row', justifyContent: 'space-between', alignItems: 'baseline' },
  mealTime: { color: colors.ink, fontSize: 15, fontWeight: '800' },
  mealKcal: { color: colors.navy, fontSize: 15, fontWeight: '800' },
  mealMacroRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm, marginTop: spacing.sm },
  mealChip: { flexDirection: 'row', alignItems: 'center', gap: 5 },
  mealChipText: { color: colors.muted, fontSize: 12 },
  mealPartial: { color: colors.muted, fontSize: 11, lineHeight: 16, marginTop: spacing.sm },
  mealNote: { color: colors.muted, fontSize: 12, marginTop: spacing.sm, fontStyle: 'italic' },

  fieldLabel: { color: colors.ink, fontSize: 14, fontWeight: '800', marginTop: spacing.lg },
  fieldHint: { color: colors.muted, fontSize: 12, lineHeight: 17, marginTop: 2, marginBottom: spacing.sm },
  chipRow: { flexDirection: 'row', gap: spacing.sm },
  chip: {
    flex: 1, minHeight: 44, alignItems: 'center', justifyContent: 'center',
    borderRadius: radius.sm, borderWidth: 1, borderColor: colors.line, backgroundColor: colors.surface,
  },
  chipActive: { borderColor: colors.teal, backgroundColor: colors.tealSoft },
  chipText: { color: colors.muted, fontSize: 14, fontWeight: '700' },
  chipTextActive: { color: colors.teal },
  measureRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  measureField: { flex: 1 },
  measureLabel: { color: colors.muted, fontSize: 11, fontWeight: '700', marginBottom: 4 },
  measureInputWrap: {
    flexDirection: 'row', alignItems: 'center', backgroundColor: colors.surface,
    borderRadius: radius.sm, borderColor: colors.line, borderWidth: 1, paddingHorizontal: spacing.sm,
  },
  measureInput: { flex: 1, color: colors.ink, fontSize: 16, fontWeight: '700', paddingVertical: spacing.md },
  measureUnit: { color: colors.muted, fontSize: 11 },
  levelRow: {
    flexDirection: 'row', alignItems: 'center', minHeight: 44,
    backgroundColor: colors.surface, borderRadius: radius.sm, borderWidth: 1, borderColor: colors.line,
    padding: spacing.md, marginBottom: spacing.sm,
  },
  levelRowActive: { borderColor: colors.teal, backgroundColor: colors.tealSoft },
  levelCopy: { flex: 1, paddingRight: spacing.sm },
  levelLabel: { color: colors.ink, fontSize: 14, fontWeight: '700' },
  levelLabelActive: { color: colors.teal },
  levelDetail: { color: colors.muted, fontSize: 12, lineHeight: 17, marginTop: 2 },
  levelCheck: { color: colors.teal, fontSize: 17, fontWeight: '800' },
  targetMacroRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.md },
  targetChip: { flex: 1, gap: 3 },
  targetChipValue: { color: colors.ink, fontSize: 16, fontWeight: '800' },
  targetChipLabel: { color: colors.muted, fontSize: 11 },
  targetBreakdown: { color: colors.muted, fontSize: 11, lineHeight: 16, marginTop: spacing.md },

  tabIntro: { color: colors.muted, fontSize: 12, lineHeight: 18, marginBottom: spacing.md },
  tabIntroStrong: { color: colors.ink, fontWeight: '700' },
  legendRow: { gap: spacing.xs, marginBottom: spacing.md },
  legendItem: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  legendSwatch: { width: 12, height: 12, borderRadius: 3 },
  legendSwatchLower: { backgroundColor: colors.muted },
  legendText: { color: colors.muted, fontSize: 12, flex: 1 },
  horizonBlock: { backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.md, marginBottom: spacing.sm },
  horizonTitle: { color: colors.ink, fontSize: 13, fontWeight: '800', marginBottom: spacing.sm },
  deltaRow: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm, marginBottom: 6 },
  deltaTrack: { flex: 1, height: 8, borderRadius: 4, backgroundColor: colors.line, overflow: 'hidden' },
  deltaFill: { height: '100%', borderRadius: 4 },
  deltaValue: { color: colors.ink, fontSize: 13, fontWeight: '800', width: 92, textAlign: 'right' },
  deltaUnit: { color: colors.muted, fontSize: 11, fontWeight: '600' },
  deltaInsufficient: { color: colors.muted, fontSize: 11, width: 92, textAlign: 'right' },

  hazardBox: { backgroundColor: colors.warningSoft, borderRadius: radius.md, padding: spacing.md, marginTop: spacing.md, gap: spacing.xs },
  hazardTitle: { color: colors.warning, fontSize: 13, fontWeight: '800' },
  hazardText: { color: colors.warning, fontSize: 12, lineHeight: 18, fontWeight: '600' },
  noteBox: { backgroundColor: colors.surface, borderRadius: radius.md, padding: spacing.md, marginTop: spacing.md, gap: spacing.sm },
  noteTitle: { color: colors.ink, fontSize: 13, fontWeight: '800' },
  noteText: { color: colors.muted, fontSize: 12, lineHeight: 18 },
  noteWarning: { color: colors.warning, fontSize: 12, lineHeight: 18, fontWeight: '600' },
  message: { color: colors.warning, backgroundColor: colors.warningSoft, borderRadius: radius.sm, padding: spacing.md, fontSize: 13, lineHeight: 19, marginTop: spacing.md },
  primaryButton: {
    minHeight: 48, alignItems: 'center', justifyContent: 'center',
    borderRadius: radius.sm, backgroundColor: colors.teal, marginTop: spacing.md,
    alignSelf: 'stretch',
  },
  primaryButtonText: { color: '#FFFFFF', fontSize: 15, fontWeight: '800' },
  disabled: { opacity: 0.55 },
});
