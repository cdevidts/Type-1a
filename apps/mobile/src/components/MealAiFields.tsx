import { Pressable, StyleSheet, Text, TextInput, View } from 'react-native';

// Subpath, nunca el barrel: Metro no hace tree-shaking (ver `/iconography`).
import WandSparkles from 'lucide-react-native/icons/wand-sparkles';

import { colors, radius, spacing } from '../theme';

/**
 * Los **dos** cuadros de texto de la IA de comida, compartidos por los tres
 * modales que registran comida.
 *
 * ## El problema que arregla
 *
 * Había uno solo y hacía dos trabajos: darle pistas a la IA sobre lo que hay
 * en la foto, y estimar sin foto solo con texto. El rótulo anunciaba el
 * segundo, así que nadie descubría el primero — y esa pista es justo lo que
 * más mejora una estimación por foto.
 *
 * Y faltaba un tercer trabajo que solo existía en `MealEditModal`: **corregir
 * sobre lo que la IA acaba de proponer** sin volver a empezar. Si el borrador
 * dice más arroz del que había, la única salida era sacar otra foto.
 *
 * ## Los dos campos
 *
 * 1. **Qué comiste.** Con foto adjunta es la pista para el análisis de la
 *    imagen; sin foto es la descripción completa que habilita estimar por
 *    texto. El rótulo y la ayuda cambian según haya imagen: ese cambio **es**
 *    el arreglo, porque hoy el campo miente sobre lo que hace cuando hay foto.
 * 2. **Corregir la propuesta.** Aparece solo cuando ya hay un análisis en
 *    pantalla. Manda la composición actual más la instrucción y deja el
 *    resultado en el mismo lugar — **sin volver a mandar la imagen**: trabaja
 *    sobre lo que ya está, que es exactamente lo que se pidió.
 *
 * ## Lo que el padre tiene que garantizar
 *
 * Este componente no toca estado clínico: solo recoge texto y avisa. Quien lo
 * monta es responsable de que **una corrección invalide la dosis calculada**
 * igual que un análisis nuevo — cambia los carbohidratos, así que una dosis
 * anterior deja de corresponder. Es la regla que más fácil se pierde al mover
 * este código de sitio.
 */

export function MealAiFields({
  description,
  onChangeDescription,
  hasPhoto,
  hasAnalysis,
  instruction,
  onChangeInstruction,
  busy,
  onEstimateFromText,
  onRefine,
  /** Oculta el botón de estimar por texto donde no aplica (editor de comida). */
  showTextEstimate = true,
}: {
  description: string;
  onChangeDescription: (next: string) => void;
  hasPhoto: boolean;
  hasAnalysis: boolean;
  instruction: string;
  onChangeInstruction: (next: string) => void;
  busy: boolean;
  onEstimateFromText: () => void;
  onRefine: () => void;
  showTextEstimate?: boolean;
}) {
  return (
    <View>
      <Text style={styles.label}>
        {hasPhoto ? 'Ayuda a la IA con la foto' : 'Qué comiste'}
      </Text>
      <Text style={styles.hint}>
        {hasPhoto
          ? 'Qué hay en la imagen y cómo está preparado. La IA lo usa junto con la foto: es lo que más mejora la estimación.'
          : 'Descríbelo con lo que sepas —cantidad, preparación— y estima sin foto. Si además sacas una foto, este texto pasa a ser la pista para la imagen.'}
      </Text>
      <TextInput
        style={styles.textArea}
        value={description}
        onChangeText={onChangeDescription}
        placeholder={hasPhoto ? 'Ej.: plato de 24 cm, comí la mitad' : 'Ej.: dos sopaipillas con pebre'}
        placeholderTextColor={colors.muted}
        maxLength={500}
        multiline
        accessibilityLabel={hasPhoto ? 'Pista para el análisis de la foto' : 'Descripción de la comida'}
      />
      {showTextEstimate && !hasPhoto ? (
        <Pressable
          style={[styles.secondary, busy && styles.disabled]}
          disabled={busy}
          onPress={onEstimateFromText}
          accessibilityRole="button"
        >
          <Text style={styles.secondaryText}>Estimar por texto, sin foto</Text>
        </Pressable>
      ) : null}

      {/*
        Solo con una propuesta en pantalla: corregir "sobre lo que acaba de
        hacer" no significa nada si todavía no hizo nada.
      */}
      {hasAnalysis ? (
        <View style={styles.panel}>
          <View style={styles.panelHead}>
            <WandSparkles size={18} color={colors.teal} />
            <Text style={styles.panelTitle}>Corregir la propuesta</Text>
          </View>
          <Text style={styles.hint}>
            Sobre lo que la IA ya propuso, en tus palabras: "es menos arroz del que pensaste", "agrégale una
            cucharada de aceite". No hace falta otra foto.
          </Text>
          <TextInput
            style={styles.textArea}
            value={instruction}
            onChangeText={onChangeInstruction}
            placeholder="Qué hay que corregir"
            placeholderTextColor={colors.muted}
            maxLength={300}
            multiline
            accessibilityLabel="Corrección sobre la propuesta de la IA"
          />
          <Pressable
            style={[styles.secondary, busy && styles.disabled]}
            disabled={busy}
            onPress={onRefine}
            accessibilityRole="button"
          >
            <Text style={styles.secondaryText}>{busy ? 'Consultando…' : 'Ver qué propone'}</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  label: { color: colors.navy, fontSize: 13, fontWeight: '800', marginTop: spacing.md },
  hint: { color: colors.muted, fontSize: 12, lineHeight: 17, marginTop: 4 },
  textArea: {
    backgroundColor: colors.surface, color: colors.ink, borderColor: colors.line, borderWidth: 1,
    borderRadius: radius.sm, minHeight: 70, padding: spacing.md, marginTop: 6, textAlignVertical: 'top',
  },
  secondary: {
    minHeight: 44, justifyContent: 'center', alignItems: 'center', marginTop: spacing.sm,
    borderRadius: radius.sm, borderWidth: 1, borderColor: colors.teal, paddingHorizontal: spacing.md,
  },
  secondaryText: { color: colors.teal, fontSize: 13, fontWeight: '800' },
  panel: {
    backgroundColor: colors.tealSoft, borderRadius: radius.md, padding: spacing.md, marginTop: spacing.lg,
  },
  panelHead: { flexDirection: 'row', alignItems: 'center', gap: spacing.sm },
  panelTitle: { color: colors.navy, fontSize: 14, fontWeight: '800' },
  disabled: { opacity: 0.55 },
});
