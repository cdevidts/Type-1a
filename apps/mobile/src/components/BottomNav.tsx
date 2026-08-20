import { Image, Pressable, StyleSheet, Text, View } from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
// Imports por icono vía el subpath oficial `lucide-react-native/icons/*`,
// NO desde el barrel. Metro no hace tree-shaking de un barrel export:
// importar por nombre metía los ~1.500 iconos al bundle (medido: 1.263 →
// 3.088 módulos). Ver la skill `/iconography`.
import Activity from 'lucide-react-native/icons/activity';
import Plus from 'lucide-react-native/icons/plus';
import Salad from 'lucide-react-native/icons/salad';
import UtensilsCrossed from 'lucide-react-native/icons/utensils-crossed';

import { APP_LOGO } from '../branding';
import { colors, spacing } from '../theme';

/**
 * Barra de navegación inferior (Fase 16).
 *
 * Cinco destinos fijos. Antes, Resumen y Nutrición vivían arriba a la derecha
 * junto a Ajustes, que es donde va la **configuración**, no la navegación —
 * quedaban escondidos y se usaban poco. "Nueva entrada" era un botón grande
 * en medio del scroll, así que había que buscarlo.
 *
 * ## Por qué no hay librería de navegación
 *
 * Ver la skill `/app-shell`. En resumen: cinco destinos fijos y conocidos no
 * justifican el peso de bundle ni la capa de estado de react-navigation, y sí
 * traerían una fuente nueva de bugs de safe-area.
 *
 * ## El inset de abajo no es opcional
 *
 * Con edge-to-edge (obligatorio desde Expo SDK 54) Android dibuja su barra de
 * navegación —los tres botones, o la barra de gestos— **encima** del
 * contenido. Una barra a `bottom: 0` sin `insets.bottom` queda debajo de esos
 * botones y es literalmente intocable. `useSafeAreaInsets` viene de
 * `react-native-safe-area-context`; el `SafeAreaView` de `react-native` es
 * iOS-only y acá no serviría de nada.
 */

export type NavDestination = 'nutrition' | 'catalog' | 'entry' | 'chat' | 'summary';

/**
 * Orden fijo, y **es el mismo del swipe**: el gesto y la posición del botón
 * tienen que contar la misma historia. `entry` está al centro a propósito —
 * es la acción primaria y la que se toca con el pulgar sin recolocar la mano.
 */
export const NAV_ORDER: NavDestination[] = ['nutrition', 'catalog', 'entry', 'chat', 'summary'];

const ICON_SIZE = 24;

export function BottomNav({
  active,
  onSelect,
}: {
  /** Destino resaltado. `null` cuando se está en la pantalla principal. */
  active: NavDestination | null;
  onSelect: (destination: NavDestination) => void;
}) {
  const insets = useSafeAreaInsets();

  return (
    <View style={[styles.bar, { paddingBottom: insets.bottom + spacing.sm }]}>
      <NavButton
        label="Nutrición"
        isActive={active === 'nutrition'}
        onPress={() => { onSelect('nutrition'); }}
        icon={<Salad size={ICON_SIZE} color={active === 'nutrition' ? colors.teal : colors.muted} />}
      />
      <NavButton
        label="Catálogo"
        isActive={active === 'catalog'}
        onPress={() => { onSelect('catalog'); }}
        icon={<UtensilsCrossed size={ICON_SIZE} color={active === 'catalog' ? colors.teal : colors.muted} />}
      />

      {/* Acción primaria: más grande y con fondo, única en la barra. */}
      <Pressable
        style={({ pressed }) => [styles.primary, pressed && styles.pressed]}
        onPress={() => { onSelect('entry'); }}
        accessibilityRole="button"
        accessibilityLabel="Nueva entrada"
        hitSlop={6}
      >
        <Plus size={30} color="#FFFFFF" strokeWidth={2.5} />
      </Pressable>

      <NavButton
        label="Chat"
        isActive={active === 'chat'}
        onPress={() => { onSelect('chat'); }}
        icon={
          <Image
            source={APP_LOGO}
            style={[styles.logo, active === 'chat' ? undefined : styles.logoInactive]}
            resizeMode="contain"
          />
        }
      />
      <NavButton
        label="Resumen"
        isActive={active === 'summary'}
        onPress={() => { onSelect('summary'); }}
        icon={<Activity size={ICON_SIZE} color={active === 'summary' ? colors.teal : colors.muted} />}
      />
    </View>
  );
}

/**
 * El estado activo se marca con color **y** con peso de la etiqueta: nunca
 * solo con color (regla de `docs/UX_GUIDELINES.md`).
 */
function NavButton({
  label,
  icon,
  isActive,
  onPress,
}: {
  label: string;
  icon: React.ReactNode;
  isActive: boolean;
  onPress: () => void;
}) {
  return (
    <Pressable
      style={({ pressed }) => [styles.tab, pressed && styles.pressed]}
      onPress={onPress}
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected: isActive }}
      hitSlop={6}
    >
      {icon}
      <Text style={[styles.tabLabel, isActive && styles.tabLabelActive]} numberOfLines={1}>
        {label}
      </Text>
    </Pressable>
  );
}

const styles = StyleSheet.create({
  bar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    flexDirection: 'row',
    alignItems: 'flex-end',
    justifyContent: 'space-around',
    backgroundColor: colors.surface,
    borderTopColor: colors.line,
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: spacing.sm,
    paddingHorizontal: spacing.sm,
  },
  // minHeight 44 y minWidth 44: el mínimo táctil de HIG, aunque el icono
  // mida 24.
  tab: { flex: 1, minHeight: 44, minWidth: 44, alignItems: 'center', justifyContent: 'flex-end', gap: 3 },
  tabLabel: { color: colors.muted, fontSize: 10, fontWeight: '600' },
  tabLabelActive: { color: colors.teal, fontWeight: '800' },
  primary: {
    width: 58,
    height: 58,
    borderRadius: 29,
    backgroundColor: colors.teal,
    alignItems: 'center',
    justifyContent: 'center',
    marginHorizontal: spacing.xs,
    // Elevado sobre la barra para que se lea como la acción dominante.
    marginBottom: 2,
    shadowColor: '#14212A',
    shadowOpacity: 0.2,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: 3 },
    elevation: 4,
  },
  logo: { width: ICON_SIZE, height: ICON_SIZE, borderRadius: 6 },
  logoInactive: { opacity: 0.55 },
  pressed: { opacity: 0.65 },
});
