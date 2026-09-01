import { Image, Pressable, StyleSheet, Text, View } from 'react-native';

// Subpath, nunca el barrel: Metro no hace tree-shaking (ver `/iconography`).
import Pencil from 'lucide-react-native/icons/pencil';
import UtensilsCrossed from 'lucide-react-native/icons/utensils-crossed';
import X from 'lucide-react-native/icons/x';

import { colors, macroColors, radius, spacing } from '../theme';

/**
 * La tarjeta de un alimento — **la misma** en el catálogo y en el carrito.
 *
 * ## Por qué una sola
 *
 * Las dos pantallas muestran lo mismo (una foto, un nombre, su porción y sus
 * macros) y lo único que cambia es el control de la derecha: en el catálogo un
 * lápiz para editar, en el carrito una X para quitar la línea. Escribirlas por
 * separado es cómo esta app llegó a tener el mismo bloque de macros seis
 * veces (ver `MacroFields`), y el costo no fue estético: cada mejora había que
 * hacerla en todos lados y siempre se olvidaba uno.
 *
 * ## Dos reglas de interacción que no son cosméticas
 *
 * 1. **Tocar el contenedor no abre la edición.** La acción vive en el control
 *    de la derecha, con su área de 44 pt. Una tarjeta entera tocable en una
 *    lista que se recorre con el pulgar abre el editor por accidente, y en el
 *    catálogo ese editor cambia valores que después sugieren carbohidratos.
 * 2. **Cada chip lleva su etiqueta y sus gramos.** El color no comunica solo
 *    (`contracts/ux-checklist.md`), y la fibra comparte el hue de los
 *    carbohidratos a propósito — se distingue por ir en contorno y por su
 *    etiqueta, no por un cuarto color sin validar (ver `theme.ts`).
 * 3. **Los chips dicen sobre cuánto hablan.** `macrosCaption` no es adorno:
 *    los mismos cinco números significan cosas distintas según sean de una
 *    porción, de 100 g o de una receta entera, y la diferencia es de dos a
 *    diez veces. Sin la leyenda, un alimento denso se lee como si una porción
 *    tuviera el triple de carbohidratos de los que tiene.
 */

export interface FoodCardMacros {
  carbsG?: number | undefined;
  proteinG?: number | undefined;
  fatG?: number | undefined;
  fiberG?: number | undefined;
  /**
   * Energía. **No es un macro y por eso no lleva hue propio**: va en un chip
   * neutro, detrás de los cuatro. Un quinto color categórico no se puede
   * elegir a ojo (ver `theme.ts`), y aquí ni siquiera haría falta: las
   * calorías no compiten con los macros, los resumen.
   */
  caloriesKcal?: number | undefined;
}

/**
 * Un chip de macro.
 *
 * `undefined` se dibuja como "—" y **no** como "0 g": en toda esta app un
 * campo sin anotar es una afirmación distinta de un cero medido, y el chip es
 * justo donde esa diferencia se pierde si nadie la escribe.
 */
function MacroChip({
  label,
  value,
  unit,
  color,
  outlined = false,
  neutral = false,
}: {
  label: string;
  value: number | undefined;
  unit: string;
  color: string;
  outlined?: boolean;
  /** Sin hue de macro: para la energía, que no es uno de los cuatro. */
  neutral?: boolean;
}) {
  const text = value === undefined ? 'sin anotar' : `${Math.round(value * 10) / 10} ${unit}`;
  return (
    <View
      style={[
        styles.chip,
        neutral
          ? { backgroundColor: colors.background, borderColor: colors.line, borderWidth: 1 }
          : outlined
            ? { borderColor: color, borderWidth: 1, backgroundColor: 'transparent' }
            : { backgroundColor: `${color}1A`, borderColor: `${color}66`, borderWidth: 1 },
      ]}
      accessible
      accessibilityLabel={`${label}: ${text}`}
    >
      <Text style={[styles.chipLabel, { color }]} numberOfLines={1}>{label}</Text>
      <Text style={styles.chipValue} numberOfLines={1}>{text}</Text>
    </View>
  );
}

/**
 * La miniatura. Cuadrada con esquinas redondeadas; si el alimento no tiene
 * foto —todo lo guardado antes de que el catálogo las soportara— va un icono
 * neutro. **Nunca se genera.**
 *
 * ⚠️ **No es una foto DEL alimento: es la foto de la comida donde se
 * identificó.** El análisis de una foto devuelve varios alimentos y todos
 * heredan la misma imagen, así que la foto de un sándwich queda como
 * miniatura de "Pan", "Queso" y "Jamón" por separado. Anunciarla como "Foto
 * de Pan" al lado de "porción 20 g" invita a estimar la porción mirando un
 * plato entero — y esa porción produce los gramos que pueden terminar en
 * carbohidratos confirmados. La etiqueta lo dice.
 */
function Thumbnail({ imageUri, name }: { imageUri: string | undefined; name: string }) {
  if (imageUri === undefined) {
    return (
      <View style={[styles.thumb, styles.thumbEmpty]} accessible accessibilityLabel={`${name}, sin foto`}>
        <UtensilsCrossed size={22} color={colors.muted} />
      </View>
    );
  }
  return (
    <Image
      source={{ uri: imageUri }}
      style={styles.thumb}
      resizeMode="cover"
      accessible
      accessibilityLabel={`Foto de la comida donde se identificó ${name}. Puede incluir otros alimentos.`}
    />
  );
}

export function FoodCard({
  name,
  subtitle,
  imageUri,
  macros,
  macrosCaption,
  action,
}: {
  name: string;
  /** Porción, cantidad o veces vista. Lo que distinga a esta línea. */
  subtitle: string;
  imageUri?: string | undefined;
  macros: FoodCardMacros;
  /**
   * Sobre cuánto alimento hablan los chips: "por porción de 150 g", "receta
   * completa". Opcional solo donde la cantidad ya está dicha justo encima
   * (el carrito); donde no lo está, ponerla no es negociable.
   */
  macrosCaption?: string | undefined;
  /**
   * El único control tocable de la tarjeta.
   *
   * `'edit'` dibuja el lápiz (catálogo), `'remove'` la X (carrito). No hay
   * variante sin acción: una tarjeta de la que no se puede salir es un
   * callejón, y el catálogo ya tuvo uno.
   */
  action: { kind: 'edit' | 'remove'; label: string; onPress: () => void };
}) {
  const Icon = action.kind === 'edit' ? Pencil : X;
  const tint = action.kind === 'edit' ? colors.navy : colors.red;
  return (
    <View style={styles.card}>
      <Thumbnail imageUri={imageUri} name={name} />
      <View style={styles.body}>
        <Text style={styles.name} numberOfLines={2}>{name}</Text>
        <Text style={styles.subtitle} numberOfLines={2}>{subtitle}</Text>
        <View style={styles.chipRow}>
          <MacroChip label="Carbos" value={macros.carbsG} unit="g" color={macroColors.carbs} />
          <MacroChip label="Proteína" value={macros.proteinG} unit="g" color={macroColors.protein} />
          <MacroChip label="Grasa" value={macros.fatG} unit="g" color={macroColors.fat} />
          <MacroChip label="Fibra" value={macros.fiberG} unit="g" color={macroColors.fiber} outlined />
          <MacroChip label="Calorías" value={macros.caloriesKcal} unit="kcal" color={colors.muted} neutral />
        </View>
        {macrosCaption === undefined ? null : (
          <Text style={styles.macrosCaption} numberOfLines={2}>{macrosCaption}</Text>
        )}
      </View>
      <Pressable
        style={styles.action}
        onPress={action.onPress}
        accessibilityRole="button"
        accessibilityLabel={action.label}
        hitSlop={8}
      >
        <Icon size={20} color={tint} />
      </Pressable>
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: spacing.md,
    backgroundColor: colors.surface,
    borderRadius: radius.md,
    borderWidth: 1,
    borderColor: colors.line,
    padding: spacing.md,
    marginBottom: spacing.sm,
  },
  thumb: { width: 56, height: 56, borderRadius: radius.sm, backgroundColor: colors.background },
  thumbEmpty: { alignItems: 'center', justifyContent: 'center', borderWidth: 1, borderColor: colors.line },
  body: { flex: 1 },
  name: { fontSize: 15, fontWeight: '800', color: colors.ink },
  subtitle: { fontSize: 12, color: colors.muted, marginTop: 2, lineHeight: 16 },
  chipRow: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.xs, marginTop: spacing.sm },
  chip: { borderRadius: radius.sm, paddingHorizontal: spacing.sm, paddingVertical: 3 },
  chipLabel: { fontSize: 9, fontWeight: '900', letterSpacing: 0.3 },
  chipValue: { fontSize: 11, fontWeight: '700', color: colors.ink },
  macrosCaption: { fontSize: 11, color: colors.muted, marginTop: 4, lineHeight: 15 },
  // 44×44 explícito: el mínimo táctil es del área, no del icono de 20.
  action: { width: 44, height: 44, alignItems: 'center', justifyContent: 'center' },
});
