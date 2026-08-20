import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { colors, radius, spacing } from '../theme';

/**
 * Flujo de primer uso (Fase 13, ítem 10).
 *
 * Hasta ahora la app abría directamente en la pantalla principal, con los
 * parámetros de terapia en sus valores placeholder y sin nada que explicara
 * qué hace y qué no hace. Verónica lo pidió explícitamente por WhatsApp.
 *
 * Lo que este flujo **no** hace, a propósito:
 *
 * - **No pide parámetros de terapia acá.** `AGENTS.md` prohíbe inferirlos, y
 *   un formulario de bienvenida con campos prellenados es la forma más fácil
 *   de que alguien "confirme" de un toque unos números que nunca eligió. La
 *   última pantalla explica qué falta y manda a Ajustes → Terapia, que es el
 *   único lugar que marca el perfil como configurado.
 * - **No ofrece elegir entre mg/dL y mmol/L todavía.** Verónica lo pidió, y
 *   la preferencia existe en `TherapyProfile.glucoseUnit`, pero hoy no la
 *   consume ninguna pantalla: `targetGlucose` y `correctionFactor` son mg/dL
 *   implícito y sin migrarlos la calculadora de dosis quedaría en otra unidad
 *   que el resto de la app. Un selector que no se respeta es peor que no
 *   tenerlo, así que acá se **declara** la unidad en vez de fingir una
 *   opción. Ver `docs/ROADMAP_V0.2.md` § Fase 13, ítem 10b.
 */

interface Step {
  title: string;
  body: string;
  bullets?: string[];
  warning?: string;
}

const STEPS: Step[] = [
  {
    title: 'Type 1A te acompaña, no te indica',
    body:
      'Registra tu glucosa, tus comidas y tu insulina en un solo lugar, y te muestra lo que ya pasó para que puedas conversarlo con tu equipo clínico.',
    // OJO: la app SÍ hace aritmética de dosis (`calculateCorrection`,
    // `calculateMealBolus`) con los parámetros que cargó la usuaria. Decir
    // "nunca calcula insulina" sería falso y además contradiría el paso 4 de
    // este mismo flujo, que habla de "las calculadoras". Lo que `AGENTS.md`
    // prohíbe es que la app *decida* o *sugiera* una dosis, y que infiera
    // parámetros — eso es lo que se afirma acá.
    warning:
      'Type 1A nunca decide ni sugiere una dosis por su cuenta, y nunca propone parámetros de terapia. La calculadora solo aplica los valores que tú cargaste; la decisión es siempre de tu equipo clínico.',
  },
  {
    title: 'Todo se guarda en tu teléfono',
    // Este flujo es el ÚNICO lugar donde se puede dar por informada a la
    // usuaria de qué sale del teléfono, así que la lista tiene que ser
    // completa, no tranquilizadora. Rutas reales de salida hoy:
    // `analyzeMealImage` y `analyzeMealDescription` (foto/texto de comida →
    // backend → Abacus), `fetchGlucoseInsight` en `episodes.ts` (métricas del
    // episodio post-comida: glucosas, unidades de rápida y carbos — se manda
    // **automáticamente** en cada `processReadyEpisodes`, sin que ella
    // elija), la consulta al CGM, y el email de LibreView al conectar.
    body:
      'Tu historial completo vive en este dispositivo, cifrado, y los reportes en PDF y Excel se generan acá mismo para que los lleves a un control. Nada de eso se sube.',
    bullets: [
      'Sí salen de tu teléfono: la foto o la descripción de una comida cuando pides estimar carbohidratos, y las cifras de un episodio post-comida (glucosas, carbos y unidades) que se envían solos para redactarte el resumen.',
      'También salen la consulta a tu sensor y tu email de LibreView al conectarlo.',
      'Si el sensor o internet fallan, puedes seguir registrando a mano.',
      'Un dato importado o escrito por ti nunca se muestra como si viniera del sensor en vivo.',
    ],
  },
  {
    title: 'Las unidades que vas a ver',
    body:
      'Esta versión muestra y recibe toda la glucosa en mg/dL, incluidos el objetivo y el factor de corrección. Es la unidad en la que están definidos los rangos y las estimaciones que verás.',
    bullets: [
      'Glucosa: mg/dL',
      'Insulina: unidades (U)',
      'Carbohidratos: gramos (g)',
    ],
    warning:
      'Poder elegir mmol/L está pendiente. Mientras tanto la app no lo ofrece, para que no queden dos unidades conviviendo en la misma pantalla.',
  },
  {
    title: 'Conecta tu sensor',
    body:
      'Type 1A lee tu FreeStyle Libre a través de LibreLinkUp, la app de seguimiento de Abbott. Vas a necesitar una cuenta de LibreLinkUp que siga a tu sensor: no es la misma con la que escaneas en LibreLink.',
    bullets: [
      'En LibreLink: menú → Compartir → activa LibreLinkUp e invita a tu propio correo.',
      'Instala LibreLinkUp, regístrate con ese correo y acepta la invitación.',
      'Comprueba que veas tu glucosa en LibreLinkUp; recién ahí conéctala en Ajustes → Dispositivos.',
    ],
    warning:
      'Tu contraseña de LibreLinkUp se guarda cifrada en este teléfono y viaja solo hacia Abbott: no pasa por los servidores de Type 1A. Sin sensor conectado la app igual sirve para registrar todo a mano.',
  },
  {
    title: '¿También quieres cuidar lo que comes?',
    body:
      'Además de la diabetes, Type 1A puede seguir tus calorías y macronutrientes: bajar de peso, mantenerte, o simplemente ver qué estás comiendo. Es opcional y puedes activarlo o apagarlo cuando quieras.',
    bullets: [
      'Se configura en la pestaña Nutrición (el botón ◍ de arriba), con tu peso, estatura, edad y nivel de actividad.',
      'Ahí verás algo que el conteo de carbohidratos no muestra: cómo se mueve tu glucosa varias horas después de las comidas altas en grasa y proteína.',
    ],
    warning:
      'Las metas de alimentación son una referencia calculada con ecuaciones poblacionales, no una indicación médica — y menos si vas a bajar de peso usando insulina. Eso se decide con tu equipo clínico.',
  },
  {
    title: 'Falta un paso, y lo das tú',
    body:
      'Las calculadoras de dosis quedan bloqueadas hasta que cargues tus parámetros en Ajustes → Terapia: objetivo, factor de corrección e incremento de la pluma.',
    warning:
      'Escribe ahí exactamente lo que te indicó tu equipo clínico. La app deja esos campos vacíos a propósito: no propone valores.',
  },
];

export function OnboardingModal({ visible, onFinish }: { visible: boolean; onFinish: () => void }) {
  const [index, setIndex] = useState(0);
  if (!visible) return null;

  const step = STEPS[index]!;
  const isLast = index === STEPS.length - 1;

  return (
    <View style={styles.backdrop}>
      <View style={styles.sheet}>
        <ScrollView contentContainerStyle={styles.body}>
          <Text style={styles.progress}>Paso {index + 1} de {STEPS.length}</Text>
          <Text style={styles.title}>{step.title}</Text>
          <Text style={styles.copy}>{step.body}</Text>
          {step.bullets?.map((bullet) => (
            <View key={bullet} style={styles.bulletRow}>
              <Text style={styles.bulletDot}>•</Text>
              <Text style={styles.bulletText}>{bullet}</Text>
            </View>
          ))}
          {step.warning === undefined ? null : (
            <View style={styles.warningBox}>
              <Text style={styles.warningText}>{step.warning}</Text>
            </View>
          )}
        </ScrollView>

        <View style={styles.footer}>
          <View style={styles.dots}>
            {STEPS.map((entry, dotIndex) => (
              <View
                key={entry.title}
                style={[styles.dot, dotIndex === index && styles.dotActive]}
              />
            ))}
          </View>
          {/* Una sola acción dominante por pantalla; "Atrás" queda secundario. */}
          <View style={styles.buttonRow}>
            {index === 0 ? null : (
              <Pressable
                style={styles.secondaryButton}
                onPress={() => { setIndex((current) => current - 1); }}
                accessibilityRole="button"
              >
                <Text style={styles.secondaryText}>Atrás</Text>
              </Pressable>
            )}
            <Pressable
              style={styles.primaryButton}
              onPress={() => { if (isLast) onFinish(); else setIndex((current) => current + 1); }}
              accessibilityRole="button"
            >
              <Text style={styles.primaryText}>{isLast ? 'Empezar' : 'Continuar'}</Text>
            </Pressable>
          </View>
        </View>
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  backdrop: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    bottom: 0,
    backgroundColor: 'rgba(20, 33, 42, 0.55)',
    justifyContent: 'center',
    padding: spacing.lg,
    zIndex: 10,
  },
  sheet: {
    backgroundColor: colors.background,
    borderRadius: radius.lg,
    maxHeight: '86%',
    overflow: 'hidden',
  },
  body: { padding: spacing.lg, gap: spacing.sm },
  progress: { color: colors.muted, fontSize: 12, fontWeight: '700', letterSpacing: 0.6 },
  title: { color: colors.ink, fontSize: 22, fontWeight: '800', marginTop: spacing.xs },
  copy: { color: colors.muted, fontSize: 14, lineHeight: 21, marginTop: spacing.xs },
  bulletRow: { flexDirection: 'row', gap: spacing.sm, marginTop: spacing.xs },
  bulletDot: { color: colors.teal, fontSize: 14, fontWeight: '800', lineHeight: 20 },
  bulletText: { color: colors.muted, fontSize: 13, lineHeight: 20, flex: 1 },
  warningBox: {
    backgroundColor: colors.warningSoft,
    borderRadius: radius.sm,
    padding: spacing.md,
    marginTop: spacing.md,
  },
  warningText: { color: colors.warning, fontSize: 12, lineHeight: 18, fontWeight: '600' },
  footer: {
    borderTopColor: colors.line,
    borderTopWidth: StyleSheet.hairlineWidth,
    padding: spacing.lg,
    gap: spacing.md,
  },
  dots: { flexDirection: 'row', gap: 6, justifyContent: 'center' },
  dot: { width: 7, height: 7, borderRadius: 4, backgroundColor: colors.line },
  dotActive: { backgroundColor: colors.teal },
  buttonRow: { flexDirection: 'row', gap: spacing.sm },
  secondaryButton: {
    minHeight: 44,
    paddingHorizontal: spacing.lg,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
    borderColor: colors.line,
    borderWidth: 1,
  },
  secondaryText: { color: colors.muted, fontSize: 15, fontWeight: '700' },
  primaryButton: {
    flex: 1,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: radius.sm,
    backgroundColor: colors.teal,
  },
  primaryText: { color: '#FFFFFF', fontSize: 15, fontWeight: '800' },
});
